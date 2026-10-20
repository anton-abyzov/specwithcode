import Foundation
import Synchronization
import Testing
import SWCTransport
import SWCWire
@testable import SWCSync

/// Turns a fake machine off and on: its HTTP refuses connections and its
/// sockets close, as when the Mac sleeps or leaves the network.
final class PowerSwitch: Sendable {
  private let on = Mutex(true)
  var isOn: Bool { on.withLock { $0 } }
  func set(_ value: Bool) { on.withLock { $0 = value } }
}

final class SwitchedConnector: WebSocketConnector {
  let inner: FakeConnector
  let power: PowerSwitch

  init(_ inner: FakeConnector, power: PowerSwitch) {
    self.inner = inner
    self.power = power
  }

  func connect(to url: URL) async throws -> any WebSocketConnection {
    guard power.isOn else { throw URLError(.cannotConnectToHost) }
    return try await inner.connect(to: url)
  }

  /// Drops every open socket.
  func cut() {
    for connection in inner.connections.values { connection.close() }
  }
}

@MainActor
@Suite struct FleetEngineTests {
  let env = FakeMachine.environmentId
  nonisolated static let minis = "env-2"

  struct Harness {
    let engine: LiveEngine
    let model: AppModel
    let machine: FakeMachine
    let http: FakeHTTP
    let registry: MachineRegistry
    let credentials: InMemoryCredentialStore
    let connector: SwitchedConnector
    let power: PowerSwitch
    let cache: FleetCache
  }

  /// The hub roster: M4 plus a Mac mini the phone has never paired with.
  nonisolated static func roster(mint: [String]) -> String {
    let pairing = mint.contains(minis) ? #","pairing":{"code":"code-minis","expiresAt":"2099-01-01T00:00:00.000Z"}"# : ""
    return #"{"hub":{"environmentId":"env-1","label":"M4"},"machines":[{"environmentId":"env-2","label":"Sam's Mac mini","routes":[{"kind":"lan","httpBaseUrl":"http://192.168.1.30:8319"}]\#(pairing)}]}"#
  }

  nonisolated static func mint(_ request: URLRequest) -> [String] {
    guard let body = request.httpBody, let json = try? JSONDecoder().decode([String: [String]].self, from: body) else { return [] }
    return json["mint"] ?? []
  }

