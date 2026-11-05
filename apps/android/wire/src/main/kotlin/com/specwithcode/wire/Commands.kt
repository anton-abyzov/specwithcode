package com.specwithcode.wire

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.time.Instant

// Payloads of `orchestration.dispatchCommand` and `orchestration.launchThread`. Optional
// keys are omitted when null, never sent as null. Mint `commandId` and `messageId` once (a
// UUID) and reuse them on retry; the server dedupes.

/** A command for `orchestration.dispatchCommand`. Returns `DispatchResult`. */
@Serializable(with = OrchestrationCommandSerializer::class)
sealed interface OrchestrationCommand {
    data class MessageDispatch(val command: MessageDispatchCommand) : OrchestrationCommand
    data class RunInterrupt(val command: RunInterruptCommand) : OrchestrationCommand
    data class RuntimeRequestRespond(val command: RuntimeRequestRespondCommand) : OrchestrationCommand
    data class ThreadPin(override val commandId: String, override val threadId: String, val orderKey: String? = null) : OrchestrationCommand
    data class ThreadUnpin(override val commandId: String, override val threadId: String) : OrchestrationCommand

    /** Resolve a thread, optionally with a one-line closing note. */
    data class ThreadSettle(
        override val commandId: String,
        override val threadId: String,
        val settledAt: Instant? = null,
        val note: String? = null,
    ) : OrchestrationCommand
    data class ThreadUnsettle(override val commandId: String, override val threadId: String) : OrchestrationCommand
    data class ThreadArchive(override val commandId: String, override val threadId: String) : OrchestrationCommand
    data class ThreadUnarchive(override val commandId: String, override val threadId: String) : OrchestrationCommand
    data class ThreadDelete(override val commandId: String, override val threadId: String) : OrchestrationCommand

    /** [visitedAt] is the shell's `updatedAt` the viewer has seen, as an ISO string. */
    data class ThreadVisit(override val commandId: String, override val threadId: String, val visitedAt: String) : OrchestrationCommand
    data class ThreadMarkUnread(override val commandId: String, override val threadId: String) : OrchestrationCommand
    data class ThreadMetadataUpdate(val command: ThreadMetadataUpdateCommand) : OrchestrationCommand

    /** Any other command, sent as is. */
    data class Other(val raw: JsonObject) : OrchestrationCommand

    val type: String
        get() = when (this) {
            is MessageDispatch -> "message.dispatch"
            is RunInterrupt -> "run.interrupt"
            is RuntimeRequestRespond -> "runtime-request.respond"
            is ThreadPin -> "thread.pin"
            is ThreadUnpin -> "thread.unpin"
            is ThreadSettle -> "thread.settle"
            is ThreadUnsettle -> "thread.unsettle"
            is ThreadArchive -> "thread.archive"
            is ThreadUnarchive -> "thread.unarchive"
            is ThreadDelete -> "thread.delete"
            is ThreadVisit -> "thread.visit"
            is ThreadMarkUnread -> "thread.mark-unread"
            is ThreadMetadataUpdate -> "thread.metadata.update"
            is Other -> raw["type"]?.stringValue ?: ""
        }

    val commandId: String
        get() = when (this) {
            is MessageDispatch -> command.commandId
            is RunInterrupt -> command.commandId
            is RuntimeRequestRespond -> command.commandId
            is ThreadMetadataUpdate -> command.commandId
            is Other -> raw["commandId"]?.stringValue ?: ""
            else -> error("unreachable")
        }

    val threadId: String
        get() = when (this) {
            is MessageDispatch -> command.threadId
            is RunInterrupt -> command.threadId
            is RuntimeRequestRespond -> command.threadId
            is ThreadMetadataUpdate -> command.threadId
            is Other -> raw["threadId"]?.stringValue ?: ""
            else -> error("unreachable")
        }

    companion object {
        /** `thread.visit` with a date, formatted like the server's ISO strings. */
        fun visit(commandId: String, threadId: String, at: Instant): OrchestrationCommand =
            ThreadVisit(commandId, threadId, WireDates.format(at))
    }
}

