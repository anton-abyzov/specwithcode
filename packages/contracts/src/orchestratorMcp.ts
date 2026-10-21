import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import {
  ContextTransferId,
  EnvironmentId,
  IsoDateTime,
  MessageId,
  NodeId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RunId,
  RuntimeRequestId,
  ScheduledTaskId,
  SecretRef,
  ThreadId,
  TrimmedNonEmptyString,
  TurnItemId,
} from "./baseSchemas.ts";
import {
  ScheduledTaskBrief,
  ScheduledTaskCheck,
  ScheduledTaskRunStatus,
  ScheduledTaskSchedule,
  ScheduledTaskUpsertSchedule,
} from "./scheduledTask.ts";
import { HandoffMachineThreadOutcome } from "./handoffMode.ts";
import { ModelSelection } from "./modelSelection.ts";
import { TaskClass, TaskRoutingDecision } from "./taskRouting.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";
import { ThreadLinkedPullRequest } from "./threadPullRequest.ts";
import {
  ThreadExecutionHistoryEntry,
  ThreadExecutionState,
  ThreadSourceRoot,
} from "./threadExecution.ts";
import { ThreadTitleRegeneration } from "./threadTitle.ts";
import {
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  OrchestrationV2RunStatus,
  OrchestrationV2TurnItemStatus,
} from "./orchestrationV2.ts";
import {
  ProviderOptionDescriptor,
  ProviderOptionSelection,
  ProviderOptionSelectionValue,
} from "./model.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

const OrchestratorMcpPrompt = TrimmedNonEmptyString.check(Schema.isMaxLength(120_000)).annotate({
  description: "Complete task or message text for the target agent.",
});
const OrchestratorMcpTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(512)).annotate({
  description: "Optional concise display title.",
});
const OrchestratorMcpClientRequestId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(256),
).annotate({ description: "Stable idempotency key to reuse when retrying this mutation." });

/**
 * Another of the user's machines, as `studio_machine_list` names it: its fleet
 * id or its label (case-insensitive), or "local" for this machine.
 */
export const OrchestratorMcpMachineTarget = TrimmedNonEmptyString.check(
  Schema.isMaxLength(80),
).annotate({
  description:
    "Machine to act on: a fleet id or label from studio_machine_list, or 'local'. Omit for this machine.",
});
export type OrchestratorMcpMachineTarget = typeof OrchestratorMcpMachineTarget.Type;

/** The machine a remote thread lives on, as tool results report it. */
export const OrchestratorMcpMachineRef = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  environmentId: EnvironmentId,
});
export type OrchestratorMcpMachineRef = typeof OrchestratorMcpMachineRef.Type;

/** The most machines one chain of remote launches may name. */
export const ORCHESTRATOR_MCP_DELEGATION_MAX_PATH = 16;

/**
 * Which machines a remote launch came through, oldest first, ending with the
 * machine that sends it, and how many machine hops it has made. Set by
 * SpecWithCode itself on launches between machines; the receiving machine
 * refuses a launch whose path already names it or whose hops exceed what it
 * allows the sender.
 */
export const OrchestratorMcpDelegation = Schema.Struct({
  path: Schema.Array(EnvironmentId).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(ORCHESTRATOR_MCP_DELEGATION_MAX_PATH),
  ),
  hops: PositiveInt.check(Schema.isLessThanOrEqualTo(ORCHESTRATOR_MCP_DELEGATION_MAX_PATH)),
}).annotate({
  description:
    "Set by SpecWithCode between machines; agents never pass it. The machines this launch came through and its hop count.",
});
export type OrchestratorMcpDelegation = typeof OrchestratorMcpDelegation.Type;

/**
 * OpenCode 1.15 has been observed serializing nested MCP union objects as JSON
 * strings. Keep the structured object as the documented form while accepting
 * that compatibility shape at the tool boundary and decoding it immediately.
 */
const OrchestratorMcpScheduleFromJsonString = Schema.fromJsonString(
  ScheduledTaskUpsertSchedule,
).annotate({
  description:
    "Compatibility-only JSON encoding of the schedule object. Prefer a structured object.",
});

const OrchestratorMcpSchedule = Schema.Union([
  ScheduledTaskUpsertSchedule,
  OrchestratorMcpScheduleFromJsonString,
]).annotate({
  description:
    "Trigger object: {type:'interval', everyMs}, {type:'fixed_time', timeOfDay, weekdays?}, {type:'monthly', dayOfMonth (1-28), timeOfDay}, {type:'manual'} to run only when asked (Run now or run_scheduled_task_now), or {type:'webhook'} to run on each request to a generated URL. Never stringify it unless the provider requires the compatibility form.",
});

/**
 * Shorthand `{ id: value }` record form for target model options. Unlike the
 * legacy-tolerant `ProviderOptionSelections` persistence schema, this decodes
 * strictly: a value that is not a string or boolean fails the request rather
 * than being silently dropped.
 */
const OrchestratorMcpTargetOptionsFromRecord = Schema.Record(
  Schema.String,
  ProviderOptionSelectionValue,
).pipe(
  Schema.decodeTo(
    Schema.Array(ProviderOptionSelection),
    SchemaTransformation.transformEffect({
      decode: (record) =>
        Effect.succeed(Object.entries(record).map(([id, value]) => ({ id, value }))),
      encode: (selections: ReadonlyArray<ProviderOptionSelection>) =>
        Effect.succeed(
          Object.fromEntries(selections.map((selection) => [selection.id, selection.value])),
        ),
    }),
  ),
);

export const OrchestratorMcpTargetOptions = Schema.Union([
  Schema.Array(ProviderOptionSelection),
  OrchestratorMcpTargetOptionsFromRecord,
]);
export type OrchestratorMcpTargetOptions = typeof OrchestratorMcpTargetOptions.Type;

