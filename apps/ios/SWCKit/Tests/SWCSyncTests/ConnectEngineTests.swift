import Foundation
import Testing
import SWCTransport
import SWCWire
@testable import SWCSync

@MainActor
final class FakeAccount: ConnectAccount {
  let config = ConnectConfig(publishableKey: "pk_test_x", relayURL: URL(string: "https://relay.example.com")!, oauthProviders: ["github"])
  var currentUser: ConnectUser?

  init(signedIn: Bool) {
    currentUser = signedIn ? ConnectUser(id: "user_1", displayName: "Anton", email: "anton@example.com") : nil
  }

  func load() async {}
  func signIn(with method: ConnectSignInMethod) async throws {
    currentUser = ConnectUser(id: "user_1", displayName: "Anton", email: "anton@example.com")
  }
  func signOut() async throws { currentUser = nil }
  func sessionToken(refresh: Bool) async throws -> String? { currentUser == nil ? nil : "clerk-jwt" }
}

final class TestKeyStore: DpopKeyStore {
  let key = SoftwareDpopKey()
  func loadOrCreate() throws -> any DpopKey { key }
  func reset() throws {}
}

/// The relay and a machine reached over its tunnel, end to end through the engine.
@MainActor
@Suite struct ConnectEngineTests {
  let env = FakeMachine.environmentId
  nonisolated static let tunnel = "https://env-1.tunnels.example.com"
  nonisolated static let deviceId = "device-1"

  struct Harness {
    let engine: LiveEngine
    let model: AppModel
    let account: FakeAccount
    let relay: FakeHTTP
    let machineHTTP: FakeHTTP
    let registry: MachineRegistry
  }

