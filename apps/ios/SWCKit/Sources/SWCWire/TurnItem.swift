import Foundation

/// One row of a thread's timeline: a message, a command, a plan, a question.
///
/// A known `type` must decode in full. A type this build does not know decodes as
/// `.unknown` with its raw JSON, keeping whatever base fields it carries, and
/// encodes back unchanged.
public struct TurnItem: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var threadId: String
  public var runId: String?
  public var nodeId: String?
  public var providerThreadId: String?
  public var providerTurnId: String?
  public var nativeItemRef: JSONValue?
  public var parentItemId: String?
  public var ordinal: Int
  public var status: TurnItemStatus
  public var title: String?
  public var startedAt: Date?
  public var completedAt: Date?
  public var updatedAt: Date
  public var toolNonExecutionKind: String?
  /// `browser` or `computer`.
  public var toolSurface: String?
  public var toolIcon: JSONValue?
  public var toolSource: ToolSource?
  public var content: Content

  /// The wire `type`.
  public var type: String { content.type }

  public init(id: String, threadId: String, runId: String? = nil, nodeId: String? = nil, ordinal: Int, status: TurnItemStatus, title: String? = nil, startedAt: Date? = nil, completedAt: Date? = nil, updatedAt: Date, parentItemId: String? = nil, content: Content) {
    self.id = id
    self.threadId = threadId
    self.runId = runId
    self.nodeId = nodeId
    self.ordinal = ordinal
    self.status = status
    self.title = title
    self.startedAt = startedAt
    self.completedAt = completedAt
    self.updatedAt = updatedAt
    self.parentItemId = parentItemId
    self.content = content
  }

  public enum Content: Hashable, Sendable {
    case userMessage(UserMessage)
    case assistantMessage(AssistantMessage)
    case reasoning(Reasoning)
    case proposedPlan(ProposedPlan)
    case todoList(TodoList)
    case commandExecution(CommandExecution)
    case fileChange(FileChange)
    case fileSearch(FileSearch)
    case webSearch(WebSearch)
    case approvalRequest(ApprovalRequest)
    case userInputRequest(UserInputRequest)
    case dynamicTool(DynamicTool)
    case subagent(Subagent)
    case error(ErrorReport)
    case systemNotice(SystemNotice)
    case notification(ThreadNotification)
    case unknown(type: String, raw: JSONValue)

    public var type: String {
      switch self {
      case .userMessage: "user_message"
      case .assistantMessage: "assistant_message"
      case .reasoning: "reasoning"
      case .proposedPlan: "proposed_plan"
      case .todoList: "todo_list"
      case .commandExecution: "command_execution"
      case .fileChange: "file_change"
      case .fileSearch: "file_search"
      case .webSearch: "web_search"
      case .approvalRequest: "approval_request"
      case .userInputRequest: "user_input_request"
      case .dynamicTool: "dynamic_tool"
      case .subagent: "subagent"
      case .error: "error"
      case .systemNotice: "system_notice"
      case .notification: "notification"
      case let .unknown(type, _): type
      }
    }
  }

  /// Every type this build decodes into a typed case.
  public static let knownTypes: Set<String> = [
    "user_message", "assistant_message", "reasoning", "proposed_plan", "todo_list", "command_execution",
    "file_change", "file_search", "web_search", "approval_request", "user_input_request", "dynamic_tool",
    "subagent", "error", "system_notice", "notification",
  ]

  enum BaseKeys: String, CodingKey {
    case type, id, threadId, runId, nodeId, providerThreadId, providerTurnId, nativeItemRef, parentItemId
    case ordinal, status, title, startedAt, completedAt, updatedAt
    case toolNonExecutionKind, toolSurface, toolIcon, toolSource
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: BaseKeys.self)
    let type = try c.decode(String.self, forKey: .type)
    guard Self.knownTypes.contains(type) else {
      // Keep what the base offers so the row still sorts; never fail.
      id = (try? c.decode(String.self, forKey: .id)) ?? ""
      threadId = (try? c.decode(String.self, forKey: .threadId)) ?? ""
      runId = try? c.decodeIfPresent(String.self, forKey: .runId)
      nodeId = try? c.decodeIfPresent(String.self, forKey: .nodeId)
      providerThreadId = try? c.decodeIfPresent(String.self, forKey: .providerThreadId)
      providerTurnId = try? c.decodeIfPresent(String.self, forKey: .providerTurnId)
      nativeItemRef = nil
      parentItemId = try? c.decodeIfPresent(String.self, forKey: .parentItemId)
      ordinal = (try? c.decode(Int.self, forKey: .ordinal)) ?? 0
      status = (try? c.decode(TurnItemStatus.self, forKey: .status)) ?? .idle
      title = try? c.decodeIfPresent(String.self, forKey: .title)
      startedAt = try? c.decodeIfPresent(Date.self, forKey: .startedAt)
      completedAt = try? c.decodeIfPresent(Date.self, forKey: .completedAt)
      updatedAt = (try? c.decode(Date.self, forKey: .updatedAt)) ?? Date(timeIntervalSince1970: 0)
      content = .unknown(type: type, raw: try JSONValue(from: decoder))
      return
    }
    id = try c.decode(String.self, forKey: .id)
    threadId = try c.decode(String.self, forKey: .threadId)
    runId = try c.decodeIfPresent(String.self, forKey: .runId)
    nodeId = try c.decodeIfPresent(String.self, forKey: .nodeId)
    providerThreadId = try c.decodeIfPresent(String.self, forKey: .providerThreadId)
    providerTurnId = try c.decodeIfPresent(String.self, forKey: .providerTurnId)
    nativeItemRef = try c.decodeIfPresent(JSONValue.self, forKey: .nativeItemRef)
    parentItemId = try c.decodeIfPresent(String.self, forKey: .parentItemId)
    ordinal = try c.decode(Int.self, forKey: .ordinal)
    status = try c.decode(TurnItemStatus.self, forKey: .status)
    title = try c.decodeIfPresent(String.self, forKey: .title)
    startedAt = try c.decodeIfPresent(Date.self, forKey: .startedAt)
    completedAt = try c.decodeIfPresent(Date.self, forKey: .completedAt)
    updatedAt = try c.decode(Date.self, forKey: .updatedAt)
    toolNonExecutionKind = try c.decodeIfPresent(String.self, forKey: .toolNonExecutionKind)
    toolSurface = try c.decodeIfPresent(String.self, forKey: .toolSurface)
    toolIcon = try c.decodeIfPresent(JSONValue.self, forKey: .toolIcon)
    toolSource = try? c.decodeIfPresent(ToolSource.self, forKey: .toolSource)
    switch type {
    case "user_message": content = .userMessage(try UserMessage(from: decoder))
    case "assistant_message": content = .assistantMessage(try AssistantMessage(from: decoder))
    case "reasoning": content = .reasoning(try Reasoning(from: decoder))
    case "proposed_plan": content = .proposedPlan(try ProposedPlan(from: decoder))
    case "todo_list": content = .todoList(try TodoList(from: decoder))
    case "command_execution": content = .commandExecution(try CommandExecution(from: decoder))
    case "file_change": content = .fileChange(try FileChange(from: decoder))
    case "file_search": content = .fileSearch(try FileSearch(from: decoder))
    case "web_search": content = .webSearch(try WebSearch(from: decoder))
    case "approval_request": content = .approvalRequest(try ApprovalRequest(from: decoder))
    case "user_input_request": content = .userInputRequest(try UserInputRequest(from: decoder))
    case "dynamic_tool": content = .dynamicTool(try DynamicTool(from: decoder))
    case "subagent": content = .subagent(try Subagent(from: decoder))
    case "error": content = .error(try ErrorReport(from: decoder))
    case "system_notice": content = .systemNotice(try SystemNotice(from: decoder))
    default: content = .notification(try ThreadNotification(from: decoder))
    }
  }

  public func encode(to encoder: Encoder) throws {
    if case let .unknown(_, raw) = content {
      try raw.encode(to: encoder)
      return
    }
    var c = encoder.container(keyedBy: BaseKeys.self)
    try c.encode(type, forKey: .type)
    try c.encode(id, forKey: .id)
    try c.encode(threadId, forKey: .threadId)
    try c.encodeIfPresent(runId, forKey: .runId)
    try c.encodeIfPresent(nodeId, forKey: .nodeId)
    try c.encodeIfPresent(providerThreadId, forKey: .providerThreadId)
    try c.encodeIfPresent(providerTurnId, forKey: .providerTurnId)
    try c.encodeIfPresent(nativeItemRef, forKey: .nativeItemRef)
    try c.encodeIfPresent(parentItemId, forKey: .parentItemId)
    try c.encode(ordinal, forKey: .ordinal)
    try c.encode(status, forKey: .status)
    try c.encodeIfPresent(title, forKey: .title)
    try c.encodeIfPresent(startedAt, forKey: .startedAt)
    try c.encodeIfPresent(completedAt, forKey: .completedAt)
    try c.encode(updatedAt, forKey: .updatedAt)
    try c.encodeIfPresent(toolNonExecutionKind, forKey: .toolNonExecutionKind)
    try c.encodeIfPresent(toolSurface, forKey: .toolSurface)
    try c.encodeIfPresent(toolIcon, forKey: .toolIcon)
    try c.encodeIfPresent(toolSource, forKey: .toolSource)
    switch content {
    case let .userMessage(v): try v.encode(to: encoder)
    case let .assistantMessage(v): try v.encode(to: encoder)
    case let .reasoning(v): try v.encode(to: encoder)
    case let .proposedPlan(v): try v.encode(to: encoder)
    case let .todoList(v): try v.encode(to: encoder)
    case let .commandExecution(v): try v.encode(to: encoder)
    case let .fileChange(v): try v.encode(to: encoder)
    case let .fileSearch(v): try v.encode(to: encoder)
    case let .webSearch(v): try v.encode(to: encoder)
    case let .approvalRequest(v): try v.encode(to: encoder)
    case let .userInputRequest(v): try v.encode(to: encoder)
    case let .dynamicTool(v): try v.encode(to: encoder)
    case let .subagent(v): try v.encode(to: encoder)
    case let .error(v): try v.encode(to: encoder)
    case let .systemNotice(v): try v.encode(to: encoder)
    case let .notification(v): try v.encode(to: encoder)
    case .unknown: break
    }
  }

  public var isUnknown: Bool {
    if case .unknown = content { return true }
    return false
  }

  /// True while the item is still changing.
  public var isInFlight: Bool {
    switch status.known {
    case .pending, .running, .waiting: true
    default: false
    }
  }
}