const OrchestratorMcpTargetFields = {
  providerInstanceId: Schema.optional(
    ProviderInstanceId.annotate({
      description: "Configured provider instance id from orchestrator_capabilities.",
    }),
  ),
  driverKind: Schema.optional(
    ProviderDriverKind.annotate({
      description: "Provider driver kind; prefer providerInstanceId when available.",
    }),
  ),
  model: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Model id advertised for the selected provider instance.",
    }),
  ),
  /**
   * Model option selections for the child (for example reasoning effort).
   * Accepts the canonical `[{ id, value }]` array or the shorthand
   * `{ id: value }` record; valid ids come from the option descriptors
   * advertised by orchestrator_capabilities. When omitted, options inherit
   * from the parent only when the child runs the parent's provider and model.
   */
  options: Schema.optional(
    OrchestratorMcpTargetOptions.annotate({
      description: "Model option selections advertised by orchestrator_capabilities.",
    }),
  ),
  effort: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Reasoning effort the user asked for, e.g. 'low', 'medium', 'high', 'xhigh' (extra high) or 'max'. Mapped to the model's own effort option; when the model lacks that level the nearest one it offers is used, and a model without an effort setting is rejected.",
    }),
  ),
};
// An unknown key (for example `reasoningEffort`) must fail the call instead
// of being dropped, or the child silently runs at the default.
export const OrchestratorMcpTarget = Schema.StructWithRest(
  Schema.Struct(OrchestratorMcpTargetFields),
  [Schema.Record(Schema.String, Schema.Unknown)],
).check(
  Schema.makeFilter((value) => {
    const unknown = Object.keys(value).filter((key) => !(key in OrchestratorMcpTargetFields));
    return unknown.length === 0
      ? true
      : `Unknown target key(s): ${unknown.join(", ")}. Use target.effort for reasoning effort and target.options for other model options.`;
  }),
);
export type OrchestratorMcpTarget = typeof OrchestratorMcpTarget.Type;

export const OrchestratorMcpRuntimeMode = Schema.Union([Schema.Literal("inherit"), RuntimeMode]);
export type OrchestratorMcpRuntimeMode = typeof OrchestratorMcpRuntimeMode.Type;

export const OrchestratorMcpInteractionMode = Schema.Union([
  Schema.Literal("inherit"),
  ProviderInteractionMode,
]);
export type OrchestratorMcpInteractionMode = typeof OrchestratorMcpInteractionMode.Type;

export const OrchestratorMcpTaskRole = Schema.Literals([
  "implementation",
  "research",
  "review",
  "design",
  "test",
  "general",
]);
export type OrchestratorMcpTaskRole = typeof OrchestratorMcpTaskRole.Type;