object OrchestrationCommandSerializer : ObjectSerializer<OrchestrationCommand>("OrchestrationCommand") {
    override fun JsonReader.read(): OrchestrationCommand {
        val type = optString("type") ?: ""
        return when (type) {
            "message.dispatch" -> OrchestrationCommand.MessageDispatch(MessageDispatchCommandSerializer.readFrom(raw, json))
            "run.interrupt" -> OrchestrationCommand.RunInterrupt(RunInterruptCommandSerializer.readFrom(raw, json))
            "runtime-request.respond" -> OrchestrationCommand.RuntimeRequestRespond(RuntimeRequestRespondCommandSerializer.readFrom(raw, json))
            "thread.metadata.update" -> OrchestrationCommand.ThreadMetadataUpdate(ThreadMetadataUpdateCommandSerializer.readFrom(raw, json))
            "thread.pin" -> OrchestrationCommand.ThreadPin(string("commandId"), string("threadId"), optString("orderKey"))
            "thread.settle" -> OrchestrationCommand.ThreadSettle(string("commandId"), string("threadId"), optInstant("settledAt"), optString("note"))
            "thread.visit" -> OrchestrationCommand.ThreadVisit(string("commandId"), string("threadId"), string("visitedAt"))
            "thread.unpin" -> OrchestrationCommand.ThreadUnpin(string("commandId"), string("threadId"))
            "thread.unsettle" -> OrchestrationCommand.ThreadUnsettle(string("commandId"), string("threadId"))
            "thread.archive" -> OrchestrationCommand.ThreadArchive(string("commandId"), string("threadId"))
            "thread.unarchive" -> OrchestrationCommand.ThreadUnarchive(string("commandId"), string("threadId"))
            "thread.delete" -> OrchestrationCommand.ThreadDelete(string("commandId"), string("threadId"))
            "thread.mark-unread" -> OrchestrationCommand.ThreadMarkUnread(string("commandId"), string("threadId"))
            else -> OrchestrationCommand.Other(raw)
        }
    }

    override fun JsonWriter.write(value: OrchestrationCommand) {
        when (value) {
            is OrchestrationCommand.MessageDispatch -> return merge(MessageDispatchCommandSerializer.writeTo(value.command, json))
            is OrchestrationCommand.RunInterrupt -> return merge(RunInterruptCommandSerializer.writeTo(value.command, json))
            is OrchestrationCommand.RuntimeRequestRespond -> return merge(RuntimeRequestRespondCommandSerializer.writeTo(value.command, json))
            is OrchestrationCommand.ThreadMetadataUpdate -> return merge(ThreadMetadataUpdateCommandSerializer.writeTo(value.command, json))
            is OrchestrationCommand.Other -> return merge(value.raw)
            else -> Unit
        }
        put("type", value.type)
        put("commandId", value.commandId)
        put("threadId", value.threadId)
        when (value) {
            is OrchestrationCommand.ThreadPin -> put("orderKey", value.orderKey)
            is OrchestrationCommand.ThreadSettle -> {
                putInstant("settledAt", value.settledAt)
                put("note", value.note)
            }
            is OrchestrationCommand.ThreadUnsettle -> put("reason", "user")
            is OrchestrationCommand.ThreadVisit -> put("visitedAt", value.visitedAt)
            else -> Unit
        }
    }
}

/** How a message joins the thread's work. */
@Serializable(with = DispatchModeSerializer::class)
sealed interface DispatchMode {
    /** Start a run now. Use when the thread is idle. */
    data object StartImmediately : DispatchMode

    /** Run after the active run finishes. */
    data object QueueAfterActive : DispatchMode

    /** Add the message to the active run. */
    data class SteerActive(val targetRunId: String) : DispatchMode

    /** Stop the active run and start again with this message. */
    data class RestartActive(val targetRunId: String) : DispatchMode

    /** Prepare the run without starting it. */
    data class DeferStart(val workspaceStrategy: WorkspaceStrategy? = null) : DispatchMode
}

object DispatchModeSerializer : ObjectSerializer<DispatchMode>("DispatchMode") {
    override fun JsonReader.read(): DispatchMode = when (string("type")) {
        "queue_after_active" -> DispatchMode.QueueAfterActive
        "steer_active" -> DispatchMode.SteerActive(string("targetRunId"))
        "restart_active" -> DispatchMode.RestartActive(string("targetRunId"))
        "defer_start" -> DispatchMode.DeferStart(opt("workspaceStrategy", WorkspaceStrategySerializer))
        else -> DispatchMode.StartImmediately
    }

