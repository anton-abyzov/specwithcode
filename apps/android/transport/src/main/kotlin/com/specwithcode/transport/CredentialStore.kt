package com.specwithcode.transport

import com.specwithcode.wire.WireInstant
import kotlinx.serialization.Serializable
import java.time.Duration
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap

/** The token for one machine. The pairing code is never stored. */
@Serializable
data class MachineCredential(
    val token: String,
    val expiresAt: WireInstant,
    /** Permissions granted to the token, e.g. `orchestration:operate`. */
    val permissions: List<String> = emptyList(),
) {
    constructor(grant: TokenGrant) : this(grant.accessToken, grant.expiresAt, grant.scopes)

    fun isExpired(now: Instant = Instant.now()): Boolean = !expiresAt.isAfter(now)

    /** Whole days until expiry, never negative. */
    /** Whole days left, rounded up: 0 only once it has expired, so a token with hours left is not shown as expired. */
    fun daysLeft(now: Instant = Instant.now()): Int =
        maxOf(0L, Math.floorDiv(Duration.between(now, expiresAt).seconds + 86_399, 86_400L)).toInt()

    fun allows(permission: String): Boolean = permission in permissions

    /** Never prints the token. */
    override fun toString(): String = "MachineCredential(expiresAt=$expiresAt, permissions=$permissions)"
}

/**
 * Where machine tokens live. Every token is bound to the machine and to the route that issued
 * it (its `issuer`, a route address), as client-runtime keys `bearer:<environmentId>:<origin>`.
 * A token is only sent to its issuer and to routes a socket it authenticated reported.
 *
 * The Android app backs this with an Android Keystore key; tests use [InMemoryCredentialStore].
 */
interface CredentialStore {
    /** The token `issuer` issued for the machine. */
    fun credential(environmentId: String, issuer: String): MachineCredential?

    fun save(credential: MachineCredential, environmentId: String, issuer: String)

    /** Removes every token of the machine. */
    fun remove(environmentId: String)

    /** The token a route uses: the one its issuer issued. */
    fun credential(route: MachineRoute, environmentId: String): MachineCredential? = credential(environmentId, route.issuer)

    /**
     * The token of the best-ranked route holding an unexpired one, else of the best-ranked
     * route holding any. For permissions and days left.
     */
    fun bestCredential(record: MachineRecord, now: Instant = Instant.now()): MachineCredential? {
        var fallback: MachineCredential? = null
        val seen = mutableSetOf<String>()
        for (route in record.rankedRoutes) {
            if (!seen.add(route.issuer)) continue
            val credential = runCatching { credential(record.environmentId, route.issuer) }.getOrNull() ?: continue
            if (!credential.isExpired(now)) return credential
            if (fallback == null) fallback = credential
        }
        return fallback
    }
}

/** A token's key in a store: the machine and the route that issued it. */
data class CredentialKey(val environmentId: String, val issuer: String)

/** For tests, previews and fixtures. */
class InMemoryCredentialStore(items: Map<CredentialKey, MachineCredential> = emptyMap()) : CredentialStore {
    private val items = ConcurrentHashMap(items)

    override fun credential(environmentId: String, issuer: String): MachineCredential? = items[CredentialKey(environmentId, issuer)]

    override fun save(credential: MachineCredential, environmentId: String, issuer: String) {
        items[CredentialKey(environmentId, issuer)] = credential
    }

    override fun remove(environmentId: String) {
        items.keys.removeIf { it.environmentId == environmentId }
    }

    val keys: Set<CredentialKey> get() = items.keys.toSet()
}