export const OrchestratorMcpDelegatedTaskStatus = Schema.Literals([
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export type OrchestratorMcpDelegatedTaskStatus = typeof OrchestratorMcpDelegatedTaskStatus.Type;

export const OrchestratorMcpTerminalDelegatedTaskStatus = Schema.Literals([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export type OrchestratorMcpTerminalDelegatedTaskStatus =
  typeof OrchestratorMcpTerminalDelegatedTaskStatus.Type;

export const OrchestratorMcpTaskClassHint = TaskClass.annotate({
  description:
    "Optional kind of work, used only when Auto model routing is on and no model is named: translation, transcript (speech or transcript processing; audio is transcribed by a speech-to-text tool first, never by the text model), summary, research, animation-draft, animation-final, code, review, design or general. A named model always wins.",
});

export const OrchestratorMcpDelegateTaskInput = Schema.Struct({
  task: OrchestratorMcpPrompt.annotate({
    description: "Self-contained task for one delegated child agent/subagent.",
  }),
  target: Schema.optional(OrchestratorMcpTarget),
  taskClass: Schema.optional(OrchestratorMcpTaskClassHint),
  title: Schema.optional(OrchestratorMcpTitle),
  role: Schema.optional(OrchestratorMcpTaskRole),
  mode: Schema.optional(
    Schema.Literals(["async", "wait"]).annotate({
      description:
        "Defaults to async. Use wait only when this turn needs the child's result before you can continue.",
    }),
  ),
  timeoutMs: Schema.optional(Schema.Number).annotate({
    description:
      "Wait budget for mode=wait only. Default 10 minutes. Elapsing it returns waitTimedOut=true on that call and does not cancel the child.",
  }),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
  runtimeMode: Schema.optional(OrchestratorMcpRuntimeMode),
  interactionMode: Schema.optional(OrchestratorMcpInteractionMode),
  machine: Schema.optional(
    OrchestratorMcpMachineTarget.annotate({
      description:
        "Only 'local' is accepted: delegated children always run on this machine. Start work on another machine with studio_thread_launch and machine.",
    }),
  ),
});
export type OrchestratorMcpDelegateTaskInput = typeof OrchestratorMcpDelegateTaskInput.Type;

const OrchestratorMcpThreadLink = Schema.String.annotate({
  description:
    "Ready-made Markdown link to this thread, [title](studio://thread/<encoded id>). Copy it verbatim when naming the thread to the user; never build a thread link by hand.",
});

export const OrchestratorMcpDelegateTaskResult = Schema.Struct({
  taskId: NodeId,
  childThreadId: ThreadId,
  threadLink: OrchestratorMcpThreadLink,
  childRunId: Schema.NullOr(RunId),
  childNodeId: NodeId,
  status: OrchestratorMcpDelegatedTaskStatus,
  workState: Schema.Literals(["working", "waiting_for_children", "result_available"]),
  hasPendingChildRuns: Schema.Boolean,
  heldQueuedMessages: Schema.optional(
    NonNegativeInt.annotate({
      description:
        "Queued messages waiting in this thread's held queue (after Stop, a restart or a provider failure). They are not delivered until the queue is resumed: by the user's Resume, by studio_queue_resume, or by another message sent to the thread. Omitted when nothing is held.",
    }),
  ),
  latestTerminalRunId: Schema.NullOr(RunId),
  latestTerminalStatus: Schema.NullOr(OrchestratorMcpTerminalDelegatedTaskStatus),
  latestTerminalSummary: Schema.NullOr(Schema.String),
  latestTerminalResultContextTransferId: Schema.NullOr(ContextTransferId),
  providerInstanceId: ProviderInstanceId,
  model: Schema.NullOr(Schema.String),
  effort: Schema.optional(
    Schema.String.annotate({
      description: "Reasoning effort option the child was started with, when one was set.",
    }),
  ),
  routing: Schema.optional(
    TaskRoutingDecision.annotate({
      description:
        "Set when Auto model routing chose the model: the task class, the reason and the baseline it left. If this task fails and `escalation` is set, you may retry it once with that provider and model; it is never retried for you.",
    }),
  ),
  summary: Schema.NullOr(Schema.String),
  resultContextTransferId: Schema.NullOr(ContextTransferId),
  waitTimedOut: Schema.Boolean.annotate({
    description:
      "True only on that mode=wait call when timeoutMs elapsed. The timeout does not cancel the child. Later task_status reads return false and use status for liveness.",
  }),
});
export type OrchestratorMcpDelegateTaskResult = typeof OrchestratorMcpDelegateTaskResult.Type;

export const OrchestratorMcpTaskStatusInput = Schema.Struct({
  taskId: NodeId,
});
export type OrchestratorMcpTaskStatusInput = typeof OrchestratorMcpTaskStatusInput.Type;

export const OrchestratorMcpTaskCancelInput = Schema.Struct({
  taskId: NodeId,
  reason: Schema.optional(Schema.String.check(Schema.isMaxLength(2_000))),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type OrchestratorMcpTaskCancelInput = typeof OrchestratorMcpTaskCancelInput.Type;

export const OrchestratorMcpTaskCancelResult = Schema.Struct({
  taskId: NodeId,
  status: Schema.Literals(["cancel_requested", "completed", "failed", "cancelled", "interrupted"]),
});
export type OrchestratorMcpTaskCancelResult = typeof OrchestratorMcpTaskCancelResult.Type;

export const OrchestratorMcpCreateThreadRequest = Schema.Struct({
  prompt: Schema.optional(OrchestratorMcpPrompt),
  title: Schema.optional(OrchestratorMcpTitle),
  target: Schema.optional(OrchestratorMcpTarget),
  taskClass: Schema.optional(OrchestratorMcpTaskClassHint),
  runtimeMode: Schema.optional(OrchestratorMcpRuntimeMode),
  interactionMode: Schema.optional(OrchestratorMcpInteractionMode),
});
export type OrchestratorMcpCreateThreadRequest = typeof OrchestratorMcpCreateThreadRequest.Type;

export const OrchestratorMcpCreateThreadsInput = Schema.Struct({
  threads: Schema.Array(OrchestratorMcpCreateThreadRequest).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(20),
  ),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type OrchestratorMcpCreateThreadsInput = typeof OrchestratorMcpCreateThreadsInput.Type;

export const OrchestratorMcpCreatedThreadStatus = Schema.Union([
  Schema.Literal("idle"),
  Schema.Literal("preparing"),
  Schema.Literal("starting"),
  OrchestratorMcpDelegatedTaskStatus,
  Schema.Literal("rolled_back"),
]);
export type OrchestratorMcpCreatedThreadStatus = typeof OrchestratorMcpCreatedThreadStatus.Type;

export const OrchestratorMcpCreatedThread = Schema.Struct({
  threadId: ThreadId,
  threadLink: OrchestratorMcpThreadLink,
  runId: Schema.NullOr(RunId),
  status: OrchestratorMcpCreatedThreadStatus,
  title: Schema.String,
  createdBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
  effort: Schema.optional(
    Schema.String.annotate({
      description: "Reasoning effort option the thread was started with, when one was set.",
    }),
  ),
  routing: Schema.optional(TaskRoutingDecision),
});
export type OrchestratorMcpCreatedThread = typeof OrchestratorMcpCreatedThread.Type;

export const OrchestratorMcpCreateThreadsResult = Schema.Struct({
  threads: Schema.Array(OrchestratorMcpCreatedThread),
});
export type OrchestratorMcpCreateThreadsResult = typeof OrchestratorMcpCreateThreadsResult.Type;

export const OrchestratorMcpThreadStatus = Schema.Union([
  Schema.Literal("idle"),
  OrchestrationV2RunStatus,
]);
export type OrchestratorMcpThreadStatus = typeof OrchestratorMcpThreadStatus.Type;

const OrchestratorMcpProjectTarget = Schema.optional(
  ProjectId.annotate({
    description:
      "Project to act on. Omit for the calling thread's project; required when the caller is not a SpecWithCode thread.",
  }),
);

export const OrchestratorMcpThreadListInput = Schema.Struct({
  machine: Schema.optional(
    OrchestratorMcpMachineTarget.annotate({
      description:
        "List one machine only. Omit machine for a coordinator's logical-project inventory. projectId on an explicit remote machine names its project.",
    }),
  ),
  projectId: OrchestratorMcpProjectTarget,
  statuses: Schema.optional(
    Schema.Array(OrchestratorMcpThreadStatus).check(Schema.isMaxLength(10)),
  ),
  titleContains: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  settled: Schema.optional(Schema.Boolean),
  includeSubagents: Schema.optional(Schema.Boolean),
  includeArchived: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Include archived threads; defaults to true for a federated coordinator inventory, false for a single machine.",
    }),
  ),
  cursor: Schema.optional(NonNegativeInt),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(100))),
});
export type OrchestratorMcpThreadListInput = typeof OrchestratorMcpThreadListInput.Type;

/** Where a thread lives and runs; see threadExecution.ts. Omitted by older servers. */
const OrchestratorMcpThreadExecutionFields = {
  ownerMachineId: Schema.optional(
    EnvironmentId.annotate({
      description: "Environment id of the machine the thread lives on (its project's machine).",
    }),
  ),
  executionMachineId: Schema.optional(
    EnvironmentId.annotate({
      description:
        "Environment id of the machine that runs the thread now. Differs from ownerMachineId after a handoff.",
    }),
  ),
  executionMachineLabel: Schema.optional(Schema.String),
  executionState: Schema.optional(
    ThreadExecutionState.annotate({
      description:
        "running: the execution machine holds the thread's lease. fenced: this copy was handed off and takes no new turns. unknown: the execution machine is unreachable; executionLastSeenAt says when it last answered. Never read unknown as idle.",
    }),
  ),
  executionLastSeenAt: Schema.optional(Schema.NullOr(IsoDateTime)),
} as const;

export const OrchestratorMcpThreadListItem = Schema.Struct({
  threadId: ThreadId,
  /** Always use the compound reference for cross-machine reads. */
  threadRef: Schema.optional(Schema.String),
  environmentId: Schema.optional(EnvironmentId),
  projectId: Schema.optional(ProjectId),
  machine: Schema.optional(OrchestratorMcpMachineRef),
  archived: Schema.optional(Schema.Boolean),
  title: Schema.String,
  threadLink: OrchestratorMcpThreadLink,
  createdBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
  status: OrchestratorMcpThreadStatus,
  latestRunId: Schema.NullOr(RunId),
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  linkedPullRequest: Schema.NullOr(ThreadLinkedPullRequest),
  settled: Schema.Boolean,
  settledAt: Schema.NullOr(IsoDateTime),
  parentThreadId: Schema.NullOr(ThreadId),
  relationshipToParent: Schema.NullOr(Schema.Literals(["fork", "subagent"])),
  itemCount: NonNegativeInt,
  heldQueuedMessages: Schema.optional(
    NonNegativeInt.annotate({
      description:
        "Queued messages waiting in this thread's held queue (after Stop, a restart or a provider failure). They are not delivered until the queue is resumed: by the user's Resume, by studio_queue_resume, or by another message sent to the thread. Omitted when nothing is held.",
    }),
  ),
  ...OrchestratorMcpThreadExecutionFields,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestratorMcpThreadListItem = typeof OrchestratorMcpThreadListItem.Type;

export const OrchestratorMcpProjectThreadInventoryMember = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  machine: Schema.optional(OrchestratorMcpMachineRef),
  status: Schema.Literals(["complete", "partial", "unavailable"]),
  total: Schema.optional(NonNegativeInt),
  code: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});
export type OrchestratorMcpProjectThreadInventoryMember =
  typeof OrchestratorMcpProjectThreadInventoryMember.Type;

export const OrchestratorMcpThreadListResult = Schema.Struct({
  logicalProjectId: Schema.optional(Schema.String),
  /** False only when every linked binding answered completely. total is a lower bound when true. */
  partial: Schema.optional(Schema.Boolean),
  members: Schema.optional(Schema.Array(OrchestratorMcpProjectThreadInventoryMember)),
  /** Acknowledges archive support; absent on older servers. */
  includeArchived: Schema.optional(Schema.Boolean),
  machine: Schema.optional(OrchestratorMcpMachineRef),
  projectId: ProjectId,
  /** The calling thread, or null when the caller is not a Studio thread. */
  currentThreadId: Schema.NullOr(ThreadId),
  threads: Schema.Array(OrchestratorMcpThreadListItem),
  nextCursor: Schema.NullOr(NonNegativeInt),
  total: NonNegativeInt,
});
export type OrchestratorMcpThreadListResult = typeof OrchestratorMcpThreadListResult.Type;

export const OrchestratorMcpThreadReadInput = Schema.Struct({
  machine: Schema.optional(OrchestratorMcpMachineTarget),
  threadId: ThreadId,
  itemId: Schema.optional(TurnItemId),
  textOffset: Schema.optional(NonNegativeInt),
  view: Schema.optional(Schema.Literals(["messages", "activity"])),
  afterPosition: Schema.optional(NonNegativeInt),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(100))),
  runLimit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(50))),
  maxCharsPerItem: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(50_000))),
});
export type OrchestratorMcpThreadReadInput = typeof OrchestratorMcpThreadReadInput.Type;

