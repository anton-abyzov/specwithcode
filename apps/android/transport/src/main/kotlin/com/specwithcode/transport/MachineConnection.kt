package com.specwithcode.transport

import com.specwithcode.wire.EnvironmentDescriptor
import com.specwithcode.wire.OrchestrationProtocol
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.time.Duration
import java.time.Instant
import kotlin.coroutines.cancellation.CancellationException
import kotlin.math.roundToLong
import kotlin.random.Random

/**
 * The reconnect ladder of `packages/client-runtime/src/connection/supervisor.ts`: the ceiling
 * doubles from 2 s up to [maxDelayMillis], and the delay is a random point in its upper half.
 */
data class RetryPolicy(
    val baseDelayMillis: Long = 1_000,
    val maxDelayMillis: Long = 300_000,
    /** A connection that lasts at least this long resets the ladder when it drops. */
    val resetAfterMillis: Long = 30_000,
) {
    /**
     * Delay before the next attempt after [failureCount] earlier failed retries (0 for the
     * first retry). [random] is in `[0, 1)`. [retryAfterMillis] is a floor the server asked for.
     */
    fun delayMillis(failureCount: Int, random: Double, retryAfterMillis: Long = 0): Long {
        val exponent = (failureCount + 1).coerceIn(0, 30)
        val ceiling = minOf(maxDelayMillis.toDouble(), baseDelayMillis * Math.pow(2.0, exponent.toDouble()))
        val delay = (ceiling / 2 + ceiling / 2 * random.coerceIn(0.0, 1.0)).roundToLong()
        return maxOf(delay, retryAfterMillis)
    }
}

/**
 * Keeps one machine connected: picks a route, gets a ticket, opens the socket, and reconnects
 * with backoff when it drops. A rejected token stops it ([State.NEEDS_REPAIR]) until
 * [reconnect]; an incompatible protocol stops it ([State.UNSUPPORTED]).
 */
