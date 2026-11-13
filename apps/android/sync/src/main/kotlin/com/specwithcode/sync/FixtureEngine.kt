package com.specwithcode.sync

import com.specwithcode.sync.TranscriptRow.Kind
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.yield
import java.net.URI
import java.time.Instant

/**
 * Sample scenarios. These four are ported from the iOS app; the iOS `connect-welcome`,
 * `fleet`, `m4-blip`, `minis-blip`, `check-output`, `readability`, `thread-lists`,
 * `duplicates`, `devices`, `offline-recovery`, `offline-startup`, `connect` and
 * `team-rules` scenarios come with the features they show.
 */
enum class FixtureScenario(val rawValue: String) {
    /** Three machines, Percy, four projects and fourteen threads. */
    Default("default"),

    /** No machines yet, as on first launch. */
    Empty("empty"),

    /** Like [Default], but every opened chat is mid-run with one queued message. */
    Running("running"),

    /** Like [Default], but Percy's chat holds a long history with links. */
    Long("long"),
    ;

    companion object {
        fun fromRaw(raw: String?): FixtureScenario = entries.firstOrNull { it.rawValue == raw } ?: Default
    }
}

/** A failure with a sentence the UI shows as is. */
class FixtureFailure(message: String) : Exception(message)

/**
 * Sample data for previews, UI tests and screenshots. Nothing here talks to a machine: sends
 * echo and stream a short canned reply, actions change the summaries in memory, and settings
 * live for the app session.
 *
 * [scope] runs the fake streaming; pass a main-thread scope in the app and the test scope in
 * tests. [streamDelayMs] and [latencyMs] are zero in tests.
 */
