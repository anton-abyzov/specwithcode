import Foundation
import Testing
import SWCSync

@MainActor
@Suite("Fixture engine")
struct FixtureEngineTests {
  private func make(_ scenario: FixtureScenario = .default) -> (AppModel, FixtureEngine) {
    let engine = FixtureEngine(scenario: scenario)
    engine.latency = .zero
    engine.streamDelay = .zero
    return (AppModel(engine: engine), engine)
  }

  /// Lets queued main-actor work (fake streaming) run until `done` holds.
  private func settle(_ done: () -> Bool) async {
    for _ in 0..<2_000 where !done() { await Task.yield() }
  }

  private var studio: String { "env-studio-mac" }
  private var release: ThreadRef { ThreadRef(environmentId: studio, threadId: "t-release") }

  @Test func defaultScenarioHasSampleData() throws {
    let (model, _) = make()
    #expect(!model.isLoading)
    #expect(model.machines.map(\.label) == ["Office Mac", "Build box", "Travel laptop"])
    #expect(model.machines.map(\.status) == [.connected, .connected, .offline])
    let aide = try #require(model.aide)
    #expect(aide.kind == .personal)
    #expect(aide.ref.environmentId == studio)
    #expect(model.projects.map(\.title) == ["SpecWeave", "Verified Skill", "Docs site", "Recipe app"])
    #expect(model.pinnedProjects.count == 2)
    let specweave = try #require(model.projects.first)
    #expect(specweave.workingCount == 2)
    #expect(specweave.hasUnread)
    #expect(model.projects.first { $0.title == "Docs site" }?.machineOnline == false)
    #expect(model.threadsByProject.values.map(\.count).reduce(0, +) == 14)
    #expect(model.recentThreads.count == 10)
    #expect(model.recentThreads.first?.isPinned == true)
    let statuses = Set(model.threadsByProject.values.flatMap { $0 }.map(\.activity))
    #expect(statuses == [.needsYou, .working, .failed, .idle])
  }

  @Test func emptyScenarioHasNoMachines() {
    let (model, _) = make(.empty)
    #expect(!model.isLoading)
    #expect(model.machines.isEmpty)
    #expect(model.aide == nil)
    #expect(model.projects.isEmpty)
  }

