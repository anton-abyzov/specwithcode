import Foundation
import Synchronization

public enum WebSocketFrame: Sendable, Hashable {
  case text(String)
  case binary(Data)
}

/// An open WebSocket. `receive` throws once the socket is closed.
public protocol WebSocketConnection: AnyObject, Sendable {
  func send(_ text: String) async throws
  func receive() async throws -> WebSocketFrame
  func close()
}

/// Opens sockets. Returns only after the upgrade succeeded; a refused upgrade
/// throws `TransportError.upgradeFailed`, a network failure `.unreachable` or `.timedOut`.
public protocol WebSocketConnector: Sendable {
  func connect(to url: URL) async throws -> any WebSocketConnection
}

public struct URLSessionWebSocketConnector: WebSocketConnector {
  /// The 1 MiB default drops thread snapshots.
  public static let defaultMaximumMessageSize = 32 * 1024 * 1024

  public var maximumMessageSize: Int
  public var openTimeout: Duration

  public init(maximumMessageSize: Int = URLSessionWebSocketConnector.defaultMaximumMessageSize, openTimeout: Duration = .seconds(15)) {
    self.maximumMessageSize = maximumMessageSize
    self.openTimeout = openTimeout
  }

  public func connect(to url: URL) async throws -> any WebSocketConnection {
    let connection = URLSessionWebSocketConnection(url: url, maximumMessageSize: maximumMessageSize, openTimeout: openTimeout)
    do {
      try await connection.open()
    } catch {
      // Invalidate the session so it releases its delegate.
      connection.close()
      throw error
    }
    return connection
  }
}

/// `URLSessionWebSocketTask` with no subprotocol, no cookies and no auth header:
/// the ticket in the URL is the only credential.
public final class URLSessionWebSocketConnection: WebSocketConnection {
  private let session: URLSession
  private let task: URLSessionWebSocketTask
  private let delegate: Delegate
  private let openTimeout: Duration

  public init(url: URL, maximumMessageSize: Int = URLSessionWebSocketConnector.defaultMaximumMessageSize, openTimeout: Duration = .seconds(15)) {
    let config = URLSessionConfiguration.ephemeral
    config.httpCookieAcceptPolicy = .never
    config.httpShouldSetCookies = false
    config.urlCache = nil
    config.waitsForConnectivity = false
    let delegate = Delegate()
    self.delegate = delegate
    self.session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: openTimeout.timeInterval)
    request.httpShouldHandleCookies = false
    self.task = session.webSocketTask(with: request)
    self.task.maximumMessageSize = maximumMessageSize
    self.openTimeout = openTimeout
  }

  /// Starts the upgrade and waits for it.
  public func open() async throws {
    let delegate = self.delegate
    let task = self.task
    let timeout = openTimeout
    let timer = Task {
      try await Task.sleep(for: timeout)
      if delegate.fail(TransportError.timedOut) { task.cancel() }
    }
    defer { timer.cancel() }
    task.resume()
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
        delegate.wait(continuation)
      }
    } onCancel: {
      if delegate.fail(CancellationError()) { task.cancel() }
    }
  }

  public func send(_ text: String) async throws {
    try await task.send(.string(text))
  }

  public func receive() async throws -> WebSocketFrame {
    switch try await task.receive() {
    case let .string(text): return .text(text)
    case let .data(data): return .binary(data)
    @unknown default: throw TransportError.invalidResponse("Unknown WebSocket message")
    }
  }

  public func close() {
    _ = delegate.fail(TransportError.closed)
    task.cancel(with: .normalClosure, reason: nil)
    session.finishTasksAndInvalidate()
  }

  final class Delegate: NSObject, URLSessionWebSocketDelegate, Sendable {
    private enum State {
      case idle
      case waiting(CheckedContinuation<Void, Error>)
      case opened
      case failed(Error)
    }

    private let state = Mutex<State>(.idle)

    func wait(_ continuation: CheckedContinuation<Void, Error>) {
      state.withLock { state in
        switch state {
        case .idle: state = .waiting(continuation)
        case .opened: continuation.resume()
        case let .failed(error): continuation.resume(throwing: error)
        case .waiting: continuation.resume(throwing: TransportError.closed)
        }
      }
    }

    /// Fails a pending or future open. Returns false if the socket already opened.
    @discardableResult
    func fail(_ error: Error) -> Bool {
      state.withLock { state in
        switch state {
        case .opened: return false
        case let .waiting(continuation):
          state = .failed(error)
          continuation.resume(throwing: error)
        case .idle:
          state = .failed(error)
        case .failed:
          break
        }
        return true
      }
    }

    private func opened() {
      state.withLock { state in
        switch state {
        case let .waiting(continuation):
          state = .opened
          continuation.resume()
        case .idle:
          state = .opened
        case .opened, .failed:
          break
        }
      }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
      opened()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
      let status = (task.response as? HTTPURLResponse)?.statusCode
      if let status, status != 101 {
        fail(TransportError.upgradeFailed(status: status))
      } else if let urlError = error as? URLError {
        fail(MachineHTTP.map(urlError))
      } else if let error {
        fail(TransportError.unreachable(error.redactedDescription))
      } else {
        fail(TransportError.closed)
      }
    }
  }
}
