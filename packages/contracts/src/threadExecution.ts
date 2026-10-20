/**
 * Where a thread lives and where it runs. A thread lives on its owner machine
 * (the project it was created in) and runs on exactly one execution machine at
 * a time; handoff mode moves execution, never ownership. Machines are named by
 * their environment id, which is unique across a fleet.
 *
 * A thread that never moved carries no record: it lives and runs on the
 * machine that serves it. Read it through `resolveThreadExecution`.
 */
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

const bounded = (max: number) => Schema.String.check(Schema.isMaxLength(max));

export const THREAD_EXECUTION_HISTORY_MAX = 50;

/**
 * running: the execution machine holds the lease (the thread may be idle between turns).
 * fenced: this copy no longer runs; another machine took over with a newer epoch.
 * unknown: the execution machine has not answered since `executionLastSeenAt`.
 */
export const ThreadExecutionState = Schema.Literals(["running", "fenced", "unknown"]);
export type ThreadExecutionState = typeof ThreadExecutionState.Type;

export const ThreadExecutionReason = Schema.Literals([
  "created",
  "handoff",
  "machine-handoff",
  "sleep",
  "usage-limit",
  "continue-here",
  "auto-takeover",
]);
export type ThreadExecutionReason = typeof ThreadExecutionReason.Type;

/** One stretch of execution on one machine: [machine, from, to, reason]. */
export const ThreadExecutionHistoryEntry = Schema.Struct({
  machine: EnvironmentId,
  machineLabel: Schema.optional(bounded(120)),
  from: IsoDateTime,
  /** Null while the stretch is current. */
  to: Schema.NullOr(IsoDateTime),
  reason: ThreadExecutionReason,
  epoch: NonNegativeInt,
});
export type ThreadExecutionHistoryEntry = typeof ThreadExecutionHistoryEntry.Type;

/**
 * The checkout a continuation came from. Recorded by the destination; projects
 * on two machines are joined only by an explicit link, never by a shared name.
 */
export const ThreadSourceRoot = Schema.Struct({
  environmentId: EnvironmentId,
  machineLabel: Schema.optional(bounded(120)),
  projectId: ProjectId,
  threadId: ThreadId,
  workspaceRoot: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  branch: Schema.NullOr(bounded(512)),
});
export type ThreadSourceRoot = typeof ThreadSourceRoot.Type;

/** Persisted on the thread once it has moved (or arrived) at least once. */
export const ThreadExecutionRecord = Schema.Struct({
  ownerMachineId: EnvironmentId,
  ownerMachineLabel: Schema.optional(bounded(120)),
  executionMachineId: EnvironmentId,
  executionMachineLabel: Schema.optional(bounded(120)),
  /** The lease epoch this copy last held or saw; every side effect carries it. */
  epoch: NonNegativeInt,
  /** Set on a continuation: where it came from. */
  sourceRoot: Schema.optional(Schema.NullOr(ThreadSourceRoot)),
  history: Schema.Array(ThreadExecutionHistoryEntry).check(
    Schema.isMaxLength(THREAD_EXECUTION_HISTORY_MAX),
  ),
});
export type ThreadExecutionRecord = typeof ThreadExecutionRecord.Type;

/**
 * The execution fields thread summaries and the thread list API carry. Older
 * servers omit them; a missing value means the serving machine owns and runs it.
 */
export const ThreadExecutionSummaryFields = {
  ownerMachineId: Schema.optional(EnvironmentId),
  executionMachineId: Schema.optional(EnvironmentId),
  executionMachineLabel: Schema.optional(bounded(120)),
  executionState: Schema.optional(ThreadExecutionState),
  /** When the execution machine last answered; set with executionState "unknown". */
  executionLastSeenAt: Schema.optional(Schema.NullOr(IsoDateTime)),
} as const;

export const ThreadExecutionSummary = Schema.Struct(ThreadExecutionSummaryFields);
export type ThreadExecutionSummary = typeof ThreadExecutionSummary.Type;

/** The parts of a stored thread the summary is built from (structural, to avoid a cycle). */
export interface ThreadExecutionSource {
  readonly execution?: ThreadExecutionRecord | null | undefined;
  readonly movedTo?:
    | {
        readonly kind?: "project" | "handoff" | undefined;
        readonly environmentId?: EnvironmentId | undefined;
        readonly machineLabel?: string | undefined;
      }
    | null
    | undefined;
}

/**
 * The summary fields a server puts on a thread shell. Empty for a thread that
 * never moved; a copy handed off elsewhere reads "fenced" and names the
 * machine that runs it now.
 */
