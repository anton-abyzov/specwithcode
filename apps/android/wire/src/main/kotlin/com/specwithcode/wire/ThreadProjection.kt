package com.specwithcode.wire

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import java.time.Instant

object LenientPlanRef : LenientSerializer<PlanRef>(PlanRef.serializer())
object LenientWorkspaceStrategy : LenientSerializer<WorkspaceStrategy>(WorkspaceStrategySerializer)
object LenientPromptSuggestion : LenientSerializer<PromptSuggestion>(PromptSuggestion.serializer())
object LenientThreadNotification : LenientSerializer<ThreadNotification>(ThreadNotification.serializer())

/** One prompt and the work it started. */
@Serializable
data class Run(
    val id: String,
    val threadId: String,
    val ordinal: Int,
    val providerInstanceId: String,
    val modelSelection: ModelSelection,
    val providerThreadId: String? = null,
    val userMessageId: String,
    val rootNodeId: String? = null,
    val activeAttemptId: String? = null,
    val status: RunStatus,
    val queuePosition: Int? = null,
    /** Restart recovery holds the queue until the user resumes it. */
    val queueHeld: Boolean? = null,
    val cancelledForUpdate: Boolean? = null,
    val requestedAt: WireInstant,
    val startedAt: WireInstant? = null,
    val completedAt: WireInstant? = null,
    val checkpointId: String? = null,
    val contextHandoffId: String? = null,
    val restartContinuationOfRunId: String? = null,
    /** Set on wake runs: when the work they continue started. */
    val workStartedAt: WireInstant? = null,
    @Serializable(with = LenientPlanRef::class) val sourcePlanRef: PlanRef? = null,
    @Serializable(with = LenientWorkspaceStrategy::class) val workspacePreparation: WorkspaceStrategy? = null,
    /** The predicted next prompt, set only by `run.prompt-suggested`. */
    @Serializable(with = LenientPromptSuggestion::class) val promptSuggestion: PromptSuggestion? = null,
) {
    /** When the work this run belongs to started; a wake counts from the prompt that started it. */
    val workStartDate: Instant get() = workStartedAt ?: startedAt ?: requestedAt
}

/** A predicted next user prompt for a finished run. */
@Serializable
data class PromptSuggestion(
    val text: String,
    /** "provider" or "generated". */
    val source: String,
)

/** A plan in another thread, for runs and messages that carry one out. */
@Serializable
data class PlanRef(val threadId: String, val planId: String)

@Serializable
data class ConversationMessage(
    @Serializable(with = LenientThreadNotification::class) val notification: ThreadNotification? = null,
    val createdBy: ActorKind = ActorKind.User,
    val creationSource: CreationSource = CreationSource.Web,
    val scheduledTaskId: String? = null,
    /** The sending agent's thread, for messages from another agent. */
    val senderThreadId: String? = null,
    val id: String,
    val threadId: String,
    val runId: String? = null,
    val nodeId: String? = null,
    val role: MessageRole,
    val text: String = "",
    val context: JsonElement? = null,
    @Serializable(with = LossyAttachments::class) val attachments: List<ChatAttachment> = emptyList(),
    val streaming: Boolean = false,
    val createdAt: WireInstant,
    val updatedAt: WireInstant,
)

/** A plan the agent proposed or a todo list it keeps. */
@Serializable(with = PlanArtifactSerializer::class)
data class PlanArtifact(
    val id: String,
    val threadId: String,
    val runId: String? = null,
    val nodeId: String,
    val status: PlanStatus,
    /** The full content lives in the matching turn item. */
    val detailInTurnItem: Boolean? = null,
    val content: Content,
) {
    val kind: String get() = content.kind

    sealed interface Content {
        val kind: String

        data class ProposedPlan(val markdown: String) : Content { override val kind get() = "proposed_plan" }
        data class TodoList(val steps: List<PlanStep>, val explanation: String? = null) : Content { override val kind get() = "todo_list" }
        data class Unknown(override val kind: String, val raw: JsonObject) : Content
    }
}