    override fun JsonWriter.write(value: DispatchMode) {
        when (value) {
            DispatchMode.StartImmediately -> put("type", "start_immediately")
            DispatchMode.QueueAfterActive -> put("type", "queue_after_active")
            is DispatchMode.SteerActive -> {
                put("type", "steer_active")
                put("targetRunId", value.targetRunId)
            }
            is DispatchMode.RestartActive -> {
                put("type", "restart_active")
                put("targetRunId", value.targetRunId)
            }
            is DispatchMode.DeferStart -> {
                put("type", "defer_start")
                put("workspaceStrategy", value.workspaceStrategy, WorkspaceStrategySerializer)
            }
        }
    }
}

/** `message.dispatch`: send a message to a thread. */
@Serializable(with = MessageDispatchCommandSerializer::class)
data class MessageDispatchCommand(
    val commandId: String,
    val threadId: String,
    val messageId: String,
    val text: String,
    val dispatchMode: DispatchMode,
    val attachments: List<ChatAttachment> = emptyList(),
    /** Let the server pick steer or restart against its own state. */
    val deliveryIntent: DeliveryIntent? = null,
    val modelSelection: ModelSelection? = null,
    /** Seeds the temporary title of a new thread. */
    val titleSeed: String? = null,
    val sourcePlanRef: PlanRef? = null,
    val context: JsonElement? = null,
    val createdBy: ActorKind = ActorKind.User,
    val creationSource: CreationSource = CreationSource.Mobile,
)

object MessageDispatchCommandSerializer : ObjectSerializer<MessageDispatchCommand>("MessageDispatchCommand") {
    override fun JsonReader.read() = MessageDispatchCommand(
        commandId = string("commandId"),
        threadId = string("threadId"),
        messageId = string("messageId"),
        text = string("text"),
        dispatchMode = req("dispatchMode", DispatchModeSerializer),
        attachments = list("attachments"),
        deliveryIntent = opt("deliveryIntent"),
        modelSelection = opt("modelSelection"),
        titleSeed = optString("titleSeed"),
        sourcePlanRef = opt("sourcePlanRef"),
        context = element("context"),
        createdBy = opt("createdBy") ?: ActorKind.User,
        creationSource = opt("creationSource") ?: CreationSource.Mobile,
    )

    override fun JsonWriter.write(value: MessageDispatchCommand) {
        put("type", "message.dispatch")
        put("createdBy", value.createdBy)
        put("creationSource", value.creationSource)
        put("commandId", value.commandId)
        put("threadId", value.threadId)
        put("messageId", value.messageId)
        put("text", value.text)
        put("attachments", value.attachments)
        value.context?.let { members["context"] = it }
        put("titleSeed", value.titleSeed)
        put("modelSelection", value.modelSelection)
        put("sourcePlanRef", value.sourcePlanRef)
        put("deliveryIntent", value.deliveryIntent)
        put("dispatchMode", value.dispatchMode, DispatchModeSerializer)
    }
}

/**
 * `run.interrupt`. The Stop button sends `holdQueue: true`, which also holds queued messages
 * and stops the thread's delegated tasks.
 */
@Serializable(with = RunInterruptCommandSerializer::class)
data class RunInterruptCommand(
    val commandId: String,
    val threadId: String,
    val runId: String,
    val reason: String? = null,
    /** Who asked: `user` (the default when absent), `agent`, `service_update`, `delegated_cancel`. */
    val cause: String? = null,
    val holdQueue: Boolean? = true,
)

object RunInterruptCommandSerializer : ObjectSerializer<RunInterruptCommand>("RunInterruptCommand") {
    override fun JsonReader.read() = RunInterruptCommand(
        string("commandId"), string("threadId"), string("runId"), optString("reason"), optString("cause"), optBool("holdQueue"),
    )

    override fun JsonWriter.write(value: RunInterruptCommand) {
        put("type", "run.interrupt")
        put("commandId", value.commandId)
        put("threadId", value.threadId)
        put("runId", value.runId)
        put("reason", value.reason)
        put("cause", value.cause)
        put("holdQueue", value.holdQueue)
    }
}

