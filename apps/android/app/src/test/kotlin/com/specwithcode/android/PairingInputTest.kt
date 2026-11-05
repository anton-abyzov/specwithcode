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

    @Test fun deepLinksOpenPairingOrAThread() {
        val real = "https://m4.example.ts.net/pair#token=$code"
        assertEquals(DeepLink.Pair(real), DeepLink.parse("studio://pair?pairingUrl=" + java.net.URLEncoder.encode(real, "UTF-8")))
        assertEquals(DeepLink.Thread("env-studio-mac", "t-release"), DeepLink.parse("specwithcode://thread/env-studio-mac/t-release"))
        assertNull(DeepLink.parse("https://example.com"))
        assertNull(DeepLink.parse("studio://somewhere"))
        assertNull(DeepLink.parse(null))
    }
}
