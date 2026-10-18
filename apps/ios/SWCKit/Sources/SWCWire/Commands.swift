import Foundation

// Payloads of `orchestration.dispatchCommand` and `orchestration.launchThread`.
// Optional keys are omitted when nil, never sent as null. Mint `commandId` and
// `messageId` once (a UUID) and reuse them on retry; the server dedupes.

/// A command for `orchestration.dispatchCommand`. Returns `DispatchResult`.
public enum OrchestrationCommand: Codable, Hashable, Sendable {
  case messageDispatch(MessageDispatchCommand)
  case runInterrupt(RunInterruptCommand)
  case runtimeRequestRespond(RuntimeRequestRespondCommand)
  case threadPin(commandId: String, threadId: String, orderKey: String? = nil)
  case threadUnpin(commandId: String, threadId: String)
  /// Resolve a thread, optionally with a one-line closing note.
  case threadSettle(commandId: String, threadId: String, settledAt: Date? = nil, note: String? = nil)
  case threadUnsettle(commandId: String, threadId: String)
  case threadArchive(commandId: String, threadId: String)
  case threadUnarchive(commandId: String, threadId: String)
  case threadDelete(commandId: String, threadId: String)
  /// `visitedAt` is the shell's `updatedAt` the viewer has seen, as an ISO string.
  case threadVisit(commandId: String, threadId: String, visitedAt: String)
  case threadMarkUnread(commandId: String, threadId: String)
  case threadMetadataUpdate(ThreadMetadataUpdateCommand)
  /// Any other command, sent as is.
  case other(JSONValue)

  enum CodingKeys: String, CodingKey { case type, commandId, threadId, orderKey, settledAt, note, reason, visitedAt }

  public var type: String {
    switch self {
    case .messageDispatch: "message.dispatch"
    case .runInterrupt: "run.interrupt"
    case .runtimeRequestRespond: "runtime-request.respond"
    case .threadPin: "thread.pin"
    case .threadUnpin: "thread.unpin"
    case .threadSettle: "thread.settle"
    case .threadUnsettle: "thread.unsettle"
    case .threadArchive: "thread.archive"
    case .threadUnarchive: "thread.unarchive"
    case .threadDelete: "thread.delete"
    case .threadVisit: "thread.visit"
    case .threadMarkUnread: "thread.mark-unread"
    case .threadMetadataUpdate: "thread.metadata.update"
    case let .other(raw): raw["type"]?.stringValue ?? ""
    }
  }

  public var commandId: String {
    switch self {
    case let .messageDispatch(v): v.commandId
    case let .runInterrupt(v): v.commandId
    case let .runtimeRequestRespond(v): v.commandId
    case let .threadMetadataUpdate(v): v.commandId
    case let .threadPin(id, _, _), let .threadSettle(id, _, _, _), let .threadVisit(id, _, _): id
    case let .threadUnpin(id, _), let .threadUnsettle(id, _), let .threadArchive(id, _), let .threadUnarchive(id, _),
         let .threadDelete(id, _), let .threadMarkUnread(id, _): id
    case let .other(raw): raw["commandId"]?.stringValue ?? ""
    }
  }

  public var threadId: String {
    switch self {
    case let .messageDispatch(v): v.threadId
    case let .runInterrupt(v): v.threadId
    case let .runtimeRequestRespond(v): v.threadId
    case let .threadMetadataUpdate(v): v.threadId
    case let .threadPin(_, id, _), let .threadSettle(_, id, _, _), let .threadVisit(_, id, _): id
    case let .threadUnpin(_, id), let .threadUnsettle(_, id), let .threadArchive(_, id), let .threadUnarchive(_, id),
         let .threadDelete(_, id), let .threadMarkUnread(_, id): id
    case let .other(raw): raw["threadId"]?.stringValue ?? ""
    }
  }

