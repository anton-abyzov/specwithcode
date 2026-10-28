import {
  ScheduledTaskId,
  ScheduledTask,
  OrchestrationSearchThreadsInput,
  OrchestrationSearchThreadsResult,
  OrchestrationV2ThreadForkSourcePoint,
  OrchestrationV2ContextTransfer,
  TrimmedNonEmptyString,
  ModelSelection,
  RuntimeMode,
  ProviderInteractionMode,
  RuntimeRequestId,
  ProviderUserInputAnswers,
  IsoDateTime,
  OrchestratorMcpFailure,
  OrchestrationV2DispatchCommandResult,
  OrchestrationV2ThreadSettledNote,
  LifecycleReceiptReport,
  ThreadId,
  RunId,
  NonNegativeInt,
  ProjectId,
} from "@specweave-studio/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const ThreadOrganizeTool = Tool.make("studio_thread_organize", {
  description:
    "Pin, snooze, settle, archive, or mark a thread unread. Omit threadId for this thread. snooze requires snoozedUntil. settle accepts an optional one-line note shown with the resolved thread. Resolving your own running thread requires expectedRunId from studio_thread_read. Only when the user explicitly asks to resolve this thread, set userRequested=true to resolve after that exact turn succeeds, independently of automatic delivery evidence. This schedules resolution; it does not confirm resolution or verify that work shipped. Without userRequested, another thread must record delivery evidence with studio_thread_record_delivery. Deliver your final answer normally. New messages, newer runs, pending questions/approvals, child work, Stop, user reopens, pin and auto-settle opt-out prevent deferred resolution. Do not claim the thread is resolved without settled-state readback. Other threads retain the explicit lifecycle guards.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    action: Schema.Literals([
      "pin",
      "unpin",
      "snooze",
      "unsnooze",
      "settle",
      "unsettle",
      "archive",
      "unarchive",
      "mark_unread",
    ]),
    snoozedUntil: Schema.optional(IsoDateTime),
    note: Schema.optional(OrchestrationV2ThreadSettledNote),
    /** Required for self-settle; binds this call to the turn the caller observed. */
    expectedRunId: Schema.optional(RunId),
    /** Only for an explicit user instruction to resolve this running thread. */
    userRequested: Schema.optional(Schema.Literal(true)),
  }),
  success: OrchestrationV2DispatchCommandResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    Crypto.Crypto,
  ],
})
  .annotate(Tool.Title, "Organize a thread")
  .annotate(Tool.Destructive, true);

const ThreadRecordDeliveryTool = Tool.make("studio_thread_record_delivery", {
  description:
    "Record delivery evidence for another thread's latest completed turn after you verified it. The target thread itself cannot report it; verify the delivery independently before recording. The service binds the request, turn and acceptance revision and records you as the reporter. kind=code needs push, merge and deployment verified with a reference, observedAt and the same scopeRevision; kind=no_code marks those three not_applicable with a rationale. deliverable and verification are always verified. obligations lists what is still open (operational waits, deployment, review, user actions with needsUserOutput, nested work), each with owner and nextEvent; the thread stays unresolved and shows them. Complete evidence with no obligations resolves the thread with the scope as its note, unless it is pinned, reopened by the user, opted out of auto-resolve, stopped, or has pending work. A newer message or a reopen invalidates the evidence. Terminal status, CI, a merged PR or a claim of done is not evidence.",
  parameters: Schema.Struct({
    threadId: ThreadId,
    /** The target's latest completed turn, from studio_thread_read; a newer turn refuses. */
    expectedRunId: RunId,
    ...LifecycleReceiptReport.fields,
  }),
  success: OrchestrationV2DispatchCommandResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    Crypto.Crypto,
  ],
})
  .annotate(Tool.Title, "Record delivery evidence")
  .annotate(Tool.Destructive, true);