  @Test func longScenarioGivesAideALongHistoryWithLinks() throws {
    let (model, engine) = make(.long)
    let aide = try #require(model.aide)
    let session = model.session(for: .aide(aide.ref))
    engine.open(session)
    #expect(session.rows.count == 122)
    if case let .user(text, _) = session.rows.first?.kind { #expect(text == "Start of history") } else { Issue.record("The oldest row should be the user's first message") }
    let links = session.rows.filter { if case let .assistant(text, _) = $0.kind { text.contains("](https://") } else { false } }
    #expect(links.count == 6)
    #expect(model.projects.count == 4, "The rest of the sample data stays as in default")
  }

  @Test func openFillsTheRichThread() throws {
    let (model, engine) = make()
    let session = model.session(for: .thread(release))
    engine.open(session)
    #expect(session.isLoaded)
    #expect(!session.isStale)
    #expect(session.machineOnline)
    #expect(session.title == "Release 3.1 checklist")
    #expect(session.subtitle == "SpecWeave")
    #expect(session.plan == PlanProgress(completed: 3, total: 5))
    #expect(session.rows.contains { if case .approval(_, _, false) = $0.kind { true } else { false } })
    #expect(session.rows.contains { if case let .assistant(text, false) = $0.kind { text.count > 1_200 && text.contains("```bash") } else { false } })
    #expect(session.rows.contains { if case .tool = $0.kind { true } else { false } })
    #expect(session.rows.contains { if case .subagent(_, .some) = $0.kind { true } else { false } })
    #expect(model.thread(release)?.isUnread == false)
  }

  @Test func offlineThreadIsStaleAndBlocked() {
    let (model, engine) = make()
    let session = model.session(for: .thread(ThreadRef(environmentId: "env-travel-laptop", threadId: "t-links")))
    engine.open(session)
    #expect(session.isStale)
    #expect(!session.machineOnline)
    #expect(session.sendBlockedReason?.contains("Travel laptop") == true)
  }

  @Test func sendEchoesAndStreamsAReply() async throws {
    let (model, engine) = make()
    let aide = try #require(model.aide)
    let session = model.session(for: .aide(aide.ref))
    engine.open(session)
    let before = session.rows.count
    try await engine.send("Plan my day", to: .aide(aide.ref))
    #expect(session.rows.count == before + 2)
    #expect(session.rows[before].kind == .user(text: "Plan my day"))
    #expect(session.isRunning)
    await settle { !session.isRunning }
    #expect(!session.isRunning)
    guard case let .assistant(reply, streaming) = session.rows.last?.kind else {
      Issue.record("Expected an assistant reply")
      return
    }
    #expect(!streaming)
    #expect(!reply.isEmpty)
  }

  @Test func sendWhileRunningQueues() async throws {
    let (model, engine) = make()
    engine.streamDelay = .milliseconds(5)
    let thread = ThreadRef(environmentId: studio, threadId: "t-verify-gate")
    let session = model.session(for: .thread(thread))
    engine.open(session)
    try await engine.send("First", to: .thread(thread))
    try await engine.send("Second", to: .thread(thread))
    #expect(session.queuedCount == 1)
    #expect(model.thread(thread)?.activity == .working)
    try await engine.stop(.thread(thread))
    #expect(!session.isRunning)
    #expect(session.queuedCount == 1)
    #expect(session.rows.last?.kind == .notice(text: "Stopped. 1 queued message is on hold."))
    #expect(model.thread(thread)?.activity == .idle)
  }

  @Test func queuedMessagesShowTheirStateUntilTheyRun() async throws {
    let (model, engine) = make()
    let thread = ThreadRef(environmentId: studio, threadId: "t-verify-gate")
    let session = model.session(for: .thread(thread))
    engine.open(session)
    try await engine.send("First", to: .thread(thread))
    try await engine.send("Second", to: .thread(thread))
    #expect(session.rows.contains { $0.kind == .user(text: "First", state: .sent) })
    #expect(session.rows.contains { $0.kind == .user(text: "Second", state: .queued) })
    await settle { !session.isRunning }
    #expect(session.rows.contains { $0.kind == .user(text: "Second", state: .sent) })
  }

  @Test func stopHoldsQueuedMessages() async throws {
    let (model, engine) = make()
    engine.streamDelay = .milliseconds(5)
    let thread = ThreadRef(environmentId: studio, threadId: "t-verify-gate")
    let session = model.session(for: .thread(thread))
    engine.open(session)
    try await engine.send("First", to: .thread(thread))
    try await engine.send("Second", to: .thread(thread))
    try await engine.stop(.thread(thread))
    #expect(session.rows.contains { $0.kind == .user(text: "Second", state: .held) })
  }

  @Test func pairAgainRefusesAnotherMachinesLink() async throws {
    let (model, engine) = make()
    await #expect(throws: (any Error).self) {
      try await engine.pair(link: "http://192.168.1.77:3773#token=x", expectedEnvironmentId: "env-travel-laptop")
    }
    #expect(model.machine("env-travel-laptop")?.status == .offline)
    let again = try await engine.pair(link: "http://192.168.1.24:3773#token=y", expectedEnvironmentId: "env-travel-laptop")
    #expect(again.id == "env-travel-laptop")
    #expect(again.status == .connected)
  }

  @Test func sendToOfflineMachineFails() async {
    let (model, engine) = make()
    let target = ChatTarget.project(ProjectRef(environmentId: "env-travel-laptop", projectId: "docs-site"))
    engine.open(model.session(for: target))
    await #expect(throws: (any Error).self) { try await engine.send("Hello", to: target) }
  }

