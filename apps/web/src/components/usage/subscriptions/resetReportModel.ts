/**
 * The used-against-lost report: for each account, what each weekly or monthly
 * reset found used and what it left unused, week over week. Percent of one
 * window is the unit, because that is what providers report. A token figure
 * is an estimate, shown only where the spend behind the percent can be
 * measured.
 */
import type { UsageResetPeriod } from "@specweave-studio/contracts";
import { lossIsUpperBound } from "@specweave-studio/shared/usageResetLedger";

const DAY = 24 * 60 * 60_000;
/** Below this much used, tokens per percent is too noisy to scale up. */
const MIN_USED_FOR_ESTIMATE = 5;

/**
 * Tokens the unused share of one reset would have bought: tokens per percent
 * used, times the percent lost. Null when the spend behind the percent is not
 * measurable; spend after a long-ago last read is unknown, so that is too.
 */
export function tokensLostAtReset(
  period: {
    readonly usedPercent: number;
    readonly lostPercent: number;
    readonly startedAt: number | null;
    readonly endedAt: number;
    readonly upperBound: boolean;
  },
  tokensSpent: (from: number, to: number) => number | null,
): number | null {
  if (period.lostPercent === 0) return 0;
  if (period.upperBound || period.startedAt === null || period.usedPercent < MIN_USED_FOR_ESTIMATE) {
    return null;
  }
  const spent = tokensSpent(period.startedAt, period.endedAt);
  return spent === null || spent <= 0 ? null : (spent / period.usedPercent) * period.lostPercent;
}

export interface ReportCell {
  readonly usedPercent: number;
  readonly lostPercent: number;
  /** Resets in the week: more than one when the provider reset limits early. */
  readonly resets: number;
  /**
   * The last read was long before a reset, so what was spent after it is
   * unknown: used is at least, and lost at most, what is shown.
   */
  readonly upperBound: boolean;
}

export interface ReportAccount {
  readonly accountKey: string;
  readonly driver: UsageResetPeriod["driver"];
  /** One cell per report week, oldest first; null for a week with no reset recorded. */
  readonly weeks: ReadonlyArray<ReportCell | null>;
  /** The newest week that has a reset. */
  readonly latest: ReportCell | null;
  /** Average loss per reset over the report, and how many resets it averages. */
  readonly averageLostPercent: number | null;
  readonly resets: number;
  /** Some reset in the average was read long before it happened. */
  readonly upperBound: boolean;
  /** Tokens the unused quota would have bought, or null when it cannot be measured. */
  readonly tokensLostEstimate: number | null;
}

export interface ResetReport {
  /** Local midnight of each week's Monday, oldest first. */
  readonly weekStarts: readonly number[];
  readonly accounts: readonly ReportAccount[];
  /** Summed over accounts, in percent of one account's window. */
  readonly lostThisWeek: number;
  readonly lostAllWeeks: number;
  /** The totals include a loss that is only an upper bound. */
  readonly lostThisWeekUpperBound: boolean;
  readonly lostAllWeeksUpperBound: boolean;
}

/** Local midnight of the Monday on or before `at`. */
export function weekStartOf(at: number): number {
  const date = new Date(at);
  const sinceMonday = (date.getDay() + 6) % 7;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - sinceMonday).getTime();
}

export interface ReportOptions {
  readonly weeks?: number;
  /**
   * Tokens this fleet spent on the account's provider between two times, or
   * null when that cannot be attributed to this one account (two accounts of
   * the provider, or no usage history for the span).
   */
  readonly tokensSpent?: (
    account: { readonly accountKey: string; readonly driver: UsageResetPeriod["driver"] },
    from: number,
    to: number,
  ) => number | null;
}

/**
 * Builds the report from closed periods. Each account is reported on its
 * account-wide window, the weekly one where it has both; a model family's
 * window is a slice of the same quota and would count the loss twice.
 */
