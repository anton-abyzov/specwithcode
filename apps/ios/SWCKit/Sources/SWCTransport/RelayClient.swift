import Foundation

/// The Clerk session behind SpecWithCode Connect. The app target implements it
/// with the Clerk SDK; SWCKit only needs the session JWT.
public protocol ConnectSessionTokenProvider: Sendable {
  /// A Clerk session JWT from the relay's JWT template, nil when signed out.
  /// `refresh` skips any cached token.
  func sessionToken(refresh: Bool) async throws -> String?
}

/// A machine linked to the signed-in account (`GET /v1/environments`).
public struct ConnectEnvironment: Sendable, Hashable, Codable, Identifiable {
  public var environmentId: String
  public var label: String
  public var endpoint: ConnectEndpoint
  public var linkedAt: String?

  public var id: String { environmentId }

  public init(environmentId: String, label: String, endpoint: ConnectEndpoint, linkedAt: String? = nil) {
    self.environmentId = environmentId
    self.label = label
    self.endpoint = endpoint
    self.linkedAt = linkedAt
  }
}

/// The machine's managed tunnel hostname.
public struct ConnectEndpoint: Sendable, Hashable, Codable {
  public var httpBaseUrl: String
  public var wsBaseUrl: String
  public var providerKind: String?

  public init(httpBaseUrl: String, wsBaseUrl: String, providerKind: String? = nil) {
    self.httpBaseUrl = httpBaseUrl
    self.wsBaseUrl = wsBaseUrl
    self.providerKind = providerKind
  }

  public var httpBase: URL? { URL(string: httpBaseUrl) }
  public var wsBase: URL? { URL(string: wsBaseUrl) }
}

/// `POST /v1/environments/:id/status`.
public struct ConnectEnvironmentStatus: Sendable, Hashable, Decodable {
  public var environmentId: String
  public var status: String
  /// When the relay last probed the machine. The relay keeps no last-seen time.
  public var checkedAt: String
  public var offlineReason: String?
  public var error: String?

  public var isOnline: Bool { status == "online" }
}

/// `POST /v1/environments/:id/connect`: a one-time credential the machine
/// accepts only with a DPoP proof from the key it was issued to.
public struct ConnectBootstrap: Sendable, Hashable, Decodable {
  public var environmentId: String
  public var endpoint: ConnectEndpoint
  public var credential: String
  public var expiresAt: String
}

/// `POST /v1/mobile/devices`. Field names follow `RelayDeviceRegistrationRequest`.
public struct ConnectDeviceRegistration: Sendable, Hashable, Codable {
  public struct Preferences: Sendable, Hashable, Codable {
    public var liveActivitiesEnabled: Bool
    public var notificationsEnabled: Bool
    public var notifyOnApproval: Bool
    public var notifyOnInput: Bool
    public var notifyOnCompletion: Bool
    public var notifyOnFailure: Bool

    public init(notificationsEnabled: Bool, liveActivitiesEnabled: Bool = false, notifyOnApproval: Bool = true, notifyOnInput: Bool = true, notifyOnCompletion: Bool = true, notifyOnFailure: Bool = true) {
      self.liveActivitiesEnabled = liveActivitiesEnabled
      self.notificationsEnabled = notificationsEnabled
      self.notifyOnApproval = notifyOnApproval
      self.notifyOnInput = notifyOnInput
      self.notifyOnCompletion = notifyOnCompletion
      self.notifyOnFailure = notifyOnFailure
    }
  }

  public var deviceId: String
  public var label: String
  public var platform = "ios"
  public var iosMajorVersion: Int
  public var appVersion: String?
  public var bundleId: String?
  /// `sandbox` or `production`.
  public var apsEnvironment: String?
  public var pushToken: String?
  public var preferences: Preferences

  public init(deviceId: String, label: String, iosMajorVersion: Int, appVersion: String?, bundleId: String?, apsEnvironment: String?, pushToken: String?, preferences: Preferences) {
    self.deviceId = deviceId
    self.label = label
    self.iosMajorVersion = iosMajorVersion
    self.appVersion = appVersion
    self.bundleId = bundleId
    self.apsEnvironment = apsEnvironment
    self.pushToken = pushToken
    self.preferences = preferences
  }
}

