import Foundation
import Synchronization
import SWCTransport
import SWCWire

// Fakes copied from Tests/SWCTransportTests/Support.swift, plus a scripted machine.

final class Recorder<Value: Sendable>: Sendable {
  private let storage = Mutex<[Value]>([])
  func append(_ value: Value) { storage.withLock { $0.append(value) } }
  var values: [Value] { storage.withLock { $0 } }
}

final class FakeHTTP: HTTPTransport {
  typealias Handler = @Sendable (URLRequest) async throws -> (Int, String)
  private let handler: Handler

  init(_ handler: @escaping Handler) {
    self.handler = handler
  }

  func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    let (status, body) = try await handler(request)
    let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
    return (Data(body.utf8), response)
  }
}

/// A WebSocket whose server side is a responder closure.
final class ScriptedConnection: WebSocketConnection {
  private struct State {
    var inbox: [WebSocketFrame] = []
    var waiter: CheckedContinuation<WebSocketFrame, Error>?
    var closed = false
  }

  private let state = Mutex(State())
  private let responder: @Sendable (String) -> [String]

  init(responder: @escaping @Sendable (String) -> [String]) {
    self.responder = responder
  }

  func push(_ text: String) {
    state.withLock { state in
      guard !state.closed else { return }
      if let waiter = state.waiter {
        state.waiter = nil
        waiter.resume(returning: .text(text))
      } else {
        state.inbox.append(.text(text))
      }
    }
  }

  func send(_ text: String) async throws {
    if state.withLock({ $0.closed }) { throw TransportError.closed }
    for reply in responder(text) { push(reply) }
  }

  func receive() async throws -> WebSocketFrame {
    try await withCheckedThrowingContinuation { continuation in
      state.withLock { state in
        if !state.inbox.isEmpty {
          continuation.resume(returning: state.inbox.removeFirst())
        } else if state.closed {
          continuation.resume(throwing: TransportError.closed)
        } else {
          state.waiter = continuation
        }
      }
    }
  }

  func close() {
    state.withLock { state in
      guard !state.closed else { return }
      state.closed = true
      state.waiter?.resume(throwing: TransportError.closed)
      state.waiter = nil
    }
  }
}

final class FakeConnector: WebSocketConnector {
  private let machine: FakeMachine
  let connections = Recorder<ScriptedConnection>()

  init(_ machine: FakeMachine) {
    self.machine = machine
  }

  func connect(to url: URL) async throws -> any WebSocketConnection {
    let connection = ScriptedConnection(responder: machine.respond)
    connections.append(connection)
    return connection
  }
}

/// Answers RPC requests the way a machine does, from the embedded fixtures.
final class FakeMachine: Sendable {
  static let environmentId = "env-1"

  let requests = Recorder<JSONValue>()
  private let failures = Mutex<[String: String]>([:])

  /// Makes the next call of `tag` fail with this typed error JSON.
  func fail(_ tag: String, with error: String) {
    failures.withLock { $0[tag] = error }
  }

