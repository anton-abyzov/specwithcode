package com.specwithcode.transport

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.io.ByteArrayOutputStream

// Pairing links, ported from `packages/shared/src/remote.ts` and
// `apps/mobile/src/features/connection/pairing.ts`.
//
// Accepted forms:
//   http(s)://host[:port][/pair]#token=CODE      (also ?token=CODE; the fragment wins)
//   https://app.example/pair?host=<url>&label=<name>#token=CODE
//   studio:…?pairingUrl=<url>, studio-dev:…, specwithcode:…?link=<url>
//   a host plus a code typed by hand
// Only the origin of the machine address is kept.

/** Where to pair and with which one-time code. */
data class PairingTarget(
    val code: String,
    /** Origin with a trailing slash, e.g. `https://m4.tailnet.ts.net/`. */
    val httpBase: String,
    /** The same origin with `ws` or `wss`. */
    val wsBase: String,
    /** Label from a hosted link, when it carried one. */
    val label: String? = null,
) {
    val route: MachineRoute get() = MachineRoute(httpBase = httpBase, wsBase = wsBase)
}

/** Why a pairing link or a typed host could not be used. */
sealed class PairingLinkException(message: String) : Exception(message) {
    enum class HostSource { DIRECT_HOST, HOSTED_PAIRING_HOST }

    /** Nothing was entered or scanned. */
    class Empty : PairingLinkException("Scan or paste a pairing link.")

    /** A host is needed for manual pairing. */
    class MissingHost : PairingLinkException("Enter the computer's address.")

    /** The link is not a URL, or uses a scheme other than http, https, ws or wss. */
    class InvalidLink(val scheme: String?) : PairingLinkException("That pairing link is not valid.")

    /** The machine address is not a usable URL. */
    class InvalidHost(val source: HostSource, val scheme: String?) : PairingLinkException("That computer address is not valid.")

    /** A link without a token. */
    class MissingToken(val host: String) : PairingLinkException("That pairing link is missing its code.")

    /** A manual host without a code. */
    class MissingCode(val host: String) : PairingLinkException("Enter a pairing code.")
}

object PairingLink {
    /** App schemes that wrap a pairing link in `?pairingUrl=` or `?link=`. */
    val wrapperSchemes: Set<String> = setOf("studio", "studio-dev", "specwithcode")

    internal val backendSchemes: Set<String> = setOf("http", "https", "ws", "wss")

    /** Parses a scanned or pasted pairing link. */
    fun parse(text: String): PairingTarget = parse(text, depth = 0)

    /** Pairs from a host and a code typed by hand. A bare IP address gets http, any other host https. */
    fun manual(host: String, code: String): PairingTarget {
        val trimmedHost = host.trim()
        if (trimmedHost.isEmpty()) throw PairingLinkException.MissingHost()
        val origin = normalizeBase(trimmedHost, PairingLinkException.HostSource.DIRECT_HOST, ::defaultScheme)
        val trimmedCode = code.trim()
        if (trimmedCode.isEmpty()) throw PairingLinkException.MissingCode(origin.hostAndPort)
        return PairingTarget(trimmedCode, origin.httpBase, origin.wsBase)
    }

    /** The pairing link inside an app-scheme wrapper, or the trimmed text itself. */
    fun unwrap(payload: String): String {
        val trimmed = payload.trim()
        val scheme = schemePrefix(trimmed) ?: return trimmed
        if (scheme !in wrapperSchemes) return trimmed
        val query = FormQuery(rawQuery(trimmed))
        val inner = (query["pairingUrl"] ?: query["link"])?.trim().orEmpty()
        return inner.ifEmpty { trimmed }
    }

    /**
     * The http and ws origins for a backend address. Accepts a bare host, a protocol-relative
     * host, or a full URL; drops path, query, fragment and user info.
     */
    fun origin(address: String): Pair<String, String> {
        val origin = normalizeBase(address, PairingLinkException.HostSource.DIRECT_HOST) { "https" }
        return origin.httpBase to origin.wsBase
    }

