import Foundation
import Synchronization
import Testing
@testable import SWCTransport

/// Clerk session JWTs handed out in order; nil means signed out.
final class FakeSession: ConnectSessionTokenProvider {
  private let state: Mutex<(tokens: [String?], calls: [Bool])>
  init(_ tokens: [String?] = ["clerk-jwt"]) { state = Mutex((tokens, [])) }
  var refreshes: [Bool] { state.withLock { $0.calls } }
  func sessionToken(refresh: Bool) async throws -> String? {
    state.withLock { state in
      state.calls.append(refresh)
      return state.tokens.count > 1 ? state.tokens.removeFirst() : state.tokens.first ?? nil
    }
  }
}

enum RelayFixture {
  static let config = ConnectConfig(publishableKey: "pk_test_x", relayURL: URL(string: "https://relay.example.com")!)
  static let token = #"{"access_token":"relay-at","token_type":"DPoP","expires_in":300,"issued_token_type":"urn:ietf:params:oauth:token-type:access_token","scope":"environment:connect"}"#
  static let environments = #"{"environments":[{"environmentId":"env-1","label":"Anton's MacBook","endpoint":{"httpBaseUrl":"https://env-1.tunnels.example.com","wsBaseUrl":"wss://env-1.tunnels.example.com","providerKind":"cloudflare"},"linkedAt":"2026-10-18T10:00:00.000Z"},{"environmentId":"env-2","label":"Mac mini","endpoint":{"httpBaseUrl":"https://env-2.tunnels.example.com","wsBaseUrl":"wss://env-2.tunnels.example.com"}}]}"#
  static let connect = #"{"environmentId":"env-1","endpoint":{"httpBaseUrl":"https://env-1.tunnels.example.com","wsBaseUrl":"wss://env-1.tunnels.example.com","providerKind":"cloudflare"},"credential":"one-time-cred","expiresAt":"2026-10-19T10:01:00.000Z"}"#
  static let online = #"{"environmentId":"env-1","status":"online","checkedAt":"2026-10-19T10:00:00.000Z"}"#
  static let offline = #"{"environmentId":"env-2","status":"offline","checkedAt":"2026-10-19T10:00:00.000Z","offlineReason":"endpoint_unreachable"}"#
  static let authInvalid = #"{"_tag":"RelayAuthInvalidError","code":"auth_invalid","reason":"invalid_dpop","traceId":"t"}"#
  static let upstreamUnavailable = #"{"_tag":"RelayInternalError","code":"internal_error","reason":"upstream_unavailable","traceId":"t"}"#
  static let timedOut = #"{"_tag":"RelayEnvironmentEndpointTimedOutError","code":"environment_endpoint_timed_out","traceId":"t"}"#

  static func form(_ request: URLRequest) -> [String: String] {
    let body = String(decoding: request.httpBody ?? Data(), as: UTF8.self)
    var components = URLComponents()
    components.percentEncodedQuery = body.replacingOccurrences(of: "+", with: "%20")
    return Dictionary((components.queryItems ?? []).map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { a, _ in a })
  }
}

@Suite struct RelayClientTests {
  let keys = FixedKeyStore()

  func client(_ fake: FakeHTTP, session: FakeSession = FakeSession(), now: @escaping @Sendable () -> Date = { Date() }) -> RelayClient {
    RelayClient(config: RelayFixture.config, session: session, keys: keys, transport: fake, now: now)
  }

