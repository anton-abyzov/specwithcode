import Foundation
import Testing
import SWCTransport
@testable import SWCSync

@Suite struct AllowDeviceCodeTests {
  @Test(arguments: [
    ("abc234", "ABC234"),
    ("ab-c2 34", "ABC234"),
    ("  a b c 2 3 4 5 6", "ABC234"),
    ("ab!c", "ABC"),
    ("é1", "1"),
    ("", ""),
  ])
  func normalizes(typed: String, expected: String) {
    #expect(AllowDeviceCode.normalized(typed) == expected)
  }
}

@Suite struct AllowDeviceOutcomeTests {
  private let now = Date(timeIntervalSince1970: 1_800_000_000)
  private func device(expiresIn: TimeInterval) -> WaitingDevice {
    WaitingDevice(id: "r1", label: "Test tablet", shortId: "K3PX", expiresAt: now.addingTimeInterval(expiresIn))
  }

  @Test func approvedNamesTheDevice() {
    let outcome = AllowDeviceOutcome.from(
      ConnectDeviceApproval(status: .approved, deviceLabel: "Test tablet", deviceShortId: "K3PX"),
      waitingAfter: nil, now: now
    )
    #expect(outcome == .allowed(name: "Test tablet", shortId: "K3PX"))
    #expect(outcome.message(machine: "Office Mac") == "Allowed Test tablet · K3PX")
    #expect(outcome.isSuccess)
  }

  @Test func notFoundWithADeviceStillListedIsAWrongCode() {
    let approval = ConnectDeviceApproval(status: .notFound)
    #expect(AllowDeviceOutcome.from(approval, waitingAfter: [device(expiresIn: 60)], now: now) == .wrongCode)
  }

  @Test func notFoundWithNothingLeftIsExpired() {
    let approval = ConnectDeviceApproval(status: .notFound)
    #expect(AllowDeviceOutcome.from(approval, waitingAfter: [], now: now) == .expired)
    #expect(AllowDeviceOutcome.from(approval, waitingAfter: [device(expiresIn: -1)], now: now) == .expired)
    #expect(AllowDeviceOutcome.expired.message(machine: "M") == "That request expired. Ask the device for a new code.")
  }

  @Test func notFoundWithAnUnknownListDoesNotClaimExpiry() {
    #expect(AllowDeviceOutcome.from(ConnectDeviceApproval(status: .notFound), waitingAfter: nil, now: now) == .wrongCode)
  }

  @Test func ownCodeAndPausedSpeakPlainly() {
    #expect(AllowDeviceOutcome.from(ConnectDeviceApproval(status: .own), waitingAfter: nil, now: now) == .ownCode)
    #expect(AllowDeviceOutcome.ownCode.message(machine: "M") == "That is this phone's own code.")
    #expect(AllowDeviceOutcome.from(ConnectDeviceApproval(status: .paused), waitingAfter: nil, now: now) == .paused)
    #expect(AllowDeviceOutcome.paused.message(machine: "M") == "Too many wrong codes. Try again in 10 minutes.")
    #expect(AllowDeviceOutcome.unreachable.message(machine: "Office Mac") == "Couldn't reach Office Mac")
  }

  @Test(arguments: [
    (TransportError.http(status: 403, code: nil), AllowDeviceListing.unavailable),
    (.http(status: 404, code: nil), .unavailable),
    (.invalidResponse("bad"), .unavailable),
    (.needsRepair, .unavailable),
    (.awaitingApproval(code: "", message: "waiting"), .waitingHere),
    (.connect(.signedOut), .unavailable),
    (.connect(.relay(status: 403, code: "environment_connect_not_authorized", reason: nil)), .unavailable),
    (.connect(.unreachable("down")), .unreachable),
    (.connect(.relay(status: 502, code: nil, reason: nil)), .unreachable),
    (.connect(.relay(status: 429, code: nil, reason: nil)), .unreachable),
    (.teamRules(message: "off"), .unavailable),
    (.unreachable("down"), .unreachable),
    (.timedOut, .unreachable),
    (.closed, .unreachable),
    (.http(status: 503, code: nil), .unreachable),
    (.http(status: 429, code: nil), .unreachable),
  ])
  func aFailedRequestOnlyChangesTheCard(error: TransportError, listing: AllowDeviceListing) {
    #expect(AllowDeviceListing.after(error) == listing)
  }
}

@MainActor
@Suite struct AllowDeviceEngineTests {
  private let env = FakeMachine.environmentId
  private nonisolated static let list = #"{"machine":"M","health":"ok","canApprove":true,"canRepair":false,"needsReview":false,"devices":[],"notices":[],"pending":[{"id":"r1","kind":"connect","label":"Test tablet","shortId":"K3PX","askedAt":"2026-10-18T06:00:00.000Z","expiresAt":"2099-10-18T06:05:00.000Z"}]}"#

