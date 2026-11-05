package com.specwithcode.android.app.secure

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStoreFile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import java.security.KeyStore
import java.util.Base64
import javax.crypto.BadPaddingException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Encrypts small secrets. The Android implementation keeps its key in the Keystore. */
interface SecretBox {
    fun seal(plain: ByteArray): ByteArray

    /** Throws when the data was sealed with another key (for example after a restore to a new phone). */
    fun open(sealed: ByteArray): ByteArray
}

/**
 * AES-256-GCM with a key that lives in the Android Keystore and never leaves it. The output is
 * the 12-byte IV followed by the ciphertext and tag.
 */
class KeystoreSecretBox(private val alias: String) : SecretBox {
    @Volatile private var key: SecretKey? = null

    private fun key(): SecretKey = key ?: synchronized(this) {
        key ?: run {
            val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
            (store.getKey(alias, null) as? SecretKey) ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE).run {
                init(
                    KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                        .setKeySize(256)
                        .setRandomizedEncryptionRequired(true)
                        .build(),
                )
                generateKey()
            }
        }.also { key = it }
    }

    override fun seal(plain: ByteArray): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        return cipher.iv + cipher.doFinal(plain)
    }

    override fun open(sealed: ByteArray): ByteArray {
        require(sealed.size > IV_BYTES) { "Sealed data is too short" }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, sealed, 0, IV_BYTES))
        return cipher.doFinal(sealed, IV_BYTES, sealed.size - IV_BYTES)
    }

    private companion object {
        const val KEYSTORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
    }
}

/** Where sealed values are kept, as strings by key. */
interface SealedValueFile {
    fun readAll(): Map<String, String>

    /** Writes or (with null) removes one value, durably, before returning. */
    fun write(key: String, value: String?)
}

/**
 * A DataStore preferences file (`files/datastore/credentials.preferences_pb`, excluded from
 * backup). Every call blocks on disk I/O, so callers must not be on the main thread: the app
 * warms [SecureValues] on a background thread at startup and reads sign-in state off it.
 */
class DataStoreSealedValueFile(context: Context, name: String = "credentials") : SealedValueFile {
    private val store: DataStore<Preferences> = PreferenceDataStoreFactory.create(
        produceFile = { context.applicationContext.preferencesDataStoreFile(name) },
    )

    override fun readAll(): Map<String, String> = runBlocking(Dispatchers.IO) {
        store.data.first().asMap().entries.mapNotNull { (key, value) -> (value as? String)?.let { key.name to it } }.toMap()
    }

    override fun write(key: String, value: String?) {
        runBlocking(Dispatchers.IO) {
            store.edit { prefs ->
                val preference = stringPreferencesKey(key)
                if (value == null) prefs.remove(preference) else prefs[preference] = value
            }
        }
    }
}

/**
 * Sealed strings by key, cached in memory after the first complete read. The first read and
 * every [put] block on disk and Keystore work: call them off the main thread ([warm] at startup).
 *
 * Only a complete read is cached. When the file or the Keystore fails for a moment (for example
 * before the first unlock), the values readable so far are returned and the next access reads
 * again, so a transient failure never looks like a sign-out for the rest of the process.
 */
class SecureValues(private val file: SealedValueFile, private val box: SecretBox) {
    private val lock = Any()
    private var cache: MutableMap<String, String>? = null

    /** The values, and whether every stored one was read (only then is it cached). */
    private fun loaded(): Pair<MutableMap<String, String>, Boolean> {
        cache?.let { return it to true }
        val stored = try {
            file.readAll()
        } catch (_: Exception) {
            return HashMap<String, String>() to false
        }
        val values = HashMap<String, String>()
        var complete = true
        for ((key, sealed) in stored) {
            try {
                values[key] = String(box.open(Base64.getDecoder().decode(sealed)), Charsets.UTF_8)
            } catch (e: Exception) {
                // A value sealed by a key this phone no longer has (or corrupt data) stays
                // unreadable: drop it. Any other Keystore failure is retried on the next access.
                if (!isPermanentlyUnreadable(e)) complete = false
            }
        }
        if (complete) cache = values
        return values to complete
    }

    /** Loads and opens every value now, so later reads come from memory. */
    fun warm() {
        synchronized(lock) { loaded() }
    }

    fun get(key: String): String? = synchronized(lock) { loaded().first[key] }

    fun keys(): Set<String> = synchronized(lock) { loaded().first.keys.toSet() }

    fun put(key: String, value: String?) = synchronized(lock) {
        val (values, complete) = loaded()
        if (value == null) {
            // A partial read may not hold the key, so the file is written anyway.
            if (values.remove(key) != null || !complete) file.write(key, null)
        } else {
            file.write(key, Base64.getEncoder().encodeToString(box.seal(value.toByteArray(Charsets.UTF_8))))
            values[key] = value
        }
    }

    internal companion object {
        /** Wrong key or corrupt bytes: retrying cannot help. */
        fun isPermanentlyUnreadable(error: Throwable): Boolean =
            error is BadPaddingException || error is IllegalArgumentException
    }
}
