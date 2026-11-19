import type { OrchestrationV2AppThread, OrchestrationV2Run } from "@specweave-studio/contracts";
import { latestExecutedRun } from "@specweave-studio/shared/orchestrationV2ThreadError";

/**
 * Why a `limit-preswitch:` move (1089) no longer applies to the thread as it is
 * when the move lands, or null. After a turn it moves only an idle thread whose
 * latest turn completed, on the selection that turn ran or one an earlier
 * pre-switch set. A thread with no turn yet has nothing to compare (the sweep
 * never moves one), so the move stands. The latest turn is returned for the
 * caller's Stop check.
 */
export function preswitchMoveRefusal(
  thread: Pick<OrchestrationV2AppThread, "modelSelection" | "limitPreswitchFrom">,
  runs: ReadonlyArray<OrchestrationV2Run>,
): { readonly refusal: string | null; readonly latest: OrchestrationV2Run | null } {
  // An unfinished run counts as the latest, so a running turn refuses here too.
  const latest = latestExecutedRun(runs);
  if (latest === null) return { refusal: null, latest };
  if (latest.status !== "completed")
    return { refusal: "The latest turn is running or did not complete.", latest };
  const picked =
    thread.limitPreswitchFrom == null &&
    (thread.modelSelection.instanceId !== latest.providerInstanceId ||
      thread.modelSelection.model !== latest.modelSelection.model);
  return { refusal: picked ? "A model was picked since the latest turn." : null, latest };
}
