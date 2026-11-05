package com.specwithcode.wire

import kotlinx.serialization.Serializable

// String literal unions from the contracts, kept open so a newer server never fails a
// decode. Compare with the companion constants (`status == ThreadStatus.Running`) or
// check `isKnown`.

private val workingStatuses = setOf("preparing", "queued", "starting", "running", "waiting")

/** `"idle"` or a run status: the status a thread shell reports. */
@Serializable
@JvmInline
value class ThreadStatus(override val rawValue: String) : OpenEnum {
    override val isKnown: Boolean get() = rawValue in KNOWN

    /** True while a run is in flight: preparing, queued, starting, running or waiting. */
    val isWorking: Boolean get() = rawValue in workingStatuses

    companion object {
        val Idle = ThreadStatus("idle")
        val Preparing = ThreadStatus("preparing")
        val Queued = ThreadStatus("queued")
        val Starting = ThreadStatus("starting")
        val Running = ThreadStatus("running")
        val Waiting = ThreadStatus("waiting")
        val Completed = ThreadStatus("completed")
        val Interrupted = ThreadStatus("interrupted")
        val Failed = ThreadStatus("failed")
        val Cancelled = ThreadStatus("cancelled")
        val RolledBack = ThreadStatus("rolled_back")
        val KNOWN = setOf("idle", "preparing", "queued", "starting", "running", "waiting", "completed", "interrupted", "failed", "cancelled", "rolled_back")
    }
}

@Serializable
@JvmInline
value class RunStatus(override val rawValue: String) : OpenEnum {
    override val isKnown: Boolean get() = rawValue in KNOWN

    /** Preparing, queued, starting, running or waiting. */
    val isWorking: Boolean get() = rawValue in workingStatuses

    /** A run that holds the thread now: preparing, starting, running or waiting (not queued). */
    val isActive: Boolean get() = rawValue in ACTIVE

    companion object {
        val Preparing = RunStatus("preparing")
        val Queued = RunStatus("queued")
        val Starting = RunStatus("starting")
        val Running = RunStatus("running")
        val Waiting = RunStatus("waiting")
        val Completed = RunStatus("completed")
        val Interrupted = RunStatus("interrupted")
        val Failed = RunStatus("failed")
        val Cancelled = RunStatus("cancelled")
        val RolledBack = RunStatus("rolled_back")
        val KNOWN = setOf("preparing", "queued", "starting", "running", "waiting", "completed", "interrupted", "failed", "cancelled", "rolled_back")
        private val ACTIVE = setOf("preparing", "starting", "running", "waiting")
    }
}

@Serializable
@JvmInline
value class TurnItemStatus(override val rawValue: String) : OpenEnum {
    override val isKnown: Boolean get() = rawValue in KNOWN

    companion object {
        val Idle = TurnItemStatus("idle")
        val Pending = TurnItemStatus("pending")
        val Running = TurnItemStatus("running")
        val Waiting = TurnItemStatus("waiting")
        val Completed = TurnItemStatus("completed")
        val Failed = TurnItemStatus("failed")
        val Cancelled = TurnItemStatus("cancelled")
        val Interrupted = TurnItemStatus("interrupted")
        val KNOWN = setOf("idle", "pending", "running", "waiting", "completed", "failed", "cancelled", "interrupted")
    }
}

@Serializable
@JvmInline
value class RuntimeMode(override val rawValue: String) : OpenEnum {
    override val isKnown: Boolean get() = rawValue in KNOWN

    companion object {
        val ApprovalRequired = RuntimeMode("approval-required")
        val AutoAcceptEdits = RuntimeMode("auto-accept-edits")
        val Auto = RuntimeMode("auto")
        val FullAccess = RuntimeMode("full-access")
        val KNOWN = setOf("approval-required", "auto-accept-edits", "auto", "full-access")
    }
}

