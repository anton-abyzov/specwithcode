import Testing
import SWCWire
@testable import SWCSync

/// A coordinator's workers are listed under its project, as on the desktop;
/// a thread's own subagents stay inside that thread.
@Suite("Coordinator workers")
struct CoordinatorWorkerTests {
  private func child(_ id: String, parent: String) throws -> ThreadShell {
    var thread = try TestData.thread(id: id)
    thread.lineage = ThreadLineage(parentThreadId: parent, relationshipToParent: .subagent, rootThreadId: parent)
    return thread
  }

  @Test func aCoordinatorsWorkerIsListed() throws {
    let worker = try child("worker", parent: "project-coordinator:proj_1")
    #expect(ShellSummaries.isTopLevel(worker, coordinatorIds: []))
    #expect(ShellSummaries.isCoordinatorWorker(worker, coordinatorIds: []))
    let named = try child("named", parent: "coord-1")
    #expect(ShellSummaries.isTopLevel(named, coordinatorIds: ["coord-1"]))
  }

  @Test func aThreadsOwnSubagentIsNot() throws {
    let nested = try child("nested", parent: "thr_1")
    #expect(!ShellSummaries.isTopLevel(nested, coordinatorIds: ["coord-1"]))
    #expect(!ShellSummaries.isCoordinatorWorker(nested, coordinatorIds: ["coord-1"]))
    #expect(ShellSummaries.isTopLevel(try TestData.thread(), coordinatorIds: []))
  }
}
