/**
 * Reasons the server gives when it interrupts a run by itself. Those interrupts
 * carry no cause, the way a person's Stop does, so readers that must tell them
 * apart (delegated result delivery) match these reasons.
 */

/** StaleRunWatchdog: a run that posted its final answer but whose provider never ended it. */
export const STALE_FINISHED_RUN_REASON =
  "Closed automatically: the turn had posted its final answer and its provider sent nothing for 30 minutes.";

/** EffectWorker: a run whose provider turn never started. */
export const PROVIDER_TURN_START_TIMEOUT_MESSAGE =
  "The provider did not start this turn within 2 minutes, so it was stopped. Send the message again to retry.";

export const SYSTEM_INTERRUPT_REASONS: ReadonlySet<string> = new Set([
  STALE_FINISHED_RUN_REASON,
  PROVIDER_TURN_START_TIMEOUT_MESSAGE,
]);
