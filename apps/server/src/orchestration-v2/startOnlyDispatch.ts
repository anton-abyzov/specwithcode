/**
 * A `message.dispatch` with `startOnly` starts a turn now or is refused: it
 * never leaves a queued run that could start later on its own, after
 * whatever allowed it has ended. The refusal is not recorded, so the same
 * command goes through once the thread is idle (1427).
 */
export const START_ONLY_WOULD_QUEUE = "The thread cannot start this turn now.";

/**
 * A dispatch carrying `authorityEndsAt` is refused, unrecorded, when the
 * serialized start runs at or after it: what allowed it ended while it waited.
 */
export const START_AUTHORITY_ENDED = "What allowed this turn ended before it could start.";
