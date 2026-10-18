import Foundation

// Shared wire primitives. Every other wire type builds on these.
//
// The server speaks Effect RPC over a WebSocket with the Schema JSON codec:
// one JSON value per UTF-8 text frame, `DateTimeUtc` as ISO strings with
// milliseconds, optional keys omitted (or null), extra keys ignored.

// MARK: - JSONValue

/// Any JSON value. Used for payloads the app does not model and for raw passthrough.
public enum JSONValue: Sendable, Hashable, Codable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])

  public init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() { self = .null }
    else if let b = try? c.decode(Bool.self) { self = .bool(b) }
    else if let n = try? c.decode(Double.self) { self = .number(n) }
    else if let s = try? c.decode(String.self) { self = .string(s) }
    else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
    else { self = .object(try c.decode([String: JSONValue].self)) }
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .null: try c.encodeNil()
    case let .bool(b): try c.encode(b)
    case let .number(n):
      if n.rounded() == n, abs(n) < 1e15 { try c.encode(Int64(n)) } else { try c.encode(n) }
    case let .string(s): try c.encode(s)
    case let .array(a): try c.encode(a)
    case let .object(o): try c.encode(o)
    }
  }

  public subscript(key: String) -> JSONValue? {
    if case let .object(o) = self { return o[key] }
    return nil
  }

  public var stringValue: String? { if case let .string(s) = self { return s }; return nil }
  public var intValue: Int? { if case let .number(n) = self { return Int(n) }; return nil }
  public var boolValue: Bool? { if case let .bool(b) = self { return b }; return nil }
  public var isNull: Bool { if case .null = self { return true }; return false }

  /// Re-decode this value as a typed model.
  public func decode<T: Decodable>(_ type: T.Type = T.self) throws -> T {
    try WireCoding.decoder.decode(T.self, from: WireCoding.encoder.encode(self))
  }

  public static func from<T: Encodable>(_ value: T) throws -> JSONValue {
    try WireCoding.decoder.decode(JSONValue.self, from: WireCoding.encoder.encode(value))
  }
}

// MARK: - Open string enums

/// A string literal union the server may extend. Unknown values never fail a decode.
public protocol OpenStringEnum: RawRepresentable, Codable, Hashable, Sendable where RawValue == String {
  associatedtype Known: RawRepresentable & Sendable where Known.RawValue == String
}

public extension OpenStringEnum {
  var known: Known? { Known(rawValue: rawValue) }
  init(_ known: Known) { self.init(rawValue: known.rawValue)! }
  init(from decoder: Decoder) throws {
    self.init(rawValue: try decoder.singleValueContainer().decode(String.self))!
  }
  func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    try c.encode(rawValue)
  }
}

// MARK: - Coding

public enum WireCoding {
  nonisolated(unsafe) static let isoFractional: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
  }()

  nonisolated(unsafe) static let isoPlain: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f
  }()

  private static let lock = NSLock()

  /// Parses `DateTimeUtc` (always with milliseconds) and lenient `IsoDateTime` strings.
  public static func parseDate(_ s: String) -> Date? {
    lock.lock(); defer { lock.unlock() }
    return isoFractional.date(from: s) ?? isoPlain.date(from: s)
  }

  /// Formats like JavaScript `Date.toISOString()`: UTC with milliseconds.
  public static func formatDate(_ d: Date) -> String {
    lock.lock(); defer { lock.unlock() }
    return isoFractional.string(from: d)
  }

  public static var decoder: JSONDecoder {
    let d = JSONDecoder()
    d.dateDecodingStrategy = .custom { dec in
      let s = try dec.singleValueContainer().decode(String.self)
      guard let date = parseDate(s) else {
        throw DecodingError.dataCorrupted(.init(codingPath: dec.codingPath, debugDescription: "Unparseable date \(s)"))
      }
      return date
    }
    return d
  }

  public static var encoder: JSONEncoder {
    let e = JSONEncoder()
    e.dateEncodingStrategy = .custom { date, enc in
      var c = enc.singleValueContainer()
      try c.encode(formatDate(date))
    }
    e.outputFormatting = [.withoutEscapingSlashes]
    return e
  }
}

// MARK: - RPC envelopes

/// Request id chosen by the client and echoed by the server.
public typealias RpcRequestID = Int

/// Client to server frames.
public enum RpcClientMessage: Sendable, Encodable {
  case request(id: RpcRequestID, tag: String, payload: JSONValue)
  case ack(requestId: RpcRequestID)
  case interrupt(requestId: RpcRequestID)
  case ping

  enum K: String, CodingKey { case _tag, id, tag, payload, headers, requestId }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: K.self)
    switch self {
    case let .request(id, tag, payload):
      try c.encode("Request", forKey: ._tag)
      try c.encode(id, forKey: .id)
      try c.encode(tag, forKey: .tag)
      try c.encode(payload, forKey: .payload)
      try c.encode([[String]](), forKey: .headers)
    case let .ack(requestId):
      try c.encode("Ack", forKey: ._tag)
      try c.encode(requestId, forKey: .requestId)
    case let .interrupt(requestId):
      try c.encode("Interrupt", forKey: ._tag)
      try c.encode(requestId, forKey: .requestId)
    case .ping:
      try c.encode("Ping", forKey: ._tag)
    }
  }
}

/// One entry of an Effect `Cause` in a failed exit.
public enum RpcCause: Sendable, Decodable {
  /// A typed error the handler declared (`_tag` names it, e.g. `ProjectWorkspaceError`).
  case fail(JSONValue)
  /// An unexpected defect, usually a message string.
  case die(JSONValue)
  case interrupt

