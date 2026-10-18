import Foundation
import Testing
import SWCWire
@testable import SWCSync

@Suite struct ActivityTests {
  @Test func idleByDefault() throws {
    #expect(ShellSummaries.activity(try TestData.thread()) == .idle)
  }

  @Test func pendingRequestNeedsYou() throws {
    var thread = try TestData.thread()
    thread.status = .failed
    thread.pendingRuntimeRequest = PendingRuntimeRequestSummary(id: "req_1", kind: .command, createdAt: Date())
    #expect(ShellSummaries.activity(thread) == .needsYou)
  }

  @Test(arguments: [ThreadStatus.preparing, .queued, .starting, .running, .waiting])
  func workingStatuses(_ status: ThreadStatus) throws {
    var thread = try TestData.thread()
    thread.status = status
    #expect(ShellSummaries.activity(thread) == .working)
  }

  @Test func activityRunStatusCountsAsWorking() throws {
    var thread = try TestData.thread()
    thread.activityRunStatus = .queued
    #expect(ShellSummaries.activity(thread) == .working)
    thread.activityRunStatus = .completed
    #expect(ShellSummaries.activity(thread) == .idle)
  }

  @Test func failedStatus() throws {
    var thread = try TestData.thread()
    thread.status = .failed
    #expect(ShellSummaries.activity(thread) == .failed)
  }

  @Test func unreadWhenTheLatestRunFinishedAfterTheVisit() throws {
    var thread = try TestData.thread()
    thread.latestRunCompletedAt = TestData.date("2026-10-18T06:10:00.000Z")
    #expect(!thread.isUnread)
    thread.lastVisitedAt = TestData.date("2026-10-18T06:05:00.000Z")
    #expect(thread.isUnread)
    thread.lastVisitedAt = TestData.date("2026-10-18T06:10:00.000Z")
    #expect(!thread.isUnread)
  }

  @Test func settledOverrideWinsOverSettledAt() throws {
    var thread = try TestData.thread()
    #expect(!thread.isSettled)
    thread.settledAt = TestData.date("2026-10-18T06:10:00.000Z")
    #expect(thread.isSettled)
    thread.settledOverride = .active
    #expect(!thread.isSettled)
    thread.settledAt = nil
    thread.settledOverride = .settled
    #expect(thread.isSettled)
  }

  @Test func summaryCarriesTheDerivedFlags() throws {
    var thread = try TestData.thread(title: "  ")
    thread.status = .running
    thread.activityRunStartedAt = TestData.date("2026-10-18T06:00:00.000Z")
    thread.pinnedAt = TestData.date("2026-10-18T06:00:00.000Z")
    thread.settledOverride = .settled
    thread.planProgress = ThreadPlanProgress(completed: 1, total: 3)
    let summary = ShellSummaries.threadSummary(thread, environmentId: "env", projectTitle: "SpecWeave", machineLabel: "M4", machineOnline: true)
    #expect(summary.title == "New thread")
    #expect(summary.activity == .working)
    #expect(summary.workStartedAt == TestData.date("2026-10-18T06:00:00.000Z"))
    #expect(summary.isPinned)
    #expect(summary.isResolved)
    #expect(summary.planProgress == PlanProgress(completed: 1, total: 3))

    thread.status = .idle
    thread.planProgress = ThreadPlanProgress(completed: 0, total: 0)
    let idle = ShellSummaries.threadSummary(thread, environmentId: "env", projectTitle: nil, machineLabel: "M4", machineOnline: true)
    #expect(idle.workStartedAt == nil)
    #expect(idle.planProgress == nil)
  }

  @Test func previewFollowsActivity() throws {
    var thread = try TestData.thread()
    #expect(ShellSummaries.preview(thread) == nil)
    thread.latestVisibleMessage = LatestVisibleMessageSummary(id: "m", role: .assistant, text: "Line one\n\n  line two  ", updatedAt: Date())
    #expect(ShellSummaries.preview(thread) == "Line one line two")

    thread.status = .running
    thread.activeWork = ActiveWork(label: "Running tests", startedAt: Date())
    #expect(ShellSummaries.preview(thread) == "Running tests")

    thread.pendingRuntimeRequest = PendingRuntimeRequestSummary(id: "r", kind: .command, createdAt: Date())
    #expect(ShellSummaries.preview(thread) == "Waiting for your approval")
    thread.pendingRuntimeRequest = PendingRuntimeRequestSummary(id: "r", kind: .userInput, createdAt: Date())
    #expect(ShellSummaries.preview(thread) == "Waiting for your answer")

    thread.pendingRuntimeRequest = nil
    thread.status = .failed
    thread.lastError = "Usage limit reached"
    #expect(ShellSummaries.preview(thread) == "Usage limit reached")
  }
}

