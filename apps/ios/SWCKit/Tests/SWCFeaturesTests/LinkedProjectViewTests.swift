import Foundation
import Testing
@testable import SWCFeatures
@testable import SWCSync
import SWCWire

@MainActor
@Suite struct LinkedProjectViewTests {
  @Test func takeoverHintSaysWhyTheButtonWaits() {
    #expect(LinkedProjectMachinesCard.takeoverHint(.waiting(minutes: 4)) == "Available in 4 min")
    #expect(LinkedProjectMachinesCard.takeoverHint(.unavailable("Connect M1 first.")) == "Connect M1 first.")
    #expect(LinkedProjectMachinesCard.takeoverHint(.ready) == nil)
    #expect(LinkedProjectMachinesCard.takeoverHint(.hidden) == nil)
  }

  @Test func thePromptIsRememberedPerProject() throws {
    let defaults = try #require(UserDefaults(suiteName: "linked-prompt-\(UUID().uuidString)"))
    #expect(LinkedMachinesPromptMemory.asked(defaults).isEmpty)
    LinkedMachinesPromptMemory.remember("lp1", defaults)
    LinkedMachinesPromptMemory.remember("lp1", defaults)
    LinkedMachinesPromptMemory.remember("lp2", defaults)
    #expect(LinkedMachinesPromptMemory.asked(defaults) == ["lp1", "lp2"])
    let ref = ProjectRef(environmentId: "m4", projectId: "p")
    #expect(LinkedMachinesPromptMemory.projectKey([], fallback: ref) == "m4:p")
    let copy = LinkedProjectResolver.Copy(ref: ref, machineLabel: "M4", machineOnline: true, logicalProjectId: "lp9")
    #expect(LinkedMachinesPromptMemory.projectKey([copy], fallback: ref) == "lp9")
  }

  @Test func takeoverIsSentOnlyWhileTheConfirmedSituationHolds() {
    func copy(_ env: String, state: CoordinatorBindingState, online: Bool, epoch: Int = 3, predecessor: String? = nil) -> LinkedProjectResolver.Copy {
      let pred = predecessor.map { LogicalProjectMember(environmentId: $0, projectId: "p-\($0)", coordinatorThreadId: "t") }
      return LinkedProjectResolver.Copy(ref: ProjectRef(environmentId: env, projectId: "p-\(env)"), machineLabel: env.uppercased(), machineOnline: online, binding: CoordinatorBinding(epoch: epoch, state: state, predecessor: pred))
    }
    let now = Date()
    let away = [copy("m4", state: .active, online: false), copy("m1", state: .transferred, online: true)]
    let ready = LinkedProjectResolver.rows(away, now: now, unreachableSince: now.addingTimeInterval(-11 * 60))
    #expect(LinkedProjectState.mayTakeOver(at: away[1].ref, from: away[0].ref, copies: away, rows: ready))
    // M4 came back while the dialog was open.
    let back = [copy("m4", state: .active, online: true), away[1]]
    #expect(!LinkedProjectState.mayTakeOver(at: away[1].ref, from: away[0].ref, copies: back, rows: LinkedProjectResolver.rows(back, now: now, unreachableSince: nil)))
    // The standby took over automatically meanwhile: M1 coordinates now.
    let auto = [away[0], copy("m1", state: .active, online: true, epoch: 4, predecessor: "m4")]
    #expect(!LinkedProjectState.mayTakeOver(at: away[1].ref, from: away[0].ref, copies: auto, rows: LinkedProjectResolver.rows(auto, now: now, unreachableSince: nil)))
    // Still inside the 10-minute wait.
    let early = LinkedProjectResolver.rows(away, now: now, unreachableSince: now.addingTimeInterval(-60))
    #expect(!LinkedProjectState.mayTakeOver(at: away[1].ref, from: away[0].ref, copies: away, rows: early))
  }

  @Test func fleetSampleListsEachLinkedCopyWithTheCoordinatorArmed() async throws {
    let engine = FixtureEngine(scenario: .fleet)
    engine.latency = .zero
    let model = AppModel(engine: engine)
    engine.start(model: model)
    let project = try #require(model.projects.first { $0.members.count > 1 })
    let copies = engine.linkedCopies(of: project.ref, in: model)
    #expect(copies.count == project.members.count)
    let coordinator = try #require(LinkedProjectResolver.coordinator(copies))
    #expect(coordinator.ref == project.ref)
    #expect(coordinator.binding?.standby != nil)
  }

  @Test func machinesLinkOfTheAwayCoordinatorOpensTheReachableCopy() async throws {
    let engine = FixtureEngine(scenario: .fleet)
    engine.latency = .zero
    let model = AppModel(engine: engine)
    engine.start(model: model)
    let project = try #require(model.projects.first { $0.members.count > 1 })
    // Both machines connected: the opened copy's own settings.
    #expect(LinkedProjectState.settingsTarget(project.ref, in: model) == project.ref)
    // M4 away for 25 minutes: Minis' copy, which can take over.
    let away = FixtureEngine.fleetCopies(of: project, machine: { _ in (online: true, switchedOff: false) }, state: .coordinatorAway, now: Date())
    let coordinator = try #require(LinkedProjectResolver.coordinator(away))
    #expect(!coordinator.machineOnline)
    let target = LinkedProjectResolver.settingsCopy(opened: coordinator.ref, copies: away)
    #expect(target != coordinator.ref)
    let row = try #require(LinkedProjectResolver.rows(away, now: Date(), unreachableSince: coordinator.lastSeenAt).first { $0.copy.ref == target })
    #expect(row.takeover == .ready)
  }
}
