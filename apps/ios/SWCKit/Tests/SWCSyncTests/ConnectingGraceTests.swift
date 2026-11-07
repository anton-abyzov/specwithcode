import Foundation
import Synchronization
import Testing
import SWCTransport
import SWCWire
@testable import SWCSync

/// A clock the test moves by hand.
final class ManualClock: Sendable {
  private let instant = Mutex(ContinuousClock.now)
  var now: ContinuousClock.Instant { instant.withLock { $0 } }
  func advance(_ duration: Duration) { instant.withLock { $0 += duration } }
}

/// How the fake machine's HTTP answers the first attempt.
final class AttemptGate: Sendable {
  enum Mode: Sendable { case hang, fail, answer }
  private let mode: Mutex<Mode>
  init(_ mode: Mode) { self.mode = Mutex(mode) }
  var current: Mode { mode.withLock { $0 } }
  func set(_ value: Mode) { mode.withLock { $0 = value } }
}

/// A machine that has not connected yet reads "Connecting" for the grace
/// after launch, then its real state; a failed attempt shows at once.
@MainActor
@Suite struct ConnectingGraceTests {
  let env = FakeMachine.environmentId

  struct Harness {
    let engine: LiveEngine
    let model: AppModel
    let gate: AttemptGate
    let connector: FakeConnector
  }