// MARK: - Item payloads

extension TurnItem {
  public struct UserMessage: Codable, Hashable, Sendable {
    public var createdBy: ActorKind
    public var creationSource: CreationSource
    public var messageId: String
    public var scheduledTaskId: String?
    /// The sending agent's thread, for messages from another agent.
    public var senderThreadId: String?
    public var inputIntent: UserMessageInputIntent
    public var text: String
    /// Structured composer context, kept raw.
    public var context: JSONValue?
    public var attachments: [ChatAttachment]

    public init(createdBy: ActorKind = .user, creationSource: CreationSource = .mobile, messageId: String, inputIntent: UserMessageInputIntent = .turnStart, text: String, attachments: [ChatAttachment] = []) {
      self.createdBy = createdBy
      self.creationSource = creationSource
      self.messageId = messageId
      self.inputIntent = inputIntent
      self.text = text
      self.attachments = attachments
    }

    enum CodingKeys: String, CodingKey { case createdBy, creationSource, messageId, scheduledTaskId, senderThreadId, inputIntent, text, context, attachments }

    public init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      createdBy = try c.decodeIfPresent(ActorKind.self, forKey: .createdBy) ?? .user
      creationSource = try c.decodeIfPresent(CreationSource.self, forKey: .creationSource) ?? .web
      messageId = try c.decode(String.self, forKey: .messageId)
      scheduledTaskId = try c.decodeIfPresent(String.self, forKey: .scheduledTaskId)
      senderThreadId = try c.decodeIfPresent(String.self, forKey: .senderThreadId)
      inputIntent = try c.decodeIfPresent(UserMessageInputIntent.self, forKey: .inputIntent) ?? .turnStart
      text = try c.decode(String.self, forKey: .text)
      context = try c.decodeIfPresent(JSONValue.self, forKey: .context)
      attachments = try c.decodeLossyArray(ChatAttachment.self, forKey: .attachments)
    }
  }

  public struct AssistantMessage: Codable, Hashable, Sendable {
    public var messageId: String
    /// Markdown.
    public var text: String
    public var attachments: [ChatAttachment]?
    public var streaming: Bool

    public init(messageId: String, text: String, attachments: [ChatAttachment]? = nil, streaming: Bool = false) {
      self.messageId = messageId
      self.text = text
      self.attachments = attachments
      self.streaming = streaming
    }
  }

  public struct Reasoning: Codable, Hashable, Sendable {
    public var text: String
    public var streaming: Bool

    public init(text: String, streaming: Bool = false) {
      self.text = text
      self.streaming = streaming
    }
  }

  public struct ProposedPlan: Codable, Hashable, Sendable {
    public var planId: String
    public var markdown: String
    public var streaming: Bool

    public init(planId: String, markdown: String, streaming: Bool = false) {
      self.planId = planId
      self.markdown = markdown
      self.streaming = streaming
    }
  }

  public struct TodoList: Codable, Hashable, Sendable {
    public var planId: String
    public var steps: [PlanStep]
    public var explanation: String?

    public init(planId: String, steps: [PlanStep], explanation: String? = nil) {
      self.planId = planId
      self.steps = steps
      self.explanation = explanation
    }

    public var completedCount: Int { steps.filter { $0.status == .completed }.count }
  }

  public struct CommandExecution: Codable, Hashable, Sendable {
    public var input: String
    public var output: String?
    /// The output was withheld; fetch it with `orchestration.getTurnItem`.
    public var outputOmitted: Bool?
    public var outputIndicatesFailure: Bool?
    public var exitCode: Int?

    public init(input: String, output: String? = nil, outputOmitted: Bool? = nil, outputIndicatesFailure: Bool? = nil, exitCode: Int? = nil) {
      self.input = input
      self.output = output
      self.outputOmitted = outputOmitted
      self.outputIndicatesFailure = outputIndicatesFailure
      self.exitCode = exitCode
    }
  }

  public struct FileChange: Codable, Hashable, Sendable {
    public var fileName: String
    public var additions: Int?
    public var deletions: Int?
    public var diffStr: String?
    public var oldStr: String?
    public var newStr: String?
    public var changes: [FileChangeDetail]?

    public init(fileName: String, additions: Int? = nil, deletions: Int? = nil, diffStr: String? = nil, changes: [FileChangeDetail]? = nil) {
      self.fileName = fileName
      self.additions = additions
      self.deletions = deletions
      self.diffStr = diffStr
      self.changes = changes
    }
  }

  public struct FileSearch: Codable, Hashable, Sendable {
    public var pattern: String?
    public var results: [FileSearchResult]?

    public init(pattern: String? = nil, results: [FileSearchResult]? = nil) {
      self.pattern = pattern
      self.results = results
    }
  }

  public struct WebSearch: Codable, Hashable, Sendable {
    public var patterns: [String]?
    public var results: [WebSearchResult]?

    public init(patterns: [String]? = nil, results: [WebSearchResult]? = nil) {
      self.patterns = patterns
      self.results = results
    }
  }

  /// A permission the agent waits on. Answer with `runtime-request.respond` and a decision.
  public struct ApprovalRequest: Codable, Hashable, Sendable {
    public var requestId: String
    public var requestKind: RuntimeRequestKind
    public var prompt: String?
    /// File-write grant root: `.null` means explicitly none, nil means unknown.
    public var grantRoot: Nullable<String>?
    /// The app asking, for `mcp-elicitation` requests.
    public var appName: String?
    /// Choices the provider offers. Nil means the default accept and decline.
    public var options: [ApprovalOption]?

    public init(requestId: String, requestKind: RuntimeRequestKind, prompt: String? = nil, grantRoot: Nullable<String>? = nil, appName: String? = nil, options: [ApprovalOption]? = nil) {
      self.requestId = requestId
      self.requestKind = requestKind
      self.prompt = prompt
      self.grantRoot = grantRoot
      self.appName = appName
      self.options = options
    }

    enum CodingKeys: String, CodingKey { case requestId, requestKind, prompt, grantRoot, appName, options }

    public init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      requestId = try c.decode(String.self, forKey: .requestId)
      requestKind = try c.decode(RuntimeRequestKind.self, forKey: .requestKind)
      prompt = try c.decodeIfPresent(String.self, forKey: .prompt)
      grantRoot = try c.decodeNullable(String.self, forKey: .grantRoot)
      appName = try c.decodeIfPresent(String.self, forKey: .appName)
      options = try c.decodeIfPresent([ApprovalOption].self, forKey: .options)
    }
  }

  /// Questions the agent asks. Answer with `runtime-request.respond` and `answers`.
  public struct UserInputRequest: Codable, Hashable, Sendable {
    public var requestId: String
    public var questions: [UserInputQuestion]
    /// The recorded answer once given, kept raw.
    public var questionAnswer: JSONValue?
    /// `message`: answer by sending a message instead of a response.
    public var responseMode: String?

    public init(requestId: String, questions: [UserInputQuestion], questionAnswer: JSONValue? = nil, responseMode: String? = nil) {
      self.requestId = requestId
      self.questions = questions
      self.questionAnswer = questionAnswer
      self.responseMode = responseMode
    }

    public var isAnswered: Bool { questionAnswer != nil }
  }

  /// A tool call outside the built-in kinds, such as an MCP tool.
  public struct DynamicTool: Codable, Hashable, Sendable {
    public var toolName: String?
    public var viewedImagePath: String?
    public var input: JSONValue
    public var output: JSONValue?
    public var outputOmitted: Bool?

    public init(toolName: String?, viewedImagePath: String? = nil, input: JSONValue = .null, output: JSONValue? = nil, outputOmitted: Bool? = nil) {
      self.toolName = toolName
      self.viewedImagePath = viewedImagePath
      self.input = input
      self.output = output
      self.outputOmitted = outputOmitted
    }

    enum CodingKeys: String, CodingKey { case toolName, viewedImagePath, input, output, outputOmitted }

    public init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      toolName = try c.decodeIfPresent(String.self, forKey: .toolName)
      viewedImagePath = try c.decodeIfPresent(String.self, forKey: .viewedImagePath)
      input = try c.decodeIfPresent(JSONValue.self, forKey: .input) ?? .null
      output = try c.decodeIfPresent(JSONValue.self, forKey: .output)
      outputOmitted = try c.decodeIfPresent(Bool.self, forKey: .outputOmitted)
    }

    public func encode(to encoder: Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(toolName, forKey: .toolName)
      try c.encodeIfPresent(viewedImagePath, forKey: .viewedImagePath)
      try c.encode(input, forKey: .input)
      try c.encodeIfPresent(output, forKey: .output)
      try c.encodeIfPresent(outputOmitted, forKey: .outputOmitted)
    }
  }

  public struct Subagent: Codable, Hashable, Sendable {
    public var subagentId: String
    /// `provider_native` or `app_owned`.
    public var origin: String
    public var driver: String
    public var providerInstanceId: String
    public var childThreadId: String?
    public var prompt: String
    public var progress: String?
    public var result: String?

    public init(subagentId: String, origin: String, driver: String, providerInstanceId: String, childThreadId: String? = nil, prompt: String, progress: String? = nil, result: String? = nil) {
      self.subagentId = subagentId
      self.origin = origin
      self.driver = driver
      self.providerInstanceId = providerInstanceId
      self.childThreadId = childThreadId
      self.prompt = prompt
      self.progress = progress
      self.result = result
    }
  }

  public struct ErrorReport: Codable, Hashable, Sendable {
    public var failure: ProviderFailure
    public var retry: ProviderRetry?

    public init(failure: ProviderFailure, retry: ProviderRetry? = nil) {
      self.failure = failure
      self.retry = retry
    }
  }

  public struct SystemNotice: Codable, Hashable, Sendable {
    public var message: String
    public init(message: String) { self.message = message }
  }
}

