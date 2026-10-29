import { formatDayShort, formatTokens } from "@specweave-studio/shared/usageFormat";
import { useState } from "react";

import type { TrendDay } from "../../studio/projectUsageInsights";
import { niceScale } from "../usage/UsageProviderChart";

const SERIES = [
  { key: "threads", label: "SpecWithCode threads", color: "var(--usage-series-threads)" },
  { key: "cli", label: "CLI sessions", color: "var(--usage-series-cli)" },
] as const;

/**
 * Daily tokens as stacked columns, Studio threads under CLI sessions. Each
 * column is a button: hover or focus shows that day's split. Nothing renders
 * when the window holds no tokens.
 */
export function ProjectUsageTrend({ days }: { readonly days: readonly TrendDay[] }) {
  const [active, setActive] = useState<number | null>(null);
  const peak = days.reduce((max, day) => Math.max(max, day.threads + day.cli), 0);
  if (peak <= 0) return null;
  const { max, ticks } = niceScale(peak, 3);
  const totals = SERIES.map((series) => ({
    ...series,
    value: days.reduce((sum, day) => sum + day[series.key], 0),
  }));
  const shown = totals.filter((series) => series.value > 0);
  const focus = active === null ? null : days[active];
  const middle = Math.floor((days.length - 1) / 2);
  return (
    <figure className="project-usage-trend" aria-labelledby="project-usage-trend-title">
      <figcaption>
        <h3 id="project-usage-trend-title">Daily tokens, last {days.length} days</h3>
        {shown.length > 0 ? (
          <span className="project-usage-legend">
            {shown.map((series) => (
              <span key={series.key}>
                <i aria-hidden style={{ background: series.color }} />
                {series.label} <b>{formatTokens(series.value)}</b>
              </span>
            ))}
          </span>
        ) : null}
      </figcaption>
      <div className="project-usage-trend-plot" onMouseLeave={() => setActive(null)}>
        {ticks.map((tick) => (
          <span
            key={tick}
            aria-hidden
            className="project-usage-trend-grid"
            style={{ bottom: `${(tick / max) * 100}%` }}
          >
            <small>{tick === 0 ? "" : formatTokens(tick)}</small>
          </span>
        ))}
        <ul className="project-usage-trend-columns">
          {days.map((day, index) => {
            const total = day.threads + day.cli;
            return (
              <li key={day.day} className="project-usage-trend-day">
                <button
                  type="button"
                  className="project-usage-trend-column"
                  data-active={active === index || undefined}
                  aria-label={`${formatDayShort(day.day)}: ${formatTokens(total)} tokens, ${formatTokens(day.threads)} in threads, ${formatTokens(day.cli)} in CLI sessions`}
                  onMouseEnter={() => setActive(index)}
                  onFocus={() => setActive(index)}
                  onBlur={() => setActive(null)}
                >
                  <span
                    className="project-usage-trend-stack"
                    style={{ height: `${(total / max) * 100}%` }}
                  >
                    {[...SERIES]
                      .reverse()
                      .map((series) =>
                        day[series.key] > 0 ? (
                          <span
                            key={series.key}
                            style={{ flexGrow: day[series.key], background: series.color }}
                          />
                        ) : null,
                      )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {focus ? (
          <div
            role="status"
            className="project-usage-trend-tip"
            style={{
              left: `${((active! + 0.5) / days.length) * 100}%`,
              translate: active! > days.length / 2 ? "-100% 0" : "0 0",
            }}
          >
            <strong>{formatDayShort(focus.day)}</strong>
            <span>{formatTokens(focus.threads + focus.cli)} tokens</span>
            {SERIES.map((series) =>
              focus[series.key] > 0 ? (
                <span key={series.key}>
                  <i aria-hidden style={{ background: series.color }} />
                  {series.label} {formatTokens(focus[series.key])}
                </span>
              ) : null,
            )}
          </div>
        ) : null}
      </div>
      <div className="project-usage-trend-axis" aria-hidden>
        <span>{formatDayShort(days[0]!.day)}</span>
        <span>{formatDayShort(days[middle]!.day)}</span>
        <span>{formatDayShort(days.at(-1)!.day)}</span>
      </div>
    </figure>
  );
}