  @Test func stopEndsAWorkingThread() async throws {
    let (model, engine) = make()
    let thread = ThreadRef(environmentId: studio, threadId: "t-handoff")
    let session = model.session(for: .thread(thread))
    engine.open(session)
    #expect(session.isRunning)
    #expect(session.plan == PlanProgress(completed: 2, total: 5))
    try await engine.stop(.thread(thread))
    #expect(!session.isRunning)
    #expect(!session.rows.contains { if case .tool(_, _, _, .running) = $0.kind { true } else { false } })
  }

  @Test func runningScenarioShowsARunWithAQueue() throws {
    let (model, engine) = make(.running)
    let aide = try #require(model.aide)
    let session = model.session(for: .aide(aide.ref))
    engine.open(session)
    #expect(session.isRunning)
    #expect(session.queuedCount == 1)
    guard case .tool(_, _, _, .running) = session.rows.last?.kind else {
      Issue.record("Expected a running tool row last")
      return
    }
  }

  @Test func approvalResolvesAndContinues() async throws {
    let (model, engine) = make()
    let session = model.session(for: .thread(release))
    engine.open(session)
    try await engine.respond(to: "req-publish", in: .thread(release), decision: .approve)
    #expect(session.rows.contains { $0.kind == .approval(requestId: "req-publish", prompt: "npm publish --tag next", resolved: true) })
    #expect(session.plan == PlanProgress(completed: 4, total: 5))
    #expect(model.thread(release)?.activity == .working)
    await settle { !session.isRunning }
    #expect(model.thread(release)?.activity == .idle)
    await #expect(throws: (any Error).self) {
      try await engine.respond(to: "req-missing", in: .thread(release), decision: .deny)
    }
  }

  @Test func threadActionsUpdateSummaries() async throws {
    let (model, engine) = make()
    let thread = ThreadRef(environmentId: studio, threadId: "t-dedupe")
    try await engine.perform(.pin, on: thread)
    #expect(model.thread(thread)?.isPinned == true)
    #expect(model.recentThreads.prefix(2).contains { $0.ref == thread })
    try await engine.perform(.rename("Deduplicate imports"), on: thread)
    #expect(model.thread(thread)?.title == "Deduplicate imports")
    try await engine.perform(.resolve, on: thread)
    #expect(model.thread(thread)?.isResolved == true)
    try await engine.perform(.unresolve, on: thread)
    #expect(model.thread(thread)?.isResolved == false)
    try await engine.perform(.markUnread, on: thread)
    #expect(model.thread(thread)?.isUnread == true)
    try await engine.perform(.delete, on: thread)
    #expect(model.thread(thread) == nil)
    await #expect(throws: (any Error).self) { try await engine.perform(.pin, on: thread) }
    let offline = ThreadRef(environmentId: "env-travel-laptop", threadId: "t-links")
    await #expect(throws: (any Error).self) { try await engine.perform(.resolve, on: offline) }
  }

  @Test func projectSettingsRoundTripWithRevisions() async throws {
    let (model, engine) = make()
    let project = ProjectRef(environmentId: studio, projectId: "verified-skill")
    var draft = try await engine.loadProjectSettings(project)
    #expect(draft.title == "Verified Skill")
    #expect(!draft.goal.isEmpty)
    let stale = draft
    draft.title = "Verified Skills"
    draft.paused = true
    try await engine.saveProjectSettings(draft, for: project)
    #expect(model.project(project)?.title == "Verified Skills")
    #expect(model.project(project)?.paused == true)
    let reloaded = try await engine.loadProjectSettings(project)
    #expect(reloaded.revision == draft.revision + 1)
    await #expect(throws: (any Error).self) { try await engine.saveProjectSettings(stale, for: project) }
    await #expect(throws: (any Error).self) {
      try await engine.loadProjectSettings(ProjectRef(environmentId: "env-travel-laptop", projectId: "docs-site"))
    }
  }

  @Test func archivingHidesTheProject() async throws {
    let (model, engine) = make()
    let project = ProjectRef(environmentId: "env-build-box", projectId: "recipe-app")
    var draft = try await engine.loadProjectSettings(project)
    draft.archived = true
    try await engine.saveProjectSettings(draft, for: project)
    #expect(!model.otherProjects.contains { $0.ref == project })
  }

  @Test func machineSettingsRoundTrip() async throws {
    let (model, engine) = make()
    defer { withExtendedLifetime(model) {} }
    var settings = try await engine.loadMachineSettings(studio)
    #expect(settings.defaultRuntimeMode == .autoAcceptEdits)
    settings.defaultRuntimeMode = .fullAccess
    try await engine.saveMachineSettings(settings, for: studio)
    #expect(try await engine.loadMachineSettings(studio).defaultRuntimeMode == .fullAccess)
    await #expect(throws: (any Error).self) { try await engine.loadMachineSettings("env-travel-laptop") }
  }

  @Test func pairingRejectsBadLinksAndAddsMachines() async throws {
    let (model, engine) = make(.empty)
    do {
      _ = try await engine.pair(link: "https://bad.example/pair#token=1")
      Issue.record("Expected pairing to fail")
    } catch {
      #expect(error.localizedDescription.contains("pairing link"))
    }
    await #expect(throws: (any Error).self) { try await engine.pair(link: "   ") }
    let machine = try await engine.pair(link: "https://m4-mini.local:3773/pair#token=ABC")
    #expect(machine.label == "M4 mini")
    #expect(machine.address == "https://m4-mini.local:3773")
    #expect(machine.status == .connected)
    #expect(model.machines.count == 1)
    let again = try await engine.pair(link: "https://m4-mini.local:3773/pair#token=DEF")
    #expect(again.id == machine.id)
    #expect(model.machines.count == 1)
  }

  @Test func setupAideOnFirstOnlineMachine() async throws {
    let (model, engine) = make(.empty)
    await #expect(throws: (any Error).self) { try await engine.setupAide() }
    _ = try await engine.pair(link: "http://192.168.1.9:3773#token=x")
    #expect(model.machines.first?.label == "Machine at 192.168.1.9")
    let ref = try await engine.setupAide()
    #expect(model.aide?.ref == ref)
    #expect(try await engine.setupAide() == ref)
    let session = model.session(for: .aide(ref))
    engine.open(session)
    #expect(session.rows.count == 1)
  }

  @Test func removeAndReconnectMachines() async throws {
    let (model, engine) = make()
    engine.removeMachine(id: "env-build-box")
    #expect(model.machines.count == 2)
    #expect(!model.projects.contains { $0.ref.environmentId == "env-build-box" })
    #expect(!model.recentThreads.contains { $0.ref.environmentId == "env-build-box" })
    engine.reconnect(machineId: studio)
    #expect(model.machine(studio)?.status == .reconnecting)
    await settle { model.machine(studio)?.status == .connected }
    #expect(model.machine(studio)?.status == .connected)
    engine.reconnect(machineId: "env-travel-laptop")
    await settle { model.machine("env-travel-laptop")?.status == .offline }
    #expect(model.machine("env-travel-laptop")?.status == .offline)
  }
}

@MainActor
@Suite("Fixture devices")
struct FixtureDevicesTests {
  @Test func devicesScenarioOpensDevicesInThreads() async throws {
    let engine = FixtureEngine(scenario: .devices)
    let model = AppModel(engine: engine)
    let release = ThreadRef(environmentId: "env-studio-mac", threadId: "t-release")
    #expect(model.deviceSessions(for: release).map(\.name) == ["iPhone 17 Pro", "Pixel 9"])
    #expect(model.devices["env-build-box"]?.support.message == MachineDevices.disabledMessage)
    let access = try await engine.deviceHubAccess(machineId: "env-studio-mac", hostId: "local")
    #expect(access.query["hostId"] == "local")
    await #expect(throws: SyncError.self) { try await engine.deviceHubAccess(machineId: "env-travel-laptop", hostId: "local") }
  }

  @Test func otherScenariosOpenNoDevices() {
    let model = AppModel(engine: FixtureEngine(scenario: .default))
    #expect(model.devices.isEmpty)
  }
}
