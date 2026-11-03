/**
 * The filter row of the project Threads pane: which machines and agents to offer, in
 * what order, and which threads a choice keeps. Pure rules only; the pane renders them.
 */
import type { MachineFilterOption } from "./threadMachineFilter";

export interface ThreadPaneFilters {
  readonly machine: string | null;
  readonly agent: string | null;
  readonly openPullRequest: boolean;
}

export interface ThreadPaneFacts {
  readonly machine: string;
  readonly agent: string;
  readonly openPullRequest: boolean;
  readonly open: boolean;
}

export interface MachineChoice {
  readonly machineId: string;
  readonly label: string;
  readonly count: number;
  readonly current: boolean;
}

export interface AgentChoice {
  readonly agent: string;
  readonly count: number;
}

export function threadMatchesPaneFilters(
  facts: ThreadPaneFacts,
  filters: ThreadPaneFilters,
): boolean {
  return (
    (filters.machine === null || facts.machine === filters.machine) &&
    (filters.agent === null || facts.agent === filters.agent) &&
    (!filters.openPullRequest || facts.openPullRequest)
  );
}

/**
 * This machine first, then by name. Unlike the busiest-first menu, these sit in view,
 * and a choice must not move under the pointer because a thread started somewhere.
 * Counts say how many open threads a click would show given the other filters.
 */
export function machineChoices(
  options: readonly MachineFilterOption[],
  facts: readonly ThreadPaneFacts[],
  filters: ThreadPaneFilters,
  currentMachineId: string | null,
): MachineChoice[] {
  const others = { ...filters, machine: null };
  const counts = new Map<string, number>();
  for (const thread of facts) {
    if (thread.open && threadMatchesPaneFilters(thread, others))
      counts.set(thread.machine, (counts.get(thread.machine) ?? 0) + 1);
  }
  return options
    .map((option) => ({
      machineId: option.machineId,
      label: option.label,
      count: counts.get(option.machineId) ?? 0,
      current: option.machineId === currentMachineId,
    }))
    .toSorted(
      (left, right) =>
        Number(right.current) - Number(left.current) ||
        left.label.localeCompare(right.label) ||
        left.machineId.localeCompare(right.machineId),
    );
}

/** The agents threads use, by name; a thread with no agent yet offers nothing. */
export function agentChoices(
  facts: readonly ThreadPaneFacts[],
  filters: ThreadPaneFilters,
): AgentChoice[] {
  const others = { ...filters, agent: null };
  const counts = new Map<string, number>();
  for (const thread of facts) {
    if (thread.agent === "") continue;
    const shown = thread.open && threadMatchesPaneFilters(thread, others);
    counts.set(thread.agent, (counts.get(thread.agent) ?? 0) + (shown ? 1 : 0));
  }
  return [...counts]
    .map(([agent, count]) => ({ agent, count }))
    .toSorted((left, right) => left.agent.localeCompare(right.agent));
}
