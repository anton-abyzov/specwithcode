package com.specwithcode.android.app.secure

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.specwithcode.transport.DpopKey
import com.specwithcode.transport.DpopKeyStore
import com.specwithcode.transport.Ecdsa
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.KeyStoreException
import java.security.PrivateKey
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

/**
 * The device's DPoP key for SpecWithCode Connect: EC P-256 in the Android Keystore.
 *
 * Only a missing alias creates a new key. Any other Keystore failure is thrown, so a
 * transient error never replaces the key the relay knows this phone by; the next call retries.
 */
class KeystoreDpopKeyStore internal constructor(private val backend: Backend) : DpopKeyStore {
    constructor(alias: String = "specwithcode_dpop") : this(AndroidKeystoreBackend(alias))

    /** The Keystore operations the store needs, so the load-or-create rules can be tested off device. */
    internal interface Backend {
        fun containsKey(): Boolean

        /** The saved key pair; throws when the Keystore cannot read it. */
        fun entry(): KeyPair

        fun generate(): KeyPair

        fun delete()
    }

    @Volatile private var cached: DpopKey? = null

    override fun loadOrCreate(): DpopKey = cached ?: synchronized(this) {
        cached ?: (load() ?: create()).also { cached = it }
    }

    /** The saved key, or null only when none is saved. */
    private fun load(): DpopKey? {
        if (!backend.containsKey()) return null
        val pair = backend.entry()
        val public = pair.public as? ECPublicKey ?: throw KeyStoreException("The device key is not an EC key")
        return KeystoreDpopKey(pair.private, public)
    }

    private fun create(): DpopKey {
        val pair = backend.generate()
        return KeystoreDpopKey(pair.private, pair.public as ECPublicKey)
    }

    override fun reset() = synchronized(this) {
        cached = null
        runCatching { backend.delete() }
        Unit
    }
}

private class AndroidKeystoreBackend(private val alias: String) : KeystoreDpopKeyStore.Backend {
    private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

    override fun containsKey(): Boolean = keyStore().containsAlias(alias)

    override fun entry(): KeyPair {
        val entry = keyStore().getEntry(alias, null) as? KeyStore.PrivateKeyEntry
            ?: throw KeyStoreException("The device key could not be read")
        return KeyPair(entry.certificate.publicKey, entry.privateKey)
    }

    override fun generate(): KeyPair {
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE)
        generator.initialize(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .build(),
        )
        return generator.generateKeyPair()
    }

    override fun delete() = keyStore().deleteEntry(alias)

    private companion object {
        const val KEYSTORE = "AndroidKeyStore"
    }
}

/** Signs with a Keystore key. The Keystore returns DER; DPoP wants raw `r || s`. */
class KeystoreDpopKey(private val privateKey: PrivateKey, publicKey: ECPublicKey) : DpopKey {
    override val publicX: ByteArray = Ecdsa.fixed32(publicKey.w.affineX)
    override val publicY: ByteArray = Ecdsa.fixed32(publicKey.w.affineY)

    override fun sign(message: ByteArray): ByteArray {
        val signer = Signature.getInstance("SHA256withECDSA")
        signer.initSign(privateKey)
        signer.update(message)
        return Ecdsa.derToRaw(signer.sign())
    }
}
