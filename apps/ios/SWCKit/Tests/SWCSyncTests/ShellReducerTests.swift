import Foundation
import Testing
import SWCWire
@testable import SWCSync

// Ports of packages/client-runtime/src/state/shellReducer.test.ts.

@Suite struct ShellReducerTests {
  @Test func updatesThreadInPlaceWithoutMovingSiblings() throws {
    let threads = try ["a", "b", "c"].map { try TestData.thread(id: $0) }
    var updated = threads[1]
    updated.title = "Streaming"
    let next = ShellReducer.apply(.threadUpdated(sequence: 1, location: .active, thread: updated), to: try TestData.shell(threads: threads))
    #expect(next.threads.map(\.id) == ["a", "b", "c"])
    #expect(next.threads[0] == threads[0])
    #expect(next.threads[1] == updated)
    #expect(next.threads[2] == threads[2])
  }

  @Test func keepsThreadListWhenUpdateChangesNothing() throws {
    let threads = try ["a", "b"].map { try TestData.thread(id: $0) }
    let next = ShellReducer.apply(.threadUpdated(sequence: 1, location: .active, thread: threads[1]), to: try TestData.shell(threads: threads))
    #expect(next.threads == threads)
    #expect(next.snapshotSequence == 1)
  }

  @Test func ignoresStaleProjectUpdates() throws {
    let project = try TestData.project()
    let snapshot = try TestData.shell(sequence: 4, projects: [project])
    for sequence in [3, 4] {
      var stale = project
      stale.title = "Stale Title"
      let next = ShellReducer.apply(.projectUpdated(sequence: sequence, project: stale), to: snapshot)
      #expect(next == snapshot)
      #expect(next.snapshotSequence == 4)
      #expect(next.projects.first?.title == project.title)
    }
  }

  @Test func appliesProjectUpdatesAndRemovals() throws {
    let updated = ShellReducer.apply(.projectUpdated(sequence: 1, project: try TestData.project(title: "Updated")), to: try TestData.shell())
    #expect(updated.projects.first?.title == "Updated")
    #expect(updated.snapshotSequence == 1)

    let removed = ShellReducer.apply(.projectRemoved(sequence: 2, projectId: "proj_1"), to: updated)
    #expect(removed.projects.isEmpty)
  }

  @Test func keepsPriorIdentityWhenDeltaHasNone() throws {
    let withIdentity = ShellReducer.apply(.projectUpdated(sequence: 1, project: try TestData.project(identity: TestData.identity)), to: try TestData.shell())
    #expect(withIdentity.projects.first?.repositoryIdentity == TestData.identity)

    let withoutIdentity = ShellReducer.apply(.projectUpdated(sequence: 2, project: try TestData.project(title: "Still same root")), to: withIdentity)
    #expect(withoutIdentity.projects.first?.title == "Still same root")
    #expect(withoutIdentity.projects.first?.repositoryIdentity == TestData.identity)
  }

  @Test func dropsPriorIdentityAfterWorkspaceRootMove() throws {
    let withIdentity = ShellReducer.apply(.projectUpdated(sequence: 1, project: try TestData.project(identity: TestData.identity)), to: try TestData.shell())
    let moved = ShellReducer.apply(.projectUpdated(sequence: 2, project: try TestData.project(root: "/tmp/other-root")), to: withIdentity)
    #expect(moved.projects.first?.workspaceRoot == "/tmp/other-root")
    #expect(moved.projects.first?.repositoryIdentity == nil)
  }

  @Test func mergesFullSnapshotKeepingKnownIdentity() throws {
    let previous = try TestData.shell(projects: [TestData.project(identity: TestData.identity)])
    let next = ShellReducer.merge(previous, try TestData.shell(sequence: 2, projects: [TestData.project(title: "Refreshed")]))
    #expect(next.projects.first?.title == "Refreshed")
    #expect(next.projects.first?.repositoryIdentity == TestData.identity)
  }

  @Test func authoritativeLowerSequenceResetReplacesClientAheadState() throws {
    let previous = try TestData.shell(sequence: 9, threads: [TestData.thread(title: "Local-only thread")], projects: [TestData.project(title: "Client ahead", identity: TestData.identity)])
    let next = ShellReducer.merge(previous, try TestData.shell(sequence: 3, threads: [TestData.thread(title: "Server thread")], projects: [TestData.project(title: "Server reset")]))
    #expect(next.snapshotSequence == 3)
    #expect(next.projects.first?.title == "Server reset")
    #expect(next.projects.first?.repositoryIdentity == TestData.identity)
    #expect(next.threads.first?.title == "Server thread")
  }

