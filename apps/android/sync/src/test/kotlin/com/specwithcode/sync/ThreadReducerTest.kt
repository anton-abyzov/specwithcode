package com.specwithcode.sync

import com.specwithcode.wire.DomainEvent
import com.specwithcode.wire.RunStatus
import com.specwithcode.wire.ThreadStreamItem
import com.specwithcode.wire.TurnItemStatus
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ThreadReducerTest {
    @Test fun snapshotReplacesState() {
        val state = TestData.threadState()
        assertEquals(99, state.sequence)
        assertEquals(99, state.resumeSequence)
        assertFalse(state.partialTimeline)
        assertEquals("thr_1", state.projection?.thread?.id)
        assertEquals(listOf("ti_1"), state.projection?.visibleTurnItems?.map { it.sourceItemId })
    }

    @Test fun eventsFromTheFixtureApplyInOrder() {
        val state = TestData.threadState()
        TestData.threadEvents().forEach { state.apply(it) }
        val projection = assertNotNull(state.projection)
        assertEquals(209, state.sequence)
        assertTrue(state.isSynchronized)
        assertTrue(projection.thread.isPinned)
        assertEquals(RunStatus.Running, projection.runs.first { it.id == "run_2" }.status)
        assertTrue("msg_4" in projection.messages.map { it.id })
        assertTrue("plan_p" in projection.plans.map { it.id })
        assertEquals(listOf("req_1", "req_2"), projection.runtimeRequests.map { it.id })
        assertEquals(false, projection.runtimeRequest("req_2")?.isPending)
        // The streamed assistant message lands after the command (ordinal 1 after 0).
        assertEquals(listOf("ti_1", "ti_asst"), projection.visibleTurnItems.map { it.sourceItemId })
        assertEquals(listOf(0, 1), projection.visibleTurnItems.map { it.position })
    }

    @Test fun newItemIsOrderedByOrdinal() {
        val state = TestData.threadState()
        var (sequence, event) = TestData.event(5)
        var early = TestData.turnItem("ti_user").copy(threadId = "thr_1", runId = "run_1", ordinal = -1)
        assertTrue(state.apply(ThreadStreamItem.Event(sequence, event.copy(payload = DomainEvent.Payload.TurnItemPayload(early)))))
        assertEquals(listOf("ti_user", "ti_1"), state.projection?.visibleTurnItems?.map { it.sourceItemId })

        // Updating an existing item keeps one row.
        early = early.copy(status = TurnItemStatus.Failed)
        sequence += 1
        assertTrue(state.apply(ThreadStreamItem.Event(sequence, event.copy(payload = DomainEvent.Payload.TurnItemPayload(early)))))
        assertEquals(2, state.projection?.visibleTurnItems?.size)
        assertEquals(TurnItemStatus.Failed, state.projection?.visibleTurnItems?.first()?.item?.status)
        assertEquals(2, state.projection?.turnItems?.size)
    }

    @Test fun rolledBackRunHidesItsItems() {
        val state = TestData.threadState()
        val (sequence, event) = TestData.event(3)
        val run = assertNotNull(state.projection?.runs?.first { it.id == "run_1" }).copy(status = RunStatus.RolledBack)
        assertTrue(state.apply(ThreadStreamItem.Event(sequence, event.copy(payload = DomainEvent.Payload.RunPayload(run)))))
        assertEquals(true, state.projection?.visibleTurnItems?.isEmpty())
        assertEquals(1, state.projection?.turnItems?.size)
    }

    @Test fun oldSequencesAreIgnored() {
        val state = TestData.threadState()
        val (_, event) = TestData.event(0)
        assertFalse(state.apply(ThreadStreamItem.Event(99, event)))
        assertFalse(state.apply(ThreadStreamItem.Event(50, event)))
        assertEquals(false, state.projection?.thread?.isPinned)
        assertTrue(state.apply(ThreadStreamItem.Event(100, event)))
        assertEquals(true, state.projection?.thread?.isPinned)
    }

    @Test fun eventsBeforeTheSnapshotAreIgnored() {
        val state = ThreadState()
        val (sequence, event) = TestData.event(0)
        assertFalse(state.apply(ThreadStreamItem.Event(sequence, event)))
        assertNull(state.projection)
        assertNull(state.resumeSequence)
    }

    @Test fun otherThreadsEventsAreIgnored() {
        val state = TestData.threadState()
        val (sequence, event) = TestData.event(4)
        assertFalse(state.apply(ThreadStreamItem.Event(sequence, event.copy(threadId = "thr_other"))))
        assertEquals(1, state.projection?.messages?.size)
        assertEquals(sequence, state.sequence)
    }

    @Test fun visitDoesNotBumpUpdatedAt() {
        val state = TestData.threadState()
        val before = assertNotNull(state.projection?.updatedAt)
        val (sequence, event) = TestData.event(0)
        assertTrue(state.apply(ThreadStreamItem.Event(sequence, event.copy(type = "thread.visited"))))
        assertEquals(before, state.projection?.updatedAt)
        val pinned = event.copy(type = "thread.pinned")
        assertTrue(state.apply(ThreadStreamItem.Event(sequence + 1, pinned)))
        assertEquals(pinned.occurredAt, state.projection?.updatedAt)
    }

    @Test fun unknownEventAdvancesTheSequence() {
        val state = TestData.threadState()
        val (sequence, event) = TestData.event(9)
        assertTrue(event.isUnknown)
        assertTrue(state.apply(ThreadStreamItem.Event(sequence, event)))
        assertEquals(sequence, state.sequence)
        assertEquals(event.occurredAt, state.projection?.updatedAt)
    }

    @Test fun boundedSnapshotDropsItemsOlderThanItsWindow() {
        val snapshot = (TestData.threadSnapshot() as ThreadStreamItem.Snapshot).snapshot
        val state = ThreadState()
        state.apply(ThreadStreamItem.Snapshot(snapshot.copy(hasMoreHistory = true, latestLocalTurnOrdinal = 0)))
        assertTrue(state.partialTimeline)

        val (sequence, event) = TestData.event(5)
        val old = TestData.turnItem("ti_reason").copy(threadId = "thr_1", runId = "run_1", ordinal = -5)
        assertFalse(state.apply(ThreadStreamItem.Event(sequence, event.copy(payload = DomainEvent.Payload.TurnItemPayload(old)))))
        assertEquals(1, state.projection?.turnItems?.size)

        val fresh = old.copy(id = "ti_new", ordinal = 7)
        assertTrue(state.apply(ThreadStreamItem.Event(sequence + 1, event.copy(payload = DomainEvent.Payload.TurnItemPayload(fresh)))))
        assertEquals(listOf("ti_1", "ti_new"), state.projection?.visibleTurnItems?.map { it.sourceItemId })
    }

    @Test fun completeBoundedSnapshotAppliesItemsBelowItsWatermark() {
        val snapshot = (TestData.threadSnapshot() as ThreadStreamItem.Snapshot).snapshot
        val state = ThreadState()
        state.apply(ThreadStreamItem.Snapshot(snapshot.copy(hasMoreHistory = false, historyCursor = null, latestLocalTurnOrdinal = 10)))
        assertFalse(state.partialTimeline)

        var (sequence, event) = TestData.event(5)
        val late = TestData.turnItem("ti_reason").copy(id = "ti_late", threadId = "thr_1", runId = "run_1", ordinal = 3)
        assertTrue(state.apply(ThreadStreamItem.Event(sequence, event.copy(payload = DomainEvent.Payload.TurnItemPayload(late)))))
        val older = late.copy(id = "ti_older", ordinal = -2)
        sequence += 1
        assertTrue(state.apply(ThreadStreamItem.Event(sequence, event.copy(payload = DomainEvent.Payload.TurnItemPayload(older)))))
        assertEquals(listOf("ti_older", "ti_1", "ti_late"), state.projection?.visibleTurnItems?.map { it.sourceItemId })
    }

    @Test fun snapshotIsCurrentButResumedEventsWaitForTheMarker() {
        val state = ThreadState()
        state.beginSubscription()
        state.apply(TestData.threadSnapshot())
        assertTrue(state.isSynchronized)

        // A resume replays missed events; the projection is behind until the marker.
        state.beginSubscription()
        assertFalse(state.isSynchronized)
        val (sequence, event) = TestData.event(0)
        state.apply(ThreadStreamItem.Event(sequence, event))
        assertFalse(state.isSynchronized)
        assertTrue(state.apply(ThreadStreamItem.Synchronized))
        assertTrue(state.isSynchronized)
    }

    @Test fun syncStartsOverForAnotherThread() {
        val sync = ThreadSync()
        assertNull(sync.begin("thr_1"))
        val update = sync.apply(listOf(TestData.json("threadStreamItem.snapshot.json"), JsonObject(mapOf("kind" to JsonPrimitive("synchronized")))))
        assertEquals("thr_1", update?.projection?.thread?.id)
        assertEquals(true, update?.isSynchronized)
        assertEquals(99, sync.begin("thr_1"))
        assertNull(sync.begin("thr_2"))
    }

    @Test fun withoutTheMarkerAResumeIsLiveAtOnce() {
        val state = ThreadState()
        state.beginSubscription(awaitsMarker = false)
        assertFalse(state.isSynchronized)
        state.apply(TestData.threadSnapshot())
        assertTrue(state.isSynchronized)
        state.beginSubscription(awaitsMarker = false)
        assertTrue(state.isSynchronized)
    }

    @Test fun anUnreadableKnownEventDropsTheCursor() {
        val sync = ThreadSync()
        sync.begin("thr_1")
        sync.apply(listOf(TestData.json("threadStreamItem.snapshot.json")))
        assertEquals(99, sync.resumeSequence)
        val broken = JsonObject(
            mapOf(
                "kind" to JsonPrimitive("event"),
                "sequence" to JsonPrimitive(100),
                "event" to JsonObject(mapOf("type" to JsonPrimitive("run.updated"), "payload" to JsonPrimitive("bad"))),
            ),
        )
        assertFailsWith<StreamDivergedException> { sync.apply(listOf(broken)) }
        assertNull(sync.resumeSequence)
        assertNull(sync.begin("thr_1"))
    }
}
