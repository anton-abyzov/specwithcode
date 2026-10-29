import {
  type LimitHistoryIndex,
  type PoolForecast,
  type PoolForecastPoint,
  forecastPool,
  formatBurnPerHour,
} from "@specweave-studio/shared/usageLimitForecast";
import { type LimitPoolWindow, formatDuration } from "@specweave-studio/shared/usageLimits";
import { type ReactNode, useMemo } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { limitAccountLabel } from "./usageAccountLabel";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const CHART_WIDTH = 1000;
const CHART_HEIGHT = 160;

function Stat({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-2xs text-muted-foreground">{label}</span>
      <span className="text-xs font-medium [overflow-wrap:anywhere] text-foreground tabular-nums">
        {children}
      </span>
    </div>
  );
}

/** "the next 10 days", "the next 12 hours". */
function horizonText(forecast: PoolForecast, now: number): string {
  const span = forecast.horizonEnd - now;
  return span >= 2 * DAY
    ? `the next ${Math.round(span / DAY)} days`
    : `the next ${Math.round(span / HOUR)} hours`;
}

function percent(value: number): string {
  return `${Math.round(value)}%`;
}

/** The pool in whole accounts: 142 points of a 200-point pool is "1.4". */
function accounts(value: number): string {
  const worth = Math.max(0, value) / 100;
  return Number.isInteger(worth) ? String(worth) : worth.toFixed(1);
}

/** The y-axis top: "2 accounts" for a pool, "100%" for one account. */
function capacityLabel(capacity: number): string {
  return capacity > 100 ? `${accounts(capacity)} accounts` : percent(capacity);
}

function toPath(
  points: readonly PoolForecastPoint[],
  x: (at: number) => number,
  y: (value: number) => number,
): string {
  return points
    .map(
      (point, index) =>
        `${index === 0 ? "M" : "L"}${x(point.at).toFixed(1)},${y(point.remaining).toFixed(1)}`,
    )
    .join(" ");
}

/** Local midnights across the span, thinned to at most eight; hours for spans under two days. */
function ticks(start: number, end: number): Array<{ readonly at: number; readonly label: string }> {
  const span = end - start;
  if (span <= 0) return [];
  if (span >= 2 * DAY) {
    // Step by calendar day, not 24h, so ticks stay on midnight across a DST change.
    const day = new Date(start);
    day.setHours(24, 0, 0, 0);
    const days: number[] = [];
    for (; day.getTime() < end; day.setDate(day.getDate() + 1), day.setHours(0, 0, 0, 0)) {
      days.push(day.getTime());
    }
    const every = Math.ceil(days.length / 8);
    const format = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric" });
    return days
      .filter((_, index) => index % every === 0)
      .map((at) => ({ at, label: format.format(at) }));
  }
  const stepHours = Math.max(1, Math.ceil(span / HOUR / 6));
  const first = new Date(start);
  first.setMinutes(0, 0, 0);
  first.setHours(first.getHours() + 1);
  const format = new Intl.DateTimeFormat(undefined, { hour: "numeric" });
  const hours: Array<{ at: number; label: string }> = [];
  for (let at = first.getTime(); at < end; at += stepHours * HOUR) {
    hours.push({ at, label: format.format(at) });
  }
  return hours;
}

/**
 * The pool's total left over time: recorded reads to the left of now, the
 * projection at the current burn to the right, dashed. The y axis runs from
 * empty to every account full.
 */
