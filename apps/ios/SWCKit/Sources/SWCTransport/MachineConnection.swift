import Foundation
import os

/// Keeps one machine connected: picks a route, gets a ticket, opens the
/// socket, and reconnects with backoff when it drops.
public actor MachineConnection {
  public enum State: String, Sendable, Hashable {
    case offline, connecting, connected, reconnecting, needsRepair, unsupported
  }

  public struct Status: Sendable, Hashable {
    public var state: State
    /// The route in use, or the one last used.
    public var route: MachineRoute?
    public var descriptor: EnvironmentDescriptorLite?
    /// Why the last attempt failed. For `.unsupported` it is `.appTooOld` or `.serverTooOld`.
    public var lastError: TransportError?
    /// When the next attempt starts, while backing off.
    public var retryAt: Date?
    public var tokenDaysLeft: Int?

    public init(state: State, route: MachineRoute? = nil, descriptor: EnvironmentDescriptorLite? = nil, lastError: TransportError? = nil, retryAt: Date? = nil, tokenDaysLeft: Int? = nil) {
      self.state = state
      self.route = route
      self.descriptor = descriptor
      self.lastError = lastError
      self.retryAt = retryAt
      self.tokenDaysLeft = tokenDaysLeft
    }
  }

  /// Exponential backoff with jitter: `base * 2^(failures-1)`, scaled by
  /// a random factor in `1 ± jitter`, kept within `base...maximum`.
  public struct Backoff: Sendable, Hashable {
    public var base: Duration
    public var maximum: Duration
    public var jitter: Double

    public init(base: Duration = .milliseconds(500), maximum: Duration = .seconds(30), jitter: Double = 0.2) {
      self.base = base
      self.maximum = maximum
      self.jitter = jitter
    }

    /// `random` is in `0..<1`.
    public func delay(afterFailures failures: Int, random: Double) -> Duration {
      let base = self.base.timeInterval
      let maximum = self.maximum.timeInterval
      let exponent = Double(max(0, min(failures - 1, 30)))
      let raw = min(maximum, base * pow(2, exponent))
      let factor = 1 - jitter + 2 * jitter * min(max(random, 0), 1)
      return .seconds(min(maximum, max(base, raw * factor)))
    }
  }

  public struct Configuration: Sendable {
    /// Delay between starting probes of successive routes.
    public var probeStagger: Duration
    public var backoff: Backoff
    /// A connection that lasts at least this long resets the backoff when it
    /// drops; a shorter one counts as a failure.
    public var stableConnection: Duration
    public var socket: RpcSocket.Configuration
    /// A cached ticket is reused until this close to its expiry.
    public var ticketReuseMargin: TimeInterval
    /// Query parameters after `wsTicket` and `orchestrationProtocol`.
    public var clientParameters: [(String, String)]
    public var sleepBeforeRetry: @Sendable (Duration) async throws -> Void
    public var random: @Sendable () -> Double
    public var now: @Sendable () -> Date

    public init(
      probeStagger: Duration = .milliseconds(300),
      backoff: Backoff = Backoff(),
      stableConnection: Duration = .seconds(10),
      socket: RpcSocket.Configuration = RpcSocket.Configuration(),
      ticketReuseMargin: TimeInterval = 30,
      clientParameters: [(String, String)] = MachineConnection.defaultClientParameters,
      sleepBeforeRetry: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
      random: @escaping @Sendable () -> Double = { Double.random(in: 0..<1) },
      now: @escaping @Sendable () -> Date = { Date() }
    ) {
      self.probeStagger = probeStagger
      self.backoff = backoff
      self.stableConnection = stableConnection
      self.socket = socket
      self.ticketReuseMargin = ticketReuseMargin
      self.clientParameters = clientParameters
      self.sleepBeforeRetry = sleepBeforeRetry
      self.random = random
      self.now = now
    }
  }

  public static let defaultClientParameters: [(String, String)] = [
    ("clientSurface", "mobile"),
    ("clientOs", "iOS"),
    ("clientDeviceType", "phone"),
    ("connectionMethod", "direct"),
  ]

  static let log = Logger(subsystem: "com.specwithcode.ios", category: "connection")

  public nonisolated let environmentId: String
  public private(set) var record: MachineRecord
  public private(set) var status: Status
  /// The live socket, while connected.
  public private(set) var socket: RpcSocket?

  private let credentials: any CredentialStore
  private let http: MachineHTTP
  private let connector: any WebSocketConnector
  private let configuration: Configuration
  private let authorizer: (any ConnectAuthorizing)?

  private var active = false
  private var generation = 0
  private var loop: Task<Void, Never>?
  private var failures = 0
  private var everConnected = false
  private var backingOff = false
  /// The last ticket and the issuer of the token that bought it; a ticket
  /// only goes back to routes of the same issuer.
  private var cachedTicket: (issuer: String, ticket: WebSocketTicket)?
  private var statusObservers: [UUID: AsyncStream<Status>.Continuation] = [:]
  private var socketObservers: [UUID: AsyncStream<RpcSocket>.Continuation] = [:]

  public init(
    record: MachineRecord,
    credentials: any CredentialStore,
    http: MachineHTTP = MachineHTTP(),
    connector: any WebSocketConnector = URLSessionWebSocketConnector(),
    configuration: Configuration = Configuration(),
    authorizer: (any ConnectAuthorizing)? = nil
  ) {
    self.environmentId = record.environmentId
    self.record = record
    self.credentials = credentials
    self.http = http
    self.connector = connector
    self.configuration = configuration
    self.authorizer = authorizer
    self.status = Status(state: .offline)
  }

  // MARK: - Observation

  /// Every status change, starting with the current one.
  public func statusUpdates() -> AsyncStream<Status> {
    let (stream, continuation) = AsyncStream.makeStream(of: Status.self, bufferingPolicy: .bufferingNewest(32))
    let id = UUID()
    statusObservers[id] = continuation
    continuation.yield(status)
    continuation.onTermination = { [weak self] _ in
      Task { await self?.removeStatusObserver(id) }
    }
    return stream
  }

  /// Each socket as it connects, starting with the current one. Subscribe
  /// (or resubscribe) on every value; the previous socket is closed by then.
  public func connectedSockets() -> AsyncStream<RpcSocket> {
    let (stream, continuation) = AsyncStream.makeStream(of: RpcSocket.self, bufferingPolicy: .unbounded)
    let id = UUID()
    socketObservers[id] = continuation
    if let socket { continuation.yield(socket) }
    continuation.onTermination = { [weak self] _ in
      Task { await self?.removeSocketObserver(id) }
    }
    return stream
  }

  /// Days until the token of the route in use expires (else of the best
  /// route holding one), or nil without one.
  public func tokenDaysLeft() -> Int? {
    let routes = (status.route.map { [$0] } ?? []) + record.rankedRoutes
    for route in routes {
      if let credential = try? credentials.credential(for: route, of: environmentId) {
        return credential.daysLeft(now: configuration.now())
      }
    }
    return nil
  }

  /// The route a socket was opened on, while it is the live socket.
  public func route(of socket: RpcSocket) -> MachineRoute? {
    guard let current = self.socket, current === socket else { return nil }
    return status.route
  }

  // MARK: - Control

  /// Foreground (true) connects now; background (false) closes the socket.
  public func setActive(_ value: Bool) {
    if value {
      let wasActive = active
      active = true
      // Leave a live socket or an attempt in flight alone; cut a backoff short.
      if wasActive, socket != nil || (loop != nil && !backingOff) { return }
      failures = 0
      restart()
    } else {
      guard active else { return }
      active = false
      stopLoop()
      setStatus(Status(state: .offline, route: status.route, descriptor: status.descriptor, tokenDaysLeft: status.tokenDaysLeft))
    }
  }

  /// Tries again now, also after "Pair again" or "Update needed". Closes a live socket first.
  public func reconnect() {
    failures = 0
    cachedTicket = nil
    guard active else { return }
    restart()
  }

  /// The network path changed: skip the rest of the backoff.
  public func networkChanged() {
    guard active, socket == nil, backingOff || loop == nil, status.state != .needsRepair, status.state != .unsupported else { return }
    failures = 0
    restart()
  }

  /// New routes or the enabled flag from the registry. Takes effect on the next attempt.
  public func update(_ record: MachineRecord) {
    let wasEnabled = self.record.enabled
    self.record = record
    if !record.enabled {
      stopLoop()
      setStatus(Status(state: .offline, route: status.route, descriptor: status.descriptor, tokenDaysLeft: status.tokenDaysLeft))
    } else if !wasEnabled, active {
      failures = 0
      restart()
    }
  }

  /// Checks the token after an authorization error on a live socket. A revoked
  /// session leaves sockets open, so this is how a revoke is noticed.
  public func verifySession() async {
    guard let route = status.route, let credential = try? credentials.credential(for: route, of: environmentId) else { return }
    if route.issuer == ConnectAuthorizer.issuer {
      // A Connect token is DPoP-bound; reconnecting asks the relay again if it was revoked.
      reconnect()
      return
    }
    let gen = generation
    do {
      let session = try await http.session(token: credential.token, at: route.httpBase)
      guard gen == generation, !session.authenticated else { return }
    } catch TransportError.needsRepair {
      guard gen == generation else { return }
    } catch {
      return
    }
    halt(.needsRepair, error: .needsRepair)
  }

  // MARK: - Supervisor

  private func restart() {
    stopLoop()
    guard active, record.enabled else { return }
    let gen = generation
    loop = Task { await self.run(gen) }
  }

  private func stopLoop() {
    generation += 1
    loop?.cancel()
    loop = nil
    backingOff = false
    if let socket {
      self.socket = nil
      Task { await socket.close() }
    }
  }

  private func halt(_ state: State, error: TransportError) {
    stopLoop()
    var next = status
    next.state = state
    next.lastError = error
    next.retryAt = nil
    if case let .appTooOld(descriptor) = error { next.descriptor = descriptor }
    if case let .serverTooOld(descriptor) = error { next.descriptor = descriptor }
    setStatus(next)
  }

  private func run(_ gen: Int) async {
    while gen == generation, !Task.isCancelled {
      var attempt = status
      attempt.state = attemptState()
      attempt.retryAt = nil
      setStatus(attempt)
      do {
        let (socket, route, descriptor, credential) = try await establish(gen)
        guard gen == generation else {
          await socket.close()
          return
        }
        everConnected = true
        self.socket = socket
        let connectedAt = configuration.now()
        setStatus(Status(state: .connected, route: route, descriptor: descriptor, tokenDaysLeft: credential.daysLeft(now: configuration.now())))
        for observer in socketObservers.values { observer.yield(socket) }

        let reason = await socket.waitUntilClosed()
        guard gen == generation else { return }
        self.socket = nil
        // The reason can quote the failing URL, which carries the ticket.
        Self.log.notice("Socket to \(self.environmentId, privacy: .public) closed: \(String(describing: reason), privacy: .private)")
        if configuration.now().timeIntervalSince(connectedAt) >= configuration.stableConnection.timeInterval {
          failures = 0
        } else {
          // Dropped right after connecting: keep counting so a flapping server backs off.
          failures += 1
          try await backOff(gen, error: .closed)
        }
      } catch {
        // A stop or restart cancels this loop; anything else is a failed attempt.
        guard gen == generation, !Task.isCancelled else { return }
        let failure = Self.transportError(error)
        switch failure {
        case .needsRepair:
          halt(.needsRepair, error: failure)
          return
        case let .connect(connectError) where connectError.isPermanent:
          halt(.needsRepair, error: failure)
          return
        case .appTooOld, .serverTooOld:
          halt(.unsupported, error: failure)
          return
        default:
          failures += 1
          do { try await backOff(gen, error: failure) } catch { return }
        }
      }
    }
  }

  private func backOff(_ gen: Int, error: TransportError) async throws {
    let delay = configuration.backoff.delay(afterFailures: failures, random: configuration.random())
    var next = status
    next.state = backoffState()
    next.lastError = error
    next.retryAt = configuration.now().addingTimeInterval(delay.timeInterval)
    setStatus(next)
    backingOff = true
    defer { if gen == generation { backingOff = false } }
    try await configuration.sleepBeforeRetry(delay)
    guard gen == generation else { throw CancellationError() }
  }

  private func attemptState() -> State {
    if failures == 0 { return everConnected ? .reconnecting : .connecting }
    return backoffState()
  }

  private func backoffState() -> State {
    everConnected && failures < 3 ? .reconnecting : .offline
  }

  static func transportError(_ error: Error) -> TransportError {
    if let transport = error as? TransportError { return transport }
    if let connect = error as? ConnectError {
      return connect.isOffline ? .unreachable("Offline") : .connect(connect)
    }
    return .unreachable(error.redactedDescription)
  }

  /// Direct routes first when the record has paired ones; the Connect tunnel
  /// when there are none or none of them answered.
  private func establish(_ gen: Int) async throws -> (RpcSocket, MachineRoute, EnvironmentDescriptorLite, MachineCredential) {
    guard let authorizer, let connectRoute = record.connectRoute else {
      return try await establishDirect(gen)
    }
    if !record.routes.isEmpty {
      do {
        return try await establishDirect(gen)
      } catch is CancellationError {
        throw CancellationError()
      } catch {
        try check(gen)
        switch error as? TransportError {
        case .appTooOld?, .serverTooOld?: throw error
        default: break
        }
      }
    }
    return try await establishConnect(gen, route: connectRoute, authorizer: authorizer)
  }

  private func establishConnect(_ gen: Int, route: MachineRoute, authorizer: any ConnectAuthorizing) async throws -> (RpcSocket, MachineRoute, EnvironmentDescriptorLite, MachineCredential) {
    let descriptor = try await http.descriptor(at: route.httpBase, expectedEnvironmentId: environmentId)
    try check(gen)
    var progress = status
    progress.route = route
    progress.descriptor = descriptor
    setStatus(progress)

    // A cached token the machine no longer accepts gets one fresh credential.
    var refresh = false
    while true {
      let (credential, key) = try await authorizer.credential(for: environmentId, at: route, refresh: refresh)
      try check(gen)
      let ticket: WebSocketTicket
      do {
        ticket = try await http.dpopWebsocketTicket(token: credential.token, key: key, at: route.httpBase)
      } catch TransportError.needsRepair where !refresh {
        refresh = true
        continue
      } catch TransportError.http(status: 401, code: _) where !refresh {
        refresh = true
        continue
      }
      try check(gen)
      guard let url = Self.socketURL(wsBase: route.wsBase, ticket: ticket.ticket, parameters: Self.relayParameters(configuration.clientParameters)) else {
        throw TransportError.invalidAddress(route.wsBase.absoluteString)
      }
      let connection = try await connector.connect(to: url)
      guard gen == generation else {
        connection.close()
        throw CancellationError()
      }
      let socket = RpcSocket(connection: connection, configuration: configuration.socket)
      await socket.start()
      return (socket, route, descriptor, credential)
    }
  }

  /// The client parameters with `connectionMethod=relay`.
  static func relayParameters(_ parameters: [(String, String)]) -> [(String, String)] {
    parameters.filter { $0.0 != "connectionMethod" } + [("connectionMethod", "relay")]
  }

  private func establishDirect(_ gen: Int) async throws -> (RpcSocket, MachineRoute, EnvironmentDescriptorLite, MachineCredential) {
    // Only routes holding an unexpired token from their own issuer are tried,
    // and each gets only that token.
    let now = configuration.now()
    var candidates: [(route: MachineRoute, credential: MachineCredential)] = []
    do {
      for route in record.rankedRoutes {
        if let credential = try credentials.credential(for: route, of: environmentId), !credential.isExpired(now: now) {
          candidates.append((route, credential))
        }
      }
    } catch {
      // The Keychain is unreadable while the device is locked; try again later.
      throw TransportError.unreachable("Credential unavailable: \(error.redactedDescription)")
    }
    guard !candidates.isEmpty else { throw TransportError.needsRepair }

    let (index, descriptor) = try await probe(candidates.map(\.route))
    let (route, credential) = candidates[index]
    try check(gen)
    var progress = status
    progress.route = route
    progress.descriptor = descriptor
    setStatus(progress)

    let ticket = try await ticket(token: credential.token, at: route)
    try check(gen)
    guard let url = Self.socketURL(wsBase: route.wsBase, ticket: ticket.ticket, parameters: configuration.clientParameters) else {
      throw TransportError.invalidAddress(route.wsBase.absoluteString)
    }

    let connection: any WebSocketConnection
    do {
      connection = try await connector.connect(to: url)
    } catch let TransportError.upgradeFailed(status) {
      cachedTicket = nil
      try check(gen)
      throw await diagnoseUpgradeFailure(status: status, route: route, token: credential.token)
    }
    guard gen == generation else {
      connection.close()
      throw CancellationError()
    }
    let socket = RpcSocket(connection: connection, configuration: configuration.socket)
    await socket.start()
    return (socket, route, descriptor, credential)
  }

  private func check(_ gen: Int) throws {
    if gen != generation || Task.isCancelled { throw CancellationError() }
  }

  /// Probes routes in rank order, starting one every `probeStagger`. The first
  /// descriptor with the expected environment id wins; returns its index.
  private func probe(_ routes: [MachineRoute]) async throws -> (Int, EnvironmentDescriptorLite) {
    let http = self.http
    let expected = environmentId
    let stagger = configuration.probeStagger
    return try await withThrowingTaskGroup(of: (Int, Result<EnvironmentDescriptorLite, Error>).self) { group in
      for (index, route) in routes.enumerated() {
        group.addTask {
          if index > 0 { try await Task.sleep(for: stagger * index) }
          do {
            return (index, .success(try await http.descriptor(at: route.httpBase, expectedEnvironmentId: expected)))
          } catch {
            return (index, .failure(error))
          }
        }
      }
      var errors: [Int: Error] = [:]
      while let (index, result) = try await group.next() {
        switch result {
        case let .success(descriptor):
          group.cancelAll()
          return (index, descriptor)
        case let .failure(error):
          if let transport = error as? TransportError {
            switch transport {
            case .appTooOld, .serverTooOld:
              group.cancelAll()
              throw transport
            default:
              break
            }
          }
          errors[index] = error
        }
      }
      try Task.checkCancellation()
      throw errors.min(by: { $0.key < $1.key })?.value ?? TransportError.unreachable("No route answered")
    }
  }

  private func ticket(token: String, at route: MachineRoute) async throws -> WebSocketTicket {
    if let cachedTicket, cachedTicket.issuer == route.issuer, let expiresAt = cachedTicket.ticket.expiresAt,
       expiresAt.timeIntervalSince(configuration.now()) > configuration.ticketReuseMargin {
      return cachedTicket.ticket
    }
    let ticket = try await http.websocketTicket(token: token, at: route.httpBase)
    cachedTicket = (route.issuer, ticket)
    return ticket
  }

  /// Tells a revoked token or a changed protocol from a transient refusal.
  private func diagnoseUpgradeFailure(status: Int?, route: MachineRoute, token: String) async -> Error {
    let original = TransportError.upgradeFailed(status: status)
    do {
      let session = try await http.session(token: token, at: route.httpBase)
      if !session.authenticated { return TransportError.needsRepair }
    } catch TransportError.needsRepair {
      return TransportError.needsRepair
    } catch {
      return original
    }
    do {
      _ = try await http.descriptor(at: route.httpBase, expectedEnvironmentId: environmentId)
    } catch let error as TransportError {
      switch error {
      case .appTooOld, .serverTooOld: return error
      default: return original
      }
    } catch {
      return original
    }
    return original
  }

  /// `ws(s)://host/ws?wsTicket=…&orchestrationProtocol=2&…`
  public static func socketURL(wsBase: URL, ticket: String, parameters: [(String, String)] = defaultClientParameters) -> URL? {
    guard var components = URLComponents(url: wsBase, resolvingAgainstBaseURL: false) else { return nil }
    components.path = "/ws"
    components.fragment = nil
    components.percentEncodedQuery = FormQuery.encode(
      [("wsTicket", ticket), ("orchestrationProtocol", String(EnvironmentDescriptorLite.supportedProtocolVersion))] + parameters
    )
    return components.url
  }

  private func setStatus(_ next: Status) {
    guard next != status else { return }
    status = next
    for observer in statusObservers.values { observer.yield(next) }
  }

  private func removeStatusObserver(_ id: UUID) {
    statusObservers[id] = nil
  }

  private func removeSocketObserver(_ id: UUID) {
    socketObservers[id] = nil
  }
}
