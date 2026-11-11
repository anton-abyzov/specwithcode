package com.specwithcode.sync

import com.specwithcode.wire.CoordinatorBindingState
import com.specwithcode.wire.ExecutionState
import com.specwithcode.wire.ProjectIconOverride
import com.specwithcode.wire.ProjectShell
import com.specwithcode.wire.RuntimeRequestKind
import com.specwithcode.wire.ServerProviderSummary
import com.specwithcode.wire.ShellSnapshot
import com.specwithcode.wire.SidebarProjectOrder
import com.specwithcode.wire.AccessRequestCopy
import com.specwithcode.wire.ThreadShell
import com.specwithcode.wire.ThreadStatus
import com.specwithcode.wire.isAutomated
import java.time.Instant

/** Turns machines' shells into the drawer and list models. Pure, so it is tested without sockets. */
object ShellSummaries {
    /** What one machine contributes. */
    data class Machine(
        val environmentId: String,
        val label: String,
        val online: Boolean,
        /** The live thread list, or the last one held while the machine is unreachable. */
        val snapshot: ShellSnapshot?,
        val projectOrder: SidebarProjectOrder? = null,
        /** Folder of the machine's scratch project ("No project"), from its server config. */
        val scratchWorkspaceRoot: String? = null,
        val lastSeenAt: Instant? = null,
        val providers: List<ServerProviderSummary> = emptyList(),
    ) {
        val displayName: String get() = MachineNickname.shortName(label)
    }

    data class Output(
        val aide: ProjectSummary?,
        val projects: List<ProjectSummary>,
        val threadsByProject: Map<ProjectRef, List<ThreadSummary>>,
        val recentThreads: List<ThreadSummary>,
    )

    const val RECENT_LIMIT = 30

    /**
     * Per-machine results kept between [build] calls, so a change on one machine (a shell
     * chunk) does not map every other machine's threads again. A machine's threads are reused
     * only while every input they are built from is unchanged: its snapshot (by identity, as
     * the reducer makes a new one on every change), label, reachability, providers, the other
     * machines' names and reachability, and the set of listed threads. Not thread-safe: use
     * it from one lane.
     */
    class Cache {
        internal data class MachineInfo(val displayName: String, val online: Boolean, val lastSeenAt: Instant?)

        internal class TopLevelKey(
            val snapshot: ShellSnapshot?,
            val environmentId: String,
            val label: String,
            val online: Boolean,
            val lastSeenAt: Instant?,
            val providers: List<ServerProviderSummary>,
            val includeAide: Boolean,
            val directory: Map<String, MachineInfo>,
            val listed: Set<String>,
        ) {
            fun matches(other: TopLevelKey): Boolean =
                snapshot === other.snapshot && environmentId == other.environmentId && label == other.label &&
                    online == other.online && lastSeenAt == other.lastSeenAt && includeAide == other.includeAide &&
                    providers == other.providers && directory == other.directory && listed == other.listed
        }

        private class TopLevel(val key: TopLevelKey, val value: Map<String, List<ThreadSummary>>)

        private class Listed(val snapshot: ShellSnapshot?, val ids: List<String>)

        private val topLevel = HashMap<String, TopLevel>()
        private val listed = HashMap<String, Listed>()

        internal fun listedIds(machine: Machine): List<String> {
            listed[machine.environmentId]?.takeIf { it.snapshot === machine.snapshot }?.let { return it.ids }
            val ids = (machine.snapshot?.threads ?: emptyList()).map { "${machine.environmentId}/${it.id}" }
            listed[machine.environmentId] = Listed(machine.snapshot, ids)
            return ids
        }

        internal fun topLevel(key: TopLevelKey, compute: () -> Map<String, List<ThreadSummary>>): Map<String, List<ThreadSummary>> {
            topLevel[key.environmentId]?.takeIf { it.key.matches(key) }?.let { return it.value }
            return compute().also { topLevel[key.environmentId] = TopLevel(key, it) }
        }

