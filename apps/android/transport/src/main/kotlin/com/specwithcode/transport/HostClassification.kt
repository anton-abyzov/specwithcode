package com.specwithcode.transport

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * How a route reaches a machine, fastest first. Ported from
 * `packages/client-runtime/src/connection/routes.ts` and
 * `packages/shared/src/hostClassification.ts`.
 */
@Serializable
enum class RouteKind(val rank: Int, val label: String) {
    @SerialName("loopback") LOOPBACK(0, "This device"),
    @SerialName("lan") LAN(1, "LAN"),
    @SerialName("tailnet") TAILNET(2, "Tailscale"),
    @SerialName("public") PUBLIC(3, "Internet"),
    ;

    companion object {
        fun classify(host: String): RouteKind = when {
            HostClassification.isLoopback(host) -> LOOPBACK
            HostClassification.isTailnet(host) -> TAILNET
            HostClassification.isPrivateNetwork(host) -> LAN
            else -> PUBLIC
        }
    }
}

object HostClassification {
    fun normalize(host: String): String {
        var h = host.lowercase()
        if (h.startsWith("[")) h = h.drop(1)
        if (h.endsWith("]")) h = h.dropLast(1)
        while (h.endsWith(".")) h = h.dropLast(1)
        return h
    }

    internal fun ipv4(host: String): List<Int>? {
        val parts = normalize(host).split(".")
        if (parts.size != 4) return null
        return parts.map { part ->
            if (part.isEmpty() || !part.all { it in '0'..'9' }) return null
            part.toIntOrNull()?.takeIf { it <= 255 } ?: return null
        }
    }

    internal fun ipv4Mapped(host: String): List<Int>? {
        val h = normalize(host)
        if (!h.startsWith("::ffff:")) return null
        val suffix = h.removePrefix("::ffff:")
        ipv4(suffix)?.let { return it }
        val hextets = suffix.split(":")
        if (hextets.size != 2 || !hextets.all(::isHextet)) return null
        val high = hextets[0].toInt(16)
        val low = hextets[1].toInt(16)
        return listOf(high shr 8, high and 0xff, low shr 8, low and 0xff)
    }

    internal fun ipv6(host: String): List<Int>? {
        val h = normalize(host)
        if (!h.contains(":")) return null
        val halves = h.split("::")
        if (halves.size > 2) return null
        val head = if (halves[0].isEmpty()) emptyList() else halves[0].split(":")
        val tail = if (halves.size == 2 && halves[1].isNotEmpty()) halves[1].split(":") else emptyList()
        if (!(head + tail).all(::isHextet)) return null
        val missing = 8 - head.size - tail.size
        if (halves.size == 1 && missing != 0) return null
        if (halves.size == 2 && missing < 1) return null
        return (head + List(maxOf(missing, 0)) { "0" } + tail).map { it.toInt(16) }
    }

    private fun isHextet(s: String): Boolean =
        s.length in 1..4 && s.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }

    private fun isPrivateIPv4(p: List<Int>): Boolean =
        p[0] == 0 || p[0] == 10 || p[0] == 127 ||
            (p[0] == 100 && p[1] in 64..127) ||
            (p[0] == 172 && p[1] in 16..31) ||
            (p[0] == 192 && p[1] == 168) ||
            (p[0] == 169 && p[1] == 254) ||
            (p[0] == 198 && p[1] in 18..19)

    fun isLoopback(host: String): Boolean {
        val h = normalize(host)
        if (h == "localhost" || h == "::1") return true
        return ipv4(h)?.first() == 127
    }

    /** A MagicDNS name, the 100.64.0.0/10 range, or fd7a:115c:a1e0::/48. */
    fun isTailnet(host: String): Boolean {
        val h = normalize(host)
        if (h.endsWith(".ts.net")) return true
        ipv4(h)?.let { return it[0] == 100 && it[1] in 64..127 }
        val v6 = ipv6(h) ?: return false
        return v6.size == 8 && v6[0] == 0xfd7a && v6[1] == 0x115c && v6[2] == 0xa1e0
    }

    fun isPrivateNetwork(host: String): Boolean {
        val h = normalize(host)
        if (h == "::" || isLoopback(h) || h.endsWith(".localhost") || h.endsWith(".local") ||
            h == "home.arpa" || h.endsWith(".home.arpa") || (!h.contains(".") && !h.contains(":"))
        ) {
            return true
        }
        if (h.endsWith(".ts.net")) return true
        (ipv4(h) ?: ipv4Mapped(h))?.let { return isPrivateIPv4(it) }
        if (!h.contains(":")) return false
        val first = h.substringBefore(":")
        if (!isHextet(first)) return false
        val hextet = first.toInt(16)
        return (hextet and 0xfe00) == 0xfc00 || (hextet and 0xffc0) == 0xfe80
    }

    /** A bare IPv4 or IPv6 literal, with or without a port. */
    fun isIPLiteral(hostAndPort: String): Boolean {
        if (hostAndPort.startsWith("[")) return true
        if (hostAndPort.count { it == ':' } > 1) return ipv6(hostAndPort) != null
        val h = if (hostAndPort.contains(":")) hostAndPort.substringBeforeLast(":") else hostAndPort
        return ipv4(h) != null
    }
}
