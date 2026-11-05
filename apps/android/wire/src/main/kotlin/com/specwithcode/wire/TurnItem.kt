package com.specwithcode.wire

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import java.time.Instant

/**
 * One row of a thread's timeline: a message, a command, a plan, a question.
 *
 * A known `type` must decode in full. A type this build does not know decodes as
 * [Content.Unknown] with its raw JSON, keeping whatever base fields it carries, and encodes
 * back unchanged.
 */
@Serializable(with = TurnItemSerializer::class)
data class TurnItem(
    val id: String,
    val threadId: String,
    val runId: String? = null,
    val nodeId: String? = null,
    val providerThreadId: String? = null,
    val providerTurnId: String? = null,
    val nativeItemRef: JsonElement? = null,
    val parentItemId: String? = null,
    val ordinal: Int,
    val status: TurnItemStatus,
    val title: String? = null,
    val startedAt: Instant? = null,
    val completedAt: Instant? = null,
    val updatedAt: Instant,
    val toolNonExecutionKind: String? = null,
    /** `browser` or `computer`. */
    val toolSurface: String? = null,
    val toolIcon: JsonElement? = null,
    val toolSource: ToolSource? = null,
    val content: Content,
) {
    /** The wire `type`. */
    val type: String get() = content.type

    val isUnknown: Boolean get() = content is Content.Unknown

    /** True while the item is still changing. */
    val isInFlight: Boolean
        get() = status == TurnItemStatus.Pending || status == TurnItemStatus.Running || status == TurnItemStatus.Waiting

    sealed interface Content {
        val type: String

        data class UserMessageContent(val value: UserMessage) : Content { override val type get() = "user_message" }
        data class AssistantMessageContent(val value: AssistantMessage) : Content { override val type get() = "assistant_message" }
        data class ReasoningContent(val value: Reasoning) : Content { override val type get() = "reasoning" }
        data class ProposedPlanContent(val value: ProposedPlan) : Content { override val type get() = "proposed_plan" }
        data class TodoListContent(val value: TodoList) : Content { override val type get() = "todo_list" }
        data class CommandExecutionContent(val value: CommandExecution) : Content { override val type get() = "command_execution" }
        data class FileChangeContent(val value: FileChange) : Content { override val type get() = "file_change" }
        data class FileSearchContent(val value: FileSearch) : Content { override val type get() = "file_search" }
        data class WebSearchContent(val value: WebSearch) : Content { override val type get() = "web_search" }
        data class ApprovalRequestContent(val value: ApprovalRequest) : Content { override val type get() = "approval_request" }
        data class UserInputRequestContent(val value: UserInputRequest) : Content { override val type get() = "user_input_request" }
        data class DynamicToolContent(val value: DynamicTool) : Content { override val type get() = "dynamic_tool" }
        data class SubagentContent(val value: Subagent) : Content { override val type get() = "subagent" }
        data class ErrorContent(val value: ErrorReport) : Content { override val type get() = "error" }
        data class SystemNoticeContent(val value: SystemNotice) : Content { override val type get() = "system_notice" }
        data class NotificationContent(val value: ThreadNotification) : Content { override val type get() = "notification" }
        data class AccessRequestContent(val value: AccessRequest) : Content { override val type get() = "access_request" }
        data class Unknown(override val type: String, val raw: JsonObject) : Content
    }

    @Serializable
    data class UserMessage(
        val createdBy: ActorKind = ActorKind.User,
        val creationSource: CreationSource = CreationSource.Web,
        val messageId: String,
        val scheduledTaskId: String? = null,
        /** The sending agent's thread, for messages from another agent. */
        val senderThreadId: String? = null,
        val inputIntent: UserMessageInputIntent = UserMessageInputIntent.TurnStart,
        val text: String,
        /** Structured composer context, kept raw. */
        val context: JsonElement? = null,
        @Serializable(with = LossyAttachments::class) val attachments: List<ChatAttachment> = emptyList(),
    )

    @Serializable
    data class AssistantMessage(
        val messageId: String,
        /** Markdown. */
        val text: String,
        val attachments: List<ChatAttachment>? = null,
        val streaming: Boolean = false,
    )

    @Serializable
    data class Reasoning(val text: String, val streaming: Boolean = false)

    @Serializable
    data class ProposedPlan(val planId: String, val markdown: String, val streaming: Boolean = false)

    @Serializable
    data class TodoList(val planId: String, val steps: List<PlanStep>, val explanation: String? = null) {
        val completedCount: Int get() = steps.count { it.status == PlanStepStatus.Completed }
    }

    @Serializable
    data class CommandExecution(
        val input: String,
        val output: String? = null,
        /** The output was withheld; fetch it with `orchestration.getTurnItem`. */
        val outputOmitted: Boolean? = null,
        val outputIndicatesFailure: Boolean? = null,
        val exitCode: Int? = null,
    )

    @Serializable
    data class FileChange(
        val fileName: String,
        val additions: Int? = null,
        val deletions: Int? = null,
        val diffStr: String? = null,
        val oldStr: String? = null,
        val newStr: String? = null,
        val changes: List<FileChangeDetail>? = null,
    )

    @Serializable
    data class FileSearch(val pattern: String? = null, val results: List<FileSearchResult>? = null)

    @Serializable
    data class WebSearch(val patterns: List<String>? = null, val results: List<WebSearchResult>? = null)

    /** A permission the agent waits on. Answer with `runtime-request.respond` and a decision. */
    @Serializable(with = ApprovalRequestSerializer::class)
    data class ApprovalRequest(
        val requestId: String,
        val requestKind: RuntimeRequestKind,
        val prompt: String? = null,
        /** File-write grant root: [Nullable.Null] means explicitly none, null means unknown. */
        val grantRoot: Nullable<String>? = null,
        /** The app asking, for `mcp-elicitation` requests. */
        val appName: String? = null,
        /** Choices the provider offers. Null means the default accept and decline. */
        val options: List<ApprovalOption>? = null,
    )

    /** Questions the agent asks. Answer with `runtime-request.respond` and `answers`. */
    @Serializable
    data class UserInputRequest(
        val requestId: String,
        val questions: List<UserInputQuestion>,
        /** The recorded answer once given, kept raw. */
        val questionAnswer: JsonElement? = null,
        /** `message`: answer by sending a message instead of a response. */
        val responseMode: String? = null,
    ) {
        val isAnswered: Boolean get() = questionAnswer != null
    }

    /** A tool call outside the built-in kinds, such as an MCP tool. */
    @Serializable
    data class DynamicTool(
        val toolName: String? = null,
        val viewedImagePath: String? = null,
        val input: JsonElement = JsonNull,
        val output: JsonElement? = null,
        val outputOmitted: Boolean? = null,
    )

    @Serializable
    data class Subagent(
        val subagentId: String,
        /** `provider_native` or `app_owned`. */
        val origin: String,
        val driver: String,
        val providerInstanceId: String,
        val childThreadId: String? = null,
        val prompt: String,
        val progress: String? = null,
        val result: String? = null,
    )

    @Serializable
    data class ErrorReport(val failure: ProviderFailure, val retry: ProviderRetry? = null)

    @Serializable
    data class SystemNotice(val message: String)

    /** Access the agent asked for. Answer with `access.answerRequest`. */
    @Serializable
    data class AccessRequest(
        /** What is asked, e.g. "Use System Settings and Activity Monitor". */
        val accessTitle: String,
        val reason: String = "",
        val subjects: List<AccessRequestSubject>,
        val accessStatus: AccessRequestStatus,
        /** Set once allowed. A scope this build does not know reads as none. */
        @Serializable(with = LenientAccessScope::class) val accessScope: AccessRequestScope? = null,
    ) {
        val isPending: Boolean get() = accessStatus == AccessRequestStatus.Pending
    }

    companion object {
        /** Every type this build decodes into a typed case. */
        val knownTypes: Set<String> = setOf(
            "user_message", "assistant_message", "reasoning", "proposed_plan", "todo_list", "command_execution",
            "file_change", "file_search", "web_search", "approval_request", "user_input_request", "dynamic_tool",
            "subagent", "error", "system_notice", "notification", "access_request",
        )
    }
}

