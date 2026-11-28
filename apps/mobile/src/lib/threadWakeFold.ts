import type { OrchestrationV2ProjectedTurnItem, RunId } from "@specweave-studio/contracts";

// Structural row shapes, so this module does not import threadActivity.ts back
// (the mobile dependency graph forbids cycles, type-only ones included).
interface ActivityGroupLike {
  readonly type: "activity-group";
  readonly activities: ReadonlyArray<{ readonly projectedItem: OrchestrationV2ProjectedTurnItem }>;
}
interface RunFoldLike {
  readonly type: "run-fold";
  readonly runId: RunId;
  readonly expanded: boolean;
  readonly wakeLabel?: string;
}
type FeedRowLike = { readonly type: string };

function wakeNoticeOf(row: FeedRowLike | undefined) {
  if (row?.type !== "activity-group") return null;
  const group = row as ActivityGroupLike;
  if (group.activities.length !== 1) return null;
  const item = group.activities[0]?.projectedItem.item;
  if (item?.type !== "notification" || item.runId == null) return null;
  // A failed or cancelled wake reports something that needs attention: it keeps its row.
  if (item.outcome === "failed" || item.outcome === "cancelled") return null;
  return { runId: item.runId, label: item.summary };
}

const mergedFolds = new WeakMap<object, RunFoldLike>();

/**
 * Merges each wake notice into the collapsed "Worked for …" fold of the run it
 * started, when that fold sits right under it: one row instead of two. An open
 * fold, a running turn (no fold yet) and a failed or cancelled notice leave
 * the notice on its own row.
 */
export function mergeWakeNoticesIntoRunFolds<Row extends FeedRowLike>(
  rows: ReadonlyArray<Row>,
): Row[] {
  const out: Row[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const notice = wakeNoticeOf(row);
    const next = rows[index + 1];
    const nextFold = next?.type === "run-fold" ? (next as unknown as RunFoldLike) : null;
    if (
      notice === null ||
      nextFold === null ||
      nextFold.expanded ||
      nextFold.runId !== notice.runId
    ) {
      out.push(row);
      continue;
    }
    let fold = mergedFolds.get(nextFold);
    if (fold?.wakeLabel !== notice.label) {
      fold = { ...nextFold, wakeLabel: notice.label };
      mergedFolds.set(nextFold, fold);
    }
    out.push(fold as unknown as Row);
    index += 1;
  }
  return out;
}
