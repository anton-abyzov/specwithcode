import Foundation

// Thread rows and the thread record. `DateTimeUtc` fields are `Date`, so decode
// these with `WireCoding.decoder` (or `JSONValue.decode`).

/// A thread as the shell stream sends it: enough for lists, badges and routing.
public struct ThreadShell: Codable, Hashable, Sendable, Identifiable {
  public var createdBy: ActorKind
  public var creationSource: CreationSource
  public var id: String
  public var projectId: String
  public var title: String
  public var providerInstanceId: String
  public var modelSelection: ModelSelection
  public var modelIdentity: ThreadModelIdentity?
  public var runtimeMode: RuntimeMode
  public var interactionMode: InteractionMode
  public var branch: String?
  public var worktreePath: String?
  public var linkedPullRequest: LinkedPullRequest?
  /// Pull request links with their snapshots, kept raw.
  public var pullRequests: [JSONValue]?
  public var branchPullRequest: LinkedPullRequest?
  public var lineage: ThreadLineage
  /// Where the thread was forked from, kept raw.
  public var forkedFrom: JSONValue?
  public var activeProviderThreadId: String?
  public var historyOrigin: String?
  public var latestRunId: String?
  public var latestRunRequestedAt: Date?
  public var latestRunStartedAt: Date?
  public var latestRunCompletedAt: Date?
  public var activeRunId: String?
  /// When the work of the activity-owning run started.
  public var activityRunStartedAt: Date?
  public var activityRunStatus: RunStatus?
  /// The active run's newest unfinished command, tool or subagent.
  public var activeWork: ActiveWork?
  public var status: ThreadStatus
  public var lastError: String?
  public var lastErrorClass: ProviderFailureClass?
  /// Free-form ISO string.
  public var usageLimitResetAt: String?
  public var pendingRuntimeRequest: PendingRuntimeRequestSummary?
  public var latestVisibleMessage: LatestVisibleMessageSummary?
  public var latestUserMessageAt: Date?
  public var latestUserAuthoredMessageAt: Date?
  public var hasActionableProposedPlan: Bool
  public var planProgress: ThreadPlanProgress?
  public var reportedBlocker: String?
  public var pendingBackgroundTasks: [PendingBackgroundTask]
  public var providerInstanceHistory: [String]
  public var goal: ProviderGoal?
  public var heldQueuedCount: Int?
  public var itemCount: Int
  public var visibleItemCount: Int
  public var createdAt: Date
  public var updatedAt: Date
  public var archivedAt: Date?
  public var settledOverride: SettledOverride?
  public var settledAt: Date?
  public var unsettledAt: Date?
  public var snoozedUntil: Date?
  public var snoozedAt: Date?
  /// Usage-limit recovery choices, kept raw.
  public var limitRecovery: JSONValue?
  public var pinnedAt: Date?
  public var autoSettleDisabledAt: Date?
  public var pinOrderKey: String?
  public var activeOrderKey: String?
  /// Absent on servers without visited tracking.
  public var lastVisitedAt: Date?
  public var titleRegeneration: TitleRegeneration?
  public var deletedAt: Date?
  /// The machine the thread lives on. Absent on servers without handoff mode.
  public var ownerMachineId: String?
  /// The machine it runs on now; the owner unless it was handed off.
  public var executionMachineId: String?
  public var executionMachineLabel: String?
  public var executionState: ExecutionState?
  /// When the execution machine last answered; set with `.unknown`.
  public var executionLastSeenAt: Date?
  /// Set on a copy that continued elsewhere (handoff) or moved to another project.
  public var movedTo: ThreadMoveLink?

