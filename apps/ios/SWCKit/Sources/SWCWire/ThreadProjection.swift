import Foundation

/// One prompt and the work it started.
public struct Run: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var threadId: String
  public var ordinal: Int
  public var providerInstanceId: String
  public var modelSelection: ModelSelection
  public var providerThreadId: String?
  public var userMessageId: String
  public var rootNodeId: String?
  public var activeAttemptId: String?
  public var status: RunStatus
  public var queuePosition: Int?
  /// Restart recovery holds the queue until the user resumes it.
  public var queueHeld: Bool?
  public var cancelledForUpdate: Bool?
  public var requestedAt: Date
  public var startedAt: Date?
  public var completedAt: Date?
  public var checkpointId: String?
  public var contextHandoffId: String?
  public var restartContinuationOfRunId: String?
  /// Set on wake runs: when the work they continue started.
  public var workStartedAt: Date?
  public var sourcePlanRef: PlanRef?
  public var workspacePreparation: WorkspaceStrategy?

  enum CodingKeys: String, CodingKey {
    case id, threadId, ordinal, providerInstanceId, modelSelection, providerThreadId, userMessageId, rootNodeId
    case activeAttemptId, status, queuePosition, queueHeld, cancelledForUpdate, requestedAt, startedAt, completedAt
    case checkpointId, contextHandoffId, restartContinuationOfRunId, workStartedAt, sourcePlanRef, workspacePreparation
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    threadId = try c.decode(String.self, forKey: .threadId)
    ordinal = try c.decode(Int.self, forKey: .ordinal)
    providerInstanceId = try c.decode(String.self, forKey: .providerInstanceId)
    modelSelection = try c.decode(ModelSelection.self, forKey: .modelSelection)
    providerThreadId = try c.decodeIfPresent(String.self, forKey: .providerThreadId)
    userMessageId = try c.decode(String.self, forKey: .userMessageId)
    rootNodeId = try c.decodeIfPresent(String.self, forKey: .rootNodeId)
    activeAttemptId = try c.decodeIfPresent(String.self, forKey: .activeAttemptId)
    status = try c.decode(RunStatus.self, forKey: .status)
    queuePosition = try c.decodeIfPresent(Int.self, forKey: .queuePosition)
    queueHeld = try c.decodeIfPresent(Bool.self, forKey: .queueHeld)
    cancelledForUpdate = try c.decodeIfPresent(Bool.self, forKey: .cancelledForUpdate)
    requestedAt = try c.decode(Date.self, forKey: .requestedAt)
    startedAt = try c.decodeIfPresent(Date.self, forKey: .startedAt)
    completedAt = try c.decodeIfPresent(Date.self, forKey: .completedAt)
    checkpointId = try c.decodeIfPresent(String.self, forKey: .checkpointId)
    contextHandoffId = try c.decodeIfPresent(String.self, forKey: .contextHandoffId)
    restartContinuationOfRunId = try c.decodeIfPresent(String.self, forKey: .restartContinuationOfRunId)
    workStartedAt = try c.decodeIfPresent(Date.self, forKey: .workStartedAt)
    sourcePlanRef = try? c.decodeIfPresent(PlanRef.self, forKey: .sourcePlanRef)
    workspacePreparation = try? c.decodeIfPresent(WorkspaceStrategy.self, forKey: .workspacePreparation)
  }

  /// When the work this run belongs to started; a wake counts from the prompt that started it.
  public var workStartDate: Date { workStartedAt ?? startedAt ?? requestedAt }
}

/// A plan in another thread, for runs and messages that carry one out.
public struct PlanRef: Codable, Hashable, Sendable {
  public var threadId: String
  public var planId: String

  public init(threadId: String, planId: String) {
    self.threadId = threadId
    self.planId = planId
  }
}

public struct ConversationMessage: Codable, Hashable, Sendable, Identifiable {
  public var notification: ThreadNotification?
  public var createdBy: ActorKind
  public var creationSource: CreationSource
  public var scheduledTaskId: String?
  /// The sending agent's thread, for messages from another agent.
  public var senderThreadId: String?
  public var id: String
  public var threadId: String
  public var runId: String?
  public var nodeId: String?
  public var role: MessageRole
  public var text: String
  public var context: JSONValue?
  public var attachments: [ChatAttachment]
  public var streaming: Bool
  public var createdAt: Date
  public var updatedAt: Date