export const OrchestratorMcpThreadDetail = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  createdBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
  status: OrchestratorMcpThreadStatus,
  latestRunId: Schema.NullOr(RunId),
  activeRunId: Schema.NullOr(RunId),
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  linkedPullRequest: Schema.NullOr(ThreadLinkedPullRequest),
  titleRegeneration: Schema.NullOr(ThreadTitleRegeneration),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  parentThreadId: Schema.NullOr(ThreadId),
  relationshipToParent: Schema.NullOr(Schema.Literals(["fork", "subagent"])),
  runCount: NonNegativeInt,
  itemCount: NonNegativeInt,
  pendingRequestCount: NonNegativeInt,
  heldQueuedMessages: Schema.optional(
    NonNegativeInt.annotate({
      description:
        "Queued messages waiting in this thread's held queue (after Stop, a restart or a provider failure). They are not delivered until the queue is resumed: by the user's Resume, by studio_queue_resume, or by another message sent to the thread. Omitted when nothing is held.",
    }),
  ),
  archived: Schema.Boolean,
  settled: Schema.Boolean,
  settledAt: Schema.NullOr(IsoDateTime),
  ...OrchestratorMcpThreadExecutionFields,
  /** Each stretch of execution: [machine, from, to, reason]. Omitted when it never moved. */
  executionHistory: Schema.optional(Schema.Array(ThreadExecutionHistoryEntry)),
  /** Where a continuation came from. Omitted unless it arrived through a handoff. */
  sourceRoot: Schema.optional(ThreadSourceRoot),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestratorMcpThreadDetail = typeof OrchestratorMcpThreadDetail.Type;

