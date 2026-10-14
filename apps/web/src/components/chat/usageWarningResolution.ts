import type { OrchestrationV2Run, OrchestrationV2TurnItem } from "@specweave-studio/contracts";
export type UsageRecoveryRun = Pick<OrchestrationV2Run, "id" | "ordinal" | "status" | "startedAt">;
export type UsageRecoveryItem = OrchestrationV2TurnItem;
/** A subsequent execution resolves the old stop; pending or pre-start refusals do not. */
export function usageWarningResolved(
  runId: string | null,
  runs: ReadonlyArray<UsageRecoveryRun>,
  items: ReadonlyArray<UsageRecoveryItem> = [],
): boolean {
  const failed = runs.find((run) => run.id === runId);
  return (
    failed !== undefined &&
    runs.some(
      (run) =>
        run.ordinal > failed.ordinal &&
        run.startedAt !== null &&
        (run.status === "completed" ||
          items.some(
            (item) =>
              item.runId === run.id &&
              ((["assistant_message", "reasoning"].includes(item.type) &&
                "text" in item &&
                item.text.trim().length > 0) ||
                (item.providerTurnId !== null &&
                  [
                    "command_execution",
                    "file_change",
                    "dynamic_tool",
                    "user_input_request",
                  ].includes(item.type))),
          )),
    )
  );
}
