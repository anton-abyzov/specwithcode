import {
  backgroundWorkHoldsCompletion,
  classifyRunHealth,
  type RunAwaitingPerson,
  type RunHealth,
} from "@specweave-studio/shared/orchestrationV2PendingBackgroundWork";
import { threadPullRequestsOf } from "@specweave-studio/shared/threadPullRequests";
import type {
  ThreadLinkedPullRequest,
  EnvironmentId,
  MessageId,
  OrchestrationProjectShell,
  OrchestrationV2ProviderGoal,
  OrchestrationV2RunStatus,
  OrchestrationV2ProviderFailureClass,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadProjectMoveLink,
  OrchestrationV2ThreadShell,
  PlanId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";

import { formatSubagentDisplayTitle } from "./subagentDisplay.ts";

export interface EnvironmentProject extends OrchestrationProjectShell {
  readonly environmentId: EnvironmentId;
}

/**
 * A pristine V2 thread projection paired with the environment that produced it.
 *
 * The projection stays nested so the server projection and all structurally
 * shared collections retain their identities. Rich consumers read V2 state
 * directly instead of a second presentation-shaped thread graph.
 */
export interface EnvironmentThread {
  readonly environmentId: EnvironmentId;
  readonly projection: OrchestrationV2ThreadProjection;
}

export interface ThreadRunSummary {
  readonly runId: RunId;
  readonly status: OrchestrationV2RunStatus;
  readonly requestedAt: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly assistantMessageId: MessageId | null;
  readonly sourcePlanRef?: {
    readonly threadId: ThreadId;
    readonly planId: PlanId;
  };
}

export interface ThreadRuntimeSummary {
  readonly status: OrchestrationV2RunStatus | "idle";
  readonly activeRunId: RunId | null;
  readonly activityStartedAt?: string | null | undefined;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerName: string | null;
  readonly lastError: string | null;
  readonly lastErrorClass?: OrchestrationV2ProviderFailureClass | null;
  /** When the run that owns lastError ended; null while it runs or when unknown. */
  readonly lastErrorAt?: string | null;
  readonly usageLimitResetAt?: string | null;
  readonly updatedAt: string;
}

export function threadRuntimeIsActive(runtime: ThreadRuntimeSummary | null | undefined): boolean {
  return runtime !== null && runtime !== undefined && threadRunStatusIsActive(runtime.status);
}

/** Archiving may discard queued work, but it must not detach a provider that
 * is preparing, starting, or running a turn. */
export function threadRuntimeCanArchive(runtime: ThreadRuntimeSummary | null | undefined): boolean {
  if (runtime?.status === "queued") return runtime.activeRunId === null;
  return (
    runtime?.status !== "preparing" &&
    runtime?.status !== "starting" &&
    runtime?.status !== "running"
  );
}

function threadRunStatusIsActive(status: ThreadRuntimeSummary["status"]): boolean {
  return (
    status === "preparing" ||
    status === "queued" ||
    status === "starting" ||
    status === "running" ||
    status === "waiting"
  );
}

export interface EnvironmentThreadShell {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  /** Who started the thread: an agent's own threads are project work, not the user's chats. */
  readonly createdBy?: OrchestrationV2ThreadShell["createdBy"];
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelSelection: OrchestrationV2ThreadShell["modelSelection"];
  readonly modelIdentity?: OrchestrationV2ThreadShell["modelIdentity"];
  readonly runtimeMode: OrchestrationV2ThreadShell["runtimeMode"];
  readonly interactionMode: OrchestrationV2ThreadShell["interactionMode"];
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly lineage: OrchestrationV2ThreadShell["lineage"];
  readonly forkedFrom: OrchestrationV2ThreadShell["forkedFrom"];
  /** Set once the thread moved to another project; it is then archived and takes no turns. */
  readonly movedTo: OrchestrationV2ThreadProjectMoveLink | null;
  /** The thread this one restarted from, in another project. */
  readonly movedFrom: OrchestrationV2ThreadProjectMoveLink | null;
  /**
   * Where it lives and runs, when it moved through handoff mode. Absent means
   * the serving machine (environmentId); read with resolveThreadExecution.
   */
  readonly ownerMachineId?: EnvironmentId;
  readonly executionMachineId?: EnvironmentId;
  readonly executionMachineLabel?: string;
  readonly executionState?: OrchestrationV2ThreadShell["executionState"];
  readonly executionLastSeenAt?: string | null;
  readonly activeProviderThreadId: OrchestrationV2ThreadShell["activeProviderThreadId"];
  readonly latestRun: ThreadRunSummary | null;
  readonly runtime: ThreadRuntimeSummary | null;
  readonly latestUserMessageAt: string | null;
  /** The last message the user wrote. `undefined` means the server predates it. */
  readonly latestUserAuthoredMessageAt?: string | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly hasActionableProposedPlan: boolean;
  /** What the thread's last report says stops the work; null when nothing does. */
  readonly reportedBlocker?: string | null;
  /** Queued messages held until someone resumes or discards them; absent when none. */
  readonly heldQueuedCount?: number;
  /** Where the agent's newest todo list stands; null without one. */
  readonly planProgress?: OrchestrationV2ThreadShell["planProgress"];
  readonly pendingBackgroundTasks: ReadonlyArray<
    NonNullable<OrchestrationV2ThreadShell["pendingBackgroundTasks"]>[number]
  >;
  /** What the running turn waits on: its newest unfinished command or subagent. */
  readonly activeWork?:
    | {
        readonly label: string;
        readonly startedAt: string;
        readonly waitThreadId?: string;
      }
    | null
    | undefined;
  /** Provider instances that have owned the root conversation, oldest first. */
  readonly providerInstanceHistory: ReadonlyArray<ProviderInstanceId>;
  /** Native `/goal` on the active provider thread. */
  readonly goal: OrchestrationV2ProviderGoal | null;
  readonly itemCount: number;
  readonly visibleItemCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly settledOverride: "settled" | "active" | null;
  readonly settledAt: string | null;
  readonly unsettledAt: string | null;
  readonly snoozedUntil: string | null;
  readonly snoozedAt: string | null;
  readonly limitRecovery?:
    | import("@specweave-studio/contracts").OrchestrationV2LimitRecovery
    | null;
  /** Auto model routing's decision for this thread, when Auto chose its model. */
  readonly routing?: import("@specweave-studio/contracts").TaskRoutingDecision | null;
  readonly pinnedAt: string | null;
  readonly autoSettleDisabledAt?: string | null;
  /** Slot in the user-arranged pinned order; null for keyless (legacy) pins. */
  readonly pinOrderKey: string | null;
  /** Slot in the user-arranged active order; null for keyless active threads. */
  readonly activeOrderKey: string | null;
  readonly pullRequests: ReadonlyArray<import("@specweave-studio/contracts").ThreadPullRequestLink>;
  readonly linkedPullRequest?: ThreadLinkedPullRequest | null;
  readonly branchPullRequest?: ThreadLinkedPullRequest | null;
  /**
   * Server-tracked visited watermark. `undefined` means the environment's
   * server predates visited tracking and clients should fall back to any
   * local visited state they keep.
   */
  readonly lastVisitedAt?: string | null;
  /** Pending title regeneration marker; null when no request is in flight. */
  readonly titleRegeneration?: { readonly requestId: string; readonly startedAt: string } | null;
  readonly deletedAt: string | null;
  readonly source: OrchestrationV2ThreadShell;
}

function iso(value: DateTime.Utc): string {
  return DateTime.formatIso(value);
}

function nullableIso(value: DateTime.Utc | null): string | null {
  return value === null ? null : iso(value);
}

function terminalRunStatus(status: OrchestrationV2RunStatus): boolean {
  return (
    status === "completed" ||
    status === "interrupted" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "rolled_back"
  );
}

// Park runtime at idle when the post-settlement background roster holds the
// run's completion, so #4415 waiting-presentation Waiting (session.idle) can
// consume CTM runtime. Only work that wakes the agent holds it: commands it
// left running, such as a dev server, present the run's own status (#14872).
// The server suppresses the roster while an interruptible activity run exists,
// so a remaining roster is stronger than checkpoint-oriented waiting.
// latestRun keeps the latest run's status for history presentation.
// A failed latest run outranks the roster, so the failure stays visible.
function shellRuntime(thread: OrchestrationV2ThreadShell): ThreadRuntimeSummary | null {
  const parkAtIdle =
    backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? []) &&
    thread.status !== "failed";
  // A pull request watch can hold a thread that never ran, and a provider-native
  // subagent works without app runs; the server reports its live turn as activity.
  if (
    thread.latestRunId === null &&
    thread.activeProviderThreadId === null &&
    !parkAtIdle &&
    thread.activityRunStatus == null
  ) {
    return null;
  }
  const status = parkAtIdle ? "idle" : (thread.activityRunStatus ?? thread.status);
  return {
    status,
    activeRunId: thread.activeRunId,
    activityStartedAt:
      thread.activityRunStartedAt === undefined
        ? undefined
        : nullableIso(thread.activityRunStartedAt),
    providerInstanceId: thread.providerInstanceId,
    providerName: null,
    lastError: thread.lastError ?? null,
    lastErrorClass: thread.lastErrorClass ?? null,
    lastErrorAt:
      thread.lastError == null || thread.latestRunCompletedAt == null
        ? null
        : iso(thread.latestRunCompletedAt),
    usageLimitResetAt: thread.usageLimitResetAt ?? null,
    updatedAt: iso(thread.updatedAt),
  };
}

