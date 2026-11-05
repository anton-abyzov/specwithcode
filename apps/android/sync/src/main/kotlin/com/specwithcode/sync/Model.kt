package com.specwithcode.sync

import com.specwithcode.wire.AccessRequestCopy
import java.time.Instant

// The UI contract. Compose screens read `AppModel` and `ChatSession` only; they never see
// wire types, sockets or reducers. An `AppEngine` fills the model: `LiveEngine` will talk to
// real machines, `FixtureEngine` serves sample data for previews, tests and screenshots.

// MARK: - References

data class ProjectRef(val environmentId: String, val projectId: String)

data class ThreadRef(val environmentId: String, val threadId: String)

/** Where a message goes. Aide and projects talk to their coordinator. */
sealed interface ChatTarget {
    val environmentId: String

    data class Aide(val project: ProjectRef) : ChatTarget {
        override val environmentId: String get() = project.environmentId
    }

    data class Project(val project: ProjectRef) : ChatTarget {
        override val environmentId: String get() = project.environmentId
    }

    data class Thread(val thread: ThreadRef) : ChatTarget {
        override val environmentId: String get() = thread.environmentId
    }
}

// MARK: - Machines

enum class MachineStatus(val label: String) {
    Offline("Offline"),
    Connecting("Connecting"),
    Connected("Online"),
    Reconnecting("Reconnecting"),
    NeedsRepair("Pair again"),
    Unsupported("Update needed"),
    ;

    val isOnline: Boolean get() = this == Connected
}

data class MachineSummary(
    /** The machine's environment id. */
    val id: String,
    val label: String,
    val status: MachineStatus,
    /** e.g. "macOS · arm64" */
    val platform: String? = null,
    val serverVersion: String? = null,
    /** Base URL the app currently uses, e.g. https://m4.tailnet.ts.net */
    val address: String? = null,
    /** Days until the pairing token expires, when known. */
    val tokenDaysLeft: Int? = null,
    /** Online, but the machine's projects and threads are not live right now. */
    val isStale: Boolean = false,
    /** Reached through SpecWithCode Connect, the signed-in account. */
    val viaConnect: Boolean = false,
    /** The live connection goes through SpecWithCode Connect, even if the computer also has a direct pairing. */
    val connectedViaConnect: Boolean = false,
    /** The account signed out; signing in again reconnects it. */
    val needsSignIn: Boolean = false,
    /** When SpecWithCode Connect last checked an offline computer. */
    val checkedAt: Instant? = null,
    /** The user's nickname for it, else its short name: what rows and notices show. */
    val displayName: String = MachineNickname.shortName(label),
    /** Paired with a link or QR code, so it has a pairing that expires. */
    val hasDirectPairing: Boolean = !viaConnect,
    /** This phone has paused the connection without forgetting its credentials. */
    val isDisconnected: Boolean = false,
    /** The computer refuses sign-ins from this network for a while after too many failed attempts. */
    val isRefusingSignIns: Boolean = false,
    /** Why the machine's Team rules refuse this phone right now, in the machine's words. */
    val teamRulesRefusal: String? = null,
    /** Set when the computer asked for this device to be approved again, in the computer's words. */
    val reapprovalNotice: String? = null,
    /** Why the last connection attempt failed, while the machine is not connected. */
    val lastErrorMessage: String? = null,
)

// MARK: - Projects

sealed interface ProjectIcon {
    /** A Lucide icon name (e.g. "concierge-bell") and a color name or hex. */
    data class Symbol(val name: String, val color: String?) : ProjectIcon
    data class Emoji(val emoji: String) : ProjectIcon
    data class Monogram(val text: String, val color: String?) : ProjectIcon
    data object None : ProjectIcon
}

enum class ProjectKind { Code, Personal }

data class ProjectSummary(
    /** The project's own row; for a project on several machines, the member whose coordinator is active. */
    val ref: ProjectRef,
    val title: String,
    val icon: ProjectIcon = ProjectIcon.None,
    val kind: ProjectKind = ProjectKind.Code,
    val machineLabel: String,
    val machineOnline: Boolean,
    val isPinned: Boolean = false,
    val paused: Boolean = false,
    val archived: Boolean = false,
    /** Made by a check or agent for itself; listed under "Automated". */
    val isAutomated: Boolean = false,
    /** Threads of this project that are working right now. */
    val workingCount: Int = 0,
    val hasUnread: Boolean = false,
    /** Each machine's copy of a project linked across machines, coordinator first. Empty for one machine. */
    val members: List<ProjectMember> = emptyList(),
) {
    val id: ProjectRef get() = ref

    /** True for this project's row or any machine's copy of it. */
    fun contains(other: ProjectRef): Boolean = ref == other || members.any { it.ref == other }
}

/** One machine's copy of a project linked across machines. */
data class ProjectMember(
    val ref: ProjectRef,
    val machineLabel: String,
    val machineOnline: Boolean,
    val lastSeenAt: Instant? = null,
    /** This copy's coordinator is the project's active coordinator. */
    val isCoordinator: Boolean = false,
    /** Linked to the project's other copies, so a thread can move here. */
    val isLinked: Boolean = true,
    /** The copy's folder on its machine, normalized. */
    val folder: String? = null,
)