/// A failed relay call. `code` and `reason` come from the relay's error body.
public enum ConnectError: Error, Sendable, Hashable {
  /// No Clerk session: the person signed out or the session ended.
  case signedOut
  case relay(status: Int, code: String?, reason: String?)
  case unreachable(String)
  case invalidResponse(String)
}

/// `DELETE /v1/client/account`.
public struct ConnectAccountDeletion: Sendable, Hashable, Decodable {
  public var deleted: Bool
  /// Computers unlinked and tunnels removed by this request.
  public var environmentCount: Int
}

extension ConnectError {
  /// Retrying without the person doing something will not help.
  public var isPermanent: Bool {
    switch self {
    case .signedOut: true
    case let .relay(_, code, _): code == "environment_connect_not_authorized"
    default: false
    }
  }

  /// Account deletion stopped partway and is safe to run again.
  var isRetryableDeletion: Bool {
    if case let .relay(status, _, reason) = self { return status == 500 && reason == RelayClient.upstreamUnavailable }
    return false
  }

  /// The machine is offline rather than broken.
  public var isOffline: Bool {
    switch self {
    case let .relay(_, code, _): code == "environment_endpoint_unavailable" || code == "environment_endpoint_timed_out"
    default: false
    }
  }
}

extension ConnectError: LocalizedError {
  public var errorDescription: String? {
    switch self {
    case .signedOut:
      "Sign in to reach your computers."
    case let .relay(_, code, reason):
      switch (code, reason) {
      case ("environment_connect_not_authorized", "environment_link_not_found"?):
        "This computer is no longer linked to your account."
      case ("environment_connect_not_authorized", _):
        "This computer is not ready for SpecWithCode Connect yet. Update SpecWithCode on it and try again."
      case ("environment_endpoint_unavailable", _), ("environment_endpoint_timed_out", _):
        "The computer is offline."
      case ("auth_invalid", _):
        "Your sign-in expired. Sign in again."
      default:
        "SpecWithCode Connect is not available right now."
      }
    case .unreachable:
      "SpecWithCode Connect could not be reached. Check your connection."
    case .invalidResponse:
      "SpecWithCode Connect sent an answer the app could not read."
    }
  }
}