        /** Forgets machines that are gone. */
        internal fun retain(environmentIds: Set<String>) {
            topLevel.keys.retainAll(environmentIds)
            listed.keys.retainAll(environmentIds)
        }
    }

    /**
     * [includeAide] false hides Aide: no `aide`, and its chats are left out of recents and `threadsByProject`.
     * [cache] reuses unchanged machines' thread rows; the output is the same with or without it.
     */
    fun build(machines: List<Machine>, includeAide: Boolean = true, cache: Cache? = null): Output {
        val ordered = machines.sortedBy { it.environmentId }
        val orders = ordered.mapNotNull { it.projectOrder }
        val mainOrder = machines.mapNotNull { it.projectOrder }.firstOrNull { it.pinned.isNotEmpty() || it.unpinned.isNotEmpty() }
        val directory = ordered.associateBy { it.environmentId }
        val listed = if (cache == null) {
            ordered.flatMap { m -> (m.snapshot?.threads ?: emptyList()).map { "${m.environmentId}/${it.id}" } }.toSet()
        } else {
            cache.retain(directory.keys)
            ordered.flatMap { cache.listedIds(it) }.toSet()
        }
        val directoryInfo = if (cache == null) emptyMap() else {
            directory.mapValues { (_, m) -> Cache.MachineInfo(m.displayName, m.online, m.lastSeenAt) }
        }
        val aides = mutableListOf<ProjectSummary>()
        val copies = mutableListOf<LinkedCopy>()
        val threadsByProject = LinkedHashMap<ProjectRef, List<ThreadSummary>>()
        val all = mutableListOf<ThreadSummary>()

        for (machine in ordered) {
            val snapshot = machine.snapshot ?: continue
            val personalIds = snapshot.projects.filter { it.isPersonal }.map { it.id }.toSet()
            val compute = { topLevelThreads(machine, directory, listed) { includeAide || it !in personalIds } }
            val byProject = if (cache == null) compute() else {
                val key = Cache.TopLevelKey(
                    snapshot, machine.environmentId, machine.label, machine.online, machine.lastSeenAt, machine.providers,
                    includeAide, directoryInfo, listed,
                )
                cache.topLevel(key, compute)
            }
            byProject.values.forEach { all += it }
            for (project in snapshot.projects) {
                if (project.deletedAt != null) continue
                if (project.isPersonal && !includeAide) continue
                val ref = ProjectRef(machine.environmentId, project.id)
                val threads = sortThreads(byProject[project.id] ?: emptyList())
                threadsByProject[ref] = threads
                var summary = projectSummary(project, machine.environmentId, machine.displayName, machine.online, threads)
                when {
                    project.isPersonal -> aides += summary
                    isScratch(project, machine.scratchWorkspaceRoot) -> Unit
                    else -> {
                        summary = summary.copy(
                            isPinned = ProjectPinning.isPinned(project, machine.environmentId, mainOrder?.let { listOf(it) } ?: orders),
                        )
                        copies += LinkedCopy(project, summary, threads, machine.lastSeenAt, ProjectPinning.projectKeys(project, machine.environmentId))
                    }
                }
            }
        }
        val aide = aides.firstOrNull { !it.archived } ?: aides.firstOrNull()

        val projects = mutableListOf<ProjectSummary>()
        val ranks = HashMap<ProjectRef, ProjectOrdering.Rank>()
        for (group in sameProjectGroups(copies)) {
            val linked = group.filter { it.project.workspaceSettings?.logicalProject != null }
            val rank = ProjectOrdering.rank(
                (linked.ifEmpty { group }).flatMap { it.keys },
                group.map { "${it.summary.ref.environmentId}:${it.summary.ref.projectId}" },
                mainOrder,
            )
            if (group.size == 1 && group[0].project.workspaceSettings?.logicalProject == null) {
                projects += group[0].summary
                ranks[group[0].summary.ref] = rank
                continue
            }
            val (summary, threads) = merge(group)
            projects += summary
            ranks[summary.ref] = rank
            for (member in group) threadsByProject[member.summary.ref] = threads
        }

        projects.sortWith { a, b ->
            if (a.isPinned != b.isPinned) return@sortWith if (a.isPinned) -1 else 1
            ProjectOrdering.precedes(ranks[a.ref], ranks[b.ref], a.isPinned)?.let { return@sortWith if (it) -1 else 1 }
            val order = a.title.compareTo(b.title, ignoreCase = true)
            if (order != 0) return@sortWith order
            compareValuesBy(a, b, { it.ref.environmentId }, { it.ref.projectId })
        }
        val recent = all.sortedWith(
            compareByDescending<ThreadSummary> { it.activityAt }.thenBy { it.ref.environmentId }.thenBy { it.ref.threadId },
        ).take(RECENT_LIMIT)
        return Output(aide, projects, threadsByProject, recent)
    }

