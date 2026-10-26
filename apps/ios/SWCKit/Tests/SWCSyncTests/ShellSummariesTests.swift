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

  @Test func checkProjectsAreAutomatedAndUserProjectsAreNot() throws {
    let user = try TestData.project(id: "user", title: "EasyChamp", root: "/Users/x/Projects/sw-easychamp")
    let check = try TestData.project(id: "check", title: "Run shell acceptance 357", root: "/Users/x/.specwithcode/m4/scratch/run-shell/workspace")
    let proof = try TestData.project(id: "proof", title: "EasyChamp", root: "/Users/x/.local/share/specweave/fleet/handoff-proof/sw-easychamp")
    var kept = try TestData.project(id: "kept", title: "Fixture lab", root: "/Users/x/Projects/fixture-lab")
    kept.workspaceSettings?.origin = .user
    var flagged = try TestData.project(id: "flagged", title: "Flagged", root: "/Users/x/Projects/flagged")
    flagged.workspaceSettings?.origin = .automated
    let named = try TestData.project(id: "named", title: "Scratch notes", root: "/Users/x/.specwithcode/m4/projects/scratch-notes")
    let output = ShellSummaries.build([machine("env", threads: [], projects: [user, check, proof, kept, flagged, named])])
    let automated = Set(output.projects.filter(\.isAutomated).map(\.ref.projectId))
    #expect(automated == ["check", "proof", "flagged"])
  }

  @Test func archiveStateUsesEveryRealMemberIncludingCachedCopies() throws {
    let logical = LogicalProject(id: "logical:archive", title: "Linked", coordinatorId: "coordinator:archive", members: [])
    var first = try TestData.project(id: "first", title: "Linked", root: "/work/first")
    first.workspaceSettings?.logicalProject = logical
    first.workspaceSettings?.archived = true
    var second = try TestData.project(id: "second", title: "Linked", root: "/work/second")
    second.workspaceSettings?.logicalProject = logical
    var cached = machine("b", threads: [], projects: [second])
    cached.online = false
    let mixed = ShellSummaries.build([machine("a", threads: [], projects: [first]), cached])
    #expect(mixed.projects.count == 1)
    #expect(mixed.projects[0].archived == false)
    #expect(mixed.projects[0].members.count == 2)
    second.workspaceSettings?.archived = true
    cached.snapshot = ShellSnapshot(projects: [second])
    let archived = ShellSummaries.build([cached, machine("a", threads: [], projects: [first])])
    #expect(archived.projects.count == 1)
    #expect(archived.projects[0].archived)
  }

  @Test func linkedProjectIsAutomatedOnlyWhenEveryCopyIs() throws {
    let logical = LogicalProject(id: "logical:1", title: "EasyChamp", coordinatorId: "coordinator:logical:1", members: [])
    var mine = try TestData.project(id: "mine", title: "EasyChamp", root: "/Users/x/Projects/sw-easychamp")
    mine.workspaceSettings?.logicalProject = logical
    var copy = try TestData.project(id: "copy", title: "EasyChamp", root: "/Users/x/Projects/scratch/sw-easychamp")
    copy.workspaceSettings?.logicalProject = logical
    let output = ShellSummaries.build([
      machine("a", threads: [], projects: [mine]),
      machine("b", threads: [], projects: [copy]),
    ])
    #expect(output.projects.count == 1)
    #expect(output.projects.first?.isAutomated == false)
  }

  @Test func sharedRemoteWithDifferentRootsStaySeparate() throws {
    // Canonical workspace policy: never merge distinct checkouts solely because remotes match.
    // Two independent roots/worktrees with the same GitHub remote must remain separate projects
    // and not aggregate unrelated threads.
    let repo = RepositoryIdentity(canonicalKey: "github.com/anton-abyzov/sw-easychamp")
    func easychamp(_ id: String, _ root: String) throws -> ProjectShell {
      try TestData.project(id: id, title: "EasyChamp", root: root, identity: repo)
    }
    let m1 = try [
      easychamp("m1-main", "/Users/anton/Projects/sw-easychamp"),
      easychamp("m1-main-dup", "/Users/anton/Projects/sw-easychamp/"),
      easychamp("m1-worktree", "/Users/anton/Projects/sw-easychamp-worktree"),
      easychamp("m1-copy", "/Users/anton/work/sw-easychamp"),
    ]
    let m4 = try [
      easychamp("m4-main", "/Users/you/Projects/sw-easychamp"),
    ]
    let output = ShellSummaries.build([
      machine("m1", threads: [
        try TestData.thread(id: "t-main", projectId: "m1-main", updatedAt: "2026-10-21T10:00:00.000Z"),
        try TestData.thread(id: "t-worktree", projectId: "m1-worktree", updatedAt: "2026-10-21T11:00:00.000Z"),
      ], projects: m1),
      machine("m4", threads: [
        try TestData.thread(id: "t-m4", projectId: "m4-main", updatedAt: "2026-10-21T12:00:00.000Z"),
      ], projects: m4),
    ])

    // m1-main and m1-main-dup merge (exact same folder on same machine)
    // m1-worktree stays separate (distinct root)
    // m1-copy stays separate (distinct root)
    // m4-main stays separate (distinct machine, unlinked)
    #expect(output.projects.count == 4)

    let mainProject = try #require(output.projects.first { $0.ref.projectId == "m1-main" })
    #expect(mainProject.members.map(\.ref.projectId).sorted() == ["m1-main", "m1-main-dup"])
    #expect(output.threadsByProject[mainProject.ref]?.map(\.ref.threadId) == ["t-main"])

    let worktreeProject = try #require(output.projects.first { $0.ref.projectId == "m1-worktree" })
    #expect(output.threadsByProject[worktreeProject.ref]?.map(\.ref.threadId) == ["t-worktree"])

    let m4Project = try #require(output.projects.first { $0.ref.projectId == "m4-main" })
    #expect(output.threadsByProject[m4Project.ref]?.map(\.ref.threadId) == ["t-m4"])
  }

  @Test func duplicatesFixtureListsEachProjectOnce() {
    let titles = FixtureDuplicates.output(now: Date()).projects.map(\.title)
    #expect(titles.sorted() == ["Active check", "Archived check", "EasyChamp", "Notes", "SpecWeave"])
    let projects = FixtureDuplicates.output(now: Date()).projects
    #expect(projects.filter { $0.isAutomated && !$0.archived }.map(\.title) == ["Active check"])
    #expect(projects.filter(\.archived).map(\.title) == ["Archived check"])
  }

  @Test func sameFolderTwiceOnOneMachineIsOneRow() throws {
    let repo = RepositoryIdentity(canonicalKey: "github.com/example/notes")
    let a = try TestData.project(id: "a", title: "Notes", root: "/Users/x/notes", identity: repo)
    let b = try TestData.project(id: "b", title: "notes", root: "/Users/x/notes/", identity: repo)
    let other = try TestData.project(id: "c", title: "Notes", root: "/Users/x/other-notes", identity: repo)
    let output = ShellSummaries.build([machine("env", threads: [], projects: [a, b, other])])
    // Duplicate normalized folder merges, while distinct root stays separate even with same repository.
    #expect(output.projects.count == 2)
  }

  @Test func differentFoldersOfOneRepositoryStaySeparate() throws {
    var repo = RepositoryIdentity(canonicalKey: "github.com/x/mono")
    repo.rootPath = "/Users/x/mono"
    let web = try TestData.project(id: "web", title: "Web", root: "/Users/x/mono/apps/web", identity: repo)
    let api = try TestData.project(id: "api", title: "API", root: "/Users/x/mono/apps/api", identity: repo)
    let output = ShellSummaries.build([machine("env", threads: [], projects: [web, api])])
    #expect(output.projects.count == 2)
  }

  @Test func linkedCopyStaysLinkedBesideAnUnlinkedCopy() throws {
    let repo = RepositoryIdentity(canonicalKey: "github.com/x/app")
    let logical = LogicalProject(id: "logical:app", title: "App", coordinatorId: "coordinator:logical:app")
    var a = try TestData.project(id: "a", title: "App", root: "/Users/x/app", identity: repo)
    a.workspaceSettings?.logicalProject = logical
    var b = try TestData.project(id: "b", title: "App", root: "/Users/y/app", identity: repo)
    b.workspaceSettings?.logicalProject = logical
    let stray = try TestData.project(id: "stray", title: "App", root: "/Users/z/app", identity: repo)
    let output = ShellSummaries.build([
      machine("e1", threads: [], projects: [a]),
      machine("e2", threads: [], projects: [b]),
      machine("e3", threads: [], projects: [stray]),
    ])
    // a and b merge through explicit logicalProject; stray is unlinked with a distinct root so stays separate.
    #expect(output.projects.count == 2)
    let linkedProject = try #require(output.projects.first { $0.title == "App" && $0.members.count == 2 })
    let linked = Set(linkedProject.members.filter(\.isLinked).map(\.ref.environmentId))
    #expect(linked == ["e1", "e2"])
    let strayProject = try #require(output.projects.first { $0.ref.projectId == "stray" })
    #expect(strayProject.ref.environmentId == "e3")
  }

  @Test func rowLeadsWithALinkedCopyOverANewerUnlinkedOne() throws {
    let logical = LogicalProject(id: "logical:app", title: "App", coordinatorId: "coordinator:logical:app")
    var a = try TestData.project(id: "a", title: "App", root: "/Users/x/app")
    a.workspaceSettings?.logicalProject = logical
    var b = try TestData.project(id: "b", title: "App", root: "/Users/y/app")
    b.workspaceSettings?.logicalProject = logical
    let stray = try TestData.project(id: "stray", title: "App", root: "/Users/x/app/")
    let output = ShellSummaries.build([
      machine("e1", threads: [
        try TestData.thread(id: "t-a", projectId: "a", updatedAt: "2026-10-21T10:00:00.000Z"),
        try TestData.thread(id: "t-stray", projectId: "stray", updatedAt: "2026-10-21T12:00:00.000Z"),
      ], projects: [a, stray]),
      machine("e2", threads: [
        try TestData.thread(id: "t-b", projectId: "b", updatedAt: "2026-10-21T11:00:00.000Z"),
      ], projects: [b]),
    ])
    #expect(output.projects.count == 1)
    let row = try #require(output.projects.first)
    #expect(row.ref == ProjectRef(environmentId: "e2", projectId: "b"))
    #expect(row.members.count == 3)
    #expect(output.threadsByProject[row.ref]?.count == 3)
  }

  @Test func offlineLinkedCopyStillLeadsOverAnUnlinkedOne() throws {
    let logical = LogicalProject(id: "logical:app", title: "App", coordinatorId: "coordinator:logical:app")
    let stray = try TestData.project(id: "stray", title: "App", root: "/Users/x/app/")
    var a = try TestData.project(id: "a", title: "App", root: "/Users/x/app")
    a.workspaceSettings?.logicalProject = logical
    var b = try TestData.project(id: "b", title: "App", root: "/Users/y/app")
    b.workspaceSettings?.logicalProject = logical
    var e1 = machine("e1", threads: [], projects: [stray, a])
    e1.online = false
    var e2 = machine("e2", threads: [], projects: [b])
    e2.online = false
    let output = ShellSummaries.build([e1, e2])
    #expect(output.projects.count == 1)
    #expect(output.projects.first?.ref.projectId != "stray")
  }

  @Test func duplicatesFixtureMergesThreadsOfBothCopies() throws {
    let output = FixtureDuplicates.output(now: Date())
    let notes = try #require(output.projects.first { $0.title == "Notes" })
    #expect(output.threadsByProject[notes.ref]?.map(\.ref.threadId) == ["t-signup"])
  }

  @Test func checkCopiesOfARepositoryStayUnderAutomated() throws {
    let repo = RepositoryIdentity(canonicalKey: "github.com/x/app")
    let mine = try TestData.project(id: "mine", title: "App", root: "/Users/x/Projects/app", identity: repo)
    let proof = try TestData.project(id: "proof", title: "App", root: "/Users/x/.local/share/specweave/fleet/handoff-proof/app", identity: repo)
    let output = ShellSummaries.build([machine("env", threads: [], projects: [mine, proof])])
    #expect(output.projects.map(\.isAutomated).sorted { !$0 && $1 } == [false, true])
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

  @Test func recentKeepsThirtyByStableActivityRatherThanPinnedOrStreamTime() throws {
    var threads = try (0..<35).map { index in
      try TestData.thread(id: "t\(index)", updatedAt: String(format: "2026-10-18T06:%02d:00.000Z", index))
    }
    for index in threads.indices {
      threads[index].latestUserMessageAt = threads[index].updatedAt
    }
    threads[0].pinnedAt = Date()
    let output = ShellSummaries.build([machine("env", threads: threads, projects: [try TestData.project()])])
    #expect(output.recentThreads.count == 30)
    #expect(output.recentThreads.first?.ref.threadId == "t34")
    #expect(output.recentThreads[1].ref.threadId == "t33")
    #expect(output.recentThreads.last?.ref.threadId == "t5")
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
