package com.specwithcode.wire

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonNull

/**
 * `projectLink.*` methods the app calls for a project linked across machines. The server's
 * own names; the phone reuses what the desktop app calls.
 */
enum class ProjectLinkMethod(val tag: String) {
    /** `ProjectTakeoverInput` -> `ProjectTakeoverResult`. Settings write and operate. */
    Takeover("projectLink.takeover"),

    /** `ProjectAcceptStandbyInput` -> result ignored. Settings write and operate. */
    AcceptStandby("projectLink.acceptStandby"),

    /** `ProjectLinkSyncStatusInput` -> `ProjectLinkSyncStatus`. Orchestration read. */
    SyncStatus("projectLink.syncStatus"),
}

/**
 * Member machine, while the coordinator's machine is unreachable: make this copy the
 * coordinator at the next epoch, with the old one as predecessor.
 */
@Serializable
data class ProjectTakeoverInput(
    /** A lowercase v4 UUID; a retry reuses it. */
    val operationId: String,
    val projectId: String,
    /** The highest epoch any copy is known at; the new one is above it. */
    val knownEpoch: Int? = null,
    /** The coordinator being replaced, as the app last saw it. */
    val predecessor: LogicalProjectMember? = null,
)

@Serializable
data class ProjectTakeoverResult(
    val operationId: String,
    val logicalProject: LogicalProject,
    val coordinatorBinding: CoordinatorBinding,
    /** When the replica this copy started from was taken; null without one. */
    val replicaFrom: String? = null,
    val replayed: Boolean = false,
)

/**
 * Disarms a standby registered for an older coordinator after a person took over, as the
 * desktop does: `standby` is sent as an explicit null.
 */
@Serializable(with = ProjectStandbyDisarmInputSerializer::class)
data class ProjectStandbyDisarmInput(
    val projectId: String,
    val logicalProjectId: String,
    /** Disarm only a registration below this epoch; a newer one stays. */
    val belowEpoch: Int,
)

object ProjectStandbyDisarmInputSerializer : ObjectSerializer<ProjectStandbyDisarmInput>("ProjectStandbyDisarmInput") {
    override fun JsonReader.read() = ProjectStandbyDisarmInput(string("projectId"), string("logicalProjectId"), int("belowEpoch"))

    override fun JsonWriter.write(value: ProjectStandbyDisarmInput) {
        put("projectId", value.projectId)
        put("logicalProjectId", value.logicalProjectId)
        members["standby"] = JsonNull
        put("belowEpoch", value.belowEpoch)
    }
}

@Serializable
data class ProjectLinkSyncStatusInput(val projectId: String)

object LossySyncPairs : LossyListSerializer<LinkedServerSyncPair>(LinkedServerSyncPair.serializer())
object LenientStandbyRearm : LenientSerializer<ProjectStandbyRearmStatus>(ProjectStandbyRearmStatus.serializer())

/** The pairs one server keeps in step for one of its copies, and its standby re-arm. */
@Serializable
data class ProjectLinkSyncStatus(
    @Serializable(with = LossySyncPairs::class) val pairs: List<LinkedServerSyncPair> = emptyList(),
    /** Absent from older servers, and where this copy has no re-arm consent or run. */
    @Serializable(with = LenientStandbyRearm::class) val standbyRearm: ProjectStandbyRearmStatus? = null,
)

@Serializable
data class LinkedServerSyncPair(
    val peerEnvironmentId: String,
    val peerProjectId: String,
    /** "replica", "memory", "plan" or "supersede". */
    val kind: String,
    /** The end of the last pass that left this pair in step. */
    val lastSuccessAt: String? = null,
    val lastAttemptAt: String? = null,
    /** Null after a successful pass. */
    val lastError: String? = null,
)

object LenientRearmConsent : LenientSerializer<ProjectStandbyRearmStatus.Consent>(ProjectStandbyRearmStatus.Consent.serializer())
object LenientRearmRun : LenientSerializer<ProjectStandbyRearmStatus.Run>(ProjectStandbyRearmStatus.Run.serializer())

/** This machine's standby re-arm for one copy. */
@Serializable
data class ProjectStandbyRearmStatus(
    @Serializable(with = LenientRearmConsent::class) val consent: Consent? = null,
    /** Only for the epoch this copy coordinates at now. */
    @Serializable(with = LenientRearmRun::class) val run: Run? = null,
) {
    @Serializable
    data class Consent(val chainId: String, val members: List<LogicalProjectMember>, val afterMinutes: Int)

    @Serializable
    data class Run(
        /** "pending", "verifying", "armed" or "stopped". */
        val state: String,
        /** Why re-arming has not finished, or stopped. */
        val reason: String? = null,
        val detail: String? = null,
        val standby: LogicalProjectMember? = null,
        val epoch: Int = 0,
        val since: String? = null,
    )
}
