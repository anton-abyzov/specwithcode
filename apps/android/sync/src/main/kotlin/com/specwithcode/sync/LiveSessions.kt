package com.specwithcode.sync

import com.specwithcode.transport.MachineConnection
import com.specwithcode.transport.RpcSocket
import com.specwithcode.transport.TransportException
import com.specwithcode.transport.call
import com.specwithcode.wire.AccessAnswerRequestInput
import com.specwithcode.wire.AccessRequestAnswer
import com.specwithcode.wire.AccessRequestScope
import com.specwithcode.wire.CoordinatorResult
import com.specwithcode.wire.CoordinatorSendInput
import com.specwithcode.wire.CoordinatorStartInput
import com.specwithcode.wire.DeliveryIntent
import com.specwithcode.wire.DispatchMode
import com.specwithcode.wire.InitialMessage
import com.specwithcode.wire.MessageDispatchCommand
import com.specwithcode.wire.ModelSelection
import com.specwithcode.wire.OrchestrationCommand
import com.specwithcode.wire.OrchestrationCommandSerializer
import com.specwithcode.wire.ProviderApprovalDecision
import com.specwithcode.wire.RpcMethod
import com.specwithcode.wire.RunInterruptCommand
import com.specwithcode.wire.RuntimeMode
import com.specwithcode.wire.RuntimeRequestRespondCommand
import com.specwithcode.wire.ServerError
import com.specwithcode.wire.SubscribeThreadInput
import com.specwithcode.wire.SubscribeThreadInputSerializer
import com.specwithcode.wire.ThreadLaunchInput
import com.specwithcode.wire.ThreadLaunchResult
import com.specwithcode.wire.ThreadProjection
import com.specwithcode.wire.ThreadShell
import com.specwithcode.wire.ThreadMetadataUpdateCommand
import com.specwithcode.wire.WireJson
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.time.Instant
import java.util.logging.Level
import kotlin.coroutines.cancellation.CancellationException

/** Open conversations: one live thread stream each, plus every command a chat sends. */
internal class SessionHub(private val engine: LiveEngine) {
    /** What [send] reads from engine state before it dispatches. */
    private data class Prepared(
        val controller: Controller?,
        val running: Boolean,
        val threadId: String?,
        val serverResolves: Boolean,
    )

    /** A message on its way, shown until the machine echoes it. */
    private class PendingMessage(
        val messageId: String,
        val text: String,
        /** For a coordinator send, which has no message id: the user messages already held at send time. */
        val knownAtSend: Set<String>?,
    )

    private inner class Controller(val session: ChatSession) {
        val target: ChatTarget = session.id
        val environmentId: String = target.environmentId
        var threadId: String? = (target as? ChatTarget.Thread)?.thread?.threadId
        val sync = ThreadSync()
        val restart = MutableStateFlow(0)
        var job: Job? = null
        val pending = mutableListOf<PendingMessage>()
        var loadError: String? = null

        /** The coordinator does not exist yet and opening the chat must not create it. */
        var waitingForFirstSend = false

        /** The `coordinatorStart` id, reused when the call is retried. */
        val startCommandId: String = engine.newId()

        /** The shell `updatedAt` last reported as seen. */
        var visited: Instant? = null

        /** The shell row last rendered, so a shell change elsewhere on the machine skips this chat. */
        var renderedShellThread: ThreadShell? = null
        var renderedShellKnown = false

        /** What [render] derived from the projection last time, reused while it is the same object. */
        var derived: Derived? = null
    }

    /** Projection-derived chat state; rebuilding it maps the whole transcript. */
    private class Derived(
        val projection: ThreadProjection,
        val environmentId: String,
        val mode: String,
        val rows: List<TranscriptRow>,
        val isRunning: Boolean,
        val queuedCount: Int,
        val promptSuggestion: String?,
        val plan: PlanProgress?,
    )

    private val controllers = HashMap<ChatTarget, Controller>()

    // Following

    fun open(session: ChatSession) {
        engine.scope.launch {
            if (controllers[session.id] != null) return@launch
            val controller = Controller(session)
            controllers[session.id] = controller
            controller.job = launch { follow(controller) }
        }
    }

