package com.specwithcode.sync

import com.specwithcode.wire.RepositoryIdentity
import com.specwithcode.wire.ShellStreamItem
import com.specwithcode.wire.ShellStreamItemSerializer
import com.specwithcode.wire.ThreadLocation
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

// Ports of packages/client-runtime/src/state/shellReducer.test.ts, by way of the iOS tests.

class ShellReducerTest {
    private val root get() = TestData.project().workspaceRoot

    @Test fun updatesThreadInPlaceWithoutMovingSiblings() {
        val threads = listOf("a", "b", "c").map { TestData.thread(id = it) }
        val updated = threads[1].copy(title = "Streaming")
        val next = ShellReducer.apply(ShellStreamItem.ThreadUpdated(1, ThreadLocation.Active, updated), TestData.shell(threads = threads))
        assertEquals(listOf("a", "b", "c"), next.threads.map { it.id })
        assertEquals(threads[0], next.threads[0])
        assertEquals(updated, next.threads[1])
        assertEquals(threads[2], next.threads[2])
    }

    @Test fun keepsThreadListWhenUpdateChangesNothing() {
        val threads = listOf("a", "b").map { TestData.thread(id = it) }
        val next = ShellReducer.apply(ShellStreamItem.ThreadUpdated(1, ThreadLocation.Active, threads[1]), TestData.shell(threads = threads))
        assertEquals(threads, next.threads)
        assertEquals(1, next.snapshotSequence)
    }

    @Test fun ignoresStaleProjectUpdates() {
        val project = TestData.project()
        val snapshot = TestData.shell(sequence = 4, projects = listOf(project))
        for (sequence in listOf(3, 4)) {
            val next = ShellReducer.apply(ShellStreamItem.ProjectUpdated(sequence, project.copy(title = "Stale Title")), snapshot)
            assertEquals(snapshot, next)
            assertEquals(4, next.snapshotSequence)
            assertEquals(project.title, next.projects.first().title)
        }
    }

    @Test fun appliesProjectUpdatesAndRemovals() {
        val updated = ShellReducer.apply(ShellStreamItem.ProjectUpdated(1, TestData.project(title = "Updated")), TestData.shell())
        assertEquals("Updated", updated.projects.first().title)
        assertEquals(1, updated.snapshotSequence)
        val removed = ShellReducer.apply(ShellStreamItem.ProjectRemoved(2, "proj_1"), updated)
        assertTrue(removed.projects.isEmpty())
    }

    @Test fun keepsPriorIdentityWhenDeltaHasNone() {
        val withIdentity = ShellReducer.apply(ShellStreamItem.ProjectUpdated(1, TestData.project(identity = TestData.identity)), TestData.shell())
        assertEquals(TestData.identity, withIdentity.projects.first().repositoryIdentity)
        val withoutIdentity = ShellReducer.apply(ShellStreamItem.ProjectUpdated(2, TestData.project(title = "Still same root")), withIdentity)
        assertEquals("Still same root", withoutIdentity.projects.first().title)
        assertEquals(TestData.identity, withoutIdentity.projects.first().repositoryIdentity)
    }

    @Test fun dropsPriorIdentityAfterWorkspaceRootMove() {
        val withIdentity = ShellReducer.apply(ShellStreamItem.ProjectUpdated(1, TestData.project(identity = TestData.identity)), TestData.shell())
        val moved = ShellReducer.apply(ShellStreamItem.ProjectUpdated(2, TestData.project(root = "/tmp/other-root")), withIdentity)
        assertEquals("/tmp/other-root", moved.projects.first().workspaceRoot)
        assertNull(moved.projects.first().repositoryIdentity)
    }

    @Test fun mergesFullSnapshotKeepingKnownIdentity() {
        val previous = TestData.shell(projects = listOf(TestData.project(identity = TestData.identity)))
        val next = ShellReducer.merge(previous, TestData.shell(sequence = 2, projects = listOf(TestData.project(title = "Refreshed"))))
        assertEquals("Refreshed", next.projects.first().title)
        assertEquals(TestData.identity, next.projects.first().repositoryIdentity)
    }

