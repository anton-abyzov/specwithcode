import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { cn } from "../../lib/utils";
import type { UsageProviderKind } from "@specweave-studio/contracts";
import { useId, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  costCoverage,
  type DailyTotals,
  type HourlyTotals,
} from "@specweave-studio/shared/usageMerge";
import {
  formatDayShort,
  formatHourShort,
  formatRelativeHourShort,
  formatTokens,
  formatUsd,
} from "@specweave-studio/shared/usageFormat";
import { costText } from "./usageFilters";
import { PROVIDER_ORDER, PROVIDER_PRESENTATION } from "./usageProviders";

const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 260;
const TICK_COUNT = 4;
const PLOT_TOP = 8;

export type UsageChartMetric = "tokens" | "cost";

interface UsageProviderChartProps {
  readonly providers: readonly UsageProviderKind[];
  readonly days: readonly string[];
  readonly daily: readonly DailyTotals[];
  readonly hours: readonly string[];
  readonly hourly: readonly HourlyTotals[];
  readonly metric: UsageChartMetric;
  readonly referenceTime: string | undefined;
  readonly resolution: "day" | "hour";
  readonly timeZone: string;
  /** The pinned day or hour start, marked on the plot. */
  readonly selectedPeriod?: string | null;
  /** Click or Enter pins a period (null unpins); Escape unpins. */
  readonly onSelectPeriod?: (period: string | null) => void;
}

