import type { OrchestrationV2TurnItem } from "@specweave-studio/contracts";

/**
 * Least time between two stored snapshots of one running tool item. Agents
 * can stream a tool's output dozens of times a second, and every update stores
 * the whole item again; the timeline only needs a few frames a second.
 */
export const TOOL_ITEM_PERSIST_INTERVAL_MS = 300;

/**
 * How long a turn item may go without a stored update that only moves its
 * `updatedAt`. Well under the shortest idle limit that ends a quiet run
 * (ORPHANED_RUN_ENDED_SESSION_IDLE, 5 minutes), so a tool that keeps
 * reporting unchanged content still keeps its run alive. The ingestor applies
 * the same limit to every turn item.
 */
export const TURN_ITEM_TIME_ONLY_REFRESH_MS = 60_000;

/** What to do with a tool item update: store it now, keep it for later, or drop it. */
export type ToolItemPersistDecision = "emit" | "hold" | "skip";

const OPEN_STATUSES: ReadonlySet<OrchestrationV2TurnItem["status"]> = new Set([
  "pending",
  "running",
  "waiting",
]);

/** Whether a tool item can still change: pending, running or waiting. */
export function isOpenToolItemStatus(status: OrchestrationV2TurnItem["status"]): boolean {
  return OPEN_STATUSES.has(status);
}

/** A stable form of an item for comparison, without the time it was sent. */
export function turnItemContentKey(item: OrchestrationV2TurnItem): string {
  return JSON.stringify({ ...item, updatedAt: null });
}

/**
 * Decides one tool item update against the last update that was stored.
 * The first update, any status or title change, and every end (completed,
 * failed, interrupted, cancelled) are stored at once, so the final item is
 * always exact. An update that changes nothing but `updatedAt` is dropped,
 * unless the last stored one is a minute old.
 * Other progress inside the interval is held; the caller stores the latest
 * held update when the interval ends or the turn settles.
 */
export function decideToolItemPersist(input: {
  readonly previous:
    | { readonly item: OrchestrationV2TurnItem; readonly at: number; readonly key?: string }
    | undefined;
  readonly next: OrchestrationV2TurnItem;
  /** `turnItemContentKey(next)`, when the caller already has it. */
  readonly nextKey?: string;
  readonly now: number;
  readonly intervalMs?: number;
}): ToolItemPersistDecision {
  const { previous, next, now } = input;
  if (previous === undefined) return "emit";
  if (!isOpenToolItemStatus(next.status)) return "emit";
  if (previous.item.status !== next.status || previous.item.title !== next.title) return "emit";
  // Even an unchanged update is stored once a minute, so run liveness, which
  // reads the item's updatedAt, still sees a tool that keeps reporting.
  if (now - previous.at >= TURN_ITEM_TIME_ONLY_REFRESH_MS) return "emit";
  const previousKey = previous.key ?? turnItemContentKey(previous.item);
  if (previousKey === (input.nextKey ?? turnItemContentKey(next))) return "skip";
  return now - previous.at >= (input.intervalMs ?? TOOL_ITEM_PERSIST_INTERVAL_MS) ? "emit" : "hold";
}
