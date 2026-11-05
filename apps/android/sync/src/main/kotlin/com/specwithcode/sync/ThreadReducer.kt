package com.specwithcode.sync

import com.specwithcode.wire.DomainEvent
import com.specwithcode.wire.ProjectedTurnItem
import com.specwithcode.wire.Run
import com.specwithcode.wire.RunStatus
import com.specwithcode.wire.ThreadProjection
import com.specwithcode.wire.ThreadSnapshot
import com.specwithcode.wire.ThreadStreamItem
import com.specwithcode.wire.TurnItem
import com.specwithcode.wire.TurnItemVisibility
import com.specwithcode.wire.UserMessageInputIntent

// Port of the event handling in packages/client-runtime/src/state/orchestrationV2Projection.ts,
// limited to the parts of the projection the app decodes.

object ThreadReducer {
    /**
     * Applies one committed event to the projection of the same thread. [partialTimeline] is set
     * for bounded snapshots, which hold only recent history.
     */
    fun apply(
        event: DomainEvent,
        projection: ThreadProjection,
        partialTimeline: Boolean = false,
        latestLocalTurnOrdinal: Int? = null,
    ): ThreadProjection {
        if (event.threadId != projection.thread.id) return projection
        return when (val payload = event.payload) {
            is DomainEvent.Payload.Thread -> projection.copy(
                thread = payload.thread,
                // Visited tracking is read state, not activity.
                updatedAt = if (event.type != "thread.visited" && event.type != "thread.marked-unread") event.occurredAt else projection.updatedAt,
            )

            is DomainEvent.Payload.RunPayload -> {
                // Only run.prompt-suggested sets the suggestion; a run snapshot keeps it.
                val run = if (payload.run.promptSuggestion == null) {
                    payload.run.copy(promptSuggestion = projection.runs.firstOrNull { it.id == payload.run.id }?.promptSuggestion)
                } else {
                    payload.run
                }
                val next = projection.copy(updatedAt = event.occurredAt, runs = upsert(projection.runs, run) { it.id })
                next.copy(visibleTurnItems = activeVisibleTurnItems(next))
            }

            is DomainEvent.Payload.PromptSuggestionPayload -> {
                val suggested = payload.value
                val index = projection.runs.indexOfFirst { it.id == suggested.runId }
                if (index < 0) return projection
                val runs = projection.runs.toMutableList()
                runs[index] = runs[index].copy(promptSuggestion = suggested.promptSuggestion)
                projection.copy(updatedAt = event.occurredAt, runs = runs)
            }

            is DomainEvent.Payload.Message ->
                projection.copy(updatedAt = event.occurredAt, messages = upsert(projection.messages, payload.message) { it.id })

            is DomainEvent.Payload.Plan ->
                projection.copy(updatedAt = event.occurredAt, plans = upsert(projection.plans, payload.plan) { it.id })

            is DomainEvent.Payload.RuntimeRequestPayload ->
                projection.copy(updatedAt = event.occurredAt, runtimeRequests = upsert(projection.runtimeRequests, payload.request) { it.id })

            is DomainEvent.Payload.TurnItemPayload -> {
                val item = payload.item
                if (partialTimeline && projection.turnItems.none { it.id == item.id } &&
                    shouldDropMissingPartialItem(projection, item, latestLocalTurnOrdinal)
                ) {
                    return projection
                }
                val next = projection.copy(updatedAt = event.occurredAt, turnItems = upsert(projection.turnItems, item) { it.id })
                val visible = if (isVisible(item, next.runs)) {
                    upsertVisible(next, item, partialTimeline, latestLocalTurnOrdinal)
                } else {
                    removeVisible(next.visibleTurnItems, item.id)
                }
                next.copy(visibleTurnItems = visible)
            }

            is DomainEvent.Payload.Unknown -> projection.copy(updatedAt = event.occurredAt)
        }
    }

    /** Rolled-back runs leave no rows, and a queued message whose run was cancelled never reached the provider. */
    fun isVisible(item: TurnItem, runs: List<Run>): Boolean {
        val runId = item.runId ?: return true
        val run = runs.firstOrNull { it.id == runId } ?: return true
        if (run.status == RunStatus.RolledBack) return false
        val content = item.content
        if (run.status == RunStatus.Cancelled && content is TurnItem.Content.UserMessageContent &&
            content.value.inputIntent == UserMessageInputIntent.QueuedTurn
        ) {
            return false
        }
        return true
    }

    internal fun activeVisibleTurnItems(projection: ThreadProjection): List<ProjectedTurnItem> {
        val rows = projection.visibleTurnItems
        val kept = rows.filter { it.visibility != TurnItemVisibility.Local || isVisible(it.item, projection.runs) }
        return if (kept.size == rows.size) rows else renumber(kept)
    }

    internal fun removeVisible(rows: List<ProjectedTurnItem>, itemId: String): List<ProjectedTurnItem> {
        val index = rows.indexOfFirst { it.sourceItemId == itemId }
        if (index < 0) return rows
        return renumber(rows.toMutableList().also { it.removeAt(index) })
    }

