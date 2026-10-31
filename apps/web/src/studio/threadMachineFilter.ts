/**
 * The project Threads pane's machine column and filter: which machines to offer,
 * how many open threads each runs, and how wide the column is so rows line up.
 * Pure rules only; ThreadsPane renders them.
 */

export interface MachineFilterThread {
  readonly archivedAt: string | null;
  readonly settledOverride?: string | null;
}

export interface MachineFilterOption {
  readonly machineId: string;
  readonly label: string;
  /** Open threads that machine runs; resolved ones are not counted. */
  readonly count: number;
}

/** Machines the threads run on, busiest first, then by name. */
export function machineFilterOptions<T extends MachineFilterThread>(
  threads: readonly T[],
  machineOf: (thread: T) => { readonly machineId: string; readonly label: string },
): MachineFilterOption[] {
  const byMachine = new Map<string, { label: string; count: number }>();
  for (const thread of threads) {
    const { machineId, label } = machineOf(thread);
    const entry = byMachine.get(machineId) ?? { label, count: 0 };
    if (thread.archivedAt === null && thread.settledOverride !== "settled") entry.count += 1;
    byMachine.set(machineId, entry);
  }
  return [...byMachine]
    .map(([machineId, entry]) => ({ machineId, ...entry }))
    .toSorted((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

/** The column fits the longest name between 4 and 10 characters; longer names end in an ellipsis. */
export function machineColumnCh(labels: readonly string[]): number {
  const longest = labels.reduce((max, label) => Math.max(max, [...label].length), 0);
  return Math.min(10, Math.max(4, longest));
}

/** The column names the machine a thread runs on; a moved one marks it with an arrow. */
export function machineColumnLabel(location: {
  readonly label: string;
  readonly moved: boolean;
}): string {
  return location.moved ? `→ ${location.label.split(" → ").at(-1)}` : location.label;
}
