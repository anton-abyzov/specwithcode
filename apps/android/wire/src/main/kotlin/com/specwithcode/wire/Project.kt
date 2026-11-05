package com.specwithcode.wire

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import java.time.Instant

object LenientRepositoryIdentity : LenientSerializer<RepositoryIdentity>(RepositoryIdentity.serializer())
object LossyProjectScripts : LossyListSerializer<ProjectScript>(ProjectScript.serializer())

/**
 * A project as the shell sends it. `projects.mutate` returns the same shape plus `deletedAt`.
 *
 * `createdAt`, `updatedAt` and `deletedAt` are free-form ISO strings on the wire, kept as
 * sent; use the `...Date` accessors to read them.
 */
@Serializable
data class ProjectShell(
    val id: String,
    val title: String,
    val workspaceRoot: String,
    @Serializable(with = LenientRepositoryIdentity::class) val repositoryIdentity: RepositoryIdentity? = null,
    val defaultModelSelection: ModelSelection? = null,
    val defaultThreadEnvMode: ThreadEnvMode? = null,
    val autoPull: Boolean? = null,
    val faviconPath: String? = null,
    val projectIcon: ProjectIconOverride? = null,
    /** Omitted by the server when the project has none. */
    val workspaceSettings: ProjectWorkspaceSettings? = null,
    @Serializable(with = LossyProjectScripts::class) val scripts: List<ProjectScript> = emptyList(),
    val createdAt: String = "",
    val updatedAt: String = "",
    val deletedAt: String? = null,
) {
    val kind: WorkspaceKind get() = workspaceSettings?.kind ?: WorkspaceKind.Code
    val isPersonal: Boolean get() = kind == WorkspaceKind.Personal
    val isPaused: Boolean get() = workspaceSettings?.paused ?: false
    val isArchived: Boolean get() = workspaceSettings?.archived ?: false

    /** The coordinator thread: the stored id, or `project-coordinator:<id>` when none is set. */
    val coordinatorThreadId: String
        get() = workspaceSettings?.coordinatorThreadId ?: defaultCoordinatorThreadId(id)

    /** The logical project title when the project belongs to one. */
    val displayTitle: String get() = workspaceSettings?.logicalProject?.title ?: title

    val createdDate: Instant? get() = WireDates.parse(createdAt)
    val updatedDate: Instant? get() = WireDates.parse(updatedAt)

    companion object {
        fun defaultCoordinatorThreadId(projectId: String): String = "project-coordinator:$projectId"
    }
}

/** A project's chosen icon. A kind from a newer server decodes as [Unknown]; show the default icon for it. */
@Serializable(with = ProjectIconOverrideSerializer::class)
sealed interface ProjectIconOverride {
    /** A Lucide icon name such as `concierge-bell` and a palette color such as `violet`. */
    data class Lucide(val name: String, val color: String) : ProjectIconOverride
    data class Emoji(val emoji: String) : ProjectIconOverride
    data class Monogram(val text: String, val color: String) : ProjectIconOverride
    data class Unknown(val raw: JsonObject) : ProjectIconOverride

    companion object {
        /** The icon a new personal assistant starts with. */
        val PersonalAssistant: ProjectIconOverride = Lucide("concierge-bell", "violet")
    }
}

object ProjectIconOverrideSerializer : ObjectSerializer<ProjectIconOverride>("ProjectIconOverride") {
    override fun JsonReader.read(): ProjectIconOverride = when (optString("kind")) {
        "lucide" -> {
            val color = optString("color") ?: "gray"
            // Older servers sent a monogram as a lucide icon carrying its text.
            val text = optString("monogramText") ?: optString("monogram")
            if (text != null) ProjectIconOverride.Monogram(text, color) else ProjectIconOverride.Lucide(string("name"), color)
        }
        "emoji" -> ProjectIconOverride.Emoji(string("emoji"))
        "monogram" -> ProjectIconOverride.Monogram(string("text"), optString("color") ?: "gray")
        else -> ProjectIconOverride.Unknown(raw)
    }

