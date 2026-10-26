import type {
  StudioFleetSnapshot,
  StudioFleetRemoteWorkersResult,
} from "@specweave-studio/contracts/studioFleet";
import { AsyncResult } from "effect/reactivity";

/** A refresh keeps its successful observation; a failed read never proves coverage. */
export function fleetWorkerCapability(
  result: AsyncResult.AsyncResult<StudioFleetSnapshot | null, unknown>,
): boolean | null {
  if (result._tag !== "Success" || result.value === null) return null;
  return result.value.machines.some((machine) => machine.workers !== undefined);
}

/**
 * Whether to keep asking for remote workers. Unlike coverage, this follows the
 * last successful snapshot, so one failed fleet poll does not drop the workers.
 */
export function fleetRetainsWorkers(
  result: AsyncResult.AsyncResult<StudioFleetSnapshot | null, unknown>,
): boolean {
  const value = AsyncResult.value(result);
  return value._tag === "Some" && value.value !== null
    ? value.value.machines.some((machine) => machine.workers !== undefined)
    : false;
}

export function remoteAttentionObservation(
  capability: boolean | null,
  result: AsyncResult.AsyncResult<StudioFleetRemoteWorkersResult | null, unknown>,
) {
  const value = AsyncResult.value(result);
  return {
    workers: value._tag === "Some" ? (value.value?.workers ?? []) : [],
    complete: capability !== null && result._tag === "Success" && result.value !== null,
  };
}
