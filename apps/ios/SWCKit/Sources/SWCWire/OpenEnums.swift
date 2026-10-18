import Foundation

// String literal unions from the contracts, kept open so a newer server never
// fails a decode. Compare with the static members (`status == .running`) or
// switch over `known`.

/// `"idle"` or a run status: the status a thread shell reports.
public struct ThreadStatus: OpenStringEnum {
  public enum Known: String, Sendable, CaseIterable {
    case idle, preparing, queued, starting, running, waiting, completed, interrupted, failed, cancelled
    case rolledBack = "rolled_back"
  }
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }

  public static let idle = Self(.idle)
  public static let preparing = Self(.preparing)
  public static let queued = Self(.queued)
  public static let starting = Self(.starting)
  public static let running = Self(.running)
  public static let waiting = Self(.waiting)
  public static let completed = Self(.completed)
  public static let interrupted = Self(.interrupted)
  public static let failed = Self(.failed)
  public static let cancelled = Self(.cancelled)
  public static let rolledBack = Self(.rolledBack)

  /// True while a run is in flight: preparing, queued, starting, running or waiting.
  public var isWorking: Bool {
    switch known {
    case .preparing, .queued, .starting, .running, .waiting: true
    default: false
    }
  }
}

public struct RunStatus: OpenStringEnum {
  public enum Known: String, Sendable, CaseIterable {
    case preparing, queued, starting, running, waiting, completed, interrupted, failed, cancelled
    case rolledBack = "rolled_back"
  }
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }

  public static let preparing = Self(.preparing)
  public static let queued = Self(.queued)
  public static let starting = Self(.starting)
  public static let running = Self(.running)
  public static let waiting = Self(.waiting)
  public static let completed = Self(.completed)
  public static let interrupted = Self(.interrupted)
  public static let failed = Self(.failed)
  public static let cancelled = Self(.cancelled)
  public static let rolledBack = Self(.rolledBack)

  /// Preparing, queued, starting, running or waiting.
  public var isWorking: Bool {
    switch known {
    case .preparing, .queued, .starting, .running, .waiting: true
    default: false
    }
  }

  /// A run that holds the thread now: preparing, starting, running or waiting (not queued).
  public var isActive: Bool {
    switch known {
    case .preparing, .starting, .running, .waiting: true
    default: false
    }
  }
}

public struct TurnItemStatus: OpenStringEnum {
  public enum Known: String, Sendable, CaseIterable {
    case idle, pending, running, waiting, completed, failed, cancelled, interrupted
  }
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }

  public static let idle = Self(.idle)
  public static let pending = Self(.pending)
  public static let running = Self(.running)
  public static let waiting = Self(.waiting)
  public static let completed = Self(.completed)
  public static let failed = Self(.failed)
  public static let cancelled = Self(.cancelled)
  public static let interrupted = Self(.interrupted)
}

public struct RuntimeMode: OpenStringEnum {
  public enum Known: String, Sendable, CaseIterable {
    case approvalRequired = "approval-required"
    case autoAcceptEdits = "auto-accept-edits"
    case auto
    case fullAccess = "full-access"
  }
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }

  public static let approvalRequired = Self(.approvalRequired)
  public static let autoAcceptEdits = Self(.autoAcceptEdits)
  public static let auto = Self(.auto)
  public static let fullAccess = Self(.fullAccess)
}

public struct InteractionMode: OpenStringEnum {
  public enum Known: String, Sendable, CaseIterable {
    case `default`, plan
  }
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }

  public static let `default` = Self(.default)
  public static let plan = Self(.plan)
}

/// Who created a thread, message or command: `user`, `agent` or `system`.
public struct ActorKind: OpenStringEnum {
  public enum Known: String, Sendable, CaseIterable {
    case user, agent, system
  }
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }

  public static let user = Self(.user)
  public static let agent = Self(.agent)
  public static let system = Self(.system)
}

public struct CreationSource: OpenStringEnum {
  public enum Known: String, Sendable, CaseIterable {
    case web, mobile, mcp, provider, server
  }
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }

  public static let web = Self(.web)
  public static let mobile = Self(.mobile)
  public static let mcp = Self(.mcp)
  public static let provider = Self(.provider)
  public static let server = Self(.server)
}

public struct MessageRole: OpenStringEnum {
  public enum Known: String, Sendable, CaseIterable {
    case user, assistant, system
  }
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }

  public static let user = Self(.user)
  public static let assistant = Self(.assistant)
  public static let system = Self(.system)
}

public struct PlanStatus: OpenStringEnum {
  public enum Known: String, Sendable, CaseIterable {
    case draft, active, completed, superseded
  }
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }

  public static let draft = Self(.draft)
  public static let active = Self(.active)
  public static let completed = Self(.completed)
  public static let superseded = Self(.superseded)
}

public struct PlanStepStatus: OpenStringEnum {
  public enum Known: String, Sendable, CaseIterable {
    case pending, running, completed
  }
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }

  public static let pending = Self(.pending)
  public static let running = Self(.running)
  public static let completed = Self(.completed)
}

/// What a runtime request asks for. Approval kinds plus tool calls, questions and auth.
public struct RuntimeRequestKind: OpenStringEnum {
  public enum Known: String, Sendable, CaseIterable {
    case command
    case fileRead = "file-read"
    case fileChange = "file-change"
    case mcpElicitation = "mcp-elicitation"
    case permission
    case dynamicToolCall = "dynamic_tool_call"
    case userInput = "user_input"
    case authRefresh = "auth_refresh"
  }
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }

  public static let command = Self(.command)
  public static let fileRead = Self(.fileRead)
  public static let fileChange = Self(.fileChange)
  public static let mcpElicitation = Self(.mcpElicitation)
  public static let permission = Self(.permission)
  public static let dynamicToolCall = Self(.dynamicToolCall)
  public static let userInput = Self(.userInput)
  public static let authRefresh = Self(.authRefresh)

  /// A question for the user rather than an approval.
  public var isUserInput: Bool { known == .userInput }
}