    override fun JsonWriter.write(value: ProjectIconOverride) {
        when (value) {
            is ProjectIconOverride.Lucide -> {
                put("kind", "lucide")
                put("name", value.name)
                put("color", value.color)
            }
            is ProjectIconOverride.Emoji -> {
                put("kind", "emoji")
                put("emoji", value.emoji)
            }
            is ProjectIconOverride.Monogram -> {
                put("kind", "monogram")
                put("text", value.text)
                put("color", value.color)
            }
            is ProjectIconOverride.Unknown -> merge(value.raw)
        }
    }
}

/** Settings of a project's workspace: kind, goal, instructions and its coordinator. */
@Serializable(with = ProjectWorkspaceSettingsSerializer::class)
data class ProjectWorkspaceSettings(
    val kind: WorkspaceKind = WorkspaceKind.Code,
    val environment: ProjectEnvironment = ProjectEnvironment(),
    /** Optimistic-concurrency revision; send it back as `expectedRevision`. */
    val revision: Int = 0,
    val goal: String = "",
    val instructions: String = "",
    val coordinatorModelSelection: ModelSelection? = null,
    /** Null means `project-coordinator:<projectId>`. */
    val coordinatorThreadId: String? = null,
    val paused: Boolean = false,
    val archived: Boolean = false,
    val autoResume: Boolean = false,
    val logicalProject: LogicalProject? = null,
    val coordinatorBinding: CoordinatorBinding? = null,
    val workerMachine: WorkerMachine? = null,
    val temporarySessionId: String? = null,
    /** "automated" for a project a check made for itself; absent on older projects. */
    val origin: ProjectOrigin? = null,
) {
    /** True while the coordinator is handing off to another machine. */
    val isCoordinatorFenced: Boolean
        get() {
            val state = coordinatorBinding?.state ?: return false
            return state != CoordinatorBindingState.Active
        }
}

object ProjectWorkspaceSettingsSerializer : ObjectSerializer<ProjectWorkspaceSettings>("ProjectWorkspaceSettings") {
    override fun JsonReader.read() = ProjectWorkspaceSettings(
        logicalProject = lenient("logicalProject"),
        coordinatorBinding = lenient("coordinatorBinding"),
        kind = opt("kind") ?: WorkspaceKind.Code,
        environment = lenient("environment") ?: ProjectEnvironment(),
        revision = int("revision"),
        goal = optString("goal") ?: "",
        instructions = optString("instructions") ?: "",
        coordinatorModelSelection = opt("coordinatorModelSelection"),
        coordinatorThreadId = optString("coordinatorThreadId"),
        paused = optBool("paused") ?: false,
        archived = optBool("archived") ?: false,
        autoResume = optBool("autoResume") ?: false,
        workerMachine = lenient("workerMachine"),
        temporarySessionId = optString("temporarySessionId"),
        // A value from a newer server reads as unset, so its folder decides.
        origin = lenient("origin"),
    )

    override fun JsonWriter.write(value: ProjectWorkspaceSettings) {
        put("logicalProject", value.logicalProject)
        put("coordinatorBinding", value.coordinatorBinding)
        put("kind", value.kind)
        put("environment", value.environment)
        put("revision", value.revision)
        put("goal", value.goal)
        put("instructions", value.instructions)
        put("coordinatorModelSelection", value.coordinatorModelSelection)
        put("coordinatorThreadId", value.coordinatorThreadId)
        put("paused", value.paused)
        put("archived", value.archived)
        put("autoResume", value.autoResume)
        put("workerMachine", value.workerMachine)
        put("temporarySessionId", value.temporarySessionId)
        put("origin", value.origin)
    }
}

object LossyRepositories : LossyListSerializer<ProjectRepository>(ProjectRepository.serializer())

@Serializable
data class ProjectEnvironment(
    val additionalFolders: List<String> = emptyList(),
    @Serializable(with = LossyRepositories::class) val repositories: List<ProjectRepository> = emptyList(),
)

@Serializable
data class ProjectRepository(val id: String, val url: String, val localPath: String? = null)

/** A project's identity across machines. */
@Serializable
data class LogicalProject(
    val id: String,
    val title: String,
    val coordinatorId: String,
    val members: List<LogicalProjectMember> = emptyList(),
)

@Serializable
data class LogicalProjectMember(val environmentId: String, val projectId: String, val coordinatorThreadId: String)

