package com.specwithcode.sync

import com.specwithcode.transport.ConnectAuthorizer
import com.specwithcode.transport.ConnectConfig
import com.specwithcode.transport.ConnectError
import com.specwithcode.transport.CredentialStore
import com.specwithcode.transport.DpopKeyStore
import com.specwithcode.transport.HttpTransport
import com.specwithcode.transport.MachineHttp
import com.specwithcode.transport.OkHttpTransport
import com.specwithcode.transport.RelayClient
import com.specwithcode.transport.TransportException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import java.util.logging.Level
import kotlin.coroutines.cancellation.CancellationException

/**
 * The signed-in SpecWithCode Connect account. The app implements it with the hosted sign-in;
 * tests use a fake. [sessionToken] returns the short-lived relay JWT (template `studio-relay`).
 */
interface ConnectAccount {
    /** Whether a session is held. Read without network. */
    fun isSignedIn(): Boolean

    /** The signed-in person's email or name, when known. */
    fun accountLabel(): String? = null

    /** Opens the hosted sign-in. Throws when it fails or is cancelled. */
    suspend fun signIn()

    suspend fun signOut()

    /** A relay JWT for the current session; null when signed out. */
    suspend fun sessionToken(refresh: Boolean): String?
}

/** The pieces the engine needs to reach machines through the relay. */
class ConnectRuntime(
    val config: ConnectConfig,
    val account: ConnectAccount,
    keys: DpopKeyStore,
    credentials: CredentialStore,
    http: MachineHttp,
    /** Stable per install, so the relay can tell this phone apart and refuse it once removed. */
    deviceId: String,
    clientLabel: String,
    transport: HttpTransport = OkHttpTransport(),
) {
    val relay = RelayClient(config, { account.sessionToken(it) }, keys, transport, deviceId = deviceId)
    val authorizer = ConnectAuthorizer(relay, credentials, http, deviceId, clientLabel)

    // Reading the account touches encrypted storage, so it is not done here, where the engine
    // may be built on the main thread. LiveEngine.start reads it first, on the engine lane.
    private val signedIn = MutableStateFlow(false)

    /** Whether Connect is signed in, for the account screen. */
    val isSignedInFlow: StateFlow<Boolean> = signedIn.asStateFlow()

    fun isSignedIn(): Boolean = signedIn.value

    internal fun refreshSignedIn() {
        signedIn.value = account.isSignedIn()
    }
}

/** Signs in to Connect, then lists the account's machines and connects to them. */
suspend fun LiveEngine.connectSignIn() {
    val runtime = connect ?: throw SyncError.SendBlocked("SpecWithCode Connect is not set up in this build.")
    runtime.account.signIn()
    // Reading the account touches encrypted storage: never on the caller's (main) thread.
    withContext(Dispatchers.IO) {
        runtime.refreshSignedIn()
        runtime.relay.reset()
        refreshConnect(throwing = true)
    }
}

/**
 * Signs out of Connect and drops every Connect route and the session tokens bought through it.
 * Machines reached only through Connect stay listed and wait for a new sign-in; machines also
 * paired directly reconnect over their direct routes. Storage and Keystore work runs on
 * [Dispatchers.IO], so the screen calling it never blocks.
 */
suspend fun LiveEngine.connectSignOut() {
    val runtime = connect ?: return
    val (connectOnly, alsoDirect) = withContext(engineDispatcher) {
        val withConnect = machines.values.filter { it.record.connectRoute != null }
        withConnect.filter { it.viaConnect }.map { it.environmentId } to withConnect.filter { !it.viaConnect }.map { it.environmentId }
    }
    val directRecords = withContext(Dispatchers.IO) {
        runCatching { runtime.account.signOut() }
        runtime.refreshSignedIn()
        runtime.authorizer.forget(connectOnly + alsoDirect)
        runtime.relay.reset()
        runtime.relay.keys.reset()
        // The next sign-in records the Connect route again (refreshConnect).
        alsoDirect.associateWith { id -> runCatching { registry.update(id) { it.copy(connectRoute = null) } }.getOrNull() }
    }
    withContext(engineDispatcher) {
        for (id in connectOnly) machines[id]?.connection?.setActive(false)
        for ((id, saved) in directRecords) {
            val entry = machines[id] ?: continue
            entry.record = saved ?: entry.record.copy(connectRoute = null)
            entry.connection.update(entry.record)
            // Drops the Connect socket; the next attempt uses the direct routes only.
            entry.connection.reconnect()
        }
        publish()
    }
}

/**
 * Lists the account's machines and adopts each one: the registry keeps its Connect route, and a
 * new machine gets a connection. Signed out, it does nothing.
 */
suspend fun LiveEngine.refreshConnect(throwing: Boolean = false) {
    val runtime = connect ?: return
    runtime.refreshSignedIn()
    if (!runtime.isSignedIn()) {
        withContext(engineDispatcher) { publish() }
        return
    }
    val environments = try {
        runtime.relay.environments()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        syncLog.log(Level.INFO, "Connect machine list failed: ${e.message}")
        if (e is ConnectError.SignedOut || (e is TransportException.Connect && e.error is ConnectError.SignedOut)) runtime.refreshSignedIn()
        if (throwing) throw SyncError.wrap(e)
        return
    }
    for (environment in environments) {
        val route = ConnectAuthorizer.route(environment.endpoint) ?: continue
        val record = runCatching { registry.recordConnect(environment.environmentId, environment.label, route) }.getOrNull() ?: continue
        withContext(engineDispatcher) {
            val existing = machines[record.environmentId]
            if (existing == null) {
                addMachine(record)
            } else {
                existing.record = record
                existing.connection.update(record)
                existing.connection.setActive(isActive && record.enabled)
            }
        }
    }
    withContext(engineDispatcher) { publish() }
}
