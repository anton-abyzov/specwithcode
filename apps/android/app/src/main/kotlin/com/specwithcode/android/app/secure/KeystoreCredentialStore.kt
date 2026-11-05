package com.specwithcode.android.app.secure

import com.specwithcode.transport.CredentialStore
import com.specwithcode.transport.MachineCredential
import com.specwithcode.wire.WireJson

/**
 * Machine credentials, each sealed with a Keystore AES-GCM key ([KeystoreSecretBox]) and kept in
 * a DataStore file that is excluded from backup.
 */
class KeystoreCredentialStore(private val values: SecureValues) : CredentialStore {
    private fun key(environmentId: String, issuer: String) = "$PREFIX$environmentId\n$issuer"

    override fun credential(environmentId: String, issuer: String): MachineCredential? {
        val json = values.get(key(environmentId, issuer)) ?: return null
        return runCatching { WireJson.decodeFromString(MachineCredential.serializer(), json) }.getOrNull()
    }

    override fun save(credential: MachineCredential, environmentId: String, issuer: String) {
        values.put(key(environmentId, issuer), WireJson.encodeToString(MachineCredential.serializer(), credential))
    }

    override fun remove(environmentId: String) {
        val prefix = "$PREFIX$environmentId\n"
        values.keys().filter { it.startsWith(prefix) }.forEach { values.put(it, null) }
    }

    private companion object {
        const val PREFIX = "machine:"
    }
}
