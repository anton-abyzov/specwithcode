import type { EnvironmentId, ServerProvider, UsageProviderKind } from "@specweave-studio/contracts";
import { MACHINE_USAGE_MAX_AGE_MS } from "@specweave-studio/shared/machineFallback";
import { billingOf } from "@specweave-studio/shared/taskRouting";
import { isLiveWindow, windowModelScope } from "@specweave-studio/shared/usageWindows";

import { PROVIDER_ORDER, PROVIDER_PRESENTATION } from "./usageProviders";

/**
 * How a provider's turns are paid for right now, from its current sign-ins.
 * Transcripts do not record the sign-in, so this describes today, not history.
 */
export type UsageBillingMode = "plan" | "perToken" | "local" | "mixed" | "unknown";

/** What is left of a plan provider's quota, from the tightest live window. */
export type UsageAllowance =
  | {
      readonly kind: "left";
      readonly leftPercent: number;
      readonly windowLabel: string;
      readonly resetsAt: string | undefined;
      readonly accounts: number;
    }
  | { readonly kind: "stale"; readonly checkedAt: string }
  | { readonly kind: "notReported" };

export interface ProviderBilling {
  readonly provider: UsageProviderKind;
  readonly mode: UsageBillingMode;
  /** A current sign-in explicitly reports per-token billing. Mixed alone is insufficient. */
  readonly hasApiBilling: boolean;
  /** Present only when at least one sign-in runs on a plan. */
  readonly allowance: UsageAllowance | null;
}

export interface UsageBillingPicture {
  readonly byProvider: ReadonlyMap<UsageProviderKind, ProviderBilling>;
  /** Connected providers that keep no usage history SpecWithCode can read. */
  readonly untracked: readonly string[];
}

export type UsageBillingPresentations = ReadonlyMap<
  EnvironmentId,
  {
    readonly connection?: { readonly phase: string } | undefined;
    readonly serverConfig: { readonly providers?: readonly ServerProvider[] | undefined } | null;
  }
>;

const DRIVER_BY_PROVIDER = Object.fromEntries(
  PROVIDER_ORDER.map((provider) => [provider, String(PROVIDER_PRESENTATION[provider].driverKind)]),
) as Record<UsageProviderKind, string>;

const PROVIDER_BY_DRIVER = new Map(
  PROVIDER_ORDER.map((provider) => [DRIVER_BY_PROVIDER[provider], provider] as const),
);

export const USAGE_ALLOWANCE_FRESH_MS = MACHINE_USAGE_MAX_AGE_MS;

function modeOf(provider: ServerProvider): Exclude<UsageBillingMode, "mixed"> {
  switch (billingOf(provider)) {
    case "subscription":
      return "plan";
    case "api":
    case "paid-router":
      return "perToken";
    case "local":
      return "local";
    default:
      return "unknown";
  }
}

/** A sign-in that can run turns: enabled, installed and not signed out. */
function isActive(provider: ServerProvider): boolean {
  return provider.enabled && provider.installed && provider.auth.status !== "unauthenticated";
}

interface PlanRead {
  readonly leftPercent: number;
  readonly windowLabel: string;
  readonly resetsAt: string | undefined;
}

/** The account-wide live window with the least left, or null when none reports. */
function tightestWindow(provider: ServerProvider, nowMs: number): PlanRead | null {
  let tightest: PlanRead | null = null;
  for (const window of provider.usageLimits?.windows ?? []) {
    if (windowModelScope(window) !== null || !isLiveWindow(window, nowMs)) continue;
    const leftPercent = Math.round(100 - Math.max(0, Math.min(100, window.usedPercent)));
    if (tightest === null || leftPercent < tightest.leftPercent) {
      tightest = { leftPercent, windowLabel: window.label, resetsAt: window.resetsAt };
    }
  }
  return tightest;
}

function allowanceOf(
  plans: readonly { provider: ServerProvider; connected: boolean }[],
  nowMs: number,
): UsageAllowance {
  let tightest: PlanRead | null = null;
  let accounts = 0;
  let staleAt: string | null = null;
  for (const { provider, connected } of plans) {
    const limits = provider.usageLimits;
    if (limits === undefined) continue;
    const checked = Date.parse(limits.checkedAt);
    const fresh =
      connected &&
      Number.isFinite(checked) &&
      checked <= nowMs &&
      nowMs - checked <= USAGE_ALLOWANCE_FRESH_MS;
    const read = tightestWindow(provider, nowMs);
    if (read === null) continue;
    if (!fresh) {
      if (staleAt === null || limits.checkedAt > staleAt) staleAt = limits.checkedAt;
      continue;
    }
    accounts += 1;
    if (tightest === null || read.leftPercent < tightest.leftPercent) tightest = read;
  }
  if (tightest !== null) return { kind: "left", ...tightest, accounts };
  if (staleAt !== null) return { kind: "stale", checkedAt: staleAt };
  return { kind: "notReported" };
}

/**
 * Billing mode, plan allowance and untracked providers across the selected
 * environments. Unknown sign-ins stay unknown; nothing is assumed free.
 */
export function usageBillingPicture(
  presentations: UsageBillingPresentations,
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null,
  nowMs: number,
): UsageBillingPicture {
  const modes = new Map<UsageProviderKind, Set<Exclude<UsageBillingMode, "mixed">>>();
  const plans = new Map<UsageProviderKind, { provider: ServerProvider; connected: boolean }[]>();
  const untracked = new Set<string>();

  for (const [environmentId, presentation] of presentations) {
    if (selectedEnvironmentIds !== null && !selectedEnvironmentIds.has(environmentId)) continue;
    const connected = (presentation.connection?.phase ?? "connected") === "connected";
    for (const provider of presentation.serverConfig?.providers ?? []) {
      if (!isActive(provider)) continue;
      const kind = PROVIDER_BY_DRIVER.get(String(provider.driver));
      if (kind === undefined) {
        if (connected) untracked.add(provider.displayName?.trim() || String(provider.instanceId));
        continue;
      }
      const mode = modeOf(provider);
      const set = modes.get(kind) ?? new Set();
      set.add(mode);
      modes.set(kind, set);
      if (mode === "plan") {
        const list = plans.get(kind) ?? [];
        list.push({ provider, connected });
        plans.set(kind, list);
      }
    }
  }

  const byProvider = new Map<UsageProviderKind, ProviderBilling>();
  for (const kind of PROVIDER_ORDER) {
    const set = modes.get(kind);
    if (set === undefined) continue;
    const mode: UsageBillingMode = set.size === 1 ? [...set][0]! : "mixed";
    const planReads = plans.get(kind);
    byProvider.set(kind, {
      provider: kind,
      mode,
      hasApiBilling: set.has("perToken"),
      allowance: planReads === undefined ? null : allowanceOf(planReads, nowMs),
    });
  }
  return { byProvider, untracked: [...untracked].toSorted((a, b) => a.localeCompare(b)) };
}

export const BILLING_MODE_LABEL: Record<UsageBillingMode, string> = {
  plan: "Plan",
  perToken: "Per token",
  local: "Local",
  mixed: "Mixed",
  unknown: "Unknown",
};

export const BILLING_MODE_DESCRIPTION: Record<UsageBillingMode, string> = {
  plan: "Signed in to a subscription plan: turns use plan allowance, not per-token charges.",
  perToken: "Signed in with API billing: each turn is charged per token.",
  local: "Runs on this machine's own models.",
  mixed:
    "Billing differs across current sign-ins; see the separate reported billing and allowance.",
  unknown: "The sign-in does not say how it is billed.",
};