    private fun parse(text: String, depth: Int): PairingTarget {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) throw PairingLinkException.Empty()

        val explicitScheme = schemePrefix(trimmed)
        if (explicitScheme != null && explicitScheme in wrapperSchemes) {
            return parseWrapper(trimmed, explicitScheme, depth)
        }

        // A pasted link without a scheme, like `m4.local:8319#token=…`.
        val candidate = if (trimmed.contains("://")) trimmed else "${defaultScheme(trimmed)}://${trimmed.trimStart('/')}"
        val link = ParsedUrl.parse(candidate)
            ?: throw PairingLinkException.InvalidLink(if (trimmed.contains("://")) explicitScheme else null)
        if (link.scheme !in backendSchemes) throw PairingLinkException.InvalidLink(link.scheme)

        hostedRequest(link)?.let { hosted ->
            val origin = normalizeBase(hosted.host, PairingLinkException.HostSource.HOSTED_PAIRING_HOST) { "https" }
            return PairingTarget(hosted.token, origin.httpBase, origin.wsBase, hosted.label)
        }

        val origin = Origin.of(link.scheme, link.host, link.port) ?: throw PairingLinkException.InvalidLink(link.scheme)
        val token = link.token ?: throw PairingLinkException.MissingToken(origin.hostAndPort)
        return PairingTarget(token, origin.httpBase, origin.wsBase)
    }

    private fun parseWrapper(text: String, scheme: String, depth: Int): PairingTarget {
        if (depth != 0 || !isUrlSafe(text)) throw PairingLinkException.InvalidLink(scheme)
        val query = FormQuery(rawQuery(text))
        // `link` is what specwithcode://pair deep links use; `pairingUrl` is the older name.
        val inner = (query["pairingUrl"] ?: query["link"])?.trim()
        if (!inner.isNullOrEmpty()) return parse(inner, depth + 1)
        val host = query["host"]?.trim().orEmpty()
        val token = query["token"]?.trim().orEmpty()
        if (host.isEmpty() || token.isEmpty()) throw PairingLinkException.InvalidLink(scheme)
        val origin = normalizeBase(host, PairingLinkException.HostSource.HOSTED_PAIRING_HOST) { "https" }
        val label = query["label"]?.trim()?.takeIf { it.isNotEmpty() }
        return PairingTarget(token, origin.httpBase, origin.wsBase, label)
    }

    private data class Hosted(val host: String, val token: String, val label: String?)

    private fun hostedRequest(link: ParsedUrl): Hosted? {
        val host = link.query["host"]?.trim().orEmpty()
        val token = link.token
        if (host.isEmpty() || token == null) return null
        return Hosted(host, token, link.query["label"]?.trim()?.takeIf { it.isNotEmpty() })
    }

    /** `http` for an IP literal, `https` otherwise, as the mobile app does. */
    internal fun defaultScheme(hostAndRest: String): String {
        val authority = hostAndRest.trimStart('/').takeWhile { it != '/' && it != '?' && it != '#' }
        return if (HostClassification.isIPLiteral(authority)) "http" else "https"
    }

    /** The scheme before the first colon, when the text starts with one. */
    internal fun schemePrefix(text: String): String? {
        val colon = text.indexOf(':')
        if (colon <= 0) return null
        val candidate = text.substring(0, colon)
        if (!candidate[0].isAsciiLetter()) return null
        if (!candidate.all { it.isAsciiLetter() || it in '0'..'9' || it == '+' || it == '-' || it == '.' }) return null
        return candidate.lowercase()
    }

    private val schemeRegex = Regex("^[a-zA-Z][a-zA-Z0-9+-]*://")

    internal fun normalizeBase(raw: String, source: PairingLinkException.HostSource, defaultScheme: (String) -> String): Origin {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) throw PairingLinkException.MissingHost()
        val withoutSlashes = trimmed.trimStart('/')
        val input = if (schemeRegex.containsMatchIn(withoutSlashes)) withoutSlashes else "${defaultScheme(withoutSlashes)}://$withoutSlashes"
        val url = ParsedUrl.parse(input) ?: throw PairingLinkException.InvalidHost(source, null)
        if (url.scheme !in backendSchemes) throw PairingLinkException.InvalidHost(source, url.scheme)
        return Origin.of(url.scheme, url.host, url.port) ?: throw PairingLinkException.InvalidHost(source, null)
    }

    /** The raw query of a URL-like string: after the first `?`, before the `#`. */
    private fun rawQuery(text: String): String? {
        val q = text.indexOf('?')
        if (q < 0) return null
        val hash = text.indexOf('#')
        if (hash in 0 until q) return null
        return if (hash < 0) text.substring(q + 1) else text.substring(q + 1, hash)
    }

    private fun Char.isAsciiLetter() = this in 'a'..'z' || this in 'A'..'Z'
}

