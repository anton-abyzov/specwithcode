import Foundation

/// RPC method tags the app calls. Payload and result types are noted on each case.
public enum RpcMethod: String, Sendable, CaseIterable {
  /// `EmptyInput` -> `{}`.
  case serverProbe = "server.probe"
  /// `EmptyInput` -> `ServerConfig`.
  case serverGetConfig = "server.getConfig"
  /// `EmptyInput` -> `ServerSettings`.
  case serverGetSettings = "server.getSettings"
  /// `UpdateServerSettingsInput` -> `ServerSettings`.
  case serverUpdateSettings = "server.updateSettings"
  /// `SubscribeServerConfigInput` -> stream of `ServerConfigStreamItem`.
  case subscribeServerConfig = "subscribeServerConfig"
  /// `SubscribeShellInput` -> stream of `ShellStreamItem`.
  case subscribeShell = "orchestration.subscribeShell"
  /// `SubscribeThreadInput` -> stream of `ThreadStreamItem`.
  case subscribeThread = "orchestration.subscribeThread"
  /// `GetThreadProjectionInput` -> `ThreadProjection`.
  case getThreadProjection = "orchestration.getThreadProjection"
  /// `GetTurnItemInput` -> `GetTurnItemResult`.
  case getTurnItem = "orchestration.getTurnItem"
  /// `OrchestrationCommand` -> `DispatchResult`.
  case dispatchCommand = "orchestration.dispatchCommand"
  /// `ThreadLaunchInput` -> `ThreadLaunchResult`.
  case launchThread = "orchestration.launchThread"
  /// `CoordinatorSendInput` -> `CoordinatorResult`.
  case coordinatorSend = "projects.coordinatorSend"
  /// `CoordinatorStartInput` -> `CoordinatorResult`.
  case coordinatorStart = "projects.coordinatorStart"
  /// `WorkspaceReadInput` -> `WorkspaceReadResult`.
  case workspaceRead = "projects.workspaceRead"
  /// `ProjectUpdateCommand` -> `ProjectShell`.
  case projectsMutate = "projects.mutate"
  /// `CreateNewProjectInput` -> `CreateNewProjectResult`.
  case createNewProject = "projects.createNew"
  /// `EmptyInput` -> `EnsureScratchResult`.
  case ensureScratch = "projects.ensureScratch"

  /// True for methods that answer with a stream of chunks.
  public var isStream: Bool {
    switch self {
    case .subscribeServerConfig, .subscribeShell, .subscribeThread: true
    default: false
    }
  }
}

/// The `{}` payload of methods that take no input.
public struct EmptyInput: Codable, Hashable, Sendable {
  public init() {}
}

/// `orchestration.subscribeShell`. Pass a cached snapshot's sequence as `afterSequence`
/// to resume without a new snapshot.
public struct SubscribeShellInput: Codable, Hashable, Sendable {
  public var afterSequence: Int?
  /// Ask for `synchronized` between catch-up and live updates.
  public var requestCompletionMarker: Bool?

  public init(afterSequence: Int? = nil, requestCompletionMarker: Bool? = true) {
    self.afterSequence = afterSequence
    self.requestCompletionMarker = requestCompletionMarker
  }
}

/// `orchestration.subscribeThread`.
public struct SubscribeThreadInput: Codable, Hashable, Sendable {
  public var threadId: String
  public var afterSequence: Int?
  public var requestCompletionMarker: Bool?
  /// Allow a bounded snapshot with pageable history.
  public var acceptBoundedSnapshot: Bool?

  public init(threadId: String, afterSequence: Int? = nil, requestCompletionMarker: Bool? = true, acceptBoundedSnapshot: Bool? = nil) {
    self.threadId = threadId
    self.afterSequence = afterSequence
    self.requestCompletionMarker = requestCompletionMarker
    self.acceptBoundedSnapshot = acceptBoundedSnapshot
  }
}

/// `subscribeServerConfig`.
public struct SubscribeServerConfigInput: Codable, Hashable, Sendable {
  public var environmentThemes: Bool?
  public var usageLimitSources: Bool?

  public init(environmentThemes: Bool? = nil, usageLimitSources: Bool? = nil) {
    self.environmentThemes = environmentThemes
    self.usageLimitSources = usageLimitSources
  }
}

public struct GetThreadProjectionInput: Codable, Hashable, Sendable {
  public var threadId: String
  public init(threadId: String) { self.threadId = threadId }
}

/// `orchestration.getTurnItem`: one item with its full output, for items sent with
/// `outputOmitted`.
public struct GetTurnItemInput: Codable, Hashable, Sendable {
  public var threadId: String
  public var itemId: String
  /// The item `updatedAt` last seen; only keys the server's cache.
  public var revision: String?

  public init(threadId: String, itemId: String, revision: String? = nil) {
    self.threadId = threadId
    self.itemId = itemId
    self.revision = revision
  }
}

public struct GetTurnItemResult: Codable, Hashable, Sendable {
  public var item: TurnItem?
  public init(item: TurnItem?) { self.item = item }
}

/// Result of `orchestration.dispatchCommand`: the event sequence the command produced.
public struct DispatchResult: Codable, Hashable, Sendable {
  public var sequence: Int
  public init(sequence: Int) { self.sequence = sequence }
}

/// Result of `projects.ensureScratch`.
public struct EnsureScratchResult: Codable, Hashable, Sendable {
  public var projectId: String
  public init(projectId: String) { self.projectId = projectId }
}

extension RpcClientMessage {
  /// A request frame with a typed payload.
  public static func request<Payload: Encodable>(id: RpcRequestID, method: RpcMethod, payload: Payload) throws -> RpcClientMessage {
    .request(id: id, tag: method.rawValue, payload: try JSONValue.from(payload))
  }

  /// A request frame for a method that takes no input.
  public static func request(id: RpcRequestID, method: RpcMethod) -> RpcClientMessage {
    .request(id: id, tag: method.rawValue, payload: .object([:]))
  }
}

extension RpcExit {
  /// The success value decoded as `T`, or the failure as a `ServerError`.
  public func value<T: Decodable>(_ type: T.Type = T.self) throws -> T {
    switch self {
    case let .success(value): return try value.decode(T.self)
    case let .failure(causes): throw ServerError.from(causes: causes)
    }
  }

  public var isSuccess: Bool {
    if case .success = self { return true }
    return false
  }

  /// True when the call ended only because it was interrupted (an unsubscribe).
  public var isInterruptOnly: Bool {
    guard case let .failure(causes) = self, !causes.isEmpty else { return false }
    return causes.allSatisfy {
      if case .interrupt = $0 { return true }
      return false
    }
  }
}
