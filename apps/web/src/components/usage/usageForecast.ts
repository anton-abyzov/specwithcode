import {
  USAGE_CONTRACT_VERSION,
  type UsageProviderKind,
  type UsageSummaryInput,
} from "@specweave-studio/contracts";
import { enumerateDays } from "@specweave-studio/shared/usageFormat";
import type { MergedUsage } from "@specweave-studio/shared/usageMerge";
import type { EnvironmentUsageStatus } from "../../state/usage";

export const FORECAST_FRESH_MS = 60 * 60_000;
export interface ForecastPace {
  readonly mean: number;
  readonly low: number;
  readonly high: number;
}
export interface ForecastDay {
  readonly day: string;
  readonly tokens: number;
  readonly costUsd: number;
}
export type UsageForecastResult =
  | { readonly kind: "unavailable"; readonly reason: string }
  | {
      readonly kind: "available";
      readonly days: readonly ForecastDay[];
      readonly dailyTokens: ForecastPace;
      readonly dailyCost: ForecastPace | null;
      readonly costUnavailableReason: string | null;
      readonly readAt: string;
      readonly readAgeMinutes: number;
      readonly forecastSince: string;
      readonly forecastUntil: string;
      readonly activeDays: number;
    };

function addDays(day: string, amount: number) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}
function todayIn(timeZone: string, nowMs: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(nowMs);
  const part = (type: string) => parts.find((entry) => entry.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
const pace = (values: readonly number[]): ForecastPace => ({
  mean: values.reduce((sum, value) => sum + value, 0) / values.length,
  low: Math.min(...values),
  high: Math.max(...values),
});

/** A constant-pace scenario from completed, freshly scanned local history. Not a bill or quota prediction. */
export function forecastUsage({
  usage,
  environments,
  window,
  providers,
  nowMs,
  partial,
  pinned,
}: {
  readonly usage: MergedUsage;
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly window: UsageSummaryInput;
  readonly providers: ReadonlySet<UsageProviderKind>;
  readonly nowMs: number;
  readonly partial: boolean;
  readonly pinned: boolean;
}): UsageForecastResult {
  const unavailable = (reason: string): UsageForecastResult => ({ kind: "unavailable", reason });
  if (pinned) return unavailable("Clear the pinned period to forecast from daily history.");
  if (window.sinceTime !== undefined || window.untilTime !== undefined)
    return unavailable("Choose 7, 30 or 90 days to use completed daily history.");
  if (partial || usage.contractMismatches.length > 0 || environments.length === 0)
    return unavailable("Wait for complete usage history from the selected machines.");
  const relevantProviders =
    providers.size > 0
      ? providers
      : new Set(
          usage.providers.filter((entry) => entry.records > 0).map((entry) => entry.provider),
        );
  const reads: number[] = [];
  let ratesFresh = true;
  let hasSources = false;
  for (const environment of environments) {
    const summary = environment.summary;
    if (
      environment.error ||
      environment.isPending ||
      !environment.canReadDiagnostics ||
      summary === null ||
      summary.contractVersion !== USAGE_CONTRACT_VERSION
    )
      return unavailable("Some selected machines cannot report complete usage history.");
    // A "missing" source is a configured directory that does not exist: it has
    // no history to lose, and the merge skips it too.
    const sources = summary.sources.filter(
      (source) => source.status !== "missing" && relevantProviders.has(source.fingerprint.provider),
    );
    if (sources.some((source) => source.status !== "ok"))
      return unavailable("A selected provider's history is missing or incomplete.");
    if (sources.length > 0) hasSources = true;
    ratesFresh &&= summary.pricing.status === "fresh";
    const read = Date.parse(summary.readAt);
    if (!Number.isFinite(read) || read > nowMs + 60_000 || nowMs - read > FORECAST_FRESH_MS)
      return unavailable("Usage history is stale. Refresh it before forecasting.");
    reads.push(read);
  }
  if (!hasSources) return unavailable("A selected provider's history is missing or incomplete.");
  let today: string;
  try {
    today = todayIn(window.timeZone, nowMs);
  } catch {
    return unavailable("The history time zone is unavailable.");
  }
  const yesterday = addDays(today, -1);
  if (window.untilDay < yesterday)
    return unavailable("The selected history does not include the last completed day.");
  const since = window.sinceDay > addDays(today, -7) ? window.sinceDay : addDays(today, -7);
  const completeDays = enumerateDays(since, yesterday);
  if (completeDays.length < 5)
    return unavailable("At least five completed days of daily history are needed.");
  const byDay = new Map(usage.daily.map((entry) => [entry.day, entry]));
  const days = completeDays.map((day) => ({
    day,
    tokens: byDay.get(day)?.totalTokens ?? 0,
    costUsd: byDay.get(day)?.costUsd ?? 0,
  }));
  const activeDays = completeDays.filter((day) => (byDay.get(day)?.records ?? 0) > 0).length;
  if (activeDays < 3)
    return unavailable("At least three active days are needed for a useful projection.");
  const invalidCosts = days.some((day) => !Number.isFinite(day.costUsd) || day.costUsd < 0);
  const unpriced = completeDays.some((day) => (byDay.get(day)?.unpricedRecords ?? 0) > 0);
  return {
    kind: "available",
    days,
    activeDays,
    dailyTokens: pace(days.map((day) => day.tokens)),
    dailyCost:
      unpriced || !ratesFresh || invalidCosts ? null : pace(days.map((day) => day.costUsd)),
    costUnavailableReason: unpriced
      ? "Some observed usage is unpriced."
      : !ratesFresh
        ? "Current rates are stale or unavailable."
        : invalidCosts
          ? "Observed costs include invalid values or adjustments."
          : null,
    readAt: new Date(Math.min(...reads)).toISOString(),
    readAgeMinutes: Math.max(0, Math.floor((nowMs - Math.min(...reads)) / 60_000)),
    forecastSince: addDays(today, 1),
    forecastUntil: addDays(today, 7),
  };
}