    internal fun topLevelThreads(
        machine: Machine,
        directory: Map<String, Machine>,
        listed: Set<String>,
        include: (String) -> Boolean,
    ): Map<String, List<ThreadSummary>> {
        val snapshot = machine.snapshot ?: return emptyMap()
        val coordinatorIds = snapshot.projects.map { it.coordinatorThreadId }.toSet()
        val titles = snapshot.projects.associate { it.id to it.displayTitle }
        val byProject = LinkedHashMap<String, MutableList<ThreadSummary>>()
        for (thread in snapshot.threads) {
            if (!include(thread.projectId) || !isTopLevel(thread, coordinatorIds)) continue
            val next = thread.movedTo
            if (next != null && next.isHandoff && "${next.environmentId ?: machine.environmentId}/${next.threadId}" in listed) continue
            val summary = threadSummary(thread, machine.environmentId, titles[thread.projectId], machine.displayName, machine.online, machine.providers)
                .copy(placement = placement(thread, machine, directory))
            byProject.getOrPut(thread.projectId) { mutableListOf() } += summary
        }
        return byProject
    }

    /** Where a thread lives and runs. A thread listed by an unreachable machine, or one its machine cannot reach, is unknown. */
    internal fun placement(thread: ThreadShell, machine: Machine, directory: Map<String, Machine>): ThreadPlacement {
        fun name(id: String, reported: String? = null): String =
            directory[id]?.displayName ?: reported?.let { MachineNickname.shortName(it) }?.ifEmpty { null } ?: "Another machine"
        val owner = thread.ownerMachineId ?: machine.environmentId
        val handoff = thread.movedTo?.takeIf { it.isHandoff }
        val execution = thread.executionMachineId ?: handoff?.environmentId ?: owner
        val executionName = name(execution, thread.executionMachineLabel ?: handoff?.machineLabel)
        val unknown = when {
            !machine.online -> ThreadPlacement.Unknown(machine.displayName, machine.lastSeenAt)
            thread.executionState == ExecutionState.Unknown ||
                (execution != machine.environmentId && directory[execution]?.online == false) ->
                ThreadPlacement.Unknown(executionName, directory[execution]?.lastSeenAt ?: thread.executionLastSeenAt)
            else -> null
        }
        return ThreadPlacement(owner = name(owner), runsOn = if (execution == owner) null else executionName, unknown = unknown)
    }

    // One row per project

    internal data class LinkedCopy(
        val project: ProjectShell,
        val summary: ProjectSummary,
        val threads: List<ThreadSummary>,
        val lastSeenAt: Instant?,
        val keys: List<String> = emptyList(),
    )

    internal fun sameProjectKeys(project: ProjectShell, environmentId: String): List<String> {
        val keys = mutableListOf<String>()
        val logical = project.workspaceSettings?.logicalProject
        val repository = project.repositoryIdentity?.groupingKey
        if (logical != null) keys += "logical:${logical.id}" else if (!repository.isNullOrEmpty()) keys += "repo:$repository"
        folderKey(project, environmentId)?.let { keys += it }
        return keys
    }

    internal fun folderKey(project: ProjectShell, environmentId: String): String? {
        val root = ProjectPinning.normalizePath(project.workspaceRoot)
        return if (root.isEmpty()) null else "folder:$environmentId:$root"
    }

