import Foundation
import SWCWire

/// Sends one HTTP request. Swapped for a fake in tests.
public protocol HTTPTransport: Sendable {
  func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

/// `URLSession` without cookies or caching: the server must see only the bearer token.
public struct URLSessionHTTPTransport: HTTPTransport {
  public let session: URLSession

  public init(session: URLSession? = nil) {
    if let session {
      self.session = session
    } else {
      let config = URLSessionConfiguration.ephemeral
      config.httpCookieAcceptPolicy = .never
      config.httpShouldSetCookies = false
      config.requestCachePolicy = .reloadIgnoringLocalCacheData
      config.urlCache = nil
      config.waitsForConnectivity = false
      self.session = URLSession(configuration: config)
    }
  }

  public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse else {
      throw TransportError.invalidResponse("Not an HTTP response")
    }
    return (data, http)
  }
}

/// A bearer token from `POST /oauth/token`. It lasts 30 days and cannot be refreshed.
public struct TokenGrant: Sendable, Hashable {
  public var accessToken: String
  public var expiresAt: Date
  public var scopes: [String]

  public init(accessToken: String, expiresAt: Date, scopes: [String]) {
    self.accessToken = accessToken
    self.expiresAt = expiresAt
    self.scopes = scopes
  }
}

/// A short-lived ticket for `/ws?wsTicket=`. It can be reused until it expires.
public struct WebSocketTicket: Sendable, Hashable {
  public var ticket: String
  public var expiresAt: Date?

  public init(ticket: String, expiresAt: Date?) {
    self.ticket = ticket
    self.expiresAt = expiresAt
  }
}

/// `GET /api/auth/session`.
public struct SessionState: Sendable, Hashable {
  public var authenticated: Bool
  public var permissions: [String]
  public var expiresAt: Date?

  public init(authenticated: Bool, permissions: [String], expiresAt: Date? = nil) {
    self.authenticated = authenticated
    self.permissions = permissions
    self.expiresAt = expiresAt
  }
}

/// The plain HTTP endpoints of one machine.
public struct MachineHTTP: Sendable {
  public static let tokenExchangeGrantType = "urn:ietf:params:oauth:grant-type:token-exchange"
  public static let bootstrapTokenType = "urn:specweave-studio:params:oauth:token-type:environment-bootstrap"
  public static let accessTokenType = "urn:ietf:params:oauth:token-type:access_token"
  /// Token lifetime when the server leaves out `expires_in`.
  static let defaultTokenLifetime: TimeInterval = 30 * 86_400

  public let transport: any HTTPTransport
  public let descriptorTimeout: Duration
  public let requestTimeout: Duration
  let now: @Sendable () -> Date

  public init(
    transport: any HTTPTransport = URLSessionHTTPTransport(),
    descriptorTimeout: Duration = .seconds(5),
    requestTimeout: Duration = .seconds(15),
    now: @escaping @Sendable () -> Date = { Date() }
  ) {
    self.transport = transport
    self.descriptorTimeout = descriptorTimeout
    self.requestTimeout = requestTimeout
    self.now = now
  }

  /// Fetches the descriptor and requires protocol 2. With `expectedEnvironmentId`,
  /// an answer from another machine fails before anything else is checked.
  public func descriptor(at httpBase: URL, expectedEnvironmentId: String? = nil) async throws -> EnvironmentDescriptorLite {
    let descriptor = try await rawDescriptor(at: httpBase)
    if let expectedEnvironmentId, descriptor.environmentId != expectedEnvironmentId {
      throw TransportError.environmentMismatch(expected: expectedEnvironmentId, actual: descriptor.environmentId)
    }
    switch descriptor.protocolCompatibility {
    case .compatible: return descriptor
    case .appTooOld: throw TransportError.appTooOld(descriptor)
    case .serverTooOld: throw TransportError.serverTooOld(descriptor)
    }
  }

