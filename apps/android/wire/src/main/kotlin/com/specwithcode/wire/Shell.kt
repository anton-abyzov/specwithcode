package com.specwithcode.wire

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/**
 * The machine's projects and thread rows. Sent first on `orchestration.subscribeShell` and
 * by `GET /api/orchestration/shell`.
 */
@Serializable(with = ShellSnapshotSerializer::class)
data class ShellSnapshot(
    val schemaVersion: Int = 1,
    /** Stream items with `sequence <= snapshotSequence` are already applied. */
    val snapshotSequence: Int = 0,
    val threads: List<ThreadShell> = emptyList(),
    val archivedThreads: List<ThreadShell> = emptyList(),
    val projects: List<ProjectShell> = emptyList(),
)

object ShellSnapshotSerializer : ObjectSerializer<ShellSnapshot>("ShellSnapshot") {
    override fun JsonReader.read() = ShellSnapshot(
        schemaVersion = optInt("schemaVersion") ?: 1,
        snapshotSequence = int("snapshotSequence"),
        threads = list("threads"),
        archivedThreads = list("archivedThreads"),
        projects = list("projects"),
    )

    override fun JsonWriter.write(value: ShellSnapshot) {
        put("schemaVersion", value.schemaVersion)
        put("snapshotSequence", value.snapshotSequence)
        put("threads", value.threads)
        put("archivedThreads", value.archivedThreads)
        put("projects", value.projects)
    }
}

/** One value of the `orchestration.subscribeShell` stream. */
@Serializable(with = ShellStreamItemSerializer::class)
sealed interface ShellStreamItem {
    /** Initial catch-up is done; live updates follow. */
    data object Synchronized : ShellStreamItem

    /**
     * A full snapshot. With [resolvedRepositoryIdentityRoots] it is a metadata patch for
     * those roots, never a replacement.
     */
    data class Snapshot(val snapshot: ShellSnapshot, val resolvedRepositoryIdentityRoots: List<String>? = null) : ShellStreamItem
    data class ProjectUpdated(val sequence: Int, val project: ProjectShell) : ShellStreamItem
    data class ProjectRemoved(val sequence: Int, val projectId: String) : ShellStreamItem
    data class ThreadUpdated(val sequence: Int, val location: ThreadLocation, val thread: ThreadShell) : ShellStreamItem
    data class ThreadRemoved(val sequence: Int, val location: ThreadLocation, val threadId: String) : ShellStreamItem

    /** A kind this build does not know. Skip it. */
    data class Unknown(val kind: String, val raw: JsonObject) : ShellStreamItem
}

/** The wire `kind`. */
val ShellStreamItem.kind: String
    get() = when (this) {
        ShellStreamItem.Synchronized -> "synchronized"
        is ShellStreamItem.Snapshot -> "snapshot"
        is ShellStreamItem.ProjectUpdated -> "project.updated"
        is ShellStreamItem.ProjectRemoved -> "project.removed"
        is ShellStreamItem.ThreadUpdated -> "thread.updated"
        is ShellStreamItem.ThreadRemoved -> "thread.removed"
        is ShellStreamItem.Unknown -> kind
    }

/** The event sequence: the snapshot's for a snapshot, null for [Synchronized]. */
val ShellStreamItem.sequence: Int?
    get() = when (this) {
        ShellStreamItem.Synchronized -> null
        is ShellStreamItem.Snapshot -> snapshot.snapshotSequence
        is ShellStreamItem.ProjectUpdated -> sequence
        is ShellStreamItem.ProjectRemoved -> sequence
        is ShellStreamItem.ThreadUpdated -> sequence
        is ShellStreamItem.ThreadRemoved -> sequence
        is ShellStreamItem.Unknown -> raw["sequence"]?.intValue
    }

object ShellStreamItemSerializer : ObjectSerializer<ShellStreamItem>("ShellStreamItem") {
    override fun JsonReader.read(): ShellStreamItem = when (val kind = string("kind")) {
        "synchronized" -> ShellStreamItem.Synchronized
        "snapshot" -> ShellStreamItem.Snapshot(req("snapshot"), opt("resolvedRepositoryIdentityRoots"))
        "project.updated" -> ShellStreamItem.ProjectUpdated(int("sequence"), req("project"))
        "project.removed" -> ShellStreamItem.ProjectRemoved(int("sequence"), string("projectId"))
        "thread.updated" -> ShellStreamItem.ThreadUpdated(int("sequence"), opt("location") ?: ThreadLocation.Active, req("thread"))
        "thread.removed" -> ShellStreamItem.ThreadRemoved(int("sequence"), opt("location") ?: ThreadLocation.Active, string("threadId"))
        else -> ShellStreamItem.Unknown(kind, raw)
    }

    override fun JsonWriter.write(value: ShellStreamItem) {
        if (value is ShellStreamItem.Unknown) {
            merge(value.raw)
            return
        }
        put("kind", value.kind)
        when (value) {
            ShellStreamItem.Synchronized, is ShellStreamItem.Unknown -> Unit
            is ShellStreamItem.Snapshot -> {
                put("snapshot", value.snapshot)
                put("resolvedRepositoryIdentityRoots", value.resolvedRepositoryIdentityRoots)
            }
            is ShellStreamItem.ProjectUpdated -> {
                put("sequence", value.sequence)
                put("project", value.project)
            }
            is ShellStreamItem.ProjectRemoved -> {
                put("sequence", value.sequence)
                put("projectId", value.projectId)
            }
            is ShellStreamItem.ThreadUpdated -> {
                put("sequence", value.sequence)
                put("location", value.location)
                put("thread", value.thread)
            }
            is ShellStreamItem.ThreadRemoved -> {
                put("sequence", value.sequence)
                put("location", value.location)
                put("threadId", value.threadId)
            }
        }
    }
}