export function resetReport(
  periods: readonly UsageResetPeriod[],
  now: number,
  options: ReportOptions = {},
): ResetReport {
  const weeks = options.weeks ?? 4;
  const thisWeek = weekStartOf(now);
  const weekStarts = Array.from({ length: weeks }, (_, index) =>
    weekStartOf(thisWeek - (weeks - 1 - index) * 7 * DAY + DAY / 2),
  );
  const byAccount = new Map<string, UsageResetPeriod[]>();
  for (const period of periods) {
    if (period.modelScope !== undefined) continue;
    const list = byAccount.get(period.accountKey) ?? [];
    list.push(period);
    byAccount.set(period.accountKey, list);
  }
  const accounts: ReportAccount[] = [];
  for (const [accountKey, all] of byAccount) {
    const kind = all.some((period) => period.windowKind === "weekly")
      ? "weekly"
      : (all[0]?.windowKind ?? "weekly");
    const own = all.filter((period) => period.windowKind === kind);
    const windowId = own.toSorted(
      (left, right) => Date.parse(right.endedAt) - Date.parse(left.endedAt),
    )[0]?.windowId;
    const reported = own.filter((period) => period.windowId === windowId);
    const cells: Array<ReportCell | null> = weekStarts.map(() => null);
    let lostSum = 0;
    let resets = 0;
    let anyUpperBound = false;
    let tokens: number | null = options.tokensSpent ? 0 : null;
    for (const period of reported) {
      const endedAt = Date.parse(period.endedAt);
      const index = weekStarts.indexOf(weekStartOf(endedAt));
      if (index === -1) continue;
      const cell = cells[index];
      const upperBound = lossIsUpperBound({
        endedAt,
        lastReadAt: Date.parse(period.lastReadAt),
      });
      anyUpperBound ||= upperBound;
      cells[index] = {
        usedPercent: (cell?.usedPercent ?? 0) + period.usedPercentAtReset,
        lostPercent: (cell?.lostPercent ?? 0) + period.lostPercent,
        resets: (cell?.resets ?? 0) + 1,
        upperBound: (cell?.upperBound ?? false) || upperBound,
      };
      lostSum += period.lostPercent;
      resets += 1;
      if (tokens === null) continue;
      const startedAt = period.startedAt === undefined ? null : Date.parse(period.startedAt);
      const lost = tokensLostAtReset(
        {
          usedPercent: period.usedPercentAtReset,
          lostPercent: period.lostPercent,
          startedAt: startedAt !== null && Number.isFinite(startedAt) ? startedAt : null,
          endedAt,
          upperBound,
        },
        (from, to) =>
          options.tokensSpent?.({ accountKey, driver: period.driver }, from, to) ?? null,
      );
      tokens = lost === null ? null : tokens + lost;
    }
    if (resets === 0) continue;
    accounts.push({
      accountKey,
      driver: reported[0]!.driver,
      weeks: cells,
      latest: cells.findLast((cell) => cell !== null) ?? null,
      averageLostPercent: lostSum / resets,
      resets,
      upperBound: anyUpperBound,
      tokensLostEstimate: tokens !== null && tokens > 0 ? Math.round(tokens) : null,
    });
  }
  accounts.sort(
    (left, right) =>
      (right.averageLostPercent ?? 0) - (left.averageLostPercent ?? 0) ||
      left.accountKey.localeCompare(right.accountKey),
  );
  const last = weekStarts.length - 1;
  return {
    weekStarts,
    accounts,
    lostThisWeek: accounts.reduce((sum, account) => sum + (account.weeks[last]?.lostPercent ?? 0), 0),
    lostThisWeekUpperBound: accounts.some((account) => account.weeks[last]?.upperBound === true),
    lostAllWeeksUpperBound: accounts.some((account) => account.upperBound),
    lostAllWeeks: accounts.reduce(
      (sum, account) =>
        sum + account.weeks.reduce((inner, cell) => inner + (cell?.lostPercent ?? 0), 0),
      0,
    ),
  };
}

/** The report as Markdown, for saving as a SpecWithCode report. */
export function resetReportMarkdown(
  report: ResetReport,
  labelOf: (accountKey: string) => string,
  formatWeek: (weekStart: number) => string,
  formatTokens: (tokens: number) => string,
): string {
  const header = ["Account", ...report.weekStarts.map(formatWeek), "Average lost", "Tokens lost (estimate)"];
  const rows = report.accounts.map((account) => [
    labelOf(account.accountKey),
    ...account.weeks.map((cell) =>
      cell === null
        ? "No reset recorded"
        : `${Math.round(cell.usedPercent)}% used, ${cell.upperBound ? "up to " : ""}${Math.round(cell.lostPercent)}% lost`,
    ),
    account.averageLostPercent === null
      ? "Not reported"
      : `${account.upperBound ? "up to " : ""}${Math.round(account.averageLostPercent)}% over ${account.resets} ${account.resets === 1 ? "reset" : "resets"}`,
    account.tokensLostEstimate === null
      ? "Not measurable"
      : `~${formatTokens(account.tokensLostEstimate)}`,
  ]);
  const line = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
  return [
    "# Subscription quota: used against lost",
    "",
    `Lost this week: ${report.lostThisWeekUpperBound ? "up to " : ""}${Math.round(report.lostThisWeek)}% of one window. Lost over ${report.weekStarts.length} weeks: ${report.lostAllWeeksUpperBound ? "up to " : ""}${Math.round(report.lostAllWeeks)}%.`,
    "",
    line(header),
    line(header.map(() => "---")),
    ...rows.map(line),
    "",
    "Percent is of one account's window at each reset. \"Up to\" marks a reset last read more than two hours before it. A token figure is an estimate from this fleet's own usage and appears only where one account of the provider was in use.",
    "",
  ].join("\n");
}
