package com.specwithcode.sync

import com.specwithcode.wire.AccessRequestScope
import com.specwithcode.wire.AccessRequestStatus
import com.specwithcode.wire.ApprovalOption
import com.specwithcode.wire.ChatAttachment
import com.specwithcode.wire.MessageRole
import com.specwithcode.wire.PlanArtifact
import com.specwithcode.wire.PlanStatus
import com.specwithcode.wire.PlanStep
import com.specwithcode.wire.PlanStepStatus
import com.specwithcode.wire.ProviderApprovalDecision
import com.specwithcode.wire.RunStatus
import com.specwithcode.wire.RuntimeRequest
import com.specwithcode.wire.RuntimeRequestKind
import com.specwithcode.wire.ThreadProjection
import com.specwithcode.wire.TurnItem
import com.specwithcode.wire.TurnItemStatus
import com.specwithcode.wire.TurnItemVisibility
import com.specwithcode.wire.WireJson
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.time.Duration
import kotlin.math.roundToLong

/** A user message the machine holds, for matching optimistic rows to their echo. */
data class ReceivedUserMessage(val id: String, val messageId: String, val text: String)

/** Maps a thread projection to the rows and composer state a [ChatSession] shows. */
object TranscriptMapper {
    /** Rows in timeline order, then messages waiting in the queue. Item types this build does not know are skipped. */
    fun rows(projection: ThreadProjection, environmentId: String): List<TranscriptRow> {
        val requests = projection.runtimeRequests.associateBy { it.id }
        val timeline = projection.visibleTurnItems.sortedBy { it.position }.mapNotNull { row ->
            kind(row.item, requests, environmentId)?.let { TranscriptRow(row.id, placed(it, row.visibility)) }
        }
        return timeline + queuedRows(projection)
    }

    /**
     * Messages queued behind the active run. They have no turn item until their run starts, so
     * they come from the runs and messages, in queue order. Automatic notification runs are left out.
     */
    internal fun queuedRows(projection: ThreadProjection): List<TranscriptRow> {
        val inTimeline = userMessages(projection).map { it.messageId }.toSet()
        val messages = projection.messages.associateBy { it.id }
        return projection.runs
            .filter { it.status == RunStatus.Queued && it.userMessageId !in inTimeline }
            .sortedWith(compareBy({ it.queuePosition ?: it.ordinal }, { it.ordinal }))
            .mapNotNull { run ->
                val message = messages[run.userMessageId]
                if (message?.notification != null) return@mapNotNull null
                val state = if (run.queueHeld == true) UserMessageState.Held else UserMessageState.Queued
                TranscriptRow(
                    "queued:${run.id}",
                    TranscriptRow.Kind.User(message?.text ?: "Queued message", state, (message?.attachments ?: emptyList()).map(::attachment)),
                )
            }
    }

    /** An access request inherited from another thread (a fork, or synthetic) is not answered here. */
    internal fun placed(kind: TranscriptRow.Kind, visibility: TurnItemVisibility): TranscriptRow.Kind {
        if (kind !is TranscriptRow.Kind.Access || visibility == TurnItemVisibility.Local) return kind
        return TranscriptRow.Kind.Access(kind.request.copy(isInherited = true))
    }

    /** Whole seconds a settled thought took; null while streaming or unmeasured (replayed items). */
    internal fun thoughtSeconds(item: TurnItem): Int? {
        val started = item.startedAt ?: return null
        val completed = item.completedAt ?: return null
        val seconds = (Duration.between(started, completed).toMillis() / 1000.0).roundToLong().toInt()
        return if (seconds >= 1) seconds else null
    }