  func harness(cache prepare: (FleetCache) async throws -> Void = { _ in }, startOn: Bool = true, config: String = FakeMachine.config) async throws -> Harness {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("swcfleet-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let registry = MachineRegistry(fileURL: directory.appendingPathComponent("machines.json"))
    try await registry.upsert(MachineRecord(environmentId: env, label: "M4", routes: [try #require(MachineRoute(httpBase: "http://192.168.1.20:8319"))]))
    let credentials = InMemoryCredentialStore([CredentialKey(environmentId: env, issuer: "http://192.168.1.20:8319"): MachineCredential(token: "tok", expiresAt: Date().addingTimeInterval(30 * 86_400), permissions: ["orchestration:read", "orchestration:operate"])])
    let cache = FleetCache(directory: directory.appendingPathComponent("Fleet"))
    try await prepare(cache)
    let machine = FakeMachine(config: config)
    let power = PowerSwitch()
    power.set(startOn)
    let hub = machine.http()
    let http = FakeHTTP { request in
      guard power.isOn else { throw URLError(.cannotConnectToHost) }
      let host = request.url?.host ?? ""
      switch (host, request.url?.path ?? "") {
      case ("192.168.1.30", "/.well-known/studio/environment"):
        return (200, #"{"environmentId":"env-2","label":"Sam's Mac mini","platform":{"os":"darwin","arch":"arm64"},"serverVersion":"1.0.50","orchestrationProtocolVersion":2,"capabilities":{}}"#)
      case ("192.168.1.30", "/oauth/token"):
        return (200, #"{"access_token":"tok-minis","token_type":"Bearer","expires_in":2592000,"scope":"orchestration:read orchestration:operate"}"#)
      case ("192.168.1.30", _):
        return (404, "")
      case (_, "/.well-known/studio/environment"):
        // As a real machine, the descriptor and config agree on the name.
        return (200, FakeMachine.descriptor().replacingOccurrences(of: "Wire Probe", with: "M4"))
      case (_, "/api/studio/fleet/phone"):
        return (200, Self.roster(mint: Self.mint(request)))
      default:
        let (data, response) = try await hub.send(request)
        return (response.statusCode, String(decoding: data, as: UTF8.self))
      }
    }
    let connector = SwitchedConnector(FakeConnector(machine), power: power)
    let engine = LiveEngine(
      registry: registry,
      credentials: credentials,
      http: MachineHTTP(transport: http),
      connector: connector,
      options: LiveEngine.Options(
        publishInterval: .milliseconds(5),
        socketWait: .seconds(3),
        retryDelay: .milliseconds(10),
        connection: MachineConnection.Configuration(probeStagger: .milliseconds(5), stableConnection: .zero),
        monitorsNetwork: false,
        resubscribeDelay: .milliseconds(5),
        resubscribeMaximum: .milliseconds(20)
      ),
      fleetCache: cache
    )
    let model = AppModel(engine: engine)
    return Harness(engine: engine, model: model, machine: machine, http: http, registry: registry, credentials: credentials, connector: connector, power: power, cache: cache)
  }

  func rows(_ h: Harness) -> [ThreadSummary] { h.model.recentThreads.filter { $0.ref.environmentId == env } }

  // MARK: Fleet linking

  @Test func linksTheRestOfTheFleetThroughOneMachine() async throws {
    let h = try await harness()
    #expect(await until { h.model.machines.first?.status == .connected })
    #expect(await until { h.http.requests(path: "/oauth/token").count == 1 })
    let fleet = h.http.requests(path: "/api/studio/fleet/phone")
    #expect(fleet.map(Self.mint) == [[], [Self.minis]])
    #expect(fleet.allSatisfy { $0.url?.host == "192.168.1.20" && $0.value(forHTTPHeaderField: "Authorization") == "Bearer tok" })
    #expect(await until { h.model.machines.count == 2 })
    let minis = try #require(await h.registry.machine(Self.minis))
    #expect(minis.routes.contains { $0.address == "http://192.168.1.30:8319" })
    #expect(try h.credentials.credential(for: try #require(minis.routes.first), of: Self.minis)?.token == "tok-minis")
  }

  @Test func machinesGoByTheNicknamesInTheirSettings() async throws {
    let nicknames = #""machineNicknames":{"env-1":{"name":"Office","updatedAt":"2026-10-20T21:00:00.000Z"},"env-2":{"name":"Minis","updatedAt":"2026-10-20T21:00:00.000Z"}},"#
    let h = try await harness(config: FakeMachine.config.replacingOccurrences(of: #""settings":{"#, with: #""settings":{\#(nicknames)"#))
    #expect(await until { Set(h.model.machines.map(\.displayName)) == ["Office", "Minis"] })
    #expect(h.model.machines.first { $0.id == env }?.label == "M4")
    #expect(await until { !rows(h).isEmpty && rows(h).allSatisfy { $0.placement.owner == "Office" } })
  }

  @Test func neverRelinksAMachineThePersonRemoved() async throws {
    let h = try await harness(cache: { await $0.dismiss(Self.minis) })
    #expect(await until { h.http.requests(path: "/api/studio/fleet/phone").count == 1 })
    try await Task.sleep(for: .milliseconds(100))
    #expect(h.http.requests(path: "/api/studio/fleet/phone").map(Self.mint) == [[]])
    #expect(h.http.requests(path: "/oauth/token").isEmpty)
    #expect(await h.registry.machine(Self.minis) == nil)
    // Its roster name is still known for threads that run there.
    #expect(await h.cache.labels()[Self.minis] == "Sam's Mac mini")
  }

  // MARK: A machine going away and coming back

  @Test func unreachableMachineKeepsItsSavedThreadsAsUnknown() async throws {
    let seen = Date(timeIntervalSince1970: 1_792_510_000)
    let h = try await harness(cache: { cache in
      await cache.saveSnapshot(try TestData.shell(), for: FakeMachine.environmentId)
      await cache.setLastSeen(seen, for: FakeMachine.environmentId)
    }, startOn: false)
    #expect(await until { rows(h).count == 1 })
    let row = try #require(rows(h).first)
    #expect(row.isUnknown)
    #expect(row.placement.unknown?.lastSeenAt == seen)
    #expect(row.placement.label == "M4")
    #expect(h.model.projects.first?.workingCount == 0)

    // Back: the live list replaces the saved one, with no second row.
    h.power.set(true)
    h.engine.reconnect(machineId: env)
    #expect(await until { h.model.machines.first?.status == .connected && rows(h).first?.isUnknown == false })
    #expect(rows(h).map(\.ref.threadId) == ["thr_1"])
    #expect(h.model.projects.count == 1)
  }

  @Test func machineOffMidSessionThenBackLeavesNoDuplicates() async throws {
    let h = try await harness()
    #expect(await until { h.model.machines.first?.label == "M4" && h.model.machines.first?.status == .connected && rows(h).count == 1 })
    #expect(rows(h).first?.isUnknown == false)

    h.power.set(false)
    h.connector.cut()
    #expect(await until { h.model.machines.first?.status != .connected && rows(h).first?.isUnknown == true })
    let unknown = try #require(rows(h).first)
    #expect(unknown.placement.unknown?.lastSeenAt != nil)
    #expect(unknown.placement.subtitle().hasPrefix("M4 · Unknown · last seen "))
    #expect(await untilAsync { await h.cache.cached(env).snapshot?.threads.map(\.id) == ["thr_1"] })

    h.power.set(true)
    h.engine.reconnect(machineId: env)
    #expect(await until { h.model.machines.first?.status == .connected && rows(h).first?.isUnknown == false })
    #expect(rows(h).map(\.ref.threadId) == ["thr_1"])
    #expect(h.model.threads(in: try #require(h.model.projects.first).ref).count == 1)
  }

  @Test func removingAMachineDismissesIt() async throws {
    let h = try await harness()
    #expect(await until { h.model.machines.count == 2 })
    h.engine.removeMachine(id: Self.minis)
    #expect(await until { h.model.machines.count == 1 })
    #expect(await untilAsync { await h.cache.dismissed() == [Self.minis] })
  }
}

/// `until` with an async condition.
@MainActor func untilAsync(timeout: Duration = .seconds(5), _ condition: () async -> Bool) async -> Bool {
  let deadline = ContinuousClock.now + timeout
  while ContinuousClock.now < deadline {
    if await condition() { return true }
    try? await Task.sleep(for: .milliseconds(5))
  }
  return await condition()
}