export const OrchestratorMcpThreadRun = Schema.Struct({
  runId: RunId,
  ordinal: PositiveInt,
  status: OrchestrationV2RunStatus,
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestratorMcpThreadRun = typeof OrchestratorMcpThreadRun.Type;

export const OrchestratorMcpThreadTimelineItem = Schema.Struct({
  position: NonNegativeInt,
  visibility: Schema.Literals(["local", "inherited", "synthetic"]),
  sourceThreadId: ThreadId,
  itemId: TurnItemId,
  runId: Schema.NullOr(RunId),
  messageId: Schema.NullOr(MessageId),
  createdBy: Schema.NullOr(OrchestrationV2Actor),
  creationSource: Schema.NullOr(OrchestrationV2CreationSource),
  type: Schema.String,
  status: OrchestrationV2TurnItemStatus,
  title: Schema.NullOr(Schema.String),
  text: Schema.NullOr(Schema.String),
  textTruncated: Schema.Boolean,
  nextTextOffset: Schema.optional(Schema.NullOr(NonNegativeInt)),
  updatedAt: IsoDateTime,
});
export type OrchestratorMcpThreadTimelineItem = typeof OrchestratorMcpThreadTimelineItem.Type;

export const OrchestratorMcpThreadReadResult = Schema.Struct({
  machine: Schema.optional(OrchestratorMcpMachineRef),
  thread: OrchestratorMcpThreadDetail,
  recentRuns: Schema.Array(OrchestratorMcpThreadRun),
  items: Schema.Array(OrchestratorMcpThreadTimelineItem),
  nextPosition: Schema.NullOr(NonNegativeInt),
  hasMore: Schema.Boolean,
});
export type OrchestratorMcpThreadReadResult = typeof OrchestratorMcpThreadReadResult.Type;

export const OrchestratorMcpThreadSendInput = Schema.Struct({
  machine: Schema.optional(OrchestratorMcpMachineTarget),
  threadId: ThreadId,
  message: Schema.optional(OrchestratorMcpPrompt),
  forwardMessageId: Schema.optional(
    MessageId.annotate({
      description:
        "A user message in the calling thread to deliver unchanged, as the user's own words. Pass it instead of message to route a 'User follow-up from selected worker' message; it is the ID that message names.",
    }),
  ),
  mode: Schema.optional(Schema.Literals(["auto", "queue", "steer", "restart"])),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type OrchestratorMcpThreadSendInput = typeof OrchestratorMcpThreadSendInput.Type;

export const OrchestratorMcpThreadSendResult = Schema.Struct({
  machine: Schema.optional(OrchestratorMcpMachineRef),
  threadId: ThreadId,
  /** Optional only because an older machine's answer has none. */
  threadLink: Schema.optional(OrchestratorMcpThreadLink),
  messageId: MessageId,
  runId: RunId,
  status: OrchestrationV2RunStatus,
  delivery: Schema.Literals(["started", "queued", "steered", "restarted"]),
  queueHeld: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "True when the message joined the target's held queue: it was NOT delivered and waits until the queue is resumed. Tell whoever needs it, or resume the queue with studio_queue_resume when that is yours to decide.",
    }),
  ),
  heldQueuedMessages: Schema.optional(
    NonNegativeInt.annotate({
      description:
        "Queued messages waiting in this thread's held queue (after Stop, a restart or a provider failure). They are not delivered until the queue is resumed: by the user's Resume, by studio_queue_resume, or by another message sent to the thread. Omitted when nothing is held.",
    }),
  ),
  releasedHeldMessages: Schema.optional(
    NonNegativeInt.annotate({
      description: "Held queued messages this send released: they run after it, in their order.",
    }),
  ),
  notice: Schema.optional(Schema.String),
});
export type OrchestratorMcpThreadSendResult = typeof OrchestratorMcpThreadSendResult.Type;

export const OrchestratorMcpThreadWaitInput = Schema.Struct({
  machine: Schema.optional(OrchestratorMcpMachineTarget),
  threadId: ThreadId,
  runId: Schema.optional(RunId),
  timeoutMs: Schema.optional(Schema.Number),
});
export type OrchestratorMcpThreadWaitInput = typeof OrchestratorMcpThreadWaitInput.Type;

export const OrchestratorMcpThreadWaitResult = Schema.Struct({
  machine: Schema.optional(OrchestratorMcpMachineRef),
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  status: OrchestratorMcpThreadStatus,
  timedOut: Schema.Boolean,
});
export type OrchestratorMcpThreadWaitResult = typeof OrchestratorMcpThreadWaitResult.Type;

export const OrchestratorMcpThreadInterruptInput = Schema.Struct({
  machine: Schema.optional(OrchestratorMcpMachineTarget),
  threadId: ThreadId,
  runId: Schema.optional(RunId),
  reason: Schema.optional(Schema.String.check(Schema.isMaxLength(2_000))),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type OrchestratorMcpThreadInterruptInput = typeof OrchestratorMcpThreadInterruptInput.Type;

export const OrchestratorMcpThreadInterruptResult = Schema.Struct({
  machine: Schema.optional(OrchestratorMcpMachineRef),
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  status: Schema.Union([
    Schema.Literal("interrupt_requested"),
    Schema.Literal("no_active_run"),
    Schema.Literals(["completed", "failed", "cancelled", "interrupted", "rolled_back"]),
  ]),
});
export type OrchestratorMcpThreadInterruptResult = typeof OrchestratorMcpThreadInterruptResult.Type;

export const OrchestratorMcpThreadsStopAllInput = Schema.Struct({
  projectId: OrchestratorMcpProjectTarget,
  reason: Schema.optional(Schema.String.check(Schema.isMaxLength(2_000))),
});
export type OrchestratorMcpThreadsStopAllInput = typeof OrchestratorMcpThreadsStopAllInput.Type;

export const OrchestratorMcpThreadsContinueAllInput = Schema.Struct({
  projectId: OrchestratorMcpProjectTarget,
});
export type OrchestratorMcpThreadsContinueAllInput =
  typeof OrchestratorMcpThreadsContinueAllInput.Type;

/** One thread a bulk stop or continue acted on, or skipped and why. */
export const OrchestratorMcpBulkThreadResult = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  threadLink: Schema.String,
  runId: Schema.NullOr(RunId),
  status: Schema.Literals(["stop_requested", "continued", "skipped", "failed"]),
  message: Schema.optional(Schema.String),
});
export type OrchestratorMcpBulkThreadResult = typeof OrchestratorMcpBulkThreadResult.Type;

export const OrchestratorMcpThreadsBulkResult = Schema.Struct({
  projectId: ProjectId,
  /** Threads stopped or continued; skipped and failed threads are listed but not counted. */
  count: NonNegativeInt,
  threads: Schema.Array(OrchestratorMcpBulkThreadResult),
});
export type OrchestratorMcpThreadsBulkResult = typeof OrchestratorMcpThreadsBulkResult.Type;

/** The most threads one migrate call moves, as the handoff service accepts. */
export const ORCHESTRATOR_MCP_MIGRATE_MAX_THREADS = 100;

export const OrchestratorMcpThreadMigrateInput = Schema.Struct({
  machine: OrchestratorMcpMachineTarget.annotate({
    description:
      "Destination machine: a fleet id or label from studio_machine_list. It must be another machine; it is never substituted.",
  }),
  threadIds: Schema.optional(
    Schema.Array(ThreadId)
      .check(Schema.isMinLength(1), Schema.isMaxLength(ORCHESTRATOR_MCP_MIGRATE_MAX_THREADS))
      .annotate({
        description:
          "Threads of this project to move. Omit to move every running handoff-mode thread of this project.",
      }),
  ),
  modelSelection: Schema.optional(ModelSelection).annotate({
    description:
      "Model to continue with on the destination. Only with exactly one thread; omitted keeps its model or the destination's default.",
  }),
});
export type OrchestratorMcpThreadMigrateInput = typeof OrchestratorMcpThreadMigrateInput.Type;

/** One thread a migrate call moved, left in place with the exact reason, or skipped. */
export const OrchestratorMcpThreadMigrateThreadResult = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  outcome: HandoffMachineThreadOutcome,
  detail: Schema.NullOr(Schema.String),
  continuedThreadId: Schema.NullOr(ThreadId),
  /** Whether the destination resumed the run; null when the handoff does not report it. */
  resumed: Schema.NullOr(Schema.Boolean),
});
export type OrchestratorMcpThreadMigrateThreadResult =
  typeof OrchestratorMcpThreadMigrateThreadResult.Type;

export const OrchestratorMcpThreadMigrateResult = Schema.Struct({
  destination: Schema.Struct({ environmentId: EnvironmentId, label: Schema.String }),
  reason: Schema.Literal("manual"),
  results: Schema.Array(OrchestratorMcpThreadMigrateThreadResult),
  /** One line, such as "2 moved, 1 stayed to Mac mini." */
  summary: Schema.String,
});
export type OrchestratorMcpThreadMigrateResult = typeof OrchestratorMcpThreadMigrateResult.Type;