@Serializable
@JvmInline
value class InteractionMode(override val rawValue: String) : OpenEnum {
    override val isKnown: Boolean get() = rawValue in KNOWN

    companion object {
        val Default = InteractionMode("default")
        val Plan = InteractionMode("plan")
        val KNOWN = setOf("default", "plan")
    }
}

/** Who created a thread, message or command: `user`, `agent` or `system`. */
@Serializable
@JvmInline
value class ActorKind(override val rawValue: String) : OpenEnum {
    override val isKnown: Boolean get() = rawValue in KNOWN

    companion object {
        val User = ActorKind("user")
        val Agent = ActorKind("agent")
        val System = ActorKind("system")
        val KNOWN = setOf("user", "agent", "system")
    }
}

@Serializable
@JvmInline
value class CreationSource(override val rawValue: String) : OpenEnum {
    override val isKnown: Boolean get() = rawValue in KNOWN

    companion object {
        val Web = CreationSource("web")
        val Mobile = CreationSource("mobile")
        val Mcp = CreationSource("mcp")
        val Provider = CreationSource("provider")
        val Server = CreationSource("server")
        val KNOWN = setOf("web", "mobile", "mcp", "provider", "server")
    }
}

@Serializable
@JvmInline
value class MessageRole(override val rawValue: String) : OpenEnum {
    override val isKnown: Boolean get() = rawValue in KNOWN

    companion object {
        val User = MessageRole("user")
        val Assistant = MessageRole("assistant")
        val System = MessageRole("system")
        val KNOWN = setOf("user", "assistant", "system")
    }
}

@Serializable
@JvmInline
value class PlanStatus(override val rawValue: String) : OpenEnum {
    override val isKnown: Boolean get() = rawValue in KNOWN

    companion object {
        val Draft = PlanStatus("draft")
        val Active = PlanStatus("active")
        val Completed = PlanStatus("completed")
        val Superseded = PlanStatus("superseded")
        val KNOWN = setOf("draft", "active", "completed", "superseded")
    }
}

@Serializable
@JvmInline
value class PlanStepStatus(override val rawValue: String) : OpenEnum {
    override val isKnown: Boolean get() = rawValue in KNOWN

    companion object {
        val Pending = PlanStepStatus("pending")
        val Running = PlanStepStatus("running")
        val Completed = PlanStepStatus("completed")
        val KNOWN = setOf("pending", "running", "completed")
    }
}

/** What a runtime request asks for. Approval kinds plus tool calls, questions and auth. */
@Serializable
@JvmInline
value class RuntimeRequestKind(override val rawValue: String) : OpenEnum {
    override val isKnown: Boolean get() = rawValue in KNOWN

    /** A question for the user rather than an approval. */
    val isUserInput: Boolean get() = this == UserInput

    companion object {
        val Command = RuntimeRequestKind("command")
        val FileRead = RuntimeRequestKind("file-read")
        val FileChange = RuntimeRequestKind("file-change")
        val McpElicitation = RuntimeRequestKind("mcp-elicitation")
        val Permission = RuntimeRequestKind("permission")
        val DynamicToolCall = RuntimeRequestKind("dynamic_tool_call")
        val UserInput = RuntimeRequestKind("user_input")
        val AuthRefresh = RuntimeRequestKind("auth_refresh")
        val KNOWN = setOf("command", "file-read", "file-change", "mcp-elicitation", "permission", "dynamic_tool_call", "user_input", "auth_refresh")
    }
}

@Serializable
@JvmInline
value class RuntimeRequestStatus(override val rawValue: String) : OpenEnum {
    override val isKnown: Boolean get() = rawValue in KNOWN

    companion object {
        val Pending = RuntimeRequestStatus("pending")
        val Resolved = RuntimeRequestStatus("resolved")
        val Expired = RuntimeRequestStatus("expired")
        val Cancelled = RuntimeRequestStatus("cancelled")
        val KNOWN = setOf("pending", "resolved", "expired", "cancelled")
    }
}

