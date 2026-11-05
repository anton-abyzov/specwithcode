package com.specwithcode.wire

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.serializer
import java.time.Instant

// Thread rows and the thread record.

object LenientLinkedPullRequest : LenientSerializer<LinkedPullRequest>(LinkedPullRequest.serializer())
object LenientJsonList : LenientSerializer<List<JsonElement>>(serializer())
object LenientThreadOrigin : LenientSerializer<ThreadOriginSummary>(ThreadOriginSummary.serializer())
object LenientActiveWork : LenientSerializer<ActiveWork>(ActiveWork.serializer())
object LenientPlanProgress : LenientSerializer<ThreadPlanProgress>(ThreadPlanProgress.serializer())
object LenientProviderGoal : LenientSerializer<ProviderGoal>(ProviderGoal.serializer())
object LenientTitleRegeneration : LenientSerializer<TitleRegeneration>(TitleRegeneration.serializer())
object LenientRollbackFailure : LenientSerializer<RollbackFailure>(RollbackFailure.serializer())
object LenientExecutionState : LenientSerializer<ExecutionState>(ExecutionState.serializer())
object LenientThreadMoveLink : LenientSerializer<ThreadMoveLink>(ThreadMoveLink.serializer())
object LossyBackgroundTasks : LossyListSerializer<PendingBackgroundTask>(PendingBackgroundTask.serializer())

/** A thread as the shell stream sends it: enough for lists, badges and routing. */
@Serializable
data class ThreadShell(
    val createdBy: ActorKind = ActorKind.User,
    val creationSource: CreationSource = CreationSource.Web,
    val id: String,
    val projectId: String,
    val title: String = "",
    val providerInstanceId: String,
    val modelSelection: ModelSelection,
    val modelIdentity: ThreadModelIdentity? = null,
    val runtimeMode: RuntimeMode,
    val interactionMode: InteractionMode = InteractionMode.Default,
    val branch: String? = null,
    val worktreePath: String? = null,
    @Serializable(with = LenientLinkedPullRequest::class) val linkedPullRequest: LinkedPullRequest? = null,
    /** Pull request links with their snapshots, kept raw. */
    @Serializable(with = LenientJsonList::class) val pullRequests: List<JsonElement>? = null,
    @Serializable(with = LenientLinkedPullRequest::class) val branchPullRequest: LinkedPullRequest? = null,
    val lineage: ThreadLineage,
    /** Where the thread was forked from, kept raw. */
    val forkedFrom: JsonElement? = null,
    val activeProviderThreadId: String? = null,
    val historyOrigin: String? = null,
    /** Where the thread came from; holds the ceiling it brought from another machine. */
    @Serializable(with = LenientThreadOrigin::class) val origin: ThreadOriginSummary? = null,
    val latestRunId: String? = null,
    val latestRunRequestedAt: WireInstant? = null,
    val latestRunStartedAt: WireInstant? = null,
    val latestRunCompletedAt: WireInstant? = null,
    val activeRunId: String? = null,
    /** When the work of the activity-owning run started. */
    val activityRunStartedAt: WireInstant? = null,
    val activityRunStatus: RunStatus? = null,
    /** The active run's newest unfinished command, tool or subagent. */
    @Serializable(with = LenientActiveWork::class) val activeWork: ActiveWork? = null,
    val status: ThreadStatus,
    val lastError: String? = null,
    val lastErrorClass: ProviderFailureClass? = null,
    /** Free-form ISO string. */
    val usageLimitResetAt: String? = null,
    val pendingRuntimeRequest: PendingRuntimeRequestSummary? = null,
    val latestVisibleMessage: LatestVisibleMessageSummary? = null,
    val latestUserMessageAt: WireInstant? = null,
    val latestUserAuthoredMessageAt: WireInstant? = null,
    val hasActionableProposedPlan: Boolean = false,
    @Serializable(with = LenientPlanProgress::class) val planProgress: ThreadPlanProgress? = null,
    val reportedBlocker: String? = null,
    @Serializable(with = LenientString::class) val reportedWait: String? = null,
    @Serializable(with = LossyBackgroundTasks::class) val pendingBackgroundTasks: List<PendingBackgroundTask> = emptyList(),
    @Serializable(with = LossyStringList::class) val providerInstanceHistory: List<String> = emptyList(),
    @Serializable(with = LenientProviderGoal::class) val goal: ProviderGoal? = null,
    val heldQueuedCount: Int? = null,
    val itemCount: Int = 0,
    val visibleItemCount: Int = 0,
    val createdAt: WireInstant,
    val updatedAt: WireInstant,
    val archivedAt: WireInstant? = null,
    val settledOverride: SettledOverride? = null,
    val settledAt: WireInstant? = null,
    val unsettledAt: WireInstant? = null,
    val snoozedUntil: WireInstant? = null,
    val snoozedAt: WireInstant? = null,
    /** Usage-limit recovery choices, kept raw. */
    val limitRecovery: JsonElement? = null,
    val pinnedAt: WireInstant? = null,
    val autoSettleDisabledAt: WireInstant? = null,
    val pinOrderKey: String? = null,
    val activeOrderKey: String? = null,
    /** Absent on servers without visited tracking. */
    val lastVisitedAt: WireInstant? = null,
    @Serializable(with = LenientTitleRegeneration::class) val titleRegeneration: TitleRegeneration? = null,
    val deletedAt: WireInstant? = null,
    /** The machine the thread lives on. Absent on servers without handoff mode. */
    @Serializable(with = LenientString::class) val ownerMachineId: String? = null,
    /** The machine it runs on now; the owner unless it was handed off. */
    @Serializable(with = LenientString::class) val executionMachineId: String? = null,
    @Serializable(with = LenientString::class) val executionMachineLabel: String? = null,
    @Serializable(with = LenientExecutionState::class) val executionState: ExecutionState? = null,
    /** When the execution machine last answered; set with [ExecutionState.Unknown]. */
    @Serializable(with = LenientInstant::class) val executionLastSeenAt: Instant? = null,
    /** Set on a copy that continued elsewhere (handoff) or moved to another project. */
    @Serializable(with = LenientThreadMoveLink::class) val movedTo: ThreadMoveLink? = null,
) {
    val isPinned: Boolean get() = pinnedAt != null
    val isArchived: Boolean get() = archivedAt != null

    /** Resolved by the user or the settlement sweep, and not reopened. */
    val isSettled: Boolean
        get() = when (settledOverride) {
            SettledOverride.Settled -> true
            SettledOverride.Active -> false
            else -> settledAt != null
        }

    /** A run in flight or a request waiting on the user. */
    val isWorking: Boolean get() = status.isWorking || pendingRuntimeRequest != null

    /** The latest run finished after the last visit. A missing visit counts as read. */
    val isUnread: Boolean
        get() {
            val completed = latestRunCompletedAt ?: return false
            val visited = lastVisitedAt ?: return false
            return completed > visited
        }

    /** A spawned subagent's thread rather than one the user started. */
    val isSubagent: Boolean get() = lineage.relationshipToParent == LineageRelationship.Subagent

    /** True for a coordinator thread with the default `project-coordinator:` id. */
    val isCoordinatorThread: Boolean get() = id.startsWith("project-coordinator:")
}