    @Test fun authoritativeLowerSequenceResetReplacesClientAheadState() {
        val previous = TestData.shell(9, listOf(TestData.thread(title = "Local-only thread")), listOf(TestData.project(title = "Client ahead", identity = TestData.identity)))
        val next = ShellReducer.merge(previous, TestData.shell(3, listOf(TestData.thread(title = "Server thread")), listOf(TestData.project(title = "Server reset"))))
        assertEquals(3, next.snapshotSequence)
        assertEquals("Server reset", next.projects.first().title)
        assertEquals(TestData.identity, next.projects.first().repositoryIdentity)
        assertEquals("Server thread", next.threads.first().title)
    }

    @Test fun clientAheadSurvivesMarkedEnrichmentThenResetsOnAuthoritative() {
        val previous = TestData.shell(20, listOf(TestData.thread(title = "Local-only thread")), listOf(TestData.project(title = "Client ahead", identity = TestData.identity)))
        val server = TestData.shell(3, listOf(TestData.thread(title = "Server thread")), listOf(TestData.project(title = "Server reset")))
        val afterEnrichment = ShellReducer.merge(previous, server, listOf(root))
        assertEquals(20, afterEnrichment.snapshotSequence)
        assertEquals("Client ahead", afterEnrichment.projects.first().title)
        assertNull(afterEnrichment.projects.first().repositoryIdentity)
        assertEquals("Local-only thread", afterEnrichment.threads.first().title)

        val afterAuthoritative = ShellReducer.merge(afterEnrichment, server)
        assertEquals(3, afterAuthoritative.snapshotSequence)
        assertEquals("Server reset", afterAuthoritative.projects.first().title)
        assertNull(afterAuthoritative.projects.first().repositoryIdentity)
        assertEquals("Server thread", afterAuthoritative.threads.first().title)
    }

    @Test fun authoritativeNullRetainsIdentityThenEnrichmentClearsIt() {
        val previous = TestData.shell(9, listOf(TestData.thread(title = "Local-only thread")), listOf(TestData.project(title = "Client ahead", identity = TestData.identity)))
        val server = TestData.shell(3, listOf(TestData.thread(title = "Server thread")), listOf(TestData.project(title = "Server reset")))
        val afterAuthoritative = ShellReducer.merge(previous, server)
        assertEquals(3, afterAuthoritative.snapshotSequence)
        assertEquals("Server reset", afterAuthoritative.projects.first().title)
        assertEquals(TestData.identity, afterAuthoritative.projects.first().repositoryIdentity)
        assertEquals("Server thread", afterAuthoritative.threads.first().title)

        val afterEnrichment = ShellReducer.merge(afterAuthoritative, server, listOf(root))
        assertEquals(3, afterEnrichment.snapshotSequence)
        assertEquals("Server reset", afterEnrichment.projects.first().title)
        assertNull(afterEnrichment.projects.first().repositoryIdentity)
        assertEquals("Server thread", afterEnrichment.threads.first().title)
    }

    @Test fun takesIdentityFromLowerEnrichmentWithoutRevertingThreads() {
        val previous = TestData.shell(5, listOf(TestData.thread(title = "Newest title")), listOf(TestData.project()))
        val next = ShellReducer.merge(previous, TestData.shell(4, listOf(TestData.thread(title = "Stale title")), listOf(TestData.project(identity = TestData.identity))), listOf(root))
        assertEquals(5, next.snapshotSequence)
        assertEquals("Newest title", next.threads.first().title)
        assertEquals(TestData.identity, next.projects.first().repositoryIdentity)
    }

    @Test fun higherSequenceCompactEnrichmentIsMetadataOnly() {
        val previous = TestData.shell(5, listOf(TestData.thread(title = "Newest title")), listOf(TestData.project()))
        val next = ShellReducer.merge(previous, TestData.shell(8, emptyList(), listOf(TestData.project(identity = TestData.identity))), listOf(root))
        assertEquals(5, next.snapshotSequence)
        assertEquals("Newest title", next.threads.first().title)
        assertEquals(TestData.identity, next.projects.first().repositoryIdentity)
    }

    @Test fun lowerEnrichmentCannotResurrectEmptyState() {
        val previous = TestData.shell(7, emptyList(), emptyList())
        val next = ShellReducer.merge(previous, TestData.shell(4, listOf(TestData.thread()), listOf(TestData.project(identity = TestData.identity))), listOf(root))
        assertEquals(7, next.snapshotSequence)
        assertTrue(next.projects.isEmpty())
        assertTrue(next.threads.isEmpty())
    }