  /// `thread.visit` with a date, formatted like the server's ISO strings.
  public static func visit(commandId: String, threadId: String, at visitedAt: Date) -> OrchestrationCommand {
    .threadVisit(commandId: commandId, threadId: threadId, visitedAt: WireCoding.formatDate(visitedAt))
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    let type = try c.decodeIfPresent(String.self, forKey: .type) ?? ""
    func ids() throws -> (String, String) {
      (try c.decode(String.self, forKey: .commandId), try c.decode(String.self, forKey: .threadId))
    }
    switch type {
    case "message.dispatch": self = .messageDispatch(try MessageDispatchCommand(from: decoder))
    case "run.interrupt": self = .runInterrupt(try RunInterruptCommand(from: decoder))
    case "runtime-request.respond": self = .runtimeRequestRespond(try RuntimeRequestRespondCommand(from: decoder))
    case "thread.metadata.update": self = .threadMetadataUpdate(try ThreadMetadataUpdateCommand(from: decoder))
    case "thread.pin":
      let (cid, tid) = try ids()
      self = .threadPin(commandId: cid, threadId: tid, orderKey: try c.decodeIfPresent(String.self, forKey: .orderKey))
    case "thread.settle":
      let (cid, tid) = try ids()
      self = .threadSettle(commandId: cid, threadId: tid, settledAt: try c.decodeIfPresent(Date.self, forKey: .settledAt), note: try c.decodeIfPresent(String.self, forKey: .note))
    case "thread.visit":
      let (cid, tid) = try ids()
      self = .threadVisit(commandId: cid, threadId: tid, visitedAt: try c.decode(String.self, forKey: .visitedAt))
    case "thread.unpin": let (cid, tid) = try ids(); self = .threadUnpin(commandId: cid, threadId: tid)
    case "thread.unsettle": let (cid, tid) = try ids(); self = .threadUnsettle(commandId: cid, threadId: tid)
    case "thread.archive": let (cid, tid) = try ids(); self = .threadArchive(commandId: cid, threadId: tid)
    case "thread.unarchive": let (cid, tid) = try ids(); self = .threadUnarchive(commandId: cid, threadId: tid)
    case "thread.delete": let (cid, tid) = try ids(); self = .threadDelete(commandId: cid, threadId: tid)
    case "thread.mark-unread": let (cid, tid) = try ids(); self = .threadMarkUnread(commandId: cid, threadId: tid)
    default: self = .other(try JSONValue(from: decoder))
    }
  }

  public func encode(to encoder: Encoder) throws {
    switch self {
    case let .messageDispatch(v): try v.encode(to: encoder); return
    case let .runInterrupt(v): try v.encode(to: encoder); return
    case let .runtimeRequestRespond(v): try v.encode(to: encoder); return
    case let .threadMetadataUpdate(v): try v.encode(to: encoder); return
    case let .other(raw): try raw.encode(to: encoder); return
    default: break
    }
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(type, forKey: .type)
    try c.encode(commandId, forKey: .commandId)
    try c.encode(threadId, forKey: .threadId)
    switch self {
    case let .threadPin(_, _, orderKey):
      try c.encodeIfPresent(orderKey, forKey: .orderKey)
    case let .threadSettle(_, _, settledAt, note):
      try c.encodeIfPresent(settledAt, forKey: .settledAt)
      try c.encodeIfPresent(note, forKey: .note)
    case .threadUnsettle:
      try c.encode("user", forKey: .reason)
    case let .threadVisit(_, _, visitedAt):
      try c.encode(visitedAt, forKey: .visitedAt)
    default:
      break
    }
  }
}

/// How a message joins the thread's work.
public enum DispatchMode: Codable, Hashable, Sendable {
  /// Start a run now. Use when the thread is idle.
  case startImmediately
  /// Run after the active run finishes.
  case queueAfterActive
  /// Add the message to the active run.
  case steerActive(targetRunId: String)
  /// Stop the active run and start again with this message.
  case restartActive(targetRunId: String)
  /// Prepare the run without starting it.
  case deferStart(workspaceStrategy: WorkspaceStrategy? = nil)