export const OrchestratorMcpHandoffReadyListInput = Schema.Struct({
  includeContinued: Schema.optional(Schema.Boolean).annotate({
    description: "Also list threads this machine already continued. Defaults to false.",
  }),
});
export type OrchestratorMcpHandoffReadyListInput = typeof OrchestratorMcpHandoffReadyListInput.Type;

/** A thread another machine replicated here for this project, which this machine can continue. */
export const OrchestratorMcpHandoffReadyThread = Schema.Struct({
  source: Schema.Struct({ environmentId: EnvironmentId, label: Schema.String }),
  sourceThreadId: ThreadId,
  title: Schema.String,
  checkpointAt: IsoDateTime,
  branch: Schema.NullOr(Schema.String),
  sourceUnreachable: Schema.Boolean,
  sourceLastSeenAt: Schema.NullOr(IsoDateTime),
  /** False while the source still renews the lease: continuing now is refused as busy. */
  canContinueNow: Schema.Boolean,
  continuedThreadId: Schema.NullOr(ThreadId),
});
export type OrchestratorMcpHandoffReadyThread = typeof OrchestratorMcpHandoffReadyThread.Type;

export const OrchestratorMcpHandoffReadyListResult = Schema.Struct({
  projectId: ProjectId,
  threads: Schema.Array(OrchestratorMcpHandoffReadyThread),
});
export type OrchestratorMcpHandoffReadyListResult =
  typeof OrchestratorMcpHandoffReadyListResult.Type;

export const OrchestratorMcpThreadContinueHereInput = Schema.Struct({
  sourceThreadId: ThreadId.annotate({
    description: "The source machine's thread id, from studio_handoff_ready_list.",
  }),
  machine: Schema.optional(OrchestratorMcpMachineTarget).annotate({
    description:
      "The source machine's id or label, only needed when two machines replicated the same thread id.",
  }),
  modelSelection: Schema.optional(ModelSelection).annotate({
    description:
      "Model to continue with here; omitted keeps the thread's model or this machine's default.",
  }),
});
export type OrchestratorMcpThreadContinueHereInput =
  typeof OrchestratorMcpThreadContinueHereInput.Type;

export const OrchestratorMcpThreadContinueHereResult = Schema.Struct({
  source: Schema.Struct({ environmentId: EnvironmentId, label: Schema.String }),
  sourceThreadId: ThreadId,
  /** The thread that continues the work on this machine. */
  threadId: ThreadId,
  machineLabel: Schema.String,
  modelSelection: Schema.NullOr(ModelSelection),
  notice: Schema.NullOr(Schema.String),
});
export type OrchestratorMcpThreadContinueHereResult =
  typeof OrchestratorMcpThreadContinueHereResult.Type;

/**
 * What a machine shares about one provider's usage so another machine can
 * judge it as a limit handoff target. Never a token or an account name: the
 * account is a salted sha256 of the provider's account identity, equal on
 * every machine signed in to the same account or key.
 */
export const OrchestratorMcpProviderUsage = Schema.Struct({
  accountFingerprint: Schema.NullOr(Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/))),
  /** The fullest live usage window, or null when the provider reports none. */
  usedPercent: Schema.NullOr(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
  resetsAt: Schema.NullOr(IsoDateTime),
  signedIn: Schema.Boolean,
  /** When the usage was read; null when it never was. */
  observedAt: Schema.NullOr(IsoDateTime),
  /** The provider refused ordinary use after that read. */
  limited: Schema.optional(Schema.Boolean),
});
export type OrchestratorMcpProviderUsage = typeof OrchestratorMcpProviderUsage.Type;

export const OrchestratorMcpProviderCapability = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  driverKind: ProviderDriverKind,
  displayName: Schema.NullOr(Schema.String),
  models: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      label: Schema.NullOr(Schema.String),
      /** Model options a target may select (for example reasoning effort). */
      options: Schema.optional(Schema.Array(ProviderOptionDescriptor)),
    }),
  ),
  canRunChildTask: Schema.Boolean,
  canRunCrossProviderChildTask: Schema.Boolean,
  constraints: Schema.Array(Schema.String),
  /** Usage and account pool, for limit handoff targets. Older machines omit it. */
  usage: Schema.optional(OrchestratorMcpProviderUsage),
  /** Whether the caller's work grant lets it run this provider. Omitted without a grant. */
  allowedByGrant: Schema.optional(Schema.Boolean),
});
export type OrchestratorMcpProviderCapability = typeof OrchestratorMcpProviderCapability.Type;

export const OrchestratorMcpCapabilitiesResult = Schema.Struct({
  /** The calling thread, or null when the caller is not a Studio thread. */
  parentThreadId: Schema.NullOr(ThreadId),
  /** The calling thread's selection, or null when the caller is not a Studio thread. */
  inheritedProviderInstanceId: Schema.NullOr(ProviderInstanceId),
  inheritedModel: Schema.NullOr(Schema.String),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  providers: Schema.Array(OrchestratorMcpProviderCapability),
  features: Schema.Struct({
    appOwnedSubagents: Schema.Boolean,
    asyncPolling: Schema.Boolean,
    cancellation: Schema.Boolean,
    batchThreadCreation: Schema.Boolean,
    threadManagement: Schema.Boolean,
    incrementalThreadRead: Schema.Boolean,
    scheduledTasks: Schema.Boolean,
    maxBatchThreads: Schema.Number,
  }),
});
export type OrchestratorMcpCapabilitiesResult = typeof OrchestratorMcpCapabilitiesResult.Type;

export const OrchestratorMcpMachineStatus = Schema.Literals([
  "ready",
  "needs_grant",
  "grant_expiring",
  "grant_revoked",
  "grant_expired",
  "unreachable",
  "identity_mismatch",
  "unsupported",
]);
export type OrchestratorMcpMachineStatus = typeof OrchestratorMcpMachineStatus.Type;

export const OrchestratorMcpMachineProject = Schema.Struct({
  match: Schema.Literals(["configured", "identity", "none", "ambiguous"]),
  projectId: Schema.optional(ProjectId),
  title: Schema.optional(Schema.String),
  candidates: Schema.optional(
    Schema.Array(Schema.Struct({ projectId: ProjectId, title: Schema.String })),
  ),
});
export type OrchestratorMcpMachineProject = typeof OrchestratorMcpMachineProject.Type;

