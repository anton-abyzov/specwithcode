import {
  formatDateTimeShort,
  formatDayShort,
  formatTokens,
  formatUsd,
} from "@specweave-studio/shared/usageFormat";
import type { ForecastPace, UsageForecastResult } from "./usageForecast";

const HORIZON = 7;
function ScenarioValue({
  label,
  pace,
  format,
  reason,
}: {
  readonly label: string;
  readonly pace: ForecastPace | null;
  readonly format: (value: number) => string;
  readonly reason?: string | null;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold tracking-tight text-foreground tabular-nums">
        {pace ? `~ ${format(pace.mean * HORIZON)}` : "Unavailable"}
      </span>
      <span className="text-xs text-muted-foreground tabular-nums">
        {pace ? `${format(pace.mean)} / day observed` : reason}
      </span>
      {pace ? (
        <span className="text-2xs text-muted-foreground tabular-nums">
          Scenario range {format(pace.low * HORIZON)} to {format(pace.high * HORIZON)}
        </span>
      ) : null}
    </div>
  );
}
function ForecastGraphic({
  result,
  metric,
}: {
  readonly result: Extract<UsageForecastResult, { kind: "available" }>;
  readonly metric: "cost" | "tokens";
}) {
  const monetary = metric === "cost" && result.dailyCost !== null;
  const pace = monetary ? result.dailyCost! : result.dailyTokens;
  const values = result.days.map((day) => (monetary ? day.costUsd : day.tokens));
  const max = Math.max(...values, pace.high, 1);
  const width = 440,
    height = 94,
    top = 8,
    floor = 84;
  const step = width / (values.length + HORIZON);
  const y = (value: number) => floor - (value / max) * (floor - top);
  const line = values.map((value, index) => `${index * step},${y(value)}`).join(" ");
  const futureX = (values.length + 1) * step;
  return (
    <figure className="min-w-0">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-24 w-full"
        role="img"
        aria-label={`${monetary ? "API-equivalent cost" : "Token"} outlook: exact measured days followed by a dashed constant daily mean. Shaded future band spans the quietest to busiest observed daily pace.`}
      >
        <line
          x1="0"
          x2={width}
          y1={floor}
          y2={floor}
          stroke="currentColor"
          className="text-border"
        />
        <line
          x1={futureX - step / 2}
          x2={futureX - step / 2}
          y1="0"
          y2={height}
          stroke="currentColor"
          className="text-border"
          strokeDasharray="2 4"
        />
        <rect
          x={futureX}
          y={y(pace.high)}
          width={width - futureX}
          height={Math.max(1, y(pace.low) - y(pace.high))}
          fill="currentColor"
          opacity="0.07"
        />
        <polyline
          points={line}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
        {values.map((value, index) => (
          <circle
            key={result.days[index]!.day}
            cx={index * step}
            cy={y(value)}
            r="2"
            fill="currentColor"
          />
        ))}
        <line
          x1={futureX}
          x2={width}
          y1={y(pace.mean)}
          y2={y(pace.mean)}
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray="5 4"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <figcaption className="flex justify-between gap-4 text-2xs text-muted-foreground">
        <span>Measured {monetary ? "API-equivalent cost" : "tokens"}</span>
        <span>Projected daily pace</span>
      </figcaption>
    </figure>
  );
}
export function UsageOutlook({
  result,
  metric,
  timeZone,
}: {
  readonly result: UsageForecastResult;
  readonly metric: "cost" | "tokens";
  readonly timeZone: string;
}) {
  return (
    <section
      aria-labelledby="usage-outlook-title"
      className="rounded-xl border border-dashed border-border bg-muted/15 p-4 sm:p-5"
      data-testid="usage-forecast"
    >
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2
          id="usage-outlook-title"
          className="flex items-center gap-2 text-sm font-medium text-foreground"
        >
          Next 7 days{" "}
          <span className="rounded border border-border px-1.5 py-0.5 text-2xs font-normal text-muted-foreground">
            Forecast
          </span>
        </h2>
        {result.kind === "available" ? (
          <span className="text-xs text-muted-foreground">
            {formatDayShort(result.forecastSince)} to {formatDayShort(result.forecastUntil)}
          </span>
        ) : null}
      </div>
      {result.kind === "unavailable" ? (
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-foreground">Forecast unavailable</p>
          <p className="text-xs text-muted-foreground">{result.reason}</p>
        </div>
      ) : (
        <>
          <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2 xl:grid-cols-[1fr_1fr_1.4fr]">
            <ScenarioValue
              label="API-equivalent value"
              pace={result.dailyCost}
              format={formatUsd}
              reason={result.costUnavailableReason}
            />
            <ScenarioValue
              label="Processed tokens"
              pace={result.dailyTokens}
              format={formatTokens}
            />
            <div className="sm:col-span-2 xl:col-span-1">
              <ForecastGraphic result={result} metric={metric} />
            </div>
          </div>
          <p className="mt-4 text-2xs leading-relaxed text-muted-foreground">
            Based on {result.days.length} completed days, {formatDayShort(result.days[0]!.day)} to{" "}
            {formatDayShort(result.days.at(-1)!.day)}, including {result.activeDays} active days.
            Oldest source read: {result.readAgeMinutes} min ago (
            {formatDateTimeShort(result.readAt, timeZone)}).
          </p>
        </>
      )}
      <p className="mt-3 text-2xs text-muted-foreground">
        Assumes similar recorded activity, model mix and configured rates. This is a usage scenario,
        not billed spend or plan quota.
      </p>
      <details className="mt-3 text-2xs text-muted-foreground">
        <summary className="w-fit cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-ring">
          Method and limits
        </summary>
        <p className="mt-2 max-w-prose leading-relaxed">
          Daily mean × 7, starting tomorrow. Uses up to seven completed calendar days; today is
          excluded. Needs at least five covered days and three active days, complete sources, and a
          source read within one hour. Quiet days count as zero recorded usage.
        </p>
        <p className="mt-1 max-w-prose leading-relaxed">
          The range assumes every future day matches the quietest or busiest observed day. It is a
          scenario range, not a confidence interval. Assumes similar recorded activity, model mix
          and configured rates. Untracked providers are excluded. This predicts neither invoice
          charges nor subscription exhaustion.
        </p>
      </details>
    </section>
  );
}