// MARK: - Threads

enum class ThreadActivity {
    /** Waiting for an approval or an answer from you. */
    NeedsYou,
    Working,
    Failed,
    Idle,
}

data class ThreadSummary(
    val ref: ThreadRef,
    val projectRef: ProjectRef? = null,
    val projectTitle: String? = null,
    val title: String,
    val activity: ThreadActivity,
    /** Latest status line or message preview. */
    val preview: String? = null,
    val updatedAt: Instant,
    /** When the current run started, for "2m" style elapsed labels. */
    val workStartedAt: Instant? = null,
    val isPinned: Boolean = false,
    val isResolved: Boolean = false,
    val isUnread: Boolean = false,
    val machineLabel: String,
    val machineOnline: Boolean,
    val planProgress: PlanProgress? = null,
    /** Where the thread lives and runs, and whether its state is unknown. */
    val placement: ThreadPlacement = ThreadPlacement(owner = MachineNickname.shortName(machineLabel)),
    val activityAt: Instant = updatedAt,
    val identity: ThreadIdentity = ThreadIdentity.Unknown,
    val waitsOnUser: Boolean = false,
    /** Its last run finished, as opposed to a thread nothing has run in yet. */
    val isDone: Boolean = false,
    /** What it waits on other than the person ("Waiting for CI"); it counts as working. */
    val waitReason: String? = null,
    /** It waits for the person to allow access to apps, devices, machines or folders. */
    val asksForAccess: Boolean = false,
) {
    val id: ThreadRef get() = ref

    /** Its machine is unreachable, so its activity is the last known one. */
    val isUnknown: Boolean get() = placement.unknown != null
}

data class PlanProgress(val completed: Int, val total: Int)

sealed interface ThreadAction {
    data object Pin : ThreadAction
    data object Unpin : ThreadAction
    data object Resolve : ThreadAction
    data object Unresolve : ThreadAction
    data object Archive : ThreadAction
    data object Delete : ThreadAction
    data object MarkUnread : ThreadAction
    data class Rename(val title: String) : ThreadAction

    /** Takes effect on the next turn, without stopping work in progress. */
    data class SetRuntimeMode(val mode: RuntimeModeChoice) : ThreadAction
}

// MARK: - Transcript

data class TodoStep(val id: String, val text: String, val status: Status) {
    enum class Status { Pending, Running, Completed }
}

enum class ToolStatus { Running, Completed, Failed }

/** Where a message you sent stands. */
enum class UserMessageState {
    /** The machine has it and its run started or finished. */
    Sent,

    /** On its way to the machine. */
    Sending,

    /** Waits for the active run to finish. */
    Queued,

    /** Queued behind a stop or a restart; it runs once the queue is resumed. */
    Held,
}

data class TranscriptRow(val id: String, val kind: Kind) {
    sealed interface Kind {
        data class User(
            val text: String,
            val state: UserMessageState = UserMessageState.Sent,
            val attachments: List<TranscriptAttachment> = emptyList(),
        ) : Kind
        data class Assistant(val markdown: String, val streaming: Boolean) : Kind

        /** [seconds] is how long a settled thought took; null when it was not measured. */
        data class Reasoning(val text: String, val streaming: Boolean, val seconds: Int? = null) : Kind

        /** A command, file change, search or other tool call. */
        data class Tool(val title: String, val detail: String?, val symbol: String, val status: ToolStatus) : Kind
        data class Plan(val steps: List<TodoStep>) : Kind
        data class ProposedPlan(val markdown: String) : Kind

        /** [kind] is the wire request kind; [options] are the provider's choices, empty for accept and decline. */
        data class Approval(
            val requestId: String,
            val prompt: String,
            val resolved: Boolean,
            val kind: String? = null,
            val options: List<ApprovalChoice> = emptyList(),
        ) : Kind
        data class Question(val requestId: String, val prompt: String, val resolved: Boolean) : Kind

        /** The agent asks to use apps, devices, machines or folders. One answer covers them all. */
        data class Access(val request: AccessRequestRow) : Kind
        data class Subagent(val title: String, val child: ThreadRef?, val isRunning: Boolean = false) : Kind
        data class Error(val message: String) : Kind
        data class Notice(val text: String) : Kind

        /** A turn's folded steps: "Worked · Ran 3 commands". */
        data class Fold(val label: String, val summary: String?, val failures: Int, val expanded: Boolean, val running: Boolean) : Kind
    }

    /** A subagent still at work. */
    val isRunningSubagent: Boolean get() = (kind as? Kind.Subagent)?.isRunning == true
}

enum class ApprovalDecision { Approve, ApproveForSession, ApproveAlways, Deny, Cancel }