/// Talks to the SpecWithCode Connect relay: exchanges the Clerk session for
/// DPoP-bound relay tokens, lists linked machines and asks for one-time
/// machine credentials. The relay never carries machine traffic.
public actor RelayClient {
  public static let connectScope = "environment:connect"
  public static let statusScope = "environment:status"
  public static let registrationScope = "mobile:registration"
  public static let clientId = "studio-mobile"
  static let upstreamUnavailable = "upstream_unavailable"
  static let subjectTokenType = "urn:ietf:params:oauth:token-type:jwt"
  /// A relay token is renewed this long before it expires.
  static let refreshSkew: TimeInterval = 60

  public nonisolated let config: ConnectConfig
  public nonisolated let keys: any DpopKeyStore
  private let session: any ConnectSessionTokenProvider
  private let transport: any HTTPTransport
  private let timeout: Duration
  private let now: @Sendable () -> Date
  private var tokens: [String: (token: String, expiresAt: Date, thumbprint: String)] = [:]

  public init(
    config: ConnectConfig,
    session: any ConnectSessionTokenProvider,
    keys: any DpopKeyStore = KeychainDpopKeyStore(),
    transport: any HTTPTransport = URLSessionHTTPTransport(),
    timeout: Duration = .seconds(15),
    now: @escaping @Sendable () -> Date = { Date() }
  ) {
    self.config = config
    self.session = session
    self.keys = keys
    self.transport = transport
    self.timeout = timeout
    self.now = now
  }

  /// The DPoP key's thumbprint, which tokens and credentials are bound to.
  public func thumbprint() throws -> String {
    try keys.loadOrCreate().thumbprint
  }

  /// Forgets cached relay tokens, e.g. after sign-out.
  public func reset() {
    tokens = [:]
  }

  // MARK: - Environments

  public func environments() async throws -> [ConnectEnvironment] {
    struct Response: Decodable { let environments: [ConnectEnvironment] }
    return try decode(Response.self, from: await bearerRequest(path: "/v1/environments", method: "GET")).environments
  }

  public func status(of environmentId: String) async throws -> ConnectEnvironmentStatus {
    let data = try await dpopRequest(path: "/v1/environments/\(Self.escape(environmentId))/status", method: "POST", scopes: [Self.statusScope], body: Data("{}".utf8))
    return try decode(ConnectEnvironmentStatus.self, from: data)
  }

  /// A one-time credential for the machine, bound to this device's key.
  public func connect(_ environmentId: String, deviceId: String?) async throws -> ConnectBootstrap {
    struct Body: Encodable {
      let deviceId: String?
      let clientProofKeyThumbprint: String
    }
    let body = try JSONEncoder().encode(Body(deviceId: deviceId, clientProofKeyThumbprint: try thumbprint()))
    let data = try await dpopRequest(path: "/v1/environments/\(Self.escape(environmentId))/connect", method: "POST", scopes: [Self.connectScope], body: body)
    let bootstrap = try decode(ConnectBootstrap.self, from: data)
    guard bootstrap.environmentId == environmentId else {
      throw ConnectError.invalidResponse("The relay answered for another computer.")
    }
    return bootstrap
  }

  // MARK: - Mobile devices

  public func registerDevice(_ registration: ConnectDeviceRegistration) async throws {
    let body = try JSONEncoder().encode(registration)
    _ = try await dpopRequest(path: "/v1/mobile/devices", method: "POST", scopes: [Self.registrationScope], body: body)
  }

  public func unregisterDevice(_ deviceId: String) async throws {
    _ = try await dpopRequest(path: "/v1/mobile/devices/\(Self.escape(deviceId))", method: "DELETE", scopes: [Self.registrationScope], body: nil)
  }

  // MARK: - Account

  /// `DELETE /v1/client/account`: the relay unlinks every computer, removes
  /// this account's devices and push registrations, then deletes the Clerk
  /// user. It is idempotent, so a `500 upstream_unavailable` (Cloudflare or
  /// Clerk failed partway) is retried after each delay in `retryDelays`.
  public func deleteAccount(retryDelays: [Duration] = [.seconds(1), .seconds(2), .seconds(4)]) async throws -> ConnectAccountDeletion {
    var delays = retryDelays[...]
    while true {
      do {
        let result = try decode(ConnectAccountDeletion.self, from: await bearerRequest(path: "/v1/client/account", method: "DELETE"))
        guard result.deleted else { throw ConnectError.invalidResponse("The relay did not delete the account.") }
        tokens = [:]
        return result
      } catch let error as ConnectError where error.isRetryableDeletion {
        guard let delay = delays.popFirst() else { throw error }
        try await Task.sleep(for: delay)
      }
    }
  }

  // MARK: - Token exchange

  /// The form body for `POST /v1/client/dpop-token`.
  public static func tokenExchangeBody(sessionToken: String, resource: String, scopes: [String]) -> String {
    FormQuery.encode([
      ("grant_type", MachineHTTP.tokenExchangeGrantType),
      ("subject_token", sessionToken),
      ("subject_token_type", subjectTokenType),
      ("requested_token_type", MachineHTTP.accessTokenType),
      ("resource", resource),
      ("scope", scopes.joined(separator: " ")),
      ("client_id", clientId),
    ])
  }

  /// A DPoP-bound relay token for `scopes`, from the cache when it has time left.
  func accessToken(scopes: [String], refresh: Bool) async throws -> (token: String, key: any DpopKey) {
    let key = try keys.loadOrCreate()
    let cacheKey = scopes.sorted().joined(separator: " ")
    if !refresh, let cached = tokens[cacheKey], cached.thumbprint == key.thumbprint,
       cached.expiresAt.timeIntervalSince(now()) > Self.refreshSkew {
      return (cached.token, key)
    }
    struct Response: Decodable {
      let access_token: String
      let token_type: String?
      let expires_in: Double
    }
    let jwt = try await sessionToken(refresh: refresh)
    let url = try makeURL("/v1/client/dpop-token")
    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout.timeInterval)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
    request.setValue(try DpopProof.make(key: key, method: "POST", url: url, now: now()), forHTTPHeaderField: "DPoP")
    request.httpBody = Data(Self.tokenExchangeBody(sessionToken: jwt, resource: config.relayURL.absoluteString, scopes: scopes).utf8)
    let response = try decode(Response.self, from: await send(request))
    tokens[cacheKey] = (response.access_token, now().addingTimeInterval(response.expires_in), key.thumbprint)
    return (response.access_token, key)
  }

  /// Sends a DPoP request, renewing the relay token and the Clerk session
  /// once when the relay rejects them.
  /// A request authorized by the Clerk session JWT alone, refreshed once on 401.
  private func bearerRequest(path: String, method: String) async throws -> Data {
    var refresh = false
    while true {
      let jwt = try await sessionToken(refresh: refresh)
      var request = try makeRequest(path, method: method)
      request.setValue("Bearer " + jwt, forHTTPHeaderField: "Authorization")
      do {
        return try await send(request)
      } catch ConnectError.relay(status: 401, _, _) where !refresh {
        refresh = true
      }
    }
  }

  private func dpopRequest(path: String, method: String, scopes: [String], body: Data?) async throws -> Data {
    var refresh = false
    while true {
      let (token, key) = try await accessToken(scopes: scopes, refresh: refresh)
      var request = try makeRequest(path, method: method)
      request.setValue("DPoP \(token)", forHTTPHeaderField: "Authorization")
      request.setValue(try DpopProof.make(key: key, method: method, url: request.url!, accessToken: token, now: now()), forHTTPHeaderField: "DPoP")
      if let body {
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
      }
      do {
        return try await send(request)
      } catch ConnectError.relay(status: 401, _, _) where !refresh {
        refresh = true
      }
    }
  }

  private func sessionToken(refresh: Bool) async throws -> String {
    guard let token = try await session.sessionToken(refresh: refresh), !token.isEmpty else {
      tokens = [:]
      throw ConnectError.signedOut
    }
    return token
  }

  // MARK: - Plumbing

  private struct ErrorBody: Decodable {
    let code: String?
    let reason: String?
  }

  static func escape(_ segment: String) -> String {
    segment.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? segment
  }

  private func makeURL(_ path: String) throws -> URL {
    guard let url = URL(string: config.relayURL.absoluteString + path) else {
      throw ConnectError.invalidResponse("Bad relay address")
    }
    return url
  }

  private func makeRequest(_ path: String, method: String) throws -> URLRequest {
    var request = URLRequest(url: try makeURL(path), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout.timeInterval)
    request.httpMethod = method
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    return request
  }

  private func send(_ request: URLRequest) async throws -> Data {
    let transport = self.transport
    let (data, response): (Data, HTTPURLResponse)
    do {
      (data, response) = try await withDeadline(timeout) { try await transport.send(request) }
    } catch is CancellationError {
      throw CancellationError()
    } catch TransportError.timedOut {
      throw ConnectError.unreachable("Timed out")
    } catch let error as URLError {
      if error.code == .cancelled { throw CancellationError() }
      throw ConnectError.unreachable(error.localizedDescription)
    } catch {
      throw ConnectError.unreachable(error.redactedDescription)
    }
    guard (200..<300).contains(response.statusCode) else {
      let body = try? JSONDecoder().decode(ErrorBody.self, from: data)
      throw ConnectError.relay(status: response.statusCode, code: body?.code, reason: body?.reason)
    }
    return data
  }

  private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
    do {
      return try JSONDecoder().decode(T.self, from: data)
    } catch {
      throw ConnectError.invalidResponse(String(describing: error))
    }
  }
}