  enum CodingKeys: String, CodingKey {
    case createdBy, creationSource, id, projectId, title, providerInstanceId, modelSelection, modelIdentity, runtimeMode, interactionMode
    case branch, worktreePath, linkedPullRequest, pullRequests, branchPullRequest, lineage, forkedFrom
    case activeProviderThreadId, historyOrigin, latestRunId, latestRunRequestedAt, latestRunStartedAt, latestRunCompletedAt
    case activeRunId, activityRunStartedAt, activityRunStatus, activeWork, status, lastError, lastErrorClass, usageLimitResetAt
    case pendingRuntimeRequest, latestVisibleMessage, latestUserMessageAt, latestUserAuthoredMessageAt, hasActionableProposedPlan
    case planProgress, reportedBlocker, pendingBackgroundTasks, providerInstanceHistory, goal, heldQueuedCount
    case itemCount, visibleItemCount, createdAt, updatedAt, archivedAt, settledOverride, settledAt, unsettledAt
    case snoozedUntil, snoozedAt, limitRecovery, pinnedAt, autoSettleDisabledAt, pinOrderKey, activeOrderKey
    case lastVisitedAt, titleRegeneration, deletedAt
    case ownerMachineId, executionMachineId, executionMachineLabel, executionState, executionLastSeenAt, movedTo
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    createdBy = try c.decodeIfPresent(ActorKind.self, forKey: .createdBy) ?? .user
    creationSource = try c.decodeIfPresent(CreationSource.self, forKey: .creationSource) ?? .web
    id = try c.decode(String.self, forKey: .id)
    projectId = try c.decode(String.self, forKey: .projectId)
    title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
    providerInstanceId = try c.decode(String.self, forKey: .providerInstanceId)
    modelSelection = try c.decode(ModelSelection.self, forKey: .modelSelection)
    modelIdentity = try c.decodeIfPresent(ThreadModelIdentity.self, forKey: .modelIdentity)
    runtimeMode = try c.decode(RuntimeMode.self, forKey: .runtimeMode)
    interactionMode = try c.decodeIfPresent(InteractionMode.self, forKey: .interactionMode) ?? .default
    branch = try c.decodeIfPresent(String.self, forKey: .branch)
    worktreePath = try c.decodeIfPresent(String.self, forKey: .worktreePath)
    linkedPullRequest = try? c.decodeIfPresent(LinkedPullRequest.self, forKey: .linkedPullRequest)
    pullRequests = try? c.decodeIfPresent([JSONValue].self, forKey: .pullRequests)
    branchPullRequest = try? c.decodeIfPresent(LinkedPullRequest.self, forKey: .branchPullRequest)
    lineage = try c.decode(ThreadLineage.self, forKey: .lineage)
    forkedFrom = try c.decodeIfPresent(JSONValue.self, forKey: .forkedFrom).flatMap { $0.isNull ? nil : $0 }
    activeProviderThreadId = try c.decodeIfPresent(String.self, forKey: .activeProviderThreadId)
    historyOrigin = try c.decodeIfPresent(String.self, forKey: .historyOrigin)
    latestRunId = try c.decodeIfPresent(String.self, forKey: .latestRunId)
    latestRunRequestedAt = try c.decodeIfPresent(Date.self, forKey: .latestRunRequestedAt)
    latestRunStartedAt = try c.decodeIfPresent(Date.self, forKey: .latestRunStartedAt)
    latestRunCompletedAt = try c.decodeIfPresent(Date.self, forKey: .latestRunCompletedAt)
    activeRunId = try c.decodeIfPresent(String.self, forKey: .activeRunId)
    activityRunStartedAt = try c.decodeIfPresent(Date.self, forKey: .activityRunStartedAt)
    activityRunStatus = try c.decodeIfPresent(RunStatus.self, forKey: .activityRunStatus)
    activeWork = try? c.decodeIfPresent(ActiveWork.self, forKey: .activeWork)
    status = try c.decode(ThreadStatus.self, forKey: .status)
    lastError = try c.decodeIfPresent(String.self, forKey: .lastError)
    lastErrorClass = try c.decodeIfPresent(ProviderFailureClass.self, forKey: .lastErrorClass)
    usageLimitResetAt = try c.decodeIfPresent(String.self, forKey: .usageLimitResetAt)
    pendingRuntimeRequest = try c.decodeIfPresent(PendingRuntimeRequestSummary.self, forKey: .pendingRuntimeRequest)
    latestVisibleMessage = try c.decodeIfPresent(LatestVisibleMessageSummary.self, forKey: .latestVisibleMessage)
    latestUserMessageAt = try c.decodeIfPresent(Date.self, forKey: .latestUserMessageAt)
    latestUserAuthoredMessageAt = try c.decodeIfPresent(Date.self, forKey: .latestUserAuthoredMessageAt)
    hasActionableProposedPlan = try c.decodeIfPresent(Bool.self, forKey: .hasActionableProposedPlan) ?? false
    planProgress = try? c.decodeIfPresent(ThreadPlanProgress.self, forKey: .planProgress)
    reportedBlocker = try c.decodeIfPresent(String.self, forKey: .reportedBlocker)
    pendingBackgroundTasks = try c.decodeLossyArray(PendingBackgroundTask.self, forKey: .pendingBackgroundTasks)
    providerInstanceHistory = try c.decodeLossyArray(String.self, forKey: .providerInstanceHistory)
    goal = try? c.decodeIfPresent(ProviderGoal.self, forKey: .goal)
    heldQueuedCount = try c.decodeIfPresent(Int.self, forKey: .heldQueuedCount)
    itemCount = try c.decodeIfPresent(Int.self, forKey: .itemCount) ?? 0
    visibleItemCount = try c.decodeIfPresent(Int.self, forKey: .visibleItemCount) ?? 0
    createdAt = try c.decode(Date.self, forKey: .createdAt)
    updatedAt = try c.decode(Date.self, forKey: .updatedAt)
    archivedAt = try c.decodeIfPresent(Date.self, forKey: .archivedAt)
    settledOverride = try c.decodeIfPresent(SettledOverride.self, forKey: .settledOverride)
    settledAt = try c.decodeIfPresent(Date.self, forKey: .settledAt)
    unsettledAt = try c.decodeIfPresent(Date.self, forKey: .unsettledAt)
    snoozedUntil = try c.decodeIfPresent(Date.self, forKey: .snoozedUntil)
    snoozedAt = try c.decodeIfPresent(Date.self, forKey: .snoozedAt)
    limitRecovery = try c.decodeIfPresent(JSONValue.self, forKey: .limitRecovery).flatMap { $0.isNull ? nil : $0 }
    pinnedAt = try c.decodeIfPresent(Date.self, forKey: .pinnedAt)
    autoSettleDisabledAt = try c.decodeIfPresent(Date.self, forKey: .autoSettleDisabledAt)
    pinOrderKey = try c.decodeIfPresent(String.self, forKey: .pinOrderKey)
    activeOrderKey = try c.decodeIfPresent(String.self, forKey: .activeOrderKey)
    lastVisitedAt = try c.decodeIfPresent(Date.self, forKey: .lastVisitedAt)
    titleRegeneration = try? c.decodeIfPresent(TitleRegeneration.self, forKey: .titleRegeneration)
    deletedAt = try c.decodeIfPresent(Date.self, forKey: .deletedAt)
    ownerMachineId = try? c.decodeIfPresent(String.self, forKey: .ownerMachineId)
    executionMachineId = try? c.decodeIfPresent(String.self, forKey: .executionMachineId)
    executionMachineLabel = try? c.decodeIfPresent(String.self, forKey: .executionMachineLabel)
    executionState = try? c.decodeIfPresent(ExecutionState.self, forKey: .executionState)
    executionLastSeenAt = (try? c.decodeIfPresent(Date.self, forKey: .executionLastSeenAt)) ?? nil
    movedTo = (try? c.decodeIfPresent(ThreadMoveLink.self, forKey: .movedTo)) ?? nil
  }

