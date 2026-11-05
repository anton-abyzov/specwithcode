package com.specwithcode.transport

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import com.specwithcode.wire.WireJson
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Test
import java.io.File
import java.math.BigInteger
import java.security.Signature
import java.time.Instant
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class DpopTest {
    private val key = SoftwareDpopKey()
    private val now = Instant.ofEpochSecond(1_762_300_000)

    private fun part(proof: String, index: Int): JsonObject =
        WireJson.parseToJsonElement(Base64Url.decode(proof.split('.')[index])!!.decodeToString()).jsonObject

    @Test
    fun proofHasTheHeaderAndClaimsTheVerifierChecks() {
        val proof = DpopProof.make(key, "post", "https://relay.example.com/v1/client/dpop-token?x=1#f".toHttpUrl(), now = now, jti = "jti-1")
        val parts = proof.split('.')
        assertEquals(3, parts.size)
        val header = part(proof, 0)
        assertEquals("dpop+jwt", header["typ"]!!.jsonPrimitive.content)
        assertEquals("ES256", header["alg"]!!.jsonPrimitive.content)
        val jwk = header["jwk"]!!.jsonObject
        assertEquals(listOf("crv", "kty", "x", "y"), jwk.keys.toList())
        assertEquals("EC", jwk["kty"]!!.jsonPrimitive.content)
        assertEquals("P-256", jwk["crv"]!!.jsonPrimitive.content)
        assertEquals(key.jwk.x, jwk["x"]!!.jsonPrimitive.content)
        assertEquals(32, Base64Url.decode(key.jwk.y)!!.size)

        val payload = part(proof, 1)
        assertEquals("POST", payload["htm"]!!.jsonPrimitive.content)
        assertEquals("https://relay.example.com/v1/client/dpop-token", payload["htu"]!!.jsonPrimitive.content)
        assertEquals(now.epochSecond, payload["iat"]!!.jsonPrimitive.long)
        assertEquals("jti-1", payload["jti"]!!.jsonPrimitive.content)
        assertNull(payload["ath"])
        // Raw R||S, not DER.
        assertEquals(64, Base64Url.decode(parts[2])!!.size)
        assertFalse(proof.contains('=') || proof.contains('+') || proof.contains('/'))
    }

    @Test
    fun signatureVerifiesWithTheJwkAndIsLowS() {
        repeat(16) {
            val k = SoftwareDpopKey()
            val proof = DpopProof.make(k, "GET", "https://m4.example.com/api/auth/session".toHttpUrl(), accessToken = "t", now = now)
            val (h, p, s) = proof.split('.')
            val raw = Base64Url.decode(s)!!
            assertTrue(BigInteger(1, raw.copyOfRange(32, 64)) <= Ecdsa.order.shiftRight(1))
            val verifier = Signature.getInstance("SHA256withECDSA")
            verifier.initVerify(k.keyPair.public)
            verifier.update("$h.$p".toByteArray())
            assertTrue(verifier.verify(Ecdsa.rawToDer(raw)))
        }
    }

    @Test
    fun athIsTheBase64UrlSha256OfTheAccessToken() {
        val proof = DpopProof.make(key, "POST", "https://relay.example.com/v1/environments/e/connect".toHttpUrl(), accessToken = "relay-access-token", now = now)
        val expected = Base64Url.encode(sha256("relay-access-token".toByteArray()))
        assertEquals(expected, part(proof, 1)["ath"]!!.jsonPrimitive.content)
        assertEquals(expected, DpopProof.accessTokenHash("relay-access-token"))
        // RFC 9449 section 7.1 example.
        assertEquals("fUHyO2r2Z3DZ53EsNrWBb0xWXoaNy59IiKCAqksmQEo", DpopProof.accessTokenHash("Kz~8mXK1EalYznwH-LC-1fBAo.4Ljp~zsPE_NeO.gxU"))
    }

    @Test
    fun thumbprintIsRfc7638OverSortedMembers() {
        // RFC 7638 section 3.1 uses RSA; this pins the EC member order and the hash.
        val jwk = DpopJwk("f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU", "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0")
        val input = """{"crv":"P-256","kty":"EC","x":"f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU","y":"x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0"}"""
        assertEquals(Base64Url.encode(sha256(input.toByteArray())), jwk.thumbprint)
        assertEquals(key.thumbprint, key.jwk.thumbprint)
        assertEquals(43, key.thumbprint.length)
    }

    @Test
    fun htuDropsQueryFragmentAndDefaultPort() {
        assertEquals("https://relay.example.com/v1/x", DpopProof.htu("HTTPS://Relay.Example.COM:443/v1/x?y=1#frag".toHttpUrl()))
        assertEquals("https://m4.example.com/", DpopProof.htu("https://m4.example.com".toHttpUrl()))
        assertEquals("http://localhost:8787/oauth/token", DpopProof.htu("http://localhost:8787/oauth/token".toHttpUrl()))
        assertEquals("https://relay.example.com/v1/environments/env%201/connect", DpopProof.htu("https://relay.example.com/v1/environments/env%201/connect".toHttpUrl()))
    }

    @Test
    fun highSIsFlippedToTheLowForm() {
        val r = ByteArray(32) { 7 }
        val highS = Ecdsa.fixed32(Ecdsa.order.subtract(BigInteger.ONE))
        val flipped = Ecdsa.lowS(r + highS)
        assertContentEquals(r, flipped.copyOfRange(0, 32))
        assertContentEquals(ByteArray(31) + byteArrayOf(1), flipped.copyOfRange(32, 64))
        val low = r + ByteArray(31) + byteArrayOf(5)
        assertContentEquals(low, Ecdsa.lowS(low))
        assertFailsWith<IllegalArgumentException> { Ecdsa.lowS(ByteArray(63)) }
    }

    @Test
    fun derAndRawRoundTrip() {
        repeat(32) {
            val der = Signature.getInstance("SHA256withECDSA").run {
                initSign(key.keyPair.private)
                update(byteArrayOf(it.toByte()))
                sign()
            }
            val raw = Ecdsa.derToRaw(der)
            assertEquals(64, raw.size)
            assertContentEquals(raw, Ecdsa.derToRaw(Ecdsa.rawToDer(raw)))
        }
    }

    /**
     * Writes proofs for `Tools/verify-dpop-vectors.mjs`, which checks them with the relay's own
     * verifier (`packages/shared/src/dpop.ts`). Does nothing unless DPOP_VECTORS_OUT is set.
     */
    @Test
    fun writesVectorsForTheRelayVerifier() {
        val out = System.getenv("DPOP_VECTORS_OUT")
        if (out.isNullOrEmpty()) return
        val now = Instant.now()
        val targets = listOf(
            Triple("POST", "https://relay.example.com/v1/client/dpop-token", null),
            Triple("POST", "https://relay.example.com/v1/environments/env%201/connect", "relay-access-token"),
            Triple("GET", "https://m4-abc.tunnels.example.com/api/auth/session?x=1", "machine-token"),
            Triple("POST", "https://m4-abc.tunnels.example.com/oauth/token", null),
            Triple("POST", "http://192.168.1.20:8319/api/auth/websocket-ticket", "lan-token"),
        )
        val vectors = mutableListOf<JsonObject>()
        targets.forEachIndexed { index, (method, url, token) ->
            repeat(8) { round ->
                val k = SoftwareDpopKey()
                val proof = DpopProof.make(k, method, url.toHttpUrl(), accessToken = token, now = now, jti = "vector-$index-$round")
                val fields = linkedMapOf(
                    "proof" to JsonPrimitive(proof),
                    "method" to JsonPrimitive(method),
                    "url" to JsonPrimitive(url),
                    "iat" to JsonPrimitive(now.epochSecond),
                    "thumbprint" to JsonPrimitive(k.thumbprint),
                )
                if (token != null) fields["accessToken"] = JsonPrimitive(token)
                vectors += JsonObject(fields)
            }
        }
        File(out).writeText(JsonArray(vectors).toString())
    }
}