@Serializable
@JvmInline
value class ProviderApprovalDecision(override val rawValue: String) : OpenEnum {
    override val isKnown: Boolean get() = rawValue in KNOWN

    companion object {
        val Accept = ProviderApprovalDecision("accept")
        val AcceptForSession = ProviderApprovalDecision("acceptForSession")
        val AcceptAlways = ProviderApprovalDecision("acceptAlways")
        val Decline = ProviderApprovalDecision("decline")
        val Cancel = ProviderApprovalDecision("cancel")
        val KNOWN = setOf("accept", "acceptForSession", "acceptAlways", "decline", "cancel")
    }
}

/** `ProjectWorkspaceSettings.kind`: a code project or the personal assistant. */
@Serializable
@JvmInline
value class WorkspaceKind(override val rawValue: String) : OpenEnum {
    override val isKnown: Boolean get() = rawValue in KNOWN

    companion object {
        val Code = WorkspaceKind("code")
        val Personal = WorkspaceKind("personal")
        val KNOWN = setOf("code", "personal")
    }
}

/** Which shell list a thread lives in. */
@Serializable
@JvmInline
value class ThreadLocation(override val rawValue: String) : OpenEnum {
    override val isKnown: Boolean get() = rawValue in KNOWN

    companion object {
        val Active = ThreadLocation("active")
        val Archive = ThreadLocation("archive")
        val KNOWN = setOf("active", "archive")
    }
}

@Serializable
@JvmInline
value class SettledOverride(override val rawValue: String) : OpenEnum {
    override val isKnown: Boolean get() = rawValue in KNOWN

    companion object {
        val Settled = SettledOverride("settled")
        val Active = SettledOverride("active")
        val KNOWN = setOf("settled", "active")
    }
}

@Serializable
@JvmInline
value class ProviderFailureClass(override val rawValue: String) : OpenEnum {
    override val isKnown: Boolean get() = rawValue in KNOWN

    companion object {
        val UsageLimit = ProviderFailureClass("usage_limit")
        val ProviderError = ProviderFailureClass("provider_error")
        val TransportError = ProviderFailureClass("transport_error")
        val PermissionError = ProviderFailureClass("permission_error")
        val ValidationError = ProviderFailureClass("validation_error")
        val Unknown = ProviderFailureClass("unknown")
        val KNOWN = setOf("usage_limit", "provider_error", "transport_error", "permission_error", "validation_error", "unknown")
    }
}

@Serializable
@JvmInline
value class UserMessageInputIntent(override val rawValue: String) : OpenEnum {
    override val isKnown: Boolean get() = rawValue in KNOWN

    companion object {
        val TurnStart = UserMessageInputIntent("turn_start")
        val QueuedTurn = UserMessageInputIntent("queued_turn")
        val Steer = UserMessageInputIntent("steer")
        val PromotedQueuedToSteer = UserMessageInputIntent("promoted_queued_to_steer")
        val KNOWN = setOf("turn_start", "queued_turn", "steer", "promoted_queued_to_steer")
    }
}

/** Where a new thread runs: the project checkout or a fresh worktree. */
@Serializable
@JvmInline
value class ThreadEnvMode(override val rawValue: String) : OpenEnum {
    override val isKnown: Boolean get() = rawValue in KNOWN

    companion object {
        val Local = ThreadEnvMode("local")
        val Worktree = ThreadEnvMode("worktree")
        val KNOWN = setOf("local", "worktree")
    }
}

/** `message.dispatch.deliveryIntent`, only for servers with `serverResolvedCommandContext`. */
@Serializable
@JvmInline
value class DeliveryIntent(override val rawValue: String) : OpenEnum {
    override val isKnown: Boolean get() = rawValue in KNOWN

    companion object {
        val Auto = DeliveryIntent("auto")
        val Steer = DeliveryIntent("steer")
        val Restart = DeliveryIntent("restart")
        val KNOWN = setOf("auto", "steer", "restart")
    }
}

@Serializable
@JvmInline
value class LineageRelationship(override val rawValue: String) : OpenEnum {
    override val isKnown: Boolean get() = rawValue in KNOWN

    companion object {
        val Fork = LineageRelationship("fork")
        val Subagent = LineageRelationship("subagent")
        val KNOWN = setOf("fork", "subagent")
    }
}

