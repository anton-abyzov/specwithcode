import { formatDuration } from "@specweave-studio/shared/usageLimits";
import type { LimitPool, LimitPoolWindow } from "@specweave-studio/shared/usageLimits";
import {
  blockingWindow,
  windowAppliesToModel,
  windowModelScope,
  windowTitle,
} from "@specweave-studio/shared/usageWindows";

export type UsageTone = "ok" | "warn" | "full";

export interface UsageIndicatorWindow {
  readonly id: string;
  readonly kind: LimitPoolWindow["kind"];
  readonly label: string;
  readonly usedPercent: number;
  /** The first reset still ahead across the accounts pooled into this window. */
  readonly nextResetAt: number | null;
  /** A spent window that caps this one, so what it shows left cannot be used. */
  readonly blockedBy?: { readonly label: string; readonly resetsAt: number | null };
}

/** One provider as the indicator shows it: every account of that provider pooled. */
export interface UsageIndicatorProvider {
  readonly driver: LimitPool["driver"];
  readonly accountCount: number;
  readonly windows: readonly UsageIndicatorWindow[];
  /**
   * The fullest pooled window that applies to the selected model: the number
   * that decides whether its next turn can run.
   */
  readonly peak: UsageIndicatorWindow | null;
  readonly bankedResets: number;
  readonly tone: UsageTone;
}

/** Quota left in a window, 0..100. Every usage surface shows what remains, as Codex does. */
export function leftPercent(usedPercent: number): number {
  return Math.round(100 - Math.max(0, Math.min(100, usedPercent)));
}

/**
 * The one tone rule for every usage surface, keyed off what is left. Room at
 * 20% left or less, 5% included, is amber. Red is only for a spent window, a
 * blocking read that every surface names with the word "Limit".
 */
export function usageTone(leftPercent: number): UsageTone {
  return leftPercent <= 0 ? "full" : leftPercent <= 20 ? "warn" : "ok";
}

/** The tone of a window by what it has used: red only at 100%, never for 99.6%. */
export function usageToneOfUsed(usedPercent: number): UsageTone {
  return usedPercent >= 100 ? "full" : usageTone(Math.max(1, leftPercent(usedPercent)));
}

/** Text colour for a share left: amber when low, red only once it is spent. */
export function usageToneTextClass(leftPercent: number): string {
  return usageToneClass(usageTone(leftPercent));
}

/** Text colour for a window by what it has used: red only at 100%, never for 99.6%. */
export function usageToneTextClassOfUsed(usedPercent: number): string {
  return usageToneClass(usageToneOfUsed(usedPercent));
}

function usageToneClass(tone: UsageTone): string {
  return tone === "full"
    ? "text-destructive-foreground"
    : tone === "warn"
      ? "text-warning-foreground"
      : "text-foreground";
}

/** `77% left`, or `Limit reached` once the window is spent. */
export function usageLeftLabel(usedPercent: number): string {
  return usedPercent >= 100 ? "Limit reached" : `${leftPercent(usedPercent)}% left`;
}

/** `Blocked by weekly limit · resets in 1d 15h`: a window capped by a spent one. */
export function blockedLabel(
  blocker: { readonly label: string; readonly resetsAt: number | null },
  now: number,
): string {
  const name = blocker.label.charAt(0).toLowerCase() + blocker.label.slice(1);
  return blocker.resetsAt === null || blocker.resetsAt <= now
    ? `Blocked by ${name} limit`
    : `Blocked by ${name} limit · resets in ${formatDuration(blocker.resetsAt - now)}`;
}

/**
 * Providers in the order the Limits page lists them. A window whose every
 * reset has already passed is stale, not full, so it never becomes the peak.
 */
export function usageIndicatorProviders(
  pools: readonly LimitPool[],
  now: number,
  model?: string | null,
): readonly UsageIndicatorProvider[] {
  return pools.flatMap((pool) => {
    const windows = pool.windows.map((window) => {
      const ahead = window.resets.find((reset) => reset.at > now);
      const scope =
        window.columns.find((column) => column.window?.modelScope)?.window?.modelScope ??
        windowModelScope(window);
      const mins = window.columns.find((column) => column.window?.windowDurationMins)?.window
        ?.windowDurationMins;
      return {
        id: window.id,
        kind: window.kind,
        label: windowTitle({
          id: window.id,
          label: window.label,
          windowDurationMins: mins,
          ...(scope ? { modelScope: scope } : {}),
        }),
        usedPercent: window.usedPercent,
        nextResetAt: ahead?.at ?? null,
        stale: window.resets.length > 0 && ahead === undefined,
        ...(scope ? { modelScope: scope } : {}),
        ...(ahead ? { resetsAt: new Date(ahead.at).toISOString() } : {}),
      };
    });
    if (windows.length === 0) return [];
    const live = windows.filter((window) => !window.stale);
    // With no model selected only the account-wide windows bind; a provider
    // that reports nothing else still shows its fullest window.
    const applying = live.filter((window) => windowAppliesToModel(window, model));
    const counted = applying.length > 0 || model ? applying : live;
    let peak: (typeof windows)[number] | null = null;
    for (const window of counted) {
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
        windows: windows.map((window): UsageIndicatorWindow => {
          const blocker = window.stale ? null : blockingWindow(window, live, now);
          return {
            id: window.id,
            kind: window.kind,
            label: window.label,
            usedPercent: window.usedPercent,
            nextResetAt: window.nextResetAt,
            ...(blocker
              ? { blockedBy: { label: blocker.label, resetsAt: blocker.nextResetAt } }
              : {}),
          };
        }),
        peak: peak
          ? {
              id: peak.id,
              kind: peak.kind,
              label: peak.label,
              usedPercent: peak.usedPercent,
              nextResetAt: peak.nextResetAt,
            }
          : null,
        bankedResets,
        tone: usageToneOfUsed(peak?.usedPercent ?? 0),
      },
    ];
  });
}

/** `Claude 58% left, Codex limit reached`: the chip's accessible name and its tooltip. */
export function usageIndicatorSummary(
  providers: readonly UsageIndicatorProvider[],
  label: (driver: UsageIndicatorProvider["driver"]) => string,
): string {
  return providers
    .map((provider) =>
      provider.peak
        ? `${label(provider.driver)} ${usageLeftLabel(provider.peak.usedPercent).toLowerCase()}`
        : `${label(provider.driver)} usage unknown`,
    )
    .join(", ");
}
