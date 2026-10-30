import Foundation
import Testing
import SWCTransport
import SWCWire
@testable import SWCSync

@MainActor
@Suite struct LiveEngineTests {
  let env = FakeMachine.environmentId

  struct Harness {
    let engine: LiveEngine
    let model: AppModel
    let machine: FakeMachine
    let registry: MachineRegistry
    let connector: FakeConnector
  }

  func harness(permissions: [String] = ["orchestration:read", "orchestration:operate"], failing: [String: String] = [:], staleThreadGrace: Duration = .seconds(3), resyncInterval: Duration = .seconds(10)) async throws -> Harness {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("swcsync-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let registry = MachineRegistry(fileURL: directory.appendingPathComponent("machines.json"))
    try await registry.upsert(MachineRecord(environmentId: env, label: "Old label", routes: [try #require(MachineRoute(httpBase: "http://192.168.1.20:8319"))]))
    let credentials = InMemoryCredentialStore([CredentialKey(environmentId: env, issuer: "http://192.168.1.20:8319"): MachineCredential(token: "tok", expiresAt: Date().addingTimeInterval(30 * 86_400), permissions: permissions)])
    let machine = FakeMachine()
    for (tag, error) in failing { machine.fail(tag, with: error) }
    let connector = FakeConnector(machine)
    let engine = LiveEngine(
      registry: registry,
      credentials: credentials,
      http: MachineHTTP(transport: machine.http()),
      connector: connector,
      options: LiveEngine.Options(
        publishInterval: .milliseconds(5),
        socketWait: .seconds(3),
        retryDelay: .milliseconds(10),
        connection: MachineConnection.Configuration(probeStagger: .milliseconds(5), stableConnection: .zero),
        monitorsNetwork: false,
        resubscribeDelay: .milliseconds(5),
        resubscribeMaximum: .milliseconds(20),
        staleThreadGrace: staleThreadGrace,
        resyncInterval: resyncInterval
      )
    )
    let model = AppModel(engine: engine)
    return Harness(engine: engine, model: model, machine: machine, registry: registry, connector: connector)
  }

  func loaded(_ h: Harness) async -> Bool {
    await until { !h.model.isLoading && h.model.machines.first?.label == "M4" && h.model.projects.count == 1 }
  }

  @Test func lateProbeStatusDoesNotOverwriteServerName() async throws {
    let h = try await harness()
    defer { h.engine.setActive(false) }
    #expect(await until { h.engine.machines[env]?.config != nil })
    let entry = try #require(h.engine.machines[env])
    let socket = try #require(entry.socket)
    await h.engine.loadConfig(entry, socket)
    let probe = EnvironmentDescriptorLite(environmentId: env, label: "Wire Probe")
    h.engine.statusChanged(env, .init(state: .connected, descriptor: probe))
    h.engine.publishNow()
    #expect(h.model.machines.first?.label == "M4")
  }

  @Test func startFillsTheModelFromTheShell() async throws {
    let h = try await harness()
    #expect(await loaded(h))
    let machine = try #require(h.model.machines.first)
    #expect(machine.status == .connected)
    #expect(machine.platform == "macOS · arm64")
    #expect(machine.serverVersion == "1.0.50")

    let project = try #require(h.model.projects.first)
    #expect(project.title == "SpecWeave")
    #expect(project.isPinned)
    #expect(h.model.threads(in: project.ref).map(\.ref.threadId) == ["thr_1"])
    #expect(h.model.recentThreads.map(\.title) == ["Fix login"])
    #expect(h.model.aide == nil)

    let shell = try #require(h.machine.payloads("orchestration.subscribeShell").first)
    #expect(shell["requestCompletionMarker"] == .bool(true))
    #expect(shell["afterSequence"] == nil)

    // The label and the learned route are saved.
    #expect(await until { h.machine.requests("server.getConfig").count == 1 })
    let saved = await h.registry.machine(env)
    #expect(saved?.label == "M4")
    #expect(saved?.routes.contains { $0.learned && $0.address == "http://192.168.1.21:8319" } == true)
  }

  @Test func openThreadStreamsRowsAndSends() async throws {
    let h = try await harness()
    #expect(await loaded(h))
    let target = ChatTarget.thread(ThreadRef(environmentId: env, threadId: "thr_1"))
    let session = h.model.session(for: target)
    h.engine.open(session)
    #expect(await until { session.isLoaded && session.rows.count == 1 })
    #expect(session.rows.first?.kind == .tool(title: "Ran ls", detail: "a\nb", symbol: "terminal", status: .completed))
    #expect(session.isRunning)
    #expect(session.plan == PlanProgress(completed: 0, total: 1))
    #expect(session.sendBlockedReason == nil)
    #expect(!session.isStale)
    let subscribe = try #require(h.machine.payloads("orchestration.subscribeThread").first)
    #expect(subscribe["threadId"] == .string("thr_1"))
    #expect(subscribe["acceptBoundedSnapshot"] == .bool(true))

    try await h.engine.send("  Next step  ", to: target)
    let dispatch = try #require(h.machine.payloads("orchestration.dispatchCommand").first)
    #expect(dispatch["type"] == .string("message.dispatch"))
    #expect(dispatch["text"] == .string("Next step"))
    #expect(dispatch["dispatchMode"]?["type"] == .string("queue_after_active"))
    // Shown as sending until the machine has it.
    #expect(session.rows.last?.kind == .user(text: "Next step", state: .sending))
    #expect(session.rows.last?.id.hasPrefix("pending:") == true)

    try await h.engine.stop(target)
    let interrupt = try #require(h.machine.payloads("orchestration.dispatchCommand").last)
    #expect(interrupt["type"] == .string("run.interrupt"))
    #expect(interrupt["runId"] == .string("run_1"))
    #expect(interrupt["holdQueue"] == .bool(true))

    h.engine.close(session)
  }

  @Test func coordinatorChatUsesTheProjectsThread() async throws {
    let h = try await harness()
    #expect(await loaded(h))
    let ref = ProjectRef(environmentId: env, projectId: "proj_1")
    let session = h.model.session(for: .project(ref))
    h.engine.open(session)
    #expect(await until { h.machine.payloads("orchestration.subscribeThread").first?["threadId"] == .string("project-coordinator:proj_1") })
    #expect(session.subtitle == "Coordinator · M4")

    try await h.engine.send("Plan the week", to: .project(ref))
    let send = try #require(h.machine.payloads("projects.coordinatorSend").first)
    #expect(send["projectId"] == .string("proj_1"))
    #expect(send["prompt"] == .string("Plan the week"))
    // The thread the machine answered with becomes the session's thread.
    #expect(await until { h.machine.payloads("orchestration.subscribeThread").last?["threadId"] == .string("thr_coord") })
  }

  @Test func renamesShowWithoutReconnecting() async throws {
    let h = try await harness()
    #expect(await loaded(h))
    #expect(await until { h.machine.requests("subscribeServerConfig").count == 1 })
    let streamId = try #require(h.machine.requests("subscribeServerConfig").last?["id"]?.intValue)
    let socket = try #require(h.connector.connections.values.last)
    func renamed(_ name: String, at time: String) -> String {
      FakeMachine.chunk(streamId, #"{"version":1,"type":"settingsUpdated","payload":{"settings":{"providerInstances":{},"machineNicknames":{"\#(env)":{"name":"\#(name)","updatedAt":"\#(time)"}}}}}"#)
    }
    socket.push(renamed("Desk", at: "2026-10-20T22:00:00.000Z"))
    #expect(await until { h.model.machines.first?.displayName == "Desk" })
    #expect(await until { h.model.recentThreads.first?.placement.owner == "Desk" })
    // An empty name resets the machine to its own name.
    socket.push(renamed("", at: "2026-10-20T22:05:00.000Z"))
    #expect(await until { h.model.machines.first?.displayName == "M4" })
    #expect(h.connector.connections.values.count == 1)
  }

  @Test func missingCoordinatorIsSubscribedAgainOnceTheShellListsIt() async throws {
    let h = try await harness()
    #expect(await loaded(h))
    let coordinator = "project-coordinator:proj_1"
    h.machine.fail("orchestration.subscribeThread", with: #"{"_tag":"OrchestrationV2GetThreadProjectionError","threadId":"\#(coordinator)","message":"Failed to load orchestration V2 thread \#(coordinator)"}"#)
    let session = h.model.session(for: .project(ProjectRef(environmentId: env, projectId: "proj_1")))
    h.engine.open(session)
    #expect(await until { session.isLoaded })
    #expect(h.machine.payloads("orchestration.subscribeThread").map { $0["threadId"] } == [.string(coordinator)])
    // A coordinator that does not exist yet is an empty chat, not a failed load.
    #expect(session.loadError == nil)

    // Shell updates that do not list the thread leave it alone.
    let shellId = try #require(h.machine.requests("orchestration.subscribeShell").last?["id"]?.intValue)
    let socket = try #require(h.connector.connections.values.last)
    socket.push(FakeMachine.chunk(shellId, #"{"kind":"project.updated","sequence":43,"project":\#(FixtureJSON.project)}"#))
    try await Task.sleep(for: .milliseconds(100))
    #expect(h.machine.payloads("orchestration.subscribeThread").count == 1)

    // A message from another device creates it.
    let thread = FixtureJSON.threadShell
      .replacingOccurrences(of: #""id": "thr_1""#, with: #""id": "\#(coordinator)""#)
      .replacingOccurrences(of: #""title": "Fix login""#, with: #""title": "SpecWeave coordinator""#)
    socket.push(FakeMachine.chunk(shellId, #"{"kind":"thread.updated","sequence":44,"thread":\#(thread)}"#))
    #expect(await until { h.machine.payloads("orchestration.subscribeThread").count == 2 })
    #expect(h.machine.payloads("orchestration.subscribeThread").last?["threadId"] == .string(coordinator))
    #expect(await until { session.rows.count == 1 })
  }

  @Test func threadActionsDispatchCommands() async throws {
    let h = try await harness()
    #expect(await loaded(h))
    let thread = ThreadRef(environmentId: env, threadId: "thr_1")
    try await h.engine.perform(.rename("  Better name "), on: thread)
    try await h.engine.perform(.resolve, on: thread)
    try await h.engine.perform(.pin, on: thread)
    let commands = h.machine.payloads("orchestration.dispatchCommand")
    #expect(commands.compactMap { $0["type"]?.stringValue } == ["thread.metadata.update", "thread.settle", "thread.pin"])
    #expect(commands.first?["title"] == .string("Better name"))
    await #expect(throws: SyncError.emptyTitle) { try await h.engine.perform(.rename(" "), on: thread) }
  }

  @Test func readOnlyPairingBlocksTheComposer() async throws {
    let h = try await harness(permissions: ["orchestration:read"])
    #expect(await loaded(h))
    let target = ChatTarget.thread(ThreadRef(environmentId: env, threadId: "thr_1"))
    let session = h.model.session(for: target)
    h.engine.open(session)
    #expect(await until { session.isLoaded })
    #expect(session.sendBlockedReason == LiveEngine.readOnlyReason)
    await #expect(throws: SyncError.sendBlocked(LiveEngine.readOnlyReason)) { try await h.engine.send("hi", to: target) }
    #expect(h.machine.payloads("orchestration.dispatchCommand").isEmpty)
  }

  @Test func projectSettingsRoundTripAndConflict() async throws {
    let h = try await harness()
    #expect(await loaded(h))
    let ref = ProjectRef(environmentId: env, projectId: "proj_1")
    var draft = try await h.engine.loadProjectSettings(ref)
    #expect(draft == ProjectSettingsDraft(title: "SpecWeave", goal: "Ship it", instructions: "Be brief", paused: false, archived: false, coordinatorModel: nil, revision: 3))

    draft.goal = "Ship it today"
    try await h.engine.saveProjectSettings(draft, for: ref)
    let mutate = try #require(h.machine.payloads("projects.mutate").first)
    #expect(mutate["type"] == .string("project.update"))
    #expect(mutate["title"] == nil)
    #expect(mutate["workspaceSettings"]?["expectedRevision"] == .number(3))
    #expect(mutate["workspaceSettings"]?["goal"] == .string("Ship it today"))

    h.machine.fail("projects.mutate", with: #"{"_tag":"ProjectMutationError","commandId":"c","message":"Project settings changed elsewhere. Reload before saving."}"#)
    do {
      try await h.engine.saveProjectSettings(draft, for: ref)
      Issue.record("Expected a conflict")
    } catch let error as SyncError {
      guard case let .projectConflict(latest) = error else { throw error }
      #expect(latest?.revision == 3)
      #expect(error.localizedDescription.hasPrefix("Someone else changed this project."))
    }
  }

  @Test func machineSettingsAndAide() async throws {
    let h = try await harness()
    #expect(await loaded(h))
    let settings = try await h.engine.loadMachineSettings(env)
    #expect(settings.defaultRuntimeMode == .fullAccess)
    try await h.engine.saveMachineSettings(MachineSettings(defaultRuntimeMode: .approvalRequired, defaultModel: nil), for: env)
    #expect(h.machine.payloads("server.updateSettings").first?["patch"]?["defaultRuntimeMode"] == .string("approval-required"))

    let aide = try await h.engine.setupAide()
    #expect(aide == ProjectRef(environmentId: env, projectId: "aide_1"))
    let create = try #require(h.machine.payloads("projects.createNew").first)
    #expect(create["name"] == .string("Aide"))
    #expect(create["kind"] == .string("personal"))
  }

  @Test func serverErrorsAreReadable() async throws {
    let h = try await harness()
    #expect(await loaded(h))
    h.machine.fail("orchestration.dispatchCommand", with: #"{"_tag":"OrchestrationV2DispatchCommandError","commandId":"c1","commandType":"message.dispatch","message":"Thread is archived."}"#)
    let target = ChatTarget.thread(ThreadRef(environmentId: env, threadId: "thr_1"))
    do {
      try await h.engine.send("hi", to: target)
      Issue.record("Expected an error")
    } catch {
      #expect(error.localizedDescription == "Thread is archived.")
    }
  }

  static let shellError = #"{"_tag":"OrchestrationV2GetShellSnapshotError","message":"Failed while streaming the application shell"}"#
  static let threadError = #"{"_tag":"OrchestrationV2GetThreadProjectionError","threadId":"thr_1","message":"Failed while streaming thr_1"}"#

  @Test func shellFailureSubscribesAgainOnTheSameSocket() async throws {
    let h = try await harness(failing: ["orchestration.subscribeShell": Self.shellError])
    #expect(await loaded(h))
    #expect(h.machine.requests("orchestration.subscribeShell").count == 2)
    #expect(h.connector.connections.values.count == 1)
    #expect(h.model.machines.first?.status == .connected)

    // A failure mid-stream on a live socket resumes from the last snapshot.
    let shellId = try #require(h.machine.requests("orchestration.subscribeShell").last?["id"]?.intValue)
    let socket = try #require(h.connector.connections.values.last)
    socket.push(FakeMachine.failure(shellId, Self.shellError))
    #expect(await until { h.machine.requests("orchestration.subscribeShell").count == 3 })
    #expect(h.machine.payloads("orchestration.subscribeShell").last?["afterSequence"] == .number(42))
    #expect(h.connector.connections.values.count == 1)
    #expect(await until { h.model.machines.first?.isStale == false })
  }

  @Test func shellAuthorizationFailureIsNotRetried() async throws {
    let denied = #"{"_tag":"EnvironmentAuthorizationError","requiredScope":"orchestration:read","message":"Missing orchestration:read"}"#
    let h = try await harness(failing: ["orchestration.subscribeShell": denied])
    #expect(await until { h.machine.requests("orchestration.subscribeShell").count == 1 })
    try await Task.sleep(for: .milliseconds(100))
    #expect(h.machine.requests("orchestration.subscribeShell").count == 1)
    #expect(await until { !h.model.isLoading })
  }

  @Test func threadFailureSubscribesAgainOnTheSameSocket() async throws {
    let h = try await harness()
    #expect(await loaded(h))
    h.machine.fail("orchestration.subscribeThread", with: Self.threadError)
    let target = ChatTarget.thread(ThreadRef(environmentId: env, threadId: "thr_1"))
    let session = h.model.session(for: target)
    h.engine.open(session)
    #expect(await until { session.rows.count == 1 && !session.isStale })
    #expect(h.machine.payloads("orchestration.subscribeThread").count == 2)
    #expect(h.connector.connections.values.count == 1)

    // A failure mid-stream resumes from the last sequence on the same socket.
    let threadId = try #require(h.machine.requests("orchestration.subscribeThread").last?["id"]?.intValue)
    let socket = try #require(h.connector.connections.values.last)
    socket.push(FakeMachine.failure(threadId, Self.threadError))
    #expect(await until { h.machine.payloads("orchestration.subscribeThread").count == 3 })
    #expect(h.machine.payloads("orchestration.subscribeThread").last?["afterSequence"] == .number(99))
    #expect(await until { !session.isStale })
    h.engine.close(session)
  }

  @Test func threadStreamThatEndsSubscribesAgainOnTheSameSocket() async throws {
    let h = try await harness()
    #expect(await loaded(h))
    let session = h.model.session(for: .thread(ThreadRef(environmentId: env, threadId: "thr_1")))
    h.engine.open(session)
    #expect(await until { session.rows.count == 1 && !session.isStale })

    // The server ends the stream while the socket stays open: the chat must not freeze.
    let threadId = try #require(h.machine.requests("orchestration.subscribeThread").last?["id"]?.intValue)
    let socket = try #require(h.connector.connections.values.last)
    socket.push(FakeMachine.exit(threadId, "null"))
    #expect(await until { h.machine.payloads("orchestration.subscribeThread").count == 2 })
    #expect(h.machine.payloads("orchestration.subscribeThread").last?["afterSequence"] == .number(99))
    #expect(h.connector.connections.values.count == 1)
    #expect(await until { !session.isStale })
    h.engine.close(session)
  }

  @Test func reopeningAChatCatchesItUp() async throws {
    let h = try await harness(resyncInterval: .zero)
    #expect(await loaded(h))
    let session = h.model.session(for: .thread(ThreadRef(environmentId: env, threadId: "thr_1")))
    h.engine.open(session)
    #expect(await until { session.rows.count == 1 })
    h.engine.open(session)
    #expect(await until { h.machine.payloads("orchestration.subscribeThread").count == 2 })
    #expect(h.machine.payloads("orchestration.subscribeThread").last?["afterSequence"] == .number(99))
    #expect(await until { !session.isStale && session.rows.count == 1 })
    h.engine.close(session)
  }

  @Test func foregroundCatchesUpLiveStreams() async throws {
    let h = try await harness(resyncInterval: .zero)
    #expect(await loaded(h))
    let session = h.model.session(for: .thread(ThreadRef(environmentId: env, threadId: "thr_1")))
    h.engine.open(session)
    #expect(await until { session.rows.count == 1 })
    let shells = h.machine.payloads("orchestration.subscribeShell").count
    // Back in front without the socket closing (Control Center, a banner).
    h.engine.setActive(true)
    #expect(await until { h.machine.payloads("orchestration.subscribeThread").count == 2 })
    #expect(await until { h.machine.payloads("orchestration.subscribeShell").count == shells + 1 })
    #expect(h.connector.connections.values.count == 1)
    h.engine.close(session)
  }

  @Test func chatTrailingTheThreadListSubscribesAgainOnce() async throws {
    let h = try await harness(staleThreadGrace: .milliseconds(20))
    #expect(await loaded(h))
    let session = h.model.session(for: .thread(ThreadRef(environmentId: env, threadId: "thr_1")))
    h.engine.open(session)
    #expect(await until { session.rows.count == 1 && !session.isStale })
    try await Task.sleep(for: .milliseconds(60))
    #expect(h.machine.payloads("orchestration.subscribeThread").count == 1)

    // The list moves on but the thread stream delivers nothing, as when it stalls.
    let shellId = try #require(h.machine.requests("orchestration.subscribeShell").last?["id"]?.intValue)
    let socket = try #require(h.connector.connections.values.last)
    let newer = FixtureJSON.threadShell.replacingOccurrences(of: #""updatedAt": "2026-10-18T04:00:01.500Z""#, with: #""updatedAt": "2026-10-19T09:00:00.000Z""#)
    socket.push(FakeMachine.chunk(shellId, #"{"kind":"thread.updated","sequence":44,"thread":\#(newer)}"#))
    #expect(await until { h.machine.payloads("orchestration.subscribeThread").count == 2 })
    #expect(h.machine.payloads("orchestration.subscribeThread").last?["afterSequence"] == .number(99))
    // Still behind after catching up (nothing newer arrived): no loop.
    try await Task.sleep(for: .milliseconds(150))
    #expect(h.machine.payloads("orchestration.subscribeThread").count == 2)
    h.engine.close(session)
  }

  @Test func projectChatFollowsANewCoordinatorThread() async throws {
    let h = try await harness()
    #expect(await loaded(h))
    let session = h.model.session(for: .project(ProjectRef(environmentId: env, projectId: "proj_1")))
    h.engine.open(session)
    #expect(await until { h.machine.payloads("orchestration.subscribeThread").count == 1 })
    #expect(h.machine.payloads("orchestration.subscribeThread").last?["threadId"] == .string("project-coordinator:proj_1"))

    let shellId = try #require(h.machine.requests("orchestration.subscribeShell").last?["id"]?.intValue)
    let socket = try #require(h.connector.connections.values.last)
    let moved = FixtureJSON.project.replacingOccurrences(of: #""coordinatorThreadId": "project-coordinator:proj_1""#, with: #""coordinatorThreadId": "thr_coord_2""#)
    socket.push(FakeMachine.chunk(shellId, #"{"kind":"project.updated","sequence":43,"project":\#(moved)}"#))
    #expect(await until { h.machine.payloads("orchestration.subscribeThread").last?["threadId"] == .string("thr_coord_2") })
    h.engine.close(session)
  }

  @Test func projectChatKeepsTheThreadASendStartedBeforeTheProjectNamesIt() async throws {
    let h = try await harness()
    #expect(await loaded(h))
    let target = ChatTarget.project(ProjectRef(environmentId: env, projectId: "proj_1"))
    let session = h.model.session(for: target)
    h.engine.open(session)
    #expect(await until { h.machine.payloads("orchestration.subscribeThread").count == 1 })
    // The machine answers the send with a new coordinator thread while the project still names the old one.
    try await h.engine.send("hello", to: target)
    #expect(await until { h.machine.payloads("orchestration.subscribeThread").last?["threadId"] == .string("thr_coord") })
    let shellId = try #require(h.machine.requests("orchestration.subscribeShell").last?["id"]?.intValue)
    let socket = try #require(h.connector.connections.values.last)
    socket.push(FakeMachine.chunk(shellId, #"{"kind":"project.updated","sequence":43,"project":\#(FixtureJSON.project)}"#))
    try await Task.sleep(for: .milliseconds(100))
    #expect(h.machine.payloads("orchestration.subscribeThread").last?["threadId"] == .string("thr_coord"))
    h.engine.close(session)
  }

  @Test func threadTheShellNoLongerListsIsNotRetried() async throws {
    let h = try await harness()
    #expect(await loaded(h))
    h.machine.fail("orchestration.subscribeThread", with: Self.threadError)
    let session = h.model.session(for: .thread(ThreadRef(environmentId: env, threadId: "thr_gone")))
    h.engine.open(session)
    #expect(await until { session.isLoaded })
    try await Task.sleep(for: .milliseconds(100))
    #expect(h.machine.payloads("orchestration.subscribeThread").count == 1)
  }

  @Test func threadThatNeverLoadsSaysSoAndLoadsAgain() async throws {
    let h = try await harness()
    #expect(await loaded(h))
    h.machine.fail("orchestration.subscribeThread", with: Self.threadError)
    let session = h.model.session(for: .thread(ThreadRef(environmentId: env, threadId: "thr_gone")))
    h.engine.open(session)
    #expect(await until { session.loadError != nil })
    #expect(session.isLoaded)
    #expect(session.rows.isEmpty)
    #expect(session.loadError == "Failed while streaming thr_1")

    // The failure was one-off: trying again loads the conversation.
    h.engine.reload(session)
    #expect(await until { h.machine.payloads("orchestration.subscribeThread").count == 2 })
    #expect(await until { session.loadError == nil && session.rows.count == 1 })
    h.engine.close(session)
  }

  @Test func setUpAideWaitsForEveryMachinesProjects() async throws {
    let h = try await harness()
    #expect(await loaded(h))
    #expect(h.model.allShellsLoaded)
    // A second machine that never connects may already hold Aide.
    let other = MachineRecord(environmentId: "env_other", label: "Travel laptop", routes: [try #require(MachineRoute(httpBase: "http://192.168.1.99:8319"))])
    h.engine.addMachine(other, credential: nil)
    h.engine.publishNow()
    #expect(!h.model.allShellsLoaded)
    await #expect(throws: SyncError.machinesNotLoaded) { try await h.engine.setupAide() }
    #expect(h.machine.payloads("projects.createNew").isEmpty)

    h.engine.removeMachine(id: "env_other")
    #expect(h.model.allShellsLoaded)
    let aide = try await h.engine.setupAide()
    #expect(aide.environmentId == env)
  }

  @Test func deletedThreadBlocksTheComposer() async throws {
    let h = try await harness()
    #expect(await loaded(h))
    let target = ChatTarget.thread(ThreadRef(environmentId: env, threadId: "thr_1"))
    let session = h.model.session(for: target)
    h.engine.open(session)
    #expect(await until { session.rows.count == 1 })
    #expect(session.sendBlockedReason == nil)

    let events = try JSONDecoder().decode([JSONValue].self, from: Data(FixtureJSON.threadEvents.utf8))
    let deleted = String(decoding: try JSONEncoder().encode(events[0]), as: UTF8.self)
      .replacingOccurrences(of: "thread.pinned", with: "thread.deleted")
      .replacingOccurrences(of: #""deletedAt":null"#, with: #""deletedAt":"2026-10-18T06:16:00.000Z""#)
    #expect(deleted.contains("2026-10-18T06:16:00.000Z"))
    let threadId = try #require(h.machine.requests("orchestration.subscribeThread").last?["id"]?.intValue)
    let socket = try #require(h.connector.connections.values.last)
    socket.push(FakeMachine.chunk(threadId, deleted))
    #expect(await until { session.sendBlockedReason == LiveEngine.deletedReason })
    await #expect(throws: SyncError.sendBlocked(LiveEngine.deletedReason)) { try await h.engine.send("hi", to: target) }
    #expect(h.machine.payloads("orchestration.dispatchCommand").isEmpty)
  }

  @Test func visitSendsTheServerClockNotThePhones() async throws {
    let h = try await harness()
    #expect(await loaded(h))
    let shellId = try #require(h.machine.requests("orchestration.subscribeShell").last?["id"]?.intValue)
    let socket = try #require(h.connector.connections.values.last)
    let unread = FixtureJSON.threadShell.replacingOccurrences(
      of: #""updatedAt": "2026-10-18T04:00:01.500Z""#,
      with: #""updatedAt": "2026-10-18T04:00:01.500Z", "latestRunCompletedAt": "2026-10-18T04:00:01.000Z", "lastVisitedAt": "2026-10-18T03:00:00.000Z""#
    )
    #expect(unread != FixtureJSON.threadShell)
    socket.push(FakeMachine.chunk(shellId, #"{"kind":"thread.updated","sequence":43,"thread":\#(unread)}"#))
    #expect(await until { h.model.recentThreads.first?.isUnread == true })

    let session = h.model.session(for: .thread(ThreadRef(environmentId: env, threadId: "thr_1")))
    h.engine.open(session)
    #expect(await until { h.machine.payloads("orchestration.dispatchCommand").contains { $0["type"] == .string("thread.visit") } })
    let visit = try #require(h.machine.payloads("orchestration.dispatchCommand").first { $0["type"] == .string("thread.visit") })
    #expect(visit["visitedAt"] == .string("2026-10-18T04:00:01.500Z"))
    h.engine.close(session)
  }

  @Test func reopeningAChatResumesInsteadOfRefetching() async throws {
    let h = try await harness()
    #expect(await loaded(h))
    let target = ChatTarget.thread(ThreadRef(environmentId: env, threadId: "thr_1"))
    let session = h.model.session(for: target)
    h.engine.open(session)
    #expect(await until { session.rows.count == 1 })
    #expect(h.machine.payloads("orchestration.subscribeThread").first?["afterSequence"] == nil)

    h.engine.close(session)
    h.engine.open(session)
    #expect(await until { h.machine.payloads("orchestration.subscribeThread").count == 2 })
    #expect(h.machine.payloads("orchestration.subscribeThread").last?["afterSequence"] == .number(99))
    #expect(await until { !session.isStale && session.rows.count == 1 })

    // A removed machine's state is not kept.
    h.engine.close(session)
    #expect(h.engine.retainedThreads[target] != nil)
    h.engine.removeMachine(id: env)
    #expect(h.engine.retainedThreads.isEmpty)
  }

  @Test func removingAMachineForgetsIt() async throws {
    let h = try await harness()
    #expect(await loaded(h))
    h.engine.removeMachine(id: env)
    #expect(h.model.machines.isEmpty)
    #expect(h.model.projects.isEmpty)
    #expect(await until { h.model.recentThreads.isEmpty })
    try await Task.sleep(for: .milliseconds(50))
    #expect(await h.registry.machine(env) == nil)
    await #expect(throws: SyncError.unknownMachine) { try await h.engine.loadMachineSettings(env) }
  }
}
