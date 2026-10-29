import Foundation
import Testing
import SWCTransport
@testable import SWCSync

@MainActor
@Suite struct OfflineRecoveryTests {
  @Test func disconnectRetainsCredentialsAndConversationThenReconnects() async throws {
    let support = LiveEngineTests()
    let h = try await support.harness()
    defer { h.engine.setActive(false) }
    #expect(await support.loaded(h))
    let env = FakeMachine.environmentId
    let target = ChatTarget.thread(ThreadRef(environmentId: env, threadId: "thr_1"))
    let session = h.model.session(for: target)
    h.engine.open(session)
    #expect(await until { session.isLoaded })
    let rows = session.rows
    let before = try #require(await h.registry.machine(env))
    let credential = h.engine.credentials.bestCredential(for: before)

    try await h.engine.setConnectionEnabled(false, machineId: env)
    #expect(h.model.machine(env)?.isDisconnected == true)
    #expect(h.model.machine(env)?.status == .offline)
    #expect(await h.registry.machine(env)?.enabled == false)
    #expect(h.engine.credentials.bestCredential(for: before)?.token == credential?.token)
    #expect(session.rows == rows)
    #expect(!h.model.projects.isEmpty)
    #expect(session.sendBlockedReason != nil)
    // Neither app foregrounding nor network/automatic retry may override the local pause.
    h.engine.setActive(false)
    h.engine.setActive(true)
    h.engine.wake(machineId: env)
    h.engine.reconnect(machineId: env)
    #expect(await untilAsync { await h.engine.machines[env]?.connection.status.state == .offline })
    #expect(h.model.machine(env)?.isDisconnected == true)

    let restarted = LiveEngine(registry: h.registry, credentials: h.engine.credentials,
      http: MachineHTTP(transport: h.machine.http()), connector: h.connector,
      options: LiveEngine.Options(monitorsNetwork: false))
    let model = AppModel(engine: restarted)
    defer { restarted.setActive(false) }
    #expect(await until { model.machine(env)?.isDisconnected == true })
    #expect(model.machine(env)?.status == .offline)
    restarted.setActive(false)

    try await h.engine.setConnectionEnabled(true, machineId: env)
    #expect(await until { h.model.machine(env)?.status == .connected && session.sendBlockedReason == nil })
    #expect(h.model.machine(env)?.isDisconnected == false)
    #expect(await h.registry.machine(env)?.enabled == true)
  }

  @Test(arguments: [false, true]) func connectDiscoveryKeepsLocalDisconnect(directlyPaired: Bool) async throws {
    let h = try await ConnectEngineTests().harness(directlyPaired: directlyPaired)
    defer { h.engine.setActive(false) }
    let env = FakeMachine.environmentId
    #expect(await until { h.model.machine(env)?.status == .connected })
    try await h.engine.setConnectionEnabled(false, machineId: env)
    let route = try #require(await h.registry.machine(env)?.connectRoute)
    // Refresh the real account discovery path with the same known environment.
    await h.engine.connectRefresh()
    #expect(await h.registry.machine(env)?.enabled == false)
    #expect(await h.registry.machine(env)?.connectRoute == route)
    #expect(h.model.machine(env)?.isDisconnected == true)
    #expect(h.model.machine(env)?.status == .offline)
  }

  @Test func recoveryDistinguishesNetworkPairingAccountAndLocalPause() {
    var machine = MachineSummary(id: "m", label: "Mac", status: .offline)
    #expect(machine.canRetryConnection)
    #expect(machine.recoveryMessage.hasPrefix("Use SpecWithCode Connect"))
    #expect(machine.recoveryMessage.contains("Tailscale"))
    machine.status = .needsRepair
    #expect(machine.recoveryTitle == "Connection needs attention")
    #expect(machine.recoveryMessage.hasPrefix("Use SpecWithCode Connect"))
    #expect(!machine.canRetryConnection)
    machine.viaConnect = true
    machine.status = .offline
    #expect(machine.recoveryMessage.hasPrefix("SpecWithCode Connect is the primary connection"))
    machine.status = .needsRepair
    machine.hasDirectPairing = false
    #expect(machine.recoveryTitle == "Connection needs attention")
    #expect(!machine.recoveryMessage.contains("expired"))
    machine.needsSignIn = true
    #expect(machine.recoveryTitle == "Sign in again")
    machine.isDisconnected = true
    #expect(machine.recoveryTitle == "Disconnected on this phone")
    #expect(!machine.canRetryConnection)
  }

  @Test func fleetDiscoveryUsesLiveSocketBeforeStatusIsPublished() async throws {
    let h = try await FleetEngineTests().harness()
    defer { h.engine.setActive(false) }
    #expect(await until { h.model.machines.count == 2 && !h.engine.fleetLinking })
    let env = FakeMachine.environmentId
    let entry = try #require(h.engine.machines[env])
    // Reproduce the order where config is delivered ahead of the status stream.
    entry.status = MachineConnection.Status(state: .connecting)
    h.engine.fleetLinkedAt[env] = nil
    let before = h.http.requests(path: "/api/studio/fleet/phone").count
    await h.engine.linkFleet(via: entry)
    #expect(h.http.requests(path: "/api/studio/fleet/phone").count == before + 1)
  }
}