/** An answer to one question of a user input request. */
@Serializable(with = UserInputAnswerSerializer::class)
sealed interface UserInputAnswer {
    data class Text(val text: String) : UserInputAnswer

    /** Several choices, for multi-select questions. */
    data class Choices(val choices: List<String>) : UserInputAnswer
    data class Other(val raw: JsonElement) : UserInputAnswer
}

object UserInputAnswerSerializer : ElementSerializer<UserInputAnswer>("UserInputAnswer") {
    override fun read(element: JsonElement, json: kotlinx.serialization.json.Json): UserInputAnswer {
        if (element is JsonPrimitive && element.isString) return UserInputAnswer.Text(element.content)
        if (element is JsonArray && element.all { it is JsonPrimitive && it.isString }) {
            return UserInputAnswer.Choices(element.map { (it as JsonPrimitive).content })
        }
        return UserInputAnswer.Other(element)
    }

    override fun write(value: UserInputAnswer, json: kotlinx.serialization.json.Json): JsonElement = when (value) {
        is UserInputAnswer.Text -> JsonPrimitive(value.text)
        is UserInputAnswer.Choices -> JsonArray(value.choices.map { JsonPrimitive(it) })
        is UserInputAnswer.Other -> value.raw
    }
}

/** `runtime-request.respond`: approve or decline a permission, or answer questions. */
@Serializable(with = RuntimeRequestRespondCommandSerializer::class)
data class RuntimeRequestRespondCommand(
    val commandId: String,
    val threadId: String,
    val requestId: String,
    val decision: ProviderApprovalDecision? = null,
    /** Answers by question id. */
    val answers: Map<String, UserInputAnswer>? = null,
)

object RuntimeRequestRespondCommandSerializer : ObjectSerializer<RuntimeRequestRespondCommand>("RuntimeRequestRespondCommand") {
    override fun JsonReader.read() = RuntimeRequestRespondCommand(
        string("commandId"), string("threadId"), string("requestId"), opt("decision"), opt("answers"),
    )

    override fun JsonWriter.write(value: RuntimeRequestRespondCommand) {
        put("type", "runtime-request.respond")
        put("commandId", value.commandId)
        put("threadId", value.threadId)
        put("requestId", value.requestId)
        put("decision", value.decision)
        put("answers", value.answers)
    }
}

/** `thread.metadata.update`: rename, regenerate the title, or move the checkout. */
@Serializable(with = ThreadMetadataUpdateCommandSerializer::class)
data class ThreadMetadataUpdateCommand(
    val commandId: String,
    val threadId: String,
    val title: String? = null,
    /** Start (true) or abandon (false) a title regeneration. */
    val regenerateTitle: Boolean? = null,
    val branch: Nullable<String>? = null,
    val worktreePath: Nullable<String>? = null,
    /** Reject unless nothing has landed on the thread yet. */
    val expectedEmpty: Boolean? = null,
)

object ThreadMetadataUpdateCommandSerializer : ObjectSerializer<ThreadMetadataUpdateCommand>("ThreadMetadataUpdateCommand") {
    override fun JsonReader.read() = ThreadMetadataUpdateCommand(
        string("commandId"), string("threadId"), optString("title"), optBool("regenerateTitle"),
        nullable("branch"), nullable("worktreePath"), optBool("expectedEmpty"),
    )

    override fun JsonWriter.write(value: ThreadMetadataUpdateCommand) {
        put("type", "thread.metadata.update")
        put("commandId", value.commandId)
        put("threadId", value.threadId)
        put("title", value.title)
        put("regenerateTitle", value.regenerateTitle)
        putNullable("branch", value.branch)
        putNullable("worktreePath", value.worktreePath)
        put("expectedEmpty", value.expectedEmpty)
    }
}

// MARK: - Launch

/** Where a new thread's run works. */
@Serializable(with = WorkspaceStrategySerializer::class)
sealed interface WorkspaceStrategy {
    /** The project checkout itself, optionally on a branch. */
    data class Root(val branch: String? = null) : WorkspaceStrategy
    data class ExistingWorktree(val worktreePath: String, val branch: String? = null, val repository: String? = null) : WorkspaceStrategy

