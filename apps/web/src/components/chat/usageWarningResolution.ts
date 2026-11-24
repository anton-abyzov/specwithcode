import type { OrchestrationV2Run, OrchestrationV2TurnItem } from "@specweave-studio/contracts";
import {
  isUsageLimitReply,
  MAX_LIMIT_REPLY_LENGTH,
} from "@specweave-studio/shared/usageLimitReply";
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
            // text ("Error: You have exceeded your monthly quota"): only an
            // answer longer than any notice counts there, so a refusal the
            // classifier does not know never reads as recovery.
            ((["assistant_message", "reasoning"].includes(item.type) &&
              "text" in item &&
              item.text.trim().length > 0 &&
              (!limited.has(run.id) || item.text.trim().length > MAX_LIMIT_REPLY_LENGTH)) ||
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
 * limit. Either the server's own rule for such a reply names it
 * (`isUsageLimitReply`, with or without its `Error:` prefix: "Error: You
 * have exceeded your monthly quota"), or it repeats the limit failure the run
 * recorded (Cursor's "… is not included in your weekly usage", which arrives
 * as the run's error). Empty text counts too. Any other wording is an answer.
 */
export function isProviderRefusalText(
  text: string,
  failureMessages: ReadonlyArray<string> = [],
): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || isUsageLimitReply(trimmed) || isUsageLimitReply(`Error: ${trimmed}`))
    return true;
  if (trimmed.length > MAX_LIMIT_REPLY_LENGTH) return false;
  const said = normalized(trimmed);
  return failureMessages.some((message) => {
    const failure = normalized(message);
    return (
      failure.length >= 12 && (said === failure || said.includes(failure) || failure.includes(said))
    );
  });
}

const normalized = (text: string) =>
  text
    .toLowerCase()
    .replace(/[\s\u00a0]+/gu, " ")
    .replace(/[.!…]+$/u, "")
    .trim();