  @Test func clientAheadSurvivesMarkedEnrichmentThenResetsOnAuthoritative() throws {
    let previous = try TestData.shell(sequence: 20, threads: [TestData.thread(title: "Local-only thread")], projects: [TestData.project(title: "Client ahead", identity: TestData.identity)])
    let server = try TestData.shell(sequence: 3, threads: [TestData.thread(title: "Server thread")], projects: [TestData.project(title: "Server reset")])
    let root = try TestData.project().workspaceRoot

    let afterEnrichment = ShellReducer.merge(previous, server, resolvedRepositoryIdentityRoots: [root])
    #expect(afterEnrichment.snapshotSequence == 20)
    #expect(afterEnrichment.projects.first?.title == "Client ahead")
    #expect(afterEnrichment.projects.first?.repositoryIdentity == nil)
    #expect(afterEnrichment.threads.first?.title == "Local-only thread")

    let afterAuthoritative = ShellReducer.merge(afterEnrichment, server)
    #expect(afterAuthoritative.snapshotSequence == 3)
    #expect(afterAuthoritative.projects.first?.title == "Server reset")
    #expect(afterAuthoritative.projects.first?.repositoryIdentity == nil)
    #expect(afterAuthoritative.threads.first?.title == "Server thread")
  }

  @Test func authoritativeNullRetainsIdentityThenEnrichmentClearsIt() throws {
    let previous = try TestData.shell(sequence: 9, threads: [TestData.thread(title: "Local-only thread")], projects: [TestData.project(title: "Client ahead", identity: TestData.identity)])
    let server = try TestData.shell(sequence: 3, threads: [TestData.thread(title: "Server thread")], projects: [TestData.project(title: "Server reset")])
    let root = try TestData.project().workspaceRoot

    let afterAuthoritative = ShellReducer.merge(previous, server)
    #expect(afterAuthoritative.snapshotSequence == 3)
    #expect(afterAuthoritative.projects.first?.title == "Server reset")
    #expect(afterAuthoritative.projects.first?.repositoryIdentity == TestData.identity)
    #expect(afterAuthoritative.threads.first?.title == "Server thread")

    let afterEnrichment = ShellReducer.merge(afterAuthoritative, server, resolvedRepositoryIdentityRoots: [root])
    #expect(afterEnrichment.snapshotSequence == 3)
    #expect(afterEnrichment.projects.first?.title == "Server reset")
    #expect(afterEnrichment.projects.first?.repositoryIdentity == nil)
    #expect(afterEnrichment.threads.first?.title == "Server thread")
  }

  @Test func takesIdentityFromLowerEnrichmentWithoutRevertingThreads() throws {
    let previous = try TestData.shell(sequence: 5, threads: [TestData.thread(title: "Newest title")], projects: [TestData.project()])
    let next = ShellReducer.merge(
      previous,
      try TestData.shell(sequence: 4, threads: [TestData.thread(title: "Stale title")], projects: [TestData.project(identity: TestData.identity)]),
      resolvedRepositoryIdentityRoots: [try TestData.project().workspaceRoot]
    )
    #expect(next.snapshotSequence == 5)
    #expect(next.threads.first?.title == "Newest title")
    #expect(next.projects.first?.repositoryIdentity == TestData.identity)
  }

  @Test func higherSequenceCompactEnrichmentIsMetadataOnly() throws {
    let previous = try TestData.shell(sequence: 5, threads: [TestData.thread(title: "Newest title")], projects: [TestData.project()])
    let next = ShellReducer.merge(
      previous,
      try TestData.shell(sequence: 8, threads: [], projects: [TestData.project(identity: TestData.identity)]),
      resolvedRepositoryIdentityRoots: [try TestData.project().workspaceRoot]
    )
    #expect(next.snapshotSequence == 5)
    #expect(next.threads.first?.title == "Newest title")
    #expect(next.projects.first?.repositoryIdentity == TestData.identity)
  }

  @Test func lowerEnrichmentCannotResurrectEmptyState() throws {
    let previous = try TestData.shell(sequence: 7, threads: [], projects: [])
    let next = ShellReducer.merge(
      previous,
      try TestData.shell(sequence: 4, threads: [TestData.thread()], projects: [TestData.project(identity: TestData.identity)]),
      resolvedRepositoryIdentityRoots: [try TestData.project().workspaceRoot]
    )
    #expect(next.snapshotSequence == 7)
    #expect(next.projects.isEmpty)
    #expect(next.threads.isEmpty)
  }

  @Test func resolvedNullClearsIdentityOnlyForMarkedRoot() throws {
    let other = try TestData.project(id: "project-other", root: "/workspace/other", identity: TestData.otherIdentity)
    let previous = try TestData.shell(sequence: 5, projects: [TestData.project(identity: TestData.identity), other])
    var otherCleared = other
    otherCleared.repositoryIdentity = nil
    let next = ShellReducer.merge(
      previous,
      try TestData.shell(sequence: 4, projects: [TestData.project(), otherCleared]),
      resolvedRepositoryIdentityRoots: [try TestData.project().workspaceRoot]
    )
    #expect(next.snapshotSequence == 5)
    #expect(next.projects.count == 2)
    #expect(next.projects[0].repositoryIdentity == nil)
    #expect(next.projects[1].repositoryIdentity == TestData.otherIdentity)
  }

