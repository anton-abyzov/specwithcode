import type {
  UsageDeliveredBinding,
  UsageDeliveredCost,
  UsageDeliveredGroup,
  UsageDeliveredIncrement,
  UsageDeliveredModelCost,
  UsageDeliveredReport,
  UsageDeliveredState,
  UsageDeliveredThread,
} from "@specweave-studio/contracts";

import { matchesModelQuery } from "../usageFilters";

/** One machine's answer to `usage.deliveredReport`. */
export type DeliveredAnswer =
  | { readonly kind: "report"; readonly report: UsageDeliveredReport }
  | { readonly kind: "failed" }
  /** Connected, but its version cannot report Delivered. */
  | { readonly kind: "unsupported" }
  /** Out of reach or without permission to read diagnostics. */
  | { readonly kind: "unreachable" };

export interface DeliveredMachine {
  readonly machineId: string;
  readonly name: string;
  readonly answer: DeliveredAnswer;
}

export interface DeliveredFilters {
  readonly drivers: ReadonlySet<string>;
  readonly modelQuery: string;
  readonly projects: ReadonlySet<string>;
}

export interface MergedThread {
  readonly machine: string;
  readonly threadId: string;
  readonly title: string | null;
  readonly binding: UsageDeliveredBinding | null;
  readonly cost: UsageDeliveredCost;
}

export interface MergedIncrement {
  readonly key: string;
  readonly project: string;
  readonly incrementId: string;
  readonly number: string;
  readonly title: string;
  readonly state: UsageDeliveredState;
  readonly closedAt: string | null;
  readonly mergedAt: string | null;
  readonly pullRequests: readonly number[];
  /** Created before the range began: earlier spend is not counted. */
  readonly startedBeforeRange: boolean;
  readonly tasks: { readonly total: number; readonly done: number; readonly doneInRange: number };
  readonly cost: UsageDeliveredCost;
  readonly byModel: readonly UsageDeliveredModelCost[];
  readonly threads: readonly MergedThread[];
  readonly threadCount: number;
  readonly machines: readonly string[];
}

export interface MergedGroup {
  readonly cost: UsageDeliveredCost;
  readonly byModel: readonly UsageDeliveredModelCost[];
  readonly threadCount: number;
  readonly threads: readonly MergedThread[];
}

export interface DeliveredView {
  readonly increments: readonly MergedIncrement[];
  readonly coordinators: MergedGroup;
  readonly otherThreads: MergedGroup;
  readonly outsideApp: MergedGroup;
  /** Increments plus the three groups; with a project filter, only the increments. */
  readonly measured: UsageDeliveredCost;
  readonly attributed: UsageDeliveredCost;
  /** Closed or merged in the range. */
  readonly deliveredCount: number;
  readonly tasksDone: number;
  readonly incrementsWithTasksDone: number;
  /** Median cost of delivered increments that recorded any cost; null with none. */
  readonly medianDeliveredUsd: number | null;
  readonly highest: MergedIncrement | null;
  /** Machines whose numbers are missing, with why. */
  readonly missing: readonly { readonly name: string; readonly reason: string }[];
  readonly answered: readonly string[];
  /** The project filter hides the groups, which carry no project. */
  readonly groupsHidden: boolean;
  /** Projects named in the answers, for the Project filter. */
  readonly projects: readonly string[];
}

const ZERO: UsageDeliveredCost = { costUsd: 0, tokens: 0, records: 0, unpricedRecords: 0 };
const STATE_RANK: Record<UsageDeliveredState, number> = { closed: 2, merged: 1, in_progress: 0 };
const MISSING_REASON: Record<Exclude<DeliveredAnswer["kind"], "report">, string> = {
  failed: "could not build its report",
  unsupported: "runs a version that cannot report Delivered yet",
  unreachable: "is out of reach",
};

function addCost(left: UsageDeliveredCost, right: UsageDeliveredCost): UsageDeliveredCost {
  return {
    costUsd: left.costUsd + right.costUsd,
    tokens: left.tokens + right.tokens,
    records: left.records + right.records,
    unpricedRecords: left.unpricedRecords + right.unpricedRecords,
  };
}

function sumCosts(costs: Iterable<UsageDeliveredCost>): UsageDeliveredCost {
  let total = ZERO;
  for (const cost of costs) total = addCost(total, cost);
  return total;
}

/** Whether a provider and model pass the provider and model filters. */
export function keepsModel(entry: UsageDeliveredModelCost, filters: DeliveredFilters): boolean {
  return (
    (filters.drivers.size === 0 || filters.drivers.has(entry.driver)) &&
    (filters.modelQuery.trim() === "" || matchesModelQuery(entry.model, filters.modelQuery))
  );
}

