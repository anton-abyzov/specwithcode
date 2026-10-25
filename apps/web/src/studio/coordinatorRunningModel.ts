/**
 * What the coordinator actually runs on when that is not its saved model. The
 * fallback never changes the saved choice, so the picker and the line above it
 * read an ongoing run or the thread's selection, never a guess about the next turn.
 */
import type {
  ModelSelection,
  OrchestrationV2ProviderFailureClass,
  OrchestrationV2Run,
  ServerProvider,
} from "@specweave-studio/contracts";
import {
  coordinatorFallbackReason,
  coordinatorOnLimitFallback,
  type CoordinatorFallbackReason,
  type ProviderFallbackRule,
} from "@specweave-studio/shared/providerFallback";

export type CoordinatorRunSummary = Pick<
  OrchestrationV2Run,
  "ordinal" | "providerInstanceId" | "modelSelection" | "status" | "queueHeld"
>;

export interface CoordinatorModelDisplay {
  /** The model the picker shows. */
  readonly shown: ModelSelection | null;
  /** Set whenever the coordinator runs, or last ran, on another model than its saved one. */
  readonly fallback: {
    readonly saved: ModelSelection;
    /** The provider and model the coordinator is on now. */
    readonly now: ModelSelection;
    /** A turn is running there right now. */
    readonly live: boolean;
    /** Its newest run there also stopped on a usage limit, and nothing newer runs. */
    readonly spent: boolean;
    /**
     * Why the saved model has no room, when this client's usage read shows it. The
     * host also holds providers back on evidence the client does not have, so a
     * missing reason never means the next turn goes back.
     */
    readonly reason: CoordinatorFallbackReason | null;
  } | null;
}

/** The newest run, by ordinal: a queued one names the next turn's provider. */
function newestRun(
  runs: ReadonlyArray<CoordinatorRunSummary> | null | undefined,
): CoordinatorRunSummary | null {
  let newest: CoordinatorRunSummary | null = null;
  for (const run of runs ?? []) if (newest === null || run.ordinal > newest.ordinal) newest = run;
  return newest;
}

/** A run's provider instance is where it ran, whatever its selection says. */
function runSelection(run: CoordinatorRunSummary): ModelSelection {
  return run.modelSelection.instanceId === run.providerInstanceId
    ? run.modelSelection
    : { ...run.modelSelection, instanceId: run.providerInstanceId };
}

function sameModel(a: ModelSelection, b: ModelSelection): boolean {
  return a.instanceId === b.instanceId && a.model === b.model;
}

export function coordinatorModelDisplay(input: {
  /** What the picker shows without a fallback: the saved model, or the default the host starts. */
  readonly picked: ModelSelection | null;
  /** The project's saved coordinator model. */
  readonly saved: ModelSelection | null;
  /** The coordinator thread's own model; null before the thread exists. */
  readonly thread: ModelSelection | null;
  /** The coordinator's runs, when its projection is loaded. */
  readonly runs: ReadonlyArray<CoordinatorRunSummary> | null | undefined;
  /** Why the thread's latest run failed, if it did. */
  readonly latestFailureClass: OrchestrationV2ProviderFailureClass | null | undefined;
  readonly providers: ReadonlyArray<ServerProvider> | null | undefined;
  readonly rule: ProviderFallbackRule | null | undefined;
  readonly nowMs: number;
  readonly limitedInstanceIds?: ReadonlySet<string>;
  /**
   * A model picked by hand in this window, and the newest run ordinal when it was
   * saved. A save never moves the thread, so until a newer run starts the pick is
   * what the next turn names, not a fallback.
   */
  readonly handPick?: { readonly selection: ModelSelection; readonly afterOrdinal: number } | null;
}): CoordinatorModelDisplay {
  const latest = newestRun(input.runs);
  // Match the shell identity: admitted work precedes queued next-message choices.
  // Once it is terminal, metadata is authoritative: Switch back changes the
  // thread selection without adding a run, so history must not undo that choice.
  const ongoing = (input.runs ?? [])
    .filter(
      (run) =>
        ["preparing", "queued", "starting", "running", "waiting"].includes(run.status) &&
        run.queueHeld !== true,
    )
    .toSorted(
      (a, b) =>
        Number(a.status === "queued") - Number(b.status === "queued") || b.ordinal - a.ordinal,
    )[0];
  const activeSelection = ongoing ? runSelection(ongoing) : null;
  // Quota refresh or a newly saved preference can change the next turn, but
  // cannot change the provider/model of a turn already admitted.
  const none = { shown: activeSelection ?? input.picked, fallback: null };
  const { saved, providers, rule } = input;
  if (saved === null) return none;
  const now = activeSelection ?? input.thread;
  if (now === null || sameModel(now, saved)) return none;
  const check =
    providers && rule
      ? {
          saved,
          thread: now,
          providers,
          rule,
          nowMs: input.nowMs,
          ...(input.limitedInstanceIds === undefined
            ? {}
            : { limitedInstanceIds: input.limitedInstanceIds }),
        }
      : null;
  const pick = input.handPick;
  // A fresh pick names the next turn, unless this client already reads that the
  // pick has no room: then the host moves that turn too, so the fallback stays.
  if (
    activeSelection === null &&
    pick &&
    sameModel(pick.selection, saved) &&
    (latest?.ordinal ?? 0) <= pick.afterOrdinal &&
    !(check !== null && now.instanceId !== saved.instanceId && coordinatorOnLimitFallback(check))
  )
    return none;
  // What runs is a fact; whether the saved model has room again is only this client's read.
  return {
    shown: now,
    fallback: {
      saved,
      now,
      live: activeSelection !== null,
      spent:
        latest?.status === "failed" &&
        latest.providerInstanceId === now.instanceId &&
        latest.modelSelection.model === now.model &&
        input.latestFailureClass === "usage_limit",
      reason:
        check !== null && now.instanceId !== saved.instanceId && coordinatorOnLimitFallback(check)
          ? coordinatorFallbackReason(check)
          : null,
    },
  };
}
