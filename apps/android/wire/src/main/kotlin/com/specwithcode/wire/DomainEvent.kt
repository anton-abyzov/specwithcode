package com.specwithcode.wire

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import java.time.Instant

/**
 * A change to one thread, delivered by `orchestration.subscribeThread`.
 *
 * Payloads the app applies are typed. Any other event type, or a turn item of a type this
 * build does not know, carries [Payload.Unknown] with its raw payload; skip it but still
 * advance the resume cursor. A typed event whose payload does not decode fails.
 */
@Serializable(with = DomainEventSerializer::class)
data class DomainEvent(
    val id: String,
    val threadId: String,
    val runId: String? = null,
    val nodeId: String? = null,
    val driver: String? = null,
    val providerInstanceId: String? = null,
    val rawEventId: String? = null,
    val occurredAt: Instant,
    val type: String,
    val payload: Payload,
) {
    sealed interface Payload {
        /** Every `thread.*` event carries the whole thread record. */
        data class Thread(val thread: AppThread) : Payload

        /** `run.created` and `run.updated`. */
        data class RunPayload(val run: Run) : Payload

        /** `run.prompt-suggested`. */
        data class PromptSuggestionPayload(val value: RunPromptSuggestion) : Payload
        data class Message(val message: ConversationMessage) : Payload
        data class TurnItemPayload(val item: TurnItem) : Payload
        data class Plan(val plan: PlanArtifact) : Payload
        data class RuntimeRequestPayload(val request: RuntimeRequest) : Payload
        data class Unknown(val raw: JsonElement) : Payload
    }

    val isUnknown: Boolean get() = payload is Payload.Unknown

    companion object {
        /** The `thread.*` types whose payload is the thread record. */
        val threadEventTypes: Set<String> = setOf(
            "thread.created", "thread.archived", "thread.unarchived", "thread.deleted", "thread.settled", "thread.unsettled",
            "thread.snoozed", "thread.unsnoozed", "thread.pinned", "thread.auto-settle-set", "thread.unpinned",
            "thread.pin-reordered", "thread.active-reordered", "thread.visited", "thread.marked-unread",
            "thread.pull-request-synced", "thread.metadata-updated", "thread.runtime-mode-updated",
            "thread.interaction-mode-updated", "thread.model-selection-updated", "thread.provider-switched",
        )

        /** Every type decoded into a typed payload. */
        val typedEventTypes: Set<String> = threadEventTypes + setOf(
            "run.created", "run.updated", "run.prompt-suggested", "message.updated", "turn-item.updated", "plan.updated",
            "runtime-request.updated",
        )
    }
}

object DomainEventSerializer : ObjectSerializer<DomainEvent>("DomainEvent") {
    private inline fun <T> soft(fallback: T, block: () -> T): T = try {
        block()
    } catch (_: IllegalArgumentException) {
        fallback
    }

    override fun JsonReader.read(): DomainEvent {
        val type = string("type")
        if (type !in DomainEvent.typedEventTypes) {
            return DomainEvent(
                id = soft("") { optString("id") ?: "" },
                threadId = soft("") { optString("threadId") ?: "" },
                runId = soft(null) { optString("runId") },
                nodeId = soft(null) { optString("nodeId") },
                driver = soft(null) { optString("driver") },
                providerInstanceId = soft(null) { optString("providerInstanceId") },
                rawEventId = soft(null) { optString("rawEventId") },
                occurredAt = soft(Instant.EPOCH) { optInstant("occurredAt") ?: Instant.EPOCH },
                type = type,
                payload = DomainEvent.Payload.Unknown(element("payload") ?: JsonNull),
            )
        }
        val payload: DomainEvent.Payload = when (type) {
            "run.created", "run.updated" -> DomainEvent.Payload.RunPayload(req("payload"))
            "run.prompt-suggested" -> DomainEvent.Payload.PromptSuggestionPayload(req("payload"))
            "message.updated" -> DomainEvent.Payload.Message(req("payload"))
            "turn-item.updated" -> {
                val item = req<TurnItem>("payload")
                val content = item.content
                if (content is TurnItem.Content.Unknown) DomainEvent.Payload.Unknown(content.raw) else DomainEvent.Payload.TurnItemPayload(item)
            }
            "plan.updated" -> DomainEvent.Payload.Plan(req("payload"))
            "runtime-request.updated" -> DomainEvent.Payload.RuntimeRequestPayload(req("payload"))
            else -> DomainEvent.Payload.Thread(req("payload"))
        }
        return DomainEvent(
            id = string("id"),
            threadId = string("threadId"),
            runId = optString("runId"),
            nodeId = optString("nodeId"),
            driver = optString("driver"),
            providerInstanceId = optString("providerInstanceId"),
            rawEventId = optString("rawEventId"),
            occurredAt = instant("occurredAt"),
            type = type,
            payload = payload,
        )
    }