export const OrchestratorMcpMachineProvider = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  driverKind: ProviderDriverKind,
  models: Schema.Array(Schema.String),
  available: Schema.Boolean,
  usage: Schema.optional(OrchestratorMcpProviderUsage),
  allowedByGrant: Schema.optional(Schema.Boolean),
});
export type OrchestratorMcpMachineProvider = typeof OrchestratorMcpMachineProvider.Type;

export const OrchestratorMcpMachine = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  environmentId: EnvironmentId,
  status: OrchestratorMcpMachineStatus,
  access: Schema.NullOr(RuntimeMode),
  grantExpiresAt: Schema.NullOr(IsoDateTime),
  project: Schema.optional(OrchestratorMcpMachineProject),
  providers: Schema.optional(Schema.Array(OrchestratorMcpMachineProvider)),
});
export type OrchestratorMcpMachine = typeof OrchestratorMcpMachine.Type;

export const OrchestratorMcpMachineListInput = Schema.Struct({
  projectId: Schema.optional(
    ProjectId.annotate({
      description:
        "Project whose match on each machine to report. Omit for the calling thread's project.",
    }),
  ),
});
export type OrchestratorMcpMachineListInput = typeof OrchestratorMcpMachineListInput.Type;

export const OrchestratorMcpMachineListResult = Schema.Struct({
  local: Schema.Struct({
    id: Schema.Literal("local"),
    label: Schema.String,
    environmentId: EnvironmentId,
  }),
  machines: Schema.Array(OrchestratorMcpMachine),
  /** The machine this project's coordinator starts workers on, or null for this one. */
  projectWorkerMachine: Schema.NullOr(Schema.String),
});
export type OrchestratorMcpMachineListResult = typeof OrchestratorMcpMachineListResult.Type;

export const OrchestratorMcpScheduleTaskInput = Schema.Struct({
  projectId: OrchestratorMcpProjectTarget,
  prompt: OrchestratorMcpPrompt.annotate({
    description: "Prompt executed on every scheduled run.",
  }),
  schedule: OrchestratorMcpSchedule,
  title: Schema.optional(OrchestratorMcpTitle),
  enabled: Schema.optional(
    Schema.Boolean.annotate({ description: "Whether the schedule starts enabled; defaults true." }),
  ),
  /**
   * When true (the default), the scheduled task fires into the calling thread
   * on each run instead of launching a fresh thread. This is the recurring
   * "wake up in this thread" behaviour reserved for agent-created tasks.
   */
  bindToCurrentThread: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "True (default) posts each run into this thread; false creates a fresh top-level thread per run.",
    }),
  ),
  ownThread: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Give the routine a thread of its own, titled after it: the first run starts it and later runs continue it. Implies bindToCurrentThread false. Use for reusable work such as a monthly report.",
    }),
  ),
  brief: Schema.optional(ScheduledTaskBrief).annotate({
    description:
      "Inputs the user named (label and location), the output location and prepareOnly. Every run opens with it and checks the inputs before working.",
  }),
  check: Schema.optional(ScheduledTaskCheck).annotate({
    description:
      "Make this a command routine: run the shell command on each trigger and wake the agent with the prompt (and the command's output) only when it exits 0. Quiet runs use no AI provider. Prefer this for watches such as disk space, a URL's status or a file's existence.",
  }),
  modelSelection: Schema.optional(ModelSelection).annotate({
    description:
      "Pin every run to this provider and model. Omit (recommended) so each run uses the model the thread's next turn would use and never switches its provider.",
  }),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type OrchestratorMcpScheduleTaskInput = typeof OrchestratorMcpScheduleTaskInput.Type;

/** Summary of a scheduled task returned by the schedule/list/update tools. */
export const OrchestratorMcpScheduledTask = Schema.Struct({
  scheduledTaskId: ScheduledTaskId,
  title: Schema.String,
  prompt: Schema.String,
  enabled: Schema.Boolean,
  projectId: ProjectId,
  boundThreadId: Schema.NullOr(ThreadId),
  schedule: ScheduledTaskSchedule,
  nextRunAt: Schema.NullOr(IsoDateTime),
  lastRunStatus: ScheduledTaskRunStatus,
  /** For webhook tasks: the public Studio Connect URL. Absent when this environment has no managed tunnel. */
  webhookUrl: Schema.optional(Schema.String).annotate({
    description:
      "Public URL to give the sender. Absent when this environment has no SpecWithCode Connect managed tunnel; the user must enable SpecWithCode Connect remote access first.",
  }),
  webhookSignature: Schema.optional(Schema.Literals(["none", "set"])).annotate({
    description: "Whether requests must carry a valid signature.",
  }),
  check: Schema.optional(ScheduledTaskCheck),
  brief: Schema.optional(ScheduledTaskBrief),
  ownThread: Schema.optional(Schema.Boolean),
  /** Present only when runs are pinned to one model instead of following the thread. */
  pinnedModel: Schema.optional(ModelSelection),
});
export type OrchestratorMcpScheduledTask = typeof OrchestratorMcpScheduledTask.Type;

export const OrchestratorMcpScheduleTaskResult = OrchestratorMcpScheduledTask;
export type OrchestratorMcpScheduleTaskResult = typeof OrchestratorMcpScheduleTaskResult.Type;

export const OrchestratorMcpListScheduledTasksInput = Schema.Struct({
  projectId: Schema.optional(
    ProjectId.annotate({
      description:
        "Only list this project's tasks. Omit for the calling thread's project, or for every project when the caller is not a SpecWithCode thread.",
    }),
  ),
});
export type OrchestratorMcpListScheduledTasksInput =
  typeof OrchestratorMcpListScheduledTasksInput.Type;

export const OrchestratorMcpListScheduledTasksResult = Schema.Struct({
  tasks: Schema.Array(OrchestratorMcpScheduledTask),
});
export type OrchestratorMcpListScheduledTasksResult =
  typeof OrchestratorMcpListScheduledTasksResult.Type;

