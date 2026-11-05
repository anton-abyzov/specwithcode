package com.specwithcode.android

import android.content.Context
import androidx.datastore.preferences.preferencesDataStoreFile
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.specwithcode.android.app.secure.DataStoreSealedValueFile
import com.specwithcode.android.app.secure.KeystoreDpopKeyStore
import com.specwithcode.android.app.secure.KeystoreSecretBox
import com.specwithcode.android.app.secure.SecureValues
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.io.File
import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec

/**
 * The real Keystore and DataStore classes, on a device. Aliases and the DataStore file are
 * test-only, so the app's own keys and credentials are never touched.
 */
@RunWith(AndroidJUnit4::class)
class KeystoreStorageTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val boxAlias = "specwithcode_test_box"
    private val dpopAlias = "specwithcode_test_dpop"
    private val fileName = "credentials_instrumented_test"

    @After
    fun tearDown() {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        runCatching { store.deleteEntry(boxAlias) }
        runCatching { store.deleteEntry(dpopAlias) }
        context.preferencesDataStoreFile(fileName).delete()
    }

    @Test
    fun secretBoxSealsAndOpens() {
        val box = KeystoreSecretBox(boxAlias)
        val plain = "token-é-✓".toByteArray(Charsets.UTF_8)
        val sealed = box.seal(plain)
        // 12-byte IV, then the ciphertext and a 16-byte GCM tag.
        assertEquals(12 + plain.size + 16, sealed.size)
        assertArrayEquals(plain, box.open(sealed))
        // A fresh IV every time.
        assertFalse(sealed.contentEquals(box.seal(plain)))
        // A new instance finds the same key in the Keystore.
        assertArrayEquals(plain, KeystoreSecretBox(boxAlias).open(sealed))
        // A flipped bit fails the tag check.
        val tampered = sealed.copyOf().also { it[it.size - 1] = (it[it.size - 1].toInt() xor 1).toByte() }
        try {
            box.open(tampered)
            fail("Tampered data opened")
        } catch (_: Exception) {
            // Expected.
        }
    }

    @Test
    fun dpopKeySignsVerifiably() {
        val store = KeystoreDpopKeyStore(dpopAlias)
        val key = store.loadOrCreate()
        assertEquals(32, key.publicX.size)
        assertEquals(32, key.publicY.size)
        val message = "header.payload".toByteArray()
        val raw = key.sign(message)
        assertEquals(64, raw.size)
        val verifier = Signature.getInstance("SHA256withECDSA")
        verifier.initVerify(publicKey(key.publicX, key.publicY))
        verifier.update(message)
        assertTrue(verifier.verify(rawToDer(raw)))

        // The key survives a new store instance, and reset makes a different one.
        assertArrayEquals(key.publicX, KeystoreDpopKeyStore(dpopAlias).loadOrCreate().publicX)
        store.reset()
        assertNotEquals(BigInteger(1, key.publicX), BigInteger(1, KeystoreDpopKeyStore(dpopAlias).loadOrCreate().publicX))
    }

    @Test
    fun sealedValuesPersistInTheBackupExcludedFile() {
        // The default file is the one backup_rules.xml and data_extraction_rules.xml exclude.
        val defaultFile = context.preferencesDataStoreFile("credentials")
        assertEquals("datastore/credentials.preferences_pb", defaultFile.relativeTo(context.filesDir).path)

        val file = DataStoreSealedValueFile(context, fileName)
        val values = SecureValues(file, KeystoreSecretBox(boxAlias))
        values.put("session", "secret-session")
        assertEquals("secret-session", values.get("session"))
        val onDisk = context.preferencesDataStoreFile(fileName)
        assertEquals(File(context.filesDir, "datastore/$fileName.preferences_pb"), onDisk)
        assertTrue(onDisk.exists())
        // Only sealed text reaches the disk.
        assertFalse(String(onDisk.readBytes(), Charsets.ISO_8859_1).contains("secret-session"))
        // A second reader over the same file opens it with the Keystore key.
        assertEquals("secret-session", SecureValues(file, KeystoreSecretBox(boxAlias)).get("session"))
        values.put("session", null)
        assertNull(SecureValues(file, KeystoreSecretBox(boxAlias)).get("session"))
    }

    private fun publicKey(x: ByteArray, y: ByteArray): ECPublicKey {
        val params = (KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }
            .generateKeyPair().public as ECPublicKey).params
        val spec = ECPublicKeySpec(ECPoint(BigInteger(1, x), BigInteger(1, y)), params)
        return KeyFactory.getInstance("EC").generatePublic(spec) as ECPublicKey
    }

    /** Raw `r || s` to the DER form JCA verifies. */
    private fun rawToDer(raw: ByteArray): ByteArray {
        fun integer(bytes: ByteArray): ByteArray {
            val value = BigInteger(1, bytes).toByteArray()
            return byteArrayOf(0x02, value.size.toByte()) + value
        }
        val body = ByteArrayOutputStream().apply {
            write(integer(raw.copyOfRange(0, 32)))
            write(integer(raw.copyOfRange(32, 64)))
        }.toByteArray()
        return byteArrayOf(0x30, body.size.toByte()) + body
    }
}