object ApprovalRequestSerializer : ObjectSerializer<TurnItem.ApprovalRequest>("ApprovalRequest") {
    override fun JsonReader.read() = TurnItem.ApprovalRequest(
        string("requestId"), req("requestKind"), optString("prompt"), nullable("grantRoot"), optString("appName"), opt("options"),
    )

    override fun JsonWriter.write(value: TurnItem.ApprovalRequest) {
        put("requestId", value.requestId)
        put("requestKind", value.requestKind)
        put("prompt", value.prompt)
        putNullable("grantRoot", value.grantRoot)
        put("appName", value.appName)
        put("options", value.options)
    }
}

object LenientToolSource : LenientSerializer<ToolSource>(ToolSource.serializer())

object TurnItemSerializer : ObjectSerializer<TurnItem>("TurnItem") {
    private inline fun <reified T> JsonReader.tryOr(fallback: T, block: JsonReader.() -> T): T = try {
        block()
    } catch (_: IllegalArgumentException) {
        fallback
    }

    override fun JsonReader.read(): TurnItem {
        val type = string("type")
        if (type !in TurnItem.knownTypes) {
            // Keep what the base offers so the row still sorts; never fail.
            return TurnItem(
                id = tryOr("") { optString("id") ?: "" },
                threadId = tryOr("") { optString("threadId") ?: "" },
                runId = tryOr(null) { optString("runId") },
                nodeId = tryOr(null) { optString("nodeId") },
                providerThreadId = tryOr(null) { optString("providerThreadId") },
                providerTurnId = tryOr(null) { optString("providerTurnId") },
                parentItemId = tryOr(null) { optString("parentItemId") },
                ordinal = tryOr(0) { optInt("ordinal") ?: 0 },
                status = tryOr(TurnItemStatus.Idle) { opt<TurnItemStatus>("status") ?: TurnItemStatus.Idle },
                title = tryOr(null) { optString("title") },
                startedAt = tryOr(null) { optInstant("startedAt") },
                completedAt = tryOr(null) { optInstant("completedAt") },
                updatedAt = tryOr(Instant.EPOCH) { optInstant("updatedAt") ?: Instant.EPOCH },
                content = TurnItem.Content.Unknown(type, raw),
            )
        }
        return TurnItem(
            id = string("id"),
            threadId = string("threadId"),
            runId = optString("runId"),
            nodeId = optString("nodeId"),
            providerThreadId = optString("providerThreadId"),
            providerTurnId = optString("providerTurnId"),
            nativeItemRef = element("nativeItemRef"),
            parentItemId = optString("parentItemId"),
            ordinal = int("ordinal"),
            status = req("status"),
            title = optString("title"),
            startedAt = optInstant("startedAt"),
            completedAt = optInstant("completedAt"),
            updatedAt = instant("updatedAt"),
            toolNonExecutionKind = optString("toolNonExecutionKind"),
            toolSurface = optString("toolSurface"),
            toolIcon = element("toolIcon"),
            toolSource = lenient("toolSource"),
            content = content(type),
        )
    }

