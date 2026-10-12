import type { LimitPool, LimitPoolWindow } from "@specweave-studio/shared/usageLimits";

export type UsageTone = "ok" | "warn" | "full";

export interface UsageIndicatorWindow {
  readonly id: string;
  readonly kind: LimitPoolWindow["kind"];
  readonly label: string;
  readonly usedPercent: number;
  /** The first reset still ahead across the accounts pooled into this window. */
  readonly nextResetAt: number | null;
}

/** One provider as the indicator shows it: every account of that provider pooled. */
export interface UsageIndicatorProvider {
  readonly driver: LimitPool["driver"];
  readonly accountCount: number;
  readonly windows: readonly UsageIndicatorWindow[];
  /** The fullest pooled window: the number that decides whether work stops. */
  readonly peak: UsageIndicatorWindow | null;
  readonly bankedResets: number;
  readonly tone: UsageTone;
}

export function usageTone(usedPercent: number): UsageTone {
  return usedPercent >= 95 ? "full" : usedPercent >= 80 ? "warn" : "ok";
}

/**
 * Providers in the order the Limits page lists them. A window whose every
 * reset has already passed is stale, not full, so it never becomes the peak.
 */
export function usageIndicatorProviders(
  pools: readonly LimitPool[],
  now: number,
): readonly UsageIndicatorProvider[] {
  return pools.flatMap((pool) => {
    const windows = pool.windows.map((window): UsageIndicatorWindow & { stale: boolean } => {
      const ahead = window.resets.find((reset) => reset.at > now);
      return {
        id: window.id,
        kind: window.kind,
        label: window.label,
        usedPercent: window.usedPercent,
        nextResetAt: ahead?.at ?? null,
        stale: window.resets.length > 0 && ahead === undefined,
      };
    });
    if (windows.length === 0) return [];
    let peak: (typeof windows)[number] | null = null;
    for (const window of windows) {
      if (window.stale) continue;
      if (peak === null || window.usedPercent > peak.usedPercent) peak = window;
    }
    const bankedResets = pool.accounts.reduce(
      (sum, account) => sum + (account.limits.resetCredits?.availableCount ?? 0),
      0,
    );
    return [
      {
        driver: pool.driver,
        accountCount: pool.accounts.length,
        windows: windows.map(({ stale: _stale, ...window }) => window),
        peak: peak ? { ...peak } : null,
        bankedResets,
        tone: usageTone(peak?.usedPercent ?? 0),
      },
    ];
  });
}

/** `Claude 42%, Codex 10%`: the chip's accessible name and its tooltip. */
export function usageIndicatorSummary(
  providers: readonly UsageIndicatorProvider[],
  label: (driver: UsageIndicatorProvider["driver"]) => string,
): string {
  return providers
    .map((provider) =>
      provider.peak
        ? `${label(provider.driver)} ${provider.peak.usedPercent}% used`
        : `${label(provider.driver)} usage unknown`,
    )
    .join(", ");
}