const queueTarget = { threadId: Schema.optional(ThreadId), queuedRunId: RunId };
const commandTool = {
  success: OrchestrationV2DispatchCommandResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    Crypto.Crypto,
  ],
};
const queueEntry = Schema.Struct({
  queuedRunId: RunId,
  text: Schema.String,
  truncated: Schema.Boolean,
  /** In a held queue: not delivered until the queue is resumed (studio_queue_resume). */
  held: Schema.optional(Schema.Boolean),
});
const QueueListTool = Tool.make("studio_queue_list", {
  ...commandTool,
  description:
    "List queued messages in delivery order. held=true marks a message in a held queue (after Stop, a restart or a provider failure): it is not delivered until the queue is resumed with studio_queue_resume. Results are a live offset page; use studio_thread_read for full thread history.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    cursor: Schema.optional(NonNegativeInt),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  }),
  success: Schema.Struct({
    items: Schema.Array(queueEntry),
    nextCursor: Schema.NullOr(NonNegativeInt),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const QueueReadTool = Tool.make("studio_queue_read", {
  ...commandTool,
  description: "Read up to 16,000 characters of a queued message. Omit threadId for this thread.",
  parameters: Schema.Struct(queueTarget),
  success: queueEntry,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const QueueEditTool = Tool.make("studio_queue_edit", {
  ...commandTool,
  description:
    "Replace a queued message's text, preserving its attachments. The service rejects runs that are no longer queued.",
  parameters: Schema.Struct({
    ...queueTarget,
    text: Schema.String.check(Schema.isMaxLength(100000)),
  }),
}).annotate(Tool.Destructive, true);
const QueueCancelTool = Tool.make("studio_queue_cancel", {
  ...commandTool,
  description: "Cancel a queued run using the existing queue command.",
  parameters: Schema.Struct(queueTarget),
}).annotate(Tool.Destructive, true);
const QueueReorderTool = Tool.make("studio_queue_reorder", {
  ...commandTool,
  description: "Move a queued run before another queued run, or to the end with beforeRunId=null.",
  parameters: Schema.Struct({ ...queueTarget, beforeRunId: Schema.NullOr(RunId) }),
}).annotate(Tool.Destructive, true);
const QueuePromoteTool = Tool.make("studio_queue_promote_to_steer", {
  ...commandTool,
  description:
    "Deliver a queued message as steering to the specified active run. Existing provider and run-state rules apply.",
  parameters: Schema.Struct({ ...queueTarget, targetRunId: RunId }),
}).annotate(Tool.Destructive, true);

const QueueResumeTool = Tool.make("studio_queue_resume", {
  ...commandTool,
  description:
    "Resume a thread's held queue. A queue is held after Stop, a restart or a provider failure, and its messages are not delivered until it is resumed; once resumed they start in order as the thread becomes idle. Omit threadId for this thread. Resume a queue only when its messages should still run; a thread waiting on a usage limit must be continued first.",
  parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
}).annotate(Tool.Destructive, true);

const requestTarget = { threadId: Schema.optional(ThreadId), requestId: RuntimeRequestId };
const question = Schema.Struct({
  id: Schema.String,
  header: Schema.String,
  question: Schema.String,
  options: Schema.Array(
    Schema.Struct({
      label: Schema.String,
      description: Schema.String,
      value: Schema.optional(Schema.String),
      recommended: Schema.optional(Schema.Boolean),
    }),
  ),
  multiSelect: Schema.optional(Schema.Boolean),
  allowCustomAnswer: Schema.optional(Schema.Boolean),
  required: Schema.optional(Schema.Boolean),
});
const pendingRequest = Schema.Struct({
  requestId: RuntimeRequestId,
  questions: Schema.Array(question),
});
const PendingRequestListTool = Tool.make("studio_pending_request_list", {
  ...commandTool,
  description:
    "List pending user questions in a thread. Omit threadId for this thread. Approval requests are not included.",
  parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  success: Schema.Struct({ requestIds: Schema.Array(RuntimeRequestId) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const PendingRequestReadTool = Tool.make("studio_pending_request_read", {
  ...commandTool,
  description:
    "Read a pending user question. Answer with studio_pending_request_respond; existing live or message response handling is used.",
  parameters: Schema.Struct(requestTarget),
  success: pendingRequest,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const PendingRequestRespondTool = Tool.make("studio_pending_request_respond", {
  ...commandTool,
  description:
    "Answer a pending user-input request using the existing runtime response command. This cannot approve a permission request.",
  parameters: Schema.Struct({ ...requestTarget, answers: ProviderUserInputAnswers }),
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const ThreadConfigurationTool = Tool.make("studio_thread_configuration", {
  ...commandTool,
  description:
    "Read a thread's provider/model selection and modes. Omit threadId for this thread. orchestrator_capabilities lists available providers and models.",
  parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  success: Schema.Struct({
    threadId: ThreadId,
    modelSelection: ModelSelection,
    runtimeMode: RuntimeMode,
    interactionMode: ProviderInteractionMode,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const ThreadConfigureTool = Tool.make("studio_thread_configure", {
  ...commandTool,
  description:
    "Set a thread's provider, model and options with the existing selection command. Omit threadId for this thread. This does not change permission modes. Use orchestrator_capabilities to choose a selection.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    modelSelection: ModelSelection,
  }),
}).annotate(Tool.Destructive, true);

const transferResult = Schema.Struct({ sequence: NonNegativeInt, targetThreadId: ThreadId });
const ThreadForkTool = Tool.make("studio_thread_fork", {
  ...commandTool,
  description:
    "Fork a thread from a stable run or checkpoint using the existing fork command. Omit threadId to fork this thread. The fork inherits the source configuration. Acceptance does not mean a provider turn has completed.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    sourcePoint: OrchestrationV2ThreadForkSourcePoint,
    title: Schema.optional(TrimmedNonEmptyString),
  }),
  success: transferResult,
}).annotate(Tool.Destructive, true);
const ThreadMergeBackTool = Tool.make("studio_thread_merge_back", {
  ...commandTool,
  description:
    "Merge context from a thread back to a related thread in the same project. Omit sourceThreadId to merge from this thread. Existing lineage and transfer rules apply.",
  parameters: Schema.Struct({
    sourceThreadId: Schema.optional(ThreadId),
    targetThreadId: ThreadId,
    sourcePoint: OrchestrationV2ThreadForkSourcePoint,
  }),
  success: transferResult,
}).annotate(Tool.Destructive, true);
const ThreadTransfersTool = Tool.make("studio_thread_transfers", {
  ...commandTool,
  description: "Read context transfer status for a thread. Omit threadId for this thread.",
  parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  success: Schema.Struct({
    transfers: Schema.Array(
      Schema.Struct({
        id: OrchestrationV2ContextTransfer.fields.id,
        sourceThreadId: OrchestrationV2ContextTransfer.fields.sourceThreadId,
        targetThreadId: OrchestrationV2ContextTransfer.fields.targetThreadId,
        status: OrchestrationV2ContextTransfer.fields.status,
      }),
    ),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ThreadSearchTool = Tool.make("studio_thread_search", {
  ...commandTool,
  description:
    "Search active thread titles and content with the app's existing bounded search. Matches are limited to one project (projectId, else the calling thread's project) out of the global top matches, so this may return fewer than limit. A caller outside a SpecWithCode thread that omits projectId searches every project. No pagination or exhaustive-result guarantee.",
  parameters: Schema.Struct({
    ...OrchestrationSearchThreadsInput.fields,
    projectId: Schema.optional(ProjectId),
  }),
  success: OrchestrationSearchThreadsResult,
  dependencies: [...commandTool.dependencies, ThreadSearch.ThreadSearch],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ScheduledTaskRunTool = Tool.make("run_scheduled_task_now", {
  ...commandTool,
  description:
    "Run a scheduled task now through the existing scheduler. Requires a full-access/default caller. Each call is a new manual run; completion means dispatch/bookkeeping completed, not that the provider turn finished.",
  parameters: Schema.Struct({ taskId: ScheduledTaskId }),
  success: Schema.Struct({
    taskId: ScheduledTaskId,
    threadId: ScheduledTask.fields.threadId,
    lastRunStatus: ScheduledTask.fields.lastRunStatus,
    runCount: NonNegativeInt,
    nextRunAt: ScheduledTask.fields.nextRunAt,
  }),
  dependencies: [...commandTool.dependencies, ScheduledTaskService.ScheduledTaskService],
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const ThreadToolkit = Toolkit.make(
  ScheduledTaskRunTool,
  ThreadSearchTool,
  ThreadForkTool,
  ThreadMergeBackTool,
  ThreadTransfersTool,
  ThreadConfigurationTool,
  ThreadConfigureTool,
  PendingRequestListTool,
  PendingRequestReadTool,
  PendingRequestRespondTool,
  ThreadOrganizeTool,
  ThreadRecordDeliveryTool,
  QueueListTool,
  QueueReadTool,
  QueueEditTool,
  QueueCancelTool,
  QueueReorderTool,
  QueuePromoteTool,
  QueueResumeTool,
);