    private fun <T> JsonReader.payload(serializer: KSerializer<T>): T = decode(serializer, raw, "payload")

    private fun JsonReader.content(type: String): TurnItem.Content = when (type) {
        "user_message" -> TurnItem.Content.UserMessageContent(payload(TurnItem.UserMessage.serializer()))
        "assistant_message" -> TurnItem.Content.AssistantMessageContent(payload(TurnItem.AssistantMessage.serializer()))
        "reasoning" -> TurnItem.Content.ReasoningContent(payload(TurnItem.Reasoning.serializer()))
        "proposed_plan" -> TurnItem.Content.ProposedPlanContent(payload(TurnItem.ProposedPlan.serializer()))
        "todo_list" -> TurnItem.Content.TodoListContent(payload(TurnItem.TodoList.serializer()))
        "command_execution" -> TurnItem.Content.CommandExecutionContent(payload(TurnItem.CommandExecution.serializer()))
        "file_change" -> TurnItem.Content.FileChangeContent(payload(TurnItem.FileChange.serializer()))
        "file_search" -> TurnItem.Content.FileSearchContent(payload(TurnItem.FileSearch.serializer()))
        "web_search" -> TurnItem.Content.WebSearchContent(payload(TurnItem.WebSearch.serializer()))
        "approval_request" -> TurnItem.Content.ApprovalRequestContent(payload(ApprovalRequestSerializer))
        "user_input_request" -> TurnItem.Content.UserInputRequestContent(payload(TurnItem.UserInputRequest.serializer()))
        "dynamic_tool" -> TurnItem.Content.DynamicToolContent(payload(TurnItem.DynamicTool.serializer()))
        "subagent" -> TurnItem.Content.SubagentContent(payload(TurnItem.Subagent.serializer()))
        "error" -> TurnItem.Content.ErrorContent(payload(TurnItem.ErrorReport.serializer()))
        "system_notice" -> TurnItem.Content.SystemNoticeContent(payload(TurnItem.SystemNotice.serializer()))
        "access_request" -> TurnItem.Content.AccessRequestContent(payload(TurnItem.AccessRequest.serializer()))
        else -> TurnItem.Content.NotificationContent(payload(ThreadNotification.serializer()))
    }