/** Characters a URL may carry as is, so the string parses without re-encoding. */
internal fun isUrlSafe(text: String): Boolean = text.all { c ->
    c.code in 0x21..0x7e && c !in "\"<>\\^`{|}"
}

/** An origin with its http and ws forms. */
internal data class Origin(
    val httpScheme: String,
    val host: String,
    val port: Int?,
    val hostAndPort: String,
    val httpBase: String,
    val wsBase: String,
) {
    val wsScheme: String get() = if (httpScheme == "https") "wss" else "ws"

    companion object {
        /**
         * Null for an unknown scheme, a port out of range, or a host that is not a DNS name,
         * IPv4 address or IPv6 literal. A decoded host can hold characters that would move the
         * authority to another host, so only plain host characters pass.
         */
        fun of(scheme: String, host: String, port: Int?): Origin? {
            val h = HostClassification.normalize(host)
            if (!isValidHost(h)) return null
            val httpScheme = when (scheme) {
                "http", "ws" -> "http"
                "https", "wss" -> "https"
                else -> return null
            }
            if (port != null && port !in 0..65_535) return null
            val defaultPort = if (httpScheme == "https") 443 else 80
            val effectivePort = port?.takeIf { it != defaultPort }
            val hostForUrl = if (h.contains(":")) "[$h]" else h
            val hostAndPort = effectivePort?.let { "$hostForUrl:$it" } ?: hostForUrl
            val wsScheme = if (httpScheme == "https") "wss" else "ws"
            val httpBase = "$httpScheme://$hostAndPort/"
            if (httpBase.toHttpUrlOrNull() == null) return null
            return Origin(httpScheme, h, effectivePort, hostAndPort, httpBase, "$wsScheme://$hostAndPort/")
        }

        /** ASCII letters, digits, `-`, `_` and `.` (already lowercased), or an IPv6 literal. */
        fun isValidHost(h: String): Boolean {
            if (h.isEmpty()) return false
            if (h.contains(":")) return HostClassification.ipv6(h) != null || HostClassification.ipv4Mapped(h) != null
            return h.all { it in '0'..'9' || it in 'a'..'z' || it == '-' || it == '.' || it == '_' }
        }
    }
}

