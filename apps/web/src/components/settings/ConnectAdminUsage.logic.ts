import type {
  RelayAdminUsageResponse,
  RelayAdminUsageWeek,
  RelayAdminUsageWindows,
} from "@specweave-studio/contracts/relayAdmin";

import type { TranslatePhrase } from "~/i18n";

/** A whole number in the reader's language. */
export function formatCount(value: number, locale: string | undefined): string {
  return new Intl.NumberFormat(locale).format(value);
}

export interface UsageRow {
  readonly id: string;
  readonly label: string;
  readonly windows: RelayAdminUsageWindows;
}

/**
 * The rows of the usage table: people from Clerk first, when Clerk was read,
 * then what SpecWithCode Connect itself recorded.
 */
export function usageRows(
  tx: TranslatePhrase,
  usage: RelayAdminUsageResponse,
): ReadonlyArray<UsageRow> {
  const people: ReadonlyArray<UsageRow> =
    usage.signUps === null
      ? []
      : [
          { id: "sign-ups", label: tx("New sign-ups"), windows: usage.signUps.created },
          { id: "active", label: tx("People active"), windows: usage.signUps.active },
        ];
  return [
    ...people,
    {
      id: "connect-new",
      label: tx("New accounts on Connect"),
      windows: usage.connect.created,
    },
    {
      id: "connect-seen",
      label: tx("Accounts seen by Connect"),
      windows: usage.connect.active,
    },
    { id: "machines", label: tx("Machines linked"), windows: usage.connect.machinesLinked },
  ];
}

export interface WeekBar {
  readonly weekStart: string;
  readonly count: number;
  /** Height of the bar in percent of the tallest week; a week with any count stays visible. */
  readonly height: number;
  /** The week's Monday, as a short date. */
  readonly date: string;
}

/** The Monday a week starts on, as a short date in UTC, the zone the weeks are cut in. */
export function weekDate(weekStart: string, locale: string | undefined): string {
  const date = new Date(weekStart);
  if (Number.isNaN(date.getTime())) return weekStart;
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

export function weekBars(
  weeks: ReadonlyArray<RelayAdminUsageWeek>,
  locale: string | undefined,
): ReadonlyArray<WeekBar> {
  const tallest = Math.max(0, ...weeks.map((week) => week.count));
  return weeks.map((week) => ({
    weekStart: week.weekStart,
    count: week.count,
    height: week.count <= 0 || tallest <= 0 ? 0 : Math.max(6, (week.count / tallest) * 100),
    date: weekDate(week.weekStart, locale),
  }));
}
