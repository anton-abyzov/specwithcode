import Foundation
import Testing
import SWCWire
import SWCSync
@testable import SWCFeatures

/// One project's thread list, as the desktop shows it. The web runs the same
/// cases in apps/web/src/studio/threadListCases.test.ts, and the server checks
/// the titles in apps/server/src/project/AgentSessionPrompt.test.ts.
@Suite("Thread list, shared cases") struct ThreadListCasesTests {
  struct Model: Decodable { let slug: String; let name: String }
  struct Provider: Decodable { let instanceId: String; let driver: String; let displayName: String; let models: [Model] }
  struct Case: Decodable {
    let name: String
    let id: String
    let title: String
    let createdBy: String
    let imported: Bool?
    let settled: Bool?
    let deleted: Bool?
    let parent: String?
    let provider: String
    let model: String
    let listed: Bool
    let group: String?
    let label: String?
  }
  struct Title: Decodable { let title: String; let markup: Bool }
  struct File: Decodable {
    let environmentId: String
    let projectId: String
    let providers: [Provider]
    let threads: [Case]
    let titles: [Title]
  }

  static let file: File = {
    let url = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent() // SWCFeaturesTests
      .deletingLastPathComponent() // Tests
      .deletingLastPathComponent() // SWCKit
      .deletingLastPathComponent() // ios
      .deletingLastPathComponent() // apps
      .deletingLastPathComponent() // repository
      .appendingPathComponent("packages/shared/src/threadList.cases.json")
    // swiftlint:disable:next force_try
    return try! JSONDecoder().decode(File.self, from: Data(contentsOf: url))
  }()

  static var providers: [ServerProviderSummary] {
    file.providers.map { ServerProviderSummary(instanceId: $0.instanceId, driver: $0.driver, displayName: $0.displayName, models: $0.models.map { .init(slug: $0.slug, name: $0.name) }) }
  }

  /// The shell a machine sends for one case.
  static func shell(_ thread: Case) throws -> ThreadShell {
    let at = "2026-11-10T15:00:00.000Z"
    var json: [String: Any] = [
      "createdBy": thread.createdBy,
      "id": thread.id,
      "projectId": file.projectId,
      "title": thread.title,
      "providerInstanceId": thread.provider,
      "modelSelection": ["instanceId": thread.provider, "model": thread.model],
      "runtimeMode": "full-access",
      "interactionMode": "default",
      "lineage": [
        "parentThreadId": thread.parent ?? NSNull(),
        "relationshipToParent": thread.parent == nil ? NSNull() : "subagent",
        "rootThreadId": thread.parent ?? thread.id,
      ] as [String: Any],
      "status": "idle",
      "hasActionableProposedPlan": false,
      "pendingBackgroundTasks": [Any](),
      "providerInstanceHistory": [Any](),
      "itemCount": 2,
      "visibleItemCount": 2,
      "createdAt": at,
      "updatedAt": at,
    ]
    if thread.imported == true { json["historyOrigin"] = "v1_import" }
    if thread.settled == true { json["settledOverride"] = "settled" }
    if thread.deleted == true { json["deletedAt"] = at }
    return try WireCoding.decoder.decode(ThreadShell.self, from: JSONSerialization.data(withJSONObject: json))
  }

  static func group(of id: String, in groups: ThreadGroups) -> String? {
    let named: [(String, [ThreadSummary])] = [("Needs you", groups.needsYou), ("Working", groups.working), ("Offline", groups.offline), ("Idle", groups.idle), ("Resolved", groups.resolved)]
    return named.first { $0.1.contains { $0.ref.threadId == id } }?.0
  }

  @Test func listsGroupsAndLabelsEachThreadAsTheDesktopDoes() throws {
    let file = Self.file
    let shells = try file.threads.map(Self.shell)
    let coordinatorIds: Set<String> = ["project-coordinator:\(file.projectId)"]
    let listed = shells.filter { ShellSummaries.isTopLevel($0, coordinatorIds: coordinatorIds) }
    #expect(Set(listed.map(\.id)) == Set(file.threads.filter(\.listed).map(\.id)))

    let rows = listed.map { ShellSummaries.threadSummary($0, environmentId: file.environmentId, projectTitle: nil, machineLabel: "MacBook Air", machineOnline: true, providers: Self.providers) }
    let groups = ThreadGroups(rows)
    for thread in file.threads where thread.listed {
      let row = try #require(rows.first { $0.ref.threadId == thread.id }, "\(thread.name)")
      #expect(Self.group(of: thread.id, in: groups) == thread.group, "\(thread.name)")
      #expect(row.identity.label == thread.label, "\(thread.name)")
      // A quiet thread on one machine: its title and who runs it, nothing more.
      #expect(ProjectOverviewView.note(row, showsMachine: false) == nil, "\(thread.name)")
    }
  }

  @Test func neverPrintsHarnessMarkupAsATitle() {
    for entry in Self.file.titles {
      #expect(ThreadTitle.isHarnessMarkup(entry.title) == entry.markup, "\(entry.title)")
      #expect(ThreadTitle.shown(entry.title) == (entry.markup ? "Imported session" : entry.title), "\(entry.title)")
    }
    #expect(ThreadTitle.shown("  ") == "New thread")
  }
}
