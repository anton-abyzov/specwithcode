package com.specwithcode.sync

import com.specwithcode.transport.ConnectAuthorizer
import com.specwithcode.transport.ConnectError
import com.specwithcode.transport.CredentialStore
import com.specwithcode.transport.MachineConnection
import com.specwithcode.transport.MachineHttp
import com.specwithcode.transport.MachinePairing
import com.specwithcode.transport.MachineRecord
import com.specwithcode.transport.MachineRegistry
import com.specwithcode.transport.OkHttpWebSocketConnector
import com.specwithcode.transport.RpcSocket
import com.specwithcode.transport.TransportException
import com.specwithcode.transport.WebSocketConnector
import com.specwithcode.transport.call
import com.specwithcode.wire.EmptyInput
import com.specwithcode.wire.EnvironmentPlatform
import com.specwithcode.wire.ModelSelection
import com.specwithcode.wire.Nullable
import com.specwithcode.wire.ProjectShell
import com.specwithcode.wire.RpcMethod
import com.specwithcode.wire.RuntimeMode
import com.specwithcode.wire.ServerConfig
import com.specwithcode.wire.ServerError
import com.specwithcode.wire.ServerSettings
import com.specwithcode.wire.ServerSettingsPatch
import com.specwithcode.wire.ShellSnapshot
import com.specwithcode.wire.SubscribeShellInput
import com.specwithcode.wire.SubscribeShellInputSerializer
import com.specwithcode.wire.ThreadShell
import com.specwithcode.wire.UpdateServerSettingsInput
import com.specwithcode.wire.WireJson
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.time.Instant
import java.util.UUID
import java.util.logging.Level
import kotlin.coroutines.cancellation.CancellationException