  @Test func unrelatedUnresolvedRootsRetainIdentity() throws {
    let other = try TestData.project(id: "project-other", root: "/workspace/other", identity: TestData.otherIdentity)
    let previous = try TestData.shell(sequence: 3, threads: [TestData.thread(title: "Current thread")], projects: [TestData.project(identity: TestData.identity), other])
    var otherCleared = other
    otherCleared.repositoryIdentity = nil
    let next = ShellReducer.merge(
      previous,
      try TestData.shell(sequence: 3, threads: [TestData.thread(title: "Stale thread")], projects: [TestData.project(identity: TestData.identity), otherCleared]),
      resolvedRepositoryIdentityRoots: [try TestData.project().workspaceRoot]
    )
    #expect(next.threads.first?.title == "Current thread")
    #expect(next.projects[0].repositoryIdentity == TestData.identity)
    #expect(next.projects[1].repositoryIdentity == TestData.otherIdentity)
  }

  @Test func clearsIdentityForSeveralResolvedRoots() throws {
    let other = try TestData.project(id: "project-other", root: "/workspace/other", identity: TestData.otherIdentity)
    let previous = try TestData.shell(sequence: 3, projects: [TestData.project(identity: TestData.identity), other])
    var otherCleared = other
    otherCleared.repositoryIdentity = nil
    let next = ShellReducer.merge(
      previous,
      try TestData.shell(sequence: 3, projects: [TestData.project(), otherCleared]),
      resolvedRepositoryIdentityRoots: [try TestData.project().workspaceRoot, other.workspaceRoot]
    )
    #expect(next.projects.map(\.repositoryIdentity) == [nil, nil])
  }

  @Test func keepsLiveIdentityAgainstUnmarkedLowerEnrichment() throws {
    let live = RepositoryIdentity(canonicalKey: "github.com/example/live")
    let stale = RepositoryIdentity(canonicalKey: "github.com/example/stale")
    let next = ShellReducer.merge(
      try TestData.shell(sequence: 5, projects: [TestData.project(identity: live)]),
      try TestData.shell(sequence: 4, projects: [TestData.project(identity: stale)]),
      resolvedRepositoryIdentityRoots: []
    )
    #expect(next.snapshotSequence == 5)
    #expect(next.projects.first?.repositoryIdentity == live)
  }

  @Test func keepsArchiveDeltasOutOfTheShell() throws {
    var archivedThread = try TestData.thread()
    archivedThread.archivedAt = archivedThread.updatedAt
    let archived = ShellReducer.apply(.threadUpdated(sequence: 3, location: .archive, thread: archivedThread), to: try TestData.shell())
    #expect(archived.threads.isEmpty)
    #expect(archived.archivedThreads.isEmpty)

    let active = ShellReducer.apply(.threadUpdated(sequence: 4, location: .active, thread: try TestData.thread()), to: archived)
    #expect(active.threads.count == 1)
    #expect(active.archivedThreads.isEmpty)
  }

  @Test func removesThread() throws {
    let next = ShellReducer.apply(.threadRemoved(sequence: 5, location: .active, threadId: "thr_1"), to: try TestData.shell())
    #expect(next.threads.isEmpty)
    #expect(next.snapshotSequence == 5)
  }

  @Test func leavesUnknownEventsUnchanged() throws {
    let snapshot = try TestData.shell()
    let next = ShellReducer.apply(.unknown(kind: "future.event", raw: .object(["kind": .string("future.event"), "sequence": .number(99)])), to: snapshot)
    #expect(next == snapshot)
  }
}

@Suite struct ShellStateTests {
  @Test func ignoresDeltasBeforeTheFirstSnapshot() throws {
    var state = ShellState()
    let changed1 = state.apply(.projectUpdated(sequence: 1, project: try TestData.project()))
    #expect(!changed1)
    #expect(state.snapshot == nil)
    #expect(state.resumeSequence == nil)
  }

  @Test func appliesSnapshotDeltasAndMarker() throws {
    var state = ShellState()
    let item = try TestData.decode(ShellStreamItem.self, FixtureJSON.shellSnapshot)
    let changed2 = state.apply(item)
    #expect(changed2)
    #expect(state.resumeSequence == 42)
    #expect(!state.isSynchronized)

    var thread = try TestData.thread()
    thread.title = "Renamed"
    let changed3 = state.apply(.threadUpdated(sequence: 43, location: .active, thread: thread))
    #expect(changed3)
    #expect(state.snapshot?.threads.first?.title == "Renamed")
    #expect(state.resumeSequence == 43)

    let changed4 = state.apply(.synchronized)

    #expect(changed4)
    #expect(state.isSynchronized)
    let changed5 = state.apply(.synchronized)
    #expect(!changed5)

    state.beginSubscription()
    #expect(!state.isSynchronized)
    #expect(state.resumeSequence == 43)
  }

  @Test func syncActorDecodesChunkValues() async throws {
    let sync = ShellSync()
    let value = try TestData.decode(JSONValue.self, FixtureJSON.shellSnapshot)
    let update = await sync.apply([value, .object(["kind": .string("synchronized")])])
    #expect(update?.snapshot?.snapshotSequence == 42)
    #expect(update?.isSynchronized == true)
    #expect(await sync.apply([.string("not an item")]) == nil)
    #expect(await sync.resumeSequence == 42)
  }
}