    fun close(session: ChatSession) {
        engine.scope.launch {
            val controller = controllers[session.id] ?: return@launch
            if (controller.session !== session) return@launch
            controllers.remove(session.id)
            controller.job?.cancel()
        }
    }

    private suspend fun follow(controller: Controller) {
        val entry = engine.machines[controller.environmentId]
        if (entry == null) {
            controller.loadError = SyncError.UnknownMachine.message
            render(controller)
            return
        }
        render(controller)
        combine(entry.connection.socket, controller.restart) { socket, _ -> socket }.collectLatest { socket ->
            if (socket == null) {
                render(controller)
                return@collectLatest
            }
            val threadId = controller.threadId ?: resolveCoordinator(controller, entry, socket)
            if (threadId == null) {
                render(controller)
                return@collectLatest
            }
            controller.threadId = threadId
            followThread(controller, entry, socket, threadId)
        }
    }

    /** The coordinator thread of a project or Aide chat; null until it is known or a send creates it. */
    private suspend fun resolveCoordinator(controller: Controller, entry: LiveEngine.MachineEntry, socket: RpcSocket): String? {
        val ref = when (val target = controller.target) {
            is ChatTarget.Aide -> target.project
            is ChatTarget.Project -> target.project
            is ChatTarget.Thread -> return target.thread.threadId
        }
        // The shell names the coordinator; wait for it (shellChanged restarts this).
        val project = entry.project(ref.projectId)
        if (project == null) {
            if (entry.snapshot != null) controller.loadError = SyncError.ProjectNotFound.message
            return null
        }
        controller.loadError = null
        return when (val resolution = CoordinatorRouting.resolve(project)) {
            is CoordinatorRouting.Resolution.Known -> resolution.threadId
            is CoordinatorRouting.Resolution.NeedsStart -> {
                if (!controller.session.startsCoordinator) {
                    controller.waitingForFirstSend = true
                    return null
                }
                try {
                    socket.call(
                        RpcMethod.CoordinatorStart,
                        CoordinatorStartInput(ref.projectId, controller.startCommandId),
                        CoordinatorStartInput.serializer(),
                        CoordinatorResult.serializer(),
                    ).threadId
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    controller.loadError = SyncError.wrap(e).message
                    null
                }
            }
        }
    }

