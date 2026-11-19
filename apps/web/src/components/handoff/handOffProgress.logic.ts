/**
 * The hand off progress view's state, read from the transfer records the
 * source machine keeps. Nothing here starts, sends or retries a move: it maps
 * a record to a row, and the rows to the summary and the bar.
 */
import type {
  EnvironmentId,
  HandoffTransferBatch,
  HandoffTransferRecord,
  HandoffTransferState,
  HandoffTransferTrigger,
  ModelSelection,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";

import type { TranslatePhrase } from "../../i18n";

export type HandOffRowState =
  | "pending"
  | "held"
  | "waiting"
  | "resumed"
  | "ready"
  | "stayed"
  | "failed";

/**
 * A row's one next step. `wait` is shown as a word, never as a control: a
 * thread that was sent is not released by hand.
 */
export type HandOffRowAction = "resume-here" | "wait" | "open" | "try-again";

/** `sent`, `accepted` and `unknown` all wait for the destination's answer. */
export function rowStateOf(state: HandoffTransferState): HandOffRowState {
  return state === "sent" || state === "accepted" || state === "unknown" ? "waiting" : state;
}

const FINISHED: ReadonlySet<HandOffRowState> = new Set(["resumed", "ready", "stayed", "failed"]);

export interface HandOffProgressRow {
  readonly operationId: string;
  readonly threadId: ThreadId;
  readonly sourceEnvironmentId: EnvironmentId;
  readonly targetEnvironmentId: EnvironmentId | null;
  readonly state: HandOffRowState;
  readonly finished: boolean;
  readonly action: HandOffRowAction | null;
  /** The thread on the destination, once it answered with one. */
  readonly continuedThreadId: ThreadId | null;
  /** The machine's own words for why it stayed or was refused. */
  readonly detail: string | null;
  readonly sentAt: string | null;
  readonly modelSelection: ModelSelection | null;
}

export function progressRow(record: HandoffTransferRecord): HandOffProgressRow {
  // A hold from before transfer records may have been accepted somewhere: it
  // waits for the machines that could hold it, whatever its state says.
  const state =
    record.legacy && !FINISHED.has(rowStateOf(record.state)) ? "waiting" : rowStateOf(record.state);
  const continuedThreadId = record.receipt?.threadId ?? null;
  const action = ((): HandOffRowAction | null => {
    switch (state) {
      case "pending":
        // The batch that planned it may reach it at any moment, and would send it anyway.
        return null;
      case "held":
        return "resume-here";
      case "waiting":
        return "wait";
      case "resumed":
      case "ready":
        return continuedThreadId !== null && record.targetEnvironmentId !== null ? "open" : null;
      case "failed":
        return record.targetEnvironmentId !== null ? "try-again" : null;
      case "stayed":
        return null;
    }
  })();
  return {
    operationId: record.operationId,
    threadId: record.lineage.sourceThreadId,
    sourceEnvironmentId: record.lineage.sourceEnvironmentId,
    targetEnvironmentId: record.targetEnvironmentId,
    state,
    finished: FINISHED.has(state),
    action,
    continuedThreadId,
    detail: record.detail,
    sentAt: record.sentAt,
    modelSelection: record.modelSelection,
  };
}

export interface HandOffProgressSummary {
  readonly finished: number;
  readonly total: number;
  readonly counts: Readonly<Record<"resumed" | "ready" | "stayed" | "failed", number>>;
  /** Finished ÷ total, the bar's width. */
  readonly fraction: number;
  /** Every thread is on the destination: none stayed, failed or still waits. */
  readonly allArrived: boolean;
}

/** The summary and the bar come from the same rows, so they cannot disagree. */
export function progressSummary(
  rows: ReadonlyArray<Pick<HandOffProgressRow, "state">>,
  /** The machine no longer keeps every thread of this hand off: the rows are not all of it. */
  incomplete = false,
): HandOffProgressSummary {
  const count = (state: HandOffRowState) => rows.filter((row) => row.state === state).length;
  const counts = {
    resumed: count("resumed"),
    ready: count("ready"),
    stayed: count("stayed"),
    failed: count("failed"),
  };
  const finished = counts.resumed + counts.ready + counts.stayed + counts.failed;
  const total = rows.length;
  return {
    finished,
    total,
    counts,
    fraction: total === 0 ? 0 : finished / total,
    allArrived: !incomplete && total > 0 && counts.resumed + counts.ready === total,
  };
}

const COUNT_PHRASES = {
  resumed: "{n} resumed",
  ready: "{n} ready",
  stayed: "{n} stayed",
  failed: "{n} failed",
} as const;

/** "2 of 4 finished: 1 resumed, 1 failed", or "All 2 on Desk" when every thread arrived. */
export function progressSummaryText(
  summary: HandOffProgressSummary,
  target: string | null,
  tx: TranslatePhrase,
): string {
  if (summary.allArrived && target !== null)
    return tx("All {n} on {machine}", { n: summary.total, machine: target });
  const counts = (["resumed", "ready", "stayed", "failed"] as const)
    .filter((state) => summary.counts[state] > 0)
    .map((state) => tx(COUNT_PHRASES[state], { n: summary.counts[state] }))
    .join(", ");
  const values = { f: summary.finished, n: summary.total, counts };
  return counts === ""
    ? tx("{f} of {n} finished", values)
    : tx("{f} of {n} finished: {counts}", values);
}

export interface HandOffProgressGroup {
  /** The batch (or the lone operation) and the project: one view shows one project. */
  readonly key: string;
  /** The batch the records were written in; null for a lone operation. */
  readonly batchId: string | null;
  /**
   * The batch names an operation this machine no longer keeps a record of, so
   * these rows may not be every thread of this project's hand off.
   */
  readonly incomplete: boolean;
  readonly projectId: ProjectId;
  readonly sourceEnvironmentId: EnvironmentId;
  readonly targetEnvironmentId: EnvironmentId | null;
  readonly trigger: HandoffTransferTrigger;
  readonly createdAt: string;
  readonly rows: ReadonlyArray<HandOffProgressRow>;
}

/** The moves to show, newest first. A machine that sends no records shows none. */
export function progressGroups(
  transfers: ReadonlyArray<HandoffTransferRecord> | undefined,
  batches: ReadonlyArray<HandoffTransferBatch> | undefined,
): HandOffProgressGroup[] {
  const batchOf = new Map((batches ?? []).map((batch) => [batch.batchId, batch]));
  const groups = new Map<string, { first: HandoffTransferRecord; rows: HandOffProgressRow[] }>();
  const known = new Set((transfers ?? []).map((record) => record.operationId));
  const ordered = [...(transfers ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const record of ordered) {
    const key = `${record.batchId ?? record.operationId}:${record.projectId}`;
    const group = groups.get(key);
    if (group) group.rows.push(progressRow(record));
    else groups.set(key, { first: record, rows: [progressRow(record)] });
  }
  return [...groups.entries()]
    .map(([key, { first, rows }]): HandOffProgressGroup => {
      const batch = first.batchId === null ? undefined : batchOf.get(first.batchId);
      // A batch's records are written at one instant: its own list is their order.
      const place = new Map((batch?.operationIds ?? []).map((id, index) => [id, index]));
      const at = (row: HandOffProgressRow) => place.get(row.operationId) ?? place.size;
      rows.sort((a, b) => at(a) - at(b));
      return {
        key,
        batchId: first.batchId,
        incomplete: (batch?.operationIds ?? []).some((id) => !known.has(id)),
        projectId: first.projectId,
        sourceEnvironmentId: first.lineage.sourceEnvironmentId,
        targetEnvironmentId: batch?.targetEnvironmentId ?? first.targetEnvironmentId,
        trigger: batch?.trigger ?? first.trigger,
        createdAt: first.createdAt,
        rows,
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * The groups of the hand off one window asked for, by the name it gave the
 * batch. Another window's hand off of the same threads is never one of them,
 * and neither is anything before this machine wrote the batch.
 */
export function submittedGroups(
  groups: ReadonlyArray<HandOffProgressGroup>,
  batchId: string | null,
  projectId: ProjectId | null,
): HandOffProgressGroup[] {
  if (batchId === null) return [];
  return groups.filter(
    (group) => group.batchId === batchId && (projectId === null || group.projectId === projectId),
  );
}

/** What "Resume here" sends: the thread, and the record the press was made on. */
export function releaseInput(row: Pick<HandOffProgressRow, "threadId" | "operationId">): {
  readonly threadId: ThreadId;
  readonly operationId: string;
} {
  return { threadId: row.threadId, operationId: row.operationId };
}

/**
 * The automatic hand off whose view opens by itself: the newest one with a
 * record this window has not seen. `seen` is null on the window's first read,
 * when only a hand off still under way opens.
 */
export function automaticGroupToOpen(
  seen: ReadonlySet<string> | null,
  groups: ReadonlyArray<HandOffProgressGroup>,
): string | null {
  for (const group of groups) {
    if (group.trigger.kind !== "automatic") continue;
    const fresh =
      seen === null
        ? group.rows.some((row) => !row.finished)
        : group.rows.some((row) => !seen.has(row.operationId));
    if (fresh) return group.key;
  }
  return null;
}

/** The newest move of one thread from this machine, or null when it has none. */
export function threadTransfer(
  transfers: ReadonlyArray<HandoffTransferRecord> | undefined,
  threadId: ThreadId,
): HandoffTransferRecord | null {
  return (
    (transfers ?? [])
      .filter((record) => record.lineage.sourceThreadId === threadId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
  );
}

export interface HandOffProgressNames {
  readonly source: string;
  readonly target: string | null;
}

/** Why the hand off started. Only this line differs between the two starts. */
export function progressReason(
  trigger: HandoffTransferTrigger,
  names: HandOffProgressNames,
  tx: TranslatePhrase,
  track?: string | null,
): string {
  if (trigger.kind === "automatic") {
    if (trigger.reason) return trigger.reason;
    return track
      ? tx("{track} track out of tokens on {machine}", { track, machine: names.source })
      : tx("Out of tokens on {machine}", { machine: names.source });
  }
  if (names.target === null) return tx("You asked to hand off");
  return trigger.kind === "pull"
    ? tx("You asked to continue on {machine}", { machine: names.target })
    : tx("You asked to hand off to {machine}", { machine: names.target });
}

export function progressTitle(project: string, target: string | null, tx: TranslatePhrase): string {
  return target === null
    ? tx("Hand off “{project}”", { project })
    : tx("Hand off “{project}” to {machine}", { project, machine: target });
}

/** The lines under the rows: what waiting and ready mean, only when a row has them. */
export function progressNotes(
  rows: ReadonlyArray<Pick<HandOffProgressRow, "state">>,
  names: HandOffProgressNames,
  tx: TranslatePhrase,
  /** The machine no longer keeps every thread of this hand off. */
  incomplete = false,
): string[] {
  const target = names.target ?? tx("the other machine");
  const notes: string[] = [];
  if (incomplete)
    notes.push(
      tx(
        "{machine} no longer keeps every thread of this hand off, so this list is not all of it.",
        { machine: names.source },
      ),
    );
  if (rows.some((row) => row.state === "waiting"))
    notes.push(
      tx(
        "Waiting is not failed. {source} runs none of these threads while {target} has not answered.",
        { source: names.source, target },
      ),
    );
  if (rows.some((row) => row.state === "ready"))
    notes.push(
      tx("Ready means installed idle: nothing starts on {machine} until you write.", {
        machine: target,
      }),
    );
  return notes;
}

/** No allowed machine has the thread's track: it stays, and this is shown in place of the bar. */
export interface HandOffTrackOut {
  readonly track: string;
  /** Threads that stay on the source. */
  readonly staying: number;
  /** Each eligible sign-in's next reset; null when it reports none. */
  readonly resets: ReadonlyArray<{
    readonly machineLabel: string;
    readonly resetsAt: string | null;
  }>;
}

export interface HandOffTrackOutView {
  readonly track: string;
  readonly staying: number;
  /** The earliest known reset, or null for "Reset unknown". */
  readonly reset: { readonly machineLabel: string; readonly resetsAt: string } | null;
}

export function trackOutView(input: HandOffTrackOut): HandOffTrackOutView {
  let reset: HandOffTrackOutView["reset"] = null;
  let earliest = Number.POSITIVE_INFINITY;
  for (const entry of input.resets) {
    if (entry.resetsAt === null) continue;
    const at = Date.parse(entry.resetsAt);
    if (Number.isNaN(at) || at >= earliest) continue;
    earliest = at;
    reset = { machineLabel: entry.machineLabel, resetsAt: entry.resetsAt };
  }
  return { track: input.track, staying: input.staying, reset };
}
