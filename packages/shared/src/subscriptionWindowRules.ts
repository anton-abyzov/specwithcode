/**
 * Notes for a window a provider does not have: Copilot's single monthly
 * allowance, Cursor's and Grok's one weekly pool, a Codex Pro plan read with
 * no 5-hour window. A note fires on what the reading holds, never on a plan
 * name alone, and each carries the vendor page it rests on and the day that
 * page was read, in `subscriptionWindowRules.json`, so a scheduled check can
 * say when they need reading again.
 *
 * @module subscriptionWindowRules
 */
import data from "./subscriptionWindowRules.json" with { type: "json" };

export type SubscriptionNoteProvider = "copilot" | "cursor" | "grok" | "codex";

export interface SubscriptionWindowRule {
  readonly id: string;
  readonly provider: SubscriptionNoteProvider;
  readonly when: "anyWindow" | "weeklyWindow" | "renewalDate" | "proWeeklyWithoutSession";
  readonly note: string;
  /** The vendor page, or null when the rule rests on the reading itself. */
  readonly source: string | null;
  readonly quote: string;
  /** The day the source was read, `YYYY-MM-DD`. */
  readonly readOn: string;
}

export const SUBSCRIPTION_WINDOW_RULES: readonly SubscriptionWindowRule[] =
  data.rules as readonly SubscriptionWindowRule[];

/** The three Pro labels the app gives a ChatGPT plan (`codexPlanLabel`). */
const CODEX_PRO_PLANS: ReadonlySet<string> = new Set([
  "ChatGPT Pro 20x Subscription",
  "ChatGPT Pro 5x Subscription",
  "ChatGPT Pro Max Subscription",
]);

const WEEK_MS = 7 * 24 * 60 * 60_000;

export interface NoteWindow {
  readonly kind: "session" | "weekly" | "monthly" | "other";
  /** How long one period lasts; null when the provider does not say. */
  readonly durationMs: number | null;
}

/**
 * The note a reading earns, or null when no rule covers it. Only account
 * windows are passed: model-scoped windows and Cursor's "Overall" are not.
 */
export function subscriptionWindowNote(input: {
  readonly provider: SubscriptionNoteProvider | null;
  readonly plans: ReadonlyArray<string | null | undefined>;
  readonly windows: readonly NoteWindow[];
  readonly hasReportedRenewal: boolean;
}): SubscriptionWindowRule | null {
  if (input.provider === null) return null;
  const weekly = input.windows.some((window) => window.kind === "weekly");
  const matches = (rule: SubscriptionWindowRule): boolean => {
    switch (rule.when) {
      case "anyWindow":
        return input.windows.length > 0;
      case "weeklyWindow":
        return weekly;
      case "renewalDate":
        return input.hasReportedRenewal;
      case "proWeeklyWithoutSession":
        return (
          input.plans.some((plan) => plan !== null && plan !== undefined && CODEX_PRO_PLANS.has(plan.trim())) &&
          weekly &&
          input.windows.every(
            (window) =>
              window.kind !== "session" && (window.durationMs === null || window.durationMs >= WEEK_MS),
          )
        );
    }
  };
  return (
    SUBSCRIPTION_WINDOW_RULES.find((rule) => rule.provider === input.provider && matches(rule)) ??
    null
  );
}