  enum CodingKeys: String, CodingKey { case type, targetRunId, workspaceStrategy }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    switch try c.decode(String.self, forKey: .type) {
    case "queue_after_active": self = .queueAfterActive
    case "steer_active": self = .steerActive(targetRunId: try c.decode(String.self, forKey: .targetRunId))
    case "restart_active": self = .restartActive(targetRunId: try c.decode(String.self, forKey: .targetRunId))
    case "defer_start": self = .deferStart(workspaceStrategy: try c.decodeIfPresent(WorkspaceStrategy.self, forKey: .workspaceStrategy))
    default: self = .startImmediately
    }
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .startImmediately:
      try c.encode("start_immediately", forKey: .type)
    case .queueAfterActive:
      try c.encode("queue_after_active", forKey: .type)
    case let .steerActive(runId):
      try c.encode("steer_active", forKey: .type)
      try c.encode(runId, forKey: .targetRunId)
    case let .restartActive(runId):
      try c.encode("restart_active", forKey: .type)
      try c.encode(runId, forKey: .targetRunId)
    case let .deferStart(strategy):
      try c.encode("defer_start", forKey: .type)
      try c.encodeIfPresent(strategy, forKey: .workspaceStrategy)
    }
  }
}

/// `message.dispatch`: send a message to a thread.
public struct MessageDispatchCommand: Codable, Hashable, Sendable {
  public var createdBy: ActorKind
  public var creationSource: CreationSource
  public var commandId: String
  public var threadId: String
  public var messageId: String
  public var text: String
  public var attachments: [ChatAttachment]
  public var context: JSONValue?
  /// Seeds the temporary title of a new thread.
  public var titleSeed: String?
  public var modelSelection: ModelSelection?
  public var sourcePlanRef: PlanRef?
  /// Let the server pick steer or restart against its own state.
  public var deliveryIntent: DeliveryIntent?
  public var dispatchMode: DispatchMode

  public init(commandId: String, threadId: String, messageId: String, text: String, dispatchMode: DispatchMode, attachments: [ChatAttachment] = [], deliveryIntent: DeliveryIntent? = nil, modelSelection: ModelSelection? = nil, titleSeed: String? = nil, sourcePlanRef: PlanRef? = nil, context: JSONValue? = nil, createdBy: ActorKind = .user, creationSource: CreationSource = .mobile) {
    self.createdBy = createdBy
    self.creationSource = creationSource
    self.commandId = commandId
    self.threadId = threadId
    self.messageId = messageId
    self.text = text
    self.attachments = attachments
    self.context = context
    self.titleSeed = titleSeed
    self.modelSelection = modelSelection
    self.sourcePlanRef = sourcePlanRef
    self.deliveryIntent = deliveryIntent
    self.dispatchMode = dispatchMode
  }

  enum CodingKeys: String, CodingKey {
    case type, createdBy, creationSource, commandId, threadId, messageId, text, attachments, context, titleSeed
    case modelSelection, sourcePlanRef, deliveryIntent, dispatchMode
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    createdBy = try c.decodeIfPresent(ActorKind.self, forKey: .createdBy) ?? .user
    creationSource = try c.decodeIfPresent(CreationSource.self, forKey: .creationSource) ?? .mobile
    commandId = try c.decode(String.self, forKey: .commandId)
    threadId = try c.decode(String.self, forKey: .threadId)
    messageId = try c.decode(String.self, forKey: .messageId)
    text = try c.decode(String.self, forKey: .text)
    attachments = try c.decodeArray(ChatAttachment.self, forKey: .attachments)
    context = try c.decodeIfPresent(JSONValue.self, forKey: .context)
    titleSeed = try c.decodeIfPresent(String.self, forKey: .titleSeed)
    modelSelection = try c.decodeIfPresent(ModelSelection.self, forKey: .modelSelection)
    sourcePlanRef = try c.decodeIfPresent(PlanRef.self, forKey: .sourcePlanRef)
    deliveryIntent = try c.decodeIfPresent(DeliveryIntent.self, forKey: .deliveryIntent)
    dispatchMode = try c.decode(DispatchMode.self, forKey: .dispatchMode)
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode("message.dispatch", forKey: .type)
    try c.encode(createdBy, forKey: .createdBy)
    try c.encode(creationSource, forKey: .creationSource)
    try c.encode(commandId, forKey: .commandId)
    try c.encode(threadId, forKey: .threadId)
    try c.encode(messageId, forKey: .messageId)
    try c.encode(text, forKey: .text)
    try c.encode(attachments, forKey: .attachments)
    try c.encodeIfPresent(context, forKey: .context)
    try c.encodeIfPresent(titleSeed, forKey: .titleSeed)
    try c.encodeIfPresent(modelSelection, forKey: .modelSelection)
    try c.encodeIfPresent(sourcePlanRef, forKey: .sourcePlanRef)
    try c.encodeIfPresent(deliveryIntent, forKey: .deliveryIntent)
    try c.encode(dispatchMode, forKey: .dispatchMode)
  }
}

