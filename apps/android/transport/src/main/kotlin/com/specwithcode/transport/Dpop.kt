package com.specwithcode.transport

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.HttpUrl
import java.math.BigInteger
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.time.Instant
import java.util.Base64
import java.util.UUID

/**
 * A P-256 key that signs DPoP proofs (RFC 9449). The relay and the machine bind their access
 * tokens to its thumbprint, so a stolen token is useless without the key.
 *
 * The Android app backs this with an Android Keystore key; tests use [SoftwareDpopKey].
 */
interface DpopKey {
    /** Uncompressed public point coordinates, 32 bytes each. */
    val publicX: ByteArray
    val publicY: ByteArray

    /** ES256 over [message]: raw `r || s`, 64 bytes. Use [Ecdsa.derToRaw] on JCA output. */
    fun sign(message: ByteArray): ByteArray

    val jwk: DpopJwk get() = DpopJwk(Base64Url.encode(publicX), Base64Url.encode(publicY))
    val thumbprint: String get() = jwk.thumbprint
}

/** The public JWK of a DPoP key. */
data class DpopJwk(val x: String, val y: String) {
    val kty: String get() = "EC"
    val crv: String get() = "P-256"

    /** RFC 7638: SHA-256 of the required members in lexicographic order. */
    val thumbprint: String
        get() = Base64Url.encode(sha256("""{"crv":"P-256","kty":"EC","x":"$x","y":"$y"}""".toByteArray()))

    /** Members in lexicographic order. */
    fun toJson(): JsonObject = JsonObject(
        linkedMapOf("crv" to JsonPrimitive(crv), "kty" to JsonPrimitive(kty), "x" to JsonPrimitive(x), "y" to JsonPrimitive(y)),
    )
}

/** Builds DPoP proofs as the relay and the machine verify them (`packages/shared/src/dpop.ts`). */
object DpopProof {
    /**
     * A compact JWS for one request. [accessToken] adds `ath`, required on requests that carry
     * `Authorization: DPoP <token>`.
     */
    fun make(
        key: DpopKey,
        method: String,
        url: HttpUrl,
        accessToken: String? = null,
        now: Instant = Instant.now(),
        jti: String = UUID.randomUUID().toString(),
    ): String {
        val header = JsonObject(
            linkedMapOf("alg" to JsonPrimitive("ES256"), "jwk" to key.jwk.toJson(), "typ" to JsonPrimitive("dpop+jwt")),
        )
        val payload = linkedMapOf<String, kotlinx.serialization.json.JsonElement>()
        if (accessToken != null) payload["ath"] = JsonPrimitive(accessTokenHash(accessToken))
        payload["htm"] = JsonPrimitive(method.uppercase())
        payload["htu"] = JsonPrimitive(htu(url))
        payload["iat"] = JsonPrimitive(now.epochSecond)
        payload["jti"] = JsonPrimitive(jti)
        val signingInput = Base64Url.encode(header.toString().toByteArray()) + "." +
            Base64Url.encode(JsonObject(payload).toString().toByteArray())
        val signature = Ecdsa.lowS(key.sign(signingInput.toByteArray()))
        return signingInput + "." + Base64Url.encode(signature)
    }

    fun accessTokenHash(token: String): String = Base64Url.encode(sha256(token.toByteArray()))

    /** The URL without query and fragment, as WHATWG `URL.toString()` prints it. */
    fun htu(url: HttpUrl): String = url.newBuilder().query(null).fragment(null).build().toString()
}

/** P-256 ECDSA signature forms. */
object Ecdsa {
    /** The P-256 group order. */
    val order = BigInteger("FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551", 16)
    private val halfOrder: BigInteger = order.shiftRight(1)

    /**
     * Rewrites `r || s` with `s > n/2` as `r || n - s`. Both verify, but noble (the relay's
     * verifier) accepts only the low form.
     */
    fun lowS(signature: ByteArray): ByteArray {
        require(signature.size == 64) { "An ES256 signature is 64 bytes" }
        val s = BigInteger(1, signature.copyOfRange(32, 64))
        if (s <= halfOrder) return signature
        return signature.copyOfRange(0, 32) + fixed32(order.subtract(s))
    }

    /** A DER `SEQUENCE { INTEGER r, INTEGER s }` (JCA and Android Keystore output) as raw `r || s`. */
    fun derToRaw(der: ByteArray): ByteArray {
        var i = 0
        fun readLength(): Int {
            val first = der[i++].toInt() and 0xff
            if (first < 0x80) return first
            var len = 0
            repeat(first and 0x7f) { len = (len shl 8) or (der[i++].toInt() and 0xff) }
            return len
        }
        require(der[i++].toInt() == 0x30) { "Not a DER sequence" }
        readLength()
        fun readInt(): BigInteger {
            require(der[i++].toInt() == 0x02) { "Not a DER integer" }
            val len = readLength()
            val value = BigInteger(1, der.copyOfRange(i, i + len))
            i += len
            return value
        }
        val r = readInt()
        val s = readInt()
        return fixed32(r) + fixed32(s)
    }

    /** Raw `r || s` as DER, for JCA verification. */
    fun rawToDer(raw: ByteArray): ByteArray {
        require(raw.size == 64)
        fun integer(bytes: ByteArray): ByteArray {
            val trimmed = BigInteger(1, bytes).toByteArray() // Keeps a leading 0 when the high bit is set.
            return byteArrayOf(0x02, trimmed.size.toByte()) + trimmed
        }
        val body = integer(raw.copyOfRange(0, 32)) + integer(raw.copyOfRange(32, 64))
        return byteArrayOf(0x30, body.size.toByte()) + body
    }

    /** An unsigned big-endian integer as exactly 32 bytes. */
    fun fixed32(value: BigInteger): ByteArray {
        val bytes = value.toByteArray()
        return when {
            bytes.size == 32 -> bytes
            bytes.size > 32 -> bytes.copyOfRange(bytes.size - 32, bytes.size)
            else -> ByteArray(32 - bytes.size) + bytes
        }
    }
}

object Base64Url {
    fun encode(data: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(data)
    fun decode(text: String): ByteArray? = runCatching { Base64.getUrlDecoder().decode(text) }.getOrNull()
}

internal fun sha256(data: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(data)

/** A software key from the JCA, for tests and for devices without a usable Keystore. */
class SoftwareDpopKey(val keyPair: KeyPair = generate()) : DpopKey {
    private val point = (keyPair.public as ECPublicKey).w
    override val publicX: ByteArray = Ecdsa.fixed32(point.affineX)
    override val publicY: ByteArray = Ecdsa.fixed32(point.affineY)

    override fun sign(message: ByteArray): ByteArray {
        val signer = Signature.getInstance("SHA256withECDSA")
        signer.initSign(keyPair.private)
        signer.update(message)
        return Ecdsa.derToRaw(signer.sign())
    }

    companion object {
        fun generate(): KeyPair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
    }
}

/** Where the device's DPoP key lives. */
interface DpopKeyStore {
    /** The saved key, or a new one saved first. */
    fun loadOrCreate(): DpopKey

    /** Forgets the key, e.g. on sign-out. Tokens bound to it stop working. */
    fun reset()
}

/** For tests and previews. */
class InMemoryDpopKeyStore(private var key: DpopKey? = null) : DpopKeyStore {
    @Synchronized
    override fun loadOrCreate(): DpopKey = key ?: SoftwareDpopKey().also { key = it }

    @Synchronized
    override fun reset() {
        key = null
    }
}