/** The parts of an absolute `scheme://authority…` URL that pairing needs. */
internal data class ParsedUrl(
    val scheme: String,
    val host: String,
    val port: Int?,
    val query: FormQuery,
    val fragment: FormQuery,
) {
    /** The token from the fragment, falling back to the query. */
    val token: String?
        get() = listOf(fragment, query).firstNotNullOfOrNull { source -> source["token"]?.trim()?.takeIf { it.isNotEmpty() } }

    companion object {
        private val schemeRegex = Regex("^([a-zA-Z][a-zA-Z0-9+.-]*)://")

        fun parse(text: String): ParsedUrl? {
            if (!isUrlSafe(text)) return null
            val match = schemeRegex.find(text) ?: return null
            val scheme = match.groupValues[1].lowercase()
            val rest = text.substring(match.range.last + 1)
            val authorityEnd = rest.indexOfFirst { it == '/' || it == '?' || it == '#' }.let { if (it < 0) rest.length else it }
            val authority = rest.substring(0, authorityEnd).substringAfterLast('@')
            val tail = rest.substring(authorityEnd)

            val host: String
            var portText: String? = null
            if (authority.startsWith("[")) {
                val close = authority.indexOf(']')
                if (close < 0) return null
                host = authority.substring(0, close + 1)
                val after = authority.substring(close + 1)
                if (after.isNotEmpty()) {
                    if (!after.startsWith(":")) return null
                    portText = after.drop(1)
                }
            } else {
                val colon = authority.lastIndexOf(':')
                if (colon >= 0) {
                    host = authority.substring(0, colon)
                    portText = authority.substring(colon + 1)
                } else {
                    host = authority
                }
            }
            val port = when {
                portText.isNullOrEmpty() -> null
                portText.all { it in '0'..'9' } && portText.length <= 6 -> portText.toInt()
                else -> return null
            }
            val decodedHost = FormQuery.percentDecode(host, plusAsSpace = false)
            if (decodedHost.isEmpty()) return null

            val hash = tail.indexOf('#')
            val beforeHash = if (hash < 0) tail else tail.substring(0, hash)
            val fragment = if (hash < 0) null else tail.substring(hash + 1)
            val q = beforeHash.indexOf('?')
            val query = if (q < 0) null else beforeHash.substring(q + 1)
            return ParsedUrl(scheme, decodedHost, port, FormQuery(query), FormQuery(fragment))
        }
    }
}

/** `application/x-www-form-urlencoded` pairs, read like `URLSearchParams`. */
internal class FormQuery(encoded: String?) {
    val pairs: List<Pair<String, String>> = encoded.orEmpty().split('&').filter { it.isNotEmpty() }.map { part ->
        val eq = part.indexOf('=')
        if (eq < 0) percentDecode(part) to "" else percentDecode(part.substring(0, eq)) to percentDecode(part.substring(eq + 1))
    }

    operator fun get(name: String): String? = pairs.firstOrNull { it.first == name }?.second

    companion object {
        /** Decodes `%XX` sequences as UTF-8; malformed escapes stay as they are. */
        fun percentDecode(s: String, plusAsSpace: Boolean = true): String {
            val text = if (plusAsSpace) s.replace('+', ' ') else s
            if (!text.contains('%')) return text
            val out = ByteArrayOutputStream()
            var i = 0
            while (i < text.length) {
                val c = text[i]
                if (c == '%' && i + 2 < text.length) {
                    val value = text.substring(i + 1, i + 3).takeIf { h -> h.all { it.isLetterOrDigit() } }?.toIntOrNull(16)
                    if (value != null) {
                        out.write(value)
                        i += 3
                        continue
                    }
                }
                out.write(c.toString().toByteArray(Charsets.UTF_8))
                i++
            }
            return out.toString(Charsets.UTF_8.name())
        }

        /** Encodes like `URLSearchParams.toString()`. */
        fun encode(pairs: List<Pair<String, String>>): String =
            pairs.joinToString("&") { "${encodeComponent(it.first)}=${encodeComponent(it.second)}" }

        fun encodeComponent(s: String): String {
            val sb = StringBuilder()
            for (byte in s.toByteArray(Charsets.UTF_8)) {
                val b = byte.toInt() and 0xff
                when {
                    b == 0x2A || b == 0x2D || b == 0x2E || b == 0x5F ||
                        b in 0x30..0x39 || b in 0x41..0x5A || b in 0x61..0x7A -> sb.append(b.toChar())
                    b == 0x20 -> sb.append('+')
                    else -> sb.append('%').append("%02X".format(b))
                }
            }
            return sb.toString()
        }
    }
}

/** The origin as an [HttpUrl]; throws [TransportException.InvalidAddress] when it is not one. */
internal fun String.toHttpBase(): HttpUrl = toHttpUrlOrNull() ?: throw TransportException.InvalidAddress(this)