    /** Groups records of the same project so each is listed once. A check's copies group apart from the person's own. */
    internal fun sameProjectGroups(copies: List<LinkedCopy>): List<List<LinkedCopy>> {
        val parent = IntArray(copies.size) { it }
        fun find(start: Int): Int {
            var index = start
            while (parent[index] != index) {
                parent[index] = parent[parent[index]]
                index = parent[index]
            }
            return index
        }
        val linkedFolders = copies.mapNotNull { copy ->
            if (copy.project.workspaceSettings?.logicalProject == null) null else folderKey(copy.project, copy.summary.ref.environmentId)
        }.toSet()
        val owner = HashMap<String, Int>()
        copies.forEachIndexed { index, copy ->
            val side = if (copy.summary.isAutomated) "automated" else "user"
            var keys = sameProjectKeys(copy.project, copy.summary.ref.environmentId)
            val folder = folderKey(copy.project, copy.summary.ref.environmentId)
            if (folder != null && folder in linkedFolders) keys = keys.filter { !it.startsWith("repo:") }
            for (key in keys) {
                val scoped = if (key.startsWith("logical:")) key else "$side|$key"
                val first = owner[scoped]
                if (first == null) {
                    owner[scoped] = index
                } else {
                    val a = find(first)
                    val b = find(index)
                    if (a != b) parent[maxOf(a, b)] = minOf(a, b)
                }
            }
        }
        val groups = LinkedHashMap<Int, MutableList<LinkedCopy>>()
        copies.indices.forEach { groups.getOrPut(find(it)) { mutableListOf() } += copies[it] }
        return groups.values.toList()
    }

    /** The active coordinator with the highest epoch among linked copies. */
    internal fun activeCoordinator(copies: List<LinkedCopy>): LinkedCopy? = copies
        .filter { it.project.workspaceSettings?.coordinatorBinding?.state == CoordinatorBindingState.Active }
        .maxByOrNull { it.project.workspaceSettings?.coordinatorBinding?.epoch ?: 0 }

    internal fun merge(copies: List<LinkedCopy>): Pair<ProjectSummary, List<ThreadSummary>> {
        val logicalIds = copies.mapNotNull { it.project.workspaceSettings?.logicalProject?.id }
        val counts = logicalIds.groupingBy { it }.eachCount()
        val most = counts.values.maxOrNull()
        val logicalId = logicalIds.firstOrNull { counts[it] == most }
        val linkedCopies = copies.filter { logicalId != null && it.project.workspaceSettings?.logicalProject?.id == logicalId }
        val coordinator = activeCoordinator(linkedCopies)
        val live = copies.filter { !it.summary.archived }
        val candidates = linkedCopies.ifEmpty { copies }.filter { live.isEmpty() || !it.summary.archived }
        val busiest = candidates.filter { it.summary.machineOnline }.maxByOrNull { copy -> copy.threads.maxOfOrNull { it.updatedAt } ?: Instant.MIN }
        val primary = coordinator ?: busiest ?: candidates.firstOrNull() ?: live.firstOrNull() ?: copies[0]
        val members = (listOf(primary) + copies.filter { it.summary.ref != primary.summary.ref }).map { copy ->
            ProjectMember(
                ref = copy.summary.ref,
                machineLabel = copy.summary.machineLabel,
                machineOnline = copy.summary.machineOnline,
                lastSeenAt = copy.lastSeenAt,
                isCoordinator = copy.summary.ref == coordinator?.summary?.ref,
                isLinked = logicalId != null && copy.project.workspaceSettings?.logicalProject?.id == logicalId,
                folder = ProjectPinning.normalizePath(copy.project.workspaceRoot),
            )
        }
        val summary = primary.summary.copy(
            title = groupLabel(copies, primary, logicalId),
            members = members,
            isPinned = copies.any { it.summary.isPinned },
            archived = live.isEmpty(),
            isAutomated = copies.all { it.summary.isAutomated },
            workingCount = copies.sumOf { it.summary.workingCount },
            hasUnread = copies.any { it.summary.hasUnread },
        )
        return summary to sortThreads(copies.flatMap { it.threads })
    }