export const OrchestratorMcpUpdateScheduledTaskInput = Schema.Struct({
  scheduledTaskId: ScheduledTaskId,
  prompt: Schema.optional(OrchestratorMcpPrompt),
  title: Schema.optional(OrchestratorMcpTitle),
  schedule: Schema.optional(OrchestratorMcpSchedule),
  enabled: Schema.optional(Schema.Boolean),
  bindToCurrentThread: Schema.optional(Schema.Boolean),
  ownThread: Schema.optional(Schema.Boolean),
  brief: Schema.optional(Schema.NullOr(ScheduledTaskBrief)).annotate({
    description: "Set the routine's brief (see schedule_task), or null to remove it.",
  }),
  check: Schema.optional(Schema.NullOr(ScheduledTaskCheck)).annotate({
    description: "Set a shell check (see schedule_task), or null to remove it.",
  }),
  modelSelection: Schema.optional(Schema.NullOr(ModelSelection)).annotate({
    description:
      "Pin runs to this model, or null to unpin so runs follow the thread's next-turn model.",
  }),
});
export type OrchestratorMcpUpdateScheduledTaskInput =
  typeof OrchestratorMcpUpdateScheduledTaskInput.Type;

export const OrchestratorMcpRequestSecretInput = Schema.Struct({
  label: TrimmedNonEmptyString.annotate({
    description: "What you need, shown as the card's title, e.g. 'GitHub webhook secret'.",
  }),
  reason: TrimmedNonEmptyString.annotate({
    description:
      "One or two sentences on what it is for and where the user gets or also enters it.",
  }),
  placeholder: Schema.optional(TrimmedNonEmptyString).annotate({
    description: "Hint inside the input, e.g. 'Paste your GitHub token'.",
  }),
  timeoutMs: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 60 * 60 * 1_000 })),
  ).annotate({ description: "How long to wait for the user. Default 10 minutes." }),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId).annotate({
    description:
      "Reuse when retrying a call that lost its result, so the user sees one card and its answer is returned again. Use a new id to ask again after timed_out or cancelled.",
  }),
});
export type OrchestratorMcpRequestSecretInput = typeof OrchestratorMcpRequestSecretInput.Type;

export const OrchestratorMcpRequestSecretResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("saved").annotate({ description: "secretRef holds the value." }),
    secretRef: SecretRef.annotate({
      description:
        "Pass it to a tool that accepts a secretRef; it works once, and you never see the value.",
    }),
  }),
  Schema.Struct({
    status: Schema.Literals(["declined", "cancelled", "timed_out"]).annotate({
      description:
        "declined: the user chose not to. cancelled: the request ended with the run. timed_out: the user did not answer in time; the card is closed, so ask again with a new clientRequestId if still needed.",
    }),
  }),
]);
export type OrchestratorMcpRequestSecretResult = typeof OrchestratorMcpRequestSecretResult.Type;

const OrchestratorMcpAskUserOption = Schema.Struct({
  label: TrimmedNonEmptyString.annotate({
    description: "A short choice, e.g. 'Clear caches'. Shown in bold after its letter (A, B, C).",
  }),
  description: Schema.optional(TrimmedNonEmptyString).annotate({
    description:
      "One line on what this choice does. Markdown links, URLs and `path/to/file` are clickable.",
  }),
  recommended: Schema.optional(Schema.Boolean).annotate({
    description: "Mark the one choice you recommend; it gets a Recommended badge.",
  }),
});

const OrchestratorMcpAskUserQuestion = Schema.Struct({
  question: TrimmedNonEmptyString.annotate({
    description:
      "The question, shown as the card's title. Markdown links, URLs and `path/to/file` are clickable.",
  }),
  header: Schema.optional(TrimmedNonEmptyString).annotate({
    description: "A one or two word topic, e.g. 'Disk space'. Defaults to 'Question'.",
  }),
  options: Schema.Array(OrchestratorMcpAskUserOption).check(Schema.isMaxLength(9)).annotate({
    description:
      "Two to five distinct choices. Leave empty for a free-text answer; the user can always reply in chat instead.",
  }),
  multiSelect: Schema.optional(Schema.Boolean).annotate({
    description: "Let the user pick more than one option.",
  }),
});

export const OrchestratorMcpAskUserInput = Schema.Struct({
  questions: Schema.Array(OrchestratorMcpAskUserQuestion)
    .check(Schema.isMinLength(1), Schema.isMaxLength(4))
    .annotate({ description: "Usually one question; at most four asked together." }),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId).annotate({
    description: "Reuse when retrying a call that lost its result, so the user sees one card.",
  }),
});
export type OrchestratorMcpAskUserInput = typeof OrchestratorMcpAskUserInput.Type;

export const OrchestratorMcpAskUserResult = Schema.Struct({
  requestId: RuntimeRequestId,
  status: Schema.Literals(["asked", "answered", "dismissed"]).annotate({
    description:
      "asked: the card is waiting; the user's answer arrives as your next user message, so end your turn or carry on with other work. answered/dismissed: a retried clientRequestId found a card already closed.",
  }),
});
export type OrchestratorMcpAskUserResult = typeof OrchestratorMcpAskUserResult.Type;

export const OrchestratorMcpDeleteScheduledTaskInput = Schema.Struct({
  scheduledTaskId: ScheduledTaskId,
});
export type OrchestratorMcpDeleteScheduledTaskInput =
  typeof OrchestratorMcpDeleteScheduledTaskInput.Type;

export const OrchestratorMcpDeleteScheduledTaskResult = Schema.Struct({
  scheduledTaskId: ScheduledTaskId,
  deleted: Schema.Boolean,
});
export type OrchestratorMcpDeleteScheduledTaskResult =
  typeof OrchestratorMcpDeleteScheduledTaskResult.Type;

export class OrchestratorMcpFailure extends Schema.TaggedError<OrchestratorMcpFailure>()(
  "OrchestratorMcpFailure",
  {
    code: Schema.Literals([
      "capability_denied",
      "parent_not_active",
      "provider_unavailable",
      "model_unavailable",
      "runtime_mode_escalation_denied",
      "interaction_mode_escalation_denied",
      "task_not_found",
      "task_not_cancellable",
      "thread_not_found",
      "run_not_found",
      "thread_not_sendable",
      "thread_not_interruptible",
      "invalid_request",
      "orchestration_error",
      "thread_credential_required",
      "target_required",
      "unknown_machine",
      "machine_unreachable",
      "machine_identity_mismatch",
      "machine_not_authorized",
      "machine_unsupported",
      "project_unavailable_on_machine",
      "project_ambiguous_on_machine",
      "model_unavailable_on_machine",
      "remote_launch_unconfirmed",
      "delegation_is_local",
      "worker_machine_set",
      "delegation_cycle",
      "delegation_limit",
      "outside_grant_scope",
      "account_not_allowed",
      "thread_fenced",
    ]),
    message: Schema.String,
  },
) {}