  /// The descriptor without the version check.
  public func rawDescriptor(at httpBase: URL) async throws -> EnvironmentDescriptorLite {
    var request = try makeRequest(httpBase, "/.well-known/studio/environment", timeout: descriptorTimeout)
    request.httpMethod = "GET"
    let data = try await perform(request, timeout: descriptorTimeout, authenticated: false)
    return try decode(EnvironmentDescriptorLite.self, from: data)
  }

  /// Spends a one-time pairing code for a bearer token.
  public func exchangePairingCode(_ code: String, at httpBase: URL, clientLabel: String) async throws -> TokenGrant {
    var request = try makeRequest(httpBase, "/oauth/token", timeout: requestTimeout)
    request.httpMethod = "POST"
    request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
    request.httpBody = Data(Self.tokenExchangeBody(code: code, clientLabel: clientLabel).utf8)
    let data: Data
    do {
      data = try await perform(request, timeout: requestTimeout, authenticated: false)
    } catch TransportError.http(status: 401, code: _) {
      throw TransportError.pairingCodeRejected
    } catch TransportError.needsRepair {
      throw TransportError.pairingCodeRejected
    }
    let body = try decode(TokenResponse.self, from: data)
    let lifetime = body.expires_in ?? Self.defaultTokenLifetime
    let scopes = (body.scope ?? "").split(separator: " ").map(String.init)
    return TokenGrant(accessToken: body.access_token, expiresAt: now().addingTimeInterval(lifetime), scopes: scopes)
  }

  /// The form body for `POST /oauth/token`, encoded like `URLSearchParams`.
  public static func tokenExchangeBody(code: String, clientLabel: String) -> String {
    FormQuery.encode([
      ("grant_type", tokenExchangeGrantType),
      ("subject_token", code),
      ("subject_token_type", bootstrapTokenType),
      ("requested_token_type", accessTokenType),
      ("client_device_type", "mobile"),
      ("client_os", "iOS"),
      ("client_label", clientLabel),
    ])
  }

  public func websocketTicket(token: String, at httpBase: URL) async throws -> WebSocketTicket {
    var request = try makeRequest(httpBase, "/api/auth/websocket-ticket", timeout: requestTimeout)
    request.httpMethod = "POST"
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    let data = try await perform(request, timeout: requestTimeout, authenticated: true)
    let body = try decode(TicketResponse.self, from: data)
    return WebSocketTicket(ticket: body.ticket, expiresAt: body.expiresAt.flatMap(WireCoding.parseDate))
  }

  /// Spends a one-time SpecWithCode Connect credential. The machine accepts
  /// it only with a DPoP proof from the key the relay bound it to, and the
  /// token it returns is bound to the same key.
  public func redeemConnectCredential(_ credential: String, at httpBase: URL, clientLabel: String, key: any DpopKey) async throws -> TokenGrant {
    var request = try makeRequest(httpBase, "/oauth/token", timeout: requestTimeout)
    request.httpMethod = "POST"
    request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
    request.setValue(try DpopProof.make(key: key, method: "POST", url: request.url!, now: now()), forHTTPHeaderField: "DPoP")
    request.httpBody = Data(Self.tokenExchangeBody(code: credential, clientLabel: clientLabel).utf8)
    let data: Data
    do {
      data = try await perform(request, timeout: requestTimeout, authenticated: false)
    } catch TransportError.http(status: 401, code: _) {
      throw TransportError.pairingCodeRejected
    }
    let body = try decode(TokenResponse.self, from: data)
    let lifetime = body.expires_in ?? Self.defaultTokenLifetime
    let scopes = (body.scope ?? "").split(separator: " ").map(String.init)
    return TokenGrant(accessToken: body.access_token, expiresAt: now().addingTimeInterval(lifetime), scopes: scopes)
  }

  /// A WebSocket ticket for a DPoP-bound token.
  public func dpopWebsocketTicket(token: String, key: any DpopKey, at httpBase: URL) async throws -> WebSocketTicket {
    var request = try makeRequest(httpBase, "/api/auth/websocket-ticket", timeout: requestTimeout)
    request.httpMethod = "POST"
    request.setValue("DPoP \(token)", forHTTPHeaderField: "Authorization")
    request.setValue(try DpopProof.make(key: key, method: "POST", url: request.url!, accessToken: token, now: now()), forHTTPHeaderField: "DPoP")
    let data = try await perform(request, timeout: requestTimeout, authenticated: true)
    let body = try decode(TicketResponse.self, from: data)
    return WebSocketTicket(ticket: body.ticket, expiresAt: body.expiresAt.flatMap(WireCoding.parseDate))
  }