    internal fun groupLabel(copies: List<LinkedCopy>, primary: LinkedCopy, logicalId: String?): String {
        fun unique(values: List<String?>): List<String> = values.mapNotNull { it?.trim() }.filter { it.isNotEmpty() }.distinct()
        if (logicalId != null) {
            val title = copies.mapNotNull { it.project.workspaceSettings?.logicalProject }.firstOrNull { it.id == logicalId }?.title
            if (!title.isNullOrEmpty()) return title
        }
        val titles = unique(copies.map { it.project.title })
        val displayNames = unique(copies.map { it.project.repositoryIdentity?.groupingDisplayName })
        val repositoryNames = unique(copies.map { it.project.repositoryIdentity?.name })
        val automatic = (displayNames + repositoryNames).toSet()
        if (titles.size == 1 && titles[0] !in automatic) return titles[0]
        val custom = unique(copies.map { copy ->
            val title = copy.project.title.trim()
            val folder = ProjectPinning.normalizePath(copy.project.workspaceRoot).split('/').lastOrNull() ?: "project"
            if (title in automatic || title == folder) null else title
        })
        if (custom.size == 1) return custom[0]
        if (displayNames.size == 1) return displayNames[0]
        if (repositoryNames.size == 1) return repositoryNames[0]
        return primary.project.title
    }

    fun isScratch(project: ProjectShell, scratchWorkspaceRoot: String?): Boolean {
        val root = scratchWorkspaceRoot?.let(ProjectPinning::normalizePath)
        if (root.isNullOrEmpty()) return false
        return ProjectPinning.normalizePath(project.workspaceRoot) == root
    }

    /** Threads the user started: not a coordinator and not a subagent's child. */
    fun isTopLevel(thread: ThreadShell, coordinatorIds: Set<String>): Boolean {
        if (thread.isCoordinatorThread || thread.id in coordinatorIds) return false
        if (thread.isSubagent) return false
        return !thread.isArchived && thread.deletedAt == null
    }

    /** Pinned first, then most recently updated. */
    fun sortThreads(threads: List<ThreadSummary>): List<ThreadSummary> = threads.sortedWith(
        compareBy<ThreadSummary> { !it.isPinned }.thenByDescending { it.updatedAt }.thenBy { it.ref.environmentId }.thenBy { it.ref.threadId },
    )

    // Threads

    fun activity(thread: ThreadShell): ThreadActivity = when {
        thread.pendingRuntimeRequest != null || thread.hasActionableProposedPlan -> ThreadActivity.NeedsYou
        thread.status.isWorking || thread.activityRunStatus?.isWorking == true -> ThreadActivity.Working
        thread.status == ThreadStatus.Failed -> ThreadActivity.Failed
        else -> ThreadActivity.Idle
    }

    fun preview(thread: ThreadShell): String? {
        when (activity(thread)) {
            ThreadActivity.NeedsYou -> {
                val request = thread.pendingRuntimeRequest ?: return "Plan ready"
                if (request.isAccessRequest) {
                    return AccessRequestCopy.waitingSubtitle(request.access?.subjects?.map { it.copyName } ?: emptyList())
                }
                if (request.kind.isUserInput) return "Answer needed"
                return if (request.kind == RuntimeRequestKind.AuthRefresh) "Sign-in needed" else "Approval requested"
            }
            ThreadActivity.Working -> {
                ThreadAttention.dependencyWait(thread)?.let { return it }
                thread.activeWork?.label?.takeIf { it.isNotEmpty() }?.let { return oneLine(it) }
            }
            ThreadActivity.Failed -> thread.lastError?.takeIf { it.isNotEmpty() }?.let { return oneLine(it) }
            ThreadActivity.Idle -> {
                if (ThreadAttention.needsReply(thread)) return "Reply needed"
                if ((thread.heldQueuedCount ?: 0) > 0) return "Queue held"
                ThreadAttention.dependencyWait(thread)?.let { return it }
            }
        }
        thread.latestVisibleMessage?.text?.takeIf { it.isNotEmpty() }?.let { return oneLine(it) }
        thread.reportedBlocker?.takeIf { it.isNotEmpty() }?.let { return oneLine(it) }
        return null
    }

