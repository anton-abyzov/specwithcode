/**
 * Which app raises a thread's "needs you" item: one owner machine, counted once.
 *
 * A blocker belongs to one machine. Its app counts it in badges and "Needs
 * you"; another app counts it only when it is the device the person is using
 * (the serving machine's notification target). Rows still show it everywhere.
 * Machines are named by their environment id.
 */

interface OwnedThread {
  readonly environmentId: string;
  readonly id: string;
  readonly ownerMachineId?: string | undefined;
}

/** A coordinator's remote workers, as its machine reports them. */
export interface AttentionLauncher {
  /** The coordinator's machine. */
  readonly environmentId: string;
  readonly remoteWorkers?:
    | readonly { readonly environmentId: string; readonly remoteThreadId: string | null }[]
    | undefined;
}

const workerKey = (environmentId: string, threadId: string) =>
  JSON.stringify([environmentId, threadId]);

/** The coordinator machine of every remote worker thread those coordinators know. */
export function remoteWorkerLaunchers(
  launchers: readonly AttentionLauncher[],
): ReadonlyMap<string, string> {
  const byWorker = new Map<string, string>();
  for (const launcher of launchers) {
    for (const worker of launcher.remoteWorkers ?? []) {
      if (worker.remoteThreadId === null || worker.environmentId === launcher.environmentId)
        continue;
      byWorker.set(workerKey(worker.environmentId, worker.remoteThreadId), launcher.environmentId);
    }
  }
  return byWorker;
}

/**
 * The item's owner machine: the coordinator that launched the thread on
 * another machine, else the machine the thread lives on (handoff moves where
 * it runs, never its owner), else the machine that serves it.
 */
export function attentionOwnerMachine(
  thread: OwnedThread,
  launchers: ReadonlyMap<string, string> = new Map(),
): string {
  return (
    launchers.get(workerKey(thread.environmentId, thread.id)) ??
    thread.ownerMachineId ??
    thread.environmentId
  );
}

/**
 * Whether this app counts and badges an item. `isTarget` is null when the
 * serving machine named no target, is too old to name one, or did not answer:
 * on doubt every app raises it, as before. An owner this app cannot reach is
 * nobody's to raise, so this app raises it.
 */
export function raisesAttention(input: {
  readonly ownEnvironmentId: string | null;
  readonly ownerMachineId: string;
  readonly isTarget: boolean | null;
  readonly ownerReachable: boolean;
}): boolean {
  if (input.ownEnvironmentId !== null && input.ownEnvironmentId === input.ownerMachineId)
    return true;
  return input.isTarget !== false || !input.ownerReachable;
}