  enum CodingKeys: String, CodingKey {
    case notification, createdBy, creationSource, scheduledTaskId, senderThreadId, id, threadId, runId, nodeId
    case role, text, context, attachments, streaming, createdAt, updatedAt
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    notification = try? c.decodeIfPresent(ThreadNotification.self, forKey: .notification)
    createdBy = try c.decodeIfPresent(ActorKind.self, forKey: .createdBy) ?? .user
    creationSource = try c.decodeIfPresent(CreationSource.self, forKey: .creationSource) ?? .web
    scheduledTaskId = try c.decodeIfPresent(String.self, forKey: .scheduledTaskId)
    senderThreadId = try c.decodeIfPresent(String.self, forKey: .senderThreadId)
    id = try c.decode(String.self, forKey: .id)
    threadId = try c.decode(String.self, forKey: .threadId)
    runId = try c.decodeIfPresent(String.self, forKey: .runId)
    nodeId = try c.decodeIfPresent(String.self, forKey: .nodeId)
    role = try c.decode(MessageRole.self, forKey: .role)
    text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
    context = try c.decodeIfPresent(JSONValue.self, forKey: .context)
    attachments = try c.decodeLossyArray(ChatAttachment.self, forKey: .attachments)
    streaming = try c.decodeIfPresent(Bool.self, forKey: .streaming) ?? false
    createdAt = try c.decode(Date.self, forKey: .createdAt)
    updatedAt = try c.decode(Date.self, forKey: .updatedAt)
  }
}

/// A plan the agent proposed or a todo list it keeps.
public struct PlanArtifact: Codable, Hashable, Sendable, Identifiable {
  public enum Content: Hashable, Sendable {
    case proposedPlan(markdown: String)
    case todoList(steps: [PlanStep], explanation: String?)
    case unknown(kind: String, raw: JSONValue)

    public var kind: String {
      switch self {
      case .proposedPlan: "proposed_plan"
      case .todoList: "todo_list"
      case let .unknown(kind, _): kind
      }
    }
  }

  public var id: String
  public var threadId: String
  public var runId: String?
  public var nodeId: String
  public var status: PlanStatus
  /// The full content lives in the matching turn item.
  public var detailInTurnItem: Bool?
  public var content: Content

  public var kind: String { content.kind }

  public init(id: String, threadId: String, runId: String? = nil, nodeId: String, status: PlanStatus, content: Content) {
    self.id = id
    self.threadId = threadId
    self.runId = runId
    self.nodeId = nodeId
    self.status = status
    self.content = content
  }

  enum CodingKeys: String, CodingKey { case id, threadId, runId, nodeId, status, detailInTurnItem, kind, markdown, steps, explanation }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    threadId = try c.decode(String.self, forKey: .threadId)
    runId = try c.decodeIfPresent(String.self, forKey: .runId)
    nodeId = try c.decodeIfPresent(String.self, forKey: .nodeId) ?? ""
    status = try c.decode(PlanStatus.self, forKey: .status)
    detailInTurnItem = try c.decodeIfPresent(Bool.self, forKey: .detailInTurnItem)
    let kind = try c.decode(String.self, forKey: .kind)
    switch kind {
    case "proposed_plan":
      content = .proposedPlan(markdown: try c.decodeIfPresent(String.self, forKey: .markdown) ?? "")
    case "todo_list":
      content = .todoList(steps: try c.decodeArray(PlanStep.self, forKey: .steps), explanation: try c.decodeIfPresent(String.self, forKey: .explanation))
    default:
      content = .unknown(kind: kind, raw: try JSONValue(from: decoder))
    }
  }

  public func encode(to encoder: Encoder) throws {
    if case let .unknown(_, raw) = content {
      try raw.encode(to: encoder)
      return
    }
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(id, forKey: .id)
    try c.encode(threadId, forKey: .threadId)
    try c.encodeIfPresent(runId, forKey: .runId)
    try c.encode(nodeId, forKey: .nodeId)
    try c.encode(status, forKey: .status)
    try c.encodeIfPresent(detailInTurnItem, forKey: .detailInTurnItem)
    try c.encode(kind, forKey: .kind)
    switch content {
    case let .proposedPlan(markdown):
      try c.encode(markdown, forKey: .markdown)
    case let .todoList(steps, explanation):
      try c.encode(steps, forKey: .steps)
      try c.encodeIfPresent(explanation, forKey: .explanation)
    case .unknown:
      break
    }
  }
}

/// An approval, question or tool call the provider waits on.
public struct RuntimeRequest: Codable, Hashable, Sendable, Identifiable {
  /// How a response reaches the provider.
  public enum ResponseCapability: Codable, Hashable, Sendable {
    /// The provider session is live; respond with `runtime-request.respond`.
    case live(providerSessionId: String)
    /// Answer by sending a message.
    case message
    /// The request can no longer be answered.
    case notResumable(reason: String)
    case unknown(JSONValue)

    enum CodingKeys: String, CodingKey { case type, providerSessionId, reason }

    public init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      switch try c.decodeIfPresent(String.self, forKey: .type) {
      case "live": self = .live(providerSessionId: try c.decodeIfPresent(String.self, forKey: .providerSessionId) ?? "")
      case "message": self = .message
      case "not_resumable": self = .notResumable(reason: try c.decodeIfPresent(String.self, forKey: .reason) ?? "")
      default: self = .unknown(try JSONValue(from: decoder))
      }
    }