object PlanArtifactSerializer : ObjectSerializer<PlanArtifact>("PlanArtifact") {
    override fun JsonReader.read(): PlanArtifact {
        val id = string("id")
        val threadId = string("threadId")
        val runId = optString("runId")
        val nodeId = optString("nodeId") ?: ""
        val status = req<PlanStatus>("status")
        val detail = optBool("detailInTurnItem")
        val content = when (val kind = string("kind")) {
            "proposed_plan" -> PlanArtifact.Content.ProposedPlan(optString("markdown") ?: "")
            "todo_list" -> PlanArtifact.Content.TodoList(list("steps"), optString("explanation"))
            else -> PlanArtifact.Content.Unknown(kind, raw)
        }
        return PlanArtifact(id, threadId, runId, nodeId, status, detail, content)
    }

    override fun JsonWriter.write(value: PlanArtifact) {
        val content = value.content
        if (content is PlanArtifact.Content.Unknown) {
            merge(content.raw)
            return
        }
        put("id", value.id)
        put("threadId", value.threadId)
        put("runId", value.runId)
        put("nodeId", value.nodeId)
        put("status", value.status)
        put("detailInTurnItem", value.detailInTurnItem)
        put("kind", value.kind)
        when (content) {
            is PlanArtifact.Content.ProposedPlan -> put("markdown", content.markdown)
            is PlanArtifact.Content.TodoList -> {
                put("steps", content.steps)
                put("explanation", content.explanation)
            }
            is PlanArtifact.Content.Unknown -> Unit
        }
    }
}

/** How a runtime request's response reaches the provider. */
@Serializable(with = ResponseCapabilitySerializer::class)
sealed interface ResponseCapability {
    /** The provider session is live; respond with `runtime-request.respond`. */
    data class Live(val providerSessionId: String) : ResponseCapability

    /** Answer by sending a message. */
    data object Message : ResponseCapability

    /** The request can no longer be answered. */
    data class NotResumable(val reason: String) : ResponseCapability

    data class Unknown(val raw: JsonElement) : ResponseCapability

    val canRespond: Boolean get() = this is Live
}

object ResponseCapabilitySerializer : ObjectSerializer<ResponseCapability>("ResponseCapability") {
    override fun JsonReader.read(): ResponseCapability = when (optString("type")) {
        "live" -> ResponseCapability.Live(optString("providerSessionId") ?: "")
        "message" -> ResponseCapability.Message
        "not_resumable" -> ResponseCapability.NotResumable(optString("reason") ?: "")
        else -> ResponseCapability.Unknown(raw)
    }

    override fun JsonWriter.write(value: ResponseCapability) {
        when (value) {
            is ResponseCapability.Live -> {
                put("type", "live")
                put("providerSessionId", value.providerSessionId)
            }
            ResponseCapability.Message -> put("type", "message")
            is ResponseCapability.NotResumable -> {
                put("type", "not_resumable")
                put("reason", value.reason)
            }
            is ResponseCapability.Unknown -> merge(value.raw)
        }
    }
}

/** An approval, question or tool call the provider waits on. */
@Serializable(with = RuntimeRequestSerializer::class)
data class RuntimeRequest(
    val id: String,
    val nodeId: String = "",
    val providerTurnId: String? = null,
    val nativeRequestRef: JsonElement? = null,
    val kind: RuntimeRequestKind,
    val status: RuntimeRequestStatus,
    val responseCapability: ResponseCapability = ResponseCapability.Unknown(JsonNull),
    val createdAt: Instant,
    val resolvedAt: Instant? = null,
    val decision: ProviderApprovalDecision? = null,
    /** Answers by question id: a string or an array of strings. */
    val answers: Map<String, JsonElement>? = null,
) {
    val isPending: Boolean get() = status == RuntimeRequestStatus.Pending
}