/** The thread record carried by `thread.*` events and `ThreadProjection.thread`. */
@Serializable
data class AppThread(
    val createdBy: ActorKind = ActorKind.User,
    val creationSource: CreationSource = CreationSource.Web,
    val id: String,
    val projectId: String,
    val title: String = "",
    val providerInstanceId: String,
    val modelSelection: ModelSelection,
    val runtimeMode: RuntimeMode,
    val interactionMode: InteractionMode = InteractionMode.Default,
    val branch: String? = null,
    val worktreePath: String? = null,
    @Serializable(with = LenientLinkedPullRequest::class) val linkedPullRequest: LinkedPullRequest? = null,
    @Serializable(with = LenientJsonList::class) val pullRequests: List<JsonElement>? = null,
    @Serializable(with = LenientLinkedPullRequest::class) val branchPullRequest: LinkedPullRequest? = null,
    val activeProviderThreadId: String? = null,
    val historyOrigin: String? = null,
    val lineage: ThreadLineage,
    val forkedFrom: JsonElement? = null,
    val createdAt: WireInstant,
    val updatedAt: WireInstant,
    val archivedAt: WireInstant? = null,
    val settledOverride: SettledOverride? = null,
    val settledAt: WireInstant? = null,
    /** Why the thread was resolved. */
    val settledNote: String? = null,
    val unsettledAt: WireInstant? = null,
    val snoozedUntil: WireInstant? = null,
    val snoozedAt: WireInstant? = null,
    val limitRecovery: JsonElement? = null,
    val pinnedAt: WireInstant? = null,
    val autoSettleDisabledAt: WireInstant? = null,
    val pinOrderKey: String? = null,
    val activeOrderKey: String? = null,
    val lastVisitedAt: WireInstant? = null,
    @Serializable(with = LenientTitleRegeneration::class) val titleRegeneration: TitleRegeneration? = null,
    val rollbackRequestId: String? = null,
    @Serializable(with = LenientRollbackFailure::class) val rollbackFailure: RollbackFailure? = null,
    val deletedAt: WireInstant? = null,
    val movedTo: ThreadMoveLink? = null,
) {
    val isPinned: Boolean get() = pinnedAt != null
    val isArchived: Boolean get() = archivedAt != null

    val isSettled: Boolean
        get() = when (settledOverride) {
            SettledOverride.Settled -> true
            SettledOverride.Active -> false
            else -> settledAt != null
        }
}