// MARK: - Shared parts

/// Who ran a browser, computer or integration tool.
public struct ToolSource: Codable, Hashable, Sendable {
  public var key: String
  public var name: String
  /// `browser`, `computer` or `integration`.
  public var kind: String
  public var icon: JSONValue?

  public init(key: String, name: String, kind: String, icon: JSONValue? = nil) {
    self.key = key
    self.name = name
    self.kind = kind
    self.icon = icon
  }
}

public struct PlanStep: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var text: String
  public var status: PlanStepStatus
  /// Free-form ISO string the elapsed time counts from.
  public var durationAnchorAt: String?
  /// Elapsed time of a completed step.
  public var durationMs: Int?

  public init(id: String, text: String, status: PlanStepStatus, durationAnchorAt: String? = nil, durationMs: Int? = nil) {
    self.id = id
    self.text = text
    self.status = status
    self.durationAnchorAt = durationAnchorAt
    self.durationMs = durationMs
  }
}

public struct UserInputQuestion: Codable, Hashable, Sendable, Identifiable {
  public struct Option: Codable, Hashable, Sendable {
    public var label: String
    public var description: String
    /// The value to answer with; the label when absent.
    public var value: String?
    public var recommended: Bool?

    public init(label: String, description: String, value: String? = nil, recommended: Bool? = nil) {
      self.label = label
      self.description = description
      self.value = value
      self.recommended = recommended
    }

