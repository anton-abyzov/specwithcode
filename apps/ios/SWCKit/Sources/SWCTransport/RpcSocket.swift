import Foundation
import os
import SWCWire
import Synchronization

/// One chunk of a stream. Call `ack()` after the values are applied: the
/// server sends nothing more on this stream until it gets the ack.
public struct RpcChunk: Sendable {
  public let requestId: RpcRequestID
  public let values: [JSONValue]
  private let acker: Acker

  init(requestId: RpcRequestID, values: [JSONValue], acker: Acker) {
    self.requestId = requestId
    self.values = values
    self.acker = acker
  }

  /// Sends the ack. Calling it again does nothing.
  public func ack() { acker.fire() }
}

final class Acker: Sendable {
  private let fired = Mutex(false)
  private let send: @Sendable () -> Void

  init(_ send: @escaping @Sendable () -> Void) {
    self.send = send
  }

  func fire() {
    let first = fired.withLock { fired in
      defer { fired = true }
      return !fired
    }
    if first { send() }
  }
}

/// Effect RPC over one WebSocket: unary calls, acked streams, keepalive.
///
/// Request ids count from 1 per socket. Frames are written in order by one
/// writer and decoded off this actor by one reader.
public actor RpcSocket {
  public struct Configuration: Sendable {
    /// A unary call without an answer by then fails with `TransportError.timedOut`
    /// and is interrupted; its result is unknown.
    public var callTimeout: Duration
    public var pingInterval: Duration
    /// Consecutive unanswered pings before the socket is closed.
    public var maxMissedPongs: Int

    public init(callTimeout: Duration = .seconds(30), pingInterval: Duration = .seconds(5), maxMissedPongs: Int = 3) {
      self.callTimeout = callTimeout
      self.pingInterval = pingInterval
      self.maxMissedPongs = maxMissedPongs
    }
  }

  public enum CloseReason: Sendable, Hashable {
    case requested
    case pingTimeout
    case connectionLost(String)
  }

  private enum Pending {
    case call(CheckedContinuation<JSONValue, Error>, timeout: Task<Void, Never>)
    case stream(AsyncThrowingStream<RpcChunk, Error>.Continuation)
  }

  static let log = Logger(subsystem: "com.specwithcode.ios", category: "rpc")

  public nonisolated let connection: any WebSocketConnection
  public nonisolated let configuration: Configuration

  private nonisolated let outbox: AsyncStream<RpcClientMessage>.Continuation
  private let outgoing: AsyncStream<RpcClientMessage>
  private var pending: [RpcRequestID: Pending] = [:]
  private var nextId: RpcRequestID = 1
  private var awaitingPong = false
  private var missedPongs = 0
  private var tasks: [Task<Void, Never>] = []
  private var started = false
  private var closeWaiters: [UUID: CheckedContinuation<CloseReason?, Never>] = [:]

  /// Set once the socket is closed.
  public private(set) var closeReason: CloseReason?
  /// Socket-level `Defect` frames seen so far. They do not close the socket.
  public private(set) var defectCount = 0

  public init(connection: any WebSocketConnection, configuration: Configuration = Configuration()) {
    self.connection = connection
    self.configuration = configuration
    (outgoing, outbox) = AsyncStream.makeStream(of: RpcClientMessage.self, bufferingPolicy: .unbounded)
  }

  deinit {
    outbox.finish()
    connection.close()
  }

  public var isClosed: Bool { closeReason != nil }

  /// Starts reading, writing and pinging. Calls and streams start it too.
  public func start() {
    guard !started, closeReason == nil else { return }
    started = true
    let connection = self.connection
    let outgoing = self.outgoing

    tasks.append(Task.detached { [weak self] in
      let encoder = WireCoding.encoder
      for await message in outgoing {
        do {
          let data = try encoder.encode(message)
          try await connection.send(String(decoding: data, as: UTF8.self))
        } catch {
          await self?.lost(error)
          return
        }
      }
    })

    tasks.append(Task.detached { [weak self] in
      let decoder = JSONDecoder()
      while !Task.isCancelled {
        let frame: WebSocketFrame
        do {
          frame = try await connection.receive()
        } catch {
          await self?.lost(error)
          return
        }
        let messages = RpcSocket.decode(frame, with: decoder)
        guard let self else { return }
        await self.handle(messages)
      }
    })

    let interval = configuration.pingInterval
    tasks.append(Task.detached { [weak self] in
      while !Task.isCancelled {
        do { try await Task.sleep(for: interval) } catch { return }
        guard let self, await self.pingTick() else { return }
      }
    })
  }

  /// A unary call. Throws `ServerError` for a failed exit, `TransportError.timedOut`
  /// after `callTimeout`, `TransportError.closed` if the socket closes first, and
  /// `CancellationError` when the calling task is cancelled (the server gets an Interrupt).
  public func call(tag: String, payload: JSONValue = .object([:])) async throws -> JSONValue {
    guard closeReason == nil else { throw TransportError.closed }
    start()
    let id = allocateId()
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<JSONValue, Error>) in
        if Task.isCancelled {
          continuation.resume(throwing: CancellationError())
          return
        }
        guard closeReason == nil else {
          continuation.resume(throwing: TransportError.closed)
          return
        }
        let limit = configuration.callTimeout
        let timeout = Task { [weak self] in
          do { try await Task.sleep(for: limit) } catch { return }
          await self?.timeOut(id)
        }
        pending[id] = .call(continuation, timeout: timeout)
        outbox.yield(.request(id: id, tag: tag, payload: payload))
      }
    } onCancel: {
      Task { await self.cancelRequest(id) }
    }
  }

  /// A streaming call. The stream finishes on a successful exit, throws
  /// `ServerError` on a failed one and `TransportError.closed` when the socket
  /// closes. Ending iteration early sends an Interrupt.
  public func stream(tag: String, payload: JSONValue = .object([:])) -> AsyncThrowingStream<RpcChunk, Error> {
    let (stream, continuation) = AsyncThrowingStream.makeStream(of: RpcChunk.self, throwing: Error.self, bufferingPolicy: .unbounded)
    guard closeReason == nil else {
      continuation.finish(throwing: TransportError.closed)
      return stream
    }
    start()
    let id = allocateId()
    pending[id] = .stream(continuation)
    continuation.onTermination = { [weak self] termination in
      if case .cancelled = termination {
        Task { await self?.streamCancelled(id) }
      }
    }
    outbox.yield(.request(id: id, tag: tag, payload: payload))
    return stream
  }

  /// Closes the socket and fails everything pending with `TransportError.closed`.
  public func close() {
    finish(.requested)
  }

  /// Waits until the socket closes. Returns nil if the waiting task is cancelled first.
  public func waitUntilClosed() async -> CloseReason? {
    if let closeReason { return closeReason }
    let id = UUID()
    return await withTaskCancellationHandler {
      await withCheckedContinuation { (continuation: CheckedContinuation<CloseReason?, Never>) in
        if let closeReason {
          continuation.resume(returning: closeReason)
        } else if Task.isCancelled {
          continuation.resume(returning: nil)
        } else {
          closeWaiters[id] = continuation
        }
      }
    } onCancel: {
      Task { await self.cancelWaiter(id) }
    }
  }

  // MARK: - Internals

  private func allocateId() -> RpcRequestID {
    defer { nextId += 1 }
    return nextId
  }

  private func handle(_ messages: [RpcServerMessage]) {
    for message in messages {
      switch message {
      case .pong:
        awaitingPong = false
        missedPongs = 0
      case let .chunk(requestId, values):
        guard case let .stream(continuation)? = pending[requestId] else { continue }
        let outbox = self.outbox
        let acker = Acker { outbox.yield(.ack(requestId: requestId)) }
        continuation.yield(RpcChunk(requestId: requestId, values: values, acker: acker))
      case let .exit(requestId, exit):
        guard let entry = pending.removeValue(forKey: requestId) else { continue }
        switch (entry, exit) {
        case let (.call(continuation, timeout), .success(value)):
          timeout.cancel()
          continuation.resume(returning: value)
        case let (.call(continuation, timeout), .failure(causes)):
          timeout.cancel()
          continuation.resume(throwing: ServerError.from(causes: causes))
        case let (.stream(continuation), .success):
          continuation.finish()
        case let (.stream(continuation), .failure(causes)):
          continuation.finish(throwing: ServerError.from(causes: causes))
        }
      case let .defect(value):
        defectCount += 1
        Self.log.error("Socket defect: \(String(describing: value))")
      case let .unknown(tag):
        Self.log.debug("Ignoring frame \(tag, privacy: .public)")
      }
    }
  }

  private func pingTick() -> Bool {
    guard closeReason == nil else { return false }
    if awaitingPong {
      missedPongs += 1
      if missedPongs >= configuration.maxMissedPongs {
        Self.log.notice("Closing socket after \(self.missedPongs) missed pongs")
        finish(.pingTimeout)
        return false
      }
    } else {
      missedPongs = 0
    }
    awaitingPong = true
    outbox.yield(.ping)
    return true
  }

  private func timeOut(_ id: RpcRequestID) {
    guard case let .call(continuation, _)? = pending.removeValue(forKey: id) else { return }
    outbox.yield(.interrupt(requestId: id))
    continuation.resume(throwing: TransportError.timedOut)
  }

  private func cancelRequest(_ id: RpcRequestID) {
    guard let entry = pending.removeValue(forKey: id) else { return }
    outbox.yield(.interrupt(requestId: id))
    switch entry {
    case let .call(continuation, timeout):
      timeout.cancel()
      continuation.resume(throwing: CancellationError())
    case let .stream(continuation):
      continuation.finish(throwing: CancellationError())
    }
  }

  private func streamCancelled(_ id: RpcRequestID) {
    guard case .stream? = pending[id] else { return }
    pending[id] = nil
    outbox.yield(.interrupt(requestId: id))
  }

  private func cancelWaiter(_ id: UUID) {
    closeWaiters.removeValue(forKey: id)?.resume(returning: nil)
  }

  private func lost(_ error: Error) {
    // Never the full description: a URLSession error carries the socket URL and its ticket.
    finish(.connectionLost(error.redactedDescription))
  }

  private func finish(_ reason: CloseReason) {
    guard closeReason == nil else { return }
    closeReason = reason
    for task in tasks { task.cancel() }
    tasks = []
    outbox.finish()
    connection.close()
    let entries = pending
    pending = [:]
    for entry in entries.values {
      switch entry {
      case let .call(continuation, timeout):
        timeout.cancel()
        continuation.resume(throwing: TransportError.closed)
      case let .stream(continuation):
        continuation.finish(throwing: TransportError.closed)
      }
    }
    let waiters = closeWaiters
    closeWaiters = [:]
    for waiter in waiters.values { waiter.resume(returning: reason) }
  }

  /// Decodes one frame into server messages. Accepts a single message or a batch.
  nonisolated static func decode(_ frame: WebSocketFrame, with decoder: JSONDecoder) -> [RpcServerMessage] {
    let data: Data = switch frame {
    case let .text(text): Data(text.utf8)
    case let .binary(data): data
    }
    let isBatch = data.first(where: { !($0 == 0x20 || $0 == 0x0A || $0 == 0x0D || $0 == 0x09) }) == UInt8(ascii: "[")
    do {
      return isBatch ? try decoder.decode([RpcServerMessage].self, from: data) : [try decoder.decode(RpcServerMessage.self, from: data)]
    } catch {
      // A decoding error can quote frame contents.
      log.error("Unreadable frame of \(data.count) bytes: \(String(describing: error), privacy: .private)")
      return []
    }
  }
}