/**
 * Talks to real machines: one [MachineConnection] per paired machine, the shell stream per
 * machine, and a live thread stream per open conversation. Port of the iOS `LiveEngine`.
 *
 * Engine state is touched only on [engineDispatcher], a single lane, so it needs no locks.
 * [AppModel] and [ChatSession] are state flows and can be written from it.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class LiveEngine(
    internal val registry: MachineRegistry,
    internal val credentials: CredentialStore,
    /** How this phone names itself to a machine, e.g. "Pixel 9". */
    internal val clientLabel: String,
    internal val http: MachineHttp = MachineHttp(),
    private val connector: WebSocketConnector = OkHttpWebSocketConnector(),
    private val configuration: MachineConnection.Configuration = MachineConnection.Configuration(),
    /** SpecWithCode Connect; null when the build has no Connect configuration. */
    val connect: ConnectRuntime? = null,
    internal val engineDispatcher: kotlinx.coroutines.CoroutineDispatcher = Dispatchers.Default.limitedParallelism(1),
) : AppEngine {
    internal val scope = CoroutineScope(SupervisorJob() + engineDispatcher)
    internal lateinit var model: AppModel
    internal val machines = LinkedHashMap<String, MachineEntry>()
    internal val sessions = SessionHub(this)
    internal var isActive = false
    private var started = false
    private var lastConnectRefresh = 0L

    /** Thread rows of machines whose shell did not change since the last [publish]. */
    private val summaryCache = ShellSummaries.Cache()

    /** One paired machine. */
    internal inner class MachineEntry(var record: MachineRecord) {
        val connection = MachineConnection(
            record, credentials, http, connector, configuration, connect?.authorizer,
            CoroutineScope(SupervisorJob() + Dispatchers.Default),
        )
        val shell = ShellSync()
        var snapshot: ShellSnapshot? = null
        var config: ServerConfig? = null
        var status: MachineConnection.Status = connection.status.value

        /** Answered once (shell arrived) or failed once, for [AppState.isLoading]. */
        var answered = false
        var lastSeenAt: Instant? = null
        val jobs = mutableListOf<Job>()

        val environmentId: String get() = record.environmentId
        val label: String get() = config?.environment?.label?.ifEmpty { null } ?: record.label
        val online: Boolean get() = status.state == MachineConnection.State.CONNECTED
        val viaConnect: Boolean get() = record.routes.isEmpty() && record.connectRoute != null
        val settings: ServerSettings? get() = config?.settings

        fun project(id: String): ProjectShell? = snapshot?.projects?.firstOrNull { it.id == id }
        fun thread(id: String): ThreadShell? = snapshot?.threads?.firstOrNull { it.id == id }

        fun startWatching() {
            jobs += scope.launch {
                connection.status.collect { next ->
                    status = next
                    if (next.state == MachineConnection.State.CONNECTED) lastSeenAt = Instant.now()
                    if (next.state in FAILED_STATES || (next.lastError != null && next.state != MachineConnection.State.CONNECTED)) {
                        answered = true
                    }
                    // The relay said the Clerk session is gone: the account screen and this
                    // machine should ask to sign in, not to pair again.
                    if (isSignedOut(next.lastError)) connect?.refreshSignedIn()
                    publish()
                    sessions.machineChanged(environmentId)
                }
            }
            jobs += scope.launch {
                connection.socket.collectLatest { socket ->
                    if (socket != null) followShell(this@MachineEntry, socket)
                }
            }
        }

        fun close() {
            jobs.forEach { it.cancel() }
            jobs.clear()
            connection.close()
        }
    }

    // AppEngine

    override fun start(model: AppModel) {
        val first = !::model.isInitialized
        this.model = model
        // The app may build a new model around the same engine (after showing sample data).
        if (!first) {
            scope.launch { publish() }
            return
        }
        scope.launch {
            connect?.refreshSignedIn()
            val records = runCatching { registry.all() }.getOrElse {
                syncLog.log(Level.WARNING, "Could not read paired machines: ${it.message}")
                emptyList()
            }
            for (record in records) addMachine(record)
            started = true
            publish()
            if (connect != null) {
                lastConnectRefresh = System.currentTimeMillis()
                refreshConnect()
            }
        }
    }

    override fun setActive(active: Boolean) {
        scope.launch {
            isActive = active
            for (entry in machines.values) entry.connection.setActive(active && entry.record.enabled)
            // Coming back to the foreground also picks up machines added to the Connect account.
            val now = System.currentTimeMillis()
            if (active && started && connect?.isSignedIn() == true && now - lastConnectRefresh > CONNECT_REFRESH_MILLIS) {
                lastConnectRefresh = now
                refreshConnect()
            }
        }
    }

    /** The network path changed: skip the rest of every backoff. */
    override fun networkChanged() {
        scope.launch { machines.values.forEach { it.connection.networkChanged() } }
    }

    override suspend fun pair(link: String, expectedEnvironmentId: String?): MachineSummary = withContext(engineDispatcher) {
        val result = try {
            MachinePairing(http, credentials, registry).pair(link, clientLabel, expectedEnvironmentId)
        } catch (e: Exception) {
            throw SyncError.wrap(e)
        }
        val existing = machines[result.record.environmentId]
        if (existing != null) {
            existing.record = result.record
            existing.connection.update(result.record)
            existing.connection.reconnect()
            existing.connection.setActive(isActive && result.record.enabled)
        } else {
            addMachine(result.record)
        }
        publish()
        summary(machines.getValue(result.record.environmentId))
    }

    override fun removeMachine(id: String) {
        scope.launch {
            machines.remove(id)?.close()
            runCatching { registry.remove(id) }
            runCatching { credentials.remove(id) }
            sessions.machineRemoved(id)
            publish()
        }
    }

    override fun reconnect(machineId: String) {
        scope.launch { machines[machineId]?.connection?.reconnect() }
    }

    override fun wake(machineId: String) {
        scope.launch { machines[machineId]?.connection?.networkChanged() }
    }

    override suspend fun setConnectionEnabled(enabled: Boolean, machineId: String) = withContext(engineDispatcher) {
        val entry = machines[machineId] ?: throw SyncError.UnknownMachine
        registry.setEnabled(enabled, machineId)
        entry.record = entry.record.copy(enabled = enabled)
        entry.connection.update(entry.record)
        entry.connection.setActive(isActive && enabled)
        publish()
    }

    override fun open(session: ChatSession) = sessions.open(session)

    override fun close(session: ChatSession) = sessions.close(session)

    override suspend fun send(text: String, images: List<OutgoingImage>, target: ChatTarget) = sessions.send(text, images, target)

    override suspend fun stop(target: ChatTarget) = sessions.stop(target)

    override suspend fun respond(requestId: String, target: ChatTarget, decision: ApprovalDecision) =
        sessions.respond(requestId, target, decision)

    override suspend fun answerAccess(request: AccessRequestRow, target: ChatTarget, answer: AccessAnswer) =
        sessions.answerAccess(request, target, answer)

    override suspend fun perform(action: ThreadAction, thread: ThreadRef) = sessions.perform(action, thread)

    override suspend fun startThread(request: NewThreadRequest): ThreadRef = sessions.startThread(request)

    override suspend fun setupAide(): ProjectRef =
        throw SyncError.SendBlocked("Set up Aide in SpecWithCode on your computer.")

    override suspend fun loadProjectSettings(project: ProjectRef): ProjectSettingsDraft =
        throw SyncError.SendBlocked("Project settings can be changed on your computer for now.")

    override suspend fun saveProjectSettings(draft: ProjectSettingsDraft, project: ProjectRef) =
        throw SyncError.SendBlocked("Project settings can be changed on your computer for now.")

    override suspend fun loadMachineSettings(machineId: String): MachineSettings = withContext(engineDispatcher) {
        val entry = machines[machineId] ?: throw SyncError.UnknownMachine
        val settings = entry.settings ?: throw SyncError.MachineOffline(entry.label)
        MachineSettings(
            defaultRuntimeMode = settings.defaultRuntimeMode?.let { RuntimeModeChoice.fromRaw(it.rawValue) },
            defaultModel = settings.defaultModelSelection?.model,
        )
    }

    override suspend fun saveMachineSettings(settings: MachineSettings, machineId: String) {
        val entry = withContext(engineDispatcher) { machines[machineId] } ?: throw SyncError.UnknownMachine
        val current = withContext(engineDispatcher) { entry.settings }
        val model = settings.defaultModel?.let { slug ->
            val instance = current?.defaultModelSelection?.instanceId?.takeIf { current.defaultModelSelection?.model == slug }
                ?: entry.config?.providers?.firstOrNull { p -> p.models.any { it.slug == slug } }?.instanceId
                ?: throw SyncError.SendBlocked("That model is not available on ${entry.label}.")
            ModelSelection(instance, slug)
        }
        val patch = ServerSettingsPatch(
            defaultRuntimeMode = settings.defaultRuntimeMode?.let { RuntimeMode(it.rawValue) },
            defaultModelSelection = if (settings.defaultModel == null) null else Nullable.of(model),
        )
        if (patch.isEmpty) return
        val updated = sessions.withRetry(machineId) { socket ->
            socket.call(RpcMethod.ServerUpdateSettings, UpdateServerSettingsInput(patch), UpdateServerSettingsInput.serializer(), ServerSettings.serializer())
        }
        withContext(engineDispatcher) {
            entry.config = entry.config?.copy(settings = updated)
            publish()
        }
    }

    // Machines

    /**
     * Adds a connection for a machine not yet held. A machine already held keeps its entry
     * (and its newer record): a second connection would leak its socket, scope and jobs.
     */
    internal fun addMachine(record: MachineRecord) {
        if (machines.containsKey(record.environmentId)) return
        val entry = MachineEntry(record)
        machines[record.environmentId] = entry
        entry.startWatching()
        entry.connection.setActive(isActive && record.enabled)
    }

    /** Config, then the shell: HTTP snapshot first, then `subscribeShell` from its sequence. Runs per socket. */
    private suspend fun followShell(entry: MachineEntry, socket: RpcSocket) {
        if (!loadConfig(entry, socket)) return
        var failures = 0
        var first = true
        while (true) {
            // Without the server's completion marker the stream never says `synchronized`.
            val marker = entry.config?.shellResumeCompletionMarker == true
            entry.shell.beginSubscription(awaitsMarker = marker)
            // A new socket (a reconnect) takes a fresh snapshot, so nothing missed while away is lost.
            if (first) seedShell(entry)
            first = false
            try {
                val input = WireJson.encodeToJsonElement(
                    SubscribeShellInputSerializer,
                    SubscribeShellInput(afterSequence = entry.shell.resumeSequence, requestCompletionMarker = marker.takeIf { it }),
                )
                socket.stream(RpcMethod.SubscribeShell.tag, input).collect { values ->
                    val update = entry.shell.apply(values) ?: return@collect
                    failures = 0
                    entry.snapshot = update.snapshot
                    if (update.isSynchronized) entry.answered = true
                    publish()
                    sessions.shellChanged(entry.environmentId)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                syncLog.log(Level.INFO, "Shell stream ended on ${entry.label}: ${e.message}")
                // A revoked pairing leaves the socket open: check the token before resubscribing.
                verifyAfterFailure(entry, e)
            }
            // A closed socket brings a new one through the socket flow, which cancels this loop.
            if (entry.connection.socket.value !== socket) return
            failures += 1
            delay(configuration.retry.delayMillis(failures - 1, configuration.random()))
            if (entry.connection.socket.value !== socket) return
        }
    }

    private suspend fun seedShell(entry: MachineEntry) {
        try {
            withTimeoutOrNull(5_000) { entry.connection.status.first { it.state == MachineConnection.State.CONNECTED } } ?: return
            val (route, auth) = entry.connection.currentAuth()
            val snapshot = http.shellSnapshot(auth, route.httpBase)
            entry.shell.seed(snapshot)?.let { update ->
                entry.snapshot = update.snapshot
                entry.answered = true
                publish()
                sessions.shellChanged(entry.environmentId)
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // The stream sends its own snapshot when there is no sequence to resume from.
            syncLog.log(Level.INFO, "Shell snapshot failed on ${entry.label}: ${e.message}")
        }
    }

    /** Loads the machine's config. False when the socket belongs to another environment. */
    private suspend fun loadConfig(entry: MachineEntry, socket: RpcSocket): Boolean {
        val config = try {
            socket.call(RpcMethod.ServerGetConfig, EmptyInput(), EmptyInput.serializer(), ServerConfig.serializer())
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            syncLog.log(Level.INFO, "Config failed on ${entry.label}: ${e.message}")
            return true
        }
        // The socket must belong to the paired machine (PROTOCOL.md step 7): a reused hostname
        // could answer as another one after the descriptor probe.
        val actual = config.environment.environmentId
        if (actual != entry.environmentId) {
            syncLog.log(Level.WARNING, "Config on ${entry.label} named another environment; dropping the socket")
            entry.connection.reject(socket, TransportException.EnvironmentMismatch(entry.environmentId, actual))
            return false
        }
        entry.config = config
        // Learn the machine's other addresses, bound to the issuer of the token in use.
        val route = entry.connection.routeOf(socket)
        if (route != null && route.issuer != ConnectAuthorizer.ISSUER && config.directEndpoints.isNotEmpty()) {
            runCatching {
                registry.mergeLearnedRoutes(config.directEndpoints.map { it.httpBaseUrl }, route.issuer, entry.environmentId)
            }.getOrNull()?.let {
                entry.record = it
                entry.connection.update(it)
            }
        }
        if (config.environment.label.isNotEmpty() && config.environment.label != entry.record.label) {
            runCatching { registry.update(entry.environmentId) { it.copy(label = config.environment.label) } }.getOrNull()?.let { entry.record = it }
        }
        publish()
        return true
    }

    /**
     * After a stream or call failed on a live socket: checks the session when the failure was
     * an authorization error, and on direct routes after any failure, so a revoke moves the
     * machine to "Pair again" instead of resubscribing forever. A Connect route is checked only
     * on authorization errors, because checking it means reconnecting.
     */
    internal suspend fun verifyAfterFailure(entry: MachineEntry, error: Throwable) {
        val route = entry.connection.status.value.route ?: return
        if (!isAuthFailure(error) && route.issuer == ConnectAuthorizer.ISSUER) return
        try {
            entry.connection.verifySession()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            syncLog.log(Level.INFO, "Session check failed on ${entry.label}: ${e.message}")
        }
    }

    // Publishing

    internal fun summary(entry: MachineEntry): MachineSummary {
        val status = entry.status
        val overConnect = status.state == MachineConnection.State.CONNECTED && status.route?.issuer == ConnectAuthorizer.ISSUER
        val descriptor = status.descriptor ?: entry.config?.environment
        val signedOut = entry.viaConnect && connect?.isSignedIn() == false
        return MachineSummary(
            id = entry.environmentId,
            label = entry.label,
            status = when (status.state) {
                MachineConnection.State.OFFLINE -> MachineStatus.Offline
                MachineConnection.State.CONNECTING -> MachineStatus.Connecting
                MachineConnection.State.CONNECTED -> MachineStatus.Connected
                MachineConnection.State.RECONNECTING -> MachineStatus.Reconnecting
                MachineConnection.State.NEEDS_REPAIR -> MachineStatus.NeedsRepair
                MachineConnection.State.UNSUPPORTED -> MachineStatus.Unsupported
            },
            platform = descriptor?.platform?.let(::platformLabel),
            serverVersion = descriptor?.serverVersion,
            address = (status.route ?: entry.record.rankedRoutes.firstOrNull())?.address,
            tokenDaysLeft = when {
                entry.viaConnect -> null
                // The live Connect token is not a pairing; show the direct pairing's own expiry, if any.
                overConnect -> entry.connection.tokenDaysLeft()
                else -> status.tokenDaysLeft
            },
            isStale = entry.online && !entry.shell.isSynchronized,
            viaConnect = entry.viaConnect,
            connectedViaConnect = overConnect,
            needsSignIn = signedOut,
            hasDirectPairing = entry.record.routes.isNotEmpty(),
            isDisconnected = !entry.record.enabled,
            isRefusingSignIns = (status.lastError as? TransportException.Http)?.status == 429,
            teamRulesRefusal = (status.lastError as? TransportException.TeamRules)?.message,
            reapprovalNotice = (status.lastError as? TransportException.NeedsRepair)?.takeIf { it.reapprovalRequired }?.message,
            lastErrorMessage = connectionErrorText(status.lastError, status.state, entry.viaConnect),
        )
    }

    /** Rebuilds [AppState] from every machine. */
    internal fun publish() {
        if (!::model.isInitialized) return
        val entries = machines.values.toList()
        val aideEnabled = entries.any { it.settings?.aideEnabled == true }
        val output = ShellSummaries.build(
            entries.map {
                ShellSummaries.Machine(
                    environmentId = it.environmentId,
                    label = it.label,
                    online = it.online,
                    snapshot = it.snapshot,
                    projectOrder = it.settings?.sidebarProjectOrder,
                    scratchWorkspaceRoot = it.config?.scratchWorkspaceRoot,
                    lastSeenAt = it.lastSeenAt,
                    providers = it.config?.providers ?: emptyList(),
                )
            },
            includeAide = aideEnabled,
            cache = summaryCache,
        )
        val enabled = entries.filter { it.record.enabled }
        val choices = entries.associate { it.environmentId to modelChoices(it.config) }.filterValues { it.isNotEmpty() }
        val summaries = entries.map(::summary)
        val loading = !started || enabled.any { !it.answered && it.snapshot == null }
        model.update {
            it.copy(
                machines = summaries,
                aide = output.aide,
                aideEnabled = aideEnabled,
                projects = output.projects,
                threadsByProject = output.threadsByProject,
                recentThreads = output.recentThreads,
                isLoading = loading,
                allShellsLoaded = enabled.all { entry -> entry.snapshot != null },
                modelChoices = choices,
            )
        }
    }

    internal fun newId(): String = UUID.randomUUID().toString()

    /** Stops everything. The engine cannot be started again. */
    fun shutdown() {
        machines.values.forEach { it.close() }
        machines.clear()
        scope.cancel()
    }

    companion object {
        private const val CONNECT_REFRESH_MILLIS = 5 * 60_000L
        private val FAILED_STATES = setOf(MachineConnection.State.NEEDS_REPAIR, MachineConnection.State.UNSUPPORTED)

        /** A failure that means the token or session is no longer accepted. */
        internal fun isAuthFailure(error: Throwable?): Boolean = when (error) {
            is ServerError -> error.kind is ServerError.Kind.Authorization ||
                (error.kind as? ServerError.Kind.Other)?.tag == "EnvironmentAuthInvalidError"
            is TransportException.NeedsRepair -> true
            is TransportException.Http -> error.status == 401
            is SyncError.Server -> isAuthFailure(error.error)
            else -> false
        }

        /** The relay refused because the Clerk session ended. */
        internal fun isSignedOut(error: Throwable?): Boolean =
            error is ConnectError.SignedOut || (error is TransportException.Connect && error.error is ConnectError.SignedOut)

        fun platformLabel(platform: EnvironmentPlatform): String {
            val os = when (platform.os) {
                "darwin" -> "macOS"
                "linux" -> "Linux"
                "windows" -> "Windows"
                else -> platform.os
            }
            return if (platform.arch.isEmpty() || platform.arch == "other") os else "$os · ${platform.arch}"
        }

        /** Ready providers' models, as the new thread screen offers them. */
        fun modelChoices(config: ServerConfig?): List<ModelChoice> {
            val providers = config?.providers ?: return emptyList()
            return providers.filter { it.enabled && it.installed && it.status == "ready" }.flatMap { provider ->
                val name = provider.displayName?.ifEmpty { null } ?: provider.driver
                provider.models.map { ModelChoice(provider.instanceId, it.slug, "${it.name} · $name") }
            }
        }
    }
}

/**
 * Why an offline machine could not connect, or null. Errors the card already shows on its own
 * (team rules, re-pairing) and stale errors from a retry that is still running are left out.
 */
internal fun connectionErrorText(error: TransportException?, state: MachineConnection.State, viaConnect: Boolean): String? {
    if (error == null || state != MachineConnection.State.OFFLINE) return null
    return when (error) {
        is TransportException.TeamRules, is TransportException.NeedsRepair -> null
        is TransportException.Unreachable ->
            if (viaConnect) "The computer could not be reached through SpecWithCode Connect. Check that it is awake and online." else error.message
        else -> error.message
    }
}