    public var answerValue: String { value ?? label }
  }

  public var id: String
  public var header: String
  public var question: String
  public var options: [Option]
  public var multiSelect: Bool?
  public var allowCustomAnswer: Bool?
  public var required: Bool?

  public init(id: String, header: String, question: String, options: [Option] = [], multiSelect: Bool? = nil, allowCustomAnswer: Bool? = nil, required: Bool? = nil) {
    self.id = id
    self.header = header
    self.question = question
    self.options = options
    self.multiSelect = multiSelect
    self.allowCustomAnswer = allowCustomAnswer
    self.required = required
  }

  enum CodingKeys: String, CodingKey { case id, header, question, options, multiSelect, allowCustomAnswer, required }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    header = try c.decodeIfPresent(String.self, forKey: .header) ?? ""
    question = try c.decode(String.self, forKey: .question)
    options = try c.decodeArray(Option.self, forKey: .options)
    multiSelect = try c.decodeIfPresent(Bool.self, forKey: .multiSelect)
    allowCustomAnswer = try c.decodeIfPresent(Bool.self, forKey: .allowCustomAnswer)
    required = try c.decodeIfPresent(Bool.self, forKey: .required)
  }
}

/// One approval choice a provider offers.
public struct ApprovalOption: Codable, Hashable, Sendable {
  public var decision: ProviderApprovalDecision
  public var label: String
  /// A caution shown next to the option.
  public var warning: String?

