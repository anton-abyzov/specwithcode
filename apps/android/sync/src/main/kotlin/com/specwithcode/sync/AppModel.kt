package com.specwithcode.sync

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/** Everything the UI shows outside an open conversation. */
data class AppState(
    val machines: List<MachineSummary> = emptyList(),
    /** The personal assistant project, if one exists on any machine. */
    val aide: ProjectSummary? = null,
    /** Whether Aide is shown. While false, [aide] is null and Aide's chats are left out of every list. */
    val aideEnabled: Boolean = false,
    /** Code projects across machines, pinned first, then by title. */
    val projects: List<ProjectSummary> = emptyList(),
    /** Threads by project. */
    val threadsByProject: Map<ProjectRef, List<ThreadSummary>> = emptyMap(),
    /** Most recent top-level threads across machines, pinned first. */
    val recentThreads: List<ThreadSummary> = emptyList(),
    /** True until every enabled machine has answered once (or failed). */
    val isLoading: Boolean = true,
    /** False while a paired machine's projects and threads have not arrived yet. */
    val allShellsLoaded: Boolean = true,
    val appearance: AppearancePreference = AppearancePreference.System,
    /** Models each machine offers for new threads, by machine id. Empty until the machine lists them. */
    val modelChoices: Map<String, List<ModelChoice>> = emptyMap(),
) {
    val pinnedProjects: List<ProjectSummary> get() = projects.filter { it.isPinned && !it.archived && !it.isAutomated }
    val otherProjects: List<ProjectSummary> get() = projects.filter { !it.isPinned && !it.archived && !it.isAutomated }

    /** Projects checks and agents made for themselves, listed apart under "Automated". */
    val automatedProjects: List<ProjectSummary> get() = projects.filter { it.isAutomated && !it.archived }
    val archivedProjects: List<ProjectSummary> get() = projects.filter { it.archived }

    fun machine(id: String): MachineSummary? = machines.firstOrNull { it.id == id }

    /** The project row for a project or any machine's copy of it. */
    fun project(ref: ProjectRef): ProjectSummary? {
        if (aide?.ref == ref) return aide
        return projects.firstOrNull { it.ref == ref } ?: projects.firstOrNull { it.contains(ref) }
    }

    fun threads(project: ProjectRef): List<ThreadSummary> =
        threadsByProject[project] ?: project(project)?.let { threadsByProject[it.ref] } ?: emptyList()

    fun thread(ref: ThreadRef): ThreadSummary? {
        for (list in threadsByProject.values) list.firstOrNull { it.ref == ref }?.let { return it }
        return recentThreads.firstOrNull { it.ref == ref }
    }
}

/**
 * The model screens read. The engine writes it with [update]; screens collect [state].
 * Appearance is kept here for the session; the app layer persists it.
 */
class AppModel(val engine: AppEngine) {
    private val mutableState = MutableStateFlow(AppState())
    val state: StateFlow<AppState> = mutableState.asStateFlow()

    private val sessions = mutableMapOf<ChatTarget, ChatSession>()
    private val sessionViewers = mutableMapOf<ChatTarget, Int>()

    init {
        engine.start(this)
    }

    /** The current snapshot. */
    val value: AppState get() = mutableState.value

    fun update(change: (AppState) -> AppState) = mutableState.update(change)

    // Shortcuts for the current snapshot.
    val machines: List<MachineSummary> get() = value.machines
    val aide: ProjectSummary? get() = value.aide
    val aideEnabled: Boolean get() = value.aideEnabled
    val projects: List<ProjectSummary> get() = value.projects
    val threadsByProject: Map<ProjectRef, List<ThreadSummary>> get() = value.threadsByProject
    val recentThreads: List<ThreadSummary> get() = value.recentThreads
    val isLoading: Boolean get() = value.isLoading
    val pinnedProjects: List<ProjectSummary> get() = value.pinnedProjects
    val otherProjects: List<ProjectSummary> get() = value.otherProjects

    fun machine(id: String): MachineSummary? = value.machine(id)
    fun project(ref: ProjectRef): ProjectSummary? = value.project(ref)
    fun threads(project: ProjectRef): List<ThreadSummary> = value.threads(project)
    fun thread(ref: ThreadRef): ThreadSummary? = value.thread(ref)

    fun setAppearance(appearance: AppearancePreference) = update { it.copy(appearance = appearance) }

