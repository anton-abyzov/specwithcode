/**
 * When a provider's usage reading is worth reading again. The picker asks the
 * machine for a fresh read when it opens and a reading is old or unsure, and
 * the composer chip does the same for its own model when it shows a limit it
 * can't vouch for, so "Limit?" turns into a definite answer.
 *
 * @module usageRecheck
 */
import { USAGE_RECHECK_AFTER_MS, type ModelAvailability } from "./modelAvailability";

/** One instance is asked again at most this often, however often the picker opens. */
export const USAGE_RECHECK_THROTTLE_MS = 60_000;

/** A chip that shows an unsure limit asks again at most this often while the picker is closed. */
export const CHIP_RECHECK_THROTTLE_MS = 5 * 60_000;

/** One picker opening reads at most this many providers again. */
export const USAGE_RECHECK_MAX_PER_OPEN = 3;

/** A re-check that has not answered in this long stops showing "Checking". */
export const USAGE_RECHECK_TIMEOUT_MS = 20_000;

/** Whether a reading in `state` is worth a fresh read now. */
export function needsUsageRecheck(state: ModelAvailability, nowMs: number): boolean {
  switch (state.kind) {
    case "stale":
    case "loading":
      return true;
    case "unknown":
      return state.reason === "notRead" || state.reason === "probeFailed";
    case "room":
    case "exhausted":
      return nowMs - state.checkedAt >= USAGE_RECHECK_AFTER_MS;
    case "denied":
      return nowMs - state.checkedAt >= USAGE_RECHECK_AFTER_MS;
    default:
      return false;
  }
}

/** Whether the chip's own state is unsure enough to ask while the picker is closed. */
export function chipNeedsUsageRecheck(state: ModelAvailability): boolean {
  return (
    (state.kind === "stale" && state.wasExhausted) ||
    (state.kind === "unknown" && state.reason === "notRead")
  );
}

/**
 * The instances to read again now: those whose state needs it and that were not
 * asked within `throttleMs`. `lastAskedAt` is keyed by instance id.
 */
export function planUsageRecheck<Id extends string>(input: {
  readonly candidates: ReadonlyArray<{
    readonly instanceId: Id;
    readonly state: ModelAvailability;
  }>;
  readonly nowMs: number;
  readonly lastAskedAt: ReadonlyMap<string, number>;
  readonly throttleMs: number;
  readonly inFlight: ReadonlySet<string>;
  readonly needs?: (state: ModelAvailability, nowMs: number) => boolean;
}): Id[] {
  const needs = input.needs ?? needsUsageRecheck;
  return input.candidates
    .filter(({ instanceId, state }) => {
      if (input.inFlight.has(instanceId)) return false;
      const asked = input.lastAskedAt.get(instanceId);
      if (asked !== undefined && input.nowMs - asked < input.throttleMs) return false;
      return needs(state, input.nowMs);
    })
    .map(({ instanceId }) => instanceId);
}