    fun kind(item: TurnItem, requests: Map<String, RuntimeRequest> = emptyMap(), environmentId: String): TranscriptRow.Kind? =
        when (val content = item.content) {
            is TurnItem.Content.UserMessageContent ->
                TranscriptRow.Kind.User(content.value.text, attachments = content.value.attachments.map(::attachment))

            is TurnItem.Content.AssistantMessageContent ->
                TranscriptRow.Kind.Assistant(content.value.text, content.value.streaming)

            is TurnItem.Content.ReasoningContent -> {
                val reasoning = content.value
                if (reasoning.text.isEmpty() && !reasoning.streaming) null
                else TranscriptRow.Kind.Reasoning(reasoning.text, reasoning.streaming, thoughtSeconds(item))
            }

            is TurnItem.Content.CommandExecutionContent -> {
                val command = content.value
                val failed = command.outputIndicatesFailure == true || (command.exitCode?.let { it != 0 } ?: false)
                TranscriptRow.Kind.Tool("Ran ${firstLine(command.input)}", detail(command.output), "terminal", toolStatus(item.status, failed))
            }

            is TurnItem.Content.FileChangeContent -> {
                val change = content.value
                val count = change.changes?.size ?: 0
                val title = if (count > 1) "Edited $count files" else "Edited ${fileName(change.fileName)}"
                TranscriptRow.Kind.Tool(title, lineCounts(change.additions, change.deletions), "pencil", toolStatus(item.status))
            }

            is TurnItem.Content.FileSearchContent -> {
                val search = content.value
                val title = search.pattern?.let { "Searched for ${firstLine(it)}" } ?: "Searched files"
                TranscriptRow.Kind.Tool(title, search.results?.let(::resultCount), "magnifyingglass", toolStatus(item.status))
            }

            is TurnItem.Content.WebSearchContent -> {
                val search = content.value
                val title = search.patterns?.firstOrNull()?.let { "Searched the web for ${firstLine(it)}" } ?: "Searched the web"
                TranscriptRow.Kind.Tool(title, search.results?.let(::resultCount), "globe", toolStatus(item.status))
            }

            is TurnItem.Content.DynamicToolContent -> {
                val tool = content.value
                val name = tool.toolName ?: item.title ?: item.toolSource?.name ?: "Tool"
                val presentation = ToolPresentation(name, tool.output, toolStatus(item.status) == ToolStatus.Failed)
                TranscriptRow.Kind.Tool(presentation.title, presentation.detail, "wrench.and.screwdriver", toolStatus(item.status, presentation.failed))
            }

            is TurnItem.Content.TodoListContent -> TranscriptRow.Kind.Plan(content.value.steps.map(::todoStep))

            is TurnItem.Content.ProposedPlanContent -> TranscriptRow.Kind.ProposedPlan(content.value.markdown)

            is TurnItem.Content.ApprovalRequestContent -> {
                val request = content.value
                val resolved = requests[request.requestId]?.let { !it.isPending } ?: !item.isInFlight
                TranscriptRow.Kind.Approval(
                    requestId = request.requestId,
                    prompt = request.prompt ?: approvalPrompt(request.requestKind, request.appName),
                    resolved = resolved,
                    kind = request.requestKind.rawValue,
                    options = (request.options ?: emptyList()).mapNotNull(::approvalChoice),
                )
            }

            is TurnItem.Content.UserInputRequestContent -> {
                val request = content.value
                val resolved = requests[request.requestId]?.let { !it.isPending } ?: (request.isAnswered || !item.isInFlight)
                val prompt = request.questions.map { it.question }.filter { it.isNotEmpty() }.joinToString("\n")
                TranscriptRow.Kind.Question(request.requestId, prompt.ifEmpty { "A question is waiting for your answer." }, resolved)
            }

            is TurnItem.Content.AccessRequestContent -> TranscriptRow.Kind.Access(accessRow(content.value, item))

            is TurnItem.Content.SubagentContent -> {
                val subagent = content.value
                val title = item.title ?: firstLine(subagent.prompt)
                TranscriptRow.Kind.Subagent(
                    title.ifEmpty { "Subagent" },
                    subagent.childThreadId?.let { ThreadRef(environmentId, it) },
                    isRunning = item.isInFlight,
                )
            }

            is TurnItem.Content.ErrorContent ->
                TranscriptRow.Kind.Error(content.value.failure.message.ifEmpty { "Something went wrong." })

            is TurnItem.Content.SystemNoticeContent -> TranscriptRow.Kind.Notice(content.value.message)

            is TurnItem.Content.NotificationContent -> TranscriptRow.Kind.Notice(content.value.summary)

            is TurnItem.Content.Unknown -> null
        }

    /** A run holds the thread now. */
    fun isRunning(projection: ThreadProjection): Boolean = projection.activeRun != null