object RuntimeRequestSerializer : ObjectSerializer<RuntimeRequest>("RuntimeRequest") {
    override fun JsonReader.read() = RuntimeRequest(
        id = string("id"),
        nodeId = optString("nodeId") ?: "",
        providerTurnId = optString("providerTurnId"),
        nativeRequestRef = element("nativeRequestRef"),
        kind = req("kind"),
        status = req("status"),
        responseCapability = opt("responseCapability", ResponseCapabilitySerializer) ?: ResponseCapability.Unknown(JsonNull),
        createdAt = instant("createdAt"),
        resolvedAt = optInstant("resolvedAt"),
        decision = opt("decision"),
        answers = opt("answers"),
    )

    override fun JsonWriter.write(value: RuntimeRequest) {
        put("id", value.id)
        put("nodeId", value.nodeId)
        put("providerTurnId", value.providerTurnId)
        value.nativeRequestRef?.let { members["nativeRequestRef"] = it }
        put("kind", value.kind)
        put("status", value.status)
        val capability = value.responseCapability
        if (!(capability is ResponseCapability.Unknown && capability.raw is JsonNull)) {
            put("responseCapability", capability, ResponseCapabilitySerializer)
        }
        putInstant("createdAt", value.createdAt)
        putInstant("resolvedAt", value.resolvedAt)
        put("decision", value.decision)
        put("answers", value.answers)
    }
}

/**
 * Everything about one thread: `orchestration.getThreadProjection`, the snapshot of
 * `orchestration.subscribeThread`, and `launchThread`'s result.
 *
 * The subset the app renders. Attempts, nodes, provider sessions, checkpoints and context
 * transfers are not decoded.
 */
@Serializable(with = ThreadProjectionSerializer::class)
data class ThreadProjection(
    val thread: AppThread,
    val runs: List<Run> = emptyList(),
    val runtimeRequests: List<RuntimeRequest> = emptyList(),
    val messages: List<ConversationMessage> = emptyList(),
    val plans: List<PlanArtifact> = emptyList(),
    /** Every item of this thread, including ones a newer server added (unknown). */
    val turnItems: List<TurnItem> = emptyList(),
    /** The timeline to render, with items inherited from forks. */
    val visibleTurnItems: List<ProjectedTurnItem> = emptyList(),
    val updatedAt: Instant = thread.updatedAt,
) {
    /** The highest-ordinal run. */
    val latestRun: Run? get() = runs.maxByOrNull { it.ordinal }

    /** The run holding the thread now, if any. */
    val activeRun: Run? get() = runs.filter { it.status.isActive }.maxByOrNull { it.ordinal }

    val pendingRuntimeRequests: List<RuntimeRequest> get() = runtimeRequests.filter { it.isPending }

    fun runtimeRequest(id: String): RuntimeRequest? = runtimeRequests.firstOrNull { it.id == id }

    /** Visible rows of item types this build renders. */
    val renderableTurnItems: List<ProjectedTurnItem> get() = visibleTurnItems.filter { !it.item.isUnknown }
}

object ThreadProjectionSerializer : ObjectSerializer<ThreadProjection>("ThreadProjection") {
    override fun JsonReader.read(): ThreadProjection {
        val thread = req<AppThread>("thread")
        return ThreadProjection(
            thread = thread,
            runs = list("runs"),
            runtimeRequests = list("runtimeRequests"),
            messages = list("messages"),
            plans = list("plans"),
            turnItems = list("turnItems"),
            visibleTurnItems = list("visibleTurnItems"),
            updatedAt = optInstant("updatedAt") ?: thread.updatedAt,
        )
    }

    override fun JsonWriter.write(value: ThreadProjection) {
        put("thread", value.thread)
        put("runs", value.runs)
        put("runtimeRequests", value.runtimeRequests)
        put("messages", value.messages)
        put("plans", value.plans)
        put("turnItems", value.turnItems)
        put("visibleTurnItems", value.visibleTurnItems)
        putInstant("updatedAt", value.updatedAt)
    }
}