    override fun JsonWriter.write(value: DomainEvent) {
        put("id", value.id)
        put("threadId", value.threadId)
        put("runId", value.runId)
        put("nodeId", value.nodeId)
        put("driver", value.driver)
        put("providerInstanceId", value.providerInstanceId)
        put("rawEventId", value.rawEventId)
        putInstant("occurredAt", value.occurredAt)
        put("type", value.type)
        when (val p = value.payload) {
            is DomainEvent.Payload.Thread -> put("payload", p.thread)
            is DomainEvent.Payload.RunPayload -> put("payload", p.run)
            is DomainEvent.Payload.PromptSuggestionPayload -> put("payload", p.value)
            is DomainEvent.Payload.Message -> put("payload", p.message)
            is DomainEvent.Payload.TurnItemPayload -> put("payload", p.item)
            is DomainEvent.Payload.Plan -> put("payload", p.plan)
            is DomainEvent.Payload.RuntimeRequestPayload -> put("payload", p.request)
            is DomainEvent.Payload.Unknown -> members["payload"] = p.raw
        }
    }
}

/** The payload of `run.prompt-suggested`. */
@Serializable
data class RunPromptSuggestion(val runId: String, val promptSuggestion: PromptSuggestion)

/** The first value of a thread subscription, unless resumed with `afterSequence`. */
@Serializable
data class ThreadSnapshot(
    val snapshotSequence: Int,
    val projection: ThreadProjection,
    /** Set on bounded snapshots: the cursor for older history. */
    val historyCursor: String? = null,
    val hasMoreHistory: Boolean? = null,
    val latestLocalTurnOrdinal: Int? = null,
    val payloadBudgetExceeded: Boolean? = null,
)

/** One value of the `orchestration.subscribeThread` stream. */
@Serializable(with = ThreadStreamItemSerializer::class)
sealed interface ThreadStreamItem {
    /** Initial catch-up is done; live events follow. */
    data object Synchronized : ThreadStreamItem
    data class Snapshot(val snapshot: ThreadSnapshot) : ThreadStreamItem
    data class Event(val sequence: Int, val event: DomainEvent) : ThreadStreamItem

    /** A kind this build does not know. Skip it. */
    data class Unknown(val kind: String, val raw: JsonObject) : ThreadStreamItem
}

/** The event sequence: the snapshot's for a snapshot, null for [Synchronized]. */
val ThreadStreamItem.sequence: Int?
    get() = when (this) {
        ThreadStreamItem.Synchronized -> null
        is ThreadStreamItem.Snapshot -> snapshot.snapshotSequence
        is ThreadStreamItem.Event -> sequence
        is ThreadStreamItem.Unknown -> raw["sequence"]?.intValue
    }

object ThreadStreamItemSerializer : ObjectSerializer<ThreadStreamItem>("ThreadStreamItem") {
    override fun JsonReader.read(): ThreadStreamItem = when (val kind = string("kind")) {
        "synchronized" -> ThreadStreamItem.Synchronized
        "snapshot" -> ThreadStreamItem.Snapshot(decode(ThreadSnapshot.serializer(), raw, "snapshot"))
        "event" -> ThreadStreamItem.Event(int("sequence"), req("event"))
        else -> ThreadStreamItem.Unknown(kind, raw)
    }

    override fun JsonWriter.write(value: ThreadStreamItem) {
        when (value) {
            ThreadStreamItem.Synchronized -> put("kind", "synchronized")
            is ThreadStreamItem.Snapshot -> {
                put("kind", "snapshot")
                merge(json.encodeToJsonElement(ThreadSnapshot.serializer(), value.snapshot))
            }
            is ThreadStreamItem.Event -> {
                put("kind", "event")
                put("sequence", value.sequence)
                put("event", value.event)
            }
            is ThreadStreamItem.Unknown -> merge(value.raw)
        }
    }
}
