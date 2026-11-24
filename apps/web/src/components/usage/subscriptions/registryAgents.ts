/**
 * Which agents ran through the ACP Registry (and Antigravity), and on which
 * models, from what each machine recorded (`usage.machineReport`, 1357).
 *
 * Registry agents keep no local transcripts, so a machine reports their turns
 * from SpecWithCode's own records: one cell per day, account and model, with
 * the turn count as `requests` and the tokens the agent reported. Each machine
 * reports its own turns, so recorded cells add up across machines; a cell read
 * from a transcript folder two machines share is counted once, by its source.
 *
 * Pure: the caller resolves an account to its agent.
 */
import type { UsageMachineReport } from "@specweave-studio/contracts";
import { usageAccountKeyDriver } from "@specweave-studio/shared/usageAccountKey";

import { shortModelName } from "../../../studio/shellModel";
import type { ProviderGroup } from "./providerGroups";

/** Drivers this view covers: agents the app reaches through a registry or a bridge. */
export const AGENT_DRIVERS: ReadonlySet<string> = new Set(["acpRegistry", "antigravity"]);
/** Models past this many share the last colour as "Other models". */
export const MAX_MODELS = 6;
export const OTHER_MODELS = "Other models";

export interface ModelTotals {
  readonly model: string;
  readonly turns: number;
  readonly tokens: number;
}

export interface AgentStats {
  readonly group: ProviderGroup;
  readonly turns: number;
  readonly tokens: number;
  /** Turns whose agent reported no token counts. */
  readonly turnsWithoutTokens: number;
  /** Most turns first. */
  readonly models: readonly ModelTotals[];
}

export interface AgentDay {
  readonly day: string;
  /** Turns by model, in `models` order, "Other models" last. */
  readonly turns: ReadonlyMap<string, number>;
  readonly total: number;
}

export interface AgentStatsView {
  readonly agents: readonly AgentStats[];
  /** The models the chart names, most turns first, then "Other models" when it holds any. */
  readonly models: readonly string[];
  readonly days: readonly AgentDay[];
  readonly turns: number;
  readonly tokens: number;
}

export type AgentOf = (
  accountKey: string,
  driver: string,
  label: string | undefined,
) => ProviderGroup;

/** Every day from `sinceDay` through `untilDay`, as `YYYY-MM-DD`. */
export function daysBetween(sinceDay: string, untilDay: string): string[] {
  const days: string[] = [];
  const at = new Date(`${sinceDay}T12:00:00Z`);
  const end = new Date(`${untilDay}T12:00:00Z`).getTime();
  while (at.getTime() <= end && days.length < 400) {
    days.push(at.toISOString().slice(0, 10));
    at.setUTCDate(at.getUTCDate() + 1);
  }
  return days;
}

export function agentStats(
  reports: readonly UsageMachineReport[],
  agentOf: AgentOf,
  range: { readonly sinceDay: string; readonly untilDay: string },
): AgentStatsView {
  const claimedSources = new Map<string, number>();
  const agents = new Map<
    string,
    {
      group: ProviderGroup;
      turns: number;
      tokens: number;
      turnsWithoutTokens: number;
      models: Map<string, { turns: number; tokens: number }>;
    }
  >();
  const byDay = new Map<string, Map<string, number>>();
  const modelTurns = new Map<string, number>();

  reports.forEach((report, reportIndex) => {
    const labels = new Map(report.accounts.map((account) => [account.accountKey, account.label]));
    for (const cell of report.cells) {
      if (cell.day < range.sinceDay || cell.day > range.untilDay) continue;
      const driver = usageAccountKeyDriver(cell.accountKey);
      if (!AGENT_DRIVERS.has(driver)) continue;
      if (cell.source !== undefined) {
        // A transcript folder two machines read is counted by the first that reported it.
        const key = report.sources[cell.source]?.key;
        if (key !== undefined) {
          const owner = claimedSources.get(key);
          if (owner === undefined) claimedSources.set(key, reportIndex);
          else if (owner !== reportIndex) continue;
        }
      }
      const group = agentOf(cell.accountKey, driver, labels.get(cell.accountKey));
      const model = cell.model === "unknown" ? "Model not recorded" : shortModelName(cell.model);
      const agent = agents.get(group.key) ?? {
        group,
        turns: 0,
        tokens: 0,
        turnsWithoutTokens: 0,
        models: new Map(),
      };
      agent.turns += cell.requests;
      agent.tokens += cell.tokens;
      if (cell.tokens === 0) agent.turnsWithoutTokens += cell.requests;
      const totals = agent.models.get(model) ?? { turns: 0, tokens: 0 };
      totals.turns += cell.requests;
      totals.tokens += cell.tokens;
      agent.models.set(model, totals);
      agents.set(group.key, agent);
      modelTurns.set(model, (modelTurns.get(model) ?? 0) + cell.requests);
      const day = byDay.get(cell.day) ?? new Map<string, number>();
      day.set(model, (day.get(model) ?? 0) + cell.requests);
      byDay.set(cell.day, day);
    }
  });

  const ranked = [...modelTurns]
    .filter(([, turns]) => turns > 0)
    .toSorted((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([model]) => model);
  const named = ranked.length > MAX_MODELS ? ranked.slice(0, MAX_MODELS - 1) : ranked;
  const folded = ranked.length > named.length;
  const slot = (model: string) => (named.includes(model) ? model : OTHER_MODELS);

  const days = daysBetween(range.sinceDay, range.untilDay).map((day): AgentDay => {
    const turns = new Map<string, number>();
    for (const [model, count] of byDay.get(day) ?? []) {
      turns.set(slot(model), (turns.get(slot(model)) ?? 0) + count);
    }
    return { day, turns, total: [...turns.values()].reduce((sum, value) => sum + value, 0) };
  });

  const list = [...agents.values()]
    .filter((agent) => agent.turns > 0)
    .map((agent): AgentStats => ({
      group: agent.group,
      turns: agent.turns,
      tokens: agent.tokens,
      turnsWithoutTokens: agent.turnsWithoutTokens,
      models: [...agent.models]
        .map(([model, totals]) => ({ model, ...totals }))
        .filter((entry) => entry.turns > 0)
        .toSorted(
          (left, right) => right.turns - left.turns || left.model.localeCompare(right.model),
        ),
    }))
    .toSorted(
      (left, right) =>
        right.turns - left.turns || left.group.label.localeCompare(right.group.label),
    );

  return {
    agents: list,
    models: folded ? [...named, OTHER_MODELS] : named,
    days,
    turns: list.reduce((sum, agent) => sum + agent.turns, 0),
    tokens: list.reduce((sum, agent) => sum + agent.tokens, 0),
  };
}