    /** A new worktree from [baseRef]. */
    data class Worktree(
        val baseRef: String,
        val branch: String? = null,
        val startFromOrigin: Boolean? = null,
        val repository: String? = null,
    ) : WorkspaceStrategy
    data class Unknown(val raw: JsonObject) : WorkspaceStrategy
}

object WorkspaceStrategySerializer : ObjectSerializer<WorkspaceStrategy>("WorkspaceStrategy") {
    override fun JsonReader.read(): WorkspaceStrategy = when (optString("type")) {
        "root" -> WorkspaceStrategy.Root(optString("branch"))
        "existing_worktree" -> WorkspaceStrategy.ExistingWorktree(string("worktreePath"), optString("branch"), optString("repository"))
        "worktree" -> WorkspaceStrategy.Worktree(string("baseRef"), optString("branch"), optBool("startFromOrigin"), optString("repository"))
        else -> WorkspaceStrategy.Unknown(raw)
    }

    override fun JsonWriter.write(value: WorkspaceStrategy) {
        when (value) {
            is WorkspaceStrategy.Root -> {
                put("type", "root")
                put("branch", value.branch)
            }
            is WorkspaceStrategy.ExistingWorktree -> {
                put("type", "existing_worktree")
                put("worktreePath", value.worktreePath)
                put("branch", value.branch)
                put("repository", value.repository)
            }
            is WorkspaceStrategy.Worktree -> {
                put("type", "worktree")
                put("baseRef", value.baseRef)
                put("branch", value.branch)
                put("startFromOrigin", value.startFromOrigin)
                put("repository", value.repository)
            }
            is WorkspaceStrategy.Unknown -> merge(value.raw)
        }
    }
}

/** The first message of a launched thread. */
@Serializable
data class InitialMessage(
    val messageId: String? = null,
    val text: String,
    val attachments: List<ChatAttachment> = emptyList(),
    val context: JsonElement? = null,
)

/** `orchestration.launchThread`: create a thread and, optionally, start it with a message. */
@Serializable(with = ThreadLaunchInputSerializer::class)
data class ThreadLaunchInput(
    val commandId: String,
    val projectId: String,
    val title: String,
    val modelSelection: ModelSelection,
    val runtimeMode: RuntimeMode,
    val interactionMode: InteractionMode = InteractionMode.Default,
    val workspaceStrategy: WorkspaceStrategy = WorkspaceStrategy.Root(),
    val initialMessage: InitialMessage? = null,
    /** Replace [title] with a generated one after the first message. */
    val generateTitle: Boolean? = null,
    val threadId: String? = null,
    val reuseExistingThread: Boolean? = null,
    val creationSource: CreationSource? = CreationSource.Mobile,
)

object ThreadLaunchInputSerializer : ObjectSerializer<ThreadLaunchInput>("ThreadLaunchInput") {
    override fun JsonReader.read() = ThreadLaunchInput(
        commandId = string("commandId"),
        projectId = string("projectId"),
        title = string("title"),
        modelSelection = req("modelSelection"),
        runtimeMode = req("runtimeMode"),
        interactionMode = req("interactionMode"),
        workspaceStrategy = req("workspaceStrategy", WorkspaceStrategySerializer),
        initialMessage = opt("initialMessage"),
        generateTitle = optBool("generateTitle"),
        threadId = optString("threadId"),
        reuseExistingThread = optBool("reuseExistingThread"),
        creationSource = opt("creationSource"),
    )

    override fun JsonWriter.write(value: ThreadLaunchInput) {
        put("commandId", value.commandId)
        put("creationSource", value.creationSource)
        put("threadId", value.threadId)
        put("reuseExistingThread", value.reuseExistingThread)
        put("projectId", value.projectId)
        put("title", value.title)
        put("generateTitle", value.generateTitle)
        put("modelSelection", value.modelSelection)
        put("runtimeMode", value.runtimeMode)
        put("interactionMode", value.interactionMode)
        put("workspaceStrategy", value.workspaceStrategy, WorkspaceStrategySerializer)
        put("initialMessage", value.initialMessage)
    }
}

/** Result of `orchestration.launchThread`. */
@Serializable
data class ThreadLaunchResult(
    val threadId: String,
    val projection: ThreadProjection,
    /** An existing thread was reused. */
    val resumed: Boolean = false,
)