export function scopeProject(
  environmentId: EnvironmentId,
  project: OrchestrationProjectShell,
): EnvironmentProject {
  return { ...project, environmentId };
}

/**
 * The request kinds the person answers. Others, such as a dynamic tool call,
 * are answered by the app, so a run waiting on one is not waiting on the person.
 */
const AWAITING_PERSON_BY_REQUEST_KIND: Partial<
  Record<
    NonNullable<OrchestrationV2ThreadShell["pendingRuntimeRequest"]>["kind"],
    RunAwaitingPerson
  >
> = {
  command: "approval",
  "file-read": "approval",
  "file-change": "approval",
  permission: "approval",
  "mcp-elicitation": "approval",
  user_input: "answer",
  auth_refresh: "sign-in",
};

export function presentThreadShell(
  environmentId: EnvironmentId,
  thread: OrchestrationV2ThreadShell,
): EnvironmentThreadShell {
  const updatedAt = iso(thread.updatedAt);
  const latestRun =
    thread.latestRunId === null
      ? null
      : ({
          runId: thread.latestRunId,
          status: thread.status === "idle" ? "completed" : thread.status,
          requestedAt: nullableIso(thread.latestRunRequestedAt ?? null),
          startedAt: nullableIso(thread.latestRunStartedAt ?? null),
          completedAt:
            thread.latestRunCompletedAt === undefined
              ? thread.status === "idle" || terminalRunStatus(thread.status)
                ? updatedAt
                : null
              : nullableIso(thread.latestRunCompletedAt),
          assistantMessageId: null,
        } satisfies ThreadRunSummary);
  return {
    environmentId,
    id: thread.id,
    projectId: thread.projectId,
    title:
      thread.lineage.relationshipToParent === "subagent"
        ? formatSubagentDisplayTitle(thread.title)
        : thread.title,
    createdBy: thread.createdBy,
    providerInstanceId: thread.providerInstanceId,
    modelSelection: thread.modelSelection,
    ...(thread.modelIdentity === undefined ? {} : { modelIdentity: thread.modelIdentity }),
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    pullRequests: threadPullRequestsOf(thread),
    linkedPullRequest: thread.linkedPullRequest ?? null,
    branchPullRequest: thread.branchPullRequest ?? null,
    lineage: thread.lineage,
    forkedFrom: thread.forkedFrom,
    movedTo: thread.movedTo ?? null,
    movedFrom: thread.movedFrom ?? null,
    ...(thread.ownerMachineId === undefined ? {} : { ownerMachineId: thread.ownerMachineId }),
    ...(thread.executionMachineId === undefined
      ? {}
      : { executionMachineId: thread.executionMachineId }),
    ...(thread.executionMachineLabel === undefined
      ? {}
      : { executionMachineLabel: thread.executionMachineLabel }),
    ...(thread.executionState === undefined ? {} : { executionState: thread.executionState }),
    ...(thread.executionLastSeenAt === undefined
      ? {}
      : { executionLastSeenAt: thread.executionLastSeenAt }),
    activeProviderThreadId: thread.activeProviderThreadId,
    latestRun,
    runtime: shellRuntime(thread),
    latestUserMessageAt: nullableIso(thread.latestUserMessageAt),
    ...(thread.latestUserAuthoredMessageAt === undefined
      ? {}
      : { latestUserAuthoredMessageAt: nullableIso(thread.latestUserAuthoredMessageAt) }),
    // Same table as threadAwaitingPerson, so a request the app answers is no approval.
    hasPendingApprovals:
      thread.pendingRuntimeRequest !== null &&
      AWAITING_PERSON_BY_REQUEST_KIND[thread.pendingRuntimeRequest.kind] === "approval",
    hasPendingUserInput: thread.pendingRuntimeRequest?.kind === "user_input",
    hasActionableProposedPlan: thread.hasActionableProposedPlan,
    reportedBlocker: thread.reportedBlocker ?? null,
    ...(thread.heldQueuedCount ? { heldQueuedCount: thread.heldQueuedCount } : {}),
    planProgress: thread.planProgress ?? null,
    pendingBackgroundTasks: thread.pendingBackgroundTasks ?? [],
    // Absent (a server older than this field) differs from null (nothing in flight).
    activeWork:
      thread.activeWork === undefined
        ? undefined
        : thread.activeWork === null
          ? null
          : {
              label: thread.activeWork.label,
              startedAt: iso(thread.activeWork.startedAt),
              ...(thread.activeWork.waitThreadId === undefined
                ? {}
                : { waitThreadId: thread.activeWork.waitThreadId }),
            },
    providerInstanceHistory: thread.providerInstanceHistory ?? [],
    goal: thread.goal ?? null,
    itemCount: thread.itemCount,
    visibleItemCount: thread.visibleItemCount,
    createdAt: iso(thread.createdAt),
    updatedAt,
    archivedAt: nullableIso(thread.archivedAt),
    settledOverride: thread.settledOverride,
    settledAt: nullableIso(thread.settledAt),
    unsettledAt: nullableIso(thread.unsettledAt ?? null),
    snoozedUntil: nullableIso(thread.snoozedUntil ?? null),
    snoozedAt: nullableIso(thread.snoozedAt ?? null),
    limitRecovery: thread.limitRecovery ?? null,
    routing: thread.routing ?? null,
    pinnedAt: nullableIso(thread.pinnedAt ?? null),
    autoSettleDisabledAt: nullableIso(thread.autoSettleDisabledAt ?? null),
    pinOrderKey: thread.pinOrderKey ?? null,
    activeOrderKey: thread.activeOrderKey ?? null,
    ...(thread.lastVisitedAt === undefined
      ? {}
      : { lastVisitedAt: nullableIso(thread.lastVisitedAt) }),
    titleRegeneration:
      thread.titleRegeneration == null
        ? null
        : {
            requestId: thread.titleRegeneration.requestId,
            startedAt: iso(thread.titleRegeneration.startedAt),
          },
    deletedAt: nullableIso(thread.deletedAt),
    source: thread,
  };
}