    @Test fun resolvedNullClearsIdentityOnlyForMarkedRoot() {
        val other = TestData.project(id = "project-other", root = "/workspace/other", identity = TestData.otherIdentity)
        val previous = TestData.shell(5, projects = listOf(TestData.project(identity = TestData.identity), other))
        val next = ShellReducer.merge(previous, TestData.shell(4, projects = listOf(TestData.project(), other.copy(repositoryIdentity = null))), listOf(root))
        assertEquals(5, next.snapshotSequence)
        assertEquals(2, next.projects.size)
        assertNull(next.projects[0].repositoryIdentity)
        assertEquals(TestData.otherIdentity, next.projects[1].repositoryIdentity)
    }

    @Test fun unrelatedUnresolvedRootsRetainIdentity() {
        val other = TestData.project(id = "project-other", root = "/workspace/other", identity = TestData.otherIdentity)
        val previous = TestData.shell(3, listOf(TestData.thread(title = "Current thread")), listOf(TestData.project(identity = TestData.identity), other))
        val next = ShellReducer.merge(
            previous,
            TestData.shell(3, listOf(TestData.thread(title = "Stale thread")), listOf(TestData.project(identity = TestData.identity), other.copy(repositoryIdentity = null))),
            listOf(root),
        )
        assertEquals("Current thread", next.threads.first().title)
        assertEquals(TestData.identity, next.projects[0].repositoryIdentity)
        assertEquals(TestData.otherIdentity, next.projects[1].repositoryIdentity)
    }

    @Test fun clearsIdentityForSeveralResolvedRoots() {
        val other = TestData.project(id = "project-other", root = "/workspace/other", identity = TestData.otherIdentity)
        val previous = TestData.shell(3, projects = listOf(TestData.project(identity = TestData.identity), other))
        val next = ShellReducer.merge(previous, TestData.shell(3, projects = listOf(TestData.project(), other.copy(repositoryIdentity = null))), listOf(root, other.workspaceRoot))
        assertEquals(listOf<RepositoryIdentity?>(null, null), next.projects.map { it.repositoryIdentity })
    }

    @Test fun keepsLiveIdentityAgainstUnmarkedLowerEnrichment() {
        val live = RepositoryIdentity(canonicalKey = "github.com/example/live")
        val stale = RepositoryIdentity(canonicalKey = "github.com/example/stale")
        val next = ShellReducer.merge(
            TestData.shell(5, projects = listOf(TestData.project(identity = live))),
            TestData.shell(4, projects = listOf(TestData.project(identity = stale))),
            emptyList(),
        )
        assertEquals(5, next.snapshotSequence)
        assertEquals(live, next.projects.first().repositoryIdentity)
    }

    @Test fun keepsArchiveDeltasOutOfTheShell() {
        val thread = TestData.thread()
        val archived = ShellReducer.apply(ShellStreamItem.ThreadUpdated(3, ThreadLocation.Archive, thread.copy(archivedAt = thread.updatedAt)), TestData.shell())
        assertTrue(archived.threads.isEmpty())
        assertTrue(archived.archivedThreads.isEmpty())
        val active = ShellReducer.apply(ShellStreamItem.ThreadUpdated(4, ThreadLocation.Active, TestData.thread()), archived)
        assertEquals(1, active.threads.size)
        assertTrue(active.archivedThreads.isEmpty())
    }

    @Test fun removesThread() {
        val next = ShellReducer.apply(ShellStreamItem.ThreadRemoved(5, ThreadLocation.Active, "thr_1"), TestData.shell())
        assertTrue(next.threads.isEmpty())
        assertEquals(5, next.snapshotSequence)
    }

    @Test fun leavesUnknownEventsUnchanged() {
        val snapshot = TestData.shell()
        val raw = JsonObject(mapOf("kind" to JsonPrimitive("future.event"), "sequence" to JsonPrimitive(99)))
        assertEquals(snapshot, ShellReducer.apply(ShellStreamItem.Unknown("future.event", raw), snapshot))
    }
}

