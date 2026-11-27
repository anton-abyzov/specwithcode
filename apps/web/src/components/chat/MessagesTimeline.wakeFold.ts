import type { OrchestrationV2TurnItem, ThreadId } from "@specweave-studio/contracts";
import { notificationChildThreadId } from "@specweave-studio/client-runtime/state/thread-execution";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

type TurnFoldRow = Extract<MessagesTimelineRow, { kind: "turn-fold" }>;
type NotificationItem = Extract<OrchestrationV2TurnItem, { type: "notification" }>;

/** The wake notice a settled turn's fold leads with: why the thread woke. */
export interface TurnFoldWake {
  /** The notice's own text, such as `Delegated task "X" finished`. */
  readonly label: string;
  /** The subagent or delegated task the notice reports, kept one click away on the fold. */
  readonly childThreadId?: ThreadId;
}

function wakeNoticeOf(row: MessagesTimelineRow | undefined) {
  if (row?.kind !== "work" || row.groupedEntries.length !== 1) return null;
  const entry = row.groupedEntries[0];
  if (entry?.itemType !== "notification" || entry.runId == null) return null;
  const item = entry.structuredPayload as Partial<NotificationItem> | undefined;
  // A failed or cancelled wake reports something that needs attention: it keeps its row.
  if (item?.outcome === "failed" || item?.outcome === "cancelled") return null;
  const childThreadId = item?.source ? notificationChildThreadId(item.source) : undefined;
  const wake: TurnFoldWake =
    childThreadId === undefined ? { label: entry.label } : { label: entry.label, childThreadId };
  return { runId: entry.runId, wake };
}

/**
 * Merges each wake notice into the collapsed "Worked for …" fold of the run it
 * started, when that fold sits right under it: one row instead of two. An open
 * fold, a running turn (no fold yet) and a failed or cancelled notice leave
 * the notice on its own row.
 */
export function mergeWakeNoticesIntoTurnFolds(
  rows: ReadonlyArray<MessagesTimelineRow>,
): MessagesTimelineRow[] {
  const out: MessagesTimelineRow[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const notice = wakeNoticeOf(row);
    const next = rows[index + 1];
    if (
      notice === null ||
      next?.kind !== "turn-fold" ||
      next.expanded ||
      next.runId !== notice.runId
    ) {
      out.push(row);
      continue;
    }
    const fold: TurnFoldRow = { ...next, wake: notice.wake };
    out.push(fold);
    index += 1;
  }
  return out;
}