export function scopeThreadShell(
  environmentId: EnvironmentId,
  thread: OrchestrationV2ThreadShell,
): EnvironmentThreadShell {
  return presentThreadShell(environmentId, thread);
}

const THREAD_PROVIDER_STACK_LIMIT = 3;

/**
 * Provider instances to draw in a thread row's trailing stack, back to front:
 * the current one is always last, earlier owners precede it oldest first.
 * Newest history wins when the thread has been handed off more times than fit.
 */
export function resolveThreadProviderStack(
  thread: Pick<EnvironmentThreadShell, "providerInstanceHistory" | "modelSelection" | "runtime">,
): ReadonlyArray<ProviderInstanceId> {
  const current = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
  const previous = thread.providerInstanceHistory.filter((instanceId) => instanceId !== current);
  return [...previous.slice(-(THREAD_PROVIDER_STACK_LIMIT - 1)), current];
}

/**
 * Both shell and detail timers count from the activity-owning run's work
 * start, never last activity. A wake keeps the start of the work it continues.
 */
export function resolveThreadWorkingStartedAt(input: {
  readonly latestRun: Pick<
    ThreadRunSummary,
    "runId" | "startedAt" | "requestedAt" | "completedAt"
  > | null;
  readonly runtime: Pick<ThreadRuntimeSummary, "activeRunId" | "activityStartedAt"> | null;
}): string | null {
  const valid = (value: string | null | undefined) =>
    value != null && Number.isFinite(Date.parse(value)) ? value : null;
  if (input.runtime?.activityStartedAt !== undefined) return valid(input.runtime.activityStartedAt);
  // Older servers can supply a timestamp only if the newest run owns the work.
  const run = input.latestRun;
  if (run?.completedAt === null && run.runId === input.runtime?.activeRunId) {
    return valid(run.startedAt) ?? valid(run.requestedAt);
  }
  return null;
}