/** Whether the machine a thread runs on is answering for it. */
@Serializable
enum class ExecutionState {
    /** The execution machine holds the lease; the thread may be idle between turns. */
    @SerialName("running") Running,

    /** This copy was handed off and takes no new turns. */
    @SerialName("fenced") Fenced,

    /** The execution machine is unreachable; never read it as idle. */
    @SerialName("unknown") Unknown,
}

/** Where a thread went: another project, or another machine through handoff. */
@Serializable
data class ThreadMoveLink(
    val threadId: String,
    val projectId: String,
    /** "handoff" or "project"; absent on a project move from older servers. */
    val kind: String? = null,
    /** The machine that continued it; absent when it is the same machine. */
    val environmentId: String? = null,
    val machineLabel: String? = null,
) {
    val isHandoff: Boolean get() = kind == "handoff"
}

@Serializable
data class ThreadLineage(
    val parentThreadId: String? = null,
    val relationshipToParent: LineageRelationship? = null,
    val rootThreadId: String,
)

@Serializable
data class LinkedPullRequest(val projectId: String, val repository: String, val number: Int, val url: String)

object LenientPendingAccess : LenientSerializer<PendingAccessSummary>(PendingAccessSummary.serializer())

@Serializable
data class PendingRuntimeRequestSummary(
    val id: String,
    val kind: RuntimeRequestKind,
    val createdAt: WireInstant,
    /** What an access request card asks for. Older servers leave it out; a summary this build cannot read is dropped. */
    @Serializable(with = LenientPendingAccess::class) val access: PendingAccessSummary? = null,
) {
    /** The pending request is an access request card waiting for an answer. */
    val isAccessRequest: Boolean
        get() = access != null || (kind == RuntimeRequestKind.Permission && id.startsWith("turn-item:access-request:"))
}

@Serializable
data class LatestVisibleMessageSummary(val id: String, val role: MessageRole, val text: String, val updatedAt: WireInstant)

/** A todo-list summary for rows: "3/5", the current step and the next. */
@Serializable
data class ThreadPlanProgress(val completed: Int, val total: Int, val current: String? = null, val next: String? = null)

@Serializable
data class ActiveWork(
    val label: String,
    val startedAt: WireInstant,
    /** The thread a wait is on. */
    val waitThreadId: String? = null,
)

/**
 * Provider background work that can outlive the turn, such as a dev server or a subagent.
 * Rosters without a kind load as `background_task`.
 */
@Serializable
data class PendingBackgroundTask(
    val taskId: String,
    val description: String? = null,
    val kind: BackgroundTaskKind = BackgroundTaskKind.BackgroundTask,
    /** For `subagent`: the subagent's own thread. */
    val childThreadId: String? = null,
    /** For `workflow`: the current phase. */
    val progress: String? = null,
) {
    val id: String get() = taskId
}

/** A goal set with `/goal` on the provider thread. */
@Serializable
data class ProviderGoal(
    val objective: String,
    /** `active`, `paused`, `blocked`, `usage_limited`, `budget_limited` or `complete`. */
    val status: String,
    val tokensUsed: Int? = null,
    val tokenBudget: Int? = null,
    val timeUsedSeconds: Int? = null,
    val checks: Int? = null,
    val lastCheck: String? = null,
)

/** A title regeneration in flight; cleared when the new title lands. */
@Serializable
data class TitleRegeneration(val requestId: String, val startedAt: WireInstant)

@Serializable
data class RollbackFailure(val requestId: String, val message: String)

/** Optional on older servers; current identity is authoritative when available. */
@Serializable
data class ThreadModelIdentity(
    val current: ModelSelection,
    val preferred: ModelSelection? = null,
    val kind: String? = null,
)
