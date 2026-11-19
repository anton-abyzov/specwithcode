import Foundation
import Testing
import SWCSync
@testable import SWCFeatures

@MainActor @Suite struct MachineRowTests {
  private func machine(_ status: MachineStatus, counted: Bool) -> MachineSummary {
    var machine = MachineSummary(id: "env-m4", label: "Sam's MacBook", displayName: "M4", status: status, serverVersion: "1.0.309")
    machine.isCounted = counted
    return machine
  }

  @Test func machineThatNeverAnsweredSaysItCannotBeReached() {
    #expect(machine(.offline, counted: false).statusLabel == "Can’t reach it · retrying")
    #expect(machine(.reconnecting, counted: false).statusLabel == "Can’t reach it · retrying")
    #expect(machine(.offline, counted: false).rowStatus == "Can’t reach it · retrying · Chats and projects not counted")
  }

  @Test func otherStatesKeepTheirOwnWords() {
    // Its saved chats are listed, so it is offline, not unknown.
    #expect(machine(.offline, counted: true).statusLabel == "Offline")
    #expect(machine(.offline, counted: true).rowStatus == "Offline")
    // The first attempt is still in flight, and a pairing that needs the person says so.
    #expect(machine(.connecting, counted: false).statusLabel == "Connecting")
    #expect(machine(.needsRepair, counted: false).statusLabel == "Pair again")
    var paused = machine(.offline, counted: false)
    paused.isDisconnected = true
    #expect(paused.statusLabel == "Disconnected on this phone")
    #expect(paused.rowStatus == "Disconnected on this phone")
  }

  @Test func rowCountsWhatRunsOnTheMachine() {
    let model = AppModel(engine: FixtureEngine(scenario: .fleet))
    model.engine.start(model: model)
    let m4 = model.machines[0]
    let working = model.allThreads.filter { $0.ref.environmentId == m4.id && $0.activity == .working && !$0.isResolved && !$0.isUnknown }.count
    let projects = model.projectsOn(m4.id, among: model.projects).count
    #expect(model.activityLine(m4) == MachineActivity.line(counted: true, working: working, projects: projects))
    var silent = m4
    silent.isCounted = false
    #expect(model.activityLine(silent) == "Chats and projects not counted")
  }

  @Test func machineIconFollowsTheKindThenThePlatform() {
    var machine = machine(.connected, counted: true)
    machine.platform = "Linux · x64"
    #expect(machine.symbol == "server.rack")
    machine.kind = .macMini
    #expect(machine.symbol == "macmini")
  }

  @Test func everyMachineHasItsOwnColor() {
    let model = AppModel(engine: FixtureEngine(scenario: .fleet))
    model.engine.start(model: model)
    let colors = model.machines.map { model.machineIdentities.color($0.id) }
    #expect(Set(colors).count == model.machines.count)
    // A name alone still finds its machine's color.
    #expect(model.machineTint(id: nil, named: model.machines[0].displayName) != nil)
    #expect(model.machineTint(id: nil, named: "Nowhere") == nil)
  }
}
