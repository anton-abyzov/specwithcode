import Foundation
import SWCWire
import Synchronization
@testable import SWCTransport

/// Thread-safe list for values recorded from concurrent code.
final class Recorder<Value: Sendable>: Sendable {
  private let storage = Mutex<[Value]>([])
  func append(_ value: Value) { storage.withLock { $0.append(value) } }
  var values: [Value] { storage.withLock { $0 } }
}

/// An HTTP transport answered by a closure.
final class FakeHTTP: HTTPTransport {
  typealias Handler = @Sendable (URLRequest) async throws -> (Int, String)

  private let handler: Handler
  private let log = Recorder<URLRequest>()

  init(_ handler: @escaping Handler) {
    self.handler = handler
  }

  var requests: [URLRequest] { log.values }

  func requests(path: String) -> [URLRequest] { requests.filter { $0.url?.path == path } }

  func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    log.append(request)
    let (status, body) = try await handler(request)
    let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
    return (Data(body.utf8), response)
  }
}

/// A WebSocket driven by the test: `push` delivers server frames, `sent` holds client frames.
final class ScriptedConnection: WebSocketConnection {
  private struct State {
    var inbox: [WebSocketFrame] = []
    var waiter: CheckedContinuation<WebSocketFrame, Error>?
    var closed = false
    var sent: [String] = []
  }

  private let state = Mutex(State())
  private let responder: (@Sendable (String) -> [String])?

  /// Answers every Ping with a Pong.
  static let pongs: @Sendable (String) -> [String] = { text in
    text.contains(#""_tag":"Ping""#) ? [#"{"_tag":"Pong"}"#] : []
  }

  init(responder: (@Sendable (String) -> [String])? = nil) {
    self.responder = responder
  }

  var sent: [String] { state.withLock { $0.sent } }
  var isClosed: Bool { state.withLock { $0.closed } }

  /// Sent frames as JSON, Pings left out unless asked for.
  func sentFrames(includingPings: Bool = false) -> [JSONValue] {
    sent.compactMap { try? JSONDecoder().decode(JSONValue.self, from: Data($0.utf8)) }
      .filter { includingPings || $0["_tag"]?.stringValue != "Ping" }
  }

  func sentFrames(tag: String) -> [JSONValue] {
    sentFrames(includingPings: true).filter { $0["_tag"]?.stringValue == tag }
  }

  func push(_ text: String) {
    let frame = WebSocketFrame.text(text)
    state.withLock { state in
      guard !state.closed else { return }
      if let waiter = state.waiter {
        state.waiter = nil
        waiter.resume(returning: frame)
      } else {
        state.inbox.append(frame)
      }
    }
  }

  func send(_ text: String) async throws {
    let closed = state.withLock { state -> Bool in
      if state.closed { return true }
      state.sent.append(text)
      return false
    }
    if closed { throw TransportError.closed }
    for reply in responder?(text) ?? [] { push(reply) }
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

/// Hands out scripted connections or failures in order, then fresh connections.
final class FakeConnector: WebSocketConnector {
  enum Step: Sendable {
    case connect(ScriptedConnection)
    case fail(TransportError)
  }

  private let steps: Mutex<[Step]>
  private let urlLog = Recorder<URL>()
  private let connectionLog = Recorder<ScriptedConnection>()

  init(_ steps: [Step] = []) {
    self.steps = Mutex(steps)
  }

  var urls: [URL] { urlLog.values }
  var connections: [ScriptedConnection] { connectionLog.values }

  func connect(to url: URL) async throws -> any WebSocketConnection {
    urlLog.append(url)
    let step = steps.withLock { $0.isEmpty ? nil : $0.removeFirst() }
    switch step {
    case let .fail(error):
      throw error
    case let .connect(connection):
      connectionLog.append(connection)
      return connection
    case nil:
      let connection = ScriptedConnection(responder: ScriptedConnection.pongs)
      connectionLog.append(connection)
      return connection
    }
  }
}

/// Polls until `condition` holds or the timeout passes.
func eventually(timeout: Duration = .seconds(3), _ condition: @Sendable () async -> Bool) async -> Bool {
  let deadline = ContinuousClock.now + timeout
  while ContinuousClock.now < deadline {
    if await condition() { return true }
    try? await Task.sleep(for: .milliseconds(5))
  }
  return await condition()
}

func json(_ text: String) throws -> JSONValue {
  try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
}

func formFields(_ body: String) -> [String: String] {
  Dictionary(FormQuery(body).pairs, uniquingKeysWith: { first, _ in first })
}