  private func engine(_ devices: @escaping @Sendable (URLRequest) -> (Int, String)) async throws -> (LiveEngine, AppModel, FakeHTTP) {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("swcsync-allow-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let registry = MachineRegistry(fileURL: directory.appendingPathComponent("machines.json"))
    try await registry.upsert(MachineRecord(environmentId: env, label: "Test machine", routes: [try #require(MachineRoute(httpBase: "http://192.168.1.20:8319"))]))
    let credentials = InMemoryCredentialStore([CredentialKey(environmentId: env, issuer: "http://192.168.1.20:8319"): MachineCredential(token: "tok", expiresAt: Date().addingTimeInterval(86_400), permissions: [])])
    let machine = FakeMachine(config: FakeMachine.config)
    let base = machine.http()
    let http = FakeHTTP { request in
      if request.url?.path.hasPrefix("/api/auth/connect-devices/") == true { return devices(request) }
      let (data, response) = try await base.send(request)
      return (response.statusCode, String(decoding: data, as: UTF8.self))
    }
    let engine = LiveEngine(
      registry: registry,
      credentials: credentials,
      http: MachineHTTP(transport: http),
      connector: FakeConnector(machine),
      options: LiveEngine.Options(
        publishInterval: .milliseconds(5),
        connection: MachineConnection.Configuration(probeStagger: .milliseconds(5), stableConnection: .zero),
        monitorsNetwork: false
      )
    )
    let model = AppModel(engine: engine)
    #expect(await until { model.machines.first?.status == .connected })
    return (engine, model, http)
  }

  @Test func listsWaitingDevices() async throws {
    let (engine, _, _) = try await engine { _ in (200, Self.list) }
    defer { engine.setActive(false) }
    guard case let .ready(devices) = await engine.allowDeviceListing(machineId: env) else {
      Issue.record("expected a list")
      return
    }
    #expect(devices.map(\.label) == ["Test tablet"])
  }

  @Test func aServerWithoutTheListShowsNothingAndStaysConnected() async throws {
    let (engine, model, _) = try await engine { _ in (404, "") }
    defer { engine.setActive(false) }
    #expect(await engine.allowDeviceListing(machineId: env) == .unavailable)
    #expect(model.machines.first?.status == .connected)
  }

  @Test func aSessionThatCannotApproveShowsNothing() async throws {
    let body = Self.list.replacingOccurrences(of: #""canApprove":true"#, with: #""canApprove":false"#)
    let (engine, _, _) = try await engine { _ in (200, body) }
    defer { engine.setActive(false) }
    #expect(await engine.allowDeviceListing(machineId: env) == .unavailable)
  }

  @Test func aWrongCodeWithTheDeviceStillListedSaysWrong() async throws {
    let (engine, _, _) = try await engine { request in
      request.url?.path.hasSuffix("/approve") == true ? (200, #"{"status":"not-found"}"#) : (200, Self.list)
    }
    defer { engine.setActive(false) }
    #expect(await engine.allowDevice(code: "ABC234", machineId: env) == .wrongCode)
  }

  @Test func aRefusalMidSessionTakesTheCardAway() async throws {
    let (engine, model, _) = try await engine { _ in (403, #"{"message":"no"}"#) }
    defer { engine.setActive(false) }
    #expect(await engine.allowDevice(code: "ABC234", machineId: env) == .noLongerAllowed)
    #expect(model.machines.first?.status == .connected)
  }

  @Test func aFailedRequestReportsUnreachable() async throws {
    let (engine, _, _) = try await engine { _ in (503, "") }
    defer { engine.setActive(false) }
    #expect(await engine.allowDevice(code: "ABC234", machineId: env) == .unreachable)
  }

  @Test func aNetworkFailureRenewingAccessIsNotALostRight() async throws {
    #expect(AllowDeviceOutcome.after(TransportError.connect(.unreachable("down"))) == .unreachable)
    #expect(AllowDeviceOutcome.after(TransportError.connect(.relay(status: 503, code: nil, reason: nil))) == .unreachable)
    #expect(AllowDeviceOutcome.after(TransportError.connect(.signedOut)) == .noLongerAllowed)
    #expect(AllowDeviceOutcome.after(TransportError.awaitingApproval(code: "", message: "waiting")) == .noLongerAllowed)
  }

  @Test func aPhoneWaitingOverConnectStopsAsking() async throws {
    let refusal = #"{"refusal":"device_not_approved","approvalCode":"WAIT00","teamRulesMessage":"Waiting"}"#
    let (engine, model, _) = try await engine { _ in (403, refusal) }
    defer { engine.setActive(false) }
    #expect(await engine.allowDeviceListing(machineId: env) == .waitingHere)
    #expect(model.machines.first?.status == .connected)
  }

  @Test func aMachineThisPhoneWaitsOnAsksNothing() async throws {
    let (engine, _, http) = try await engine { _ in (200, Self.list) }
    defer { engine.setActive(false) }
    engine.machines[env]?.approvalCode = "WAIT00"
    #expect(await engine.allowDeviceListing(machineId: env) == .unavailable)
    #expect(await engine.allowDevice(code: "ABC234", machineId: env) == .unreachable)
    #expect(http.requests(path: "/api/auth/connect-devices/list").isEmpty)
    engine.machines[env]?.approvalCode = nil
  }

  @Test func theFixtureHoldsNoCodeAndShowsEachState() async throws {
    let fixture = FixtureEngine(scenario: .allowDevice)
    fixture.latency = .zero
    let model = AppModel(engine: fixture)
    #expect(await until { !model.machines.isEmpty })
    let studio = "env-studio-mac"
    guard case let .ready(devices) = await fixture.allowDeviceListing(machineId: studio) else {
      Issue.record("expected the waiting devices")
      return
    }
    #expect(devices.map(\.label) == ["Spare iPad", "Work laptop"])
    #expect(await fixture.allowDeviceListing(machineId: "env-build-box") == .unavailable)
    #expect(await fixture.allowDevice(code: "WRONG1", machineId: studio) == .wrongCode)
    #expect(await fixture.allowDevice(code: "PAUSE1", machineId: studio) == .paused)
    #expect(await fixture.allowDevice(code: "SELF12", machineId: studio) == .ownCode)
    #expect(await fixture.allowDevice(code: "ABC234", machineId: studio) == .allowed(name: "Spare iPad", shortId: "K3PX"))
  }
}