  public var isPinned: Bool { pinnedAt != nil }
  public var isArchived: Bool { archivedAt != nil }

  /// Resolved by the user or the settlement sweep, and not reopened.
  public var isSettled: Bool {
    if settledOverride == .settled { return true }
    if settledOverride == .active { return false }
    return settledAt != nil
  }

  /// A run in flight or a request waiting on the user.
  public var isWorking: Bool { status.isWorking || pendingRuntimeRequest != nil }

  /// The latest run finished after the last visit. A missing visit counts as read.
  public var isUnread: Bool {
    guard let completed = latestRunCompletedAt, let visited = lastVisitedAt else { return false }
    return completed > visited
  }

  /// A spawned subagent's thread rather than one the user started.
  public var isSubagent: Bool { lineage.relationshipToParent == .subagent }

  /// True for a coordinator thread with the default `project-coordinator:` id.
  public var isCoordinatorThread: Bool { id.hasPrefix("project-coordinator:") }
}

/// The thread record carried by `thread.*` events and `ThreadProjection.thread`.
public struct AppThread: Codable, Hashable, Sendable, Identifiable {
  public var createdBy: ActorKind
  public var creationSource: CreationSource
  public var id: String
  public var projectId: String
  public var title: String
  public var providerInstanceId: String
  public var modelSelection: ModelSelection
  public var runtimeMode: RuntimeMode
  public var interactionMode: InteractionMode
  public var branch: String?
  public var worktreePath: String?
  public var linkedPullRequest: LinkedPullRequest?
  public var pullRequests: [JSONValue]?
  public var branchPullRequest: LinkedPullRequest?
  public var activeProviderThreadId: String?
  public var historyOrigin: String?
  public var lineage: ThreadLineage
  public var forkedFrom: JSONValue?
  public var createdAt: Date
  public var updatedAt: Date
  public var archivedAt: Date?
  public var settledOverride: SettledOverride?
  public var settledAt: Date?
  /// Why the thread was resolved.
  public var settledNote: String?
  public var unsettledAt: Date?
  public var snoozedUntil: Date?
  public var snoozedAt: Date?
  public var limitRecovery: JSONValue?
  public var pinnedAt: Date?
  public var autoSettleDisabledAt: Date?
  public var pinOrderKey: String?
  public var activeOrderKey: String?
  public var lastVisitedAt: Date?
  public var titleRegeneration: TitleRegeneration?
  public var rollbackRequestId: String?
  public var rollbackFailure: RollbackFailure?
  public var deletedAt: Date?
  public var movedTo: ThreadMoveLink?