/// `run.interrupt`. The Stop button sends `holdQueue: true`, which also holds queued
/// messages and stops the thread's delegated tasks.
public struct RunInterruptCommand: Codable, Hashable, Sendable {
  public var commandId: String
  public var threadId: String
  public var runId: String
  public var reason: String?
  /// Who asked: `user` (the default when absent), `agent`, `service_update`, `delegated_cancel`.
  public var cause: String?
  public var holdQueue: Bool?

  public init(commandId: String, threadId: String, runId: String, reason: String? = nil, cause: String? = nil, holdQueue: Bool? = true) {
    self.commandId = commandId
    self.threadId = threadId
    self.runId = runId
    self.reason = reason
    self.cause = cause
    self.holdQueue = holdQueue
  }

  enum CodingKeys: String, CodingKey { case type, commandId, threadId, runId, reason, cause, holdQueue }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    commandId = try c.decode(String.self, forKey: .commandId)
    threadId = try c.decode(String.self, forKey: .threadId)
    runId = try c.decode(String.self, forKey: .runId)
    reason = try c.decodeIfPresent(String.self, forKey: .reason)
    cause = try c.decodeIfPresent(String.self, forKey: .cause)
    holdQueue = try c.decodeIfPresent(Bool.self, forKey: .holdQueue)
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode("run.interrupt", forKey: .type)
    try c.encode(commandId, forKey: .commandId)
    try c.encode(threadId, forKey: .threadId)
    try c.encode(runId, forKey: .runId)
    try c.encodeIfPresent(reason, forKey: .reason)
    try c.encodeIfPresent(cause, forKey: .cause)
    try c.encodeIfPresent(holdQueue, forKey: .holdQueue)
  }
}

/// An answer to one question of a user input request.
public enum UserInputAnswer: Codable, Hashable, Sendable {
  case text(String)
  /// Several choices, for multi-select questions.
  case choices([String])
  case other(JSONValue)

  public init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if let s = try? c.decode(String.self) { self = .text(s) }
    else if let a = try? c.decode([String].self) { self = .choices(a) }
    else { self = .other(try c.decode(JSONValue.self)) }
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case let .text(s): try c.encode(s)
    case let .choices(a): try c.encode(a)
    case let .other(v): try c.encode(v)
    }
  }
}

/// `runtime-request.respond`: approve or decline a permission, or answer questions.
public struct RuntimeRequestRespondCommand: Codable, Hashable, Sendable {
  public var commandId: String
  public var threadId: String
  public var requestId: String
  public var decision: ProviderApprovalDecision?
  /// Answers by question id.
  public var answers: [String: UserInputAnswer]?

  public init(commandId: String, threadId: String, requestId: String, decision: ProviderApprovalDecision? = nil, answers: [String: UserInputAnswer]? = nil) {
    self.commandId = commandId
    self.threadId = threadId
    self.requestId = requestId
    self.decision = decision
    self.answers = answers
  }

  enum CodingKeys: String, CodingKey { case type, commandId, threadId, requestId, decision, answers }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    commandId = try c.decode(String.self, forKey: .commandId)
    threadId = try c.decode(String.self, forKey: .threadId)
    requestId = try c.decode(String.self, forKey: .requestId)
    decision = try c.decodeIfPresent(ProviderApprovalDecision.self, forKey: .decision)
    answers = try c.decodeIfPresent([String: UserInputAnswer].self, forKey: .answers)
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode("runtime-request.respond", forKey: .type)
    try c.encode(commandId, forKey: .commandId)
    try c.encode(threadId, forKey: .threadId)
    try c.encode(requestId, forKey: .requestId)
    try c.encodeIfPresent(decision, forKey: .decision)
    try c.encodeIfPresent(answers, forKey: .answers)
  }
}

