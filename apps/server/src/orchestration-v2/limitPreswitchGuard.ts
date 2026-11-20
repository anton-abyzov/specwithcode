import type { OrchestrationV2Run } from "@specweave-studio/contracts";
import { latestExecutedRun } from "@specweave-studio/shared/orchestrationV2ThreadError";
import { preswitchWindowResetAt } from "@specweave-studio/shared/threadModelIdentity";

/**
 * The refusal of a move that a turn started after the plan beat. It is not
 * recorded, so the window's move can go out once that turn has ended.
 */
export const PRESWITCH_TURN_STARTED = "A turn is running or queued.";

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
  // Queued sends start on the model they were sent with, so the move waits
  // until they have run; a held queue is skipped before planning (1089).
  if (runs.some((run) => run.status === "queued"))
    return { refusal: PRESWITCH_TURN_STARTED, latest };
  if (latest === null) return { refusal: null, latest };
  if (latest.status === "completed") return { refusal: null, latest };
  const ended = ENDED_STATUSES.has(latest.status);
  return { refusal: ended ? PRESWITCH_TURN_UNFINISHED : PRESWITCH_TURN_STARTED, latest };
}

/** The prefix of every idle move a thread is sent off `instanceId` (1089). */
export const preswitchIdPrefix = (threadId: string, instanceId: string): string =>
  `limit-preswitch:${threadId}:${instanceId}:`;

/**
 * Whether an idle move already sent for this thread off `instanceId` still
 * holds, so a hand switch back is kept: until the reset its id names has
 * passed, or for an id with no reset (`open`), until the sweep clears it on
 * reading the provider under the threshold. Another window becoming the
 * fullest, or a reset time learned later, gives a new id but not a new move.
 */
export function preswitchWindowHeld(
  sentIds: Iterable<string>,
  threadId: string,
  instanceId: string,
  nowMs: number,
): boolean {
  const prefix = preswitchIdPrefix(threadId, instanceId);
  for (const id of sentIds) {
    if (!id.startsWith(prefix)) continue;
    const resetMs = Date.parse(preswitchWindowResetAt(id) ?? "");
    if (!Number.isFinite(resetMs) || resetMs > nowMs) return true;
  }
  return false;
}