    /**
     * A screen showing a chat calls this when it appears. The same chat can be on screen
     * twice, so viewers are counted. [startingCoordinator] is false where the chat appears
     * without being asked for: the project's coordinator is then created by a send.
     */
    fun openSession(session: ChatSession, startingCoordinator: Boolean = true) {
        if (startingCoordinator || sessionViewers[session.id] == null) session.startsCoordinator = startingCoordinator
        sessionViewers[session.id] = (sessionViewers[session.id] ?: 0) + 1
        engine.open(session)
    }

    /** The engine stops following a chat only when its last viewer goes. */
    fun closeSession(session: ChatSession) {
        val remaining = (sessionViewers[session.id] ?: 1) - 1
        if (remaining > 0) sessionViewers[session.id] = remaining else sessionViewers.remove(session.id)
        if (remaining <= 0) engine.close(session)
    }

    /** The shared session for a target; screens call [openSession] when they appear. */
    fun session(target: ChatTarget): ChatSession = sessions.getOrPut(target) {
        val state = value
        when (target) {
            is ChatTarget.Aide, is ChatTarget.Project -> {
                val ref = if (target is ChatTarget.Aide) target.project else (target as ChatTarget.Project).project
                val summary = state.project(ref)
                val machine = state.machine(ref.environmentId)
                ChatSession(
                    id = target,
                    title = summary?.title ?: "Project",
                    subtitle = "Coordinator · ${machine?.displayName ?: "machine"}",
                    machineLabel = machine?.displayName ?: "",
                    machineOnline = machine?.status?.isOnline ?: false,
                )
            }
            is ChatTarget.Thread -> {
                val summary = state.thread(target.thread)
                val machine = state.machine(target.thread.environmentId)
                val personal = summary?.projectRef?.let { state.project(it) }?.kind == ProjectKind.Personal
                ChatSession(
                    id = target,
                    title = summary?.title ?: "Thread",
                    subtitle = ChatSession.threadSubtitle(summary?.projectTitle ?: "Thread", machine?.displayName ?: "", personal),
                    machineLabel = machine?.displayName ?: "",
                    machineOnline = machine?.status?.isOnline ?: false,
                )
            }
        }
    }
}

/** What an open conversation shows. */
data class ChatState(
    val title: String,
    /** e.g. "Coordinator · M4" or "SpecWeave" */
    val subtitle: String,
    val rows: List<TranscriptRow> = emptyList(),
    /** True from the moment the first cached or live data arrives. */
    val isLoaded: Boolean = false,
    /** Content came from the cache and is not live yet. Stop and queue stay disabled. */
    val isStale: Boolean = false,
    val isRunning: Boolean = false,
    val queuedCount: Int = 0,
    /** The predicted next prompt: set when the latest run completed with one. */
    val promptSuggestion: String? = null,
    val plan: PlanProgress? = null,
    val machineLabel: String,
    val machineOnline: Boolean,
    /** When set, the composer is disabled and shows this reason. */
    val sendBlockedReason: String? = null,
    /** Last send error, shown inline above the composer. */
    val lastError: String? = null,
    /** The conversation could not be loaded; [AppEngine.reload] tries again. */
    val loadError: String? = null,
)

/** One open conversation. The engine keeps it current while a screen shows it. */
class ChatSession(val id: ChatTarget, title: String, subtitle: String, machineLabel: String, machineOnline: Boolean) {
    private val mutableState = MutableStateFlow(
        ChatState(title = title, subtitle = subtitle, machineLabel = machineLabel, machineOnline = machineOnline),
    )
    val state: StateFlow<ChatState> = mutableState.asStateFlow()

    /** Opening this chat may create the project's coordinator thread. */
    var startsCoordinator: Boolean = true

    fun update(change: (ChatState) -> ChatState) = mutableState.update(change)

    val value: ChatState get() = mutableState.value
    val rows: List<TranscriptRow> get() = value.rows
    val title: String get() = value.title
    val subtitle: String get() = value.subtitle
    val isLoaded: Boolean get() = value.isLoaded
    val isStale: Boolean get() = value.isStale
    val isRunning: Boolean get() = value.isRunning
    val queuedCount: Int get() = value.queuedCount
    val plan: PlanProgress? get() = value.plan
    val machineOnline: Boolean get() = value.machineOnline
    val sendBlockedReason: String? get() = value.sendBlockedReason

    companion object {
        /** The line under a thread's title. Each machine has its own Aide, so an Aide thread names its machine. */
        fun threadSubtitle(projectTitle: String, machine: String, isPersonal: Boolean): String =
            if (isPersonal && machine.isNotEmpty()) "$projectTitle · $machine" else projectTitle
    }
}
