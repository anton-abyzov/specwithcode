package com.specwithcode.transport

import java.time.Instant

/** Gets a machine session through SpecWithCode Connect for [MachineConnection]. */
fun interface ConnectAuthorizing {
    /**
     * A DPoP-bound session token for the machine and the key it is bound to. `refresh` skips
     * the cached token and asks the relay for a new credential.
     */
    suspend fun credential(environmentId: String, route: MachineRoute, refresh: Boolean): Pair<MachineCredential, DpopKey>
}

/**
 * Redeems relay credentials with the machine over its tunnel and keeps the resulting session
 * token in the [CredentialStore], so a launch reuses it and the machine sees one session per
 * device rather than one per launch.
 */
class ConnectAuthorizer(
    val relay: RelayClient,
    private val credentials: CredentialStore,
    private val http: MachineHttp = MachineHttp(),
    private val deviceId: String? = relay.deviceId,
    private val clientLabel: String,
    private val now: () -> Instant = Instant::now,
) : ConnectAuthorizing {
    companion object {
        /** The credential-store issuer of tokens bought through Connect. */
        const val ISSUER = "specwithcode-connect"

        /** A cached token is replaced this long before it expires. */
        const val RENEW_MARGIN_SECONDS = 120L

        /** The route [MachineConnection] dials for a relay endpoint. */
        fun route(endpoint: ConnectEndpoint): MachineRoute? {
            val http = endpoint.httpBaseUrl.trim().takeIf { it.isNotEmpty() } ?: return null
            val ws = endpoint.wsBaseUrl.trim().takeIf { it.isNotEmpty() } ?: return null
            if (PairingLink.schemePrefix(http) !in setOf("http", "https") || PairingLink.schemePrefix(ws) !in setOf("ws", "wss")) return null
            return MachineRoute(http, ws, kind = RouteKind.PUBLIC, learned = false, issuer = ISSUER)
        }
    }

    override suspend fun credential(environmentId: String, route: MachineRoute, refresh: Boolean): Pair<MachineCredential, DpopKey> {
        val key = try {
            relay.keys.loadOrCreate()
        } catch (e: Exception) {
            throw TransportException.Unreachable("Device key unavailable: ${e.javaClass.simpleName}")
        }
        if (!refresh) {
            val cached = runCatching { credentials.credential(environmentId, ISSUER) }.getOrNull()
            if (cached != null && cached.expiresAt.isAfter(now().plusSeconds(RENEW_MARGIN_SECONDS))) return cached to key
        }
        val bootstrap = try {
            relay.connect(environmentId, deviceId)
        } catch (e: ConnectError) {
            throw if (e.isOffline) TransportException.Unreachable("Offline") else TransportException.Connect(e)
        }
        val base = bootstrap.endpoint.httpBaseUrl.takeIf { it.isNotEmpty() } ?: route.httpBase
        val grant = try {
            http.redeemConnectCredential(bootstrap.credential, base, clientLabel, key)
        } catch (_: TransportException.PairingCodeRejected) {
            // The credential expired between the relay and the machine; the next attempt asks again.
            throw TransportException.Unreachable("Connect credential rejected")
        }
        val credential = MachineCredential(grant)
        runCatching { credentials.save(credential, environmentId, ISSUER) }
        return credential to key
    }

    /** Drops cached session tokens, e.g. after sign-out. */
    fun forget(environmentIds: List<String>) {
        for (id in environmentIds) {
            runCatching { credentials.save(MachineCredential("", Instant.EPOCH, emptyList()), id, ISSUER) }
        }
    }
}

/** What a successful pairing produced. */
data class PairingResult(
    val record: MachineRecord,
    val descriptor: com.specwithcode.wire.EnvironmentDescriptor,
    val credential: MachineCredential,
)

/** Pairs a machine: check it, spend the code, keep the token, remember the route. */
class MachinePairing(
    private val http: MachineHttp = MachineHttp(),
    private val credentials: CredentialStore,
    private val registry: MachineRegistry,
) {
    /** Pairs from a scanned or pasted link. */
    suspend fun pair(link: String, clientLabel: String, expectedEnvironmentId: String? = null): PairingResult =
        pair(PairingLink.parse(link), clientLabel, expectedEnvironmentId)

    /**
     * The descriptor is checked before the one-time code is spent, so a wrong machine or an
     * incompatible version leaves the code usable. The descriptor is unauthenticated, so the new
     * token is bound to the address that issued it and never reaches another route.
     */
    suspend fun pair(
        target: PairingTarget,
        clientLabel: String,
        expectedEnvironmentId: String? = null,
        resumeConnection: Boolean = true,
    ): PairingResult {
        val descriptor = http.descriptor(target.httpBase, expectedEnvironmentId)
        val grant = http.exchangePairingCode(target.code, target.httpBase, clientLabel)
        val credential = MachineCredential(grant)
        val route = target.route
        credentials.save(credential, descriptor.environmentId, route.address)
        var label = descriptor.label
        if (expectedEnvironmentId == null) {
            val existing = registry.machine(descriptor.environmentId)
            // A new address claiming a known machine does not rename it.
            if (existing != null && existing.routes.none { !it.learned && it.address == route.address }) label = existing.label
        }
        val record = registry.recordPairing(descriptor.environmentId, label, route, resumeConnection)
        return PairingResult(record, descriptor, credential)
    }
}
