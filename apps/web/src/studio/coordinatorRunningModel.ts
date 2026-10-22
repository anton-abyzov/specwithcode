/**
 * What the coordinator actually runs on while a usage-limit fallback holds it
 * off its saved model. The fallback never changes the saved choice, so the
 * picker and the line above it read an ongoing run or the thread's selection.
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
  "ordinal" | "providerInstanceId" | "modelSelection" | "status"
>;

export interface CoordinatorModelDisplay {
  /** The model the picker shows. */
  readonly shown: ModelSelection | null;
  /** Set only while a limit fallback runs the coordinator off its saved model. */
  readonly fallback: {
    readonly saved: ModelSelection;
    /** The provider and model the coordinator is on now. */
    readonly now: ModelSelection;
    /** Its newest run there also stopped on a usage limit, and nothing newer runs. */
    readonly spent: boolean;
    readonly reason: CoordinatorFallbackReason;
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
}): CoordinatorModelDisplay {
  const latest = newestRun(input.runs);
  // An ongoing/queued run names the provider doing (or about to do) the work.
  // Once it is terminal, metadata is authoritative: Switch back changes the
  // thread selection without adding a run, so history must not undo that choice.
  const ongoing =
    latest !== null &&
    ["preparing", "queued", "starting", "running", "waiting"].includes(latest.status);
  const activeSelection = ongoing ? runSelection(latest) : null;
  // Quota refresh or a newly saved preference can change the next turn, but
  // cannot change the provider/model of a turn already admitted.
  const none = { shown: activeSelection ?? input.picked, fallback: null };
  const { saved, providers, rule } = input;
  if (saved === null || !providers || !rule) return none;
  const now = activeSelection ?? input.thread;
  if (now === null || now.instanceId === saved.instanceId) return none;
  const check = {
    saved,
    thread: now,
    providers,
    rule,
    nowMs: input.nowMs,
    ...(input.limitedInstanceIds === undefined
      ? {}
      : { limitedInstanceIds: input.limitedInstanceIds }),
  };
  // A model picked by hand that has room, or a saved provider whose limit reset, ends the fallback.
  if (!coordinatorOnLimitFallback(check)) return none;
  return {
    shown: now,
    fallback: {
      saved,
      now,
      spent:
        latest?.status === "failed" &&
        latest.providerInstanceId === now.instanceId &&
        latest.modelSelection.model === now.model &&
        input.latestFailureClass === "usage_limit",
      reason: coordinatorFallbackReason(check),
    },
  };
}
