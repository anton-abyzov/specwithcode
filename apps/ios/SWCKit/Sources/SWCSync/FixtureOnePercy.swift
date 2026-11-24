import Foundation
import SWCWire

/// One Percy on linked machines (1448): Studio and Laptop hold linked seats,
/// Studio runs the routines, and Desktop holds an assistant that never joined.
/// Built through ShellSummaries, so the simulator shows what the phone makes
/// of real shells. `away` takes Laptop offline.
enum FixtureOnePercy {
  static let studio = "env-studio"
  static let laptop = "env-laptop"
  static let desktop = "env-desktop"
  static let link = "percy-link"

  static func machines(away: Bool) -> [MachineSummary] {
    [
      MachineSummary(id: studio, label: "Studio", status: .connected, platform: "macOS · arm64", serverVersion: "1.1.0", address: "https://studio.local:3773", tokenDaysLeft: 28),
      MachineSummary(id: laptop, label: "Laptop", status: away ? .offline : .connected, platform: "macOS · arm64", serverVersion: "1.1.0", address: "https://laptop.local:3773", tokenDaysLeft: 28),
      MachineSummary(id: desktop, label: "Desktop", status: .connected, platform: "Windows · x64", serverVersion: "1.1.0", address: "https://desktop.local:3773", tokenDaysLeft: 28),
    ]
  }

  static func output(now: Date, away: Bool, includeAide: Bool = true) -> ShellSummaries.Output {
    func ago(_ minutes: Double) -> Date { now.addingTimeInterval(-minutes * 60) }
    let members = [(studio, "percy"), (laptop, "percy")]
    return ShellSummaries.build([
      ShellSummaries.Machine(environmentId: studio, label: "Studio", online: true, snapshot: ShellSnapshot(threads: [
        thread("t-week", "percy", "Plan the week", ago(12)),
        thread("t-passport", "percy", "Renew the passport", ago(2 * 24 * 60)),
        thread("t-hero", "website", "Tighten the hero copy", ago(45)),
      ], projects: [
        assistant("percy", members: members, routineOwner: true),
        project("website", "Website", "/Users/sample/Projects/website"),
      ])),
      ShellSummaries.Machine(environmentId: laptop, label: "Laptop", online: !away, snapshot: ShellSnapshot(threads: [
        thread("t-flights", "percy", "Book flights to Lisbon", ago(70), unread: true),
        thread("t-gifts", "percy", "Gift ideas for the team", ago(5 * 60)),
      ], projects: [
        assistant("percy", members: members, routineOwner: false),
      ]), lastSeenAt: away ? ago(3 * 60) : nil),
      ShellSummaries.Machine(environmentId: desktop, label: "Desktop", online: true, snapshot: ShellSnapshot(threads: [
        thread("t-notes", "assistant", "Sort the old notes", ago(26 * 60)),
      ], projects: [
        assistant("assistant", members: [], routineOwner: nil),
      ])),
    ], includeAide: includeAide)
  }

  static let transcript: [TranscriptRow.Kind] = [
    .user(text: "Good morning. What needs me today?"),
    .assistant(markdown: """
      Good morning. Two things are open.

      - *Book flights to Lisbon*, started on Laptop, has fares ready to compare.
      - *Plan the week*, started on Studio, is waiting for your priorities.
      """, streaming: false),
  ]

  private static func assistant(_ id: String, members: [(String, String)], routineOwner: Bool?) -> ProjectShell {
    var shell = project(id, "Percy", "/Users/sample/.assistant", kind: "personal")
    guard !members.isEmpty else { return shell }
    shell.workspaceSettings?.logicalProject = LogicalProject(id: link, title: "Percy", coordinatorId: "coordinator:\(link)", members: members.map {
      LogicalProjectMember(environmentId: $0.0, projectId: $0.1, coordinatorThreadId: "project-coordinator:\($0.1)")
    })
    shell.workspaceSettings?.coordinatorBinding = CoordinatorBinding(epoch: 1, state: .active, routineOwner: routineOwner)
    return shell
  }

  private static func project(_ id: String, _ title: String, _ root: String, kind: String = "code") -> ProjectShell {
    let json = """
    {"id":"\(id)","title":"\(title)","workspaceRoot":"\(root)","defaultModelSelection":null,
     "workspaceSettings":{"kind":"\(kind)","environment":{"additionalFolders":[],"repositories":[]},"revision":1,
       "goal":"","instructions":"","coordinatorModelSelection":null,"coordinatorThreadId":"project-coordinator:\(id)",
       "paused":false,"archived":false,"autoResume":false},
     "scripts":[],"createdAt":"2026-11-01T00:00:00.000Z","updatedAt":"2026-11-01T00:00:00.000Z"}
    """
    return try! WireCoding.decoder.decode(ProjectShell.self, from: Data(json.utf8))
  }

  private static func thread(_ id: String, _ projectId: String, _ title: String, _ at: Date, unread: Bool = false) -> ThreadShell {
    let json = """
    {"createdBy":"user","creationSource":"mobile","id":"\(id)","projectId":"\(projectId)","title":"\(title)",
     "providerInstanceId":"claude","modelSelection":{"instanceId":"claude","model":"claude-opus-5-5"},
     "runtimeMode":"full-access","interactionMode":"default","branch":null,"worktreePath":null,
     "lineage":{"parentThreadId":null,"relationshipToParent":null,"rootThreadId":"\(id)"},
     "forkedFrom":null,"activeProviderThreadId":null,"latestRunId":null,"activeRunId":null,"status":"idle",
     "pendingRuntimeRequest":null,"latestVisibleMessage":null,"latestUserMessageAt":null,
     "hasActionableProposedPlan":false,"pendingBackgroundTasks":[],"providerInstanceHistory":[],
     "itemCount":0,"visibleItemCount":0,"createdAt":"2026-11-01T06:00:00.000Z","updatedAt":"2026-11-01T06:00:00.000Z",
     "archivedAt":null,"settledOverride":null,"settledAt":null,"deletedAt":null}
    """
    var thread = try! WireCoding.decoder.decode(ThreadShell.self, from: Data(json.utf8))
    thread.updatedAt = at
    thread.latestUserMessageAt = at
    if unread {
      thread.latestRunCompletedAt = at
      thread.lastVisitedAt = at.addingTimeInterval(-60)
    }
    return thread
  }
}
