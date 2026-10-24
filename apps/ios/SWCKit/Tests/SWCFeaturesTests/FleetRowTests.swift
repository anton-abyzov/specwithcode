import Foundation
import Testing
@testable import SWCFeatures
import SWCSync

@MainActor
@Suite("Rows on an unreachable machine")
struct FleetRowTests {
  private let now = Date(timeIntervalSinceReferenceDate: 800_000_000)

  private func row(_ id: String, activity: ThreadActivity = .idle, placement: ThreadPlacement, preview: String? = "Last message", minutesAgo: Double = 1, resolved: Bool = false) -> ThreadSummary {
    ThreadSummary(
      ref: ThreadRef(environmentId: "env", threadId: id),
      title: id,
      activity: activity,
      preview: preview,
      updatedAt: now.addingTimeInterval(-minutesAgo * 60),
      isResolved: resolved,
      machineLabel: placement.owner,
      machineOnline: placement.unknown == nil,
      placement: placement
    )
  }

  private func plain(_ text: String) -> String { text.replacingOccurrences(of: "\u{202F}", with: " ") }

  @Test func unknownThreadsStayIdleWithExplicitUnknownRows() {
    let lost = ThreadPlacement(owner: "M4", unknown: .init(machine: "M4", lastSeenAt: now))
    let groups = ThreadGroups([
      row("live", activity: .working, placement: ThreadPlacement(owner: "Minis")),
      row("was-working", activity: .working, placement: lost),
      row("was-failed", activity: .failed, placement: lost, minutesAgo: 5),
      row("done", placement: lost, resolved: true),
    ])
    #expect(groups.working.map(\.ref.threadId) == ["live"])
    #expect(groups.needsYou.isEmpty)
    #expect(groups.idle.map(\.ref.threadId) == ["was-working", "was-failed"])
    #expect(groups.resolved.map(\.ref.threadId) == ["done"])
    #expect(!ThreadGroups([row("x", placement: lost)]).isEmpty)
  }

  @Test func rowMetaShowsWhereItLivesAndRuns() {
    let moved = row("moved", placement: ThreadPlacement(owner: "M4", runsOn: "Minis"))
    #expect(ProjectOverviewView.meta(moved, now: now) == "M4 → Minis · Last message")
    #expect(ProjectOverviewView.spoken(moved, now: now) == "Idle, M4, running on Minis online")

    let lost = row("lost", activity: .working, placement: ThreadPlacement(owner: "M4", runsOn: "Minis", unknown: .init(machine: "Minis", lastSeenAt: now.addingTimeInterval(-60))))
    let meta = plain(ProjectOverviewView.meta(lost, now: now))
    #expect(meta.hasPrefix("M4 → Minis · Unknown · last seen "))
    #expect(!meta.contains("Last message"))
    #expect(ProjectOverviewView.spokenLabel(lost) == "lost")
    let spoken = plain(ProjectOverviewView.spoken(lost, now: now))
    #expect(spoken.hasPrefix("M4, running on Minis, Unknown, last seen "))
    #expect(!spoken.contains("Working"))
  }

  @Test func switcherSaysWhichMachineAnswers() {
    let ref = ProjectRef(environmentId: "m4", projectId: "p")
    #expect(OrchestratorSwitcher.detail(ProjectMember(ref: ref, machineLabel: "M4", machineOnline: true, isCoordinator: true), now: now) == "Coordinator")
    #expect(OrchestratorSwitcher.detail(ProjectMember(ref: ref, machineLabel: "Minis", machineOnline: true), now: now) == "Online")
    #expect(OrchestratorSwitcher.detail(ProjectMember(ref: ref, machineLabel: "Minis", machineOnline: false), now: now) == "Offline")
    let seen = plain(OrchestratorSwitcher.detail(ProjectMember(ref: ref, machineLabel: "M4", machineOnline: false, lastSeenAt: now.addingTimeInterval(-60), isCoordinator: true), now: now))
    #expect(seen.hasPrefix("Coordinator · Offline · last seen "))
  }
}

@MainActor
@Suite("Orchestrator switcher choices")
struct OrchestratorSwitcherChoiceTests {
  @Test func listsEachMachineOnce() {
    let current = ProjectRef(environmentId: "m4", projectId: "notes-dup")
    let members = [
      ProjectMember(ref: ProjectRef(environmentId: "m4", projectId: "notes"), machineLabel: "M4", machineOnline: true),
      ProjectMember(ref: current, machineLabel: "M4", machineOnline: true),
      ProjectMember(ref: ProjectRef(environmentId: "m1", projectId: "notes"), machineLabel: "M1", machineOnline: true),
      ProjectMember(ref: ProjectRef(environmentId: "m1", projectId: "notes-2"), machineLabel: "M1", machineOnline: true),
    ]
    let choices = OrchestratorSwitcher.choices(members, current: current)
    #expect(choices.map(\.ref.projectId) == ["notes-dup", "notes"])
    #expect(choices.map(\.ref.environmentId) == ["m4", "m1"])
  }

  @Test func anotherMachineIsRepresentedByItsLinkedCopy() {
    let current = ProjectRef(environmentId: "m4", projectId: "app")
    let members = [
      ProjectMember(ref: current, machineLabel: "M4", machineOnline: true, isLinked: true),
      ProjectMember(ref: ProjectRef(environmentId: "m1", projectId: "stray"), machineLabel: "M1", machineOnline: true, isLinked: false),
      ProjectMember(ref: ProjectRef(environmentId: "m1", projectId: "app"), machineLabel: "M1", machineOnline: true, isLinked: true),
      ProjectMember(ref: ProjectRef(environmentId: "m3", projectId: "stray"), machineLabel: "M3", machineOnline: true, isLinked: false),
      ProjectMember(ref: ProjectRef(environmentId: "m3", projectId: "app"), machineLabel: "M3", machineOnline: true, isCoordinator: true, isLinked: true),
    ]
    let choices = OrchestratorSwitcher.choices(members, current: current)
    #expect(choices.map(\.ref) == [current, ProjectRef(environmentId: "m1", projectId: "app"), ProjectRef(environmentId: "m3", projectId: "app")])
  }

  @Test func sameFolderTwiceOnOneMachineHasNoSwitcher() {
    let current = ProjectRef(environmentId: "m4", projectId: "notes")
    let members = [
      ProjectMember(ref: current, machineLabel: "M4", machineOnline: true),
      ProjectMember(ref: ProjectRef(environmentId: "m4", projectId: "notes-dup"), machineLabel: "M4", machineOnline: true),
    ]
    #expect(OrchestratorSwitcher.choices(members, current: current).count == 1)
  }
}