/** One day's per-provider values, shared by the paths and the hover readout. */
export interface DayColumn {
  readonly bands: readonly {
    readonly provider: UsageProviderKind;
    readonly value: number;
  }[];
  readonly total: number;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

function valueFor(
  totals: DailyTotals | HourlyTotals | undefined,
  provider: UsageProviderKind,
  metric: UsageChartMetric,
): number {
  const entry = totals?.byProvider.get(provider);
  if (entry === undefined) return 0;
  return metric === "tokens" ? entry.totalTokens : entry.costUsd;
}

export function buildPeriodColumns(
  periods: readonly string[],
  byPeriod: ReadonlyMap<string, DailyTotals | HourlyTotals>,
  metric: UsageChartMetric,
): readonly DayColumn[] {
  return periods.map((period) => {
    const entry = byPeriod.get(period);
    const bands = PROVIDER_ORDER.map((provider) => ({
      provider,
      value: valueFor(entry, provider, metric),
    }));
    return { bands, total: bands.reduce((sum, band) => sum + band.value, 0) };
  });
}

/** Straight sample segments; null breaks unpriced history instead of drawing zero. */
export function sampledPaths(
  points: readonly (Point | null)[],
  floor: number,
): { line: string; area: string } {
  const runs: Point[][] = [];
  let run: Point[] = [];
  for (const point of points) {
    if (point === null) {
      if (run.length) runs.push(run);
      run = [];
    } else run.push(point);
  }
  if (run.length) runs.push(run);
  const path = (run: readonly Point[]) =>
    run
      .map(
        (point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)},${point.y.toFixed(2)}`,
      )
      .join(" ");
  return {
    line: runs.map(path).join(" "),
    area: runs
      .map(
        (run) =>
          `${path(run)} L${run.at(-1)!.x.toFixed(2)},${floor} L${run[0]!.x.toFixed(2)},${floor} Z`,
      )
      .join(" "),
  };
}
export function sampleIndex(
  clientX: number,
  left: number,
  width: number,
  count: number,
): number | null {
  if (width <= 0 || count <= 0) return null;
  return Math.round(Math.min(1, Math.max(0, (clientX - left) / width)) * (count - 1));
}

/**
 * Builds a scale whose maximum is a readable 1/2/5 x 10^n step at or above the
 * peak.
 *
 * Rounding the maximum *up* is the point: stopping at the last step below the
 * peak leaves the tallest day drawn past the top of the plot, where it is
 * clipped.
 */
export function niceScale(peak: number, count: number): { max: number; ticks: readonly number[] } {
  if (peak <= 0) return { max: 0, ticks: [0] };

  const rawStep = peak / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step = (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) * magnitude;

  const max = Math.ceil(peak / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= max + step * 1e-6; value += step) ticks.push(value);
  return { max, ticks };
}

export function UsageProviderChart({
  providers,
  days,
  daily,
  hours,
  hourly,
  metric,
  referenceTime,
  resolution,
  timeZone,
  selectedPeriod = null,
  onSelectPeriod,
}: UsageProviderChartProps) {
  const hatchId = useId();
  const periods = resolution === "hour" ? hours : days;
  const byPeriod = useMemo(
    () =>
      resolution === "hour"
        ? new Map(hourly.map((entry) => [entry.hourStart, entry]))
        : new Map(daily.map((entry) => [entry.day, entry])),
    [daily, hourly, resolution],
  );
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const hoverPositionRef = useRef<{ x: number; y: number } | null>(null);

  const { paths, ticks, stepX, toY, series } = useMemo(() => {
    if (periods.length === 0) {
      return {
        paths: [],
        series: [] as readonly DayColumn[],
        stepX: 0,
        ticks: [0] as readonly number[],
        toY: () => VIEW_HEIGHT,
      };
    }

    const columns = buildPeriodColumns(periods, byPeriod, metric);
    // The scale tops out at the largest single provider-period, not the sum:
    // layered series each measure from zero, so a combined peak would leave
    // the plot permanently half empty.
    const peak = columns.reduce(
      (max, column) => column.bands.reduce((inner, band) => Math.max(inner, band.value), max),
      0,
    );
    const { max, ticks: tickValues } = niceScale(peak, TICK_COUNT);
    const step = periods.length === 1 ? 0 : VIEW_WIDTH / (periods.length - 1);
    // Leave room above the top gridline so the constant-width stroke is not
    // clipped when a series reaches the peak.
    const toY = (value: number) =>
      max === 0 ? VIEW_HEIGHT : VIEW_HEIGHT - (value / max) * (VIEW_HEIGHT - PLOT_TOP);

    const built = providers.map((provider) => {
      const providerIndex = PROVIDER_ORDER.indexOf(provider);
      const points = columns.map((column, periodIndex) => {
        const entry = byPeriod.get(periods[periodIndex]!)?.byProvider.get(provider);
        return metric === "cost" && costCoverage(entry) === "unknown"
          ? null
          : {
              x: periods.length === 1 ? VIEW_WIDTH / 2 : periodIndex * step,
              y: toY(column.bands[providerIndex]?.value ?? 0),
            };
      });
      const { line, area } = sampledPaths(points, VIEW_HEIGHT);
      return {
        provider,
        total: columns.reduce((sum, column) => sum + (column.bands[providerIndex]?.value ?? 0), 0),
        area,
        line,
        points: points.filter((point): point is Point => point !== null),
      };
    });

    // Paint the heavier series first so the lighter one is not buried.
    return {
      paths: built.toSorted((a, b) => b.total - a.total),
      series: columns,
      stepX: step,
      ticks: tickValues,
      toY,
    };
  }, [byPeriod, metric, periods, providers]);

  const format = metric === "tokens" ? formatTokens : formatUsd;

  const positionTooltip = useCallback(() => {
    const plot = plotRef.current;
    const tooltip = tooltipRef.current;
    const hoverPosition = hoverPositionRef.current;
    if (plot === null || tooltip === null || hoverPosition === null) return;

    const gap = 12;
    const tooltipWidth = tooltip.offsetWidth;
    const tooltipHeight = tooltip.offsetHeight;
    const plotWidth = plot.clientWidth;
    const plotHeight = plot.clientHeight;
    const preferredLeft =
      hoverPosition.x + gap + tooltipWidth <= plotWidth
        ? hoverPosition.x + gap
        : hoverPosition.x - gap - tooltipWidth;
    const preferredTop =
      hoverPosition.y + gap + tooltipHeight <= plotHeight
        ? hoverPosition.y + gap
        : hoverPosition.y - gap - tooltipHeight;
    const left = Math.min(Math.max(0, preferredLeft), Math.max(0, plotWidth - tooltipWidth));
    const top = Math.min(Math.max(0, preferredTop), Math.max(0, plotHeight - tooltipHeight));
    plot.style.setProperty("--usage-tooltip-left", `${left}px`);
    plot.style.setProperty("--usage-tooltip-top", `${top}px`);
  }, []);

  useLayoutEffect(() => {
    if (hoverIndex === null && selectedPeriod === null) return;
    if (hoverPositionRef.current === null && plotRef.current !== null) {
      const index = Math.max(0, periods.indexOf(selectedPeriod ?? ""));
      hoverPositionRef.current = {
        x: (index / Math.max(1, periods.length - 1)) * plotRef.current.clientWidth,
        y: plotRef.current.clientHeight / 3,
      };
    }
    positionTooltip();

    const plot = plotRef.current;
    const tooltip = tooltipRef.current;
    if (plot === null || tooltip === null || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(positionTooltip);
    observer.observe(plot);
    observer.observe(tooltip);
    return () => observer.disconnect();
  }, [hoverIndex, selectedPeriod, periods, positionTooltip]);

  const handleMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const plot = plotRef.current;
      if (plot === null || periods.length === 0) return;
      const bounds = plot.getBoundingClientRect();
      if (bounds.width === 0) return;
      const localX = Math.min(bounds.width, Math.max(0, event.clientX - bounds.left));
      const localY = Math.min(bounds.height, Math.max(0, event.clientY - bounds.top));
      const fraction = localX / bounds.width;
      const index = Math.round(fraction * (periods.length - 1));
      hoverPositionRef.current = { x: localX, y: localY };
      positionTooltip();
      setHoverIndex(Math.min(periods.length - 1, Math.max(0, index)));
    },
    [periods.length, positionTooltip],
  );

  const showKeyboardIndex = useCallback(
    (index: number) => {
      const plot = plotRef.current;
      if (plot === null || periods.length === 0) return;
      const clamped = Math.min(periods.length - 1, Math.max(0, index));
      const fraction = periods.length === 1 ? 0.5 : clamped / (periods.length - 1);
      hoverPositionRef.current = { x: fraction * plot.clientWidth, y: plot.clientHeight / 3 };
      positionTooltip();
      setHoverIndex(clamped);
    },
    [periods.length, positionTooltip],
  );
  const sampleX = (index: number) => (periods.length === 1 ? VIEW_WIDTH / 2 : index * stepX);
  const selectedIndex = selectedPeriod === null ? -1 : periods.indexOf(selectedPeriod);
  const togglePeriod = (index: number | null) => {
    if (onSelectPeriod === undefined || index === null) return;
    const period = periods[index];
    if (period === undefined) return;
    onSelectPeriod(period === selectedPeriod ? null : period);
  };
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (periods.length === 0) return;
    const current = hoverIndex ?? (selectedIndex >= 0 ? selectedIndex : periods.length - 1);
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      showKeyboardIndex(current + (event.key === "ArrowLeft" ? -1 : 1));
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      showKeyboardIndex(event.key === "Home" ? 0 : periods.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      togglePeriod(current);
    } else if (event.key === "Escape" && selectedPeriod !== null) {
      event.preventDefault();
      event.stopPropagation();
      onSelectPeriod?.(null);
    }
  };

  const readoutIndex = hoverIndex ?? (selectedIndex >= 0 ? selectedIndex : null);
  const hoveredPeriod = readoutIndex === null ? undefined : periods[readoutIndex];
  const hoveredEntry = hoveredPeriod === undefined ? undefined : byPeriod.get(hoveredPeriod);
  const readout = (
    value: number,
    entry: { costUsd: number; records: number; unpricedRecords: number } | undefined,
  ) =>
    metric === "cost"
      ? costText(entry)
      : { text: format(value), label: format(value), tone: "value" as const };
  const hoveredColumn = readoutIndex === null ? undefined : series[readoutIndex];
  const formatPeriod = (period: string) =>
    resolution === "hour" ? formatHourShort(period, timeZone) : formatDayShort(period);
  const formatTooltipPeriod = (period: string) =>
    resolution === "hour" && referenceTime !== undefined
      ? formatRelativeHourShort(period, referenceTime, timeZone)
      : formatPeriod(period);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        {/* Axis labels sit outside the plot so they stay aligned to gridlines. */}
        <div className="relative h-56 w-14 shrink-0">
          {ticks.map((tick) => (
            <span
              key={tick}
              className="absolute right-0 -translate-y-1/2 text-3xs text-muted-foreground tabular-nums"
              style={{ top: `${(toY(tick) / VIEW_HEIGHT) * 100}%` }}
            >
              {tick === 0 ? "0" : format(tick)}
            </span>
          ))}
        </div>

        <div
          ref={plotRef}
          className={cn(
            "relative h-56 touch-pan-y flex-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-4 focus-visible:ring-offset-background",
            onSelectPeriod !== undefined && "cursor-pointer",
          )}
          onPointerMove={handleMove}
          onPointerLeave={() => {
            hoverPositionRef.current = null;
            setHoverIndex(null);
          }}
          onClick={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            const index = sampleIndex(event.clientX, bounds.left, bounds.width, periods.length);
            if (index !== null) showKeyboardIndex(index);
            togglePeriod(index);
          }}
          onKeyDown={onSelectPeriod === undefined ? undefined : handleKeyDown}
          onBlur={() => setHoverIndex(null)}
          tabIndex={onSelectPeriod === undefined ? undefined : 0}
          role={onSelectPeriod === undefined ? undefined : "group"}
          aria-label={
            onSelectPeriod === undefined
              ? undefined
              : `${resolution === "hour" ? "Hours" : "Days"}: arrow keys move, Enter pins${selectedPeriod === null ? "" : ", Escape unpins"}`
          }
        >
          <svg
            className="h-full w-full"
            viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`${resolution === "hour" ? "Hourly" : "Daily"} ${metric === "tokens" ? "processed tokens" : "cost"} by provider`}
          >
            <defs>
              <pattern id={hatchId} width="8" height="8" patternUnits="userSpaceOnUse">
                <path
                  d="M-2,2 L2,-2 M0,8 L8,0 M6,10 L10,6"
                  stroke="currentColor"
                  strokeOpacity="0.12"
                  strokeWidth="1"
                />
              </pattern>
            </defs>
            {metric === "cost"
              ? periods.map((period, index) => {
                  const entry = byPeriod.get(period);
                  if (!entry || entry.unpricedRecords === 0) return null;
                  return (
                    <rect
                      key={period}
                      x={Math.max(0, index * stepX - stepX / 2)}
                      y={0}
                      width={periods.length === 1 ? VIEW_WIDTH : stepX}
                      height={VIEW_HEIGHT}
                      fill={`url(#${hatchId})`}
                    />
                  );
                })
              : null}
            {ticks.map((tick) => {
              const y = toY(tick);
              return (
                <line
                  key={tick}
                  x1={0}
                  x2={VIEW_WIDTH}
                  y1={y}
                  y2={y}
                  stroke="currentColor"
                  strokeWidth={1}
                  className="text-border"
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}

            {/* Fills first, then every stroke, so no series covers another's line. */}
            {paths.map(({ provider, area }) => (
              <path
                key={provider}
                d={area}
                fill={PROVIDER_PRESENTATION[provider].color}
                fillOpacity={0.12}
              />
            ))}
            {paths.map(({ provider, line, points }) => (
              <g key={provider}>
                <path
                  d={line}
                  fill="none"
                  stroke={PROVIDER_PRESENTATION[provider].color}
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                />
                {points.map((point) => (
                  <circle
                    key={point.x}
                    cx={point.x}
                    cy={point.y}
                    r={periods.length > 31 ? 1.25 : 1.7}
                    fill={PROVIDER_PRESENTATION[provider].color}
                  />
                ))}
              </g>
            ))}

            {selectedIndex < 0 ? null : (
              <g data-testid="usage-chart-pinned">
                <rect
                  x={Math.max(0, sampleX(selectedIndex) - Math.max(stepX / 2, 4))}
                  width={Math.max(stepX, 8)}
                  y={PLOT_TOP}
                  height={VIEW_HEIGHT - PLOT_TOP}
                  fill="currentColor"
                  className="text-foreground"
                  fillOpacity={0.06}
                />
                <line
                  x1={sampleX(selectedIndex)}
                  x2={sampleX(selectedIndex)}
                  y1={PLOT_TOP}
                  y2={VIEW_HEIGHT}
                  stroke="currentColor"
                  strokeWidth={1.5}
                  className="text-foreground"
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            )}

            {hoverIndex === null || hoverIndex === selectedIndex ? null : (
              <line
                x1={sampleX(hoverIndex)}
                x2={sampleX(hoverIndex)}
                y1={PLOT_TOP}
                y2={VIEW_HEIGHT}
                stroke="currentColor"
                strokeWidth={1}
                className="text-muted-foreground"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>

          {hoveredPeriod === undefined ? null : (
            <div
              ref={tooltipRef}
              role="status"
              aria-live="polite"
              className="surface-glass pointer-events-none absolute z-10 min-w-36 max-w-full rounded-xl border border-border/50 px-2.5 py-2 text-xs shadow-lg"
              style={{
                left: "var(--usage-tooltip-left, 0px)",
                top: "var(--usage-tooltip-top, 0px)",
              }}
            >
              <div className="mb-1 text-muted-foreground">{formatTooltipPeriod(hoveredPeriod)}</div>
              {providers.map((provider) => {
                const { label, driverKind } = PROVIDER_PRESENTATION[provider];
                const value = readout(
                  hoveredColumn?.bands.find((band) => band.provider === provider)?.value ?? 0,
                  hoveredEntry?.byProvider.get(provider),
                );
                return (
                  <div key={provider} className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <ProviderInstanceIcon
                        driverKind={driverKind}
                        displayName={label}
                        iconClassName="size-3"
                      />
                      {label}
                    </span>
                    <span
                      className={cn(
                        "tabular-nums",
                        value.tone === "muted" ? "text-muted-foreground" : "text-foreground",
                      )}
                      aria-label={value.label}
                    >
                      {value.text}
                    </span>
                  </div>
                );
              })}
              <div className="mt-1 flex items-center justify-between gap-3 border-t border-border pt-1">
                <span className="text-muted-foreground">Total</span>
                <span className="text-foreground tabular-nums">
                  {readout(hoveredColumn?.total ?? 0, hoveredEntry).text}
                </span>
              </div>
              {onSelectPeriod === undefined ? null : (
                <div className="mt-1 text-2xs text-muted-foreground">
                  {hoveredPeriod === selectedPeriod ? "Click to unpin" : "Click to pin this period"}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {periods.length === 1 ? (
        <div className="pl-16 text-center text-3xs text-muted-foreground">
          {formatPeriod(periods[0]!)}
        </div>
      ) : (
        <div className="flex justify-between pl-16 text-3xs text-muted-foreground uppercase">
          <span>{periods[0] === undefined ? "" : formatPeriod(periods[0])}</span>
          <span>
            {periods[Math.floor(periods.length / 2)] === undefined
              ? ""
              : formatPeriod(periods[Math.floor(periods.length / 2)] ?? "")}
          </span>
          <span>
            {periods[periods.length - 1] === undefined
              ? ""
              : formatPeriod(periods[periods.length - 1] ?? "")}
          </span>
        </div>
      )}
      {onSelectPeriod ? (
        <p className="mt-1 text-2xs text-muted-foreground">
          Click or tap to pin. Arrow keys move; Enter pins, Escape clears.
        </p>
      ) : null}
      {metric === "cost" && [...byPeriod.values()].some((entry) => entry.unpricedRecords > 0) ? (
        <p className="mt-1 text-2xs text-muted-foreground">
          Hatched periods include unpriced usage, excluded from monetary heights.
        </p>
      ) : null}
    </div>
  );
}