function narrowsModels(filters: DeliveredFilters): boolean {
  return filters.drivers.size > 0 || filters.modelQuery.trim() !== "";
}

function keptModels(
  byModel: readonly UsageDeliveredModelCost[],
  filters: DeliveredFilters,
): UsageDeliveredModelCost[] {
  return byModel.filter((entry) => keepsModel(entry, filters));
}

function mergeModels(
  lists: Iterable<readonly UsageDeliveredModelCost[]>,
): UsageDeliveredModelCost[] {
  const merged = new Map<string, UsageDeliveredModelCost>();
  for (const list of lists) {
    for (const entry of list) {
      const key = `${entry.driver}\u0000${entry.model}`;
      const known = merged.get(key);
      merged.set(key, known === undefined ? entry : { ...known, ...addCost(known, entry) });
    }
  }
  return [...merged.values()].toSorted((left, right) => right.costUsd - left.costUsd);
}

function threadOf(
  machine: string,
  thread: UsageDeliveredThread,
  filters: DeliveredFilters,
): MergedThread | null {
  const cost = narrowsModels(filters) ? sumCosts(keptModels(thread.byModel, filters)) : thread.cost;
  if (narrowsModels(filters) && cost.records === 0) return null;
  return { machine, threadId: thread.threadId, title: thread.title, binding: thread.binding, cost };
}