  @Test func tokenExchangeBodyMatchesTheRelayGrant() {
    let body = RelayClient.tokenExchangeBody(sessionToken: "clerk jwt", resource: "https://relay.example.com", scopes: ["environment:connect", "environment:status"])
    var request = URLRequest(url: URL(string: "https://x")!)
    request.httpBody = Data(body.utf8)
    #expect(RelayFixture.form(request) == [
      "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
      "subject_token": "clerk jwt",
      "subject_token_type": "urn:ietf:params:oauth:token-type:jwt",
      "requested_token_type": "urn:ietf:params:oauth:token-type:access_token",
      "resource": "https://relay.example.com",
      "scope": "environment:connect environment:status",
      "client_id": "studio-mobile",
    ])
  }

  @Test func listsEnvironmentsWithTheClerkBearer() async throws {
    let fake = FakeHTTP { _ in (200, RelayFixture.environments) }
    let environments = try await client(fake).environments()
    #expect(environments.map(\.environmentId) == ["env-1", "env-2"])
    #expect(environments[0].label == "Anton's MacBook")
    #expect(environments[0].endpoint.httpBase?.absoluteString == "https://env-1.tunnels.example.com")
    #expect(environments[1].endpoint.providerKind == nil)
    let request = try #require(fake.requests.first)
    #expect(request.url?.absoluteString == "https://relay.example.com/v1/environments")
    #expect(request.httpMethod == "GET")
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer clerk-jwt")
    #expect(request.value(forHTTPHeaderField: "DPoP") == nil)
  }

  @Test func a401RefreshesTheClerkTokenOnce() async throws {
    let session = FakeSession(["stale", "fresh"])
    let fake = FakeHTTP { request in
      request.value(forHTTPHeaderField: "Authorization") == "Bearer fresh" ? (200, RelayFixture.environments) : (401, RelayFixture.authInvalid)
    }
    let environments = try await client(fake, session: session).environments()
    #expect(environments.count == 2)
    #expect(session.refreshes == [false, true])
  }

  @Test func signedOutStopsBeforeTheNetwork() async {
    let fake = FakeHTTP { _ in (200, RelayFixture.environments) }
    await #expect(throws: ConnectError.signedOut) { try await client(fake, session: FakeSession([nil])).environments() }
    #expect(fake.requests.isEmpty)
  }

  @Test func deletesTheAccountWithTheClerkBearer() async throws {
    let fake = FakeHTTP { _ in (200, #"{"deleted":true,"environmentCount":2}"#) }
    let result = try await client(fake).deleteAccount(retryDelays: [])
    #expect(result == ConnectAccountDeletion(deleted: true, environmentCount: 2))
    let request = try #require(fake.requests.first)
    #expect(fake.requests.count == 1)
    #expect(request.url?.absoluteString == "https://relay.example.com/v1/client/account")
    #expect(request.httpMethod == "DELETE")
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer clerk-jwt")
    #expect(request.value(forHTTPHeaderField: "DPoP") == nil)
  }

  @Test func accountDeletionRetriesWhileUpstreamIsUnavailable() async throws {
    let calls = Mutex(0)
    let fake = FakeHTTP { _ in
      calls.withLock { $0 += 1; return $0 } < 3
        ? (500, RelayFixture.upstreamUnavailable)
        : (200, #"{"deleted":true,"environmentCount":1}"#)
    }
    let result = try await client(fake).deleteAccount(retryDelays: [.zero, .zero, .zero])
    #expect(result.environmentCount == 1)
    #expect(fake.requests(path: "/v1/client/account").count == 3)
  }

  @Test func accountDeletionStopsRetryingAfterTheLastDelay() async {
    let fake = FakeHTTP { _ in (500, RelayFixture.upstreamUnavailable) }
    await #expect(throws: ConnectError.relay(status: 500, code: "internal_error", reason: "upstream_unavailable")) {
      try await client(fake).deleteAccount(retryDelays: [.zero])
    }
    #expect(fake.requests.count == 2)
  }

  @Test func accountDeletionDoesNotRetryOtherFailures() async {
    let fake = FakeHTTP { _ in (500, #"{"_tag":"RelayInternalError","code":"internal_error","reason":"database_unavailable","traceId":"t"}"#) }
    await #expect(throws: ConnectError.relay(status: 500, code: "internal_error", reason: "database_unavailable")) {
      try await client(fake).deleteAccount(retryDelays: [.zero])
    }
    #expect(fake.requests.count == 1)
  }

  @Test func accountDeletionRefreshesAnExpiredClerkToken() async throws {
    let session = FakeSession(["stale", "fresh"])
    let fake = FakeHTTP { request in
      request.value(forHTTPHeaderField: "Authorization") == "Bearer fresh"
        ? (200, #"{"deleted":true,"environmentCount":0}"#)
        : (401, RelayFixture.authInvalid)
    }
    _ = try await client(fake, session: session).deleteAccount(retryDelays: [])
    #expect(session.refreshes == [false, true])
  }

  @Test func connectExchangesThenAsksForADpopBoundCredential() async throws {
    let fake = FakeHTTP { request in
      switch request.url?.path {
      case "/v1/client/dpop-token": (200, RelayFixture.token)
      case "/v1/environments/env-1/connect": (200, RelayFixture.connect)
      default: (404, "{}")
      }
    }
    let relay = client(fake)
    let bootstrap = try await relay.connect("env-1", deviceId: "device-1")
    #expect(bootstrap.credential == "one-time-cred")
    #expect(bootstrap.endpoint.wsBase?.absoluteString == "wss://env-1.tunnels.example.com")

    let exchange = try #require(fake.requests(path: "/v1/client/dpop-token").first)
    #expect(exchange.httpMethod == "POST")
    #expect(exchange.value(forHTTPHeaderField: "Content-Type") == "application/x-www-form-urlencoded")
    #expect(exchange.value(forHTTPHeaderField: "Authorization") == nil)
    let form = RelayFixture.form(exchange)
    #expect(form["resource"] == "https://relay.example.com")
    #expect(form["subject_token"] == "clerk-jwt")
    #expect(form["scope"] == "environment:connect")
    let exchangeProof = try JWS.parts(try #require(exchange.value(forHTTPHeaderField: "DPoP")))
    #expect(exchangeProof.payload["htu"] as? String == "https://relay.example.com/v1/client/dpop-token")
    #expect(exchangeProof.payload["ath"] == nil)

    let connect = try #require(fake.requests(path: "/v1/environments/env-1/connect").first)
    #expect(connect.value(forHTTPHeaderField: "Authorization") == "DPoP relay-at")
    let proof = try JWS.parts(try #require(connect.value(forHTTPHeaderField: "DPoP")))
    #expect(proof.payload["htm"] as? String == "POST")
    #expect(proof.payload["ath"] as? String == DpopProof.accessTokenHash("relay-at"))
    let body = try JSONSerialization.jsonObject(with: try #require(connect.httpBody)) as? [String: String]
    #expect(body == ["deviceId": "device-1", "clientProofKeyThumbprint": keys.key.thumbprint])

    _ = try await relay.connect("env-1", deviceId: "device-1")
    #expect(fake.requests(path: "/v1/client/dpop-token").count == 1, "the relay token is cached")
  }

  @Test func rejectedRelayTokenIsExchangedAgainWithAFreshSession() async throws {
    let session = FakeSession(["first", "second"])
    let attempts = Recorder<Int>()
    let flaky = FakeHTTP { request in
      if request.url?.path == "/v1/client/dpop-token" { return (200, RelayFixture.token) }
      attempts.append(1)
      return attempts.values.count == 1 ? (401, RelayFixture.authInvalid) : (200, RelayFixture.connect)
    }
    _ = try await client(flaky, session: session).connect("env-1", deviceId: nil)
    #expect(flaky.requests(path: "/v1/client/dpop-token").count == 2)
    #expect(RelayFixture.form(flaky.requests(path: "/v1/client/dpop-token")[1])["subject_token"] == "second")
    #expect(session.refreshes == [false, true])
  }

  @Test func expiredRelayTokenIsRenewed() async throws {
    let clock = Mutex(Date(timeIntervalSince1970: 1_800_000_000))
    let fake = FakeHTTP { request in
      request.url?.path == "/v1/client/dpop-token" ? (200, RelayFixture.token) : (200, RelayFixture.connect)
    }
    let relay = client(fake, now: { clock.withLock { $0 } })
    _ = try await relay.connect("env-1", deviceId: nil)
    clock.withLock { $0 = $0.addingTimeInterval(250) } // 50s left, under the 60s skew
    _ = try await relay.connect("env-1", deviceId: nil)
    #expect(fake.requests(path: "/v1/client/dpop-token").count == 2)
  }

  @Test func decodesStatusesAndMarksTimeoutsAsOffline() async throws {
    let fake = FakeHTTP { request in
      switch request.url?.path {
      case "/v1/client/dpop-token": (200, RelayFixture.token)
      case "/v1/environments/env-1/status": (200, RelayFixture.online)
      case "/v1/environments/env-2/status": (200, RelayFixture.offline)
      default: (504, RelayFixture.timedOut)
      }
    }
    let relay = client(fake)
    #expect(try await relay.status(of: "env-1").isOnline)
    let offline = try await relay.status(of: "env-2")
    #expect(!offline.isOnline)
    #expect(offline.offlineReason == "endpoint_unreachable")
    #expect(offline.checkedAt == "2026-10-19T10:00:00.000Z")
    do {
      _ = try await relay.connect("env-3", deviceId: nil)
      Issue.record("expected a timeout")
    } catch let error as ConnectError {
      #expect(error == .relay(status: 504, code: "environment_endpoint_timed_out", reason: nil))
      #expect(error.isOffline)
      #expect(!error.isPermanent)
    }
  }

  @Test func refusesACredentialForAnotherMachine() async {
    let fake = FakeHTTP { request in
      request.url?.path == "/v1/client/dpop-token" ? (200, RelayFixture.token) : (200, RelayFixture.connect)
    }
    await #expect(throws: ConnectError.self) { try await client(fake).connect("env-9", deviceId: nil) }
  }

  @Test func registersTheDeviceWithRelayFieldNames() async throws {
    let fake = FakeHTTP { request in
      request.url?.path == "/v1/client/dpop-token" ? (200, RelayFixture.token) : (200, #"{"deviceId":"device-1"}"#)
    }
    let relay = client(fake)
    try await relay.registerDevice(ConnectDeviceRegistration(
      deviceId: "device-1", label: "Anton's iPhone", iosMajorVersion: 26, appVersion: "0.1.0", bundleId: "com.specwithcode.ios",
      apsEnvironment: "sandbox", pushToken: "abcd", preferences: .init(notificationsEnabled: true)
    ))
    try await relay.unregisterDevice("device-1")
    #expect(RelayFixture.form(try #require(fake.requests(path: "/v1/client/dpop-token").first))["scope"] == "mobile:registration")
    let post = try #require(fake.requests(path: "/v1/mobile/devices").first)
    let postBody = try #require(post.httpBody)
    let body = try #require(try JSONSerialization.jsonObject(with: postBody) as? [String: Any])
    #expect(body["platform"] as? String == "ios")
    #expect(body["iosMajorVersion"] as? Int == 26)
    #expect(body["apsEnvironment"] as? String == "sandbox")
    let preferences = try #require(body["preferences"] as? [String: Bool])
    #expect(Set(preferences.keys) == ["liveActivitiesEnabled", "notificationsEnabled", "notifyOnApproval", "notifyOnInput", "notifyOnCompletion", "notifyOnFailure"])
    #expect(fake.requests(path: "/v1/mobile/devices/device-1").first?.httpMethod == "DELETE")
  }
}

@Suite struct ConnectAuthorizerTests {
  let keys = FixedKeyStore()
  let tunnel = URL(string: "https://env-1.tunnels.example.com")!

  func setup(machine: @escaping FakeHTTP.Handler) -> (ConnectAuthorizer, relay: FakeHTTP, machine: FakeHTTP, store: InMemoryCredentialStore) {
    let relayHTTP = FakeHTTP { request in
      request.url?.path == "/v1/client/dpop-token" ? (200, RelayFixture.token) : (200, RelayFixture.connect)
    }
    let machineHTTP = FakeHTTP(machine)
    let store = InMemoryCredentialStore()
    let relay = RelayClient(config: RelayFixture.config, session: FakeSession(), keys: keys, transport: relayHTTP)
    let authorizer = ConnectAuthorizer(relay: relay, credentials: store, http: MachineHTTP(transport: machineHTTP), deviceId: "device-1", clientLabel: "Anton's iPhone")
    return (authorizer, relayHTTP, machineHTTP, store)
  }

  @Test func routeUsesTheTunnelHostnames() throws {
    let route = try #require(ConnectAuthorizer.route(for: ConnectEndpoint(httpBaseUrl: "https://env-1.tunnels.example.com", wsBaseUrl: "wss://env-1.tunnels.example.com")))
    #expect(route.httpBase == tunnel)
    #expect(route.issuer == ConnectAuthorizer.issuer)
  }

  @Test func redeemsTheCredentialWithTheMachineAndCachesTheSession() async throws {
    let (authorizer, relay, machine, store) = setup { _ in (200, Captured.token) }
    let route = try #require(ConnectAuthorizer.route(for: ConnectEndpoint(httpBaseUrl: tunnel.absoluteString, wsBaseUrl: "wss://env-1.tunnels.example.com")))
    let (credential, key) = try await authorizer.credential(for: "env-1", at: route, refresh: false)
    #expect(credential.token == "eyJ2IjoxfQ.sig")
    #expect(key.thumbprint == keys.key.thumbprint)

    let redeem = try #require(machine.requests.first)
    #expect(redeem.url?.absoluteString == "https://env-1.tunnels.example.com/oauth/token")
    #expect(redeem.value(forHTTPHeaderField: "Authorization") == nil)
    let form = RelayFixture.form(redeem)
    #expect(form["subject_token"] == "one-time-cred")
    #expect(form["client_device_type"] == "mobile")
    let proof = try JWS.parts(try #require(redeem.value(forHTTPHeaderField: "DPoP")))
    #expect(proof.payload["htu"] as? String == "https://env-1.tunnels.example.com/oauth/token")
    #expect((proof.header["jwk"] as? [String: String])?["x"] == Base64URL.encode(keys.key.publicX))
    #expect(try store.credential(for: "env-1", issuer: ConnectAuthorizer.issuer)?.token == "eyJ2IjoxfQ.sig")

    _ = try await authorizer.credential(for: "env-1", at: route, refresh: false)
    #expect(relay.requests(path: "/v1/environments/env-1/connect").count == 1, "cached session reused")
    _ = try await authorizer.credential(for: "env-1", at: route, refresh: true)
    #expect(relay.requests(path: "/v1/environments/env-1/connect").count == 2, "refresh bootstraps again")
  }

  @Test func rejectedCredentialIsRetryableNotARepair() async throws {
    let (authorizer, _, _, _) = setup { _ in (401, Captured.invalidCredential) }
    let route = try #require(ConnectAuthorizer.route(for: ConnectEndpoint(httpBaseUrl: tunnel.absoluteString, wsBaseUrl: "wss://env-1.tunnels.example.com")))
    await #expect(throws: TransportError.unreachable("Connect credential rejected")) {
      try await authorizer.credential(for: "env-1", at: route, refresh: false)
    }
  }
}

@Suite struct ConnectConfigTests {
  @Test func absentOrUnexpandedSettingsTurnConnectOff() {
    #expect(ConnectConfig(info: [:]) == nil)
    #expect(ConnectConfig(info: ["SWCClerkPublishableKey": "", "SWCRelayURL": ""]) == nil)
    #expect(ConnectConfig(info: ["SWCClerkPublishableKey": "$(SWC_CLERK_PUBLISHABLE_KEY)", "SWCRelayURL": "https://relay.example.com"]) == nil)
    #expect(ConnectConfig(info: ["SWCClerkPublishableKey": "sk_live_secret", "SWCRelayURL": "https://relay.example.com"]) == nil)
    #expect(ConnectConfig(info: ["SWCClerkPublishableKey": "pk_test_x", "SWCRelayURL": "http://relay.example.com"]) == nil)
    #expect(ConnectConfig.main(bundle: Bundle(for: FixedKeyStore.self)) == nil)
  }

  @Test func readsTheBuildSettings() throws {
    let config = try #require(ConnectConfig(info: [
      "SWCClerkPublishableKey": " pk_live_abc ",
      "SWCClerkJWTTemplate": "$(SWC_CLERK_JWT_TEMPLATE)",
      "SWCRelayURL": "https://relay.example.com//",
      "SWCClerkOAuthProviders": "Google, apple github",
    ]))
    #expect(config.publishableKey == "pk_live_abc")
    #expect(config.jwtTemplate == "studio-relay")
    #expect(config.relayURL.absoluteString == "https://relay.example.com")
    #expect(config.oauthProviders == ["google", "github"])
    #expect(ConnectConfig(info: ["SWCClerkPublishableKey": "pk_test_x", "SWCRelayURL": "http://localhost:8787"])?.relayURL.absoluteString == "http://localhost:8787")
  }
}