function PoolChart({
  forecast,
  color,
  now,
}: {
  readonly forecast: PoolForecast;
  readonly color: string;
  readonly now: number;
}) {
  const start = forecast.recorded[0]?.at ?? now;
  const end = forecast.projected.length > 0 ? forecast.horizonEnd : now;
  if (end <= start) return null;
  const x = (at: number) => ((at - start) / (end - start)) * CHART_WIDTH;
  const y = (value: number) =>
    CHART_HEIGHT -
    (Math.max(0, Math.min(forecast.capacity, value)) / forecast.capacity) * CHART_HEIGHT;
  const recordedPath = toPath(forecast.recorded, x, y);
  const projectedPath = toPath(forecast.projected, x, y);
  const nowX = x(now);
  const summary = [
    forecast.capacity > 100
      ? `Pool left over time, now ${accounts(forecast.remaining)} of ${accounts(forecast.capacity)} accounts.`
      : `Left over time, now ${percent(forecast.remaining)}.`,
    forecast.poolEmptyAt ? "The projection reaches empty." : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <figure className="flex min-w-0 flex-col gap-1" data-pool-forecast-chart="">
      <div className="relative ps-16">
        <span className="absolute top-0 left-0 text-2xs text-muted-foreground tabular-nums">
          {capacityLabel(forecast.capacity)}
        </span>
        <span className="absolute bottom-0 left-0 text-2xs text-muted-foreground tabular-nums">
          0%
        </span>
        <svg
          role="img"
          aria-label={summary}
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          preserveAspectRatio="none"
          className="h-28 w-full overflow-visible rounded-sm bg-muted/40 @2xl/pool:h-36"
        >
          <line
            x1={0}
            x2={CHART_WIDTH}
            y1={CHART_HEIGHT / 2}
            y2={CHART_HEIGHT / 2}
            stroke="currentColor"
            className="text-border"
            vectorEffect="non-scaling-stroke"
          />
          {forecast.recorded.length > 1 ? (
            <>
              <path
                d={`${recordedPath} L${x(now).toFixed(1)},${CHART_HEIGHT} L${x(start).toFixed(1)},${CHART_HEIGHT} Z`}
                fill={color}
                opacity={0.12}
              />
              <path
                d={recordedPath}
                fill="none"
                stroke={color}
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
                data-series="recorded"
              />
            </>
          ) : null}
          {forecast.projected.length > 1 ? (
            <path
              d={projectedPath}
              fill="none"
              stroke={color}
              strokeWidth={2}
              strokeDasharray="5 4"
              opacity={0.8}
              vectorEffect="non-scaling-stroke"
              data-series="projected"
            />
          ) : null}
          <line
            x1={nowX}
            x2={nowX}
            y1={0}
            y2={CHART_HEIGHT}
            stroke="currentColor"
            className="text-muted-foreground"
            strokeDasharray="2 3"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>
      <div aria-hidden className="relative ms-16 h-4">
        {ticks(start, end)
          // Labels are centred on their tick: keep them off the chart's edges.
          .filter((tick) => {
            const share = x(tick.at) / CHART_WIDTH;
            return share > 0.03 && share < 0.95;
          })
          .map((tick) => (
            <span
              key={tick.at}
              className="absolute -translate-x-1/2 text-2xs whitespace-nowrap text-muted-foreground"
              style={{ left: `${(x(tick.at) / CHART_WIDTH) * 100}%` }}
            >
              {tick.label}
            </span>
          ))}
      </div>
      <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-muted-foreground">
        {forecast.recorded.length > 1 ? (
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="h-0.5 w-4 rounded" style={{ backgroundColor: color }} />
            Recorded
          </span>
        ) : null}
        {forecast.projected.length > 1 ? (
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="h-0 w-4 border-t-2 border-dashed"
              style={{ borderColor: color }}
            />
            Projected at the current burn
          </span>
        ) : null}
      </figcaption>
    </figure>
  );
}

/**
 * What the pool holds, how fast it is going, and when it runs out: the total
 * left across accounts, burn over the last three hours, the first account to
 * run dry, the whole pool running dry, the next reset, and a chart of the
 * same. Estimates need history; until there is enough they say so.
 */
export function PoolForecastPanel({
  pool,
  history,
  color,
  now,
}: {
  readonly pool: LimitPoolWindow;
  /** Null while the first read of recorded history is in flight. */
  readonly history: LimitHistoryIndex | null;
  readonly color: string;
  readonly now: number;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const forecast = useMemo(
    () => forecastPool(pool, history ?? new Map(), now),
    [pool, history, now],
  );
  const when = (at: number) =>
    formatUpcomingTimestamp(new Date(at).toISOString(), timestampFormat, now);
  const measured = forecast.burnPerHour !== null;
  const within = horizonText(forecast, now);
  return (
    <div className="flex min-w-0 flex-col gap-3 md:col-span-2" data-pool-forecast="">
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3 lg:grid-cols-5">
        {pool.members.length > 1 ? (
          <Stat label="Pool left">
            {accounts(forecast.remaining)}{" "}
            <span className="font-normal text-muted-foreground">
              of {accounts(forecast.capacity)} accounts
            </span>
          </Stat>
        ) : null}
        <Stat label="Burn, last 3h">
          {measured
            ? formatBurnPerHour(forecast.burnPerHour!)
            : history === null
              ? "…"
              : "Measuring"}
        </Stat>
        <Stat label="First empty">
          {!measured
            ? "—"
            : forecast.firstEmpty
              ? `${limitAccountLabel(forecast.firstEmpty.account).primary} in ${formatDuration(forecast.firstEmpty.at - now)}`
              : `Not in ${within}`}
          {forecast.emptyNow > 0 ? (
            <span className="block font-normal text-muted-foreground">
              {forecast.emptyNow} empty now
            </span>
          ) : null}
        </Stat>
        {pool.members.length > 1 ? (
          <Stat label="Pool empty">
            {!measured
              ? "—"
              : forecast.poolEmptyAt !== null
                ? when(forecast.poolEmptyAt)
                : `Not in ${within}`}
          </Stat>
        ) : null}
        <Stat label="Next reset">
          {forecast.nextReset ? (
            <>
              +{forecast.nextReset.restores}%{" "}
              <span className="font-normal text-muted-foreground">
                {when(forecast.nextReset.at)}
              </span>
            </>
          ) : (
            "—"
          )}
        </Stat>
      </div>
      {forecast.recorded.length > 1 || forecast.projected.length > 1 ? (
        <PoolChart forecast={forecast} color={color} now={now} />
      ) : null}
      {!measured && history !== null ? (
        <p className="text-xs text-muted-foreground">
          Collecting history. Burn and run-out estimates appear after about 20 minutes of use.
        </p>
      ) : null}
    </div>
  );
}