    fun threadSummary(
        thread: ThreadShell,
        environmentId: String,
        projectTitle: String?,
        machineLabel: String,
        machineOnline: Boolean,
        providers: List<ServerProviderSummary> = emptyList(),
    ): ThreadSummary {
        val activity = activity(thread)
        val working = activity == ThreadActivity.Working || activity == ThreadActivity.NeedsYou
        val title = thread.title.trim()
        return ThreadSummary(
            ref = ThreadRef(environmentId, thread.id),
            projectRef = ProjectRef(environmentId, thread.projectId),
            projectTitle = projectTitle,
            title = title.ifEmpty { "New thread" },
            activity = activity,
            preview = preview(thread),
            updatedAt = thread.updatedAt,
            workStartedAt = if (working) thread.activityRunStartedAt ?: thread.latestRunStartedAt else null,
            isPinned = thread.isPinned,
            isResolved = thread.isSettled,
            isUnread = thread.isUnread,
            machineLabel = machineLabel,
            machineOnline = machineOnline,
            planProgress = thread.planProgress?.takeIf { it.total > 0 }?.let { PlanProgress(it.completed, it.total) },
            activityAt = listOfNotNull(thread.createdAt, thread.latestRunRequestedAt, thread.latestUserMessageAt).max(),
            identity = ThreadIdentity.from(thread.modelIdentity?.current ?: thread.modelSelection, providers),
            waitsOnUser = (thread.heldQueuedCount ?: 0) > 0 || ThreadAttention.needsReply(thread),
            isDone = thread.status == ThreadStatus.Completed,
            waitReason = ThreadAttention.dependencyWait(thread),
            asksForAccess = thread.pendingRuntimeRequest?.isAccessRequest == true,
        )
    }

    // Projects

    fun projectSummary(project: ProjectShell, environmentId: String, machineLabel: String, machineOnline: Boolean, threads: List<ThreadSummary>): ProjectSummary {
        val personal = project.isPersonal
        val title = project.displayTitle.trim()
        return ProjectSummary(
            ref = ProjectRef(environmentId, project.id),
            title = title.ifEmpty { if (personal) "Percy" else "Project" },
            icon = icon(project.projectIcon ?: if (personal) ProjectIconOverride.PersonalAssistant else null),
            kind = if (personal) ProjectKind.Personal else ProjectKind.Code,
            machineLabel = machineLabel,
            machineOnline = machineOnline,
            paused = project.isPaused,
            archived = project.isArchived,
            isAutomated = project.isAutomated,
            workingCount = threads.count {
                !it.isUnknown && (it.activity == ThreadActivity.Working || it.activity == ThreadActivity.NeedsYou || it.waitReason != null)
            },
            hasUnread = threads.any { it.isUnread },
        )
    }

    fun icon(icon: ProjectIconOverride?): ProjectIcon = when (icon) {
        is ProjectIconOverride.Lucide -> ProjectIcon.Symbol(icon.name, icon.color)
        is ProjectIconOverride.Emoji -> ProjectIcon.Emoji(icon.emoji)
        is ProjectIconOverride.Monogram -> ProjectIcon.Monogram(icon.text, icon.color)
        else -> ProjectIcon.None
    }

    internal fun oneLine(text: String, limit: Int = 240): String {
        val collapsed = text.lines().map { it.trim() }.filter { it.isNotEmpty() }.joinToString(" ")
        if (collapsed.length <= limit) return collapsed
        return collapsed.take(limit).trim() + "…"
    }
}

/**
 * Places projects as the desktop's sidebar does (`arrangeProjects` in
 * apps/web/src/studio/projectOrder.ts): pinned projects in their saved order, then projects the
 * order has never seen, then the rest in their saved order.
 */
object ProjectOrdering {
    data class Rank(val pinned: Int? = null, val unpinned: Int? = null)