  enum CodingKeys: String, CodingKey {
    case createdBy, creationSource, id, projectId, title, providerInstanceId, modelSelection, runtimeMode, interactionMode
    case branch, worktreePath, linkedPullRequest, pullRequests, branchPullRequest, activeProviderThreadId, historyOrigin
    case lineage, forkedFrom, createdAt, updatedAt, archivedAt, settledOverride, settledAt, settledNote, unsettledAt
    case snoozedUntil, snoozedAt, limitRecovery, pinnedAt, autoSettleDisabledAt, pinOrderKey, activeOrderKey
    case lastVisitedAt, titleRegeneration, rollbackRequestId, rollbackFailure, deletedAt, movedTo
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    createdBy = try c.decodeIfPresent(ActorKind.self, forKey: .createdBy) ?? .user
    creationSource = try c.decodeIfPresent(CreationSource.self, forKey: .creationSource) ?? .web
    id = try c.decode(String.self, forKey: .id)
    projectId = try c.decode(String.self, forKey: .projectId)
    title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
    providerInstanceId = try c.decode(String.self, forKey: .providerInstanceId)
    modelSelection = try c.decode(ModelSelection.self, forKey: .modelSelection)
    runtimeMode = try c.decode(RuntimeMode.self, forKey: .runtimeMode)
    interactionMode = try c.decodeIfPresent(InteractionMode.self, forKey: .interactionMode) ?? .default
    branch = try c.decodeIfPresent(String.self, forKey: .branch)
    worktreePath = try c.decodeIfPresent(String.self, forKey: .worktreePath)
    linkedPullRequest = try? c.decodeIfPresent(LinkedPullRequest.self, forKey: .linkedPullRequest)
    pullRequests = try? c.decodeIfPresent([JSONValue].self, forKey: .pullRequests)
    branchPullRequest = try? c.decodeIfPresent(LinkedPullRequest.self, forKey: .branchPullRequest)
    activeProviderThreadId = try c.decodeIfPresent(String.self, forKey: .activeProviderThreadId)
    historyOrigin = try c.decodeIfPresent(String.self, forKey: .historyOrigin)
    lineage = try c.decode(ThreadLineage.self, forKey: .lineage)
    forkedFrom = try c.decodeIfPresent(JSONValue.self, forKey: .forkedFrom).flatMap { $0.isNull ? nil : $0 }
    createdAt = try c.decode(Date.self, forKey: .createdAt)
    updatedAt = try c.decode(Date.self, forKey: .updatedAt)
    archivedAt = try c.decodeIfPresent(Date.self, forKey: .archivedAt)
    settledOverride = try c.decodeIfPresent(SettledOverride.self, forKey: .settledOverride)
    settledAt = try c.decodeIfPresent(Date.self, forKey: .settledAt)
    settledNote = try c.decodeIfPresent(String.self, forKey: .settledNote)
    unsettledAt = try c.decodeIfPresent(Date.self, forKey: .unsettledAt)
    snoozedUntil = try c.decodeIfPresent(Date.self, forKey: .snoozedUntil)
    snoozedAt = try c.decodeIfPresent(Date.self, forKey: .snoozedAt)
    limitRecovery = try c.decodeIfPresent(JSONValue.self, forKey: .limitRecovery).flatMap { $0.isNull ? nil : $0 }
    pinnedAt = try c.decodeIfPresent(Date.self, forKey: .pinnedAt)
    autoSettleDisabledAt = try c.decodeIfPresent(Date.self, forKey: .autoSettleDisabledAt)
    pinOrderKey = try c.decodeIfPresent(String.self, forKey: .pinOrderKey)
    activeOrderKey = try c.decodeIfPresent(String.self, forKey: .activeOrderKey)
    lastVisitedAt = try c.decodeIfPresent(Date.self, forKey: .lastVisitedAt)
    titleRegeneration = try? c.decodeIfPresent(TitleRegeneration.self, forKey: .titleRegeneration)
    rollbackRequestId = try c.decodeIfPresent(String.self, forKey: .rollbackRequestId)
    rollbackFailure = try? c.decodeIfPresent(RollbackFailure.self, forKey: .rollbackFailure)
    deletedAt = try c.decodeIfPresent(Date.self, forKey: .deletedAt)
    movedTo = try c.decodeIfPresent(ThreadMoveLink.self, forKey: .movedTo)
  }