@Serializable
@JvmInline
value class DirectEndpointKind(override val rawValue: String) : OpenEnum {
    override val isKnown: Boolean get() = rawValue in KNOWN

    companion object {
        val Lan = DirectEndpointKind("lan")
        val Tailnet = DirectEndpointKind("tailnet")
        val KNOWN = setOf("lan", "tailnet")
    }
}

@Serializable
@JvmInline
value class TurnItemVisibility(override val rawValue: String) : OpenEnum {
    override val isKnown: Boolean get() = rawValue in KNOWN

    companion object {
        val Local = TurnItemVisibility("local")
        val Inherited = TurnItemVisibility("inherited")
        val Synthetic = TurnItemVisibility("synthetic")
        val KNOWN = setOf("local", "inherited", "synthetic")
    }
}

@Serializable
@JvmInline
value class CoordinatorBindingState(override val rawValue: String) : OpenEnum {
    override val isKnown: Boolean get() = rawValue in KNOWN

    companion object {
        val Active = CoordinatorBindingState("active")
        val Transferring = CoordinatorBindingState("transferring")
        val Transferred = CoordinatorBindingState("transferred")
        val KNOWN = setOf("active", "transferring", "transferred")
    }
}

@Serializable
@JvmInline
value class NotificationOutcome(override val rawValue: String) : OpenEnum {
    override val isKnown: Boolean get() = rawValue in KNOWN

    companion object {
        val Completed = NotificationOutcome("completed")
        val Failed = NotificationOutcome("failed")
        val Cancelled = NotificationOutcome("cancelled")
        val Updated = NotificationOutcome("updated")
        val Unknown = NotificationOutcome("unknown")
        val KNOWN = setOf("completed", "failed", "cancelled", "updated", "unknown")
    }
}

/** Background work that can outlive the turn that started it. */
@Serializable
@JvmInline
value class BackgroundTaskKind(override val rawValue: String) : OpenEnum {
    override val isKnown: Boolean get() = rawValue in KNOWN

    companion object {
        val Subagent = BackgroundTaskKind("subagent")
        val Command = BackgroundTaskKind("command")
        val Monitor = BackgroundTaskKind("monitor")
        val Workflow = BackgroundTaskKind("workflow")
        val BackgroundTask = BackgroundTaskKind("background_task")
        val KNOWN = setOf("subagent", "command", "monitor", "workflow", "background_task")
    }
}

/** What an access request asks for. */
@Serializable
@JvmInline
value class AccessRequestSubjectKind(override val rawValue: String) : OpenEnum {
    override val isKnown: Boolean get() = rawValue in KNOWN

    companion object {
        val App = AccessRequestSubjectKind("app")
        val Device = AccessRequestSubjectKind("device")
        val Machine = AccessRequestSubjectKind("machine")
        val Folder = AccessRequestSubjectKind("folder")
        val KNOWN = setOf("app", "device", "machine", "folder")
    }
}

/** Where an access request card stands. */
@Serializable
@JvmInline
value class AccessRequestStatus(override val rawValue: String) : OpenEnum {
    override val isKnown: Boolean get() = rawValue in KNOWN

    companion object {
        val Pending = AccessRequestStatus("pending")
        val Allowed = AccessRequestStatus("allowed")
        val Denied = AccessRequestStatus("denied")
        val Cancelled = AccessRequestStatus("cancelled")
        val KNOWN = setOf("pending", "allowed", "denied", "cancelled")
    }
}

/** `"ios"` or `"android"`. */
@Serializable
@JvmInline
value class DevicePlatform(override val rawValue: String) : OpenEnum {
    override val isKnown: Boolean get() = rawValue in KNOWN

    companion object {
        val Ios = DevicePlatform("ios")
        val Android = DevicePlatform("android")
        val KNOWN = setOf("ios", "android")
    }
}
