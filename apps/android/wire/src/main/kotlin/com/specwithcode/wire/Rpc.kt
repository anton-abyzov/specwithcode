package com.specwithcode.wire

import kotlinx.serialization.Serializable

/** RPC method tags the app calls. Payload and result types are noted on each entry. */
enum class RpcMethod(val tag: String) {
    /** `EmptyInput` -> the machine's archived threads. */
    OrchestrationGetArchivedShellSnapshot("orchestration.getArchivedShellSnapshot"),

    /** `EmptyInput` -> `{}`. */
    ServerProbe("server.probe"),

    /** `EmptyInput` -> `ServerConfig`. */
    ServerGetConfig("server.getConfig"),

    /** `EmptyInput` -> `ServerSettings`. */
    ServerGetSettings("server.getSettings"),

    /** `UpdateServerSettingsInput` -> `ServerSettings`. */
    ServerUpdateSettings("server.updateSettings"),

    /** `SubscribeServerConfigInput` -> stream of `ServerConfigStreamItem`. */
    SubscribeServerConfig("subscribeServerConfig"),

    /** `SubscribeShellInput` -> stream of `ShellStreamItem`. */
    SubscribeShell("orchestration.subscribeShell"),

    /** `SubscribeThreadInput` -> stream of `ThreadStreamItem`. */
    SubscribeThread("orchestration.subscribeThread"),

    /** `GetThreadProjectionInput` -> `ThreadProjection`. */
    GetThreadProjection("orchestration.getThreadProjection"),

    /** `GetTurnItemInput` -> `GetTurnItemResult`. */
    GetTurnItem("orchestration.getTurnItem"),

    /** `OrchestrationCommand` -> `DispatchResult`. */
    DispatchCommand("orchestration.dispatchCommand"),

    /** `ThreadLaunchInput` -> `ThreadLaunchResult`. */
    LaunchThread("orchestration.launchThread"),

    /** `CoordinatorSendInput` -> `CoordinatorResult`. */
    CoordinatorSend("projects.coordinatorSend"),

    /** `{type, name, mimeType, sizeBytes}` -> `AttachmentUploadTicket`. */
    AttachmentsCreateUploadUrl("attachments.createUploadUrl"),

    /** `{resource}` -> `{relativeUrl}`. */
    AssetsCreateUrl("assets.createUrl"),

    /** `CoordinatorStartInput` -> `CoordinatorResult`. */
    CoordinatorStart("projects.coordinatorStart"),

    /** `WorkspaceReadInput` -> `WorkspaceReadResult`. */
    WorkspaceRead("projects.workspaceRead"),

    /** `ProjectUpdateCommand` -> `ProjectShell`. */
    ProjectsMutate("projects.mutate"),

    /** `CreateNewProjectInput` -> `CreateNewProjectResult`. */
    CreateNewProject("projects.createNew"),

    /** `EmptyInput` -> `EnsureScratchResult`. */
    EnsureScratch("projects.ensureScratch"),

    /** `EmptyInput` -> stream of `DeviceServiceState`. */
    SubscribeDeviceState("subscribeDeviceState"),

    /** `AccessAnswerRequestInput` -> void. */
    AccessAnswerRequest("access.answerRequest"),
    ;

    /** True for methods that answer with a stream of chunks. */
    val isStream: Boolean
        get() = this == SubscribeServerConfig || this == SubscribeShell || this == SubscribeThread || this == SubscribeDeviceState

    companion object {
        fun fromTag(tag: String): RpcMethod? = entries.firstOrNull { it.tag == tag }
    }
}

/** The `{}` payload of methods that take no input. */
@Serializable
class EmptyInput {
    override fun equals(other: Any?): Boolean = other is EmptyInput
    override fun hashCode(): Int = 0
}

/**
 * `orchestration.subscribeShell`. Pass a cached snapshot's sequence as `afterSequence`
 * to resume without a new snapshot.
 */
@Serializable(with = SubscribeShellInputSerializer::class)
data class SubscribeShellInput(
    val afterSequence: Int? = null,
    /**
     * Ask for `synchronized` between catch-up and live updates. Send `true` only when the
     * server's config sets `shellResumeCompletionMarker`.
     */
    val requestCompletionMarker: Boolean? = null,
)

object SubscribeShellInputSerializer : ObjectSerializer<SubscribeShellInput>("SubscribeShellInput") {
    override fun JsonReader.read() = SubscribeShellInput(optInt("afterSequence"), optBool("requestCompletionMarker"))
    override fun JsonWriter.write(value: SubscribeShellInput) {
        put("afterSequence", value.afterSequence)
        put("requestCompletionMarker", value.requestCompletionMarker)
    }
}

/** `orchestration.subscribeThread`. */
@Serializable(with = SubscribeThreadInputSerializer::class)
data class SubscribeThreadInput(
    val threadId: String,
    val afterSequence: Int? = null,
    /** Send `true` only when the server's config sets `threadResumeCompletionMarker`. */
    val requestCompletionMarker: Boolean? = null,
    /** Allow a bounded snapshot with pageable history. */
    val acceptBoundedSnapshot: Boolean? = null,
)

object SubscribeThreadInputSerializer : ObjectSerializer<SubscribeThreadInput>("SubscribeThreadInput") {
    override fun JsonReader.read() = SubscribeThreadInput(
        string("threadId"), optInt("afterSequence"), optBool("requestCompletionMarker"), optBool("acceptBoundedSnapshot"),
    )

    override fun JsonWriter.write(value: SubscribeThreadInput) {
        put("threadId", value.threadId)
        put("afterSequence", value.afterSequence)
        put("requestCompletionMarker", value.requestCompletionMarker)
        put("acceptBoundedSnapshot", value.acceptBoundedSnapshot)
    }
}

/** `subscribeServerConfig`. */
@Serializable
data class SubscribeServerConfigInput(
    val environmentThemes: Boolean? = null,
    val usageLimitSources: Boolean? = null,
)

@Serializable
data class GetThreadProjectionInput(val threadId: String)

/** `orchestration.getTurnItem`: one item with its full output, for items sent with `outputOmitted`. */
@Serializable
data class GetTurnItemInput(
    val threadId: String,
    val itemId: String,
    /** The item `updatedAt` last seen; only keys the server's cache. */
    val revision: String? = null,
)

@Serializable
data class GetTurnItemResult(val item: TurnItem? = null)

/** Result of `orchestration.dispatchCommand`: the event sequence the command produced. */
@Serializable
data class DispatchResult(val sequence: Int)

/** Result of `projects.ensureScratch`. */
@Serializable
data class EnsureScratchResult(val projectId: String)
