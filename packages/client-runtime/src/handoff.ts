import type {
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  ProviderInstanceId,
} from "@specweave-studio/contracts";

/**
 * The subset of a projection run that handoff rows read. Kept minimal so the
 * timeline can hold a content-stable snapshot: run status/timestamps churn on
 * every stream event, but these fields only change when a run is added.
 */
export type HandoffTimelineRun = Pick<
  OrchestrationV2Run,
  "id" | "ordinal" | "providerInstanceId" | "modelSelection"
>;

export function resolveHandoffEndpoints(
  item: Pick<
    Extract<OrchestrationV2TurnItem, { type: "handoff" }>,
    "runId" | "fromModelSelections" | "fromProviderInstanceIds" | "toModel" | "toProviderInstanceId"
  >,
  runs: ReadonlyArray<HandoffTimelineRun>,
) {
  // Items persisted before models were stamped only carry instance ids;
  // recover the models from the thread's runs (the handoff's own run is
  // the target, the newest earlier run per source instance is the origin).
  // Clients fall back to the provider display name when neither source has a model.
  const handoffRun = item.runId === null ? undefined : runs.find((run) => run.id === item.runId);
  const toModel =
    item.toModel ??
    (handoffRun !== undefined && handoffRun.providerInstanceId === item.toProviderInstanceId
      ? handoffRun.modelSelection.model
      : undefined);
  const fromEndpoints: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly model?: string | undefined;
  }> =
    item.fromModelSelections !== undefined && item.fromModelSelections.length > 0
      ? item.fromModelSelections
      : item.fromProviderInstanceIds.map((instanceId) => ({
          instanceId,
          model: latestRunModelBefore(runs, instanceId, handoffRun?.ordinal),
        }));
  return { from: fromEndpoints, to: { instanceId: item.toProviderInstanceId, model: toModel } };
}

/**
 * Model of the newest run for `instanceId` that started before the handoff's
 * own run. Legacy handoff items don't record their source models, but the
 * covered runs are still in the projection.
 */
function latestRunModelBefore(
  runs: ReadonlyArray<HandoffTimelineRun>,
  instanceId: ProviderInstanceId,
  beforeOrdinal: number | undefined,
): string | undefined {
  let latest: HandoffTimelineRun | undefined;
  for (const run of runs) {
    if (run.providerInstanceId !== instanceId) continue;
    if (beforeOrdinal !== undefined && run.ordinal >= beforeOrdinal) continue;
    if (latest === undefined || run.ordinal > latest.ordinal) latest = run;
  }
  return latest?.modelSelection.model;
}

/** A model change inside one provider: same native session or a fresh one, but no handoff item. */
export interface SameProviderModelChange {
  readonly runId: OrchestrationV2Run["id"];
  /** The message that started the run on the new model; steered messages join it later. */
  readonly messageId: OrchestrationV2Run["userMessageId"];
  readonly instanceId: ProviderInstanceId;
  readonly fromModel: string;
  readonly toModel: string;
}

/**
 * Where a thread's model changed within one provider. A move between providers
 * has its own handoff row, and a row cancelled before it started ran on nothing.
 */
export function sameProviderModelChanges(
  runs: ReadonlyArray<
    HandoffTimelineRun & Partial<Pick<OrchestrationV2Run, "status" | "startedAt" | "userMessageId">>
  >,
): ReadonlyArray<SameProviderModelChange> {
  const changes: Array<SameProviderModelChange> = [];
  let previous: HandoffTimelineRun | undefined;
  for (const run of runs.toSorted((left, right) => left.ordinal - right.ordinal)) {
    if (run.status === "queued" || (run.status === "cancelled" && run.startedAt == null)) continue;
    if (
      previous !== undefined &&
      run.userMessageId !== undefined &&
      previous.providerInstanceId === run.providerInstanceId &&
      previous.modelSelection.model !== run.modelSelection.model
    ) {
      changes.push({
        runId: run.id,
        messageId: run.userMessageId,
        instanceId: run.providerInstanceId,
        fromModel: previous.modelSelection.model,
        toModel: run.modelSelection.model,
      });
    }
    previous = run;
  }
  return changes;
}