/**
 * What a thread's open runtime request asks of the person, or null when none
 * is open or the app answers it. A sign-in counts: the agent cannot go on
 * until the person acts.
 */
export function threadAwaitingPerson(
  thread: Partial<Pick<EnvironmentThreadShell, "hasPendingApprovals" | "hasPendingUserInput">> & {
    readonly source?: Pick<OrchestrationV2ThreadShell, "pendingRuntimeRequest"> | undefined;
  },
): { readonly kind: RunAwaitingPerson; readonly sinceMs: number } | null {
  const request = thread.source?.pendingRuntimeRequest ?? null;
  const createdAt: unknown = request?.createdAt;
  const sinceMs = DateTime.isDateTime(createdAt)
    ? DateTime.toEpochMillis(createdAt)
    : Date.parse(String(createdAt));
  if (request !== null) {
    const kind = AWAITING_PERSON_BY_REQUEST_KIND[request.kind];
    return kind === undefined ? null : { kind, sinceMs };
  }
  // Without a request summary the shell flags are all there is to go by.
  if (thread.hasPendingUserInput === true) return { kind: "answer", sinceMs };
  if (thread.hasPendingApprovals === true) return { kind: "approval", sinceMs };
  return null;
}

/**
 * Whether a running thread is working, waiting on a long command or on the
 * person, or stalled: no provider event for longer than its work explains. A
 * turn blocked on an approval or a question waits on the person however long
 * it stays quiet. Null when idle.
 */
export function threadRunHealth(
  thread: Pick<EnvironmentThreadShell, "runtime" | "updatedAt" | "activeWork"> &
    Parameters<typeof threadAwaitingPerson>[0],
  nowMs: number,
): RunHealth | null {
  const status = thread.runtime?.status;
  const lastActivityMs = Date.parse(thread.updatedAt);
  if (!Number.isFinite(lastActivityMs)) return null;
  const startedAtMs =
    thread.activeWork == null ? Number.NaN : Date.parse(thread.activeWork.startedAt);
  return classifyRunHealth({
    running: status === "running" || status === "waiting",
    lastActivityMs,
    awaitingPerson: threadAwaitingPerson(thread),
    activeWork:
      thread.activeWork == null
        ? null
        : {
            label: thread.activeWork.label,
            startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : lastActivityMs,
            waitThreadId: thread.activeWork.waitThreadId,
          },
    activeWorkUnknown: thread.activeWork === undefined,
    nowMs,
  });
}