function groupOf(
  parts: readonly { readonly machine: string; readonly group: UsageDeliveredGroup }[],
  filters: DeliveredFilters,
): MergedGroup {
  const byModel = mergeModels(parts.map(({ group }) => keptModels(group.byModel, filters)));
  const cost = narrowsModels(filters)
    ? sumCosts(byModel)
    : sumCosts(parts.map(({ group }) => group.cost));
  const threads = parts
    .flatMap(({ machine, group }) =>
      group.threads.flatMap((thread) => threadOf(machine, thread, filters) ?? []),
    )
    .toSorted((left, right) => right.cost.costUsd - left.cost.costUsd);
  return {
    cost,
    byModel,
    threads,
    threadCount: parts.reduce((sum, { group }) => sum + group.threadCount, 0),
  };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function newer(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left > right ? left : right;
}

/**
 * Merges every machine's answer into one view and applies the page filters.
 * Increments meet across machines by project title and folder name; the most
 * advanced state wins (closed, then merged, then in progress), costs and
 * threads add up, and task counts take the most complete checkout.
 */
export function mergeDelivered(
  machines: readonly DeliveredMachine[],
  filters: DeliveredFilters,
): DeliveredView {
  const reports: { readonly machine: string; readonly report: UsageDeliveredReport }[] = [];
  const missing: { name: string; reason: string }[] = [];
  const seenSources = new Set<string>();
  for (const machine of machines) {
    if (machine.answer.kind !== "report") {
      missing.push({ name: machine.name, reason: MISSING_REASON[machine.answer.kind] });
      continue;
    }
    const keys = machine.answer.report.sourceKeys;
    // Two machines reading one home (a shared folder) would count it twice.
    if (keys.length > 0 && keys.every((key) => seenSources.has(key))) continue;
    for (const key of keys) seenSources.add(key);
    reports.push({ machine: machine.name, report: machine.answer.report });
  }

  const projectTitles = new Set<string>();
  const merged = new Map<
    string,
    { entries: { machine: string; increment: UsageDeliveredIncrement }[]; project: string }
  >();
  for (const { machine, report } of reports) {
    const titles = new Map(report.projects.map((project) => [project.projectId, project.title]));
    for (const increment of report.increments) {
      const project = titles.get(increment.projectId) ?? increment.projectId;
      projectTitles.add(project);
      if (filters.projects.size > 0 && !filters.projects.has(project)) continue;
      const key = `${project}\u0000${increment.incrementId}`;
      const known = merged.get(key) ?? { entries: [], project };
      known.entries.push({ machine, increment });
      merged.set(key, known);
    }
  }

  const sinceDay = reports[0]?.report.sinceDay ?? "";
  const increments: MergedIncrement[] = [];
  for (const [key, { entries, project }] of merged) {
    const byModel = mergeModels(
      entries.map(({ increment }) => keptModels(increment.byModel, filters)),
    );
    const cost = narrowsModels(filters)
      ? sumCosts(byModel)
      : sumCosts(entries.map(({ increment }) => increment.cost));
    if (narrowsModels(filters) && cost.records === 0) continue;
    const best = entries.reduce((left, right) =>
      STATE_RANK[right.increment.state] > STATE_RANK[left.increment.state] ? right : left,
    ).increment;
    const threads = entries
      .flatMap(({ machine, increment }) =>
        increment.threads.flatMap((thread) => threadOf(machine, thread, filters) ?? []),
      )
      .toSorted((left, right) => right.cost.costUsd - left.cost.costUsd);
    const first = entries[0]!.increment;
    const number = /^\d+/u.exec(first.incrementId)?.[0] ?? first.incrementId;
    increments.push({
      key,
      project,
      incrementId: first.incrementId,
      number,
      title: entries.find(({ increment }) => increment.title)?.increment.title ?? first.incrementId,
      state: best.state,
      closedAt: entries.reduce<string | null>(
        (at, { increment }) => newer(at, increment.closedAt),
        null,
      ),
      mergedAt: entries.reduce<string | null>(
        (at, { increment }) => newer(at, increment.mergedAt),
        null,
      ),
      pullRequests: [
        ...new Set(entries.flatMap(({ increment }) => increment.pullRequests)),
      ].toSorted((left, right) => left - right),
      startedBeforeRange: entries.some(
        ({ increment }) =>
          increment.createdAt !== null && increment.createdAt.slice(0, 10) < sinceDay,
      ),
      tasks: {
        total: Math.max(...entries.map(({ increment }) => increment.tasks.total)),
        done: Math.max(...entries.map(({ increment }) => increment.tasks.done)),
        doneInRange: Math.max(...entries.map(({ increment }) => increment.tasks.doneInRange)),
      },
      cost,
      byModel,
      threads,
      threadCount: narrowsModels(filters)
        ? threads.length
        : entries.reduce((sum, { increment }) => sum + increment.threadCount, 0),
      machines: [...new Set(entries.map(({ machine }) => machine))],
    });
  }
  increments.sort(
    (left, right) =>
      right.cost.costUsd - left.cost.costUsd ||
      STATE_RANK[right.state] - STATE_RANK[left.state] ||
      right.incrementId.localeCompare(left.incrementId),
  );

  const groupsHidden = filters.projects.size > 0;
  const emptyGroup: MergedGroup = { cost: ZERO, byModel: [], threadCount: 0, threads: [] };
  const group = (pick: (report: UsageDeliveredReport) => UsageDeliveredGroup) =>
    groupsHidden
      ? emptyGroup
      : groupOf(
          reports.map(({ machine, report }) => ({ machine, group: pick(report) })),
          filters,
        );
  const coordinators = group((report) => report.coordinators);
  const otherThreads = group((report) => report.otherThreads);
  const outsideApp = group((report) => report.outsideApp);
  const attributed = sumCosts(increments.map((increment) => increment.cost));
  const delivered = increments.filter((increment) => increment.state !== "in_progress");
  const highest = delivered.reduce<MergedIncrement | null>(
    (best, increment) =>
      best === null || increment.cost.costUsd > best.cost.costUsd ? increment : best,
    null,
  );
  return {
    increments,
    coordinators,
    otherThreads,
    outsideApp,
    attributed,
    measured: sumCosts([attributed, coordinators.cost, otherThreads.cost, outsideApp.cost]),
    deliveredCount: delivered.length,
    tasksDone: increments.reduce((sum, increment) => sum + increment.tasks.doneInRange, 0),
    incrementsWithTasksDone: increments.filter((increment) => increment.tasks.doneInRange > 0)
      .length,
    medianDeliveredUsd: median(
      delivered
        .filter((increment) => increment.cost.records > 0)
        .map((increment) => increment.cost.costUsd),
    ),
    highest: highest !== null && highest.cost.records > 0 ? highest : null,
    missing,
    answered: reports.map(({ machine }) => machine),
    groupsHidden,
    projects: [...projectTitles].toSorted((left, right) => left.localeCompare(right)),
  };
}

/** "Closed Nov 20", "Merged Nov 21" or "In progress". */
export function stateLabel(
  increment: Pick<MergedIncrement, "state" | "closedAt" | "mergedAt">,
  formatDay: (iso: string) => string,
): string {
  if (increment.state === "closed")
    return increment.closedAt === null ? "Closed" : `Closed ${formatDay(increment.closedAt)}`;
  if (increment.state === "merged")
    return increment.mergedAt === null ? "Merged" : `Merged ${formatDay(increment.mergedAt)}`;
  return "In progress";
}

export const BINDING_LABEL: Record<UsageDeliveredBinding, string> = {
  manual: "linked by hand",
  claim: "claim",
  branch: "branch",
  checkpoint: "matched by title",
  name: "matched by title",
  parent: "parent thread",
};

/** Bindings shown as the weakest link. */
export function isWeakBinding(binding: UsageDeliveredBinding | null): boolean {
  return binding === "checkpoint" || binding === "name";
}
