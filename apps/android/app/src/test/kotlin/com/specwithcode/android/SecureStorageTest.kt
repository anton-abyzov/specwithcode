package com.specwithcode.android

import com.specwithcode.android.app.secure.KeystoreCredentialStore
import com.specwithcode.android.app.secure.SealedValueFile
import com.specwithcode.android.app.secure.SecretBox
import com.specwithcode.android.app.secure.SecureValues
import com.specwithcode.transport.MachineCredential
import java.security.SecureRandom
import java.time.Instant
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The same AES-GCM layout as the Keystore box, with a software key. */
private class SoftwareBox(private val key: SecretKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()) : SecretBox {
    override fun seal(plain: ByteArray): ByteArray {
        val iv = ByteArray(12).also { SecureRandom().nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, iv)) }
        return iv + cipher.doFinal(plain)
    }

    override fun open(sealed: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, sealed, 0, 12)) }
        return cipher.doFinal(sealed, 12, sealed.size - 12)
    }
}

private class MemoryFile : SealedValueFile {
    val values = LinkedHashMap<String, String>()
    override fun readAll(): Map<String, String> = values.toMap()
    override fun write(key: String, value: String?) {
        if (value == null) values.remove(key) else values[key] = value
    }
}

class SecureStorageTest {
    private val credential = MachineCredential("tok-secret", Instant.parse("2027-01-01T00:00:00Z"), listOf("orchestration:read"))

    @Test fun credentialsAreSealedAtRestAndReadBackAfterRestart() {
        val file = MemoryFile()
        val box = SoftwareBox()
        KeystoreCredentialStore(SecureValues(file, box)).save(credential, "env-1", "https://m4.local")
        assertEquals(1, file.values.size)
        assertFalse(file.values.values.single().contains("tok-secret"), "the token must not be stored in the clear")

        // A new process reads the file again.
        val reopened = KeystoreCredentialStore(SecureValues(file, box))
        assertEquals(credential, reopened.credential("env-1", "https://m4.local"))
        assertNull(reopened.credential("env-1", "https://other"))
    }

    @Test fun removeForgetsEveryIssuerOfOneMachine() {
        val file = MemoryFile()
        val store = KeystoreCredentialStore(SecureValues(file, SoftwareBox()))
        store.save(credential, "env-1", "https://a")
        store.save(credential, "env-1", "specwithcode-connect")
        store.save(credential, "env-2", "https://b")
        store.remove("env-1")
        assertNull(store.credential("env-1", "https://a"))
        assertNull(store.credential("env-1", "specwithcode-connect"))
        assertEquals(credential, store.credential("env-2", "https://b"))
        assertEquals(1, file.values.size)
    }

    @Test fun valuesSealedWithAnotherKeyAreDropped() {
        val file = MemoryFile()
        KeystoreCredentialStore(SecureValues(file, SoftwareBox())).save(credential, "env-1", "https://a")
        // After a restore to a new phone the Keystore key is gone.
        val restored = KeystoreCredentialStore(SecureValues(file, SoftwareBox()))
        assertNull(restored.credential("env-1", "https://a"))
        assertTrue(file.values.isNotEmpty())
    }

    @Test fun aFailedReadIsRetriedInsteadOfCachedAsEmpty() {
        val file = MemoryFile()
        val box = SoftwareBox()
        SecureValues(file, box).put("connect:session", "sess_1")
        var failures = 1
        val flaky = object : SealedValueFile by file {
            override fun readAll(): Map<String, String> {
                if (failures-- > 0) throw java.io.IOException("not unlocked yet")
                return file.readAll()
            }
        }
        val values = SecureValues(flaky, box)
        assertNull(values.get("connect:session"))
        // Storage is readable again: the value comes back without a restart.
        assertEquals("sess_1", values.get("connect:session"))
    }

    @Test fun aTransientKeystoreFailureIsRetriedButAWrongKeyIsDropped() {
        val file = MemoryFile()
        val box = SoftwareBox()
        SecureValues(file, box).put("a", "1")
        var failures = 1
        val flaky = object : SecretBox by box {
            override fun open(sealed: ByteArray): ByteArray {
                if (failures-- > 0) throw java.security.ProviderException("Keystore busy")
                return box.open(sealed)
            }
        }
        val values = SecureValues(file, flaky)
        assertNull(values.get("a"))
        assertEquals("1", values.get("a"))
        // A removal during a partial read still reaches the file.
        val partial = SecureValues(file, object : SecretBox by box {
            override fun open(sealed: ByteArray): ByteArray = throw java.security.ProviderException("Keystore busy")
        })
        partial.put("a", null)
        assertTrue(file.values.isEmpty())
    }

    @Test fun theDeviceKeyIsCreatedOnlyWhenNoneIsSaved() {
        val saved = com.specwithcode.transport.SoftwareDpopKey.generate()
        var reads = 0
        var generated = 0
        val backend = object : com.specwithcode.android.app.secure.KeystoreDpopKeyStore.Backend {
            var present = true
            override fun containsKey() = present
            override fun entry(): java.security.KeyPair {
                if (reads++ == 0) throw java.security.KeyStoreException("Keystore busy")
                return saved
            }
            override fun generate(): java.security.KeyPair {
                generated++
                return com.specwithcode.transport.SoftwareDpopKey.generate()
            }
            override fun delete() {
                present = false
            }
        }
        val store = com.specwithcode.android.app.secure.KeystoreDpopKeyStore(backend)
        // A transient failure is thrown, never answered with a new key.
        kotlin.test.assertFailsWith<java.security.KeyStoreException> { store.loadOrCreate() }
        assertEquals(0, generated)
        val key = store.loadOrCreate()
        assertEquals(com.specwithcode.transport.Ecdsa.fixed32((saved.public as java.security.interfaces.ECPublicKey).w.affineX).toList(), key.publicX.toList())
        assertEquals(0, generated)
        // Gone for real (after a reset): a new key.
        store.reset()
        store.loadOrCreate()
        assertEquals(1, generated)
    }
}