    override fun JsonWriter.write(value: TurnItem) {
        val content = value.content
        if (content is TurnItem.Content.Unknown) {
            merge(content.raw)
            return
        }
        put("type", value.type)
        put("id", value.id)
        put("threadId", value.threadId)
        put("runId", value.runId)
        put("nodeId", value.nodeId)
        put("providerThreadId", value.providerThreadId)
        put("providerTurnId", value.providerTurnId)
        value.nativeItemRef?.let { members["nativeItemRef"] = it }
        put("parentItemId", value.parentItemId)
        put("ordinal", value.ordinal)
        put("status", value.status)
        put("title", value.title)
        putInstant("startedAt", value.startedAt)
        putInstant("completedAt", value.completedAt)
        putInstant("updatedAt", value.updatedAt)
        put("toolNonExecutionKind", value.toolNonExecutionKind)
        put("toolSurface", value.toolSurface)
        value.toolIcon?.let { members["toolIcon"] = it }
        put("toolSource", value.toolSource)
        val payload: JsonElement = when (content) {
            is TurnItem.Content.UserMessageContent -> json.encodeToJsonElement(TurnItem.UserMessage.serializer(), content.value)
            is TurnItem.Content.AssistantMessageContent -> json.encodeToJsonElement(TurnItem.AssistantMessage.serializer(), content.value)
            is TurnItem.Content.ReasoningContent -> json.encodeToJsonElement(TurnItem.Reasoning.serializer(), content.value)
            is TurnItem.Content.ProposedPlanContent -> json.encodeToJsonElement(TurnItem.ProposedPlan.serializer(), content.value)
            is TurnItem.Content.TodoListContent -> json.encodeToJsonElement(TurnItem.TodoList.serializer(), content.value)
            is TurnItem.Content.CommandExecutionContent -> json.encodeToJsonElement(TurnItem.CommandExecution.serializer(), content.value)
            is TurnItem.Content.FileChangeContent -> json.encodeToJsonElement(TurnItem.FileChange.serializer(), content.value)
            is TurnItem.Content.FileSearchContent -> json.encodeToJsonElement(TurnItem.FileSearch.serializer(), content.value)
            is TurnItem.Content.WebSearchContent -> json.encodeToJsonElement(TurnItem.WebSearch.serializer(), content.value)
            is TurnItem.Content.ApprovalRequestContent -> json.encodeToJsonElement(ApprovalRequestSerializer, content.value)
            is TurnItem.Content.UserInputRequestContent -> json.encodeToJsonElement(TurnItem.UserInputRequest.serializer(), content.value)
            is TurnItem.Content.DynamicToolContent -> json.encodeToJsonElement(TurnItem.DynamicTool.serializer(), content.value)
            is TurnItem.Content.SubagentContent -> json.encodeToJsonElement(TurnItem.Subagent.serializer(), content.value)
            is TurnItem.Content.ErrorContent -> json.encodeToJsonElement(TurnItem.ErrorReport.serializer(), content.value)
            is TurnItem.Content.SystemNoticeContent -> json.encodeToJsonElement(TurnItem.SystemNotice.serializer(), content.value)
            is TurnItem.Content.NotificationContent -> json.encodeToJsonElement(ThreadNotification.serializer(), content.value)
            is TurnItem.Content.AccessRequestContent -> json.encodeToJsonElement(TurnItem.AccessRequest.serializer(), content.value)
            is TurnItem.Content.Unknown -> JsonObject(emptyMap())
        }
        merge(payload)
    }
}

