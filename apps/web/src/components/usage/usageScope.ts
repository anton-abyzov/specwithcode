import { PROVIDER_DISPLAY_NAMES, type UsageProviderKind } from "@specweave-studio/contracts";

import { PROVIDER_ORDER, PROVIDER_PRESENTATION } from "./usageProviders";
import type { UsageMetric } from "./usageShortcuts";

/**
 * Filters the Usage page applies across tabs (1456). Providers are keyed by
 * driver kind (`claudeAgent`, `codex`, `copilot`, ACP drivers), the one key
 * Cost, Limits, Machines and Delivered all carry; Cost's transcript kinds map
 * onto it. Projects are keyed by title, since each machine has its own id.
 */
export type UsageScopeFilter = "provider" | "model" | "machine" | "project";

/** What each tab can narrow by, and why not when it cannot. */
export const FILTER_SUPPORT: Record<
  UsageMetric,
  Partial<Record<UsageScopeFilter, true>> & {
    readonly reasons: Partial<Record<UsageScopeFilter, string>>;
  }
> = {
  cost: {
    provider: true,
    model: true,
    machine: true,
    reasons: { project: "its records carry no project" },
  },
  tokens: {
    provider: true,
    model: true,
    machine: true,
    reasons: { project: "its records carry no project" },
  },
  limits: {
    provider: true,
    machine: true,
    reasons: {
      model: "limits are per account, not per model",
      project: "limits are per account, not per project",
    },
  },
  machines: {
    provider: true,
    machine: true,
    reasons: {
      model: "it groups by account and machine",
      project: "subscription shares and outside estimates are per account",
    },
  },
  delivered: { provider: true, model: true, machine: true, project: true, reasons: {} },
};

export const SCOPE_FILTER_LABEL: Record<UsageScopeFilter, string> = {
  provider: "Provider",
  model: "Model search",
  machine: "Machine",
  project: "Project",
};

const DRIVER_BY_KIND = Object.fromEntries(
  PROVIDER_ORDER.map((kind) => [kind, String(PROVIDER_PRESENTATION[kind].driverKind)]),
) as Record<UsageProviderKind, string>;

export function driverOfUsageKind(kind: UsageProviderKind): string {
  return DRIVER_BY_KIND[kind];
}

/** The transcript kind a driver reads as on Cost and Tokens; null when it has none. */
export function usageKindOfDriver(driver: string): UsageProviderKind | null {
  return PROVIDER_ORDER.find((kind) => DRIVER_BY_KIND[kind] === driver) ?? null;
}

/** A driver's name as people read it: Cost's label first, then the provider's display name. */
export function driverLabel(driver: string): string {
  const kind = usageKindOfDriver(driver);
  if (kind !== null) return PROVIDER_PRESENTATION[kind].label;
  return (PROVIDER_DISPLAY_NAMES as Record<string, string | undefined>)[driver] ?? driver;
}

/** Selected drivers that Cost and Tokens can show, as transcript kinds. */
export function usageKindsOfDrivers(drivers: ReadonlySet<string>): ReadonlySet<UsageProviderKind> {
  const kinds = new Set<UsageProviderKind>();
  for (const driver of drivers) {
    const kind = usageKindOfDriver(driver);
    if (kind !== null) kinds.add(kind);
  }
  return kinds;
}

/** Empty selection keeps everything. */
export function keepsDriver(drivers: ReadonlySet<string>, driver: string): boolean {
  return drivers.size === 0 || drivers.has(driver);
}

export function keepsProject(
  projects: ReadonlySet<string>,
  title: string | null | undefined,
): boolean {
  return projects.size === 0 || (title != null && projects.has(title));
}

/** Drivers in a stable order: Cost's order first, then the rest by label. */
export function sortDrivers(drivers: Iterable<string>): string[] {
  const unique = [...new Set(drivers)];
  const rank = (driver: string) => {
    const kind = usageKindOfDriver(driver);
    return kind === null ? PROVIDER_ORDER.length : PROVIDER_ORDER.indexOf(kind);
  };
  return unique.toSorted(
    (left, right) =>
      rank(left) - rank(right) || driverLabel(left).localeCompare(driverLabel(right)),
  );
}

export interface ActiveScope {
  readonly drivers: ReadonlySet<string>;
  readonly modelQuery: string;
  readonly projects: ReadonlySet<string>;
  /** Some machines, not all, are selected. */
  readonly machinesNarrowed: boolean;
}

/** One line per active filter the tab cannot apply, naming the reason. */
export function notAppliedNotes(metric: UsageMetric, scope: ActiveScope): string[] {
  const support = FILTER_SUPPORT[metric];
  const active: Record<UsageScopeFilter, boolean> = {
    provider: scope.drivers.size > 0,
    model: scope.modelQuery.trim() !== "",
    machine: scope.machinesNarrowed,
    project: scope.projects.size > 0,
  };
  const tab = metric.charAt(0).toUpperCase() + metric.slice(1);
  return (Object.keys(active) as UsageScopeFilter[]).flatMap((filter) =>
    active[filter] && support[filter] !== true
      ? [
          `${SCOPE_FILTER_LABEL[filter]} is not applied on ${tab}: ${support.reasons[filter] ?? "it has no such field"}.`,
        ]
      : [],
  );
}

/** Selected drivers with no measured cost in the range, for "No measured cost for …". */
export function driversWithoutCost(
  drivers: ReadonlySet<string>,
  kindsWithCost: Iterable<UsageProviderKind>,
): string[] {
  const measured = new Set([...kindsWithCost].map(driverOfUsageKind));
  return sortDrivers([...drivers].filter((driver) => !measured.has(driver)));
}
