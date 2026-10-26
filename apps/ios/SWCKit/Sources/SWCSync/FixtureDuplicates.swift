import Foundation
import SWCWire

/// Demonstrates duplicate project registrations on the same machine (e.g. trailing slash
/// or re-registered folder) deduping into one row, and explicit logical projects merging
/// across machines. Built through ShellSummaries, so the simulator shows what the
/// phone makes of real shells.
enum FixtureDuplicates {
  static let machines: [MachineSummary] = [
    MachineSummary(id: "env-m1", label: "M1", status: .connected, platform: "macOS · arm64", serverVersion: "1.0.71", address: "http://192.168.1.10:3773", tokenDaysLeft: 28),
    MachineSummary(id: "env-m3", label: "M3", status: .connected, platform: "macOS · arm64", serverVersion: "1.0.71", address: "http://192.168.1.13:3773", tokenDaysLeft: 28),
    MachineSummary(id: "env-m4", label: "M4", status: .connected, platform: "macOS · arm64", serverVersion: "1.0.71", address: "http://192.168.1.20:3773", tokenDaysLeft: 28),
  ]

  static func output(now: Date) -> ShellSummaries.Output {
    let easychamp = "github.com/anton-abyzov/sw-easychamp"
    let specweave = "github.com/anton-abyzov/specweave"
    let specweaveLogical = "logical:specweave"
    func shell(_ projects: [ProjectShell], _ threads: [ThreadShell]) -> ShellSnapshot {
      ShellSnapshot(threads: threads, projects: projects)
    }
    return ShellSummaries.build([
      ShellSummaries.Machine(environmentId: "env-m1", label: "M1", online: true, snapshot: shell([
        project("m1-a", "EasyChamp", "/Users/anton/Projects/sw-easychamp", easychamp),
        project("m1-b", "EasyChamp", "/Users/anton/Projects/sw-easychamp/", easychamp),
        project("archived-check", "Archived check", "/tmp/archive-check", nil, archived: true),
        project("active-check", "Active check", "/tmp/active-check", nil),
        project("m1-sw", "SpecWeave", "/Users/anton/Projects/specweave", specweave, logicalId: specweaveLogical),
      ], [
        thread("t-scores", "m1-a", "Fix match scores", now.addingTimeInterval(-3600)),
      ])),
      ShellSummaries.Machine(environmentId: "env-m4", label: "M4", online: true, snapshot: shell([
        project("m4-sw", "SpecWeave", "/Users/you/Projects/specweave", specweave, logicalId: specweaveLogical),
        project("m4-notes", "Notes", "/Users/you/Documents/notes", nil),
        project("m4-notes-dup", "Notes", "/Users/you/Documents/notes/", nil),
      ], [
        thread("t-signup", "m4-notes-dup", "Tidy weekly notes", now.addingTimeInterval(-600)),
        thread("t-release", "m4-sw", "Release 3.1.5", now.addingTimeInterval(-7200)),
      ])),
    ])
  }

  private static func project(_ id: String, _ title: String, _ root: String, _ repository: String?, logicalId: String? = nil, archived: Bool = false) -> ProjectShell {
    let logicalSnippet = logicalId.map { ",\"logicalProject\":{\"id\":\"\($0)\",\"title\":\"\(title)\",\"coordinatorId\":\"coordinator:\($0)\",\"members\":[]}" } ?? ""
    let json = """
    {"id":"\(id)","title":"\(title)","workspaceRoot":"\(root)","defaultModelSelection":null,
     "workspaceSettings":{"kind":"code","environment":{"additionalFolders":[],"repositories":[]},"revision":1,
       "goal":"","instructions":"","coordinatorModelSelection":null,"coordinatorThreadId":"project-coordinator:\(id)",
       "paused":false,"archived":false,"autoResume":false\(logicalSnippet)},
     "scripts":[],"createdAt":"2026-10-01T00:00:00.000Z","updatedAt":"2026-10-01T00:00:00.000Z"}
    """
    var project = try! WireCoding.decoder.decode(ProjectShell.self, from: Data(json.utf8))
    project.workspaceSettings?.archived = archived
    project.repositoryIdentity = repository.map { RepositoryIdentity(canonicalKey: $0) }
    return project
  }

  private static func thread(_ id: String, _ projectId: String, _ title: String, _ updatedAt: Date) -> ThreadShell {
    let json = """
    {"createdBy":"user","creationSource":"mobile","id":"\(id)","projectId":"\(projectId)","title":"\(title)",
     "providerInstanceId":"claude","modelSelection":{"instanceId":"claude","model":"claude-opus-4-5"},
     "runtimeMode":"full-access","interactionMode":"default","branch":null,"worktreePath":null,
     "lineage":{"parentThreadId":null,"relationshipToParent":null,"rootThreadId":"\(id)"},
     "forkedFrom":null,"activeProviderThreadId":null,"latestRunId":null,"activeRunId":null,"status":"idle",
     "pendingRuntimeRequest":null,"latestVisibleMessage":null,"latestUserMessageAt":null,
     "hasActionableProposedPlan":false,"pendingBackgroundTasks":[],"providerInstanceHistory":[],
     "itemCount":0,"visibleItemCount":0,"createdAt":"2026-10-18T06:00:00.000Z","updatedAt":"2026-10-18T06:00:00.000Z",
     "archivedAt":null,"settledOverride":null,"settledAt":null,"deletedAt":null}
    """
    var thread = try! WireCoding.decoder.decode(ThreadShell.self, from: Data(json.utf8))
    thread.updatedAt = updatedAt
    return thread
  }
}