export function threadExecutionSummary(thread: ThreadExecutionSource): ThreadExecutionSummary {
  const record = thread.execution ?? null;
  const owner = record === null ? {} : { ownerMachineId: record.ownerMachineId };
  if (thread.movedTo?.kind === "handoff") {
    const machineId = thread.movedTo.environmentId ?? record?.executionMachineId;
    const label = thread.movedTo.machineLabel ?? record?.executionMachineLabel;
    return {
      ...owner,
      ...(machineId === undefined ? {} : { executionMachineId: machineId }),
      ...(label === undefined ? {} : { executionMachineLabel: label }),
      executionState: "fenced",
    };
  }
  if (record === null) return {};
  return {
    ...owner,
    executionMachineId: record.executionMachineId,
    ...(record.executionMachineLabel === undefined
      ? {}
      : { executionMachineLabel: record.executionMachineLabel }),
    executionState: "running",
  };
}

export interface ResolvedThreadExecution {
  readonly ownerMachineId: EnvironmentId;
  readonly executionMachineId: EnvironmentId;
  readonly executionMachineLabel: string | null;
  readonly executionState: ThreadExecutionState;
  readonly executionLastSeenAt: string | null;
}

/**
 * The execution a viewer should show. `servingEnvironmentId` is the machine
 * the summary came from; `reachable` answers whether a machine is reachable
 * now and when it was last seen. A machine that does not answer is "unknown",
 * never idle or missing.
 */
export function resolveThreadExecution(
  summary: ThreadExecutionSummary,
  servingEnvironmentId: EnvironmentId,
  reachable?: (environmentId: EnvironmentId) => {
    readonly reachable: boolean;
    readonly lastSeenAt: string | null;
  },
): ResolvedThreadExecution {
  const ownerMachineId = summary.ownerMachineId ?? servingEnvironmentId;
  const executionMachineId = summary.executionMachineId ?? servingEnvironmentId;
  const base = {
    ownerMachineId,
    executionMachineId,
    executionMachineLabel: summary.executionMachineLabel ?? null,
  };
  if (summary.executionState === "fenced") {
    return { ...base, executionState: "fenced", executionLastSeenAt: null };
  }
  const seen = reachable?.(executionMachineId);
  if (summary.executionState === "unknown" || (seen !== undefined && !seen.reachable)) {
    return {
      ...base,
      executionState: "unknown",
      executionLastSeenAt: seen?.lastSeenAt ?? summary.executionLastSeenAt ?? null,
    };
  }
  return { ...base, executionState: "running", executionLastSeenAt: null };
}

/** "Unknown · Minis last seen 2:14 PM": the label for a thread whose machine is unreachable. */
export function formatUnknownExecution(machineLabel: string, lastSeen: string | null): string {
  return lastSeen === null
    ? `Unknown · ${machineLabel} not reached yet`
    : `Unknown · ${machineLabel} last seen ${lastSeen}`;
}

/** Appends a stretch, closing the current one, and keeps the newest entries. */
export function appendThreadExecutionHistory(
  history: ReadonlyArray<ThreadExecutionHistoryEntry>,
  next: ThreadExecutionHistoryEntry,
): ReadonlyArray<ThreadExecutionHistoryEntry> {
  const closed = history.map((entry) => (entry.to === null ? { ...entry, to: next.from } : entry));
  return [...closed, next].slice(-THREAD_EXECUTION_HISTORY_MAX);
}

/**
 * The idempotency key of one turn. A continuation inherits the key of the run
 * it resumes, so side effects the source already recorded are found again.
 */
export function threadTurnKey(threadId: string, runId: string): string {
  return `${threadId}/${runId}`;
}

export const ThreadSideEffectKind = Schema.Literals([
  "git-push",
  "pr-create",
  "pr-comment",
  "pr-merge",
  "tracker-write",
  "mcp-mutation",
  "scheduled-task",
]);
export type ThreadSideEffectKind = typeof ThreadSideEffectKind.Type;

/** A side effect a turn performed, journaled under its turn key and replicated with checkpoints. */
export const ThreadSideEffect = Schema.Struct({
  turnKey: bounded(300),
  kind: ThreadSideEffectKind,
  /** What it acted on: "owner/repo#branch", a PR URL, a tool name and its target. */
  target: bounded(1000),
  epoch: NonNegativeInt,
  environmentId: EnvironmentId,
  at: IsoDateTime,
  /** What it produced (a PR URL, a pushed sha), so a resumed turn reuses it. */
  result: Schema.NullOr(bounded(2000)),
});
export type ThreadSideEffect = typeof ThreadSideEffect.Type;