@Suite struct ShellSummariesTests {
  func machine(_ env: String, threads: [ThreadShell], projects: [ProjectShell], order: SidebarProjectOrder? = nil) -> ShellSummaries.Machine {
    ShellSummaries.Machine(environmentId: env, label: env.uppercased(), online: true, snapshot: ShellSnapshot(threads: threads, projects: projects), projectOrder: order)
  }

  @Test func listsOnlyTopLevelThreads() throws {
    var custom = try TestData.project()
    custom.workspaceSettings?.coordinatorThreadId = "coord_custom"
    var subagent = try TestData.thread(id: "sub")
    subagent.lineage.relationshipToParent = .subagent
    var archived = try TestData.thread(id: "archived")
    archived.archivedAt = Date()
    let threads = try [
      TestData.thread(id: "thr_1"),
      TestData.thread(id: "project-coordinator:proj_1"),
      TestData.thread(id: "coord_custom"),
      subagent,
      archived,
    ]
    let output = ShellSummaries.build([machine("env", threads: threads, projects: [custom])])
    let ref = ProjectRef(environmentId: "env", projectId: "proj_1")
    #expect(output.threadsByProject[ref]?.map(\.ref.threadId) == ["thr_1"])
    #expect(output.recentThreads.map(\.ref.threadId) == ["thr_1"])
    #expect(output.projects.map(\.ref) == [ref])
  }

  @Test func scratchProjectIsNotARowButItsChatsAreRecent() throws {
    let scratch = try TestData.project(id: "scratch", title: "No project", root: "/base/scratch/")
    let code = try TestData.project(id: "code", title: "Live Demo", root: "/base/projects/live-demo")
    let threads = try [TestData.thread(id: "chat", projectId: "scratch"), TestData.thread(id: "work", projectId: "code")]
    var machine = machine("env", threads: threads, projects: [scratch, code])
    #expect(ShellSummaries.build([machine]).projects.count == 2)

    machine.scratchWorkspaceRoot = "/base/scratch"
    let output = ShellSummaries.build([machine])
    #expect(output.projects.map(\.ref.projectId) == ["code"])
    #expect(Set(output.recentThreads.map(\.ref.threadId)) == ["chat", "work"])
  }

  @Test func aideComesFromTheLowestEnvironmentId() throws {
    var personal = try TestData.project(id: "aide", title: "Aide")
    personal.workspaceSettings?.kind = .personal
    let output = ShellSummaries.build([
      machine("env_b", threads: [], projects: [personal, try TestData.project()]),
      machine("env_a", threads: [], projects: [personal]),
    ])
    #expect(output.aide?.ref == ProjectRef(environmentId: "env_a", projectId: "aide"))
    #expect(output.aide?.kind == .personal)
    #expect(output.projects.map(\.ref) == [ProjectRef(environmentId: "env_b", projectId: "proj_1")])
  }

  @Test func activeAideBeatsAnArchivedOneOnALowerEnvironment() throws {
    var personal = try TestData.project(id: "aide", title: "Aide")
    personal.workspaceSettings?.kind = .personal
    var archived = personal
    archived.workspaceSettings?.archived = true
    let output = ShellSummaries.build([
      machine("a", threads: [], projects: [archived]),
      machine("b", threads: [], projects: [personal]),
    ])
    #expect(output.aide?.ref.environmentId == "b")
    #expect(output.aide?.archived == false)

    // With no active one anywhere, the archived Aide is still returned.
    let only = ShellSummaries.build([machine("a", threads: [], projects: [archived])])
    #expect(only.aide?.ref == ProjectRef(environmentId: "a", projectId: "aide"))
    #expect(only.aide?.archived == true)
  }

  @Test func pinnedProjectsComeFirst() throws {
    let projects = try [
      TestData.project(id: "a", title: "Alpha", root: "/w/alpha"),
      TestData.project(id: "b", title: "Beta", root: "/w/beta/"),
      TestData.project(id: "c", title: "Gamma", root: "/w/gamma"),
    ]
    let order = SidebarProjectOrder(pinned: ["env:/w/beta"])
    let output = ShellSummaries.build([machine("env", threads: [], projects: projects, order: order)])
    #expect(output.projects.map(\.title) == ["Beta", "Alpha", "Gamma"])
    #expect(output.projects.map(\.isPinned) == [true, false, false])
  }

