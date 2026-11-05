package com.specwithcode.transport

import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

// Tables ported from packages/shared/src/remote.test.ts,
// apps/mobile/src/features/connection/pairing.test.ts and the iOS PairingLinkTests.
class PairingLinkTest {
    private data class LinkCase(val input: String, val code: String, val http: String, val ws: String)

    private val links = listOf(
        // remote.test.ts
        LinkCase("https://remote.example.com/pair#token=pairing-token", "pairing-token", "https://remote.example.com/", "wss://remote.example.com/"),
        LinkCase("https://remote.example.com/pair?token=pairing-token", "pairing-token", "https://remote.example.com/", "wss://remote.example.com/"),
        LinkCase(
            "https://app.studio.invalid/pair?host=https%3A%2F%2Fdesktop.tailnet.ts.net%3A44342%2F#token=pairing-token",
            "pairing-token", "https://desktop.tailnet.ts.net:44342/", "wss://desktop.tailnet.ts.net:44342/",
        ),
        LinkCase("https://app.studio.invalid/pair?host=%2F%2Fremote.example.com#token=pairing-token", "pairing-token", "https://remote.example.com/", "wss://remote.example.com/"),
        // pairing.test.ts
        LinkCase(
            "https://app.studio.invalid/pair?host=https%3A%2F%2Fdesktop.tailnet.ts.net%2F#token=pairing-token",
            "pairing-token", "https://desktop.tailnet.ts.net/", "wss://desktop.tailnet.ts.net/",
        ),
        LinkCase("  https://remote.example.com/pair#token=pairing-token  ", "pairing-token", "https://remote.example.com/", "wss://remote.example.com/"),
        LinkCase(
            "studio://pair?pairingUrl=https%3A%2F%2Fremote.example.com%2Fpair%23token%3Dpairing-token",
            "pairing-token", "https://remote.example.com/", "wss://remote.example.com/",
        ),
        // App-scheme wrappers
        LinkCase("studio-dev://pair?pairingUrl=http%3A%2F%2F192.168.1.20%3A8319%2Fpair%23token%3DABC234", "ABC234", "http://192.168.1.20:8319/", "ws://192.168.1.20:8319/"),
        LinkCase("specwithcode://pair?pairingUrl=https%3A%2F%2Fm4.tail1234.ts.net%2F%23token%3DXYZ789", "XYZ789", "https://m4.tail1234.ts.net/", "wss://m4.tail1234.ts.net/"),
        LinkCase("specwithcode:pair?pairingUrl=https%3A%2F%2Fm4.tail1234.ts.net%2F%23token%3DXYZ789", "XYZ789", "https://m4.tail1234.ts.net/", "wss://m4.tail1234.ts.net/"),
        LinkCase("specwithcode://pair?link=https%3A%2F%2Fm4.tail1234.ts.net%2Fpair%23token%3DXYZ789", "XYZ789", "https://m4.tail1234.ts.net/", "wss://m4.tail1234.ts.net/"),
        LinkCase("specwithcode://pair?host=https%3A%2F%2Fm4.tail1234.ts.net&token=XYZ789", "XYZ789", "https://m4.tail1234.ts.net/", "wss://m4.tail1234.ts.net/"),
        // Origin only: path, query, user info and default ports go
        LinkCase("http://192.168.1.20:8319/pair#token=ABC", "ABC", "http://192.168.1.20:8319/", "ws://192.168.1.20:8319/"),
        LinkCase("https://user:secret@M4.Example.COM:443/deep/path?x=1#token=ABC", "ABC", "https://m4.example.com/", "wss://m4.example.com/"),
        LinkCase("http://m4.local:80/#token=ABC", "ABC", "http://m4.local/", "ws://m4.local/"),
        LinkCase("wss://m4.example.com/ws#token=ABC", "ABC", "https://m4.example.com/", "wss://m4.example.com/"),
        LinkCase("http://[fd7a:115c:a1e0::1]:8319/#token=ABC", "ABC", "http://[fd7a:115c:a1e0::1]:8319/", "ws://[fd7a:115c:a1e0::1]:8319/"),
        // The fragment token wins over the query token; tokens are trimmed
        LinkCase("https://remote.example.com/pair?token=query-token#token=hash-token", "hash-token", "https://remote.example.com/", "wss://remote.example.com/"),
        LinkCase("https://remote.example.com/pair#token=%20padded%20", "padded", "https://remote.example.com/", "wss://remote.example.com/"),
        // A pasted link without a scheme
        LinkCase("192.168.1.20:8319/pair#token=ABC", "ABC", "http://192.168.1.20:8319/", "ws://192.168.1.20:8319/"),
        LinkCase("m4.tail1234.ts.net#token=ABC", "ABC", "https://m4.tail1234.ts.net/", "wss://m4.tail1234.ts.net/"),
        // A real 12-character code from the server alphabet
        LinkCase("http://192.168.1.5:8319/pair#token=7KQ2MZ9XPTB4", "7KQ2MZ9XPTB4", "http://192.168.1.5:8319/", "ws://192.168.1.5:8319/"),
    )

