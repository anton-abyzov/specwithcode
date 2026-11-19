import type { OrchestrationV2Run } from "@specweave-studio/contracts";
import { latestExecutedRun } from "@specweave-studio/shared/orchestrationV2ThreadError";
import { preswitchWindowResetAt } from "@specweave-studio/shared/threadModelIdentity";

/**
 * The refusal of a move that a turn started after the plan beat. It is not
 * recorded, so the window's move can go out once that turn has ended.
 */
export const PRESWITCH_TURN_STARTED = "The latest turn is still running.";

/**
 * The refusal of a move whose thread's latest turn ended without completing.
 * Nothing changes until another turn runs, so it is recorded and the window's
 * move is spent rather than sent again on every sweep.
 */
export const PRESWITCH_TURN_UNFINISHED = "The latest turn did not complete.";

const ENDED_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

/**
 * Why a `limit-preswitch:` move (1089) no longer applies to the thread as it
 * is when the move lands, or null: it moves a thread only between turns, so
 * a turn that started since the sweep planned it refuses it. A pick since is
 * caught by the command's `expectedModelSelection`, a person's Stop by the
 * caller. The latest turn is returned for that Stop check.
 */
export function preswitchMoveRefusal(runs: ReadonlyArray<OrchestrationV2Run>): {
  readonly refusal: string | null;
  readonly latest: OrchestrationV2Run | null;
} {
  // An unfinished run counts as the latest, so a running turn refuses here.
  const latest = latestExecutedRun(runs);
  if (latest === null) return { refusal: null, latest };
  if (latest.status === "completed") return { refusal: null, latest };
  const ended = ENDED_STATUSES.has(latest.status);
  return { refusal: ended ? PRESWITCH_TURN_UNFINISHED : PRESWITCH_TURN_STARTED, latest };
}

/**
 * Whether an idle move already sent for this thread off `instanceId` still
 * holds: its window, named by the id, has not reset. Another window becoming
 * the fullest gives a new id, but a hand switch back is kept until the window
 * the move went out for resets.
 */
export function preswitchWindowHeld(
  sentIds: Iterable<string>,
  threadId: string,
  instanceId: string,
  nowMs: number,
): boolean {
  const prefix = `limit-preswitch:${threadId}:${instanceId}:`;
  for (const id of sentIds) {
    if (!id.startsWith(prefix)) continue;
    const resetMs = Date.parse(preswitchWindowResetAt(id) ?? "");
    if (Number.isFinite(resetMs) && resetMs > nowMs) return true;
  }
  return false;
}