  public init(decision: ProviderApprovalDecision, label: String, warning: String? = nil) {
    self.decision = decision
    self.label = label
    self.warning = warning
  }
}

/// A provider failure, already redacted by the server.
public struct ProviderFailure: Codable, Hashable, Sendable {
  public var failureClass: ProviderFailureClass
  public var message: String
  public var code: String?
  public var retryable: Bool?
  /// Free-form ISO string; absent when the provider names no reset time.
  public var resetAt: String?

  public init(failureClass: ProviderFailureClass, message: String, code: String? = nil, retryable: Bool? = nil, resetAt: String? = nil) {
    self.failureClass = failureClass
    self.message = message
    self.code = code
    self.retryable = retryable
    self.resetAt = resetAt
  }

  enum CodingKeys: String, CodingKey {
    case failureClass = "class"
    case message, code, retryable, resetAt
  }
}

public struct ProviderRetry: Codable, Hashable, Sendable {
  public var attempt: Int
  public var maxAttempts: Int?
  public var retryDelayMs: Int?

  public init(attempt: Int, maxAttempts: Int? = nil, retryDelayMs: Int? = nil) {
    self.attempt = attempt
    self.maxAttempts = maxAttempts
    self.retryDelayMs = retryDelayMs
  }
}

public struct FileChangeDetail: Codable, Hashable, Sendable {
  public var operation: String
  public var path: String
  public var oldPath: String?
  public var diffStr: String?
  public var fileType: String?
  public var mimeType: String?