  static let config = #"""
  {"environment":{"environmentId":"env-1","label":"M4","platform":{"os":"darwin","arch":"arm64"},"serverVersion":"1.0.50","orchestrationProtocolVersion":2,"capabilities":{}},
   "directEndpoints":[{"kind":"lan","httpBaseUrl":"http://192.168.1.21:8319"}],
   "settings":{"defaultRuntimeMode":"auto","sidebarProjectOrder":{"pinned":["env-1:/Users/x/specweave"],"unpinned":[]},"providerInstances":{}},
   "providers":[]}
  """#

  func requests(_ tag: String) -> [JSONValue] {
    requests.values.filter { $0["tag"]?.stringValue == tag }
  }

  func payloads(_ tag: String) -> [JSONValue] {
    requests(tag).compactMap { $0["payload"] }
  }

  func respond(_ text: String) -> [String] {
    guard let frame = try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)) else { return [] }
    switch frame["_tag"]?.stringValue {
    case "Ping":
      return [#"{"_tag":"Pong"}"#]
    case "Request":
      requests.append(frame)
      let id = frame["id"]?.intValue ?? 0
      let tag = frame["tag"]?.stringValue ?? ""
      if let error = failures.withLock({ $0.removeValue(forKey: tag) }) {
        return [#"{"_tag":"Exit","requestId":\#(id),"exit":{"_tag":"Failure","cause":[{"_tag":"Fail","error":\#(error)}]}}"#]
      }
      switch tag {
      case "server.getConfig":
        return [Self.exit(id, Self.config)]
      case "orchestration.subscribeShell":
        return [Self.chunk(id, FixtureJSON.shellSnapshot), Self.chunk(id, #"{"kind":"synchronized"}"#)]
      case "orchestration.subscribeThread":
        return [Self.chunk(id, FixtureJSON.threadSnapshot), Self.chunk(id, #"{"kind":"synchronized"}"#)]
      case "orchestration.dispatchCommand":
        return [Self.exit(id, #"{"sequence":500}"#)]
      case "projects.coordinatorSend", "projects.coordinatorStart":
        return [Self.exit(id, #"{"threadId":"thr_coord","created":true}"#)]
      case "projects.workspaceRead":
        return [Self.exit(id, #"{"settings":{"kind":"code","environment":{"additionalFolders":[],"repositories":[]},"revision":3,"goal":"Ship it","instructions":"Be brief","coordinatorModelSelection":null,"paused":false,"archived":false,"autoResume":false},"memory":{"files":[],"totalBytes":0}}"#)]
      case "projects.createNew":
        return [Self.exit(id, #"{"projectId":"aide_1","workspaceRoot":"/Users/x/Aide"}"#)]
      case "server.getSettings", "server.updateSettings":
        return [Self.exit(id, #"{"defaultRuntimeMode":"full-access","providerInstances":{}}"#)]
      default:
        return [Self.exit(id, "null")]
      }
    default:
      return []
    }
  }

  static func exit(_ id: Int, _ value: String) -> String {
    #"{"_tag":"Exit","requestId":\#(id),"exit":{"_tag":"Success","value":\#(value)}}"#
  }

  /// A failed exit with a typed error, as the server ends a request on a live socket.
  static func failure(_ id: Int, _ error: String) -> String {
    #"{"_tag":"Exit","requestId":\#(id),"exit":{"_tag":"Failure","cause":[{"_tag":"Fail","error":\#(error)}]}}"#
  }

  static func chunk(_ id: Int, _ value: String) -> String {
    #"{"_tag":"Chunk","requestId":\#(id),"values":[\#(value)]}"#
  }

  static func descriptor() -> String {
    #"{"environmentId":"env-1","label":"Wire Probe","platform":{"os":"darwin","arch":"arm64"},"serverVersion":"1.0.50","orchestrationProtocolVersion":2,"capabilities":{}}"#
  }

  static let session = #"{"authenticated":true,"permissions":["orchestration:read","orchestration:operate"],"expiresAt":"2026-11-17T06:18:32.514Z"}"#

  func http() -> FakeHTTP {
    FakeHTTP { request in
      switch request.url?.path {
      case "/.well-known/studio/environment": (200, Self.descriptor())
      case "/api/auth/websocket-ticket": (200, #"{"ticket":"tk.sig","expiresAt":"2099-01-01T00:00:00.000Z"}"#)
      case "/api/auth/session": (200, Self.session)
      default: (404, "")
      }
    }
  }
}

/// Polls on the main actor until `condition` holds or the timeout passes.
@MainActor
func until(timeout: Duration = .seconds(5), _ condition: () -> Bool) async -> Bool {
  let deadline = ContinuousClock.now + timeout
  while ContinuousClock.now < deadline {
    if condition() { return true }
    try? await Task.sleep(for: .milliseconds(5))
  }
  return condition()
}
