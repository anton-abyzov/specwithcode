import Foundation
import Testing
@testable import SWCTransport

/// "Your phones" and a phone removed from the Connect account.
@Suite struct PhoneRemovalTests {
  let keys = FixedKeyStore()
  static let removed = #"{"_tag":"RelayAuthInvalidError","code":"auth_invalid","reason":"device_removed","traceId":"t"}"#
  static let phones = #"{"phones":[{"deviceId":"device-1","label":"Anton's iPhone","platform":"ios","model":"iPhone 16 Pro","appVersion":"0.2.0","lastSeenAt":"2026-10-31T10:00:00.000Z","current":true},{"deviceId":"device 2","label":"Old iPhone","platform":"ios","model":null,"appVersion":null,"lastSeenAt":"2026-10-20T10:00:00.000Z","current":false}]}"#

  func client(_ fake: FakeHTTP, session: FakeSession = FakeSession(), deviceId: String? = "device-1") -> RelayClient {
    RelayClient(config: RelayFixture.config, session: session, keys: keys, transport: fake, deviceId: deviceId)
  }

  @Test func tokenExchangeNamesThePhone() async throws {
    let fake = FakeHTTP { request in
      request.url?.path == "/v1/client/dpop-token" ? (200, RelayFixture.token) : (200, RelayFixture.connect)
    }
    _ = try await client(fake).connect("env-1", deviceId: "device-1")
    let form = RelayFixture.form(try #require(fake.requests(path: "/v1/client/dpop-token").first))
    #expect(form["device_id"] == "device-1")
    #expect(form["client_id"] == "studio-mobile")

    let anonymous = FakeHTTP { request in
      request.url?.path == "/v1/client/dpop-token" ? (200, RelayFixture.token) : (200, RelayFixture.connect)
    }
    _ = try await client(anonymous, deviceId: nil).connect("env-1", deviceId: nil)
    #expect(RelayFixture.form(try #require(anonymous.requests(path: "/v1/client/dpop-token").first))["device_id"] == nil)
  }

  @Test func listsPhonesWithTheClerkBearer() async throws {
    let fake = FakeHTTP { _ in (200, Self.phones) }
    let phones = try await client(fake).phones()
    #expect(phones.map(\.deviceId) == ["device-1", "device 2"])
    #expect(phones[0] == ConnectPhoneRecord(deviceId: "device-1", label: "Anton's iPhone", model: "iPhone 16 Pro", appVersion: "0.2.0", lastSeenAt: "2026-10-31T10:00:00.000Z", current: true))
    #expect(phones[1].model == nil)
    #expect(!phones[1].current)
    let request = try #require(fake.requests.first)
    #expect(request.url?.absoluteString == "https://relay.example.com/v1/client/phones")
    #expect(request.httpMethod == "GET")
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer clerk-jwt")
    #expect(request.value(forHTTPHeaderField: "DPoP") == nil)
  }

  @Test func removesAPhoneByItsDeviceId() async throws {
    let fake = FakeHTTP { _ in (200, #"{"removed":true,"current":false}"#) }
    let result = try await client(fake).removePhone("device 2/x")
    #expect(result == ConnectPhoneRemoval(removed: true, current: false))
    let request = try #require(fake.requests.first)
    #expect(request.httpMethod == "DELETE")
    #expect(request.url?.absoluteString == "https://relay.example.com/v1/client/phones/device%202%2Fx")
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer clerk-jwt")
  }

  @Test func removingThisPhoneDropsItsRelayTokens() async throws {
    let fake = FakeHTTP { request in
      switch request.url?.path {
      case "/v1/client/dpop-token": (200, RelayFixture.token)
      case "/v1/client/phones/device-1": (200, #"{"removed":true,"current":true}"#)
      default: (200, RelayFixture.connect)
      }
    }
    let relay = client(fake)
    _ = try await relay.connect("env-1", deviceId: "device-1")
    #expect(try await relay.removePhone("device-1").current)
    _ = try await relay.connect("env-1", deviceId: "device-1")
    #expect(fake.requests(path: "/v1/client/dpop-token").count == 2)
  }

  @Test func deviceRemovedIsPermanentAndExplained() {
    let error = ConnectError.relay(status: 401, code: "auth_invalid", reason: "device_removed")
    #expect(error.isDeviceRemoved)
    #expect(error.isPermanent)
    #expect(!error.isRenewable)
    #expect(error.localizedDescription == "This iPhone was removed from your account. Sign in again to reconnect.")
    #expect(TransportError.connect(error).isPermanent)
    #expect(TransportError.connect(error).localizedDescription == error.localizedDescription)

    let expired = ConnectError.relay(status: 401, code: "auth_invalid", reason: "invalid_dpop")
    #expect(!expired.isDeviceRemoved)
    #expect(!expired.isPermanent)
    #expect(expired.isRenewable)
    #expect(expired.localizedDescription == "Your sign-in expired. Sign in again.")
  }

  @Test func refusedTokenExchangeIsNotRetried() async {
    let session = FakeSession(["first", "second"])
    let fake = FakeHTTP { _ in (401, Self.removed) }
    await #expect(throws: ConnectError.relay(status: 401, code: "auth_invalid", reason: "device_removed")) {
      try await client(fake, session: session).connect("env-1", deviceId: "device-1")
    }
    #expect(fake.requests.count == 1)
    #expect(session.refreshes == [false])
  }

  @Test func refusedRelayTokenIsNotRenewed() async {
    let session = FakeSession(["first", "second"])
    let fake = FakeHTTP { request in
      request.url?.path == "/v1/client/dpop-token" ? (200, RelayFixture.token) : (401, Self.removed)
    }
    await #expect(throws: ConnectError.self) {
      try await client(fake, session: session).registerDevice(ConnectDeviceRegistration(
        deviceId: "device-1", label: "Anton's iPhone", iosMajorVersion: 26, appVersion: nil, bundleId: nil,
        apsEnvironment: "sandbox", pushToken: "abcd", preferences: .init(notificationsEnabled: true)
      ))
    }
    #expect(fake.requests(path: "/v1/client/dpop-token").count == 1)
    #expect(fake.requests(path: "/v1/mobile/devices").count == 1)
    #expect(session.refreshes == [false])
  }

  @Test func registrationSendsTheModel() async throws {
    let fake = FakeHTTP { request in
      request.url?.path == "/v1/client/dpop-token" ? (200, RelayFixture.token) : (200, "{}")
    }
    let relay = client(fake)
    try await relay.registerDevice(ConnectDeviceRegistration(
      deviceId: "device-1", label: "Anton's iPhone", iosMajorVersion: 26, appVersion: "0.2.0", bundleId: nil,
      apsEnvironment: "sandbox", pushToken: "abcd", model: "iPhone 16 Pro", preferences: .init(notificationsEnabled: true)
    ))
    try await relay.registerDevice(ConnectDeviceRegistration(
      deviceId: "device-1", label: "Anton's iPhone", iosMajorVersion: 26, appVersion: nil, bundleId: nil,
      apsEnvironment: "sandbox", pushToken: "abcd", preferences: .init(notificationsEnabled: true)
    ))
    let posts = fake.requests(path: "/v1/mobile/devices")
    let firstBody = try #require(posts[0].httpBody)
    let first = try #require(try JSONSerialization.jsonObject(with: firstBody) as? [String: Any])
    #expect(first["model"] as? String == "iPhone 16 Pro")
    let secondBody = try #require(posts[1].httpBody)
    let second = try #require(try JSONSerialization.jsonObject(with: secondBody) as? [String: Any])
    #expect(second.keys.contains("model") == false, "an unknown model is left out, not sent as null")
  }

  @Test func removalStatusAsksWithAProofFromThePhonesKeyAlone() async throws {
    let session = FakeSession([])
    let fake = FakeHTTP { _ in (200, #"{"removed":true}"#) }
    #expect(try await client(fake, session: session).removalStatus())
    #expect(fake.requests.count == 1, "no token exchange: the Clerk session may be gone")
    #expect(session.refreshes.isEmpty)
    let request = try #require(fake.requests.first)
    #expect(request.httpMethod == "POST")
    #expect(request.url?.absoluteString == "https://relay.example.com/v1/client/removal-status")
    #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
    let proof = try JWS.parts(try #require(request.value(forHTTPHeaderField: "DPoP")))
    #expect(proof.payload["htm"] as? String == "POST")
    #expect(proof.payload["htu"] as? String == "https://relay.example.com/v1/client/removal-status")
    #expect(proof.payload["ath"] == nil)

    let kept = FakeHTTP { _ in (200, #"{"removed":false}"#) }
    #expect(try await client(kept).removalStatus() == false)
    let failing = FakeHTTP { _ in (500, RelayFixture.upstreamUnavailable) }
    await #expect(throws: ConnectError.self) { try await client(failing).removalStatus() }
  }
}