/// `thread.metadata.update`: rename, regenerate the title, or move the checkout.
public struct ThreadMetadataUpdateCommand: Codable, Hashable, Sendable {
  public var commandId: String
  public var threadId: String
  public var title: String?
  /// Start (true) or abandon (false) a title regeneration.
  public var regenerateTitle: Bool?
  public var branch: Nullable<String>?
  public var worktreePath: Nullable<String>?
  /// Reject unless nothing has landed on the thread yet.
  public var expectedEmpty: Bool?

  public init(commandId: String, threadId: String, title: String? = nil, regenerateTitle: Bool? = nil, branch: Nullable<String>? = nil, worktreePath: Nullable<String>? = nil, expectedEmpty: Bool? = nil) {
    self.commandId = commandId
    self.threadId = threadId
    self.title = title
    self.regenerateTitle = regenerateTitle
    self.branch = branch
    self.worktreePath = worktreePath
    self.expectedEmpty = expectedEmpty
  }

  enum CodingKeys: String, CodingKey { case type, commandId, threadId, title, regenerateTitle, branch, worktreePath, expectedEmpty }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    commandId = try c.decode(String.self, forKey: .commandId)
    threadId = try c.decode(String.self, forKey: .threadId)
    title = try c.decodeIfPresent(String.self, forKey: .title)
    regenerateTitle = try c.decodeIfPresent(Bool.self, forKey: .regenerateTitle)
    branch = try c.decodeNullable(String.self, forKey: .branch)
    worktreePath = try c.decodeNullable(String.self, forKey: .worktreePath)
    expectedEmpty = try c.decodeIfPresent(Bool.self, forKey: .expectedEmpty)
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode("thread.metadata.update", forKey: .type)
    try c.encode(commandId, forKey: .commandId)
    try c.encode(threadId, forKey: .threadId)
    try c.encodeIfPresent(title, forKey: .title)
    try c.encodeIfPresent(regenerateTitle, forKey: .regenerateTitle)
    try c.encodeIfPresent(branch, forKey: .branch)
    try c.encodeIfPresent(worktreePath, forKey: .worktreePath)
    try c.encodeIfPresent(expectedEmpty, forKey: .expectedEmpty)
  }
}

// MARK: - Launch

/// Where a new thread's run works.
public enum WorkspaceStrategy: Codable, Hashable, Sendable {
  /// The project checkout itself, optionally on a branch.
  case root(branch: String? = nil)
  case existingWorktree(worktreePath: String, branch: String? = nil, repository: String? = nil)
  /// A new worktree from `baseRef`.
  case worktree(baseRef: String, branch: String? = nil, startFromOrigin: Bool? = nil, repository: String? = nil)
  case unknown(JSONValue)

  enum CodingKeys: String, CodingKey { case type, branch, worktreePath, repository, baseRef, startFromOrigin }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    switch try c.decodeIfPresent(String.self, forKey: .type) {
    case "root":
      self = .root(branch: try c.decodeIfPresent(String.self, forKey: .branch))
    case "existing_worktree":
      self = .existingWorktree(
        worktreePath: try c.decode(String.self, forKey: .worktreePath),
        branch: try c.decodeIfPresent(String.self, forKey: .branch),
        repository: try c.decodeIfPresent(String.self, forKey: .repository))
    case "worktree":
      self = .worktree(
        baseRef: try c.decode(String.self, forKey: .baseRef),
        branch: try c.decodeIfPresent(String.self, forKey: .branch),
        startFromOrigin: try c.decodeIfPresent(Bool.self, forKey: .startFromOrigin),
        repository: try c.decodeIfPresent(String.self, forKey: .repository))
    default:
      self = .unknown(try JSONValue(from: decoder))
    }
  }

  public func encode(to encoder: Encoder) throws {
    if case let .unknown(raw) = self {
      try raw.encode(to: encoder)
      return
    }
    var c = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case let .root(branch):
      try c.encode("root", forKey: .type)
      try c.encodeIfPresent(branch, forKey: .branch)
    case let .existingWorktree(path, branch, repository):
      try c.encode("existing_worktree", forKey: .type)
      try c.encode(path, forKey: .worktreePath)
      try c.encodeIfPresent(branch, forKey: .branch)
      try c.encodeIfPresent(repository, forKey: .repository)
    case let .worktree(baseRef, branch, startFromOrigin, repository):
      try c.encode("worktree", forKey: .type)
      try c.encode(baseRef, forKey: .baseRef)
      try c.encodeIfPresent(branch, forKey: .branch)
      try c.encodeIfPresent(startFromOrigin, forKey: .startFromOrigin)
      try c.encodeIfPresent(repository, forKey: .repository)
    case .unknown:
      break
    }
  }
}

