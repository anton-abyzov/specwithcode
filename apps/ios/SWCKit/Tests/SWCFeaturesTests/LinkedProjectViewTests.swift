import Foundation
import Testing
@testable import SWCFeatures
@testable import SWCSync
import SWCWire

@MainActor
@Suite struct LinkedProjectViewTests {
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

  @Test func noTakeoverIsEverSent() {
    func copy(_ env: String, state: CoordinatorBindingState, online: Bool) -> LinkedProjectResolver.Copy {
      LinkedProjectResolver.Copy(ref: ProjectRef(environmentId: env, projectId: "p-\(env)"), machineLabel: env.uppercased(), machineOnline: online, binding: CoordinatorBinding(epoch: 3, state: state))
    }
    let now = Date()
    // M4 has been away for an hour; M1 still follows it on an old version.
    let away = [copy("m4", state: .active, online: false), copy("m1", state: .transferred, online: true)]
    let rows = LinkedProjectResolver.rows(away, now: now, unreachableSince: now.addingTimeInterval(-3600))
    #expect(!LinkedProjectState.mayTakeOver(at: away[1].ref, from: away[0].ref, copies: away, rows: rows))
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
    #expect(row.takeover == .hidden)
  }
}
