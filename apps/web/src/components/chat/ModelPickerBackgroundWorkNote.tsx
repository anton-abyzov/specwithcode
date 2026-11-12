import type { OrchestrationV2PendingBackgroundTask } from "@specweave-studio/contracts";
import { presentPendingBackgroundWork } from "@specweave-studio/client-runtime/state/thread-execution";
import { providerHostedBackgroundWork } from "@specweave-studio/shared/orchestrationV2PendingBackgroundWork";
import { useTx } from "../../i18n";

/**
 * What a settled thread's provider process still runs, as the picker names
 * it ("Waiting on subagent Review src/math.ts"), or null when a pick applies
 * at once. Only Claude keeps a model and effort for the life of that process.
 */
export function pickerBackgroundWorkLabel(input: {
  readonly driver: string | null | undefined;
  readonly working: boolean;
  readonly tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
}): string | null {
  if (input.driver !== "claudeAgent" || input.working) return null;
  return presentPendingBackgroundWork(providerHostedBackgroundWork(input.tasks))?.title ?? null;
}

/**
 * Says, where the choice is made, that a model or effort picked now waits for
 * the thread's background work, and names that work.
 */
export function ModelPickerBackgroundWorkNote({ work }: { readonly work: string }) {
  const tx = useTx();
  return (
    <p
      className="shrink-0 border-t border-border/70 px-3 py-2 text-xs leading-snug text-muted-foreground"
      role="note"
      data-model-picker-background-work-note=""
    >
      <span className="text-foreground">{work}.</span>{" "}
      {tx(
        "A model or effort you pick now applies when it finishes. Messages keep running on the current one until then. To switch sooner, stop the background work.",
      )}
    </p>
  );
}