class FixtureEngine(
    val scenario: FixtureScenario = FixtureScenario.Default,
    /** Whether the sample machines turn Percy on. On by default, so screenshots show it. */
    val aideEnabled: Boolean = true,
    private val scope: CoroutineScope,
    private val clock: () -> Instant = Instant::now,
) : AppEngine {
    /** Pause between streamed chunks of a fake reply. */
    var streamDelayMs: Long = 45

    /** Simulated round trip for pairing, settings and reconnects. */
    var latencyMs: Long = 450

    private var model: AppModel? = null
    private val transcripts = mutableMapOf<ChatTarget, MutableList<TranscriptRow>>()
    private val openSessions = mutableMapOf<ChatTarget, ChatSession>()
    private val replies = mutableMapOf<ChatTarget, Job>()
    private val running = mutableSetOf<ChatTarget>()
    private val queued = mutableMapOf<ChatTarget, Int>()
    private val projectSettings = mutableMapOf<ProjectRef, ProjectSettingsDraft>()
    private val machineSettings = mutableMapOf<String, MachineSettings>()
    private val threadModes = mutableMapOf<ThreadRef, RuntimeModeChoice>()

    /** Machines that stay offline when asked to reconnect. */
    private val unreachable = mutableSetOf<String>()

    /** When the phone last had each offline machine connected. */
    private val lastSeen = mutableMapOf<String, Instant>()
    private var counter = 0

    private fun requireModel(): AppModel = model ?: throw FixtureFailure("SpecWithCode isn't ready yet. Try again in a moment.")

    // MARK: AppEngine

    override fun start(model: AppModel) {
        this.model = model
        model.update { it.copy(aideEnabled = aideEnabled) }
        if (scenario != FixtureScenario.Empty) {
            val now = clock()
            unreachable += FixtureSample.TRAVEL
            lastSeen[FixtureSample.TRAVEL] = now.minusSeconds(26 * 3600)
            model.update { state ->
                state.copy(
                    machines = FixtureSample.machines,
                    aide = if (aideEnabled) FixtureSample.aide else null,
                    projects = FixtureSample.projects,
                    threadsByProject = FixtureSample.threads(now).groupBy { it.projectRef ?: FixtureSample.specweave },
                    modelChoices = FixtureSample.machines.associate { it.id to FixtureSample.modelChoices },
                )
            }
            recompute()
        }
        model.update { it.copy(isLoading = false) }
    }

    override fun setActive(active: Boolean) = Unit

    override suspend fun pair(link: String, expectedEnvironmentId: String?): MachineSummary {
        val trimmed = link.trim()
        pause(latencyMs)
        if (trimmed.isEmpty() || trimmed.lowercase().contains("bad")) {
            throw FixtureFailure(
                "This pairing link didn't work. It may have expired or been used already. Create a new one in SpecWithCode on your computer and try again.",
            )
        }
        val model = requireModel()
        val url = try {
            URI(trimmed)
        } catch (_: Exception) {
            null
        }
        val host = url?.host
        val address = host?.let { h -> "${url.scheme ?: "https"}://$h${if (url.port != -1) ":${url.port}" else ""}" }
        if (expectedEnvironmentId != null && (address == null || model.machines.firstOrNull { it.address == address }?.id != expectedEnvironmentId)) {
            val label = model.machine(expectedEnvironmentId)?.label ?: "this machine"
            throw FixtureFailure("This pairing link is for a different machine. Create one in SpecWithCode on $label and try again.")
        }
        val existing = address?.let { a -> model.machines.firstOrNull { it.address == a } }
        if (existing != null) {
            unreachable -= existing.id
            updateMachine(existing.id) { it.copy(status = MachineStatus.Connected, isDisconnected = false, tokenDaysLeft = 30) }
            recompute()
            return requireNotNull(model.machine(existing.id))
        }
        counter += 1
        val machine = MachineSummary(
            id = "env-paired-$counter",
            label = labelForHost(host),
            status = MachineStatus.Connected,
            platform = "macOS · arm64",
            serverVersion = "0.42.1",
            address = address,
            tokenDaysLeft = 30,
        )
        model.update { it.copy(machines = it.machines + machine) }
        recompute()
        return machine
    }

    override fun removeMachine(id: String) {
        val model = model ?: return
        model.update { state ->
            state.copy(
                machines = state.machines.filter { it.id != id },
                projects = state.projects.filter { it.ref.environmentId != id },
                threadsByProject = state.threadsByProject.filterKeys { it.environmentId != id },
                aide = state.aide?.takeIf { it.ref.environmentId != id },
            )
        }
        unreachable -= id
        recompute()
    }

    override suspend fun setConnectionEnabled(enabled: Boolean, machineId: String) {
        val model = requireModel()
        if (model.machine(machineId) == null) throw SyncError.UnknownMachine
        updateMachine(machineId) { it.copy(isDisconnected = !enabled, status = MachineStatus.Offline) }
        recompute()
        if (enabled) reconnect(machineId)
    }

    override fun reconnect(machineId: String) {
        val machine = model?.machine(machineId) ?: return
        if (machine.isDisconnected) return
        updateMachine(machineId) { it.copy(status = MachineStatus.Reconnecting) }
        recompute()
        val wait = latencyMs * 2
        scope.launch {
            delay(wait)
            finishReconnect(machineId)
        }
    }

    override fun open(session: ChatSession) {
        val target = session.id
        openSessions[target] = session
        if (transcripts[target] == null) transcripts[target] = initialTranscript(target).toMutableList()
        if (scenario == FixtureScenario.Running && replies[target] == null && target !in running) {
            running += target
            queued[target] = 1
            if (transcripts[target]?.lastOrNull()?.let(::isRunningTool) != true) {
                rows(target) += row("t", Kind.Tool("Running npm test", "vitest run --reporter dot", "terminal", ToolStatus.Running))
            }
        }
        if (target is ChatTarget.Thread) updateThread(target.thread) { it.copy(isUnread = false) }
        refresh(target)
    }

    override fun close(session: ChatSession) {
        openSessions.remove(session.id)
    }

    override suspend fun send(text: String, images: List<OutgoingImage>, target: ChatTarget) {
        val model = requireModel()
        val machine = model.machine(target.environmentId)
        if (machine?.status?.isOnline != true) {
            throw FixtureFailure("${machine?.label ?: "This machine"} is offline, so the message wasn't sent. Try again when it reconnects.")
        }
        if (transcripts[target] == null) transcripts[target] = initialTranscript(target).toMutableList()
        val queues = target in running
        rows(target) += row(
            "u",
            Kind.User(text, if (queues) UserMessageState.Queued else UserMessageState.Sent, images.map { it.transcriptAttachment }),
        )
        touch(target, text, ThreadActivity.Working)
        if (queues) {
            queued[target] = (queued[target] ?: 0) + 1
            refresh(target)
            return
        }
        running += target
        startReply(reply(target), target)
    }

    override suspend fun stop(target: ChatTarget) {
        replies.remove(target)?.cancel()
        if (!running.remove(target)) return
        transcripts[target]?.let { list -> list.replaceAll { held(finished(it)) } }
        val held = queued[target] ?: 0
        val notice = if (held > 0) "Stopped. $held queued message${if (held == 1) " is" else "s are"} on hold." else "Stopped."
        rows(target) += row("n", Kind.Notice(notice))
        touch(target, "Stopped", ThreadActivity.Idle)
        refresh(target)
    }

    override suspend fun respond(requestId: String, target: ChatTarget, decision: ApprovalDecision) {
        val rows = transcripts[target]
        val index = rows?.indexOfFirst { requestIdOf(it) == requestId } ?: -1
        if (rows == null || index < 0) throw FixtureFailure("That request is no longer waiting for an answer.")
        pause(latencyMs / 3)
        var prompt = ""
        when (val kind = rows[index].kind) {
            is Kind.Approval -> {
                prompt = kind.prompt
                rows[index] = rows[index].copy(kind = Kind.Approval(kind.requestId, kind.prompt, resolved = true))
            }
            is Kind.Question -> rows[index] = rows[index].copy(kind = Kind.Question(kind.requestId, kind.prompt, resolved = true))
            else -> Unit
        }
        if (decision == ApprovalDecision.Deny) {
            rows += row("n", Kind.Notice("Denied. The run will look for another way."))
            touch(target, "Approval denied", ThreadActivity.Idle)
            refresh(target)
            return
        }
        rows += row("t", Kind.Tool("Ran $prompt", "Exit code 0", "terminal", ToolStatus.Completed))
        advancePlan(target)
        touch(target, "Publishing 3.1.0", ThreadActivity.Working)
        running += target
        startReply("Published **3.1.0** to the `next` tag. The release workflow is running; I'll open the release PR once it's green.", target)
    }

    override suspend fun answerAccess(request: AccessRequestRow, target: ChatTarget, answer: AccessAnswer) {
        val rows = transcripts[target]
        val index = rows?.indexOfFirst { (it.kind as? Kind.Access)?.request?.let { r -> r.itemId == request.itemId && r.isPending } == true } ?: -1
        if (rows == null || index < 0) throw FixtureFailure("This access request was already answered.")
        pause(latencyMs / 3)
        val current = (rows[index].kind as Kind.Access).request
        val state = when (answer) {
            AccessAnswer.Allow(AccessScope.Thread) -> AccessRequestRow.State.AllowedInThread
            AccessAnswer.Allow(AccessScope.Machine) -> AccessRequestRow.State.AllowedOnMachine
            else -> AccessRequestRow.State.Denied
        }
        rows[index] = rows[index].copy(kind = Kind.Access(current.copy(state = state)))
        refresh(target)
    }

    override suspend fun perform(action: ThreadAction, thread: ThreadRef) {
        val model = requireModel()
        if (model.thread(thread) == null) throw FixtureFailure("That thread no longer exists.")
        if (model.machine(thread.environmentId)?.status?.isOnline != true) {
            throw FixtureFailure("${model.machine(thread.environmentId)?.label ?: "Its machine"} is offline. Try again when it reconnects.")
        }
        when (action) {
            ThreadAction.Pin -> updateThread(thread) { it.copy(isPinned = true) }
            ThreadAction.Unpin -> updateThread(thread) { it.copy(isPinned = false) }
            ThreadAction.Resolve -> updateThread(thread) { it.copy(isResolved = true) }
            ThreadAction.Unresolve -> updateThread(thread) { it.copy(isResolved = false) }
            ThreadAction.MarkUnread -> updateThread(thread) { it.copy(isUnread = true) }
            is ThreadAction.SetRuntimeMode -> {
                threadModes[thread] = action.mode
                refresh(ChatTarget.Thread(thread))
            }
            is ThreadAction.Rename -> {
                val clean = action.title.trim()
                if (clean.isEmpty()) throw FixtureFailure("A thread needs a name.")
                updateThread(thread) { it.copy(title = clean) }
                openSessions[ChatTarget.Thread(thread)]?.update { it.copy(title = clean) }
            }
            ThreadAction.Archive, ThreadAction.Delete -> {
                model.update { state -> state.copy(threadsByProject = state.threadsByProject.mapValues { (_, list) -> list.filter { it.ref != thread } }) }
                val target = ChatTarget.Thread(thread)
                replies.remove(target)?.cancel()
                running -= target
            }
        }
        recompute()
    }

    override suspend fun startThread(request: NewThreadRequest): ThreadRef {
        val model = requireModel()
        val text = request.text.trim()
        if (text.isEmpty()) throw SyncError.EmptyMessage
        val project = model.project(request.project) ?: throw SyncError.ProjectNotFound
        requireOnline(project.ref.environmentId, "start a thread")
        pause(latencyMs / 3)
        counter += 1
        val ref = ThreadRef(project.ref.environmentId, "t-new-$counter")
        val now = clock()
        val thread = ThreadSummary(
            ref = ref,
            projectRef = project.ref,
            projectTitle = project.title,
            title = text.lineSequence().first().take(72),
            activity = ThreadActivity.Working,
            preview = text,
            updatedAt = now,
            workStartedAt = now,
            machineLabel = model.machine(ref.environmentId)?.label ?: project.machineLabel,
            machineOnline = true,
        )
        model.update { state ->
            val list = state.threadsByProject[project.ref] ?: emptyList()
            state.copy(threadsByProject = state.threadsByProject + (project.ref to listOf(thread) + list))
        }
        threadModes[ref] = request.runtimeMode
        val target = ChatTarget.Thread(ref)
        transcripts[target] = mutableListOf(row("u", Kind.User(text)))
        running += target
        recompute()
        startReply(reply(target), target)
        return ref
    }

    override suspend fun setupAide(): ProjectRef {
        val model = requireModel()
        if (!aideEnabled) throw SyncError.AideDisabled
        model.aide?.let { return it.ref }
        // Every client puts Percy on the machine with the lowest environment id, offline ones
        // included, and creates nothing while a machine is offline: that machine may hold Percy.
        val machine = model.machines.minByOrNull { it.id } ?: throw FixtureFailure("Connect a machine before setting up Percy.")
        if (!model.machines.all { it.status.isOnline }) {
            throw FixtureFailure("Percy may already be on a machine that's offline. Reconnect your machines, then try again.")
        }
        pause(latencyMs)
        val ref = ProjectRef(machine.id, "aide")
        model.update {
            it.copy(
                aide = ProjectSummary(
                    ref, "Percy", ProjectIcon.Symbol("concierge-bell", "violet"), ProjectKind.Personal, machine.label, machineOnline = true,
                ),
            )
        }
        transcripts[ChatTarget.Aide(ref)] = mutableListOf(
            row("a", Kind.Assistant("Hi, I'm Percy. Ask me anything, or tell me what to start. I can open threads in any project on ${machine.label}.", streaming = false)),
        )
        recompute()
        return ref
    }

    override suspend fun loadProjectSettings(project: ProjectRef): ProjectSettingsDraft {
        pause(latencyMs / 2)
        val draft = currentSettings(project)
        requireOnline(project.environmentId, "load these settings")
        return draft
    }

    override suspend fun saveProjectSettings(draft: ProjectSettingsDraft, project: ProjectRef) {
        pause(latencyMs / 2)
        val current = currentSettings(project)
        requireOnline(project.environmentId, "save these settings")
        if (draft.revision != current.revision) {
            val label = model?.machine(project.environmentId)?.label ?: "the machine"
            throw FixtureFailure("These settings changed on $label while you were editing. Close and reopen them to see the latest.")
        }
        val title = draft.title.trim()
        if (title.isEmpty()) throw FixtureFailure("A project needs a name.")
        val icon = draft.icon
        val saved = draft.copy(title = title, revision = draft.revision + 1, icon = null)
        projectSettings[project] = saved
        val model = model ?: return
        fun apply(summary: ProjectSummary) = summary.copy(
            icon = icon ?: summary.icon, title = saved.title, paused = saved.paused, archived = saved.archived,
        )
        model.update { state ->
            if (state.aide?.ref == project) {
                state.copy(aide = apply(state.aide))
            } else {
                state.copy(projects = state.projects.map { if (it.ref == project) apply(it) else it })
            }
        }
        for (target in listOf(ChatTarget.Project(project), ChatTarget.Aide(project))) {
            openSessions[target]?.update { it.copy(title = saved.title) }
        }
        recompute()
    }

    override suspend fun loadMachineSettings(machineId: String): MachineSettings {
        pause(latencyMs / 2)
        requireOnline(machineId, "read its settings")
        return machineSettings[machineId] ?: MachineSettings(RuntimeModeChoice.AutoAcceptEdits, null)
    }

    override suspend fun saveMachineSettings(settings: MachineSettings, machineId: String) {
        pause(latencyMs / 2)
        requireOnline(machineId, "save its settings")
        machineSettings[machineId] = settings
    }

    // MARK: State

    private fun recompute() {
        val model = model ?: return
        model.update { state ->
            val online = state.machines.associate { it.id to it.status.isOnline }
            fun unknown(thread: ThreadSummary): ThreadPlacement.Unknown? {
                val owner = thread.ref.environmentId
                if (online[owner] == true) return null
                val label = state.machine(owner)?.label ?: thread.machineLabel
                return ThreadPlacement.Unknown(MachineNickname.shortName(label), lastSeen[owner])
            }
            val threadsByProject = state.threadsByProject.mapValues { (_, list) ->
                list.map { it.copy(machineOnline = online[it.ref.environmentId] ?: false, placement = it.placement.copy(unknown = unknown(it))) }
                    .sortedByDescending { it.updatedAt }
            }
            fun refreshed(project: ProjectSummary): ProjectSummary {
                val threads = threadsByProject[project.ref] ?: emptyList()
                return project.copy(
                    workingCount = threads.count { it.activity == ThreadActivity.Working && !it.isResolved },
                    hasUnread = threads.any { it.isUnread },
                    machineOnline = online[project.ref.environmentId] ?: false,
                    machineLabel = state.machine(project.ref.environmentId)?.label ?: project.machineLabel,
                    members = project.members.map {
                        it.copy(machineOnline = online[it.ref.environmentId] ?: false, lastSeenAt = lastSeen[it.ref.environmentId])
                    },
                )
            }
            val projects = state.projects.map(::refreshed)
                .sortedWith(compareBy<ProjectSummary> { !it.isPinned }.thenBy(String.CASE_INSENSITIVE_ORDER) { it.title })
            // A merged row lists the same threads under each of its members.
            val all = threadsByProject.values.flatten().distinctBy { it.ref }
            val recent = all.sortedWith(compareBy<ThreadSummary> { !it.isPinned }.thenByDescending { it.updatedAt }).take(10)
            state.copy(threadsByProject = threadsByProject, projects = projects, aide = state.aide?.let(::refreshed), recentThreads = recent)
        }
        for (target in openSessions.keys.toList()) refresh(target)
    }

    private fun refresh(target: ChatTarget) {
        val session = openSessions[target] ?: return
        val model = model ?: return
        val rows = transcripts[target]?.toList() ?: emptyList()
        val machine = model.machine(target.environmentId)
        val online = machine?.status?.isOnline ?: false
        val short = machine?.let { MachineNickname.shortName(it.label) }
        session.update { state ->
            var next = state.copy(
                rows = rows,
                isLoaded = true,
                isRunning = target in running,
                queuedCount = queued[target] ?: 0,
                plan = plan(rows, target in running),
                machineLabel = machine?.label ?: "",
                machineOnline = online,
                isStale = !online,
                sendBlockedReason = if (online) null else "${machine?.label ?: "This machine"} is offline. You can send again when it reconnects.",
            )
            when (target) {
                is ChatTarget.Aide, is ChatTarget.Project -> {
                    val ref = if (target is ChatTarget.Aide) target.project else (target as ChatTarget.Project).project
                    model.project(ref)?.let { next = next.copy(title = it.title) }
                    next = next.copy(subtitle = "Coordinator · ${short ?: "machine"}")
                }
                is ChatTarget.Thread -> model.thread(target.thread)?.let { thread ->
                    val personal = thread.projectRef?.let { model.project(it) }?.kind == ProjectKind.Personal
                    next = next.copy(
                        title = thread.title,
                        subtitle = ChatSession.threadSubtitle(thread.projectTitle ?: "Thread", short ?: "", personal),
                    )
                }
            }
            next
        }
    }

    private fun finishReconnect(machineId: String) {
        val machine = model?.machine(machineId) ?: return
        if (machine.isDisconnected) return
        updateMachine(machineId) { it.copy(status = if (machineId in unreachable) MachineStatus.Offline else MachineStatus.Connected) }
        recompute()
    }

    private fun updateMachine(id: String, change: (MachineSummary) -> MachineSummary) {
        model?.update { state -> state.copy(machines = state.machines.map { if (it.id == id) change(it) else it }) }
    }

    private fun updateThread(ref: ThreadRef, change: (ThreadSummary) -> ThreadSummary) {
        model?.update { state ->
            state.copy(threadsByProject = state.threadsByProject.mapValues { (_, list) -> list.map { if (it.ref == ref) change(it) else it } })
        }
        recompute()
    }

    private fun touch(target: ChatTarget, preview: String, activity: ThreadActivity) {
        if (target !is ChatTarget.Thread) return
        val line = preview.lineSequence().firstOrNull() ?: preview
        val now = clock()
        updateThread(target.thread) {
            var next = it.copy(preview = line.replace("*", "").replace("`", ""), updatedAt = now, activity = activity)
            if (activity == ThreadActivity.Working && it.activity != ThreadActivity.Working) next = next.copy(workStartedAt = now)
            if (activity == ThreadActivity.Idle) next = next.copy(workStartedAt = null)
            next
        }
    }

    private fun currentSettings(project: ProjectRef): ProjectSettingsDraft {
        projectSettings[project]?.let { return it }
        val summary = model?.project(project) ?: throw FixtureFailure("This project is no longer available.")
        val draft = ProjectSettingsDraft(
            title = summary.title,
            goal = FixtureSample.goal(project.projectId),
            instructions = if (project.projectId == FixtureSample.specweave.projectId) {
                "Keep pull requests small. Run the full test suite before asking for a merge."
            } else {
                ""
            },
            paused = summary.paused,
            archived = summary.archived,
            coordinatorModel = "Default",
            revision = 1,
        )
        projectSettings[project] = draft
        return draft
    }

    private fun requireOnline(machineId: String, action: String) {
        val machine = model?.machine(machineId)
        if (machine?.status?.isOnline != true) throw FixtureFailure("${machine?.label ?: "That machine"} is offline. Connect it to $action.")
    }

    // MARK: Replies

    private fun rows(target: ChatTarget): MutableList<TranscriptRow> = transcripts.getOrPut(target) { mutableListOf() }

    private fun startReply(text: String, target: ChatTarget) {
        val id = nextId("a")
        rows(target) += TranscriptRow(id, Kind.Assistant("", streaming = true))
        refresh(target)
        replies[target] = scope.launch { stream(text, id, target) }
    }

    private suspend fun stream(text: String, rowId: String, target: ChatTarget) {
        pause(streamDelayMs * 8)
        var shown = ""
        for (chunk in chunks(text)) {
            shown += chunk
            setAssistant(rowId, target, shown, streaming = true)
            pause(streamDelayMs)
        }
        setAssistant(rowId, target, text, streaming = false)
        replies.remove(target)
        val waiting = queued[target] ?: 0
        if (waiting > 0) {
            queued[target] = waiting - 1
            startQueuedMessage(target)
            startReply(reply(target), target)
        } else {
            running -= target
            touch(target, text, ThreadActivity.Idle)
            refresh(target)
        }
    }

    /** The oldest queued message's run starts. */
    private fun startQueuedMessage(target: ChatTarget) {
        val rows = transcripts[target] ?: return
        val index = rows.indexOfFirst { (it.kind as? Kind.User)?.state.let { s -> s == UserMessageState.Queued || s == UserMessageState.Held } }
        if (index < 0) return
        val kind = rows[index].kind as Kind.User
        rows[index] = rows[index].copy(kind = kind.copy(state = UserMessageState.Sent))
    }

    private fun setAssistant(id: String, target: ChatTarget, markdown: String, streaming: Boolean) {
        val rows = transcripts[target] ?: return
        val index = rows.indexOfFirst { it.id == id }
        if (index < 0) return
        rows[index] = rows[index].copy(kind = Kind.Assistant(markdown, streaming))
        refresh(target)
    }

    private fun advancePlan(target: ChatTarget) {
        val rows = transcripts[target] ?: return
        val index = rows.indexOfLast { it.kind is Kind.Plan }
        if (index < 0) return
        val steps = (rows[index].kind as Kind.Plan).steps.toMutableList()
        val i = steps.indexOfFirst { it.status == TodoStep.Status.Running }
        if (i >= 0) {
            steps[i] = steps[i].copy(status = TodoStep.Status.Completed)
            if (i + 1 < steps.size) steps[i + 1] = steps[i + 1].copy(status = TodoStep.Status.Running)
        }
        rows[index] = rows[index].copy(kind = Kind.Plan(steps))
        if (target is ChatTarget.Thread) {
            val done = steps.count { it.status == TodoStep.Status.Completed }
            updateThread(target.thread) { it.copy(planProgress = PlanProgress(done, steps.size)) }
        }
    }

    /** Waits, or yields when there is no delay. Cancellation ends the caller. */
    private suspend fun pause(ms: Long) {
        if (ms > 0) delay(ms) else yield()
    }

    private fun nextId(prefix: String): String {
        counter += 1
        return "$prefix-$counter"
    }

    private fun row(prefix: String, kind: Kind) = TranscriptRow(nextId(prefix), kind)

    // MARK: Transcripts

    private fun initialTranscript(target: ChatTarget): List<TranscriptRow> {
        val model = model
        return when (target) {
            is ChatTarget.Aide -> {
                val rows = if (scenario == FixtureScenario.Long) FixtureSample.longAideTranscript else FixtureSample.aideTranscript
                rows.map { row("a", it) }
            }
            is ChatTarget.Project -> {
                val title = model?.project(target.project)?.title ?: "this project"
                val threads = model?.threads(target.project) ?: emptyList()
                val working = threads.count { it.activity == ThreadActivity.Working }
                val needs = threads.count { it.activity == ThreadActivity.NeedsYou }
                val needsLabel = if (needs == 1) "1 needs you" else "$needs need you"
                var summary = "Here's where **$title** stands: $working working, $needsLabel, ${threads.size - working - needs} idle."
                threads.firstOrNull { it.activity == ThreadActivity.NeedsYou }?.let {
                    summary += "\n\n*${it.title}* needs an answer before it can continue."
                }
                listOf(row("u", Kind.User("What's the status?")), row("a", Kind.Assistant(summary, streaming = false)))
            }
            is ChatTarget.Thread -> {
                val ref = target.thread
                if (ref.threadId == "t-release") return FixtureSample.releaseTranscript.map { row("r", it) }
                val thread = model?.thread(ref) ?: return listOf(row("n", Kind.Notice("No messages yet.")))
                val rows = mutableListOf(row("u", Kind.User(thread.title)))
                thread.planProgress?.let { rows += row("p", Kind.Plan(FixtureSample.steps(it))) }
                when (thread.activity) {
                    ThreadActivity.Working -> {
                        rows += row("t", Kind.Tool("Read the open increment", ".specweave/increments/spec.md", "doc.text", ToolStatus.Completed))
                        rows += row("t", Kind.Tool(thread.preview ?: "Working", null, "terminal", ToolStatus.Running))
                        running += target
                    }
                    ThreadActivity.Failed -> {
                        rows += row("t", Kind.Tool("Ran npm test", "3 files failed · exit code 1", "terminal", ToolStatus.Failed))
                        rows += row("e", Kind.Error(thread.preview ?: "The run failed."))
                    }
                    ThreadActivity.NeedsYou -> rows += row("q", Kind.Approval("req-${ref.threadId}", "git push origin HEAD", resolved = false))
                    ThreadActivity.Idle -> rows += row("a", Kind.Assistant(thread.preview ?: "Done.", streaming = false))
                }
                rows
            }
        }
    }

    companion object {
        private fun reply(target: ChatTarget): String = when (target) {
            is ChatTarget.Aide -> "Sure. I'll take care of that and let you know here when it's done."
            is ChatTarget.Project ->
                "On it. I'll start a thread for this and report back once it has a plan.\n\n- Read the open increment\n- Split the work into tasks\n- Start the first task"
            is ChatTarget.Thread -> "Got it. I'll fold that into the current work.\n\nNext I'll run the checks again and post the results here."
        }

        /** Two words at a time, keeping the spaces and line breaks. */
        internal fun chunks(text: String): List<String> {
            val words = mutableListOf<String>()
            val current = StringBuilder()
            for (character in text) {
                current.append(character)
                if (character == ' ' || character == '\n') {
                    words += current.toString()
                    current.clear()
                }
            }
            if (current.isNotEmpty()) words += current.toString()
            return words.chunked(2).map { it.joinToString("") }
        }

        private fun plan(rows: List<TranscriptRow>, running: Boolean): PlanProgress? {
            for (row in rows.asReversed()) {
                val steps = (row.kind as? Kind.Plan)?.steps ?: continue
                if (steps.isEmpty()) continue
                val done = steps.count { it.status == TodoStep.Status.Completed }
                return if (done < steps.size || running) PlanProgress(done, steps.size) else null
            }
            return null
        }

        private fun finished(row: TranscriptRow): TranscriptRow = when (val kind = row.kind) {
            is Kind.Assistant -> if (kind.streaming) row.copy(kind = kind.copy(streaming = false)) else row
            is Kind.Reasoning -> if (kind.streaming) row.copy(kind = kind.copy(streaming = false)) else row
            is Kind.Tool -> if (kind.status == ToolStatus.Running) row.copy(kind = kind.copy(status = ToolStatus.Failed)) else row
            else -> row
        }

        /** Stop holds the queue: queued messages wait until it is resumed. */
        private fun held(row: TranscriptRow): TranscriptRow {
            val kind = row.kind as? Kind.User ?: return row
            return if (kind.state == UserMessageState.Queued) row.copy(kind = kind.copy(state = UserMessageState.Held)) else row
        }

        private fun isRunningTool(row: TranscriptRow): Boolean = (row.kind as? Kind.Tool)?.status == ToolStatus.Running

        private fun requestIdOf(row: TranscriptRow): String? = when (val kind = row.kind) {
            is Kind.Approval -> kind.requestId
            is Kind.Question -> kind.requestId
            else -> null
        }

        internal fun labelForHost(host: String?): String {
            if (host.isNullOrEmpty()) return "New machine"
            if (host.all { it.isDigit() || it == '.' || it == ':' }) return "Machine at $host"
            val name = host.split('.').first().replace('-', ' ')
            return name.replaceFirstChar { it.uppercase() }
        }
    }
}
