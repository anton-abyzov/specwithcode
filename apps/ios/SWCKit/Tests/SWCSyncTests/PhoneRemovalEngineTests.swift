import Foundation
import Synchronization
import Testing
import SWCTransport
import SWCWire
@testable import SWCSync

/// A phone removed from the Connect account, and "Your phones", through the engine.
@MainActor
@Suite struct PhoneRemovalEngineTests {
  nonisolated static let deviceId = "device-1"
  nonisolated static let tunnel = "https://env-1.tunnels.example.com"
  nonisolated static let removed = #"{"_tag":"RelayAuthInvalidError","code":"auth_invalid","reason":"device_removed","traceId":"t"}"#
  /// The relay no longer accepts the Clerk session, fresh token or not.
  nonisolated static let expired = #"{"_tag":"RelayAuthInvalidError","code":"auth_invalid","reason":"invalid_token","traceId":"t"}"#

  /// What the fake relay refuses with `device_removed`, changeable mid-test.
  final class RelayRules: Sendable {
    enum Refusal { case none, connect, tokenExchange, sessionRejected }
    /// What `POST /v1/client/removal-status` answers; `unreachable` drops the connection.
    enum RemovalStatus { case removed, notRemoved, unreachable }
    private let state = Mutex<(refusal: Refusal, removeCurrent: Bool, removalStatus: RemovalStatus)>((.none, false, .notRemoved))
    var removalStatus: RemovalStatus {
      get { state.withLock { $0.removalStatus } }
      set { state.withLock { $0.removalStatus = newValue } }
    }
    var refusal: Refusal {
      get { state.withLock { $0.refusal } }
      set { state.withLock { $0.refusal = newValue } }
    }
    var removeCurrent: Bool {
      get { state.withLock { $0.removeCurrent } }
      set { state.withLock { $0.removeCurrent = newValue } }
    }
  }

  struct Harness {
    let engine: LiveEngine
    let model: AppModel
    let account: FakeAccount
    let relay: FakeHTTP
    let rules: RelayRules
    let defaults: UserDefaults
    let directory: URL
    let registry: MachineRegistry
  }

