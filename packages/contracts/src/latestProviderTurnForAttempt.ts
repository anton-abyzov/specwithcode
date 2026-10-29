import type { RunAttemptId } from "./baseSchemas.ts";
import type { OrchestrationV2ProviderTurn } from "./orchestrationV2.ts";

/**
 * The provider turn a run attempt is on or ended with. A Codex goal keeps one
 * run open across several native turns, so an attempt's first turn is not
 * always its last.
 */
export function latestProviderTurnForAttempt<
  Turn extends Pick<OrchestrationV2ProviderTurn, "runAttemptId" | "ordinal">,
>(
  providerTurns: ReadonlyArray<Turn>,
  attemptId: RunAttemptId | null | undefined,
): Turn | undefined {
  let latest: Turn | undefined;
  for (const turn of providerTurns) {
    if (attemptId == null || turn.runAttemptId !== attemptId) continue;
    if (latest === undefined || turn.ordinal > latest.ordinal) latest = turn;
  }
  return latest;
}