  /// Whether the token is still accepted. A rejected token comes back as
  /// `authenticated == false` or as `TransportError.needsRepair`.
  public func session(token: String, at httpBase: URL) async throws -> SessionState {
    var request = try makeRequest(httpBase, "/api/auth/session", timeout: requestTimeout)
    request.httpMethod = "GET"
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    let data = try await perform(request, timeout: requestTimeout, authenticated: true)
    let body = try decode(SessionResponse.self, from: data)
    return SessionState(
      authenticated: body.authenticated,
      permissions: body.permissions ?? body.scopes ?? [],
      expiresAt: body.expiresAt.flatMap(WireCoding.parseDate)
    )
  }

  // MARK: - Plumbing

  private struct TokenResponse: Decodable {
    let access_token: String
    let expires_in: Double?
    let scope: String?
  }

  private struct TicketResponse: Decodable {
    let ticket: String
    let expiresAt: String?
  }

  private struct SessionResponse: Decodable {
    let authenticated: Bool
    let permissions: [String]?
    let scopes: [String]?
    let expiresAt: String?
  }

  private struct ErrorBody: Decodable {
    let code: String?
    let reason: String?
  }

  func makeRequest(_ base: URL, _ path: String, timeout: Duration) throws -> URLRequest {
    guard var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else {
      throw TransportError.invalidAddress(base.absoluteString)
    }
    components.path = path
    components.query = nil
    components.fragment = nil
    guard let url = components.url else { throw TransportError.invalidAddress(base.absoluteString) }
    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout.timeInterval)
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    return request
  }

  /// Runs the request under a hard deadline and maps failures. `authenticated`
  /// requests turn a 401 `invalid_credential` into `.needsRepair`.
  func perform(_ request: URLRequest, timeout: Duration, authenticated: Bool) async throws -> Data {
    let transport = self.transport
    let (data, response): (Data, HTTPURLResponse)
    do {
      (data, response) = try await withDeadline(timeout) { try await transport.send(request) }
    } catch let error as TransportError {
      throw error
    } catch is CancellationError {
      throw CancellationError()
    } catch let error as URLError {
      throw Self.map(error)
    } catch {
      throw TransportError.unreachable(error.redactedDescription)
    }
    guard (200..<300).contains(response.statusCode) else {
      let body = try? JSONDecoder().decode(ErrorBody.self, from: data)
      if authenticated, response.statusCode == 401, body?.reason == "invalid_credential" || body?.reason == nil {
        throw TransportError.needsRepair
      }
      throw TransportError.http(status: response.statusCode, code: body?.reason ?? body?.code)
    }
    return data
  }

  static func map(_ error: URLError) -> Error {
    switch error.code {
    case .cancelled: CancellationError()
    case .timedOut: TransportError.timedOut
    default: TransportError.unreachable(error.localizedDescription)
    }
  }

  func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
    do {
      return try JSONDecoder().decode(T.self, from: data)
    } catch {
      throw TransportError.invalidResponse(String(describing: error))
    }
  }
}

/// Runs `operation`, failing with `TransportError.timedOut` after `timeout`.
func withDeadline<T: Sendable>(_ timeout: Duration, _ operation: @escaping @Sendable () async throws -> T) async throws -> T {
  try await withThrowingTaskGroup(of: T.self) { group in
    group.addTask { try await operation() }
    group.addTask {
      try await Task.sleep(for: timeout)
      throw TransportError.timedOut
    }
    defer { group.cancelAll() }
    guard let result = try await group.next() else { throw CancellationError() }
    return result
  }
}

extension Duration {
  var timeInterval: TimeInterval {
    let (seconds, attoseconds) = components
    return TimeInterval(seconds) + TimeInterval(attoseconds) / 1e18
  }
}