public struct RuntimeRequestStatus: OpenStringEnum {
  public enum Known: String, Sendable, CaseIterable {
    case pending, resolved, expired, cancelled
  }
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }

  public static let pending = Self(.pending)
  public static let resolved = Self(.resolved)
  public static let expired = Self(.expired)
  public static let cancelled = Self(.cancelled)
}

public struct ProviderApprovalDecision: OpenStringEnum {
  public enum Known: String, Sendable, CaseIterable {
    case accept, acceptForSession, acceptAlways, decline, cancel
  }
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }

  public static let accept = Self(.accept)
  public static let acceptForSession = Self(.acceptForSession)
  public static let acceptAlways = Self(.acceptAlways)
  public static let decline = Self(.decline)
  public static let cancel = Self(.cancel)
}

/// `ProjectWorkspaceSettings.kind`: a code project or the personal assistant.
public struct WorkspaceKind: OpenStringEnum {
  public enum Known: String, Sendable, CaseIterable {
    case code, personal
  }
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }

  public static let code = Self(.code)
  public static let personal = Self(.personal)
}

/// Which shell list a thread lives in.
public struct ThreadLocation: OpenStringEnum {
  public enum Known: String, Sendable, CaseIterable {
    case active, archive
  }
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }

  public static let active = Self(.active)
  public static let archive = Self(.archive)
}

public struct SettledOverride: OpenStringEnum {
  public enum Known: String, Sendable, CaseIterable {
    case settled, active
  }
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }

  public static let settled = Self(.settled)
  public static let active = Self(.active)
}

public struct ProviderFailureClass: OpenStringEnum {
  public enum Known: String, Sendable, CaseIterable {
    case usageLimit = "usage_limit"
    case providerError = "provider_error"
    case transportError = "transport_error"
    case permissionError = "permission_error"
    case validationError = "validation_error"
    case unknown
  }
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }

  public static let usageLimit = Self(.usageLimit)
  public static let providerError = Self(.providerError)
  public static let transportError = Self(.transportError)
  public static let permissionError = Self(.permissionError)
  public static let validationError = Self(.validationError)
  public static let unknown = Self(.unknown)
}

public struct UserMessageInputIntent: OpenStringEnum {
  public enum Known: String, Sendable, CaseIterable {
    case turnStart = "turn_start"
    case queuedTurn = "queued_turn"
    case steer
    case promotedQueuedToSteer = "promoted_queued_to_steer"
  }
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }

  public static let turnStart = Self(.turnStart)
  public static let queuedTurn = Self(.queuedTurn)
  public static let steer = Self(.steer)
  public static let promotedQueuedToSteer = Self(.promotedQueuedToSteer)
}

/// Where a new thread runs: the project checkout or a fresh worktree.
public struct ThreadEnvMode: OpenStringEnum {
  public enum Known: String, Sendable, CaseIterable {
    case local, worktree
  }
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }

  public static let local = Self(.local)
  public static let worktree = Self(.worktree)
}

/// `message.dispatch.deliveryIntent`, only for servers with `serverResolvedCommandContext`.
public struct DeliveryIntent: OpenStringEnum {
  public enum Known: String, Sendable, CaseIterable {
    case auto, steer, restart
  }
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }

  public static let auto = Self(.auto)
  public static let steer = Self(.steer)
  public static let restart = Self(.restart)
}

public struct LineageRelationship: OpenStringEnum {
  public enum Known: String, Sendable, CaseIterable {
    case fork, subagent
  }
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }

  public static let fork = Self(.fork)
  public static let subagent = Self(.subagent)
}

public struct DirectEndpointKind: OpenStringEnum {
  public enum Known: String, Sendable, CaseIterable {
    case lan, tailnet
  }
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }

  public static let lan = Self(.lan)
  public static let tailnet = Self(.tailnet)
}

public struct TurnItemVisibility: OpenStringEnum {
  public enum Known: String, Sendable, CaseIterable {
    case local, inherited, synthetic
  }
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }

  public static let local = Self(.local)
  public static let inherited = Self(.inherited)
  public static let synthetic = Self(.synthetic)
}

public struct CoordinatorBindingState: OpenStringEnum {
  public enum Known: String, Sendable, CaseIterable {
    case active, transferring, transferred
  }
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }

  public static let active = Self(.active)
  public static let transferring = Self(.transferring)
  public static let transferred = Self(.transferred)
}

public struct NotificationOutcome: OpenStringEnum {
  public enum Known: String, Sendable, CaseIterable {
    case completed, failed, cancelled, updated, unknown
  }
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }

  public static let completed = Self(.completed)
  public static let failed = Self(.failed)
  public static let cancelled = Self(.cancelled)
  public static let updated = Self(.updated)
  public static let unknown = Self(.unknown)
}

/// Background work that can outlive the turn that started it.
public struct BackgroundTaskKind: OpenStringEnum {
  public enum Known: String, Sendable, CaseIterable {
    case subagent, command, monitor, workflow
    case backgroundTask = "background_task"
  }
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }

  public static let subagent = Self(.subagent)
  public static let command = Self(.command)
  public static let monitor = Self(.monitor)
  public static let workflow = Self(.workflow)
  public static let backgroundTask = Self(.backgroundTask)
}