    /** The latest run's predicted next prompt, once that run has completed, as the machine's setting allows. */
    fun promptSuggestion(projection: ThreadProjection, mode: String = "all"): String? {
        if (mode == "off") return null
        val run = projection.latestRun ?: return null
        if (run.status != RunStatus.Completed) return null
        if (mode == "native" && run.promptSuggestion?.source == "generated") return null
        return run.promptSuggestion?.text?.trim()?.ifEmpty { null }
    }

    fun queuedCount(projection: ThreadProjection): Int = projection.runs.count { it.status == RunStatus.Queued }

    /** Progress of the current todo list: the newest one not superseded. */
    fun planProgress(projection: ThreadProjection): PlanProgress? {
        for (plan in projection.plans.asReversed()) {
            if (plan.status == PlanStatus.Superseded) continue
            val content = plan.content as? PlanArtifact.Content.TodoList ?: continue
            if (content.steps.isEmpty()) continue
            return PlanProgress(content.steps.count { it.status == PlanStepStatus.Completed }, content.steps.size)
        }
        return null
    }

    /** User message items, for matching optimistic rows to their echo. */
    internal fun userMessages(projection: ThreadProjection): List<ReceivedUserMessage> = projection.turnItems.mapNotNull { item ->
        val content = item.content as? TurnItem.Content.UserMessageContent ?: return@mapNotNull null
        ReceivedUserMessage(item.id, content.value.messageId, content.value.text)
    }

    /**
     * Every user message the machine holds: timeline items, then messages that have none yet
     * (queued ones). Ids of the latter are prefixed so the two kinds never collide.
     */
    fun receivedUserMessages(projection: ThreadProjection): List<ReceivedUserMessage> {
        val items = userMessages(projection)
        val inTimeline = items.map { it.messageId }.toSet()
        val waiting = projection.messages
            .filter { it.role == MessageRole.User && it.id !in inTimeline }
            .map { ReceivedUserMessage("message:${it.id}", it.id, it.text) }
        return items + waiting
    }

    // Helpers

    internal fun attachment(value: ChatAttachment) =
        TranscriptAttachment(id = value.id, name = value.name, mimeType = value.mimeType, isImage = value.isImage)

    internal fun todoStep(step: PlanStep): TodoStep {
        val status = when (step.status) {
            PlanStepStatus.Completed -> TodoStep.Status.Completed
            PlanStepStatus.Running -> TodoStep.Status.Running
            else -> TodoStep.Status.Pending
        }
        return TodoStep(step.id, step.text, status)
    }

    internal fun toolStatus(status: TurnItemStatus, failed: Boolean = false): ToolStatus = when (status) {
        TurnItemStatus.Pending, TurnItemStatus.Running, TurnItemStatus.Waiting -> ToolStatus.Running
        TurnItemStatus.Failed, TurnItemStatus.Cancelled, TurnItemStatus.Interrupted -> ToolStatus.Failed
        else -> if (failed) ToolStatus.Failed else ToolStatus.Completed
    }

    internal fun approvalChoice(option: ApprovalOption): ApprovalChoice? {
        val decision = when (option.decision) {
            ProviderApprovalDecision.Accept -> ApprovalDecision.Approve
            ProviderApprovalDecision.AcceptForSession -> ApprovalDecision.ApproveForSession
            ProviderApprovalDecision.AcceptAlways -> ApprovalDecision.ApproveAlways
            ProviderApprovalDecision.Decline -> ApprovalDecision.Deny
            ProviderApprovalDecision.Cancel -> ApprovalDecision.Cancel
            // A choice this version does not know is left out rather than sent as another.
            else -> return null
        }
        return ApprovalChoice(decision, option.label, option.warning)
    }

    internal fun accessRow(request: TurnItem.AccessRequest, item: TurnItem): AccessRequestRow {
        val subjects = request.subjects.map { subject ->
            AccessRequestRow.Subject(
                kind = subject.kind.rawValue,
                key = subject.key,
                label = subject.label,
                detail = subject.detail,
                hostLabel = subject.hostLabel,
                platform = subject.platform,
                iconPng = subject.icon?.takeIf { it.mimeType == "image/png" }?.pngData,
            )
        }
        return AccessRequestRow(item.threadId, item.id, request.accessTitle, request.reason, subjects, accessState(request))
    }

