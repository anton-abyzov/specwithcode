package com.specwithcode.android.app

import com.specwithcode.transport.RouteKind
import java.net.URI
import java.net.URLDecoder

/**
 * Pairing input rules from docs/PROTOCOL.md: wrapped deep links, manual host and code entry,
 * and which links travel over plain http. Pure Kotlin so it is unit tested on the JVM.
 */
object PairingInput {
    /** Characters a pairing code uses (no 0, 1, I or O). */
    const val CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
    const val CODE_LENGTH = 12

    private val wrapperSchemes = setOf("studio", "studio-dev", "specwithcode")
    private val ipv4 = Regex("^\\d{1,3}(\\.\\d{1,3}){3}(:\\d+)?$")

    /** Unwraps `studio://…?pairingUrl=` and `specwithcode://pair?link=` into the real link. */
    fun unwrap(raw: String): String {
        val trimmed = raw.trim()
        val scheme = trimmed.substringBefore(':', "").lowercase()
        if (scheme !in wrapperSchemes) return trimmed
        val query = trimmed.substringAfter('?', "").substringBefore('#')
        val params = query.split('&').mapNotNull { part ->
            val key = part.substringBefore('=', "")
            if (key.isEmpty()) null else key to URLDecoder.decode(part.substringAfter("="), "UTF-8")
        }.toMap()
        return (params["link"] ?: params["pairingUrl"])?.trim() ?: trimmed
    }

    /** Upper-cases a typed code and drops spaces and dashes. */
    fun normalizeCode(code: String): String = code.uppercase().filter { !it.isWhitespace() && it != '-' }

    fun isValidCode(code: String): Boolean {
        val clean = normalizeCode(code)
        return clean.length == CODE_LENGTH && clean.all { it in CODE_ALPHABET }
    }

    /** True for a bare IPv4 or bracketed IPv6 literal, with or without a port. */
    fun isIpLiteral(host: String): Boolean {
        val h = host.trim()
        return ipv4.matches(h) || h.startsWith("[") || h.count { it == ':' } >= 2
    }

    /**
     * The origin for a typed host: a bare IP gets `http://`, anything else `https://`. A host
     * typed with a scheme keeps it. Null when the host is empty or unreadable.
     */
    fun origin(host: String): String? {
        val h = host.trim().trimEnd('/')
        if (h.isEmpty() || h.any { it.isWhitespace() }) return null
        val withScheme = when {
            h.contains("://") -> h
            isIpLiteral(h) -> "http://$h"
            else -> "https://$h"
        }
        val uri = try {
            URI(withScheme)
        } catch (_: Exception) {
            return null
        }
        val scheme = uri.scheme?.lowercase() ?: return null
        if (scheme != "http" && scheme != "https") return null
        val authority = uri.rawAuthority?.takeIf { it.isNotEmpty() } ?: return null
        return "$scheme://$authority"
    }

    /** The pairing link for a manual host and code, or null when either is unusable. */
    fun manualLink(host: String, code: String): String? {
        if (!isValidCode(code)) return null
        val origin = origin(host) ?: return null
        return "$origin/pair#token=${normalizeCode(code)}"
    }

    /** True when the link (after unwrapping) would send the sign-in over plain http. */
    fun isCleartext(link: String): Boolean = unwrap(link).lowercase().startsWith("http://")

    /** The host the link pairs with (after unwrapping), or null when it has none. */
    fun host(link: String): String? = try {
        URI(unwrap(link)).host?.takeIf { it.isNotEmpty() }
    } catch (_: Exception) {
        null
    }

    /**
     * True when the link would send the sign-in over plain http to a host outside this
     * device, the local network and the tailnet. Links opened from other apps must not do that.
     */
    fun isPublicCleartext(link: String): Boolean {
        if (!isCleartext(link)) return false
        val host = host(link) ?: return true
        return RouteKind.classify(host) == RouteKind.PUBLIC
    }
}

/** A link the app was opened with. */
sealed interface DeepLink {
    data class Pair(val link: String) : DeepLink
    data class Thread(val environmentId: String, val threadId: String) : DeepLink

    companion object {
        /**
         * `specwithcode://thread/<env>/<id>` opens a thread; any `studio://`, `studio-dev://` or
         * `specwithcode://pair` link with a pairing URL opens pairing.
         */
        fun parse(raw: String?): DeepLink? {
            val value = raw?.trim()?.takeIf { it.isNotEmpty() } ?: return null
            val scheme = value.substringBefore(':', "").lowercase()
            if (scheme !in setOf("studio", "studio-dev", "specwithcode")) return null
            val rest = value.substringAfter("://", "").substringBefore('?').substringBefore('#')
            val parts = rest.split('/').filter { it.isNotEmpty() }
            if (parts.size == 3 && parts[0] == "thread") return Thread(parts[1], parts[2])
            val link = PairingInput.unwrap(value)
            return if (link != value) Pair(link) else null
        }
    }
}