    /** HTTP snapshot, then `subscribeThread` from its sequence; resubscribes with backoff on the same socket. */
    private suspend fun followThread(controller: Controller, entry: LiveEngine.MachineEntry, socket: RpcSocket, threadId: String) {
        controller.waitingForFirstSend = false
        // Without the server's completion marker a resumed stream never says `synchronized`.
        val marker = entry.config?.threadResumeCompletionMarker == true
        controller.sync.begin(threadId, awaitsMarker = marker)
        render(controller)
        seedThread(controller, entry, threadId)
        var failures = 0
        while (true) {
            try {
                // No acceptBoundedSnapshot: the app has no history paging, so it asks for the full snapshot.
                val input = SubscribeThreadInput(
                    threadId,
                    afterSequence = controller.sync.resumeSequence,
                    requestCompletionMarker = marker.takeIf { it },
                )
                socket.stream(RpcMethod.SubscribeThread.tag, WireJson.encodeToJsonElement(SubscribeThreadInputSerializer, input)).collect { values ->
                    if (controller.sync.apply(values) != null) {
                        failures = 0
                        controller.loadError = null
                        render(controller)
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                syncLog.log(Level.INFO, "Thread stream ended for $threadId: ${e.message}")
                // A revoked pairing leaves the socket open: check the token before resubscribing.
                engine.verifyAfterFailure(entry, e)
                if (e is ServerError && !controller.sync.hasProjection) {
                    controller.loadError = e.message
                    render(controller)
                }
            }
            if (entry.connection.socket.value !== socket) return
            failures += 1
            delay(minOf(30_000L, 1_000L shl minOf(failures, 5)))
            if (entry.connection.socket.value !== socket) return
            controller.sync.begin(threadId, awaitsMarker = marker)
        }
    }

    private suspend fun seedThread(controller: Controller, entry: LiveEngine.MachineEntry, threadId: String) {
        try {
            withTimeoutOrNull(5_000) { entry.connection.status.first { it.state == MachineConnection.State.CONNECTED } } ?: return
            val (route, auth) = entry.connection.currentAuth()
            val snapshot = engine.http.threadSnapshot(auth, route.httpBase, threadId)
            if (snapshot != null) {
                controller.sync.seed(snapshot)
                controller.loadError = null
            } else if (!controller.sync.hasProjection) {
                controller.loadError = "This conversation is no longer on ${entry.label}."
            }
            render(controller)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // The stream sends its own snapshot.
            syncLog.log(Level.INFO, "Thread snapshot failed for $threadId: ${e.message}")
        }
    }

    fun shellChanged(environmentId: String) {
        val entry = engine.machines[environmentId]
        for (controller in controllers.values) {
            if (controller.environmentId != environmentId) continue
            if (controller.threadId == null && !controller.waitingForFirstSend) controller.restart.value += 1
            // A chat reads only its own thread's shell row; other threads' changes leave it as is.
            val threadId = controller.threadId
            if (threadId != null && controller.renderedShellKnown && entry?.thread(threadId) === controller.renderedShellThread) continue
            render(controller)
        }
    }

    fun machineChanged(environmentId: String) {
        controllers.values.filter { it.environmentId == environmentId }.forEach(::render)
    }

    fun machineRemoved(environmentId: String) {
        for (controller in controllers.values.filter { it.environmentId == environmentId }) {
            controller.job?.cancel()
            controller.loadError = SyncError.UnknownMachine.message
            render(controller)
        }
    }

    // Rendering

    private fun render(controller: Controller) {
        val entry = engine.machines[controller.environmentId]
        val projection = controller.sync.projection
        if (projection != null) reconcilePending(controller)
        val online = entry?.online == true
        val mode = entry?.settings?.promptSuggestions ?: "all"
        val derived = projection?.let { derive(controller, it, mode) }
        val rows = (derived?.rows ?: emptyList()) +
            controller.pending.map { TranscriptRow("pending:${it.messageId}", TranscriptRow.Kind.User(it.text, UserMessageState.Sending)) }
        val shellThread = controller.threadId?.let { entry?.thread(it) }
        controller.renderedShellThread = shellThread
        controller.renderedShellKnown = controller.threadId != null
        val loaded = projection != null || controller.waitingForFirstSend || controller.loadError != null
        controller.session.update { state ->
            state.copy(
                title = if (controller.target is ChatTarget.Thread) {
                    (projection?.thread?.title ?: shellThread?.title)?.trim()?.ifEmpty { null } ?: state.title
                } else {
                    state.title
                },
                rows = rows,
                isLoaded = state.isLoaded || loaded,
                isStale = !online || (projection != null && !controller.sync.isSynchronized),
                isRunning = derived?.isRunning ?: false,
                queuedCount = derived?.queuedCount ?: 0,
                promptSuggestion = derived?.promptSuggestion,
                plan = derived?.plan,
                machineLabel = entry?.let { MachineNickname.shortName(it.label) } ?: state.machineLabel,
                machineOnline = online,
                sendBlockedReason = blockedReason(controller.target),
                loadError = if (projection != null) null else controller.loadError,
            )
        }
        markVisited(controller, entry)
    }

    private fun derive(controller: Controller, projection: ThreadProjection, mode: String): Derived {
        controller.derived?.let {
            if (it.projection === projection && it.environmentId == controller.environmentId && it.mode == mode) return it
        }
        return Derived(
            projection = projection,
            environmentId = controller.environmentId,
            mode = mode,
            rows = TranscriptMapper.rows(projection, controller.environmentId),
            isRunning = TranscriptMapper.isRunning(projection),
            queuedCount = TranscriptMapper.queuedCount(projection),
            promptSuggestion = TranscriptMapper.promptSuggestion(projection, mode),
            plan = TranscriptMapper.planProgress(projection),
        ).also { controller.derived = it }
    }

    /** Tells the machine the open thread was seen, once per shell update. */
    private fun markVisited(controller: Controller, entry: LiveEngine.MachineEntry?) {
        val threadId = controller.threadId ?: return
        val thread = entry?.thread(threadId) ?: return
        if (!entry.online || !thread.isUnread || controller.visited == thread.updatedAt) return
        controller.visited = thread.updatedAt
        engine.scope.launch {
            runCatching { dispatch(OrchestrationCommand.visit(engine.newId(), threadId, thread.updatedAt), controller.environmentId) }
        }
    }

    private fun reconcilePending(controller: Controller) {
        val projection = controller.sync.projection ?: return
        if (controller.pending.isEmpty()) return
        val received = TranscriptMapper.receivedUserMessages(projection)
        val ids = received.map { it.messageId }.toSet()
        controller.pending.removeAll { pending ->
            val known = pending.knownAtSend
            if (known == null) {
                pending.messageId in ids
            } else {
                received.any { it.messageId !in known && it.text.trim() == pending.text }
            }
        }
    }

    /** Why the composer is off, when it is. */
    private fun blockedReason(target: ChatTarget): String? {
        val entry = engine.machines[target.environmentId] ?: return SyncError.UnknownMachine.message
        if (!entry.record.enabled) return "Turn on the connection to ${MachineNickname.shortName(entry.label)} to send messages."
        return when (entry.status.state) {
            MachineConnection.State.NEEDS_REPAIR -> "Pair ${MachineNickname.shortName(entry.label)} again to send messages."
            MachineConnection.State.UNSUPPORTED -> "Update SpecWithCode to send messages to ${MachineNickname.shortName(entry.label)}."
            else -> null
        }
    }

    // Commands

    suspend fun send(text: String, images: List<OutgoingImage>, target: ChatTarget) {
        val clean = text.trim()
        if (clean.isEmpty() && images.isEmpty()) throw SyncError.EmptyMessage
        if (images.isNotEmpty()) throw SyncError.SendBlocked("Pictures can't be sent from this phone yet.")
        val messageId = engine.newId()
        val commandId = engine.newId()
        val prepared = withContext(engine.engineDispatcher) {
            blockedReason(target)?.let { throw SyncError.SendBlocked(it) }
            val controller = controllers[target]
            val projection = controller?.sync?.projection
            val known = if (target is ChatTarget.Thread) null else {
                projection?.let { TranscriptMapper.receivedUserMessages(it).map { m -> m.messageId }.toSet() } ?: emptySet()
            }
            controller?.let {
                it.pending += PendingMessage(messageId, clean, known)
                it.session.update { state -> state.copy(lastError = null) }
                render(it)
            }
            val entry = engine.machines[target.environmentId]
            val descriptor = entry?.status?.descriptor ?: entry?.config?.environment
            Prepared(
                controller,
                projection?.activeRun != null,
                (target as? ChatTarget.Thread)?.thread?.threadId,
                descriptor?.capabilities?.serverResolvedCommandContext == true,
            )
        }
        val (controller, running, threadId, serverResolves) = prepared
        try {
            if (threadId != null) {
                val command = MessageDispatchCommand(
                    commandId = commandId,
                    threadId = threadId,
                    messageId = messageId,
                    text = clean,
                    // A server that resolves command context picks the mode from its own state
                    // (client-runtime commands.ts); older servers get the local guess.
                    dispatchMode = if (running && !serverResolves) DispatchMode.QueueAfterActive else DispatchMode.StartImmediately,
                    deliveryIntent = if (serverResolves) DeliveryIntent.Auto else null,
                )
                dispatch(OrchestrationCommand.MessageDispatch(command), target.environmentId)
            } else {
                val projectId = (target as? ChatTarget.Aide)?.project?.projectId ?: (target as ChatTarget.Project).project.projectId
                val result = withRetry(target.environmentId) { socket ->
                    socket.call(
                        RpcMethod.CoordinatorSend,
                        CoordinatorSendInput(projectId, commandId, clean),
                        CoordinatorSendInput.serializer(),
                        CoordinatorResult.serializer(),
                    )
                }
                withContext(engine.engineDispatcher) {
                    if (controller != null && controller.threadId == null) {
                        controller.threadId = result.threadId
                        controller.restart.value += 1
                    }
                }
            }
        } catch (e: Exception) {
            val error = SyncError.wrap(e)
            withContext(engine.engineDispatcher) {
                controller?.let {
                    it.pending.removeAll { p -> p.messageId == messageId }
                    it.session.update { state -> state.copy(lastError = error.message) }
                    render(it)
                }
            }
            throw error
        }
    }

    suspend fun stop(target: ChatTarget) {
        val (threadId, runId) = withContext(engine.engineDispatcher) {
            val entry = engine.machines[target.environmentId] ?: throw SyncError.UnknownMachine
            val threadId = threadIdFor(target) ?: throw SyncError.NothingRunning
            val runId = controllers[target]?.sync?.projection?.activeRun?.id ?: entry.thread(threadId)?.activeRunId
            threadId to (runId ?: throw SyncError.NothingRunning)
        }
        dispatch(OrchestrationCommand.RunInterrupt(RunInterruptCommand(engine.newId(), threadId, runId, holdQueue = true)), target.environmentId)
    }

    suspend fun respond(requestId: String, target: ChatTarget, decision: ApprovalDecision) {
        val threadId = withContext(engine.engineDispatcher) { threadIdFor(target) } ?: throw SyncError.RequestGone
        val wire = when (decision) {
            ApprovalDecision.Approve -> ProviderApprovalDecision.Accept
            ApprovalDecision.ApproveForSession -> ProviderApprovalDecision.AcceptForSession
            ApprovalDecision.ApproveAlways -> ProviderApprovalDecision.AcceptAlways
            ApprovalDecision.Deny -> ProviderApprovalDecision.Decline
            ApprovalDecision.Cancel -> ProviderApprovalDecision.Cancel
        }
        val command = RuntimeRequestRespondCommand(engine.newId(), threadId, requestId, decision = wire)
        dispatch(OrchestrationCommand.RuntimeRequestRespond(command), target.environmentId)
    }

    suspend fun answerAccess(request: AccessRequestRow, target: ChatTarget, answer: AccessAnswer) {
        val wire = when (answer) {
            is AccessAnswer.Allow -> AccessRequestAnswer.Allow(
                if (answer.scope == AccessScope.Machine) AccessRequestScope.Machine else AccessRequestScope.Thread,
            )
            AccessAnswer.Deny -> AccessRequestAnswer.Deny
        }
        val payload = WireJson.encodeToJsonElement(AccessAnswerRequestInput.serializer(), AccessAnswerRequestInput(request.threadId, request.itemId, wire))
        withRetry(target.environmentId) { it.call(RpcMethod.AccessAnswerRequest.tag, payload) }
    }

    suspend fun perform(action: ThreadAction, thread: ThreadRef) {
        val commandId = engine.newId()
        val id = thread.threadId
        val command: OrchestrationCommand = when (action) {
            ThreadAction.Pin -> OrchestrationCommand.ThreadPin(commandId, id)
            ThreadAction.Unpin -> OrchestrationCommand.ThreadUnpin(commandId, id)
            ThreadAction.Resolve -> OrchestrationCommand.ThreadSettle(commandId, id)
            ThreadAction.Unresolve -> OrchestrationCommand.ThreadUnsettle(commandId, id)
            ThreadAction.Archive -> OrchestrationCommand.ThreadArchive(commandId, id)
            ThreadAction.Delete -> OrchestrationCommand.ThreadDelete(commandId, id)
            ThreadAction.MarkUnread -> {
                // An open chat would otherwise mark it read again right away.
                withContext(engine.engineDispatcher) {
                    val controller = controllers[ChatTarget.Thread(thread)]
                    controller?.visited = engine.machines[thread.environmentId]?.thread(id)?.updatedAt?.plusSeconds(1)
                }
                OrchestrationCommand.ThreadMarkUnread(commandId, id)
            }
            is ThreadAction.Rename -> {
                val clean = action.title.trim()
                if (clean.isEmpty()) throw SyncError.EmptyTitle
                OrchestrationCommand.ThreadMetadataUpdate(ThreadMetadataUpdateCommand(commandId, id, title = clean))
            }
            is ThreadAction.SetRuntimeMode -> OrchestrationCommand.Other(
                JsonObject(
                    mapOf(
                        "type" to JsonPrimitive("thread.runtime-mode.set"),
                        "commandId" to JsonPrimitive(commandId),
                        "threadId" to JsonPrimitive(id),
                        "runtimeMode" to JsonPrimitive(action.mode.rawValue),
                        "applyOnNextTurn" to JsonPrimitive(true),
                    ),
                ),
            )
        }
        withContext(engine.engineDispatcher) {
            blockedReason(ChatTarget.Thread(thread))?.let { throw SyncError.SendBlocked(it) }
        }
        dispatch(command, thread.environmentId)
    }

    suspend fun startThread(request: NewThreadRequest): ThreadRef {
        val text = request.text.trim()
        if (text.isEmpty()) throw SyncError.EmptyMessage
        val env = request.project.environmentId
        val selection = withContext(engine.engineDispatcher) {
            val entry = engine.machines[env] ?: throw SyncError.UnknownMachine
            blockedReason(ChatTarget.Project(request.project))?.let { throw SyncError.SendBlocked(it) }
            val project = entry.project(request.project.projectId) ?: throw SyncError.ProjectNotFound
            request.model?.let { ModelSelection(it.instanceId, it.model) }
                ?: project.defaultModelSelection
                ?: entry.settings?.defaultModelSelection
                ?: throw SyncError.SendBlocked("Choose a model for the new thread.")
        }
        val title = text.lineSequence().first().trim().let { if (it.length > 60) it.take(60).trim() + "…" else it }
        val input = ThreadLaunchInput(
            commandId = engine.newId(),
            projectId = request.project.projectId,
            title = title,
            modelSelection = selection,
            runtimeMode = RuntimeMode(request.runtimeMode.rawValue),
            initialMessage = InitialMessage(messageId = engine.newId(), text = text),
            generateTitle = true,
        )
        val result = withRetry(env) { socket ->
            socket.call(RpcMethod.LaunchThread, input, ThreadLaunchInput.serializer(), ThreadLaunchResult.serializer())
        }
        return ThreadRef(env, result.threadId)
    }

    // Calls

    /** The thread a target's commands address, when it is known. */
    private fun threadIdFor(target: ChatTarget): String? {
        controllers[target]?.threadId?.let { return it }
        return when (target) {
            is ChatTarget.Thread -> target.thread.threadId
            is ChatTarget.Aide -> engine.machines[target.environmentId]?.project(target.project.projectId)?.coordinatorThreadId
            is ChatTarget.Project -> engine.machines[target.environmentId]?.project(target.project.projectId)?.coordinatorThreadId
        }
    }

    private suspend fun dispatch(command: OrchestrationCommand, environmentId: String) {
        val payload = WireJson.encodeToJsonElement(OrchestrationCommandSerializer, command)
        withRetry(environmentId) { it.call(RpcMethod.DispatchCommand.tag, payload) }
    }

    /**
     * Runs a call on the machine's socket, waiting briefly for one, and retries transient
     * failures. The body must reuse its ids so a retry is idempotent.
     */
    suspend fun <T> withRetry(environmentId: String, body: suspend (RpcSocket) -> T): T {
        var attempt = 0
        while (true) {
            val socket = awaitSocket(environmentId)
            try {
                return body(socket)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (LiveEngine.isAuthFailure(e)) {
                    // A revoked pairing leaves the socket open; checking moves it to "Pair again".
                    engine.scope.launch { engine.machines[environmentId]?.let { entry -> engine.verifyAfterFailure(entry, e) } }
                }
                val transient = e is TransportException.Closed || e is TransportException.TimedOut ||
                    e is TransportException.Unreachable || (e is ServerError && e.kind == ServerError.Kind.Interrupted)
                if (!transient || attempt >= 2) throw SyncError.wrap(e)
                attempt += 1
                delay(500L * attempt)
            }
        }
    }

    private suspend fun awaitSocket(environmentId: String): RpcSocket {
        val entry = withContext(engine.engineDispatcher) { engine.machines[environmentId] } ?: throw SyncError.UnknownMachine
        entry.connection.socket.value?.let { return it }
        if (!entry.record.enabled) throw SyncError.MachineOffline(MachineNickname.shortName(entry.label))
        entry.connection.networkChanged()
        return withTimeoutOrNull(15_000) { entry.connection.socket.filterNotNull().first() }
            ?: throw SyncError.MachineOffline(MachineNickname.shortName(entry.label))
    }
}
