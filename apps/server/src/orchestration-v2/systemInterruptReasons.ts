/**
 * Reasons the server gives when it interrupts a run by itself. Those interrupts
 * carry no cause, the way a person's Stop does, so readers that must tell them
 * apart (delegated result delivery) match these reasons.
 */

/** StaleRunWatchdog: a run that posted its final answer but whose provider never ended it. */
export const STALE_FINISHED_RUN_REASON =
  "Closed automatically: the turn had posted its final answer and its provider sent nothing for 30 minutes.";

/**
 * StaleRunWatchdog: a running turn on a live session that sent nothing for 45
 * minutes while waiting on nothing (no open tool, subagent, request or wait).
 */
export const LIVE_SILENT_RUN_REASON =
  "Stopped automatically: the provider sent nothing for 45 minutes while the turn was waiting on nothing. Send a message to continue.";

/** EffectWorker: a run whose provider turn never started. */
export const PROVIDER_TURN_START_TIMEOUT_MESSAGE =
  "The provider did not start this turn within 2 minutes, so it was stopped. Send the message again to retry.";

export const SYSTEM_INTERRUPT_REASONS: ReadonlySet<string> = new Set([
  STALE_FINISHED_RUN_REASON,
  LIVE_SILENT_RUN_REASON,
  PROVIDER_TURN_START_TIMEOUT_MESSAGE,
]);

/**
 * Whether a recorded interrupt request is a person's Stop, which is final. A
 * service update resumes on its own, an agent's interrupt (a handoff,
 * studio_thread_interrupt) expects the run to go on, and the server's own
 * interrupts (watchdog, start timeout) are no Stop.
 */
export function isPersonStopRequest(item: {
  readonly cause?: string | undefined;
  readonly message: string;
}): boolean {
  return (
    item.cause !== "service_update" &&
    item.cause !== "agent" &&
    !(item.cause === undefined && SYSTEM_INTERRUPT_REASONS.has(item.message))
  );
}
