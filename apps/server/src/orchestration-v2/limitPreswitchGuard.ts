import type { OrchestrationV2Run } from "@specweave-studio/contracts";
import { latestExecutedRun } from "@specweave-studio/shared/orchestrationV2ThreadError";

/**
 * The refusal of a move that a turn started after the plan beat. It is not
 * recorded, so the window's move can go out once that turn has ended.
 */
export const PRESWITCH_TURN_STARTED = "The latest turn is running or did not complete.";

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
  if (latest.status !== "completed")
    return { refusal: PRESWITCH_TURN_STARTED, latest };
  return { refusal: null, latest };
}