  func harness(signedIn: Bool = true, directlyPaired: Bool = false, online: Bool = true, device: ConnectDevice? = nil, accountDeletion: (Int, String) = (200, #"{"deleted":true,"environmentCount":1}"#)) async throws -> Harness {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("swcconnect-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let registry = MachineRegistry(fileURL: directory.appendingPathComponent("machines.json"))
    var credentials: [CredentialKey: MachineCredential] = [:]
    if directlyPaired {
      try await registry.upsert(MachineRecord(environmentId: env, label: "M4", routes: [try #require(MachineRoute(httpBase: "http://192.168.1.20:8319"))]))
      credentials[CredentialKey(environmentId: env, issuer: "http://192.168.1.20:8319")] = MachineCredential(token: "tok", expiresAt: Date().addingTimeInterval(30 * 86_400), permissions: ["orchestration:read", "orchestration:operate"])
    }
    let store = InMemoryCredentialStore(credentials)
    let machine = FakeMachine()
    let base = machine.http()
    let machineHTTP = FakeHTTP { request in
      if request.url?.path == "/oauth/token" {
        return (200, #"{"access_token":"machine-session","token_type":"DPoP","expires_in":3600,"scope":"orchestration:read orchestration:operate"}"#)
      }
      let (data, response) = try await base.send(request)
      return (response.statusCode, String(decoding: data, as: UTF8.self))
    }
    let relay = FakeHTTP { request in
      switch request.url?.path {
      case "/v1/client/dpop-token": (200, #"{"access_token":"relay-at","token_type":"DPoP","expires_in":300}"#)
      case "/v1/environments": (200, #"{"environments":[{"environmentId":"env-1","label":"Anton's MacBook","endpoint":{"httpBaseUrl":"\#(Self.tunnel)","wsBaseUrl":"wss://env-1.tunnels.example.com"}}]}"#)
      case "/v1/environments/env-1/status":
        (200, #"{"environmentId":"env-1","status":"\#(online ? "online" : "offline")","checkedAt":"2026-10-19T10:00:00.000Z"}"#)
      case "/v1/environments/env-1/connect":
        online
          ? (200, #"{"environmentId":"env-1","endpoint":{"httpBaseUrl":"\#(Self.tunnel)","wsBaseUrl":"wss://env-1.tunnels.example.com"},"credential":"one-time","expiresAt":"2026-10-19T10:01:00.000Z"}"#)
          : (504, #"{"code":"environment_endpoint_timed_out","traceId":"t"}"#)
      case "/v1/mobile/devices", "/v1/mobile/devices/\(Self.deviceId)": (200, "{}")
      case "/v1/client/account": accountDeletion
      default: (404, "{}")
      }
    }
    let account = FakeAccount(signedIn: signedIn)
    let http = MachineHTTP(transport: machineHTTP)
    let defaults = try #require(UserDefaults(suiteName: "swcconnect-\(UUID().uuidString)"))
    defaults.set(Self.deviceId, forKey: ConnectRuntime.deviceIdKey)
    let connect = ConnectRuntime(
      account: account,
      credentials: store,
      clientLabel: "Anton's iPhone",
      device: device ?? ConnectDevice(label: "Anton's iPhone", iosMajorVersion: 26, appVersion: "0.1.0", bundleId: "com.specwithcode.ios", apsEnvironment: nil),
      keys: TestKeyStore(),
      transport: relay,
      http: http,
      defaults: defaults
    )
    let engine = LiveEngine(
      registry: registry,
      credentials: store,
      http: http,
      connector: FakeConnector(machine),
      options: LiveEngine.Options(
        publishInterval: .milliseconds(5),
        socketWait: .seconds(3),
        retryDelay: .milliseconds(10),
        connection: MachineConnection.Configuration(probeStagger: .milliseconds(5), stableConnection: .zero),
        monitorsNetwork: false
      ),
      connect: connect
    )
    let model = AppModel(engine: engine)
    return Harness(engine: engine, model: model, account: account, relay: relay, machineHTTP: machineHTTP, registry: registry)
  }

  @Test func signedInPhoneListsAndConnectsToTheAccountsMac() async throws {
    let h = try await harness()
    #expect(await until { h.model.connect?.macs.first?.isOnline == true })
    #expect(h.model.connect?.user?.email == "anton@example.com")
    #expect(h.model.connect?.methods.first == .apple)
    #expect(await until { h.model.machines.first?.status == .connected })
    let machine = try #require(h.model.machines.first)
    #expect(machine.viaConnect)
    #expect(!machine.hasDirectPairing)
    #expect(machine.tokenDaysLeft == nil)

    let redeem = try #require(h.machineHTTP.requests(path: "/oauth/token").first)
    #expect(redeem.url?.absoluteString == "\(Self.tunnel)/oauth/token")
    #expect(redeem.value(forHTTPHeaderField: "DPoP") != nil)
    let ticket = try #require(h.machineHTTP.requests(path: "/api/auth/websocket-ticket").first)
    #expect(ticket.url?.host() == "env-1.tunnels.example.com")
    #expect(ticket.value(forHTTPHeaderField: "Authorization") == "DPoP machine-session")
    #expect(await h.registry.machine(env)?.connectRoute?.issuer == ConnectAuthorizer.issuer)
  }

  @Test func offlineMacIsListedAsOfflineNotAsAnError() async throws {
    let h = try await harness(online: false)
    #expect(await until { h.model.connect?.macs.first?.isOnline == false })
    let mac = try #require(h.model.connect?.macs.first)
    #expect(mac.label == "Anton's MacBook")
    #expect(mac.checkedAt != nil)
    #expect(h.model.connect?.lastError == nil)
    #expect(h.model.machines.first?.needsSignIn == false)
  }

  @Test func signedOutPhoneShowsSignInAndDialsNothing() async throws {
    let h = try await harness(signedIn: false)
    #expect(await until { h.model.connect != nil && !h.model.isLoading })
    #expect(h.model.connect?.isSignedIn == false)
    #expect(h.model.machines.isEmpty)
    #expect(h.relay.requests.isEmpty)

    try await h.engine.connectSignIn(with: .apple)
    #expect(await until { h.model.machines.first?.status == .connected })
  }

  @Test func signOutRemovesConnectOnlyMacs() async throws {
    let h = try await harness()
    #expect(await until { h.model.machines.first?.status == .connected })
    await h.engine.connectSignOut()
    #expect(h.model.connect?.isSignedIn == false)
    #expect(h.model.connect?.macs.isEmpty == true)
    #expect(await until { h.model.machines.isEmpty })
    #expect(await h.registry.machine(env) == nil)
  }

  @Test func signOutKeepsADirectPairing() async throws {
    let h = try await harness(directlyPaired: true)
    #expect(await until { h.model.machines.first?.viaConnect == true && h.model.machines.first?.status == .connected })
    #expect(h.model.machines.first?.hasDirectPairing == true)
    try await h.engine.connectDeleteAccount()
    let deletion = try #require(h.relay.requests(path: "/v1/client/account").first)
    #expect(deletion.httpMethod == "DELETE")
    #expect(deletion.value(forHTTPHeaderField: "Authorization") == "Bearer clerk-jwt")
    #expect(h.account.currentUser == nil)
    #expect(h.model.connect?.isSignedIn == false)
    let record = try #require(await h.registry.machine(env))
    #expect(record.connectRoute == nil)
    #expect(!record.routes.isEmpty)
    #expect(await until { h.model.machines.first?.viaConnect == false })
  }

  @Test func failedDeletionKeepsTheAccountSignedIn() async throws {
    let h = try await harness(accountDeletion: (500, #"{"code":"internal_error","reason":"database_unavailable","traceId":"t"}"#))
    #expect(await until { h.model.machines.first?.status == .connected })
    await #expect(throws: ConnectError.self) { try await h.engine.connectDeleteAccount() }
    #expect(h.account.currentUser != nil)
    #expect(h.model.connect?.isSignedIn == true)
    #expect(h.model.connect?.lastError != nil)
    #expect(h.model.machines.first?.viaConnect == true)
  }

  @Test func registersForNotificationsAfterSignInAndRemovesOnSignOut() async throws {
    let device = ConnectDevice(label: "Anton's iPhone", iosMajorVersion: 26, appVersion: "0.1.0", bundleId: "com.specwithcode.ios", apsEnvironment: ConnectDevice.apsEnvironment("development"))
    let h = try await harness(device: device)
    #expect(await until { h.model.machines.first?.status == .connected })
    #expect(h.relay.requests(path: "/v1/mobile/devices").isEmpty)

    h.engine.connectSetPushToken(Data([0x0a, 0xff, 0x01]))
    #expect(await until { !h.relay.requests(path: "/v1/mobile/devices").isEmpty })
    let request = try #require(h.relay.requests(path: "/v1/mobile/devices").first)
    #expect(request.httpMethod == "POST")
    #expect(request.value(forHTTPHeaderField: "DPoP") != nil)
    let body = try #require(request.httpBody.flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: Any] })
    #expect(body["deviceId"] as? String == Self.deviceId)
    #expect(body["platform"] as? String == "ios")
    #expect(body["pushToken"] as? String == "0aff01")
    #expect(body["apsEnvironment"] as? String == "sandbox")
    #expect(body["iosMajorVersion"] as? Int == 26)
    #expect((body["preferences"] as? [String: Any])?["notificationsEnabled"] as? Bool == true)

    // The same token for the same account is not sent twice.
    h.engine.connectSetPushToken(Data([0x0a, 0xff, 0x01]))
    try await Task.sleep(for: .milliseconds(50))
    #expect(h.relay.requests(path: "/v1/mobile/devices").count == 1)

    await h.engine.connectSignOut()
    let removal = try #require(h.relay.requests(path: "/v1/mobile/devices/\(Self.deviceId)").first)
    #expect(removal.httpMethod == "DELETE")
  }

  @Test func buildWithoutPushEntitlementNeverRegisters() async throws {
    let h = try await harness()
    #expect(await until { h.model.machines.first?.status == .connected })
    h.engine.connectSetPushToken(Data([0x01]))
    try await Task.sleep(for: .milliseconds(50))
    #expect(h.relay.requests(path: "/v1/mobile/devices").isEmpty)
    #expect(ConnectDevice.apsEnvironment("production") == "production")
    #expect(ConnectDevice.apsEnvironment("$(SWC_APS_ENVIRONMENT)") == nil)
  }
}
