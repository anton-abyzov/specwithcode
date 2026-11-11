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

  @Test func threadsOnAnOfflineMachineGroupAsOffline() {
    let lost = ThreadPlacement(owner: "M4", unknown: .init(machine: "M4", lastSeenAt: now))
    let groups = ThreadGroups([
      row("live", activity: .working, placement: ThreadPlacement(owner: "Minis")),
      row("was-working", activity: .working, placement: lost),
      row("was-failed", activity: .failed, placement: lost, minutesAgo: 5),
      row("done", placement: lost, resolved: true),
    ])
    #expect(groups.working.map(\.ref.threadId) == ["live"])
    #expect(groups.needsYou.isEmpty)
    #expect(groups.offline.map(\.ref.threadId) == ["was-working", "was-failed"])
    #expect(groups.resolved.map(\.ref.threadId) == ["done"])
    #expect(!ThreadGroups([row("x", placement: lost)]).isEmpty)
  }

  @Test func rowNoteShowsWhereItLivesAndRuns() {
    let moved = row("moved", placement: ThreadPlacement(owner: "M4", runsOn: "Minis"))
    // A thread that runs away from home names both machines, whatever the project spans.
    #expect(ProjectOverviewView.note(moved, showsMachine: false, now: now) == "M4 → Minis · Last message")
    #expect(ProjectOverviewView.age(moved, now: now) == "1m")
    #expect(ProjectOverviewView.spoken(moved, now: now) == "Idle, M4, running on Minis online")

    let lost = row("lost", activity: .working, placement: ThreadPlacement(owner: "M4", runsOn: "Minis", unknown: .init(machine: "Minis", lastSeenAt: now.addingTimeInterval(-60))))
    let note = plain(ProjectOverviewView.note(lost, showsMachine: false, now: now) ?? "")
    #expect(note.hasPrefix("M4 → Minis · Unknown · last seen "))
    #expect(!note.contains("Last message"))
    #expect(ProjectOverviewView.age(lost, now: now) == nil)
    #expect(ProjectOverviewView.spokenLabel(lost) == "lost")
    let spoken = plain(ProjectOverviewView.spoken(lost, now: now))
    #expect(spoken.hasPrefix("M4, running on Minis, Unknown, last seen "))
    #expect(!spoken.contains("Working"))
  }

  @Test func rowNamesTheMachineOnlyWhenItTellsThreadsApart() {
    let home = row("home", placement: ThreadPlacement(owner: "MacBook Air"), preview: nil, minutesAgo: 28)
    // A quiet thread on the project's only machine is two lines: its title, and who runs it.
    #expect(ProjectOverviewView.note(home, showsMachine: false, now: now) == nil)
    #expect(ProjectOverviewView.note(home, showsMachine: true, now: now) == "MacBook Air")
    #expect(ProjectOverviewView.age(home, now: now) == "28m")

    var busy = row("busy", activity: .working, placement: ThreadPlacement(owner: "M4"), minutesAgo: 9)
    busy.workStartedAt = now.addingTimeInterval(-120)
    #expect(ProjectOverviewView.note(busy, showsMachine: false, now: now) == nil)
    #expect(ProjectOverviewView.age(busy, now: now) == "2m")
    busy.planProgress = .init(completed: 3, total: 5)
    #expect(ProjectOverviewView.note(busy, showsMachine: false, now: now) == "3/5 tasks")
    #expect(ProjectOverviewView.note(busy, showsMachine: true, now: now) == "M4 · 3/5 tasks")

    let failed = row("failed", activity: .failed, placement: ThreadPlacement(owner: "M4"), preview: "Out of credit")
    #expect(ProjectOverviewView.note(failed, showsMachine: false, now: now) == "Failed · Out of credit")
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

  @Test func separateCheckoutsOnOneMachineEachStayOpenable() {
    let current = ProjectRef(environmentId: "m4", projectId: "main")
    func member(_ env: String, _ id: String, _ folder: String) -> ProjectMember {
      ProjectMember(ref: ProjectRef(environmentId: env, projectId: id), machineLabel: env.uppercased(), machineOnline: true, isLinked: false, folder: folder)
    }
    let members = [
      member("m4", "main", "/Users/a/Projects/sw-easychamp"),
      member("m1", "m1-main", "/Users/b/Projects/sw-easychamp"),
      member("m1", "m1-dup", "/Users/b/Projects/sw-easychamp"),
      member("m1", "m1-copy", "/Users/b/work/easychamp-copy"),
    ]
    let choices = OrchestratorSwitcher.choices(members, current: current)
    #expect(choices.map(\.ref.projectId) == ["main", "m1-main", "m1-copy"])
    #expect(choices.map { OrchestratorSwitcher.title($0, among: choices) } == ["M4", "M1 · sw-easychamp", "M1 · easychamp-copy"])
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
