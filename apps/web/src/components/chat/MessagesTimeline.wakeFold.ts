import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

type TurnFoldRow = Extract<MessagesTimelineRow, { kind: "turn-fold" }>;

/** The wake notice a settled turn's fold leads with: why the thread woke. */
export interface TurnFoldWake {
  /** The notice's own text, such as `Delegated task "X" finished`. */
  readonly label: string;
}

function wakeNoticeOf(row: MessagesTimelineRow | undefined) {
  if (row?.kind !== "work" || row.groupedEntries.length !== 1) return null;
  const entry = row.groupedEntries[0];
  if (entry?.itemType !== "notification" || entry.runId == null) return null;
  const payload = entry.structuredPayload as { readonly outcome?: unknown } | undefined;
  // A failed or cancelled wake reports something that needs attention: it keeps its row.
  if (payload?.outcome === "failed" || payload?.outcome === "cancelled") return null;
  return { row, runId: entry.runId, label: entry.label };
}

/**
 * Merges each wake notice into the "Worked for …" fold of the run it started,
 * when that fold sits right under it: one row instead of two. A folded turn
 * hides the notice behind its fold; an open one shows the notice as its first
 * row. Notices of running turns (which have no fold yet) keep their own row.
 */
export function mergeWakeNoticesIntoTurnFolds(
  rows: ReadonlyArray<MessagesTimelineRow>,
): MessagesTimelineRow[] {
  const out: MessagesTimelineRow[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const notice = wakeNoticeOf(row);
    const next = rows[index + 1];
    if (notice === null || next?.kind !== "turn-fold" || next.runId !== notice.runId) {
      out.push(row);
      continue;
    }
    const fold: TurnFoldRow = { ...next, wake: { label: notice.label } };
    out.push(fold);
    if (fold.expanded) out.push(notice.row);
    index += 1;
  }
  return out;
}
