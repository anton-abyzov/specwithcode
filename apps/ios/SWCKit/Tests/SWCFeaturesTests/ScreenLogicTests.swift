import Foundation
import Testing
@testable import SWCFeatures
import SWCSync

@MainActor
@Suite("Overview row speech")
struct OverviewSpeechTests {
  private let now = Date(timeIntervalSinceReferenceDate: 800_000_000)

  private func thread(_ title: String, activity: ThreadActivity, preview: String? = nil, updated: TimeInterval = 0, started: TimeInterval? = nil, plan: PlanProgress? = nil, unread: Bool = false, pinned: Bool = false, resolved: Bool = false, machine: String = "Office Mac", online: Bool = true) -> ThreadSummary {
    ThreadSummary(
      ref: ThreadRef(environmentId: "env", threadId: title),
      title: title,
      activity: activity,
      preview: preview,
      updatedAt: now.addingTimeInterval(-updated),
      workStartedAt: started.map { now.addingTimeInterval(-$0) },
      isPinned: pinned,
      isResolved: resolved,
      isUnread: unread,
      machineLabel: machine,
      machineOnline: online,
      planProgress: plan
    )
  }

  @Test func workingRowSpeaksTimeAndTasksInWords() {
    let row = thread("Release", activity: .working, preview: "Running tests", started: 120, plan: PlanProgress(completed: 3, total: 5))
    #expect(ProjectOverviewView.spokenLabel(row) == "Release")
    #expect(ProjectOverviewView.spoken(row, now: now) == "Working, for 2 minutes, 3 of 5 tasks done, Office Mac online")
  }

  @Test func idleRowKeepsItsPreviewInTheLabel() {
    let row = thread("Docs", activity: .idle, preview: "Merged the docs PR", unread: true, machine: "Travel laptop", online: false)
    #expect(ProjectOverviewView.spokenLabel(row) == "Docs, Merged the docs PR")
    #expect(ProjectOverviewView.spoken(row, now: now) == "Idle, Unread, Travel laptop offline")
  }

  @Test func rowWithoutPreviewSaysWhenItChanged() {
    let row = thread("Dedupe", activity: .idle, updated: 3 * 3_600, pinned: true)
    #expect(ProjectOverviewView.spokenLabel(row) == "Dedupe")
    #expect(ProjectOverviewView.spoken(row, now: now) == "Idle, updated 3 hours ago, Pinned, Office Mac online")
  }

  @Test func noLabelUsesAbbreviations() {
    let rows = [
      thread("A", activity: .working, started: 30, plan: PlanProgress(completed: 1, total: 4)),
      thread("B", activity: .failed, preview: "Build failed"),
      thread("C", activity: .idle, updated: 90),
      thread("D", activity: .working, resolved: true),
    ]
    for row in rows {
      let spoken = ProjectOverviewView.spokenLabel(row) + " " + ProjectOverviewView.spoken(row, now: now)
      #expect(!spoken.contains("<1m"))
      #expect(!spoken.contains("/"))
      #expect(spoken.components(separatedBy: "Online").count == 1)
    }
  }
}

@MainActor
@Suite("Machine wake")
struct MachineWakeTests {
  @Test func onlyDroppedConnectionsWake() {
    #expect(MachineStatus.offline.canWake)
    #expect(MachineStatus.reconnecting.canWake)
    #expect(!MachineStatus.connected.canWake)
    #expect(!MachineStatus.connecting.canWake)
    #expect(!MachineStatus.needsRepair.canWake)
    #expect(!MachineStatus.unsupported.canWake)
  }
}

@MainActor
@Suite("Screen model rules")
struct ScreenModelRuleTests {
  private func make(_ scenario: FixtureScenario = .default) -> (AppModel, FixtureEngine) {
    let engine = FixtureEngine(scenario: scenario)
    engine.latency = .zero
    engine.streamDelay = .zero
    return (AppModel(engine: engine), engine)
  }

  private func settle(_ done: () -> Bool) async {
    for _ in 0..<2_000 where !done() { await Task.yield() }
  }

  @Test func pullToRefreshLeavesALiveConnectionAlone() async {
    let (model, _) = make()
    model.wakeMachine("env-studio-mac")
    #expect(model.machine("env-studio-mac")?.status == .connected)
    model.wakeMachine("env-travel-laptop")
    #expect(model.machine("env-travel-laptop")?.status == .reconnecting)
    await settle { model.machine("env-travel-laptop")?.status == .offline }
    #expect(model.machine("env-travel-laptop")?.status == .offline)
    model.wakeMachine("env-unknown")
  }

  @Test func setUpAideWaitsUntilEveryMachineIsBack() async throws {
    let (model, engine) = make()
    engine.removeMachine(id: "env-studio-mac")
    #expect(model.aide == nil)
    // The travel laptop is offline and may hold Aide.
    #expect(!model.allMachinesLoaded)
    await #expect(throws: (any Error).self) { try await engine.setupAide() }
    #expect(model.aide == nil)
    engine.removeMachine(id: "env-travel-laptop")
    #expect(model.allMachinesLoaded)
    let ref = try await engine.setupAide()
    #expect(ref.environmentId == "env-build-box")
    #expect(model.aide?.ref == ref)
  }

  @Test func aideGoesOnTheLowestEnvironmentId() async throws {
    let (model, engine) = make(.empty)
    #expect(!model.allMachinesLoaded)
    let first = try await engine.pair(link: "http://zeta.local:3773#token=a")
    _ = try await engine.pair(link: "http://alpha.local:3773#token=b")
    model.machines.reverse()
    let ref = try await engine.setupAide()
    #expect(ref.environmentId == first.id)
    #expect(model.machines.map(\.id).min() == first.id)
  }

  @Test func privacyPolicyLinksToTheSite() {
    #expect(AppLinks.privacyPolicy.scheme == "https")
    #expect(AppLinks.privacyPolicy.host() == "spec-weave.com")
    #expect(AppLinks.privacyPolicy.path() == "/privacy")
  }
}