/// The first message of a launched thread.
public struct InitialMessage: Codable, Hashable, Sendable {
  public var messageId: String?
  public var text: String
  public var context: JSONValue?
  public var attachments: [ChatAttachment]

  public init(messageId: String? = nil, text: String, attachments: [ChatAttachment] = [], context: JSONValue? = nil) {
    self.messageId = messageId
    self.text = text
    self.attachments = attachments
    self.context = context
  }

  enum CodingKeys: String, CodingKey { case messageId, text, context, attachments }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    messageId = try c.decodeIfPresent(String.self, forKey: .messageId)
    text = try c.decode(String.self, forKey: .text)
    context = try c.decodeIfPresent(JSONValue.self, forKey: .context)
    attachments = try c.decodeArray(ChatAttachment.self, forKey: .attachments)
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encodeIfPresent(messageId, forKey: .messageId)
    try c.encode(text, forKey: .text)
    try c.encodeIfPresent(context, forKey: .context)
    try c.encode(attachments, forKey: .attachments)
  }
}

/// `orchestration.launchThread`: create a thread and, optionally, start it with a message.
public struct ThreadLaunchInput: Codable, Hashable, Sendable {
  public var commandId: String
  public var creationSource: CreationSource?
  public var threadId: String?
  public var reuseExistingThread: Bool?
  public var projectId: String
  public var title: String
  /// Replace `title` with a generated one after the first message.
  public var generateTitle: Bool?
  public var modelSelection: ModelSelection
  public var runtimeMode: RuntimeMode
  public var interactionMode: InteractionMode
  public var workspaceStrategy: WorkspaceStrategy
  public var initialMessage: InitialMessage?

  public init(commandId: String, projectId: String, title: String, modelSelection: ModelSelection, runtimeMode: RuntimeMode, interactionMode: InteractionMode = .default, workspaceStrategy: WorkspaceStrategy = .root(), initialMessage: InitialMessage? = nil, generateTitle: Bool? = nil, threadId: String? = nil, reuseExistingThread: Bool? = nil, creationSource: CreationSource? = .mobile) {
    self.commandId = commandId
    self.creationSource = creationSource
    self.threadId = threadId
    self.reuseExistingThread = reuseExistingThread
    self.projectId = projectId
    self.title = title
    self.generateTitle = generateTitle
    self.modelSelection = modelSelection
    self.runtimeMode = runtimeMode
    self.interactionMode = interactionMode
    self.workspaceStrategy = workspaceStrategy
    self.initialMessage = initialMessage
  }
}

/// Result of `orchestration.launchThread`.
public struct ThreadLaunchResult: Codable, Hashable, Sendable {
  public var threadId: String
  public var projection: ThreadProjection
  /// An existing thread was reused.
  public var resumed: Bool

  enum CodingKeys: String, CodingKey { case threadId, projection, resumed }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    threadId = try c.decode(String.self, forKey: .threadId)
    projection = try c.decode(ThreadProjection.self, forKey: .projection)
    resumed = try c.decodeIfPresent(Bool.self, forKey: .resumed) ?? false
  }
}