  enum K: String, CodingKey { case _tag, error, defect }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: K.self)
    switch try c.decode(String.self, forKey: ._tag) {
    case "Fail": self = .fail(try c.decodeIfPresent(JSONValue.self, forKey: .error) ?? .null)
    case "Die": self = .die(try c.decodeIfPresent(JSONValue.self, forKey: .defect) ?? .null)
    default: self = .interrupt
    }
  }
}

public enum RpcExit: Sendable, Decodable {
  case success(JSONValue)
  case failure([RpcCause])

  enum K: String, CodingKey { case _tag, value, cause }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: K.self)
    if try c.decode(String.self, forKey: ._tag) == "Success" {
      self = .success(try c.decodeIfPresent(JSONValue.self, forKey: .value) ?? .null)
    } else {
      self = .failure(try c.decodeIfPresent([RpcCause].self, forKey: .cause) ?? [])
    }
  }
}

/// Server to client frames. Values stay raw JSON so the socket can route them
/// to the decoder registered for each request.
public enum RpcServerMessage: Sendable, Decodable {
  case chunk(requestId: RpcRequestID, values: [JSONValue])
  case exit(requestId: RpcRequestID, exit: RpcExit)
  case pong
  case defect(JSONValue)
  case unknown(String)

  enum K: String, CodingKey { case _tag, requestId, values, exit, defect }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: K.self)
    let tag = try c.decode(String.self, forKey: ._tag)
    switch tag {
    case "Chunk":
      self = .chunk(requestId: try Self.decodeId(c), values: try c.decode([JSONValue].self, forKey: .values))
    case "Exit":
      self = .exit(requestId: try Self.decodeId(c), exit: try c.decode(RpcExit.self, forKey: .exit))
    case "Pong": self = .pong
    case "Defect": self = .defect(try c.decodeIfPresent(JSONValue.self, forKey: .defect) ?? .null)
    default: self = .unknown(tag)
    }
  }

  private static func decodeId(_ c: KeyedDecodingContainer<K>) throws -> RpcRequestID {
    if let i = try? c.decode(Int.self, forKey: .requestId) { return i }
    // Effect may echo numeric ids as strings.
    let s = try c.decode(String.self, forKey: .requestId)
    guard let i = Int(s) else {
      throw DecodingError.dataCorruptedError(forKey: .requestId, in: c, debugDescription: "Non-numeric request id \(s)")
    }
    return i
  }
}

// MARK: - Typed server errors

/// A failure the UI can explain. Built from an `RpcCause` list.
public struct ServerError: Error, Sendable, Hashable, CustomStringConvertible {
  public enum Kind: Sendable, Hashable {
    /// Token lacks a scope, e.g. `orchestration:operate`.
    case authorization(requiredScope: String?)
    /// Command rejected by the orchestrator.
    case dispatch(commandType: String?)
    /// `ProjectWorkspaceError` with its `code` (paused, archived, model_required, busy, ...).
    case projectWorkspace(code: String)
    case projectMutation
    case serverSettings
    /// Some other typed error, identified by its `_tag`.
    case other(tag: String)
    case defect
    case interrupted
  }

  public let kind: Kind
  public let message: String
  public let raw: JSONValue

  public init(kind: Kind, message: String, raw: JSONValue = .null) {
    self.kind = kind
    self.message = message
    self.raw = raw
  }

  public var description: String { message }

  public static func from(causes: [RpcCause]) -> ServerError {
    for cause in causes {
      switch cause {
      case let .fail(error):
        let tag = error["_tag"]?.stringValue ?? "UnknownError"
        let message = error["message"]?.stringValue
        switch tag {
        case "EnvironmentAuthorizationError":
          let scope = error["requiredScope"]?.stringValue
          return ServerError(kind: .authorization(requiredScope: scope), message: message ?? "This machine did not grant the app permission for that.", raw: error)
        case "OrchestrationV2DispatchCommandError":
          return ServerError(kind: .dispatch(commandType: error["commandType"]?.stringValue), message: message ?? "The machine rejected the command.", raw: error)
        case "ProjectWorkspaceError":
          let code = error["code"]?.stringValue ?? "unknown"
          return ServerError(kind: .projectWorkspace(code: code), message: ProjectWorkspaceErrorText.message(for: code), raw: error)
        case "ProjectMutationError":
          return ServerError(kind: .projectMutation, message: message ?? "The project could not be saved.", raw: error)
        case "ServerSettingsError":
          return ServerError(kind: .serverSettings, message: message ?? "The setting could not be saved.", raw: error)
        default:
          return ServerError(kind: .other(tag: tag), message: message ?? tag, raw: error)
        }
      case let .die(defect):
        let text = defect.stringValue ?? defect["message"]?.stringValue ?? "The machine hit an unexpected error."
        return ServerError(kind: .defect, message: text, raw: defect)
      case .interrupt:
        continue
      }
    }
    return ServerError(kind: .interrupted, message: "The request was cancelled.")
  }
}

/// User-facing text for `ProjectWorkspaceError.code`. The server sends only the code.
public enum ProjectWorkspaceErrorText {
  public static func message(for code: String) -> String {
    switch code {
    case "not_found": "This project no longer exists on that machine."
    case "conflict": "Someone else changed this project. Reload and try again."
    case "paused": "This project is paused. Resume it to send messages."
    case "archived": "This project is archived."
    case "model_required": "Choose a model for the coordinator first."
    case "unsupported_provider": "The coordinator's provider is not available on that machine."
    case "busy": "The coordinator is busy. Try again in a moment."
    case "transferred": "This project moved to another machine."
    case "update_in_progress": "That machine is updating. Try again shortly."
    case "invalid_coordinator": "The coordinator thread is in a bad state on that machine."
    default: "The project could not do that (\(code))."
    }
  }
}