object LenientStandby : LenientSerializer<CoordinatorStandby>(CoordinatorStandby.serializer())

@Serializable
data class CoordinatorBinding(
    val epoch: Int,
    val state: CoordinatorBindingState,
    val operationId: String? = null,
    val predecessor: LogicalProjectMember? = null,
    val successor: LogicalProjectMember? = null,
    /** When a member made itself the coordinator while the previous one was unreachable. */
    @Serializable(with = LenientString::class) val takenOverAt: String? = null,
    /** "person" or "auto" (an armed standby). */
    @Serializable(with = LenientString::class) val takenOverBy: String? = null,
    /** Set only on an active binding while automatic takeover is on. A newer shape reads as off. */
    @Serializable(with = LenientStandby::class) val standby: CoordinatorStandby? = null,
)

/** The member the owner chose to take over the coordinator automatically when it goes quiet. */
@Serializable
data class CoordinatorStandby(
    val member: LogicalProjectMember,
    /** 5, 15, 30 or 60. */
    val afterMinutes: Int,
    val enabledAt: String? = null,
)

/** Another of the user's machines the coordinator starts its workers on. */
@Serializable
data class WorkerMachine(val machineId: String, val environmentId: String, val projectId: String? = null)

@Serializable(with = ProjectScriptSerializer::class)
data class ProjectScript(
    val id: String,
    val name: String,
    val command: String,
    /** `play`, `test`, `lint`, `configure`, `build` or `debug`. */
    val icon: String = "play",
    val runOnWorktreeCreate: Boolean = false,
)

object ProjectScriptSerializer : ObjectSerializer<ProjectScript>("ProjectScript") {
    override fun JsonReader.read(): ProjectScript {
        val id = string("id")
        return ProjectScript(
            id, optString("name") ?: id, optString("command") ?: "", optString("icon") ?: "play",
            optBool("runOnWorktreeCreate") ?: false,
        )
    }

    override fun JsonWriter.write(value: ProjectScript) {
        put("id", value.id)
        put("name", value.name)
        put("command", value.command)
        put("icon", value.icon)
        put("runOnWorktreeCreate", value.runOnWorktreeCreate)
    }
}

/** The git repository a project's checkout belongs to. */
@Serializable
data class RepositoryIdentity(
    val canonicalKey: String,
    val locator: Locator? = null,
    val webUrl: String? = null,
    val rootPath: String? = null,
    val displayName: String? = null,
    val provider: String? = null,
    val owner: String? = null,
    val name: String? = null,
    val origin: Origin? = null,
) {
    @Serializable
    data class Locator(val source: String, val remoteName: String, val remoteUrl: String)

    /**
     * The checkout's own `origin` remote, sent when it names a different repository than
     * `canonicalKey` (which follows `upstream`), as for a fork.
     */
    @Serializable
    data class Origin(val canonicalKey: String, val displayName: String? = null)

    /** The key clients group checkouts by: the checkout's own remote, so a fork stays apart. */
    val groupingKey: String get() = origin?.canonicalKey ?: canonicalKey

    /** The repository's label, matching [groupingKey]. */
    val groupingDisplayName: String? get() = origin?.let { it.displayName ?: it.canonicalKey } ?: displayName
}

// MARK: - Project RPC payloads

/** `projects.coordinatorSend`: a message for the project's coordinator. */
@Serializable
data class CoordinatorSendInput(
    val projectId: String,
    val commandId: String,
    /** At most 32,000 characters. */
    val prompt: String,
    val attachments: List<ChatAttachment>? = null,
    val sourceThreadId: String? = null,
)

/** `projects.coordinatorStart`: makes sure the coordinator thread exists, optionally with a prompt. */
@Serializable
data class CoordinatorStartInput(val projectId: String, val commandId: String, val prompt: String? = null)

/** Result of `projects.coordinatorSend` and `projects.coordinatorStart`. */
@Serializable
data class CoordinatorResult(val threadId: String, val created: Boolean = false)

/** `projects.workspaceRead` payload. */
@Serializable
data class WorkspaceReadInput(val projectId: String)

object LossyMemoryFiles : LossyListSerializer<WorkspaceReadResult.MemoryFile>(WorkspaceReadResult.MemoryFile.serializer())