    @Test
    fun parsesEveryLinkForm() {
        for (case in links) {
            val target = PairingLink.parse(case.input)
            assertEquals(case.code, target.code, case.input)
            assertEquals(case.http, target.httpBase, case.input)
            assertEquals(case.ws, target.wsBase, case.input)
        }
    }

    @Test
    fun hostedLinksCarryTheirLabel() {
        val target = PairingLink.parse("https://app.studio.invalid/pair?host=https%3A%2F%2Fm4.tail1234.ts.net&label=Office%20Mac#token=ABC")
        assertEquals("Office Mac", target.label)
        assertEquals("https://m4.tail1234.ts.net/", target.httpBase)
        assertNull(PairingLink.parse("https://remote.example.com/#token=ABC").label)
        assertEquals("Desk", PairingLink.parse("specwithcode://pair?host=m4.example.com&token=X&label=+Desk+").label)
    }

    @Test
    fun manualHostsPickASchemeLikeTheMobileApp() {
        val cases = listOf(
            "https://remote.example.com" to "https://remote.example.com/",
            "//remote.example.com" to "https://remote.example.com/",
            "//remote.example.com:3000" to "https://remote.example.com:3000/",
            "///example.com" to "https://example.com/",
            "//https://example.com" to "https://example.com/",
            "myserver.com:3000" to "https://myserver.com:3000/",
            "192.168.1.100:8319" to "http://192.168.1.100:8319/",
            "remote.example.com" to "https://remote.example.com/",
            "https://192.168.1.100:8319" to "https://192.168.1.100:8319/",
            "[::1]:8319" to "http://[::1]:8319/",
        )
        for ((host, http) in cases) {
            val target = PairingLink.manual(host, " pairing-token ")
            assertEquals("pairing-token", target.code, host)
            assertEquals(http, target.httpBase, host)
            assertEquals(http.replaceFirst("http", "ws"), target.wsBase, host)
            assertNull(target.label)
        }
    }

    @Test
    fun rejectsOtherSchemes() {
        assertEquals("ftp", assertFailsWith<PairingLinkException.InvalidLink> { PairingLink.parse("ftp://remote.example.com/pair#token=x") }.scheme)
        val hosted = assertFailsWith<PairingLinkException.InvalidHost> {
            PairingLink.parse("https://app.studio.invalid/pair?host=ftp%3A%2F%2Fremote.example.com#token=x")
        }
        assertEquals(PairingLinkException.HostSource.HOSTED_PAIRING_HOST, hosted.source)
        assertEquals("ftp", hosted.scheme)
        val direct = assertFailsWith<PairingLinkException.InvalidHost> { PairingLink.manual("ftp://remote.example.com", "x") }
        assertEquals(PairingLinkException.HostSource.DIRECT_HOST, direct.source)
    }

    @Test
    fun reportsWhatIsMissing() {
        assertFailsWith<PairingLinkException.Empty> { PairingLink.parse("   ") }
        assertFailsWith<PairingLinkException.MissingHost> { PairingLink.manual("", "") }
        assertEquals("remote.example.com", assertFailsWith<PairingLinkException.MissingToken> { PairingLink.parse("https://remote.example.com/pair") }.host)
        assertEquals(
            "remote.example.com",
            assertFailsWith<PairingLinkException.MissingCode> {
                PairingLink.manual("https://user:secret@remote.example.com/path?token=sensitive#fragment", "")
            }.host,
        )
        assertEquals("remote.example.com:3000", assertFailsWith<PairingLinkException.MissingToken> { PairingLink.parse("https://remote.example.com:3000/pair#token=") }.host)
        assertNull(assertFailsWith<PairingLinkException.InvalidLink> { PairingLink.parse("not a url") }.scheme)
        assertFailsWith<PairingLinkException.InvalidHost> { PairingLink.manual("https://[invalid", "x") }
        assertEquals("studio", assertFailsWith<PairingLinkException.InvalidLink> { PairingLink.parse("studio://pair?other=1") }.scheme)
        assertEquals("Enter a pairing code.", PairingLinkException.MissingCode("x").message)
    }