  func harness(signedIn: Bool = true, refusal: RelayRules.Refusal = .none, push: Bool = false, defaults: UserDefaults? = nil, directory: URL? = nil, removalStatus: RelayRules.RemovalStatus = .notRemoved) async throws -> Harness {
    let directory = directory ?? FileManager.default.temporaryDirectory.appendingPathComponent("swcremoval-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let registry = MachineRegistry(fileURL: directory.appendingPathComponent("machines.json"))
    let store = InMemoryCredentialStore()
    let machine = FakeMachine()
    let base = machine.http()
    let machineHTTP = FakeHTTP { request in
      if request.url?.path == "/oauth/token" {
        return (200, #"{"access_token":"machine-session","token_type":"DPoP","expires_in":3600,"scope":"orchestration:read orchestration:operate"}"#)
      }
      let (data, response) = try await base.send(request)
      return (response.statusCode, String(decoding: data, as: UTF8.self))
    }
    let rules = RelayRules()
    rules.refusal = refusal
    rules.removalStatus = removalStatus
    let relay = FakeHTTP { request in
      let refusal = rules.refusal
      if refusal == .sessionRejected, request.url?.path != "/v1/client/removal-status" { return (401, Self.expired) }
      switch request.url?.path {
      case "/v1/client/dpop-token":
        return refusal == .tokenExchange ? (401, Self.removed) : (200, #"{"access_token":"relay-at","token_type":"DPoP","expires_in":300}"#)
      case "/v1/environments":
        return (200, #"{"environments":[{"environmentId":"env-1","label":"Anton's MacBook","endpoint":{"httpBaseUrl":"\#(Self.tunnel)","wsBaseUrl":"wss://env-1.tunnels.example.com"}}]}"#)
      case "/v1/environments/env-1/status":
        return (200, #"{"environmentId":"env-1","status":"online","checkedAt":"2026-10-31T10:00:00.000Z"}"#)
      case "/v1/environments/env-1/connect":
        return refusal == .connect
          ? (401, Self.removed)
          : (200, #"{"environmentId":"env-1","endpoint":{"httpBaseUrl":"\#(Self.tunnel)","wsBaseUrl":"wss://env-1.tunnels.example.com"},"credential":"one-time","expiresAt":"2026-10-31T10:01:00.000Z"}"#)
      case "/v1/mobile/devices", "/v1/mobile/devices/\(Self.deviceId)":
        return refusal == .none ? (200, "{}") : (401, Self.removed)
      case "/v1/client/phones":
        // The relay does not know this phone's session, so `current` is false here;
        // the engine still recognizes it by its device id.
        return (200, #"{"phones":[{"deviceId":"device-2","label":"Old iPhone","platform":"ios","model":"iPhone 13 mini","appVersion":"0.1.1","lastSeenAt":"2026-10-20T10:00:00.000Z","current":false},{"deviceId":"\#(Self.deviceId)","label":"Anton's iPhone","platform":"ios","model":"iPhone 16 Pro","appVersion":"0.2.0","lastSeenAt":"2026-10-31T10:00:00.000Z","current":false}]}"#)
      case "/v1/client/removal-status":
        switch rules.removalStatus {
        case .removed: return (200, #"{"removed":true}"#)
        case .notRemoved: return (200, #"{"removed":false}"#)
        case .unreachable: throw URLError(.notConnectedToInternet)
        }
      case "/v1/client/phones/device-2":
        return (200, #"{"removed":true,"current":false}"#)
      case "/v1/client/phones/\(Self.deviceId)":
        return (200, #"{"removed":true,"current":\#(rules.removeCurrent)}"#)
      default:
        return (404, "{}")
      }
    }
    let account = FakeAccount(signedIn: signedIn)
    let http = MachineHTTP(transport: machineHTTP)
    let suite = try #require(defaults ?? UserDefaults(suiteName: "swcremoval-\(UUID().uuidString)"))
    suite.set(Self.deviceId, forKey: ConnectRuntime.deviceIdKey)
    let connect = ConnectRuntime(
      account: account,
      credentials: store,
      clientLabel: "Anton's iPhone",
      device: ConnectDevice(label: "Anton's iPhone", iosMajorVersion: 26, appVersion: "0.2.0", bundleId: "com.specwithcode.ios", apsEnvironment: push ? "sandbox" : nil, model: "iPhone 16 Pro"),
      keys: TestKeyStore(),
      transport: relay,
      http: http,
      defaults: suite
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
    return Harness(engine: engine, model: model, account: account, relay: relay, rules: rules, defaults: suite, directory: directory, registry: registry)
  }

  @Test func tokenExchangeCarriesThisPhonesDeviceId() async throws {
    let h = try await harness()
    #expect(await until { h.model.machines.first?.status == .connected })
    let exchange = try #require(h.relay.requests(path: "/v1/client/dpop-token").first)
    let body = String(decoding: exchange.httpBody ?? Data(), as: UTF8.self)
    #expect(body.contains("device_id=\(Self.deviceId)"))
  }

  /// The account card and the computers read one state: a session the relay
  /// rejects shows signed out on both, and stays signed out after relaunch.
  @Test func aRejectedSessionShowsSignedOutEverywhere() async throws {
    let h = try await harness()
    #expect(await until { h.model.machines.first?.status == .connected })
    #expect(h.model.connect?.isSignedIn == true)
    h.rules.refusal = .sessionRejected
    await h.engine.connectRefresh()
    #expect(await until { h.model.connect?.isSignedIn == false })
    #expect(h.account.currentUser == nil, "Clerk's cached user must not bring 'signed in' back")
    #expect(h.model.connect?.wasRemoved == false)
    #expect(h.model.machines.count == 1, "The computer stays listed and reconnects after sign-in")
  }

  @Test func refusedConnectSignsOutAndSaysWhy() async throws {
    let h = try await harness(refusal: .connect)
    #expect(await until { h.model.connect?.wasRemoved == true })
    #expect(h.account.currentUser == nil)
    #expect(h.model.connect?.isSignedIn == false)
    #expect(h.model.connect?.macs.isEmpty == true)
    #expect(await until { h.model.machines.isEmpty })
    #expect(h.defaults.bool(forKey: ConnectRuntime.removedKey))
    // Signed out, nothing asks the relay again.
    let count = h.relay.requests.count
    try await Task.sleep(for: .milliseconds(100))
    #expect(h.relay.requests.count == count)
    #expect(h.relay.requests(path: "/v1/mobile/devices/\(Self.deviceId)").isEmpty, "a removed phone does not try to unregister")
  }

  @Test func refusedTokenExchangeSignsOutFromTheStatusCheck() async throws {
    let h = try await harness(refusal: .tokenExchange)
    #expect(await until { h.model.connect?.wasRemoved == true })
    #expect(h.account.currentUser == nil)
    #expect(await until { h.model.machines.isEmpty })
    #expect(ConnectState.removedMessage == "This iPhone was removed from your account. Sign in again to reconnect.")
  }

  @Test func refusedRegistrationSignsOut() async throws {
    let h = try await harness(push: true)
    #expect(await until { h.model.machines.first?.status == .connected })
    h.rules.refusal = .tokenExchange
    await h.engine.connect?.relay.reset()
    h.engine.connectSetPushToken(Data([0x0a]))
    #expect(await until { h.model.connect?.wasRemoved == true })
    #expect(h.account.currentUser == nil)
  }

  @Test func theRemovedNoticeOutlivesARelaunchAndAFreshSignInClearsIt() async throws {
    let defaults = try #require(UserDefaults(suiteName: "swcremoval-\(UUID().uuidString)"))
    defaults.set(true, forKey: ConnectRuntime.removedKey)
    let h = try await harness(signedIn: false, defaults: defaults)
    #expect(await until { h.model.connect != nil && !h.model.isLoading })
    #expect(h.model.connect?.wasRemoved == true)
    #expect(h.relay.requests.isEmpty, "already told it was removed, it does not ask again")

    try await h.engine.connectSignIn(with: .apple)
    #expect(h.model.connect?.wasRemoved == false)
    #expect(!defaults.bool(forKey: ConnectRuntime.removedKey))
    #expect(await until { h.model.machines.first?.status == .connected })
  }

  @Test func phonesListThisPhoneFirstByItsDeviceId() async throws {
    let h = try await harness()
    #expect(await until { h.model.machines.first?.status == .connected })
    let phones = try await h.engine.connectPhones()
    #expect(phones.map(\.id) == [Self.deviceId, "device-2"])
    #expect(phones[0].isThisPhone)
    #expect(phones[0].model == "iPhone 16 Pro")
    #expect(!phones[1].isThisPhone)
    #expect(phones[1].lastSeen == LiveEngine.parseDate("2026-10-20T10:00:00.000Z"))
  }

  @Test func removingAnotherPhoneKeepsThisOneSignedIn() async throws {
    let h = try await harness()
    #expect(await until { h.model.machines.first?.status == .connected })
    try await h.engine.connectRemovePhone("device-2")
    let request = try #require(h.relay.requests(path: "/v1/client/phones/device-2").first)
    #expect(request.httpMethod == "DELETE")
    #expect(h.account.currentUser != nil)
    #expect(h.model.connect?.isSignedIn == true)
    #expect(h.model.machines.first?.viaConnect == true)
  }

  @Test func removingThisPhoneSignsItOutWithoutUnregistering() async throws {
    let h = try await harness(push: true)
    #expect(await until { h.model.machines.first?.status == .connected })
    h.engine.connectSetPushToken(Data([0x0a]))
    #expect(await until { !h.relay.requests(path: "/v1/mobile/devices").isEmpty })
    h.rules.removeCurrent = true
    try await h.engine.connectRemovePhone(Self.deviceId)
    #expect(h.account.currentUser == nil)
    #expect(h.model.connect?.isSignedIn == false)
    #expect(h.model.connect?.wasRemoved == false, "the person removed it here and knows why")
    #expect(await until { h.model.machines.isEmpty })
    #expect(h.relay.requests(path: "/v1/mobile/devices/\(Self.deviceId)").isEmpty)
  }

  // MARK: - Removed while signed out

  /// Signs in, reaches the Mac through Connect, then "relaunches" with the
  /// Clerk session gone, as after a removal made while the phone was idle.
  func relaunchSignedOut(_ removalStatus: RelayRules.RemovalStatus) async throws -> (first: Harness, second: Harness) {
    let first = try await harness()
    #expect(await until { first.model.machines.first?.status == .connected })
    #expect(first.defaults.bool(forKey: ConnectRuntime.signedInKey))
    #expect(await first.registry.machine("env-1")?.connectRoute != nil)
    let second = try await harness(signedIn: false, defaults: first.defaults, directory: first.directory, removalStatus: removalStatus)
    return (first, second)
  }

  @Test func sessionEndedElsewhereAsksTheRelayAndSaysTheRemovalWithTheKeyAlone() async throws {
    let (_, h) = try await relaunchSignedOut(.removed)
    #expect(await until { h.model.connect?.wasRemoved == true })
    let check = try #require(h.relay.requests(path: "/v1/client/removal-status").first)
    #expect(check.httpMethod == "POST")
    #expect(check.value(forHTTPHeaderField: "Authorization") == nil)
    #expect(check.value(forHTTPHeaderField: "DPoP") != nil)
    #expect(h.relay.requests(path: "/v1/client/dpop-token").isEmpty, "a signed-out phone has no Clerk token to exchange")
    #expect(h.defaults.bool(forKey: ConnectRuntime.removedKey))
    #expect(!h.defaults.bool(forKey: ConnectRuntime.signedInKey))
    #expect(h.model.connect?.isSignedIn == false)
    // What Connect gave it is forgotten.
    #expect(await until { h.model.machines.isEmpty })
    #expect(await h.registry.machine("env-1") == nil)
  }

  @Test func sessionEndedForAnotherReasonIsPlainlySignedOut() async throws {
    let (_, h) = try await relaunchSignedOut(.notRemoved)
    #expect(await until { !h.relay.requests(path: "/v1/client/removal-status").isEmpty })
    try await Task.sleep(for: .milliseconds(50))
    #expect(h.model.connect?.wasRemoved == false)
    #expect(!h.defaults.bool(forKey: ConnectRuntime.removedKey))
    #expect(!h.defaults.bool(forKey: ConnectRuntime.signedInKey), "asked once, not on every launch")
    #expect(h.model.connect?.isSignedIn == false)
  }

  @Test func unreachableRelayLeavesItSignedOutAndAsksNextTime() async throws {
    let (_, h) = try await relaunchSignedOut(.unreachable)
    #expect(await until { !h.relay.requests(path: "/v1/client/removal-status").isEmpty })
    try await Task.sleep(for: .milliseconds(50))
    #expect(h.model.connect?.wasRemoved == false)
    #expect(h.model.connect?.isSignedIn == false)
    #expect(h.defaults.bool(forKey: ConnectRuntime.signedInKey))
  }

  @Test func signingOutHereNeverAsks() async throws {
    let first = try await harness()
    #expect(await until { first.model.machines.first?.status == .connected })
    await first.engine.connectSignOut()
    #expect(!first.defaults.bool(forKey: ConnectRuntime.signedInKey))
    let h = try await harness(signedIn: false, defaults: first.defaults, directory: first.directory, removalStatus: .removed)
    #expect(await until { h.model.connect != nil && !h.model.isLoading })
    try await Task.sleep(for: .milliseconds(50))
    #expect(h.relay.requests.isEmpty)
    #expect(h.model.connect?.wasRemoved == false)
  }

  @Test func sessionEndingWhileRunningAsksOnRefresh() async throws {
    let h = try await harness(removalStatus: .removed)
    #expect(await until { h.model.machines.first?.status == .connected })
    h.account.sessionEnded = true
    await h.engine.connect?.relay.reset()
    await h.engine.connectRefresh()
    #expect(await until { h.model.connect?.wasRemoved == true })
    #expect(h.account.currentUser == nil)
    #expect(await until { h.model.machines.isEmpty })
  }

  // MARK: - Clerk signed out while running

  nonisolated static let removedError = ConnectError.relay(status: 401, code: "auth_invalid", reason: "device_removed")

  @Test func clerkSigningOutWhileRunningAsksOnceWhenTheAppReturns() async throws {
    let h = try await harness(removalStatus: .removed)
    #expect(await until { h.model.machines.first?.status == .connected })
    // Clerk dropped the session the removal ended; the cached user is gone too.
    h.account.currentUser = nil
    h.engine.setActive(true)
    #expect(await until { h.model.connect?.wasRemoved == true })
    #expect(h.model.connect?.isSignedIn == false)
    #expect(h.defaults.bool(forKey: ConnectRuntime.removedKey))
    #expect(await until { h.model.machines.isEmpty })
    #expect(await h.registry.machine("env-1") == nil)
    h.engine.setActive(true)
    await h.engine.connectRefresh()
    try await Task.sleep(for: .milliseconds(50))
    #expect(h.relay.requests(path: "/v1/client/removal-status").count == 1)
  }

  @Test func clerkSigningOutWhileRunningForAnotherReasonIsPlainlySignedOut() async throws {
    let h = try await harness(removalStatus: .notRemoved)
    #expect(await until { h.model.machines.first?.status == .connected })
    h.account.currentUser = nil
    h.engine.setActive(true)
    #expect(await until { h.model.connect?.isSignedIn == false })
    #expect(await until { !h.relay.requests(path: "/v1/client/removal-status").isEmpty })
    #expect(h.model.connect?.wasRemoved == false)
    #expect(!h.defaults.bool(forKey: ConnectRuntime.removedKey))
    h.engine.setActive(true)
    await h.engine.connectRefresh()
    try await Task.sleep(for: .milliseconds(50))
    #expect(h.relay.requests(path: "/v1/client/removal-status").count == 1, "asked once, no loop")
  }

  @Test func aRemovalRefusalAfterClerkDroppedTheSessionStillCountsOnce() async throws {
    let h = try await harness()
    #expect(await until { h.model.machines.first?.status == .connected })
    h.account.currentUser = nil
    await h.engine.connectHandleRemoval(Self.removedError)
    await h.engine.connectHandleRemoval(Self.removedError)
    #expect(h.model.connect?.wasRemoved == true)
    #expect(h.model.connect?.isSignedIn == false)
    #expect(h.defaults.bool(forKey: ConnectRuntime.removedKey))
    #expect(h.account.signOutCount == 1)
    #expect(await until { h.model.machines.isEmpty })
    #expect(await h.registry.machine("env-1") == nil)
    // The relay check that runs after the drop does not handle it a second time.
    await h.engine.connectRefresh()
    #expect(h.account.signOutCount == 1)
    #expect(h.relay.requests(path: "/v1/client/removal-status").isEmpty)
  }

  @Test func aRemovalRefusalAfterAPlainSessionEndStillCounts() async throws {
    let h = try await harness(removalStatus: .notRemoved)
    #expect(await until { h.model.machines.first?.status == .connected })
    h.account.currentUser = nil
    h.engine.setActive(true)
    #expect(await until { !h.relay.requests(path: "/v1/client/removal-status").isEmpty })
    try await Task.sleep(for: .milliseconds(20))
    #expect(h.model.connect?.wasRemoved == false)
    await h.engine.connectHandleRemoval(Self.removedError)
    #expect(h.model.connect?.wasRemoved == true)
    #expect(await until { h.model.machines.isEmpty })
  }

  @Test func signingOutHereWhileRunningNeverAsksOrSaysRemoved() async throws {
    let h = try await harness(removalStatus: .removed)
    #expect(await until { h.model.machines.first?.status == .connected })
    await h.engine.connectSignOut()
    h.engine.setActive(true)
    await h.engine.connectRefresh()
    await h.engine.connectHandleRemoval(Self.removedError)
    try await Task.sleep(for: .milliseconds(50))
    #expect(h.relay.requests(path: "/v1/client/removal-status").isEmpty)
    #expect(h.model.connect?.wasRemoved == false)
    #expect(!h.defaults.bool(forKey: ConnectRuntime.removedKey))
  }

  @Test func registersWithoutAPushTokenAndAgainWhenOneArrives() async throws {
    let h = try await harness(push: true)
    #expect(await until { h.relay.requests(path: "/v1/mobile/devices").count == 1 })
    let first = try #require(h.relay.requests(path: "/v1/mobile/devices").first?.httpBody.flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: Any] })
    #expect(first["deviceId"] as? String == Self.deviceId)
    #expect(first["model"] as? String == "iPhone 16 Pro")
    #expect(first["pushToken"] == nil)
    h.engine.connectSetPushToken(Data([0x0a]))
    #expect(await until { h.relay.requests(path: "/v1/mobile/devices").count == 2 })
    let second = try #require(h.relay.requests(path: "/v1/mobile/devices").last?.httpBody.flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: Any] })
    #expect(second["pushToken"] as? String == "0a")
    #expect(second["apsEnvironment"] as? String == "sandbox")
    #expect((second["preferences"] as? [String: Any])?["notificationsEnabled"] as? Bool == true)
  }
}
