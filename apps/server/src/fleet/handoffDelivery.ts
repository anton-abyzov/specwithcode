/**
 * What a handed-off worker owes the thread that launched it: one result.
 *
 * These are the rules both readers of the other machine share, the follower
 * and the launcher's own wait, so they cannot disagree about what counts:
 * the first run, in the order runs ran, that completed or failed is the
 * result. A run that was only stopped (interrupted, cancelled, rolled back)
 * reports nothing and the work's result is still to come. A failed run is
 * replaced only by a run the other machine itself started to continue it.
 */
import type * as RemoteWorkerStore from "./RemoteWorkerStore.ts";

export type HandoffFollowState = NonNullable<RemoteWorkerStore.RemoteWorkerRecord["handoff"]>;

export interface ListedRun {
  readonly runId: string;
  readonly ordinal: number;
  readonly status: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

/** A user message that started a run, as a thread read lists it. */
export interface ListedMessage {
  readonly runId: string;
  readonly messageId: string;
  readonly creationSource: string | null;
  readonly position: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown) => (typeof value === "string" ? value : null);

export const listedRuns = (answer: unknown): ReadonlyArray<ListedRun> =>
  (isRecord(answer) && Array.isArray(answer.recentRuns) ? answer.recentRuns : [])
    .filter(isRecord)
    .flatMap((run) =>
      typeof run.runId === "string" &&
      typeof run.ordinal === "number" &&
      typeof run.status === "string"
        ? [
            {
              runId: run.runId,
              ordinal: run.ordinal,
              status: run.status,
              startedAt: text(run.startedAt),
              completedAt: text(run.completedAt),
            },
          ]
        : [],
    );

export const listedMessages = (answer: unknown): ReadonlyArray<ListedMessage> =>
  (isRecord(answer) && Array.isArray(answer.items) ? answer.items : [])
    .filter(isRecord)
    .flatMap((item) =>
      item.type === "user_message" &&
      typeof item.runId === "string" &&
      typeof item.messageId === "string" &&
      typeof item.position === "number"
        ? [
            {
              runId: item.runId,
              messageId: item.messageId,
              creationSource: text(item.creationSource),
              position: item.position,
            },
          ]
        : [],
    );

/** A run whose end is the worker's result. */
export const reportsResult = (status: string) => status === "completed" || status === "failed";

/** A run that ended without one: stopped by a person, a restart, a handoff or a rollback. */
export const endedWithoutResult = (status: string) =>
  status === "interrupted" || status === "cancelled" || status === "rolled_back";

/**
 * The order runs ran in. Ordinals are given when a message is queued, and a
 * queued message can be moved ahead, so a run's start says more than its
 * ordinal; a run that has not started comes after every run that has.
 */
export const inRunOrder = (runs: ReadonlyArray<ListedRun>): ReadonlyArray<ListedRun> => {
  const at = (run: ListedRun) =>
    run.startedAt ?? (run.status === "queued" ? "￿" : (run.completedAt ?? "￿"));
  return runs.toSorted((left, right) => {
    const [a, b] = [at(left), at(right)];
    return a === b ? left.ordinal - right.ordinal : a < b ? -1 : 1;
  });
};

/**
 * Whether `message` is the message the other machine itself sent to continue
 * `failedRunId`: its automatic fallback after a usage limit, or its retry of
 * a provider that would not open, or its resume once the limit reset. Those
 * carry the run they continue in their id, last or followed by what makes the
 * id unique; a message a person or an agent sent later does not.
 */
export const continuesFailedRun = (
  message: ListedMessage | undefined,
  failedRunIds: ReadonlyArray<string>,
) =>
  message !== undefined &&
  message.creationSource === "server" &&
  /^(limit|provider)-[a-z]+:/u.test(message.messageId) &&
  failedRunIds.some(
    (runId) =>
      message.messageId.endsWith(`:${runId}`) || message.messageId.includes(`:${runId}:`),
  );

export type HandoffStep =
  /** This run is the result: tell the launcher. */
  | { readonly kind: "report"; readonly runId: string; readonly status: string }
  /** This run is going or queued: wait for it. `failedRunId` is the run it continues. */
  | {
      readonly kind: "follow";
      readonly runId: string;
      readonly status: string;
      readonly failedRunId?: string;
    }
  /** This run failed last: the other machine may still continue it. */
  | { readonly kind: "hold"; readonly runId: string; readonly completedAt: string | null }
  /** No run to report or wait for. */
  | { readonly kind: "nothing" };

/**
 * What to do about a handed-off thread, from its runs and the messages that
 * started them. `runs` must be every run not yet ruled out.
 */
export function nextHandoffStep(
  runs: ReadonlyArray<ListedRun>,
  messages: ReadonlyArray<ListedMessage>,
): HandoffStep {
  const startedBy = (run: ListedRun) => messages.find((message) => message.runId === run.runId);
  /** The failed runs the next run may continue: the first of them and the latest. */
  let failed: ReadonlyArray<ListedRun> = [];
  for (const run of inRunOrder(runs)) {
    const last = failed.at(-1);
    if (last !== undefined) {
      const continues = continuesFailedRun(
        startedBy(run),
        failed.map((entry) => entry.runId),
      );
      // Someone's own later message, or a continuation that was only stopped:
      // the failure stands as the result.
      if (!continues || endedWithoutResult(run.status))
        return { kind: "report", runId: last.runId, status: "failed" };
      if (run.status === "completed") return { kind: "report", runId: run.runId, status: "completed" };
      if (run.status === "failed") {
        failed = [failed[0] ?? run, run];
        continue;
      }
      return { kind: "follow", runId: run.runId, status: run.status, failedRunId: last.runId };
    }
    if (endedWithoutResult(run.status)) continue;
    if (run.status === "completed") return { kind: "report", runId: run.runId, status: "completed" };
    if (run.status === "failed") {
      failed = [run];
      continue;
    }
    return { kind: "follow", runId: run.runId, status: run.status };
  }
  const last = failed.at(-1);
  return last === undefined
    ? { kind: "nothing" }
    : { kind: "hold", runId: last.runId, completedAt: last.completedAt };
}

/** Where a thread read says the thread runs now, when that is not the machine that was asked. */
export function movedOn(
  answer: unknown,
  askedEnvironmentId: string,
): { readonly environmentId: string; readonly epoch: number | undefined } | undefined {
  const thread = isRecord(answer) && isRecord(answer.thread) ? answer.thread : undefined;
  if (thread === undefined || thread.executionState !== "fenced") return undefined;
  const environmentId = thread.executionMachineId;
  if (typeof environmentId !== "string" || environmentId === askedEnvironmentId) return undefined;
  const history = Array.isArray(thread.executionHistory) ? thread.executionHistory : [];
  const stretch = history
    .filter(isRecord)
    .findLast((entry) => entry.machine === environmentId && typeof entry.epoch === "number");
  return { environmentId, epoch: stretch === undefined ? undefined : (stretch.epoch as number) };
}

/** Whether the row still owes its launcher the handed-off work's result. */
export const owesResult = (
  row: Pick<RemoteWorkerStore.RemoteWorkerRecord, "handoff">,
): row is { readonly handoff: HandoffFollowState } =>
  row.handoff !== undefined && row.handoff.resultRunId === undefined;

/**
 * A followed run of a handed-off thread ended, as either reader saw it. A run
 * that completed or failed is looked at again with the thread's other runs
 * (a fallback may continue a failure); one that was only stopped reports
 * nothing. Either way the row goes on following: only a result closes it.
 */
export const afterHandoffRunEnded = (
  row: Pick<RemoteWorkerStore.RemoteWorkerRecord, "handoff">,
  status: string,
): Pick<RemoteWorkerStore.RemoteWorkerRecord, "followedRunId" | "lastStatus" | "handoff"> | undefined =>
  owesResult(row)
    ? {
        followedRunId: null,
        lastStatus: status,
        handoff: { ...row.handoff, awaiting: "run" },
      }
    : undefined;

/** The result reached the launcher (a wake, or its own wait): the handoff owes nothing more. */
export const closedWith = (handoff: HandoffFollowState, runId: string): HandoffFollowState => ({
  sourceThreadId: handoff.sourceThreadId,
  epoch: handoff.epoch,
  ...(handoff.hops === undefined ? {} : { hops: handoff.hops }),
  resultRunId: runId,
});
