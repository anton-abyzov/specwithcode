import Foundation
import Testing
import SWCWire
@testable import SWCSync

/// The project's reply style in a chat's menu: what it shows and when the
/// phone may change it.
@Suite struct ReplyStyleTests {
  @Test func aProjectsOwnStyleWinsOverTheMachines() {
    let settings = ServerSettings(responseStyle: .concise, projectSettingsOverrides: ["p1": ProjectSettingsOverrides(responseStyle: .detailed), "p2": ProjectSettingsOverrides()])
    let styles = MachineReplyStyles.read(settings, canOperate: true, perKeyProjectChanges: true)
    #expect(styles.state(forProject: "p1") == ReplyStyleState(style: .detailed, isProjectOverride: true, canChange: true))
    #expect(styles.state(forProject: "p2") == ReplyStyleState(style: .concise, isProjectOverride: false, canChange: true))
    #expect(styles.state(forProject: "other") == ReplyStyleState(style: .concise, isProjectOverride: false, canChange: true))
  }

  @Test func anUnknownValueShowsNothing() {
    let styles = MachineReplyStyles.read(ServerSettings(), canOperate: true, perKeyProjectChanges: true)
    #expect(styles.state(forProject: "p1") == nil)
  }

  @Test func theValueIsReadOnlyWithoutTheCapabilityOrPermission() {
    let settings = ServerSettings(responseStyle: .detailed)
    let old = MachineReplyStyles.read(settings, canOperate: true, perKeyProjectChanges: false).state(forProject: "p1")
    #expect(old?.style == .detailed)
    #expect(old?.canChange == false)
    #expect(old?.readOnlyReason == MachineReplyStyles.updateNeededReason)
    let readOnly = MachineReplyStyles.read(settings, canOperate: false, perKeyProjectChanges: true).state(forProject: "p1")
    #expect(readOnly?.canChange == false)
    #expect(readOnly?.readOnlyReason == MachineReplyStyles.notOperableReason)
  }

  @Test func thePatchSetsOnlyThisProjectsStyle() throws {
    let patch = MachineReplyStyles.patch(.detailed, forProject: "p1")
    let json = try JSONValue.from(UpdateServerSettingsInput(patch: patch))
    #expect(json == .object(["patch": .object(["projectSettingsOverrideChanges": .object(["p1": .object(["set": .object(["responseStyle": .string("detailed")])])])])]))
  }

  @MainActor @Test func aChatFollowsTheProjectItBelongsTo() {
    let model = AppModel(engine: FixtureEngine(scenario: .empty), defaults: UserDefaults(suiteName: "ReplyStyleTests")!)
    let project = ProjectRef(environmentId: "m4", projectId: "p1")
    let thread = ThreadRef(environmentId: "m4", threadId: "t1")
    model.threadsByProject[project] = [ThreadSummary(ref: thread, projectRef: project, title: "T", activity: .idle, updatedAt: Date(), machineLabel: "M4", machineOnline: true)]
    #expect(model.replyStyle(for: .project(project)) == nil)
    model.replyStyles["m4"] = MachineReplyStyles(machine: .concise, projects: ["p1": .detailed], canChange: true)
    #expect(model.replyStyle(for: .project(project))?.style == .detailed)
    #expect(model.replyStyle(for: .thread(thread))?.style == .detailed)
    #expect(model.replyStyleProject(for: .thread(ThreadRef(environmentId: "m4", threadId: "loose"))) == nil)
    #expect(model.replyStyle(for: .aide(ProjectRef(environmentId: "m4", projectId: "percy")))?.style == .concise)
  }

  // MARK: Live engine

  static let capableConfig = FakeMachine.config
    .replacingOccurrences(of: #""capabilities":{}"#, with: #""capabilities":{"projectSettingsOverrideChanges":true}"#)
    .replacingOccurrences(of: #""providerInstances":{}}"#, with: #""providerInstances":{},"responseStyle":"concise","projectSettingsOverrides":{"proj_1":{"defaultAutoPull":true}}}"#)

  @MainActor @Test func theLiveEngineSendsAPerKeyChangeAndShowsTheSavedValue() async throws {
    let live = LiveEngineTests()
    let h = try await live.harness(config: Self.capableConfig)
    defer { h.engine.setActive(false) }
    #expect(await live.loaded(h))
    let project = ProjectRef(environmentId: live.env, projectId: "proj_1")
    #expect(await until { h.model.replyStyle(for: .project(project)) != nil })
    #expect(h.model.replyStyle(for: .project(project)) == ReplyStyleState(style: .concise, isProjectOverride: false, canChange: true))

    h.machine.answer("server.updateSettings", with: #"{"providerInstances":{},"responseStyle":"concise","projectSettingsOverrides":{"proj_1":{"defaultAutoPull":true,"responseStyle":"detailed"}}}"#)
    try await h.engine.setReplyStyle(.detailed, for: project)
    let patch = try #require(h.machine.payloads("server.updateSettings").first?["patch"])
    #expect(patch == .object(["projectSettingsOverrideChanges": .object(["proj_1": .object(["set": .object(["responseStyle": .string("detailed")])])])]))
    #expect(h.model.replyStyle(for: .project(project)) == ReplyStyleState(style: .detailed, isProjectOverride: true, canChange: true))
  }

  @MainActor @Test func theLiveEngineRefusesAServerWithoutPerKeyChanges() async throws {
    let live = LiveEngineTests()
    let config = FakeMachine.config.replacingOccurrences(of: #""providerInstances":{}}"#, with: #""providerInstances":{},"responseStyle":"detailed"}"#)
    let h = try await live.harness(config: config)
    defer { h.engine.setActive(false) }
    #expect(await live.loaded(h))
    let project = ProjectRef(environmentId: live.env, projectId: "proj_1")
    #expect(await until { h.model.replyStyle(for: .project(project)) != nil })
    let state = try #require(h.model.replyStyle(for: .project(project)))
    #expect(state.style == .detailed)
    #expect(!state.canChange)
    await #expect(throws: SyncError.sendBlocked(MachineReplyStyles.updateNeededReason)) {
      try await h.engine.setReplyStyle(.concise, for: project)
    }
    #expect(h.machine.payloads("server.updateSettings").isEmpty)
  }

  @MainActor @Test func theLiveEngineRefusesAPhoneWithoutPermissionToOperate() async throws {
    let live = LiveEngineTests()
    let h = try await live.harness(permissions: ["orchestration:read"], config: Self.capableConfig)
    defer { h.engine.setActive(false) }
    #expect(await live.loaded(h))
    let project = ProjectRef(environmentId: live.env, projectId: "proj_1")
    #expect(await until { h.model.replyStyle(for: .project(project)) != nil })
    #expect(h.model.replyStyle(for: .project(project))?.canChange == false)
    await #expect(throws: SyncError.self) { try await h.engine.setReplyStyle(.detailed, for: project) }
    #expect(h.machine.payloads("server.updateSettings").isEmpty)
  }
}