/** `projects.workspaceRead` result: settings plus a summary of the project's memory files. */
@Serializable
data class WorkspaceReadResult(val settings: ProjectWorkspaceSettings, val memory: Memory = Memory()) {
    @Serializable
    data class Memory(
        @Serializable(with = LossyMemoryFiles::class) val files: List<MemoryFile> = emptyList(),
        val totalBytes: Int = 0,
    )

    @Serializable
    data class MemoryFile(
        val name: String,
        val revision: Int,
        /** Free-form ISO string. */
        val updatedAt: String,
        val byteLength: Int,
    )
}

/**
 * `project.update` patch of `workspaceSettings`. Only `expectedRevision` is required; a
 * stale revision fails with `ProjectWorkspaceError` code `conflict`.
 */
@Serializable(with = WorkspacePatchSerializer::class)
data class WorkspacePatch(
    val expectedRevision: Int,
    val kind: WorkspaceKind? = null,
    val goal: String? = null,
    val instructions: String? = null,
    val coordinatorModelSelection: Nullable<ModelSelection>? = null,
    val paused: Boolean? = null,
    val archived: Boolean? = null,
    val autoResume: Boolean? = null,
)

object WorkspacePatchSerializer : ObjectSerializer<WorkspacePatch>("WorkspacePatch") {
    override fun JsonReader.read() = WorkspacePatch(
        int("expectedRevision"), opt("kind"), optString("goal"), optString("instructions"),
        nullable("coordinatorModelSelection"), optBool("paused"), optBool("archived"), optBool("autoResume"),
    )

    override fun JsonWriter.write(value: WorkspacePatch) {
        put("expectedRevision", value.expectedRevision)
        put("kind", value.kind)
        put("goal", value.goal)
        put("instructions", value.instructions)
        putNullable("coordinatorModelSelection", value.coordinatorModelSelection)
        put("paused", value.paused)
        put("archived", value.archived)
        put("autoResume", value.autoResume)
    }
}

/** `projects.mutate` with `type: "project.update"`. Returns the updated [ProjectShell]. */
@Serializable(with = ProjectUpdateCommandSerializer::class)
data class ProjectUpdateCommand(
    val commandId: String,
    val projectId: String,
    val title: String? = null,
    val workspaceSettings: WorkspacePatch? = null,
    /** [Nullable.Null] clears the icon back to the default. */
    val projectIcon: Nullable<ProjectIconOverride>? = null,
    val defaultModelSelection: Nullable<ModelSelection>? = null,
    val autoPull: Boolean? = null,
) {
    companion object {
        const val TYPE = "project.update"
    }
}

object ProjectUpdateCommandSerializer : ObjectSerializer<ProjectUpdateCommand>("ProjectUpdateCommand") {
    override fun JsonReader.read(): ProjectUpdateCommand {
        val type = string("type")
        if (type != ProjectUpdateCommand.TYPE) throw WireDecodingException("Expected ${ProjectUpdateCommand.TYPE}, got $type")
        return ProjectUpdateCommand(
            string("commandId"), string("projectId"), optString("title"), opt("workspaceSettings"),
            nullable("projectIcon"), nullable("defaultModelSelection"), optBool("autoPull"),
        )
    }

    override fun JsonWriter.write(value: ProjectUpdateCommand) {
        put("type", ProjectUpdateCommand.TYPE)
        put("commandId", value.commandId)
        put("projectId", value.projectId)
        put("title", value.title)
        put("workspaceSettings", value.workspaceSettings)
        putNullable("projectIcon", value.projectIcon)
        putNullable("defaultModelSelection", value.defaultModelSelection)
        put("autoPull", value.autoPull)
    }
}

/**
 * `projects.createNew`: a project in a new folder under the server's projects root. With
 * `kind: personal` the server returns the existing assistant if there is one.
 */
@Serializable
data class CreateNewProjectInput(
    /** At most 200 characters. */
    val name: String,
    val kind: WorkspaceKind? = null,
    val parentPath: String? = null,
)

@Serializable
data class CreateNewProjectResult(
    val projectId: String,
    val workspaceRoot: String,
    /** Why the first commit failed. The project exists either way. */
    val commitError: String? = null,
    /** The folder was already a project and was used as is. */
    val existing: Boolean? = null,
)