  public var isPinned: Bool { pinnedAt != nil }
  public var isArchived: Bool { archivedAt != nil }

  public var isSettled: Bool {
    if settledOverride == .settled { return true }
    if settledOverride == .active { return false }
    return settledAt != nil
  }
}

/// Whether the machine a thread runs on is answering for it.
public enum ExecutionState: String, Codable, Hashable, Sendable {
  /// The execution machine holds the lease; the thread may be idle between turns.
  case running
  /// This copy was handed off and takes no new turns.
  case fenced
  /// The execution machine is unreachable; never read it as idle.
  case unknown
}

/// Where a thread went: another project, or another machine through handoff.
public struct ThreadMoveLink: Codable, Hashable, Sendable {
  public var threadId: String
  public var projectId: String
  /// "handoff" or "project"; absent on a project move from older servers.
  public var kind: String?
  /// The machine that continued it; absent when it is the same machine.
  public var environmentId: String?
  public var machineLabel: String?

  public init(threadId: String, projectId: String, kind: String? = nil, environmentId: String? = nil, machineLabel: String? = nil) {
    self.threadId = threadId
    self.projectId = projectId
    self.kind = kind
    self.environmentId = environmentId
    self.machineLabel = machineLabel
  }

  public var isHandoff: Bool { kind == "handoff" }
}

public struct ThreadLineage: Codable, Hashable, Sendable {
  public var parentThreadId: String?
  public var relationshipToParent: LineageRelationship?
  public var rootThreadId: String

  public init(parentThreadId: String? = nil, relationshipToParent: LineageRelationship? = nil, rootThreadId: String) {
    self.parentThreadId = parentThreadId
    self.relationshipToParent = relationshipToParent
    self.rootThreadId = rootThreadId
  }
}

public struct LinkedPullRequest: Codable, Hashable, Sendable {
  public var projectId: String
  public var repository: String
  public var number: Int
  public var url: String

  public init(projectId: String, repository: String, number: Int, url: String) {
    self.projectId = projectId
    self.repository = repository
    self.number = number
    self.url = url
  }
}