    internal fun accessState(request: TurnItem.AccessRequest): AccessRequestRow.State = when (request.accessStatus) {
        AccessRequestStatus.Pending -> AccessRequestRow.State.Pending
        AccessRequestStatus.Allowed ->
            if (request.accessScope == AccessRequestScope.Machine) AccessRequestRow.State.AllowedOnMachine else AccessRequestRow.State.AllowedInThread
        AccessRequestStatus.Denied -> AccessRequestRow.State.Denied
        // Cancelled, or a status this build does not know: nothing left to answer.
        else -> AccessRequestRow.State.Ended
    }

    internal fun approvalPrompt(kind: RuntimeRequestKind, appName: String?): String = when (kind) {
        RuntimeRequestKind.Command -> "Allow this command?"
        RuntimeRequestKind.FileRead -> "Allow reading these files?"
        RuntimeRequestKind.FileChange -> "Allow these file changes?"
        RuntimeRequestKind.McpElicitation -> appName?.let { "$it is asking for input." } ?: "A tool is asking for input."
        RuntimeRequestKind.DynamicToolCall -> "Allow this tool call?"
        else -> "Allow this action?"
    }

    private fun resultCount(results: List<*>): String = if (results.size == 1) "1 result" else "${results.size} results"

    internal fun lineCounts(additions: Int?, deletions: Int?): String? =
        if (additions == null && deletions == null) null else "+${additions ?: 0} −${deletions ?: 0}"

    internal fun fileName(path: String): String {
        val name = path.trimEnd('/').substringAfterLast('/')
        return name.ifEmpty { path }
    }

    internal fun firstLine(text: String): String {
        val line = text.lineSequence().firstOrNull { it.isNotEmpty() } ?: text
        val trimmed = line.trim()
        return if (trimmed.length > 200) trimmed.take(200) + "…" else trimmed
    }

    internal fun detail(output: String?): String? {
        val trimmed = output?.trim() ?: return null
        if (trimmed.isEmpty()) return null
        val limit = 2_000
        return if (trimmed.length > limit) "…" + trimmed.takeLast(limit) else trimmed
    }
}

/**
 * Human-facing activity titles. The exact provider tool name stays in the detail, including
 * for unknown tools. Success is never inferred from text.
 */
class ToolPresentation(name: String, output: JsonElement?, itemFailed: Boolean = false) {
    val title: String
    val detail: String
    val failed: Boolean

    init {
        val action = name.substringAfterLast('.')
        val key = action.substringAfterLast("__")
        title = names[key] ?: "Use tool"
        var failure: String? = null
        if (output is JsonObject && (itemFailed || output["isError"] == JsonPrimitive(true))) {
            val content = output["content"]
            if (content is JsonArray) {
                failure = content.mapNotNull { block ->
                    ((block as? JsonObject)?.get("text") as? JsonPrimitive)?.takeIf { it.isString }?.content
                }.joinToString("\n")
            }
            if (failure.isNullOrEmpty()) failure = (output["message"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            if (failure.isNullOrEmpty()) failure = "The tool reported an error."
        }
        if (failure == null && itemFailed && output != null) {
            failure = if (output is JsonPrimitive && output.isString) output.content else WireJson.encodeToString(JsonElement.serializer(), output)
        }
        failed = itemFailed || failure != null
        detail = failure?.let { "$it\nTool: $name" } ?: "Tool: $name"
    }

    private companion object {
        val names = mapOf(
            "studio_thread_list" to "Find conversations",
            "studio_thread_read" to "Read conversation",
            "studio_thread_send" to "Send to conversation",
            "studio_thread_launch" to "Start conversation",
            "studio_project_list" to "Find projects",
            "studio_project_memory_read" to "Read project notes",
            "studio_project_memory_write" to "Save project note",
            "studio_project_knowledge_search" to "Search project knowledge",
            "studio_project_knowledge_read" to "Read project knowledge",
            "update_plan" to "Update provider checklist",
            "request_user_input" to "Ask a question",
            "exec_command" to "Run command",
            "apply_patch" to "Edit files",
        )
    }
}