class ShellStateTest {
    @Test fun ignoresDeltasBeforeTheFirstSnapshot() {
        val state = ShellState()
        assertFalse(state.apply(ShellStreamItem.ProjectUpdated(1, TestData.project())))
        assertNull(state.snapshot)
        assertNull(state.resumeSequence)
    }

    @Test fun appliesSnapshotDeltasAndMarker() {
        val state = ShellState()
        assertTrue(state.apply(TestData.decode(ShellStreamItemSerializer, "shellStreamItem.snapshot.json")))
        assertEquals(42, state.resumeSequence)
        assertFalse(state.isSynchronized)

        assertTrue(state.apply(ShellStreamItem.ThreadUpdated(43, ThreadLocation.Active, TestData.thread().copy(title = "Renamed"))))
        assertEquals("Renamed", state.snapshot?.threads?.first()?.title)
        assertEquals(43, state.resumeSequence)

        assertTrue(state.apply(ShellStreamItem.Synchronized))
        assertTrue(state.isSynchronized)
        assertFalse(state.apply(ShellStreamItem.Synchronized))

        state.beginSubscription()
        assertFalse(state.isSynchronized)
        assertEquals(43, state.resumeSequence)
    }

    @Test fun syncDecodesChunkValues() {
        val sync = ShellSync()
        val update = sync.apply(listOf(TestData.json("shellStreamItem.snapshot.json"), JsonObject(mapOf("kind" to JsonPrimitive("synchronized")))))
        assertEquals(42, update?.snapshot?.snapshotSequence)
        assertEquals(true, update?.isSynchronized)
        assertNull(sync.apply(listOf(JsonPrimitive("not an item"))))
        assertEquals(42, sync.resumeSequence)
    }

    @Test fun httpSeedThenResumedStreamAppliesBySequence() {
        val sync = ShellSync()
        sync.beginSubscription()
        val seeded = sync.seed(TestData.shell(sequence = 10))
        assertEquals(10, seeded?.snapshot?.snapshotSequence)
        assertEquals(10, sync.resumeSequence)
        // A stale delta at or below the snapshot sequence is ignored; a newer one applies.
        assertNull(sync.apply(ShellStreamItem.ThreadUpdated(9, ThreadLocation.Active, TestData.thread().copy(title = "Old"))))
        val next = sync.apply(ShellStreamItem.ThreadUpdated(11, ThreadLocation.Active, TestData.thread().copy(title = "New")))
        assertEquals("New", next?.snapshot?.threads?.first()?.title)
        assertEquals(11, sync.resumeSequence)
    }

    @Test fun withoutTheMarkerASnapshotOrAResumeIsLive() {
        val state = ShellState()
        state.beginSubscription(awaitsMarker = false)
        // Nothing held yet: live once the snapshot lands.
        assertFalse(state.isSynchronized)
        assertTrue(state.apply(TestData.decode(ShellStreamItemSerializer, "shellStreamItem.snapshot.json")))
        assertTrue(state.isSynchronized)
        // A resumed subscription has no marker to wait for.
        state.beginSubscription(awaitsMarker = false)
        assertTrue(state.isSynchronized)
        state.beginSubscription(awaitsMarker = true)
        assertFalse(state.isSynchronized)
    }

    @Test fun anUnreadableKnownItemDropsTheCursor() {
        val sync = ShellSync()
        sync.seed(TestData.shell(sequence = 10))
        assertEquals(10, sync.resumeSequence)
        // An unknown kind is skipped and keeps the cursor.
        assertNull(sync.apply(listOf(JsonObject(mapOf("kind" to JsonPrimitive("future.kind"), "sequence" to JsonPrimitive(11))))))
        assertEquals(10, sync.resumeSequence)
        // A known kind that does not decode loses a change: resubscribe from a fresh snapshot.
        val broken = JsonObject(mapOf("kind" to JsonPrimitive("thread.updated"), "sequence" to JsonPrimitive(12), "thread" to JsonPrimitive("bad")))
        assertFailsWith<StreamDivergedException> { sync.apply(listOf(broken)) }
        assertNull(sync.resumeSequence)
        sync.seed(TestData.shell(sequence = 20))
        assertEquals(20, sync.resumeSequence)
    }
}