    @Test
    fun rejectsHostsThatWouldMoveTheAuthority() {
        for (link in listOf(
            "http://a%20b:8319/pair#token=x",
            "http://a%5Bb/#token=x",
            "http://a%7Cb/#token=x",
            "http://a%22b/#token=x",
            "http://a%00b/#token=x",
            "http://host:99999/#token=x",
            "http://host:abc/#token=x",
            "specwithcode://pair?pairingUrl=http%3A%2F%2Fa%2520b%3A8319%2Fpair%23token%3Dx",
        )) {
            assertFailsWith<PairingLinkException>(link) { PairingLink.parse(link) }
        }
        // A decoded `/` or `@` must not move the authority to another host.
        assertEquals("http", assertFailsWith<PairingLinkException.InvalidLink> { PairingLink.parse("http://a%2Fb%40evil.com/#token=x") }.scheme)
        assertFailsWith<PairingLinkException.InvalidHost> { PairingLink.manual("a%5Bb", "1") }
        assertNull(MachineRoute.fromHttpBase("http://a%20b:8319/"))
    }

    @Test
    fun keepsEveryValidHostForm() {
        for ((link, http) in listOf(
            "http://[::ffff:192.168.1.5]:8319/#token=x" to "http://[::ffff:192.168.1.5]:8319/",
            "http://[::1]:8319/#token=x" to "http://[::1]:8319/",
            "https://M4.Tail1234.TS.NET.:8443/#token=x" to "https://m4.tail1234.ts.net:8443/",
            "m4.local:8319#token=x" to "https://m4.local:8319/",
            "http://my_host.lan:8319/#token=x" to "http://my_host.lan:8319/",
        )) {
            assertEquals(http, PairingLink.parse(link).httpBase, link)
        }
    }

    @Test
    fun unwrapsAppSchemes() {
        assertEquals("https://remote.example.com/pair#token=pairing-token", PairingLink.unwrap("  https://remote.example.com/pair#token=pairing-token  "))
        assertEquals(
            "https://remote.example.com/pair#token=pairing-token",
            PairingLink.unwrap("studio://pair?pairingUrl=https%3A%2F%2Fremote.example.com%2Fpair%23token%3Dpairing-token"),
        )
        assertEquals("studio://pair", PairingLink.unwrap("studio://pair"))
        assertEquals("https://m4.tail1234.ts.net/pair#token=XYZ789", PairingLink.unwrap("specwithcode://pair?link=https%3A%2F%2Fm4.tail1234.ts.net%2Fpair%23token%3DXYZ789"))
    }

    @Test
    fun classifiesHosts() {
        val cases = mapOf(
            "localhost" to RouteKind.LOOPBACK,
            "127.0.0.1" to RouteKind.LOOPBACK,
            "[::1]" to RouteKind.LOOPBACK,
            "192.168.1.20" to RouteKind.LAN,
            "10.0.0.5" to RouteKind.LAN,
            "172.20.1.1" to RouteKind.LAN,
            "m4.local" to RouteKind.LAN,
            "m4" to RouteKind.LAN,
            "fe80::1" to RouteKind.LAN,
            "fd00::1" to RouteKind.LAN,
            "100.101.102.103" to RouteKind.TAILNET,
            "m4.tail1234.ts.net" to RouteKind.TAILNET,
            "fd7a:115c:a1e0::1" to RouteKind.TAILNET,
            "relay.spec-weave.com" to RouteKind.PUBLIC,
            "8.8.8.8" to RouteKind.PUBLIC,
            "2001:db8::1" to RouteKind.PUBLIC,
        )
        for ((host, kind) in cases) assertEquals(kind, RouteKind.classify(host), host)
        assertTrue(HostClassification.isIPLiteral("192.168.1.2:8319"))
        assertTrue(HostClassification.isIPLiteral("[::1]:8319"))
        assertTrue(HostClassification.isIPLiteral("fe80::1"))
        assertFalse(HostClassification.isIPLiteral("m4.local:8319"))
        assertFalse(HostClassification.isIPLiteral("256.1.1.1"))
        assertEquals(listOf(192, 168, 1, 5), HostClassification.ipv4Mapped("::ffff:c0a8:105"))
    }

    @Test
    fun formEncodingMatchesUrlSearchParams() {
        assertEquals("Wire+probe+%28Swift+stand-in%29", FormQuery.encodeComponent("Wire probe (Swift stand-in)"))
        assertEquals("a%7Eb*c_d.e-f", FormQuery.encodeComponent("a~b*c_d.e-f"))
        assertEquals("%C3%A9", FormQuery.encodeComponent("é"))
        assertEquals("a b", FormQuery("x=a+b")["x"])
        assertEquals("é", FormQuery("x=%C3%A9")["x"])
        assertEquals("100%", FormQuery("x=100%")["x"])
    }
}