  /// A paired machine with a saved thread list, as at every launch.
  func harness(_ mode: AttemptGate.Mode, grace: Duration, clock: ManualClock? = nil, projects: [ProjectShell]? = nil) async throws -> Harness {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("swcgrace-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let registry = MachineRegistry(fileURL: directory.appendingPathComponent("machines.json"))
    try await registry.upsert(MachineRecord(environmentId: env, label: "M4", routes: [try #require(MachineRoute(httpBase: "http://192.168.1.20:8319"))]))
    let credentials = InMemoryCredentialStore([CredentialKey(environmentId: env, issuer: "http://192.168.1.20:8319"): MachineCredential(token: "tok", expiresAt: Date().addingTimeInterval(30 * 86_400), permissions: ["orchestration:read", "orchestration:operate"])])
    let cache = FleetCache(directory: directory.appendingPathComponent("Fleet"))
    await cache.saveSnapshot(try TestData.shell(projects: projects), for: env)
    let machine = FakeMachine()
    let gate = AttemptGate(mode)
    let inner = machine.http()
    let http = FakeHTTP { request in
      while gate.current == .hang { try await Task.sleep(for: .milliseconds(5)) }
      if gate.current == .fail { throw URLError(.cannotConnectToHost) }
      let (data, response) = try await inner.send(request)
      return (response.statusCode, String(decoding: data, as: UTF8.self))
    }
    let connector = FakeConnector(machine)
    let now: @Sendable () -> ContinuousClock.Instant
    if let clock { now = { clock.now } } else { now = { ContinuousClock.now } }
    let engine = LiveEngine(
      registry: registry,
      credentials: credentials,
      http: MachineHTTP(transport: http),
      connector: connector,
      options: LiveEngine.Options(
        publishInterval: .milliseconds(5),
        socketWait: .seconds(3),
        retryDelay: .milliseconds(10),
        connection: MachineConnection.Configuration(probeStagger: .milliseconds(5), stableConnection: .zero, sleepBeforeRetry: { _ in try await Task.sleep(for: .seconds(60)) }),
        monitorsNetwork: false,
        resubscribeDelay: .milliseconds(5),
        resubscribeMaximum: .milliseconds(20),
        connectingGrace: grace,
        now: now
      ),
      fleetCache: cache
    )
    let model = AppModel(engine: engine)
    return Harness(engine: engine, model: model, gate: gate, connector: connector)
  }

  func rows(_ h: Harness) -> [ThreadSummary] { h.model.recentThreads.filter { $0.ref.environmentId == env } }

  /// Nothing on screen says the machine is offline.
  func readsConnecting(_ h: Harness) -> Bool {
    guard let machine = h.model.machine(env), let project = h.model.projects.first, !rows(h).isEmpty else { return false }
    return machine.isSettling && machine.status == .connecting && machine.connectStatusLabelIsAbsent
      && project.machineSettling && !project.showsMachineOffline
      && rows(h).allSatisfy { !$0.showsMachineOffline && !$0.isUnknown }
  }

  @Test func launchReadsConnectingUntilTheGracePasses() async throws {
    let clock = ManualClock()
    let h = try await harness(.hang, grace: .seconds(3), clock: clock)
    defer { h.engine.setActive(false) }
    #expect(await until { readsConnecting(h) })
    let machine = try #require(h.model.machine(env))
    #expect(machine.status.isOnline == false)
    #expect(h.model.isLoading)

    // An open chat has no offline notice: the session is settling, not offline.
    let session = h.model.session(for: .thread(ThreadRef(environmentId: env, threadId: "thr_1")))
    h.engine.open(session)
    #expect(await until { session.machineSettling })
    #expect(!session.machineOnline)
    #expect(!session.showsMachineOffline)

    // Past the grace with the attempt still out, the rows say offline.
    clock.advance(.seconds(3))
    h.engine.publishNow()
    #expect(h.model.machine(env)?.isSettling == false)
    #expect(h.model.projects.first?.showsMachineOffline == true)
    #expect(rows(h).allSatisfy { $0.showsMachineOffline && $0.isUnknown })
    #expect(session.showsMachineOffline)
  }

  @Test func graceExpiryPublishesWithoutAnotherEvent() async throws {
    let h = try await harness(.hang, grace: .milliseconds(300))
    defer { h.engine.setActive(false) }
    #expect(await until { readsConnecting(h) })
    // The attempt never ends, so only the grace timer can change the screen.
    #expect(await until { h.model.projects.first?.showsMachineOffline == true })
    #expect(h.model.machine(env)?.isSettling == false)
    #expect(rows(h).allSatisfy { $0.showsMachineOffline && $0.isUnknown })
  }

  @Test func aFailedAttemptShowsOfflineAtOnce() async throws {
    let h = try await harness(.fail, grace: .seconds(60))
    defer { h.engine.setActive(false) }
    #expect(await until { h.model.machine(env)?.status == .offline && h.model.projects.first?.showsMachineOffline == true })
    let machine = try #require(h.model.machine(env))
    #expect(!machine.isSettling)
    #expect(machine.recoveryTitle == "M4 is unavailable")
    #expect(rows(h).allSatisfy { $0.showsMachineOffline && $0.isUnknown })
    #expect(!h.model.isLoading)
  }

  @Test func aConnectionInsideTheGraceNeverShowsOffline() async throws {
    let h = try await harness(.hang, grace: .seconds(60))
    defer { h.engine.setActive(false) }
    var sawOffline = false
    func record() {
      if h.model.machine(env)?.status == .offline { sawOffline = true }
      if h.model.projects.contains(where: \.showsMachineOffline) || rows(h).contains(where: \.showsMachineOffline) { sawOffline = true }
    }
    for _ in 0..<20 {
      record()
      try await Task.sleep(for: .milliseconds(5))
    }
    h.gate.set(.answer)
    let connected = await until {
      record()
      return h.model.machine(env)?.status == .connected && h.model.projects.first?.machineOnline == true
    }
    #expect(connected)
    #expect(!sawOffline)
    #expect(h.model.machine(env)?.isSettling == false)
  }

  @Test func aLaterDisconnectStillShowsOffline() async throws {
    let h = try await harness(.answer, grace: .seconds(60))
    defer { h.engine.setActive(false) }
    #expect(await until { h.model.machine(env)?.status == .connected && h.model.projects.first?.machineOnline == true })
    h.gate.set(.fail)
    for connection in h.connector.connections.values { connection.close() }
    #expect(await until { h.model.machine(env).map { !$0.status.isOnline } == true && h.model.projects.first?.showsMachineOffline == true })
    #expect(h.model.machine(env)?.isSettling == false)
    #expect(rows(h).allSatisfy { $0.showsMachineOffline })
  }

  @Test func returningToTheFrontStartsTheGraceAgain() async throws {
    let h = try await harness(.answer, grace: .seconds(60))
    defer { h.engine.setActive(false) }
    #expect(await until { h.model.machine(env)?.status == .connected })
    h.gate.set(.hang)
    h.engine.setActive(false)
    #expect(await until { h.model.machine(env)?.status == .offline })
    h.engine.setActive(true)
    #expect(await until { h.model.machine(env)?.isSettling == true && h.model.projects.first?.showsMachineOffline == false })
    h.gate.set(.answer)
    #expect(await until { h.model.machine(env)?.status == .connected && h.model.machine(env)?.isSettling == false })
  }

  @Test func aProjectChatOpenAtLaunchSaysOfflineWhenTheGraceRunsOut() async throws {
    let h = try await harness(.hang, grace: .milliseconds(300))
    defer { h.engine.setActive(false) }
    #expect(await until { readsConnecting(h) })
    // A project chat has no thread until it has a socket, so only the grace
    // timer's publish can tell it the machine is offline.
    let project = try #require(h.model.projects.first)
    let session = h.model.session(for: .project(project.ref))
    h.engine.open(session)
    #expect(await until { session.machineSettling })
    #expect(!session.showsMachineOffline)
    // Well before the next status change, which can take 5 seconds or more.
    #expect(await until(timeout: .seconds(1)) { session.showsMachineOffline })
    #expect(!session.machineSettling)
  }

  @Test func aDroppedConnectionReadsConnectingWhileItReconnects() async throws {
    let clock = ManualClock()
    let h = try await harness(.answer, grace: .seconds(3), clock: clock)
    defer { h.engine.setActive(false) }
    #expect(await until { h.model.machine(env)?.status == .connected && h.model.projects.first?.machineOnline == true })
    clock.advance(.seconds(30))
    h.gate.set(.hang)
    for connection in h.connector.connections.values { connection.close() }
    #expect(await until { h.model.machine(env)?.status.isOnline == false && readsConnecting(h) })

    // Still not back after the grace: now the rows say offline.
    clock.advance(.seconds(3))
    h.engine.publishNow()
    #expect(h.model.machine(env)?.isSettling == false)
    #expect(h.model.projects.first?.showsMachineOffline == true)
    #expect(rows(h).allSatisfy { $0.showsMachineOffline })
  }

  @Test func turningAMachineBackOnReadsConnecting() async throws {
    let h = try await harness(.answer, grace: .seconds(60))
    defer { h.engine.setActive(false) }
    #expect(await until { h.model.machine(env)?.status == .connected })
    try await h.engine.setConnectionEnabled(false, machineId: env)
    #expect(await until { h.model.machine(env)?.isDisconnected == true && h.model.machine(env)?.isSettling == false })
    h.gate.set(.hang)
    try await h.engine.setConnectionEnabled(true, machineId: env)
    #expect(await until { h.model.machine(env)?.isDisconnected == false && readsConnecting(h) })
    h.gate.set(.answer)
    #expect(await until { h.model.machine(env)?.status == .connected && h.model.machine(env)?.isSettling == false })
  }

  @Test func aLinkedProjectIsNotUnreachableInsideTheGraceAfterReturning() async throws {
    var linked = try TestData.project(id: "proj_1", title: "Specweave")
    linked.workspaceSettings?.logicalProject = LogicalProject(id: "lp1", title: "Specweave", coordinatorId: "c")
    linked.workspaceSettings?.coordinatorBinding = CoordinatorBinding(epoch: 1, state: .active)
    let clock = ManualClock()
    // The first session's attempt failed, so the machine has answered once.
    let h = try await harness(.fail, grace: .seconds(3), clock: clock, projects: [linked])
    defer { h.engine.setActive(false) }
    #expect(await until { h.model.projects.first?.showsMachineOffline == true })
    let ref = try #require(h.model.projects.first?.ref)
    #expect(h.engine.linkedCopies(of: ref, in: h.model).first?.machineSettled == true)

    h.gate.set(.hang)
    h.engine.setActive(false)
    // The background resets the connection's status, failure included.
    #expect(await until { h.engine.machines[env]?.status.lastError == nil })
    h.engine.setActive(true)
    #expect(await until { readsConnecting(h) })
    let copy = try #require(h.engine.linkedCopies(of: ref, in: h.model).first)
    #expect(!copy.machineSettled)
    #expect(!copy.machineOnline)

    clock.advance(.seconds(3))
    h.engine.publishNow()
    #expect(h.engine.linkedCopies(of: ref, in: h.model).first?.machineSettled == true)
  }
}

private extension MachineSummary {
  /// No "Offline · checked" line for a Connect machine either.
  var connectStatusLabelIsAbsent: Bool { !(viaConnect && status == .offline) }
}