public struct PendingRuntimeRequestSummary: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var kind: RuntimeRequestKind
  public var createdAt: Date

  public init(id: String, kind: RuntimeRequestKind, createdAt: Date) {
    self.id = id
    self.kind = kind
    self.createdAt = createdAt
  }
}

public struct LatestVisibleMessageSummary: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var role: MessageRole
  public var text: String
  public var updatedAt: Date

  public init(id: String, role: MessageRole, text: String, updatedAt: Date) {
    self.id = id
    self.role = role
    self.text = text
    self.updatedAt = updatedAt
  }
}

/// A todo-list summary for rows: "3/5", the current step and the next.
public struct ThreadPlanProgress: Codable, Hashable, Sendable {
  public var completed: Int
  public var total: Int
  public var current: String?
  public var next: String?

  public init(completed: Int, total: Int, current: String? = nil, next: String? = nil) {
    self.completed = completed
    self.total = total
    self.current = current
    self.next = next
  }
}

public struct ActiveWork: Codable, Hashable, Sendable {
  public var label: String
  public var startedAt: Date
  /// The thread a wait is on.
  public var waitThreadId: String?

  public init(label: String, startedAt: Date, waitThreadId: String? = nil) {
    self.label = label
    self.startedAt = startedAt
    self.waitThreadId = waitThreadId
  }
}

/// Provider background work that can outlive the turn, such as a dev server or a subagent.
/// Rosters without a kind load as `background_task`.
public struct PendingBackgroundTask: Codable, Hashable, Sendable, Identifiable {
  public var id: String { taskId }
  public var taskId: String
  public var description: String?
  public var kind: BackgroundTaskKind
  /// For `subagent`: the subagent's own thread.
  public var childThreadId: String?
  /// For `workflow`: the current phase.
  public var progress: String?

  public init(taskId: String, description: String? = nil, kind: BackgroundTaskKind = .backgroundTask, childThreadId: String? = nil, progress: String? = nil) {
    self.taskId = taskId
    self.description = description
    self.kind = kind
    self.childThreadId = childThreadId
    self.progress = progress
  }

  enum CodingKeys: String, CodingKey { case taskId, description, kind, childThreadId, progress }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    taskId = try c.decode(String.self, forKey: .taskId)
    description = try c.decodeIfPresent(String.self, forKey: .description)
    kind = try c.decodeIfPresent(BackgroundTaskKind.self, forKey: .kind) ?? .backgroundTask
    childThreadId = try c.decodeIfPresent(String.self, forKey: .childThreadId)
    progress = try c.decodeIfPresent(String.self, forKey: .progress)
  }
}

/// A goal set with `/goal` on the provider thread.
public struct ProviderGoal: Codable, Hashable, Sendable {
  public var objective: String
  /// `active`, `paused`, `blocked`, `usage_limited`, `budget_limited` or `complete`.
  public var status: String
  public var tokensUsed: Int?
  public var tokenBudget: Int?
  public var timeUsedSeconds: Int?
  public var checks: Int?
  public var lastCheck: String?

  public init(objective: String, status: String, tokensUsed: Int? = nil, tokenBudget: Int? = nil, timeUsedSeconds: Int? = nil, checks: Int? = nil, lastCheck: String? = nil) {
    self.objective = objective
    self.status = status
    self.tokensUsed = tokensUsed
    self.tokenBudget = tokenBudget
    self.timeUsedSeconds = timeUsedSeconds
    self.checks = checks
    self.lastCheck = lastCheck
  }
}

/// A title regeneration in flight; cleared when the new title lands.
public struct TitleRegeneration: Codable, Hashable, Sendable {
  public var requestId: String
  public var startedAt: Date

  public init(requestId: String, startedAt: Date) {
    self.requestId = requestId
    self.startedAt = startedAt
  }
}

public struct RollbackFailure: Codable, Hashable, Sendable {
  public var requestId: String
  public var message: String

  public init(requestId: String, message: String) {
    self.requestId = requestId
    self.message = message
  }
}

/// Optional on older servers; current identity is authoritative when available.
public struct ThreadModelIdentity: Codable, Hashable, Sendable {
  public var current: ModelSelection
  public var preferred: ModelSelection?
  public var kind: String?
}