class MachineConnection(
    record: MachineRecord,
    private val credentials: CredentialStore,
    private val http: MachineHttp = MachineHttp(),
    private val connector: WebSocketConnector = OkHttpWebSocketConnector(),
    private val configuration: Configuration = Configuration(),
    private val authorizer: ConnectAuthorizing? = null,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
) {
    enum class State { OFFLINE, CONNECTING, CONNECTED, RECONNECTING, NEEDS_REPAIR, UNSUPPORTED }

    data class Status(
        val state: State,
        /** The route in use, or the one last used. */
        val route: MachineRoute? = null,
        val descriptor: EnvironmentDescriptor? = null,
        /** Why the last attempt failed. For [State.UNSUPPORTED] it is AppTooOld or ServerTooOld. */
        val lastError: TransportException? = null,
        /** When the next attempt starts, while backing off. */
        val retryAt: Instant? = null,
        val tokenDaysLeft: Int? = null,
    )

    data class Configuration(
        /** Delay between starting probes of successive routes. */
        val probeStaggerMillis: Long = 300,
        val retry: RetryPolicy = RetryPolicy(),
        val socket: RpcSocket.Configuration = RpcSocket.Configuration(),
        /** A cached ticket is reused until this close to its expiry. */
        val ticketReuseMarginSeconds: Long = 30,
        /** Query parameters after `wsTicket` and `orchestrationProtocol`. */
        val clientParameters: List<Pair<String, String>> = DEFAULT_CLIENT_PARAMETERS,
        val sleep: suspend (Long) -> Unit = { delay(it) },
        val random: () -> Double = { Random.nextDouble() },
        val now: () -> Instant = Instant::now,
    )

    companion object {
        val DEFAULT_CLIENT_PARAMETERS: List<Pair<String, String>> = listOf(
            "clientSurface" to "mobile",
            "clientOs" to "Android",
            "clientDeviceType" to "phone",
            "connectionMethod" to "direct",
        )

        /**
         * `ws(s)://host[/prefix]/ws?wsTicket=…&orchestrationProtocol=2&…`. Connect endpoints already end in `/ws`,
         * so a trailing `/ws` is not doubled; any other path prefix is kept.
         */
        fun socketUrl(wsBase: String, ticket: String, parameters: List<Pair<String, String>> = DEFAULT_CLIENT_PARAMETERS): String {
            val origin = wsBase.substringBefore('?').substringBefore('#').trimEnd('/').removeSuffix("/ws")
            val query = listOf("wsTicket" to ticket, OrchestrationProtocol.QUERY_PARAMETER to OrchestrationProtocol.VERSION.toString()) + parameters
            return "$origin/ws?${FormQuery.encode(query)}"
        }

        /** The client parameters with `connectionMethod=relay`. */
        fun relayParameters(parameters: List<Pair<String, String>>): List<Pair<String, String>> =
            parameters.filter { it.first != "connectionMethod" } + ("connectionMethod" to "relay")

        internal fun transportError(error: Throwable): TransportException = when (val mapped = TransportException.from(error)) {
            is TransportException -> mapped
            else -> TransportException.Unreachable(mapped.javaClass.simpleName)
        }
    }

    private data class Established(
        val socket: RpcSocket,
        val route: MachineRoute,
        val descriptor: EnvironmentDescriptor,
        val credential: MachineCredential,
    )

    val environmentId: String = record.environmentId

    private val lock = Any()

    @Volatile
    var record: MachineRecord = record
        private set

    private val _status = MutableStateFlow(Status(State.OFFLINE))

    /** Every status change. */
    val status: StateFlow<Status> = _status.asStateFlow()

    private val _socket = MutableStateFlow<RpcSocket?>(null)

    /** The live socket, while connected. Subscribe (or resubscribe) on every new value. */
    val socket: StateFlow<RpcSocket?> = _socket.asStateFlow()

    private var active = false
    private var generation = 0
    private var loop: Job? = null
    private var failures = 0
    private var everConnected = false
    private var backingOff = false

    /** Set by [reject]: why the open socket was dropped, reported on the next backoff. */
    private var rejectedWith: TransportException? = null

    /** The last ticket and the issuer of the token that bought it. */
    private var cachedTicket: Pair<String, WebSocketTicket>? = null

    // Control

    /** Foreground (true) connects now; background (false) closes the socket. */
    fun setActive(value: Boolean) = synchronized(lock) {
        if (value) {
            val wasActive = active
            active = true
            // Leave a live socket or an attempt in flight alone; cut a backoff short.
            if (wasActive && (_socket.value != null || (loop != null && !backingOff))) return
            failures = 0
            restartLocked()
        } else {
            if (!active) return
            active = false
            stopLocked()
            setStatus(_status.value.copy(state = State.OFFLINE, lastError = null, retryAt = null))
        }
    }

    /** Tries again now, also after "Pair again" or "Update needed". Closes a live socket first. */
    fun reconnect() = synchronized(lock) {
        failures = 0
        cachedTicket = null
        if (active) restartLocked()
    }

    /** The network path changed: skip the rest of the backoff. */
    fun networkChanged() = synchronized(lock) {
        val state = _status.value.state
        if (!active || _socket.value != null || !(backingOff || loop == null) || state == State.NEEDS_REPAIR || state == State.UNSUPPORTED) return
        failures = 0
        restartLocked()
    }

    /** New routes or the enabled flag from the registry. Takes effect on the next attempt. */
    fun update(next: MachineRecord) = synchronized(lock) {
        val wasEnabled = record.enabled
        record = next
        if (!next.enabled) {
            stopLocked()
            setStatus(_status.value.copy(state = State.OFFLINE, retryAt = null))
        } else if (!wasEnabled && active) {
            failures = 0
            restartLocked()
        }
    }

    /** Stops for good and releases the scope. */
    fun close() {
        synchronized(lock) {
            active = false
            stopLocked()
        }
        scope.cancel()
    }

    /** Days until the token of the route in use (else of the best route holding one) expires. */
    fun tokenDaysLeft(): Int? {
        val routes = listOfNotNull(_status.value.route) + record.rankedRoutes
        return routes.firstNotNullOfOrNull { runCatching { credentials.credential(it, environmentId) }.getOrNull() }
            ?.daysLeft(configuration.now())
    }

    /** The route a socket was opened on, while it is the live socket. */
    /**
     * Drops [socket] because its session proved wrong after it opened, e.g. its config named
     * another environment. The connection backs off and reports [error] instead of a plain close.
     */
    fun reject(socket: RpcSocket, error: TransportException) {
        synchronized(lock) {
            if (_socket.value !== socket) return
            rejectedWith = error
        }
        socket.close()
    }

    fun routeOf(socket: RpcSocket): MachineRoute? = if (_socket.value === socket) _status.value.route else null

    /** How requests on the route in use are authorized. */
    suspend fun currentAuth(): Pair<MachineRoute, MachineAuth> {
        val status = _status.value
        val route = status.route
        if (status.state != State.CONNECTED || route == null) throw TransportException.Unreachable("Offline")
        return route to auth(route, refresh = false)
    }

    /**
     * Checks the token after an authorization error on a live socket. A revoked session leaves
     * sockets open, so this is how a revoke is noticed.
     */
    suspend fun verifySession() {
        val route = _status.value.route ?: return
        if (route.issuer == ConnectAuthorizer.ISSUER) {
            // A Connect token is DPoP-bound; reconnecting asks the relay again if it was revoked.
            reconnect()
            return
        }
        val credential = runCatching { credentials.credential(route, environmentId) }.getOrNull() ?: return
        val gen = synchronized(lock) { generation }
        val auth = MachineAuth.Bearer(credential.token)
        try {
            val session = http.session(auth, route.httpBase)
            if (session.authenticated) return
        } catch (_: TransportException.NeedsRepair) {
            // Rejected: decide below.
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            return
        }
        val rejection = sessionRejection(auth, route)
        synchronized(lock) {
            if (gen != generation) return
            if (rejection is TransportException.TeamRules) {
                // Not a dead pairing: the next attempt reports the refusal and keeps trying.
                _socket.value?.close()
                return
            }
            haltLocked(State.NEEDS_REPAIR, rejection as? TransportException.NeedsRepair ?: TransportException.NeedsRepair())
        }
    }

    /**
     * A fresh ticket for the device hub, bought on the route in use with that route's own
     * credential. Returns the route's origin with it.
     */
    suspend fun deviceHubTicket(): Pair<String, String> {
        val (route, auth) = currentAuth()
        return route.httpBase to http.websocketTicket(auth, route.httpBase).ticket
    }

    /** Posts bytes to a signed URL this machine issued, on the route in use. */
    suspend fun uploadSigned(body: ByteArray, contentType: String, relativeUrl: String) {
        val route = _status.value.route
        if (_status.value.state != State.CONNECTED || route == null) throw TransportException.Unreachable("Offline")
        http.uploadSigned(body, contentType, relativeUrl, route.httpBase)
    }

    // Supervisor

    private fun restartLocked() {
        stopLocked()
        if (!active || !record.enabled) return
        val gen = generation
        loop = scope.launch { run(gen) }
    }

    private fun stopLocked() {
        generation++
        loop?.cancel()
        loop = null
        backingOff = false
        _socket.value?.let {
            _socket.value = null
            it.close()
        }
    }

    private fun haltLocked(state: State, error: TransportException) {
        stopLocked()
        val descriptor = when (error) {
            is TransportException.AppTooOld -> error.descriptor
            is TransportException.ServerTooOld -> error.descriptor
            else -> _status.value.descriptor
        }
        setStatus(_status.value.copy(state = state, lastError = error, retryAt = null, descriptor = descriptor))
    }

    private fun setStatus(next: Status) {
        _status.value = next
    }

    private fun isCurrent(gen: Int) = synchronized(lock) { gen == generation }

    private fun check(gen: Int) {
        if (!isCurrent(gen)) throw CancellationException("Superseded")
    }

    private suspend fun run(gen: Int) {
        while (isCurrent(gen)) {
            synchronized(lock) {
                if (gen != generation) return
                setStatus(_status.value.copy(state = attemptState(), retryAt = null))
            }
            try {
                val established = establish(gen)
                val connectedAt = synchronized(lock) {
                    if (gen != generation) {
                        established.socket.close()
                        return
                    }
                    everConnected = true
                    _socket.value = established.socket
                    setStatus(
                        Status(
                            State.CONNECTED,
                            established.route,
                            established.descriptor,
                            tokenDaysLeft = established.credential.daysLeft(configuration.now()),
                        ),
                    )
                    configuration.now()
                }
                established.socket.awaitClose()
                var rejected: TransportException? = null
                val stable = synchronized(lock) {
                    if (gen != generation) return
                    _socket.value = null
                    rejected = rejectedWith
                    rejectedWith = null
                    val lasted = Duration.between(connectedAt, configuration.now()).toMillis()
                    if (rejected != null) {
                        failures++
                        false
                    } else if (lasted >= configuration.retry.resetAfterMillis) {
                        failures = 0
                        true
                    } else {
                        // Dropped right after connecting: keep counting so a flapping server backs off.
                        failures++
                        false
                    }
                }
                if (!stable) backOff(gen, rejected ?: TransportException.Closed())
            } catch (e: CancellationException) {
                if (!isCurrent(gen)) return
                throw e
            } catch (e: Throwable) {
                val failure = transportError(e)
                synchronized(lock) {
                    if (gen != generation) return
                    when {
                        failure is TransportException.NeedsRepair -> {
                            haltLocked(State.NEEDS_REPAIR, failure)
                            return
                        }
                        failure is TransportException.Connect && failure.error.isPermanent -> {
                            haltLocked(State.NEEDS_REPAIR, failure)
                            return
                        }
                        failure is TransportException.AppTooOld || failure is TransportException.ServerTooOld -> {
                            haltLocked(State.UNSUPPORTED, failure)
                            return
                        }
                        else -> failures++
                    }
                }
                try {
                    backOff(gen, failure)
                } catch (_: CancellationException) {
                    return
                }
            }
        }
    }

    private suspend fun backOff(gen: Int, error: TransportException) {
        val delay = synchronized(lock) {
            check(gen)
            val retryAfter = ((error as? TransportException.Http)?.retryAfterSeconds ?: 0L) * 1_000
            val delay = configuration.retry.delayMillis(maxOf(0, failures - 1), configuration.random(), retryAfter)
            setStatus(_status.value.copy(state = backoffState(), lastError = error, retryAt = configuration.now().plusMillis(delay)))
            backingOff = true
            delay
        }
        try {
            configuration.sleep(delay)
        } finally {
            synchronized(lock) { if (gen == generation) backingOff = false }
        }
        check(gen)
    }

    private fun attemptState(): State =
        if (failures == 0) (if (everConnected) State.RECONNECTING else State.CONNECTING) else backoffState()

    private fun backoffState(): State = if (everConnected && failures < 3) State.RECONNECTING else State.OFFLINE

    private suspend fun auth(route: MachineRoute, refresh: Boolean): MachineAuth {
        if (route.issuer == ConnectAuthorizer.ISSUER) {
            val authorizer = authorizer ?: throw TransportException.NeedsRepair()
            val (credential, key) = authorizer.credential(environmentId, route, refresh)
            return MachineAuth.Dpop(credential.token, key)
        }
        val credential = credentials.credential(route, environmentId) ?: throw TransportException.NeedsRepair()
        return MachineAuth.Bearer(credential.token)
    }

    /** SpecWithCode Connect first; independently paired direct routes remain a fallback. */
    private suspend fun establish(gen: Int): Established {
        val connectRoute = record.connectRoute
        val authorizer = authorizer
        if (authorizer == null || connectRoute == null) return establishDirect(gen)
        val connectError = try {
            return establishConnect(gen, connectRoute, authorizer)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            check(gen)
            if (e is TransportException.AppTooOld || e is TransportException.ServerTooOld) throw e
            e
        }
        if (record.routes.isEmpty()) throw connectError
        try {
            return establishDirect(gen)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            check(gen)
            if (e is TransportException.AppTooOld || e is TransportException.ServerTooOld) throw e
            throw connectError
        }
    }

    private suspend fun establishConnect(gen: Int, route: MachineRoute, authorizer: ConnectAuthorizing): Established {
        val descriptor = http.descriptor(route.httpBase, environmentId)
        check(gen)
        setStatus(_status.value.copy(route = route, descriptor = descriptor))
        // A cached token the machine no longer accepts gets one fresh credential.
        var refresh = false
        while (true) {
            val (credential, key) = authorizer.credential(environmentId, route, refresh)
            check(gen)
            val ticket = try {
                http.websocketTicket(MachineAuth.Dpop(credential.token, key), route.httpBase)
            } catch (e: TransportException) {
                val rejected = e is TransportException.NeedsRepair || (e is TransportException.Http && e.status == 401)
                if (rejected && !refresh) {
                    refresh = true
                    continue
                }
                throw e
            }
            check(gen)
            val url = socketUrl(route.wsBase, ticket.ticket, relayParameters(configuration.clientParameters))
            return Established(open(gen, url), route, descriptor, credential)
        }
    }

    private suspend fun establishDirect(gen: Int): Established {
        // Only routes holding an unexpired token from their own issuer are tried, and each gets only that token.
        val now = configuration.now()
        val candidates = try {
            record.rankedRoutes.mapNotNull { route ->
                credentials.credential(route, environmentId)?.takeIf { !it.isExpired(now) }?.let { route to it }
            }
        } catch (e: Exception) {
            // Storage can be unreadable for a moment, e.g. before the first unlock.
            throw TransportException.Unreachable("Credential unavailable: ${e.javaClass.simpleName}")
        }
        if (candidates.isEmpty()) throw TransportException.NeedsRepair()

        val (index, descriptor) = probe(candidates.map { it.first })
        val (route, credential) = candidates[index]
        check(gen)
        setStatus(_status.value.copy(route = route, descriptor = descriptor))

        val auth = MachineAuth.Bearer(credential.token)
        val ticket = ticket(auth, route)
        check(gen)
        val url = socketUrl(route.wsBase, ticket.ticket, configuration.clientParameters)
        val socket = try {
            open(gen, url)
        } catch (e: TransportException.UpgradeFailed) {
            synchronized(lock) { cachedTicket = null }
            check(gen)
            throw diagnoseUpgradeFailure(e, route, auth)
        }
        return Established(socket, route, descriptor, credential)
    }

    private suspend fun open(gen: Int, url: String): RpcSocket {
        val connection = connector.connect(url)
        if (!isCurrent(gen)) {
            connection.close()
            throw CancellationException("Superseded")
        }
        return RpcSocket(connection, configuration.socket).also { it.start() }
    }

    /**
     * Probes routes in rank order, starting one every probe stagger. The first descriptor with
     * the expected environment id wins; returns its index.
     */
    private suspend fun probe(routes: List<MachineRoute>): Pair<Int, EnvironmentDescriptor> = coroutineScope {
        val results = Channel<Pair<Int, Result<EnvironmentDescriptor>>>(Channel.UNLIMITED)
        val jobs = routes.mapIndexed { index, route ->
            launch {
                if (index > 0) delay(configuration.probeStaggerMillis * index)
                val result = try {
                    Result.success(http.descriptor(route.httpBase, environmentId))
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Throwable) {
                    Result.failure(e)
                }
                results.send(index to result)
            }
        }
        val errors = sortedMapOf<Int, Throwable>()
        repeat(routes.size) {
            val (index, result) = results.receive()
            result.onSuccess { descriptor ->
                jobs.forEach { it.cancel() }
                return@coroutineScope index to descriptor
            }
            val error = result.exceptionOrNull()!!
            if (error is TransportException.AppTooOld || error is TransportException.ServerTooOld) {
                jobs.forEach { it.cancel() }
                throw error
            }
            errors[index] = error
        }
        throw errors.values.firstOrNull() ?: TransportException.Unreachable("No route answered")
    }

    private suspend fun ticket(auth: MachineAuth, route: MachineRoute): WebSocketTicket {
        synchronized(lock) {
            val cached = cachedTicket
            val expiresAt = cached?.second?.expiresAt
            if (cached != null && cached.first == route.issuer && expiresAt != null &&
                expiresAt.isAfter(configuration.now().plusSeconds(configuration.ticketReuseMarginSeconds))
            ) {
                return cached.second
            }
        }
        val ticket = http.websocketTicket(auth, route.httpBase)
        synchronized(lock) { cachedTicket = route.issuer to ticket }
        return ticket
    }

    /** Why a token was rejected: the ticket endpoint tells a Team rules refusal from a revoke. */
    private suspend fun sessionRejection(auth: MachineAuth, route: MachineRoute): TransportException = try {
        http.websocketTicket(auth, route.httpBase)
        TransportException.NeedsRepair()
    } catch (e: TransportException.TeamRules) {
        e
    } catch (e: TransportException.NeedsRepair) {
        e
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        TransportException.NeedsRepair()
    }

    /** Tells a revoked token or a changed protocol from a transient refusal. */
    private suspend fun diagnoseUpgradeFailure(original: TransportException.UpgradeFailed, route: MachineRoute, auth: MachineAuth): TransportException {
        try {
            val session = http.session(auth, route.httpBase)
            if (!session.authenticated) return sessionRejection(auth, route)
        } catch (_: TransportException.NeedsRepair) {
            return sessionRejection(auth, route)
        } catch (e: TransportException.TeamRules) {
            return e
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            return original
        }
        return try {
            http.descriptor(route.httpBase, environmentId)
            original
        } catch (e: TransportException.AppTooOld) {
            e
        } catch (e: TransportException.ServerTooOld) {
            e
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            original
        }
    }
}
