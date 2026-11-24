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
            // A run that itself stopped on a limit wrote the refusal as text
            // ("Error: You have exceeded your monthly quota"); only its tool
            // work counts.
            ((!limited.has(run.id) &&
              ["assistant_message", "reasoning"].includes(item.type) &&
              "text" in item &&
              item.text.trim().length > 0) ||
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
