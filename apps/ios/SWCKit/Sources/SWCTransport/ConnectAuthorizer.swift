import Foundation

/// Gets a machine session through SpecWithCode Connect for `MachineConnection`.
public protocol ConnectAuthorizing: Sendable {
  /// A DPoP-bound session token for the machine and the key it is bound to.
  /// `refresh` skips the cached token and asks the relay for a new credential.
  func credential(for environmentId: String, at route: MachineRoute, refresh: Bool) async throws -> (MachineCredential, any DpopKey)
}

/// Redeems relay credentials with the machine over its tunnel and keeps the
/// resulting session token in the Keychain, so a launch reuses it and the
/// machine sees one session per device rather than one per launch.
public actor ConnectAuthorizer: ConnectAuthorizing {
  /// The credential-store issuer of tokens bought through Connect.
  public static let issuer = "specwithcode-connect"
  /// A cached token is replaced this long before it expires.
  static let renewMargin: TimeInterval = 120

  public let relay: RelayClient
  private let http: MachineHTTP
  private let credentials: any CredentialStore
  private let deviceId: String?
  private let clientLabel: String
  private let now: @Sendable () -> Date

  public init(relay: RelayClient, credentials: any CredentialStore, http: MachineHTTP = MachineHTTP(), deviceId: String?, clientLabel: String, now: @escaping @Sendable () -> Date = { Date() }) {
    self.relay = relay
    self.credentials = credentials
    self.http = http
    self.deviceId = deviceId
    self.clientLabel = clientLabel
    self.now = now
  }

  /// The route `MachineConnection` dials for a relay endpoint.
  public static func route(for endpoint: ConnectEndpoint) -> MachineRoute? {
    guard let http = endpoint.httpBase, let ws = endpoint.wsBase else { return nil }
    return MachineRoute(httpBase: http, wsBase: ws, kind: .public, learned: false, issuer: issuer)
  }

  public func credential(for environmentId: String, at route: MachineRoute, refresh: Bool) async throws -> (MachineCredential, any DpopKey) {
    let key: any DpopKey
    do {
      key = try relay.keys.loadOrCreate()
    } catch {
      throw TransportError.unreachable("Device key unavailable: \(error.redactedDescription)")
    }
    if !refresh, let cached = try? credentials.credential(for: environmentId, issuer: Self.issuer),
       cached.expiresAt.timeIntervalSince(now()) > Self.renewMargin {
      return (cached, key)
    }
    let bootstrap: ConnectBootstrap
    do {
      bootstrap = try await relay.connect(environmentId, deviceId: deviceId)
    } catch let error as ConnectError {
      throw error.isOffline ? TransportError.unreachable("Offline") : TransportError.connect(error)
    }
    let base = ConnectEndpoint(httpBaseUrl: bootstrap.endpoint.httpBaseUrl, wsBaseUrl: bootstrap.endpoint.wsBaseUrl).httpBase ?? route.httpBase
    let grant: TokenGrant
    do {
      grant = try await http.redeemConnectCredential(bootstrap.credential, at: base, clientLabel: clientLabel, key: key)
    } catch TransportError.pairingCodeRejected {
      // The credential expired between the relay and the machine; the next attempt asks again.
      throw TransportError.unreachable("Connect credential rejected")
    }
    let credential = MachineCredential(grant: grant)
    try? credentials.save(credential, for: environmentId, issuer: Self.issuer)
    return (credential, key)
  }

  /// Drops cached session tokens, e.g. after sign-out.
  public func forget(_ environmentIds: [String]) {
    for id in environmentIds {
      try? credentials.save(MachineCredential(token: "", expiresAt: .distantPast, permissions: []), for: id, issuer: Self.issuer)
    }
  }
}