  public init(operation: String, path: String, oldPath: String? = nil, diffStr: String? = nil, fileType: String? = nil, mimeType: String? = nil) {
    self.operation = operation
    self.path = path
    self.oldPath = oldPath
    self.diffStr = diffStr
    self.fileType = fileType
    self.mimeType = mimeType
  }
}

public struct FileSearchResult: Codable, Hashable, Sendable {
  public var fileName: String
  public var line: Int?
  public var column: Int?
  public var preview: String?

  public init(fileName: String, line: Int? = nil, column: Int? = nil, preview: String? = nil) {
    self.fileName = fileName
    self.line = line
    self.column = column
    self.preview = preview
  }
}

public struct WebSearchResult: Codable, Hashable, Sendable {
  public var title: String?
  public var url: String?
  public var snippet: String?

  public init(title: String? = nil, url: String? = nil, snippet: String? = nil) {
    self.title = title
    self.url = url
    self.snippet = snippet
  }
}

/// A report on background work: a subagent, a command, a delegated task.
public struct ThreadNotification: Codable, Hashable, Sendable {
  public var source: NotificationSource
  public var outcome: NotificationOutcome
  public var summary: String
  public var detail: String?

  public init(source: NotificationSource, outcome: NotificationOutcome, summary: String, detail: String? = nil) {
    self.source = source
    self.outcome = outcome
    self.summary = summary
    self.detail = detail
  }
}