    fun rank(keys: List<String>, members: List<String>, order: SidebarProjectOrder?): Rank {
        if (order == null) return Rank()
        val keySet = keys.toSet()
        val memberSet = members.toSet()
        val pinned = order.pinned.indexOfFirst { key ->
            key in keySet || order.pinnedMembers?.get(key)?.any { it in memberSet } == true
        }.takeIf { it >= 0 }
        val unpinned = order.unpinned.indexOfFirst { it in keySet }.takeIf { it >= 0 }
        return Rank(pinned, unpinned)
    }

    /** Whether the first of two projects in the same part comes first; null when the order does not tell them apart. */
    fun precedes(a: Rank?, b: Rank?, pinned: Boolean): Boolean? {
        val first = if (pinned) a?.pinned else a?.unpinned
        val second = if (pinned) b?.pinned else b?.unpinned
        return when {
            first != null && second != null -> if (first == second) null else first < second
            first == null && second != null -> !pinned
            first != null && second == null -> pinned
            else -> null
        }
    }
}

/** Matches projects against the sidebar order the web app saves in server settings. */
object ProjectPinning {
    fun isPinned(project: ProjectShell, environmentId: String, orders: List<SidebarProjectOrder>): Boolean {
        if (orders.isEmpty()) return false
        val keys = projectKeys(project, environmentId).toSet()
        val member = "$environmentId:${project.id}"
        return orders.any { order ->
            order.pinned.any { key -> key in keys || order.pinnedMembers?.get(key)?.contains(member) == true }
        }
    }

    /** Every key the web app may have saved for this project. A linked project has only its logical key. */
    fun projectKeys(project: ProjectShell, environmentId: String): List<String> {
        project.workspaceSettings?.logicalProject?.let { return listOf("logical-project:${it.id}") }
        val keys = mutableListOf<String>()
        val root = normalizePath(project.workspaceRoot)
        keys += "$environmentId:$root"
        val identity = project.repositoryIdentity ?: return keys
        val canonical = identity.canonicalKey
        keys += canonical
        if (identity.groupingKey != canonical) keys += identity.groupingKey
        val rootPath = identity.rootPath?.let(::normalizePath)
        if (!rootPath.isNullOrEmpty() && root.isNotEmpty()) {
            val separator = if (rootPath.contains('\\')) "\\" else "/"
            if (root != rootPath && root.startsWith(rootPath + separator)) {
                val relative = root.drop(rootPath.length + 1).replace('\\', '/')
                keys += "$canonical::$relative"
                if (identity.groupingKey != canonical) keys += "${identity.groupingKey}::$relative"
            }
        }
        return keys
    }

    /** Trims whitespace and trailing separators; Windows paths compare lowercased. */
    fun normalizePath(value: String): String {
        var path = value.trim()
        val isRoot = path == "/" || path == "\\" || (path.length == 3 && path[1] == ':' && (path.endsWith("/") || path.endsWith("\\")))
        if (path.isNotEmpty() && !isRoot) {
            val separators = if (path.startsWith("/")) setOf('/') else setOf('/', '\\')
            val trimmed = path.trimEnd { it in separators }
            if (trimmed.isNotEmpty()) path = if (trimmed.length == 2 && trimmed.endsWith(":")) "$trimmed\\" else trimmed
        }
        val windowsDrive = path.length >= 2 && path[0].isLetter() && path[1] == ':'
        if (windowsDrive || path.startsWith("\\\\")) return path.replace('/', '\\').lowercase()
        return path
    }
}

/** Which thread a project's or Aide's chat shows. */
object CoordinatorRouting {
    sealed interface Resolution {
        data class Known(val threadId: String) : Resolution

        /** No thread is stored yet: `projects.coordinatorStart` creates it. */
        data class NeedsStart(val fallback: String) : Resolution
    }

    fun resolve(project: ProjectShell): Resolution {
        val id = project.workspaceSettings?.coordinatorThreadId
        if (!id.isNullOrEmpty()) return Resolution.Known(id)
        return Resolution.NeedsStart(ProjectShell.defaultCoordinatorThreadId(project.id))
    }
}
