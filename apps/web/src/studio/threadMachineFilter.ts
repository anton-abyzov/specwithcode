/**
 * The machine column and filter of the project Threads pane and the sidebar's Chats
 * list: which machines to offer, how many open threads each runs, and how wide the
 * column is so rows line up. Pure rules only; those lists render them.
 */

import { englishPhrase, type TranslatePhrase } from "../i18n";

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

/**
 * The Chats column's width: a row's arrow and offline mark take room from its name, which
 * matters most when every name is short and the column would otherwise be at its minimum.
 */
export function chatMachineColumnCh(
  rows: readonly { readonly name: string; readonly moved: boolean; readonly offline: boolean }[],
): number {
  return machineColumnCh(
    rows.map((row) =>
      "x".repeat([...row.name].length + (row.moved ? 3 : 0) + (row.offline ? 3 : 0)),
    ),
  );
}

/**
 * Whether the Chats list names a machine on each row: not while everything runs on
 * this machine, because then a name on every row would say nothing.
 */
export function chatsShowMachineColumn(input: {
  readonly machineIds: readonly string[];
  readonly primaryEnvironmentId: string | null;
  readonly anyMoved: boolean;
}): boolean {
  if (input.anyMoved || input.machineIds.length > 1) return true;
  const [only] = input.machineIds;
  return only !== undefined && only !== input.primaryEnvironmentId;
}

/** What a chat row's tooltip and screen reader text say about its machines, or nothing. */
export function chatMachineNote(
  input: {
    readonly location: {
      readonly moved: boolean;
      readonly state: string;
      readonly description: string;
    };
    /** The machine the shell came from, when it can't be reached; null while it answers. */
    readonly offlineHost: string | null;
    /** It serves the chat but another machine runs it. */
    readonly runsElsewhere: boolean;
    readonly executionName: string;
    readonly executionOffline: boolean;
    /** The machine to name on a plain row, when any. */
    readonly namedMachine: string | null;
  },
  tx: TranslatePhrase = englishPhrase,
): string | null {
  const runnerOffline = tx("{machine} can't be reached", { machine: input.executionName });
  if (input.offlineHost !== null) {
    const host = tx("{machine} can't be reached", { machine: input.offlineHost });
    if (!input.runsElsewhere) return host;
    return `${host} · ${
      input.executionOffline
        ? runnerOffline
        : tx("runs on {machine}", { machine: input.executionName })
    }`;
  }
  if (input.location.moved || input.location.state !== "running") {
    // An unknown runner's description already says it stopped answering.
    return input.executionOffline && input.location.state !== "unknown"
      ? `${input.location.description} · ${runnerOffline}`
      : input.location.description;
  }
  return input.namedMachine ? tx("On {machine}", { machine: input.namedMachine }) : null;
}