    internal fun renumber(rows: List<ProjectedTurnItem>): List<ProjectedTurnItem> =
        rows.mapIndexed { index, row -> if (row.position == index) row else row.copy(position = index) }

    internal fun oldestLocalOrdinal(rows: List<ProjectedTurnItem>): Int? =
        rows.filter { it.visibility == TurnItemVisibility.Local }.minOfOrNull { it.item.ordinal }

    internal fun shouldDropMissingPartialItem(projection: ThreadProjection, item: TurnItem, latestLocalTurnOrdinal: Int?): Boolean {
        if (projection.visibleTurnItems.any { it.sourceItemId == item.id }) return false
        if (latestLocalTurnOrdinal != null && item.ordinal <= latestLocalTurnOrdinal) return true
        val oldest = oldestLocalOrdinal(projection.visibleTurnItems)
        return oldest != null && item.ordinal < oldest
    }

    internal fun upsertVisible(
        projection: ThreadProjection,
        item: TurnItem,
        partialTimeline: Boolean,
        latestLocalTurnOrdinal: Int?,
    ): List<ProjectedTurnItem> {
        val rows = projection.visibleTurnItems
        val index = rows.indexOfFirst { it.sourceItemId == item.id }
        val row = ProjectedTurnItem(position = 0, visibility = TurnItemVisibility.Local, sourceThreadId = item.threadId, sourceItemId = item.id, item = item)
        if (index >= 0) {
            val previous = rows[index]
            if (previous.visibility == TurnItemVisibility.Local && previous.sourceThreadId == row.sourceThreadId && previous.item == item) {
                return rows
            }
        } else if (partialTimeline && shouldDropMissingPartialItem(projection, item, latestLocalTurnOrdinal)) {
            return rows
        }
        val updated = rows.toMutableList()
        if (index >= 0) updated.removeAt(index)
        val insertion = updated.indexOfFirst { candidate ->
            candidate.visibility == TurnItemVisibility.Local &&
                (candidate.item.ordinal > item.ordinal || (candidate.item.ordinal == item.ordinal && candidate.item.id > item.id))
        }
        if (insertion < 0) updated.add(row) else updated.add(insertion, row)
        return renumber(updated)
    }
}

/** One open thread as its subscription builds it. */
class ThreadState {
    var projection: ThreadProjection? = null
        private set

    /** The last sequence applied: the snapshot's, then each event's. */
    var sequence: Int? = null
        private set

    /** The projection is current on this subscription: a snapshot arrived or the replay finished. */
    var isSynchronized: Boolean = false
        private set

    /** The snapshot was a bounded window of recent history. */
    var partialTimeline: Boolean = false
        private set

    var latestLocalTurnOrdinal: Int? = null
        private set

    /** False after a known item could not be read: the next subscription takes a fresh snapshot. */
    private var cursorValid = true

    /** The sequence to resume from, when a projection is held and nothing was lost since. */
    val resumeSequence: Int? get() = if (projection == null || !cursorValid) null else sequence

    /**
     * Call before subscribing. Without the completion marker ([awaitsMarker] false) a resumed
     * subscription counts as live at once, as client-runtime threads.ts does; a fresh one is
     * live once its snapshot lands.
     */
    fun beginSubscription(awaitsMarker: Boolean = true) {
        isSynchronized = !awaitsMarker && resumeSequence != null
    }

    /** Forgets the cursor so the next subscription starts from a full snapshot. */
    fun invalidateCursor() {
        cursorValid = false
    }

    /** Applies one stream item. Returns true when anything visible changed. */
    fun apply(item: ThreadStreamItem): Boolean = when (item) {
        ThreadStreamItem.Synchronized -> {
            val changed = !isSynchronized
            isSynchronized = true
            changed
        }
        is ThreadStreamItem.Snapshot -> {
            seed(item.snapshot)
            true
        }
        is ThreadStreamItem.Event -> applyEvent(item.sequence, item.event)
        is ThreadStreamItem.Unknown -> false
    }

    /**
     * Takes a snapshot, from the stream or from `GET /api/orchestration/threads/{id}`. A snapshot
     * is the thread as it is now, so it counts as synchronized at once.
     */
    fun seed(snapshot: ThreadSnapshot) {
        projection = snapshot.projection
        sequence = snapshot.snapshotSequence
        cursorValid = true
        isSynchronized = true
        // A bounded snapshot is partial only while older history remains (client-runtime
        // threads.ts); a complete window applies every item.
        partialTimeline = snapshot.hasMoreHistory == true || snapshot.historyCursor != null
        latestLocalTurnOrdinal = snapshot.latestLocalTurnOrdinal
    }

    private fun applyEvent(eventSequence: Int, event: DomainEvent): Boolean {
        val current = projection ?: return false
        val last = sequence
        if (last != null && eventSequence <= last) return false
        sequence = eventSequence
        val next = ThreadReducer.apply(event, current, partialTimeline, latestLocalTurnOrdinal)
        if (next == current) return false
        projection = next
        return true
    }
}