/** An access request card: what the agent asks to use and where the answer stands. */
data class AccessRequestRow(
    /** The thread that holds the turn item; the answer is addressed to it. */
    val threadId: String,
    val itemId: String,
    val title: String,
    val reason: String,
    val subjects: List<Subject>,
    val state: State,
    /** Inherited from the thread this one was forked from: it is answered there. */
    val isInherited: Boolean = false,
) {
    enum class State { Pending, AllowedInThread, AllowedOnMachine, Denied, Ended }

    data class Subject(
        /** `app`, `device`, `machine` or `folder`; kept open for newer servers. */
        val kind: String,
        val key: String,
        val label: String,
        val detail: String,
        val hostLabel: String? = null,
        /** `ios` or `android`, for a device. */
        val platform: String? = null,
        /** The subject's own PNG icon, when the server sent one. */
        val iconPng: ByteArray? = null,
    ) {
        val id: String get() = key

        override fun equals(other: Any?): Boolean = other is Subject && other.kind == kind && other.key == key &&
            other.label == label && other.detail == detail && other.hostLabel == hostLabel && other.platform == platform &&
            (other.iconPng?.contentEquals(iconPng) ?: (iconPng == null))

        override fun hashCode(): Int = listOf(kind, key, label, detail, hostLabel, platform).hashCode()
    }

    val isPending: Boolean get() = state == State.Pending

    /** Waiting for an answer in this chat; an inherited request waits in the original thread. */
    val awaitsAnswerHere: Boolean get() = isPending && !isInherited

    private val copyNames: List<AccessRequestCopy.SubjectName> get() = subjects.map { AccessRequestCopy.SubjectName(it.kind, it.label) }

    /** "Claude wants to use Notes"; "The agent wants ..." without a name. */
    fun headline(agent: String?): String = AccessRequestCopy.headline(agent, copyNames)

    /** What Allow lets the agent do, in one line. */
    val note: String get() = AccessRequestCopy.note(copyNames)

    /** The pill on a subject's chip. */
    fun tag(subject: Subject): String = AccessRequestCopy.subjectTag(AccessRequestCopy.SubjectName(subject.kind, subject.label))
}

/** How long an Allow on an access request lasts. */
enum class AccessScope { Thread, Machine }

/** The answer to an access request card. */
sealed interface AccessAnswer {
    data class Allow(val scope: AccessScope) : AccessAnswer
    data object Deny : AccessAnswer
}

/** One choice a provider offers on an approval, with its own label. */
data class ApprovalChoice(val decision: ApprovalDecision, val label: String, val warning: String? = null)

/** An attachment shown in the transcript. */
data class TranscriptAttachment(
    val id: String,
    val name: String,
    val mimeType: String,
    val isImage: Boolean,
    /** A small local picture while the message is on its way; the machine serves the rest. */
    val preview: ByteArray? = null,
) {
    override fun equals(other: Any?): Boolean = other is TranscriptAttachment && other.id == id && other.name == name &&
        other.mimeType == mimeType && other.isImage == isImage && (other.preview?.contentEquals(preview) ?: (preview == null))

    override fun hashCode(): Int = listOf(id, name, mimeType, isImage).hashCode()
}

/** A picture ready to send, already encoded as JPEG on the phone. */
class OutgoingImage(val id: String, val name: String, val data: ByteArray, val preview: ByteArray) {
    val mimeType: String get() = "image/jpeg"

    val transcriptAttachment: TranscriptAttachment
        get() = TranscriptAttachment(id = id, name = name, mimeType = mimeType, isImage = true, preview = preview)
}

// MARK: - Settings

data class ProjectSettingsDraft(
    val title: String,
    val goal: String,
    val instructions: String,
    val paused: Boolean,
    val archived: Boolean,
    /** Display name of the coordinator model, read only for now. */
    val coordinatorModel: String?,
    /** Optimistic-concurrency revision from the last read. */
    val revision: Int,
    /** A newly chosen icon; null leaves the project's icon as it is. */
    val icon: ProjectIcon? = null,
)

enum class AppearancePreference(val label: String) {
    System("System"),
    Light("Light"),
    Dark("Dark"),
}

enum class RuntimeModeChoice(val rawValue: String, val label: String) {
    ApprovalRequired("approval-required", "Ask before changes"),
    AutoAcceptEdits("auto-accept-edits", "Accept edits"),
    Auto("auto", "Auto"),
    FullAccess("full-access", "Full access"),
    ;

    companion object {
        fun fromRaw(raw: String): RuntimeModeChoice? = entries.firstOrNull { it.rawValue == raw }
    }
}

/** Settings that live on one machine's server. */
data class MachineSettings(val defaultRuntimeMode: RuntimeModeChoice?, val defaultModel: String?)

// MARK: - New threads

/** A model a machine offers for new threads. */
data class ModelChoice(val instanceId: String, val model: String, val label: String)

/** What the new thread screen sends: the project, the first message and how the thread runs. */
data class NewThreadRequest(
    val project: ProjectRef,
    val text: String,
    /** Null uses the machine's default model. */
    val model: ModelChoice? = null,
    val runtimeMode: RuntimeModeChoice = RuntimeModeChoice.ApprovalRequired,
)
