package com.specwithcode.sync

import com.specwithcode.wire.ShellSnapshot
import com.specwithcode.wire.ShellStreamItem
import com.specwithcode.wire.ShellStreamItemSerializer
import com.specwithcode.wire.ThreadProjection
import com.specwithcode.wire.ThreadSnapshot
import com.specwithcode.wire.ThreadStreamItem
import com.specwithcode.wire.ThreadStreamItemSerializer
import com.specwithcode.wire.WireJson
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.util.logging.Level
import java.util.logging.Logger

internal val syncLog: Logger = Logger.getLogger("com.specwithcode.sync")

/**
 * A stream item of a known kind could not be read. Its change is lost, so the held cursor is
 * dropped and the caller resubscribes for a fresh snapshot instead of skipping past it.
 */
class StreamDivergedException(stream: String, detail: String?) :
    Exception("Unreadable $stream item; taking a fresh snapshot ($detail)")

/**
 * Whether [value] names its kind. Kinds this build does not know decode as `Unknown`, so a
 * decode failure on a value with a kind means a known item was lost.
 */
private fun hasKind(value: JsonElement): Boolean =
    ((value as? JsonObject)?.get("kind") as? JsonPrimitive)?.isString == true

/**
 * Decodes and reduces one machine's shell stream. The state outlives sockets so a reconnect
 * resumes with `afterSequence`. Safe to call from any thread.
 */
class ShellSync {
    data class Update(val snapshot: ShellSnapshot?, val isSynchronized: Boolean)

    private val state = ShellState()

    val resumeSequence: Int? @Synchronized get() = state.resumeSequence

    val snapshot: ShellSnapshot? @Synchronized get() = state.snapshot

    val isSynchronized: Boolean @Synchronized get() = state.isSynchronized

    @Synchronized
    fun beginSubscription(awaitsMarker: Boolean = true) = state.beginSubscription(awaitsMarker)

    /** Applies the HTTP snapshot fetched before subscribing. */
    @Synchronized
    fun seed(snapshot: ShellSnapshot): Update? =
        if (state.seed(snapshot)) Update(state.snapshot, state.isSynchronized) else null

    /**
     * Applies a chunk's values. Returns the new state when anything changed. Throws
     * [StreamDivergedException] when a known item could not be read.
     */
    @Synchronized
    fun apply(values: List<JsonElement>): Update? {
        var changed = false
        for (value in values) {
            val item = try {
                WireJson.decodeFromJsonElement(ShellStreamItemSerializer, value)
            } catch (e: Exception) {
                if (hasKind(value)) {
                    state.invalidateCursor()
                    throw StreamDivergedException("shell", e.message)
                }
                syncLog.log(Level.WARNING, "Skipping unreadable shell item: ${e.message}")
                continue
            }
            changed = state.apply(item) || changed
        }
        return if (changed) Update(state.snapshot, state.isSynchronized) else null
    }

    @Synchronized
    fun apply(item: ShellStreamItem): Update? = if (state.apply(item)) Update(state.snapshot, state.isSynchronized) else null
}

/** Decodes and reduces one open thread's stream. Safe to call from any thread. */
class ThreadSync {
    data class Update(val projection: ThreadProjection?, val isSynchronized: Boolean)

    var threadId: String? = null
        @Synchronized get
        private set

    private var state = ThreadState()

    /** Starts over when the session moves to another thread. Returns the sequence to resume from. */
    @Synchronized
    fun begin(threadId: String, awaitsMarker: Boolean = true): Int? {
        if (this.threadId != threadId) {
            this.threadId = threadId
            state = ThreadState()
        }
        state.beginSubscription(awaitsMarker)
        return state.resumeSequence
    }

    /** Whether a projection is held for the current thread. */
    val hasProjection: Boolean @Synchronized get() = state.projection != null

    /** The sequence to resume from, when a projection is held. */
    val resumeSequence: Int? @Synchronized get() = state.resumeSequence

    val projection: ThreadProjection? @Synchronized get() = state.projection

    val isSynchronized: Boolean @Synchronized get() = state.isSynchronized

    /** Applies the HTTP snapshot fetched before subscribing. */
    @Synchronized
    fun seed(snapshot: ThreadSnapshot): Update {
        state.seed(snapshot)
        return Update(state.projection, state.isSynchronized)
    }

    /** Throws [StreamDivergedException] when a known item could not be read. */
    @Synchronized
    fun apply(values: List<JsonElement>): Update? {
        var changed = false
        for (value in values) {
            val item = try {
                WireJson.decodeFromJsonElement(ThreadStreamItemSerializer, value)
            } catch (e: Exception) {
                if (hasKind(value)) {
                    state.invalidateCursor()
                    throw StreamDivergedException("thread", e.message)
                }
                syncLog.log(Level.WARNING, "Skipping unreadable thread item: ${e.message}")
                continue
            }
            changed = state.apply(item) || changed
        }
        return if (changed) Update(state.projection, state.isSynchronized) else null
    }

    @Synchronized
    fun apply(item: ThreadStreamItem): Update? = if (state.apply(item)) Update(state.projection, state.isSynchronized) else null
}