// MARK: - Shared parts

/** Who ran a browser, computer or integration tool. */
@Serializable
data class ToolSource(
    val key: String,
    val name: String,
    /** `browser`, `computer` or `integration`. */
    val kind: String,
    val icon: JsonElement? = null,
)

@Serializable
data class PlanStep(
    val id: String,
    val text: String,
    val status: PlanStepStatus,
    /** Free-form ISO string the elapsed time counts from. */
    val durationAnchorAt: String? = null,
    /** Elapsed time of a completed step. */
    val durationMs: Int? = null,
)

@Serializable
data class UserInputQuestion(
    val id: String,
    val header: String = "",
    val question: String,
    val options: List<Option> = emptyList(),
    val multiSelect: Boolean? = null,
    val allowCustomAnswer: Boolean? = null,
    val required: Boolean? = null,
) {
    @Serializable
    data class Option(
        val label: String,
        val description: String,
        /** The value to answer with; the label when absent. */
        val value: String? = null,
        val recommended: Boolean? = null,
    ) {
        val answerValue: String get() = value ?: label
    }
}

/** One approval choice a provider offers. */
@Serializable
data class ApprovalOption(
    val decision: ProviderApprovalDecision,
    val label: String,
    /** A caution shown next to the option. */
    val warning: String? = null,
)

/** A provider failure, already redacted by the server. */
@Serializable
data class ProviderFailure(
    @SerialName("class") val failureClass: ProviderFailureClass,
    val message: String,
    val code: String? = null,
    val retryable: Boolean? = null,
    /** Free-form ISO string; absent when the provider names no reset time. */
    val resetAt: String? = null,
)

@Serializable
data class ProviderRetry(val attempt: Int, val maxAttempts: Int? = null, val retryDelayMs: Int? = null)

@Serializable
data class FileChangeDetail(
    val operation: String,
    val path: String,
    val oldPath: String? = null,
    val diffStr: String? = null,
    val fileType: String? = null,
    val mimeType: String? = null,
)

@Serializable
data class FileSearchResult(val fileName: String, val line: Int? = null, val column: Int? = null, val preview: String? = null)

@Serializable
data class WebSearchResult(val title: String? = null, val url: String? = null, val snippet: String? = null)

/** A report on background work: a subagent, a command, a delegated task. */
@Serializable
data class ThreadNotification(
    val source: NotificationSource,
    val outcome: NotificationOutcome,
    val summary: String,
    val detail: String? = null,
)

/**
 * What a notification reports on. Servers send a subagent as
 * `{"kind":"background_task","work":"subagent"}` and a command as `background_command`.
 */
@Serializable
data class NotificationSource(
    val kind: String,
    val work: String? = null,
    val childThreadId: String? = null,
    /** For `delegated_task`. */
    val taskIds: List<String>? = null,
) {
    val isSubagent: Boolean get() = kind == "subagent" || (kind == "background_task" && work == "subagent")
    val isCommand: Boolean get() = kind == "command" || kind == "background_command"
    val isDelegatedTask: Boolean get() = kind == "delegated_task"

    /** The kind with the legacy spellings folded: `subagent`, `command`, `monitor`, `delegated_task` or `background_task`. */
    val normalizedKind: String
        get() = when {
            isSubagent -> "subagent"
            isCommand -> "command"
            kind == "monitor" || kind == "delegated_task" -> kind
            else -> "background_task"
        }
}

/**
 * A row of `visibleTurnItems`: an item placed in this thread's timeline, possibly inherited
 * from the thread it was forked from.
 */
@Serializable
data class ProjectedTurnItem(
    val position: Int,
    val visibility: TurnItemVisibility = TurnItemVisibility.Local,
    val sourceThreadId: String,
    val sourceItemId: String,
    val item: TurnItem,
) {
    val id: String get() = "$sourceThreadId/$sourceItemId"
}