  @Test func pinMatchingFollowsTheWebKeys() throws {
    var logical = try TestData.project(id: "l", root: "/w/logical")
    logical.workspaceSettings?.logicalProject = LogicalProject(id: "lp1", title: "Logical", coordinatorId: "c")
    let repo = try TestData.project(id: "r", root: "/w/repo/packages/app", identity: {
      var identity = RepositoryIdentity(canonicalKey: "github.com/example/repo")
      identity.rootPath = "/w/repo"
      return identity
    }())
    let member = try TestData.project(id: "m", root: "/w/member")
    let unpinned = try TestData.project(id: "u", root: "/w/other")
    let orders = [SidebarProjectOrder(
      pinned: ["logical-project:lp1", "github.com/example/repo::packages/app", "group-key"],
      pinnedMembers: ["group-key": ["env:m"]]
    )]
    #expect(ProjectPinning.isPinned(logical, environmentId: "env", orders: orders))
    #expect(ProjectPinning.isPinned(repo, environmentId: "env", orders: orders))
    #expect(ProjectPinning.isPinned(member, environmentId: "env", orders: orders))
    #expect(!ProjectPinning.isPinned(unpinned, environmentId: "env", orders: orders))
    #expect(!ProjectPinning.isPinned(member, environmentId: "env", orders: []))
  }

  @Test func normalizesPaths() {
    #expect(ProjectPinning.normalizePath(" /w/beta/ ") == "/w/beta")
    #expect(ProjectPinning.normalizePath("/") == "/")
    #expect(ProjectPinning.normalizePath("C:/Users/X/") == "c:\\users\\x")
    #expect(ProjectPinning.normalizePath("C:\\") == "c:\\")
  }

  @Test func recentKeepsThirtyWithPinnedFirst() throws {
    var threads = try (0..<35).map { index in
      try TestData.thread(id: "t\(index)", updatedAt: String(format: "2026-10-18T06:%02d:00.000Z", index))
    }
    threads[0].pinnedAt = Date()
    let output = ShellSummaries.build([machine("env", threads: threads, projects: [try TestData.project()])])
    #expect(output.recentThreads.count == 30)
    #expect(output.recentThreads.first?.ref.threadId == "t0")
    #expect(output.recentThreads[1].ref.threadId == "t34")
    #expect(output.recentThreads.last?.ref.threadId == "t6")
  }

  @Test func projectCountsWorkAndUnread() throws {
    var working = try TestData.thread(id: "w")
    working.status = .running
    var waiting = try TestData.thread(id: "q")
    waiting.pendingRuntimeRequest = PendingRuntimeRequestSummary(id: "r", kind: .command, createdAt: Date())
    var unread = try TestData.thread(id: "u")
    unread.latestRunCompletedAt = TestData.date("2026-10-18T06:10:00.000Z")
    unread.lastVisitedAt = TestData.date("2026-10-18T06:00:00.000Z")
    let output = ShellSummaries.build([machine("env", threads: [working, waiting, unread], projects: [try TestData.project()])])
    let project = try #require(output.projects.first)
    #expect(project.workingCount == 2)
    #expect(project.hasUnread)
    #expect(project.machineLabel == "ENV")
  }

  @Test func machinesWithoutAShellContributeNothing() {
    let output = ShellSummaries.build([ShellSummaries.Machine(environmentId: "env", label: "M4", online: false, snapshot: nil)])
    #expect(output.aide == nil)
    #expect(output.projects.isEmpty)
    #expect(output.recentThreads.isEmpty)
  }
}

@Suite struct CoordinatorRoutingTests {
  @Test func usesTheStoredThread() throws {
    let project = try TestData.project()
    #expect(CoordinatorRouting.resolve(project) == .known("project-coordinator:proj_1"))
    var custom = project
    custom.workspaceSettings?.coordinatorThreadId = "thr_coord"
    #expect(CoordinatorRouting.resolve(custom) == .known("thr_coord"))
    #expect(CoordinatorRouting.threadId(for: custom, projectId: "proj_1") == "thr_coord")
  }

  @Test func fallsBackToTheDefaultIdAndAsksForAStart() throws {
    var project = try TestData.project(id: "p9")
    project.workspaceSettings?.coordinatorThreadId = nil
    #expect(CoordinatorRouting.resolve(project) == .needsStart(fallback: "project-coordinator:p9"))
    #expect(CoordinatorRouting.threadId(for: project, projectId: "p9") == "project-coordinator:p9")
    #expect(CoordinatorRouting.threadId(for: nil, projectId: "p7") == "project-coordinator:p7")
  }
}
