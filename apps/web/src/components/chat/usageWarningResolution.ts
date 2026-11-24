import type { OrchestrationV2Run, OrchestrationV2TurnItem } from "@specweave-studio/contracts";
export type UsageRecoveryRun = Pick<OrchestrationV2Run, "id" | "ordinal" | "status" | "startedAt">;
export type UsageRecoveryItem = OrchestrationV2TurnItem;
/**
 * A subsequent execution resolves the old stop; pending or pre-start refusals do
 * not, nor does a later run that failed with nothing but text (1460).
 */
export function usageWarningResolved(
  runId: string | null,
  runs: ReadonlyArray<UsageRecoveryRun>,
  items: ReadonlyArray<UsageRecoveryItem> = [],
): boolean {
  const failed = runs.find((run) => run.id === runId);
  if (failed === undefined) return false;
  const limited = limitStoppedRuns(items);
  return runs.some(
    (run) =>
      run.ordinal > failed.ordinal &&
      run.startedAt !== null &&
      (run.status === "completed" ||
        items.some(
          (item) =>
            item.runId === run.id &&
            // A run that itself stopped on a limit may write the refusal as
            // text ("Error: You have exceeded your monthly quota"): that text
            // is no recovery, a real answer before the stop still is.
            ((["assistant_message", "reasoning"].includes(item.type) &&
              "text" in item &&
              item.text.trim().length > 0 &&
              !(limited.has(run.id) && isProviderRefusalText(item.text))) ||
              (item.providerTurnId !== null &&
                ["command_execution", "file_change", "dynamic_tool", "user_input_request"].includes(
                  item.type,
                ))),
        )),
  );
}

const limitStoppedRunsCache = new WeakMap<ReadonlyArray<UsageRecoveryItem>, ReadonlySet<string>>();

/** Runs with a usage-limit failure item of their own, read once per item list. */
function limitStoppedRuns(items: ReadonlyArray<UsageRecoveryItem>): ReadonlySet<string> {
  const cached = limitStoppedRunsCache.get(items);
  if (cached !== undefined) return cached;
  const runs = new Set<string>();
  for (const item of items)
    if (item.type === "error" && item.failure.class === "usage_limit" && item.runId !== null)
      runs.add(item.runId);
  limitStoppedRunsCache.set(items, runs);
  return runs;
}

/**
 * Text a provider wrote as its whole answer when it refused the turn on a
 * limit: short, and an error or a quota notice ("Error: You have exceeded
 * your monthly quota", "Gemini 4 Neon is not included in your weekly usage").
 */
export function isProviderRefusalText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.length > 400) return false;
  return (
    /^error\b/i.test(trimmed) ||
    /\b(quota|usage limit|rate limit|limit reached|not included in your|buy credits|exceeded)\b/i.test(
      trimmed,
    )
  );
}
