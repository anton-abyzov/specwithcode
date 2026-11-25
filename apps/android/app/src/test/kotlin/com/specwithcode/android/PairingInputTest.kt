package com.specwithcode.android

import com.specwithcode.android.app.DeepLink
import com.specwithcode.android.app.PairingInput
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PairingInputTest {
    private val code = "ABCD2345EFGH"

    @Test fun bareIpGetsHttpAndNamesGetHttps() {
        assertEquals("http://192.168.1.20:3773/pair#token=$code", PairingInput.manualLink("192.168.1.20:3773", code))
        assertEquals("https://m4.example.ts.net/pair#token=$code", PairingInput.manualLink(" m4.example.ts.net/ ", code))
        assertEquals("http://[fe80::1]:3773", PairingInput.origin("[fe80::1]:3773"))
        assertEquals("https://studio.local:3773", PairingInput.origin("https://studio.local:3773/pair"))
        assertNull(PairingInput.origin("ftp://studio.local"))
        assertNull(PairingInput.origin("my host"))
        assertNull(PairingInput.origin(""))
    }

    @Test fun codesAreNormalizedAndChecked() {
        assertEquals(code, PairingInput.normalizeCode("abcd-2345 efgh"))
        assertTrue(PairingInput.isValidCode("abcd-2345-efgh"))
        assertFalse(PairingInput.isValidCode("ABCD2345EFG"), "too short")
        assertFalse(PairingInput.isValidCode("ABCD2345EFG0"), "0 is not in the alphabet")
        assertNull(PairingInput.manualLink("192.168.1.20", "short"))
    }

    @Test fun wrappedLinksUnwrap() {
        val real = "https://m4.example.ts.net/pair#token=$code"
        val encoded = java.net.URLEncoder.encode(real, "UTF-8")
        assertEquals(real, PairingInput.unwrap("studio://pair?pairingUrl=$encoded"))
        assertEquals(real, PairingInput.unwrap("specwithcode://pair?link=$encoded"))
        assertEquals(real, PairingInput.unwrap(real))
        assertTrue(PairingInput.isCleartext("studio-dev://pair?pairingUrl=" + java.net.URLEncoder.encode("http://10.0.0.2:3773/#token=$code", "UTF-8")))
        assertFalse(PairingInput.isCleartext(real))
    }

    @Test fun hostedLinksShowAndCheckTheMachineTheyPairWith() {
        // Pairing sends the code to the `?host=` machine, so the banner and the guards read that one.
        val other = "https://my-mac.local/pair?host=https%3A%2F%2Fother.example&label=Mac#token=$code"
        assertEquals("other.example", PairingInput.host(other))
        assertFalse(PairingInput.isCleartext(other))

        val cleartext = "https://x.example/pair?host=http%3A%2F%2F203.0.113.5%3A3773#token=$code"
        assertEquals("203.0.113.5", PairingInput.host(cleartext))
        assertTrue(PairingInput.isCleartext(cleartext))
        assertTrue(PairingInput.isPublicCleartext(cleartext))

        val wrapped = "specwithcode://pair?link=" + java.net.URLEncoder.encode(cleartext, "UTF-8")
        assertEquals("203.0.113.5", PairingInput.host(wrapped))
        assertTrue(PairingInput.isPublicCleartext(wrapped))

        // A plain link keeps today's answers.
        assertEquals("m4.example.ts.net", PairingInput.host("https://m4.example.ts.net/pair#token=$code"))
        assertEquals("10.0.0.2", PairingInput.host("http://10.0.0.2:3773/#token=$code"))
        assertTrue(PairingInput.isCleartext("http://10.0.0.2:3773/#token=$code"))
        assertFalse(PairingInput.isPublicCleartext("http://10.0.0.2:3773/#token=$code"))
    }

    @Test fun deepLinksOpenPairingOrAThread() {
        val real = "https://m4.example.ts.net/pair#token=$code"
        assertEquals(DeepLink.Pair(real), DeepLink.parse("studio://pair?pairingUrl=" + java.net.URLEncoder.encode(real, "UTF-8")))
        assertEquals(DeepLink.Thread("env-studio-mac", "t-release"), DeepLink.parse("specwithcode://thread/env-studio-mac/t-release"))
        assertNull(DeepLink.parse("https://example.com"))
        assertNull(DeepLink.parse("studio://somewhere"))
        assertNull(DeepLink.parse(null))
    }
}
