import type { ModelSelection, OrchestrationV2Run } from "@specweave-studio/contracts";
import { latestExecutedRun } from "@specweave-studio/shared/orchestrationV2ThreadError";

/** The same model and options on the same instance. */
export const sameModelSelection = (left: ModelSelection, right: ModelSelection): boolean =>
  left.instanceId === right.instanceId &&
  left.model === right.model &&
  JSON.stringify(left.options ?? null) === JSON.stringify(right.options ?? null);

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
    return { refusal: "The latest turn is running or did not complete.", latest };
  return { refusal: null, latest };
}
