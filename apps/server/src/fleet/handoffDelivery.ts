/**
 * What a handed-off worker owes the thread that launched it: one result.
 *
 * These are the rules both readers of the other machine share, the follower
 * and the launcher's own wait, so they cannot disagree about what counts.
 * The result is the result of one run, known by its id: the continuation's
 * first run, which is the run the handoff resumed or, for a thread that
 * arrived idle, the run that carried the handoff note. A run that was only
 * stopped (interrupted, cancelled, rolled back) reports nothing and the next
 * run to start takes its place. A failed run is replaced only by a run the
 * other machine itself started to continue it.
 */
import type * as RemoteWorkerStore from "./RemoteWorkerStore.ts";

export type HandoffFollowState = NonNullable<RemoteWorkerStore.RemoteWorkerRecord["handoff"]>;

export interface ListedRun {
  readonly runId: string;
  readonly ordinal: number;
  readonly status: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  /**
   * Not in the other machine's run list, so only its status is known: when it
   * started is not. Its place among other runs is never worked out from that.
   */
  readonly unlisted?: true;
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
 * The id every release gives a thread's first run (orchestration-v2
 * IdAllocator, `derive.run`). A continuation's first run is the handoff's
 * own: the turn it resumed, or the first message of a thread that arrived
 * idle, which is the one message that carries the handoff note.
 */
export const firstRunId = (threadId: string) =>
  `run:thread:${encodeURIComponent(threadId)}:ordinal:1`;

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
  /**
   * This run is going or queued: wait for it. `failedRunId` is the run it
   * continues, and `pin` the run whose result is owed.
   */
  | {
      readonly kind: "follow";
      readonly runId: string;
      readonly status: string;
      readonly pin: string;
      readonly failedRunId?: string;
    }
  /** This run failed last: the other machine may still continue it. */
  | {
      readonly kind: "hold";
      readonly runId: string;
      readonly pin: string;
      readonly completedAt: string | null;
    }
  /** No run to report or wait for. */
  | { readonly kind: "nothing" }
  /** The owed run was stopped and more than one run may have started next: not told apart. */
  | { readonly kind: "unsure" };

const notStarted = (run: ListedRun) =>
  run.status === "queued" || (run.unlisted !== true && run.startedAt === null);

/**
 * The run that takes the place of one that was only stopped: the next run to
 * start. Told from start times the other machine listed, or because only one
 * run has started; never from where a run sits in a page.
 */
const successor = (runs: ReadonlyArray<ListedRun>): ListedRun | "unsure" | undefined => {
  const started = runs.filter((run) => !endedWithoutResult(run.status) && !notStarted(run));
  if (started.length <= 1) return started[0];
  if (started.some((run) => run.unlisted === true || run.startedAt === null)) return "unsure";
  return started.toSorted((left, right) =>
    left.startedAt === right.startedAt
      ? left.ordinal - right.ordinal
      : (left.startedAt ?? "") < (right.startedAt ?? "")
        ? -1
        : 1,
  )[0];
};

/**
 * What to do about a handed-off thread. `from` is the run whose result is
 * owed: the one pinned in the row, or the thread's first run. `runs` must hold
 * that run and every run not yet ruled out, with the messages that started them.
 */
export function nextHandoffStep(
  runs: ReadonlyArray<ListedRun>,
  messages: ReadonlyArray<ListedMessage>,
  from: string,
): HandoffStep {
  const startedBy = (run: ListedRun) => messages.find((message) => message.runId === run.runId);
  let owed = runs.find((run) => run.runId === from);
  if (owed !== undefined && endedWithoutResult(owed.status)) {
    const next = successor(runs);
    if (next === "unsure") return { kind: "unsure" };
    owed = next;
  }
  if (owed === undefined) return { kind: "nothing" };
  const pin = owed.runId;
  if (owed.status === "completed") return { kind: "report", runId: pin, status: "completed" };
  if (owed.status !== "failed")
    return { kind: "follow", runId: pin, status: owed.status, pin };
  // A failure is the result unless the other machine itself continues it; the
  // continuation names the failed run in its message id, so no order is needed.
  const chain = [owed];
  const inOrdinal = runs.toSorted((left, right) => left.ordinal - right.ordinal);
  while (true) {
    const last = chain[chain.length - 1] as ListedRun;
    const next = inOrdinal.find(
      (run) => !chain.includes(run) && continuesFailedRun(startedBy(run), [pin, last.runId]),
    );
    if (next === undefined)
      return { kind: "hold", runId: last.runId, pin, completedAt: last.completedAt };
    // A continuation that was only stopped leaves the failure as the result.
    if (endedWithoutResult(next.status))
      return { kind: "report", runId: last.runId, status: "failed" };
    if (next.status === "completed")
      return { kind: "report", runId: next.runId, status: "completed" };
    if (next.status !== "failed")
      return {
        kind: "follow",
        runId: next.runId,
        status: next.status,
        pin,
        failedRunId: last.runId,
      };
    chain.push(next);
  }
}

/**
 * Where a thread read says the thread runs now, when that is not the machine
 * that was asked. The epoch of that move is taken only from the stretch that
 * is open now and is that machine's: the move and its history entry are two
 * writes, and between them the history still ends on the machine asked, with
 * any earlier visit to the new machine further back. Undefined epoch means
 * "not said yet": the route is kept and the thread is asked again.
 */
export function movedOn(
  answer: unknown,
  askedEnvironmentId: string,
): { readonly environmentId: string; readonly epoch: number | undefined } | undefined {
  const thread = isRecord(answer) && isRecord(answer.thread) ? answer.thread : undefined;
  if (thread === undefined || thread.executionState !== "fenced") return undefined;
  const environmentId = thread.executionMachineId;
  if (typeof environmentId !== "string" || environmentId === askedEnvironmentId) return undefined;
  const history = Array.isArray(thread.executionHistory) ? thread.executionHistory : [];
  const current = history.filter(isRecord).at(-1);
  const open =
    current !== undefined &&
    current.machine === environmentId &&
    (current.to === null || current.to === undefined) &&
    typeof current.epoch === "number";
  return { environmentId, epoch: open ? (current.epoch as number) : undefined };
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
  ...(handoff.woke === undefined ? {} : { woke: handoff.woke }),
  resultRunId: runId,
});
