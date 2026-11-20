/**
 * Who sent a relayed message, for its "Message from <thread> · <machine>" line (1427 AC-06):
 * looked up among the coordinator's own workers and its remote workers, from shells that keep
 * where each thread lives and runs now. A thread whose runner moved names its new machine.
 *
 * @module relaySenders
 */

/** What a relay line reads of a thread. */
export interface RelaySenderShell {
  readonly id: string;
  readonly environmentId: string;
  readonly title: string;
  readonly ownerMachineId?: string;
  readonly executionMachineId?: string;
  readonly executionMachineLabel?: string;
}

const relayKey = (thread: RelaySenderShell) => `${thread.environmentId}:${thread.id}`;

/**
 * The same senders as far as a relay line can tell: the same threads with the same titles,
 * living and running on the same machines. A status change keeps the list, so the
 * conversation's messages are not rebuilt for it.
 */
export function sameRelaySenders(
  kept: readonly RelaySenderShell[],
  next: readonly RelaySenderShell[],
): boolean {
  if (kept.length !== next.length) return false;
  const byKey = new Map(kept.map((thread) => [relayKey(thread), thread]));
  return next.every((other) => {
    const thread = byKey.get(relayKey(other));
    return (
      thread !== undefined &&
      thread.title === other.title &&
      thread.ownerMachineId === other.ownerMachineId &&
      thread.executionMachineId === other.executionMachineId &&
      thread.executionMachineLabel === other.executionMachineLabel
    );
  });
}

/**
 * The thread that sent a relayed message, among every worker the coordinator sees. With the
 * sender's machine, only that machine's thread. With a bare id that threads on more than one
 * machine hold, no sender: the line shows the neutral label rather than another machine's name.
 */
export function relaySender<T extends RelaySenderShell>(
  senderThreadId: string | null | undefined,
  threads: readonly T[],
  senderEnvironmentId?: string | null,
): T | undefined {
  if (!senderThreadId) return undefined;
  const matches = threads.filter(
    (thread) =>
      thread.id === senderThreadId &&
      (!senderEnvironmentId || thread.environmentId === senderEnvironmentId),
  );
  const first = matches[0];
  return first && matches.every((thread) => thread.environmentId === first.environmentId)
    ? first
    : undefined;
}