    public func encode(to encoder: Encoder) throws {
      if case let .unknown(raw) = self {
        try raw.encode(to: encoder)
        return
      }
      var c = encoder.container(keyedBy: CodingKeys.self)
      switch self {
      case let .live(id):
        try c.encode("live", forKey: .type)
        try c.encode(id, forKey: .providerSessionId)
      case .message:
        try c.encode("message", forKey: .type)
      case let .notResumable(reason):
        try c.encode("not_resumable", forKey: .type)
        try c.encode(reason, forKey: .reason)
      case .unknown:
        break
      }
    }

    public var canRespond: Bool {
      if case .live = self { return true }
      return false
    }
  }

  public var id: String
  public var nodeId: String
  public var providerTurnId: String?
  public var nativeRequestRef: JSONValue?
  public var kind: RuntimeRequestKind
  public var status: RuntimeRequestStatus
  public var responseCapability: ResponseCapability
  public var createdAt: Date
  public var resolvedAt: Date?
  public var decision: ProviderApprovalDecision?
  /// Answers by question id: a string or an array of strings.
  public var answers: [String: JSONValue]?

  enum CodingKeys: String, CodingKey {
    case id, nodeId, providerTurnId, nativeRequestRef, kind, status, responseCapability, createdAt, resolvedAt, decision, answers
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    nodeId = try c.decodeIfPresent(String.self, forKey: .nodeId) ?? ""
    providerTurnId = try c.decodeIfPresent(String.self, forKey: .providerTurnId)
    nativeRequestRef = try c.decodeIfPresent(JSONValue.self, forKey: .nativeRequestRef)
    kind = try c.decode(RuntimeRequestKind.self, forKey: .kind)
    status = try c.decode(RuntimeRequestStatus.self, forKey: .status)
    responseCapability = try c.decodeIfPresent(ResponseCapability.self, forKey: .responseCapability) ?? .unknown(.null)
    createdAt = try c.decode(Date.self, forKey: .createdAt)
    resolvedAt = try c.decodeIfPresent(Date.self, forKey: .resolvedAt)
    decision = try c.decodeIfPresent(ProviderApprovalDecision.self, forKey: .decision)
    answers = try c.decodeIfPresent([String: JSONValue].self, forKey: .answers)
  }

  public var isPending: Bool { status == .pending }
}

/// Everything about one thread: `orchestration.getThreadProjection`, the snapshot of
/// `orchestration.subscribeThread`, and `launchThread`'s result.
///
/// The subset the app renders. Attempts, nodes, provider sessions, checkpoints and
/// context transfers are not decoded.
public struct ThreadProjection: Codable, Hashable, Sendable {
  public var thread: AppThread
  public var runs: [Run]
  public var runtimeRequests: [RuntimeRequest]
  public var messages: [ConversationMessage]
  public var plans: [PlanArtifact]
  /// Every item of this thread, including ones a newer server added (`.unknown`).
  public var turnItems: [TurnItem]
  /// The timeline to render, with items inherited from forks.
  public var visibleTurnItems: [ProjectedTurnItem]
  public var updatedAt: Date

  enum CodingKeys: String, CodingKey { case thread, runs, runtimeRequests, messages, plans, turnItems, visibleTurnItems, updatedAt }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    thread = try c.decode(AppThread.self, forKey: .thread)
    runs = try c.decodeArray(Run.self, forKey: .runs)
    runtimeRequests = try c.decodeArray(RuntimeRequest.self, forKey: .runtimeRequests)
    messages = try c.decodeArray(ConversationMessage.self, forKey: .messages)
    plans = try c.decodeArray(PlanArtifact.self, forKey: .plans)
    turnItems = try c.decodeArray(TurnItem.self, forKey: .turnItems)
    visibleTurnItems = try c.decodeArray(ProjectedTurnItem.self, forKey: .visibleTurnItems)
    updatedAt = try c.decodeIfPresent(Date.self, forKey: .updatedAt) ?? thread.updatedAt
  }

  /// The highest-ordinal run.
  public var latestRun: Run? { runs.max { $0.ordinal < $1.ordinal } }

  /// The run holding the thread now, if any.
  public var activeRun: Run? { runs.filter { $0.status.isActive }.max { $0.ordinal < $1.ordinal } }

  public var pendingRuntimeRequests: [RuntimeRequest] { runtimeRequests.filter(\.isPending) }

  public func runtimeRequest(_ id: String) -> RuntimeRequest? { runtimeRequests.first { $0.id == id } }

  /// Visible rows of item types this build renders.
  public var renderableTurnItems: [ProjectedTurnItem] { visibleTurnItems.filter { !$0.item.isUnknown } }
}