/// What a notification reports on. Servers send a subagent as
/// `{"kind":"background_task","work":"subagent"}` and a command as `background_command`.
public struct NotificationSource: Codable, Hashable, Sendable {
  public var kind: String
  public var work: String?
  public var childThreadId: String?
  /// For `delegated_task`.
  public var taskIds: [String]?

  public init(kind: String, work: String? = nil, childThreadId: String? = nil, taskIds: [String]? = nil) {
    self.kind = kind
    self.work = work
    self.childThreadId = childThreadId
    self.taskIds = taskIds
  }

  public var isSubagent: Bool { kind == "subagent" || (kind == "background_task" && work == "subagent") }
  public var isCommand: Bool { kind == "command" || kind == "background_command" }
  public var isDelegatedTask: Bool { kind == "delegated_task" }

  /// The kind with the legacy spellings folded: `subagent`, `command`, `monitor`,
  /// `delegated_task` or `background_task`.
  public var normalizedKind: String {
    if isSubagent { return "subagent" }
    if isCommand { return "command" }
    switch kind {
    case "monitor", "delegated_task": return kind
    default: return "background_task"
    }
  }
}

/// A row of `visibleTurnItems`: an item placed in this thread's timeline,
/// possibly inherited from the thread it was forked from.
public struct ProjectedTurnItem: Codable, Hashable, Sendable, Identifiable {
  public var id: String { "\(sourceThreadId)/\(sourceItemId)" }
  public var position: Int
  public var visibility: TurnItemVisibility
  public var sourceThreadId: String
  public var sourceItemId: String
  public var item: TurnItem

  public init(position: Int, visibility: TurnItemVisibility = .local, sourceThreadId: String, sourceItemId: String, item: TurnItem) {
    self.position = position
    self.visibility = visibility
    self.sourceThreadId = sourceThreadId
    self.sourceItemId = sourceItemId
    self.item = item
  }
}
