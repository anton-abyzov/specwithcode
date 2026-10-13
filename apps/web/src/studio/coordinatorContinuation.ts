import type { ModelSelection } from "@specweave-studio/contracts";
import type { ProjectMessageRouting } from "./projectMessageRouting";

/** Keep an acknowledged model while the project projection is still catching up. */
export function createCoordinatorSelectionTracker() {
  let current: { selection: ModelSelection | null; revision: number | null } | null = null;
  return {
    observe(selection: ModelSelection | null, revision: number | null) {
      if (
        !current ||
        current.revision === null ||
        (revision !== null && revision >= current.revision)
      )
        current = { selection, revision };
    },
    revision() {
      return current?.revision ?? null;
    },
    selection(): ModelSelection {
      if (!current?.selection) throw new Error("Choose a coordinator model before continuing.");
      return current.selection;
    },
  };
}

/** Ordinary workers keep their native choice; coordinator review uses its saved project choice. */
export function continueWithProjectModel<T>(
  routing: ProjectMessageRouting | null,
  fallback: ModelSelection | undefined,
  operation: (selection: ModelSelection | undefined) => Promise<T>,
): Promise<T> {
  return routing?.continueCoordinator
    ? routing.continueCoordinator(operation)
    : operation(fallback);
}

const selectionKey = (selection: ModelSelection) =>
  JSON.stringify([
    selection.instanceId,
    selection.model,
    (selection.options ?? []).map(({ id, value }) => JSON.stringify([id, value])).sort(),
  ]);

/** Queue resume cannot replace models. Keep mismatched requests paused instead of silently running them. */
export function assertCoordinatorQueueModel(
  selected: ModelSelection,
  runs: ReadonlyArray<{ status: string; modelSelection: ModelSelection }> | null,
): void {
  if (runs === null) throw new Error("Reload coordinator details before resuming queued requests.");
  if (
    runs.some(
      (run) =>
        run.status === "queued" && selectionKey(run.modelSelection) !== selectionKey(selected),
    )
  )
    throw new Error(
      "Queued requests use a different model. Keep them paused and send a new coordinator message, or select their model before resuming.",
    );
}

/** Read queue state after the model barrier, immediately before releasing any held requests. */
export async function resumeQueueWithProjectModel<T>(
  routing: ProjectMessageRouting | null,
  fallback: ModelSelection | undefined,
  readRuns: () => ReadonlyArray<{ status: string; modelSelection: ModelSelection }> | null,
  resume: () => Promise<T>,
): Promise<T> {
  return continueWithProjectModel(routing, fallback, (selection) => {
    if (routing?.continueCoordinator && selection)
      assertCoordinatorQueueModel(selection, readRuns());
    return resume();
  });
}
