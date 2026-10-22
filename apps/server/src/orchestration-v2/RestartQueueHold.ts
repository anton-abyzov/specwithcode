import type { OrchestrationV2Run } from "@specweave-studio/contracts";

/**
 * Messages the server sends a thread on its own after a restart or an update:
 * the continuation of a cut-off turn, and the queued messages an update
 * cancelled, queued again.
 */
export const RESTART_CONTINUATION_MESSAGE_PREFIX = "message:restart-continuation:";
export const UPDATE_CONTINUATION_MESSAGE_PREFIX = "message:update-continuation:";
export const UPDATE_REQUEUE_MESSAGE_PREFIX = "message:update-requeue:";

/**
 * Whether `command` is one of those messages. A requeued message keeps the
 * sender and source of the one it replaces, so only its id marks it.
 */
export function isRestartDelivery(command: {
  readonly messageId?: string | undefined;
  readonly creationSource?: string | undefined;
}): boolean {
  if (command.messageId?.startsWith(UPDATE_REQUEUE_MESSAGE_PREFIX) === true) return true;
  return (
    command.creationSource === "server" &&
    [RESTART_CONTINUATION_MESSAGE_PREFIX, UPDATE_CONTINUATION_MESSAGE_PREFIX].some(
      (prefix) => command.messageId?.startsWith(prefix) === true,
    )
  );
}

/** A queued message a service update cancelled before it started. */
export function cancelledForUpdate(
  run: Pick<OrchestrationV2Run, "status" | "cancelledForUpdate">,
): boolean {
  return run.status === "cancelled" && run.cancelledForUpdate === true;
}

/**
 * Whether a person holds the thread's queue: a held message without the
 * restart's mark (Stop, a failure the next message would repeat, or a hold
 * saved before the mark existed). Only the person releases that hold; a
 * restart's own deliveries release only the hold the restart set.
 */
export function personHoldsQueue(
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "status" | "queueHeld" | "queueHeldForRestart">>,
): boolean {
  return runs.some(
    (run) => run.status === "queued" && run.queueHeld === true && run.queueHeldForRestart !== true,
  );
}

export function holdForRestart(run: OrchestrationV2Run): OrchestrationV2Run {
  return { ...run, queueHeld: true, queueHeldForRestart: true };
}

export function holdForPerson(run: OrchestrationV2Run): OrchestrationV2Run {
  const { queueHeldForRestart: _restart, ...rest } = run;
  return { ...rest, queueHeld: true };
}

export function releaseHold(run: OrchestrationV2Run): OrchestrationV2Run {
  const { queueHeldForRestart: _restart, ...rest } = run;
  return { ...rest, queueHeld: false };
}
