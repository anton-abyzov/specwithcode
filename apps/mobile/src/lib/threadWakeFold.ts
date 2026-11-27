import type { ThreadFeedEntry } from "./threadActivity";

type RunFoldRow = Extract<ThreadFeedEntry, { readonly type: "run-fold" }>;

function wakeNoticeOf(row: ThreadFeedEntry | undefined) {
  if (row?.type !== "activity-group" || row.activities.length !== 1) return null;
  const item = row.activities[0]?.projectedItem.item;
  if (item?.type !== "notification" || item.runId == null) return null;
  // A failed or cancelled wake reports something that needs attention: it keeps its row.
  if (item.outcome === "failed" || item.outcome === "cancelled") return null;
  return { runId: item.runId, label: item.summary };
}

const mergedFolds = new WeakMap<RunFoldRow, RunFoldRow>();

/**
 * Merges each wake notice into the collapsed "Worked for …" fold of the run it
 * started, when that fold sits right under it: one row instead of two. An open
 * fold, a running turn (no fold yet) and a failed or cancelled notice leave
 * the notice on its own row.
 */
export function mergeWakeNoticesIntoRunFolds(
  rows: ReadonlyArray<ThreadFeedEntry>,
): ThreadFeedEntry[] {
  const out: ThreadFeedEntry[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const notice = wakeNoticeOf(row);
    const next = rows[index + 1];
    if (
      notice === null ||
      next?.type !== "run-fold" ||
      next.expanded ||
      next.runId !== notice.runId
    ) {
      out.push(row);
      continue;
    }
    let fold = mergedFolds.get(next);
    if (fold?.wakeLabel !== notice.label) {
      fold = { ...next, wakeLabel: notice.label };
      mergedFolds.set(next, fold);
    }
    out.push(fold);
    index += 1;
  }
  return out;
}
