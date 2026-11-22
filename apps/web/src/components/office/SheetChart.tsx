import {
  type SheetChart as SheetChartBlock,
  type SheetChartAggregate,
  type SheetChartOverrides,
  type SheetChartPoint,
  type SheetChartSeries,
  type SheetChartSort,
  compactNumber,
} from "@specweave-studio/shared/officeSheet";
import { XIcon } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useId,
  useRef,
  useState,
} from "react";

import { useTx } from "../../i18n";
import { entryDelay, useCountUp, useReducedMotion, useReorderMotion } from "./chartMotion";

const WIDTH = 480;
const HEIGHT = 220;
const PAD = { top: 18, right: 12, bottom: 30, left: 44 };
const SERIES_COUNT = 8;

function seriesColor(index: number): string {
  return `var(--office-s${(index % SERIES_COUNT) + 1})`;
}

function shortLabel(label: string, max: number): string {
  return label.length > max ? `${label.slice(0, Math.max(1, max - 1))}…` : label;
}

/**
 * A key per point that follows its label, so a sort moves a mark instead of
 * remounting it. A repeated label takes its count.
 */
function pointKeys(points: ReadonlyArray<{ readonly label: string }>): string[] {
  const seen = new Map<string, number>();
  return points.map((point) => {
    const count = seen.get(point.label) ?? 0;
    seen.set(point.label, count + 1);
    return count === 0 ? point.label : `${point.label}\u0000${count}`;
  });
}

/** When a mark starts its entry, as a CSS custom property. */
function delayStyle(index: number, count: number): CSSProperties {
  return { "--office-delay": entryDelay(index, count) } as CSSProperties;
}

const AXIS_STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

/** Round the top of a value axis up to a round figure that leaves little empty room. */
function niceCeiling(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const scaled = value / power;
  const step = AXIS_STEPS.find((entry) => scaled <= entry) ?? 10;
  // Powers of ten below one carry float noise (3 * 0.1); 12 digits is past any axis label.
  return Number((step * power).toPrecision(12));
}

interface Scale {
  readonly low: number;
  readonly high: number;
  readonly y: (value: number) => number;
  readonly ticks: ReadonlyArray<number>;
}

function valueScale(series: SheetChartSeries): Scale {
  const high = niceCeiling(Math.max(0, series.max));
  // A balance that ends a rounding error below zero is zero, not a negative axis.
  const negative = series.min < 0 && Math.abs(series.min) > Math.abs(series.max) * 1e-9;
  const low = negative ? -niceCeiling(Math.abs(series.min)) : 0;
  const span = high - low || 1;
  const inner = HEIGHT - PAD.top - PAD.bottom;
  const y = (value: number) => PAD.top + ((high - value) / span) * inner;
  const ticks = low < 0 ? [low, 0, high] : [0, high / 2, high];
  return { low, high, y, ticks };
}

function Axis(props: { readonly scale: Scale }): ReactNode {
  return (
    <g aria-hidden>
      {props.scale.ticks.map((tick) => (
        <g key={tick}>
          <line
            x1={PAD.left}
            x2={WIDTH - PAD.right}
            y1={props.scale.y(tick)}
            y2={props.scale.y(tick)}
            className={tick === 0 ? "office-chart-base" : "office-chart-grid"}
          />
          <text
            x={PAD.left - 6}
            y={props.scale.y(tick)}
            className="office-chart-tick"
            textAnchor="end"
            dominantBaseline="middle"
          >
            {compactNumber(tick)}
          </text>
        </g>
      ))}
    </g>
  );
}

/**
 * Which mark the pointer or the keyboard is on. Arrow keys step through the
 * marks, Home and End jump, Escape lets go.
 */
function useActiveMark(count: number): {
  readonly index: number | null;
  readonly set: (index: number | null) => void;
  readonly onKeyDown: (event: KeyboardEvent) => void;
} {
  const [active, setActive] = useState<number | null>(null);
  const index = active !== null && active < count ? active : null;
  const onKeyDown = (event: KeyboardEvent): void => {
    if (count === 0) return;
    let next: number | null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      next = index === null ? 0 : Math.min(count - 1, index + 1);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = index === null ? count - 1 : Math.max(0, index - 1);
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = count - 1;
    } else if (event.key === "Escape" && index !== null) {
      next = null;
    } else {
      return;
    }
    // The sheet under the chart moves its selection on the same keys.
    event.preventDefault();
    event.stopPropagation();
    setActive(next);
  };
  return { index, set: setActive, onKeyDown };
}

/** What the active mark says, for a screen reader. */
function Readout(props: { readonly point: SheetChartPoint | undefined }): ReactNode {
  return (
    <span className="sr-only" aria-live="polite">
      {props.point ? `${props.point.label}: ${compactNumber(props.point.value)}` : ""}
    </span>
  );
}

/** The value and label of the active mark, drawn inside the plot. */
function PlotTip(props: {
  readonly x: number;
  readonly y: number;
  readonly point: SheetChartPoint;
}): ReactNode {
  const value = compactNumber(props.point.value);
  const label = shortLabel(props.point.label, 26);
  const width = Math.max(56, Math.min(190, Math.max(value.length * 7.2, label.length * 5.8) + 18));
  const height = 36;
  // Beside the mark, never under the pointer that rests on it: to the right,
  // or to the left when the right edge is near.
  const gap = 14;
  const right = props.x + gap;
  const left = right + width > WIDTH - PAD.right ? Math.max(2, props.x - gap - width) : right;
  const top = Math.max(2, Math.min(HEIGHT - PAD.bottom - height, props.y - height / 2));
  return (
    <g className="office-chart-tip" aria-hidden>
      <rect x={left} y={top} width={width} height={height} rx={6} />
      <text x={left + 9} y={top + 15} className="office-chart-tip-value">
        {value}
      </text>
      <text x={left + 9} y={top + 28} className="office-chart-tip-label">
        {label}
      </text>
    </g>
  );
}

interface PlotProps {
  readonly series: SheetChartSeries;
  readonly tone: number;
  /** A sentence that says what the chart holds, for a screen reader. */
  readonly summary: string;
  /** False when motion is off for this chart or for this person. */
  readonly motion: boolean;
}

/** Horizontal bars, one per label, each with its value and its share of the total. */
function BarChart(props: PlotProps): ReactNode {
  const points = props.series.points.slice(0, 40);
  const keys = pointKeys(points);
  const max = Math.max(0, ...points.map((point) => Math.abs(point.value)));
  const list = useRef<HTMLUListElement | null>(null);
  useReorderMotion(list, keys.join("\u0001"), props.motion);
  return (
    <ul className="office-bars" ref={list} aria-label={props.summary}>
      {points.map((point, index) => (
        <li key={keys[index]} data-motion-key={keys[index]} style={delayStyle(index, points.length)}>
          <span className="office-bars-label" title={point.label}>
            {point.label}
          </span>
          <span className="office-bars-track">
            <span
              className="office-bars-bar"
              style={
                {
                  // The stylesheet scales this share inside the room left for the value.
                  "--office-bar-share": max > 0 ? Math.abs(point.value) / max : 0,
                  background: seriesColor(props.tone),
                } as CSSProperties
              }
            />
            <span className="office-bars-value">
              {compactNumber(point.value)}
              {props.series.total > 0 && point.value >= 0
                ? ` · ${Math.round(point.share * 100)}%`
                : ""}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function ColumnChart(props: PlotProps): ReactNode {
  const { points } = props.series;
  const keys = pointKeys(points);
  const scale = valueScale(props.series);
  const band = (WIDTH - PAD.left - PAD.right) / points.length;
  const bar = Math.min(48, band * 0.64);
  const every = Math.ceil(points.length / 12);
  const labelChars = Math.max(3, Math.floor((band * every) / 6.5));
  const mark = useActiveMark(points.length);
  const active = mark.index === null ? undefined : points[mark.index];
  return (
    <>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="office-chart-plot"
        role="img"
        aria-label={props.summary}
        tabIndex={0}
        data-active={mark.index !== null}
        onKeyDown={mark.onKeyDown}
        onBlur={() => mark.set(null)}
        onPointerLeave={() => mark.set(null)}
      >
        <Axis scale={scale} />
        {points.map((point, index) => {
          const x = PAD.left + band * index + (band - bar) / 2;
          const top = scale.y(Math.max(0, point.value));
          const bottom = scale.y(Math.min(0, point.value));
          return (
            <g key={keys[index]} style={delayStyle(index, points.length)}>
              <rect
                className="office-chart-col"
                data-on={mark.index === index}
                data-negative={point.value < 0}
                x={x}
                y={top}
                width={bar}
                height={Math.max(1, bottom - top)}
                rx={3}
                fill={seriesColor(props.tone)}
              />
              {points.length <= 12 ? (
                <text
                  x={x + bar / 2}
                  y={point.value >= 0 ? top - 4 : bottom + 11}
                  className="office-chart-value office-chart-late"
                  textAnchor="middle"
                >
                  {compactNumber(point.value)}
                </text>
              ) : null}
              {index % every === 0 ? (
                <text
                  x={x + bar / 2}
                  y={HEIGHT - 10}
                  className="office-chart-tick"
                  textAnchor="middle"
                >
                  {shortLabel(point.label, labelChars)}
                </text>
              ) : null}
              <rect
                className="office-chart-hit"
                x={PAD.left + band * index}
                y={PAD.top}
                width={band}
                height={HEIGHT - PAD.top - PAD.bottom}
                onPointerEnter={() => mark.set(index)}
              />
            </g>
          );
        })}
        {active && mark.index !== null && points.length > 12 ? (
          <PlotTip
            x={PAD.left + band * mark.index + band / 2}
            y={scale.y(Math.max(0, active.value))}
            point={active}
          />
        ) : null}
      </svg>
      <Readout point={active} />
    </>
  );
}

/** A longer line shows a dot only under the pointer: a dot per point would bead it. */
const DOT_POINTS = 12;

function LineChart(props: PlotProps): ReactNode {
  const { points } = props.series;
  const keys = pointKeys(points);
  const scale = valueScale(props.series);
  const inner = WIDTH - PAD.left - PAD.right;
  const step = points.length > 1 ? inner / (points.length - 1) : 0;
  const x = (index: number) => (points.length > 1 ? PAD.left + step * index : PAD.left + inner / 2);
  const every = Math.ceil(points.length / 8);
  const color = seriesColor(props.tone);
  const line = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${x(index)},${scale.y(point.value)}`)
    .join(" ");
  const zero = scale.y(0);
  const area =
    points.length > 1 ? `${line} L${x(points.length - 1)},${zero} L${x(0)},${zero} Z` : null;
  const fade = `office-fade-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const mark = useActiveMark(points.length);
  const active = mark.index === null ? undefined : points[mark.index];
  const hit = points.length > 1 ? step : inner;
  return (
    <>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="office-chart-plot"
        role="img"
        aria-label={props.summary}
        tabIndex={0}
        data-active={mark.index !== null}
        onKeyDown={mark.onKeyDown}
        onBlur={() => mark.set(null)}
        onPointerLeave={() => mark.set(null)}
      >
        <defs>
          <linearGradient id={fade} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" style={{ stopColor: color, stopOpacity: 0.26 }} />
            <stop offset="1" style={{ stopColor: color, stopOpacity: 0 }} />
          </linearGradient>
        </defs>
        <Axis scale={scale} />
        {area ? <path d={area} className="office-chart-area" fill={`url(#${fade})`} /> : null}
        <path
          d={line}
          pathLength={1}
          className="office-chart-line"
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {active && mark.index !== null ? (
          <line
            className="office-chart-cross"
            x1={x(mark.index)}
            x2={x(mark.index)}
            y1={PAD.top}
            y2={HEIGHT - PAD.bottom}
          />
        ) : null}
        {points.map((point, index) => (
          <g key={keys[index]} style={delayStyle(index, points.length)}>
            {points.length <= DOT_POINTS || mark.index === index ? (
              <circle
                className="office-chart-dot"
                data-on={mark.index === index}
                cx={x(index)}
                cy={scale.y(point.value)}
                r={mark.index === index ? 5 : 3.5}
                fill={color}
              />
            ) : null}
            {index % every === 0 ? (
              <text
                x={x(index)}
                y={HEIGHT - 10}
                className="office-chart-tick"
                textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}
              >
                {shortLabel(point.label, 10)}
              </text>
            ) : null}
            <rect
              className="office-chart-hit"
              x={x(index) - hit / 2}
              y={PAD.top}
              width={hit}
              height={HEIGHT - PAD.top - PAD.bottom}
              onPointerEnter={() => mark.set(index)}
            />
          </g>
        ))}
        {active && mark.index !== null ? (
          <PlotTip x={x(mark.index)} y={scale.y(active.value)} point={active} />
        ) : null}
      </svg>
      <Readout point={active} />
    </>
  );
}

const DONUT_SLICES = 7;

function DonutChart(props: PlotProps): ReactNode {
  const tx = useTx();
  const positive = props.series.points.filter((point) => point.value > 0);
  const sorted = positive.toSorted((a, b) => b.value - a.value);
  const head = sorted.slice(0, DONUT_SLICES);
  const tail = sorted.slice(DONUT_SLICES);
  const slices: ReadonlyArray<SheetChartPoint> =
    tail.length > 0
      ? [
          ...head,
          {
            label: tx("Other"),
            value: tail.reduce((sum, point) => sum + point.value, 0),
            share: tail.reduce((sum, point) => sum + point.share, 0),
          },
        ]
      : head;
  const keys = pointKeys(slices);
  const radius = 70;
  const circumference = 2 * Math.PI * radius;
  const sweep = `office-sweep-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const total = useCountUp(props.series.total, props.motion);
  const mark = useActiveMark(slices.length);
  const active = mark.index === null ? undefined : slices[mark.index];
  let offset = 0;
  return (
    <div className="office-chart-donut" onPointerLeave={() => mark.set(null)}>
      <svg
        viewBox="0 0 200 200"
        className="office-chart-ring"
        role="img"
        aria-label={props.summary}
        tabIndex={0}
        data-active={mark.index !== null}
        onKeyDown={mark.onKeyDown}
        onBlur={() => mark.set(null)}
      >
        <defs>
          {/* An alpha mask: the stroke's colour does not matter, only where it is. */}
          <mask
            id={sweep}
            maskUnits="userSpaceOnUse"
            x="0"
            y="0"
            width="200"
            height="200"
            style={{ maskType: "alpha" }}
          >
            <circle
              className="office-donut-sweep"
              cx={100}
              cy={100}
              r={radius}
              fill="none"
              stroke="currentColor"
              strokeWidth={40}
              pathLength={1}
              transform="rotate(-90 100 100)"
            />
          </mask>
        </defs>
        <g mask={`url(#${sweep})`}>
          <g transform="rotate(-90 100 100)">
            {slices.map((slice, index) => {
              const length = slice.share * circumference;
              const dash = `${Math.max(0, length - 1.5)} ${circumference}`;
              const start = offset;
              offset += length;
              return (
                <circle
                  key={keys[index]}
                  className="office-donut-slice"
                  data-on={mark.index === index}
                  cx={100}
                  cy={100}
                  r={radius}
                  fill="none"
                  stroke={seriesColor(index)}
                  strokeDasharray={dash}
                  strokeDashoffset={-start}
                  pointerEvents="stroke"
                  onPointerEnter={() => mark.set(index)}
                />
              );
            })}
          </g>
        </g>
        <text x={100} y={98} textAnchor="middle" className="office-chart-total" aria-hidden>
          {compactNumber(active ? active.value : total)}
        </text>
        <text x={100} y={116} textAnchor="middle" className="office-chart-tick" aria-hidden>
          {active ? shortLabel(active.label, 18) : tx("Total")}
        </text>
      </svg>
      <ul className="office-chart-legend">
        {slices.map((slice, index) => (
          <li
            key={keys[index]}
            data-on={mark.index === index}
            onPointerEnter={() => mark.set(index)}
          >
            <span
              className="office-chart-swatch"
              style={{ background: seriesColor(index) }}
              aria-hidden
            />
            <span className="truncate">{slice.label}</span>
            <span className="office-chart-share">{Math.round(slice.share * 100)}%</span>
          </li>
        ))}
      </ul>
      <Readout point={active} />
    </div>
  );
}

const SORT_OPTIONS: ReadonlyArray<{ readonly value: SheetChartSort; readonly label: string }> = [
  { value: "none", label: "Order: sheet" },
  { value: "value-desc", label: "High to low" },
  { value: "value-asc", label: "Low to high" },
  { value: "label-asc", label: "A–Z" },
  { value: "label-desc", label: "Z–A" },
];

const AGGREGATE_OPTIONS: ReadonlyArray<{
  readonly value: SheetChartAggregate;
  readonly label: string;
}> = [
  { value: "none", label: "Raw" },
  { value: "sum", label: "Sum" },
  { value: "avg", label: "Avg" },
  { value: "count", label: "Count" },
  { value: "min", label: "Min" },
  { value: "max", label: "Max" },
];

/** The most labels a chart without a filter column offers as filter chips. */
const LABEL_FILTERS = 8;

/** One chart block of a sheet, drawn from the computed values of its ranges. */
export function SheetChartCard(props: {
  readonly chart: SheetChartBlock;
  readonly series: SheetChartSeries;
  /** Which series colour the chart takes, so charts on one tab differ. */
  readonly tone?: number | undefined;
  readonly overrides?: SheetChartOverrides | undefined;
  readonly onOverridesChange?: ((next: SheetChartOverrides) => void) | undefined;
  readonly onRemove?: (() => void) | undefined;
}): ReactNode {
  const tx = useTx();
  const { chart, series, overrides, onOverridesChange } = props;
  const tone = props.tone ?? 0;
  const activeSort: SheetChartSort = overrides?.sort ?? chart.sort ?? "none";
  const activeAggregate: SheetChartAggregate = overrides?.aggregate ?? chart.aggregate ?? "none";
  const activeFilters =
    overrides?.filterValues !== undefined ? overrides.filterValues : (chart.filterValues ?? []);
  const normFilter = (value: string) => value.trim().toLowerCase();
  // Chips filter by the chart's own filter column. Without one they filter by label,
  // which helps for a few categories and is noise for a long series.
  const filterable =
    series.availableFilters.length > 1 &&
    (chart.filterRange !== undefined ||
      (series.availableFilters.length <= LABEL_FILTERS &&
        // Labels that are all numbers are a scale (months, years), not categories to pick.
        series.availableFilters.some((value) => !Number.isFinite(Number(value)))));
  const hasFilters = filterable || activeFilters.length > 0;
  const showControls = onOverridesChange !== undefined && (hasFilters || series.points.length > 1);
  const reducedMotion = useReducedMotion();
  const motion = chart.animate !== false && !reducedMotion;
  const summary =
    series.points.length > 0
      ? tx("{title}. {count} values, from {low} to {high}.", {
          title: chart.title,
          count: series.points.length,
          low: compactNumber(series.min),
          high: compactNumber(series.max),
        })
      : chart.title;
  const plot = { series, tone, summary, motion };

  const toggleFilter = (value: string) => {
    if (!onOverridesChange) return;
    const target = normFilter(value);
    const exists = activeFilters.some((entry) => normFilter(entry) === target);
    const nextFilters = exists
      ? activeFilters.filter((entry) => normFilter(entry) !== target)
      : [...activeFilters, value];
    // Explicitly store [] when clearing so a saved chart.filterValues is not reapplied.
    onOverridesChange({
      ...overrides,
      filterValues: nextFilters,
    });
  };

  return (
    <figure
      className="office-chart"
      data-chart-type={chart.type}
      data-chart-id={chart.id}
      data-animate={chart.animate === false ? "off" : "on"}
    >
      <figcaption className="office-chart-title">
        <span className="min-w-0 flex-1">{chart.title}</span>
        {props.onRemove ? (
          <button
            type="button"
            className="office-chart-remove"
            aria-label={tx("Remove chart")}
            onClick={props.onRemove}
          >
            <XIcon aria-hidden />
          </button>
        ) : null}
      </figcaption>
      {showControls ? (
        <div className="office-chart-controls" data-chart-controls={chart.id}>
          <select
            className="office-chart-select"
            aria-label={tx("Sort chart")}
            data-chart-sort={chart.id}
            value={activeSort}
            onChange={(event) =>
              onOverridesChange({
                ...overrides,
                sort: event.target.value as SheetChartSort,
              })
            }
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {tx(option.label)}
              </option>
            ))}
          </select>
          <select
            className="office-chart-select"
            aria-label={tx("Aggregate chart")}
            data-chart-aggregate={chart.id}
            value={activeAggregate}
            onChange={(event) =>
              onOverridesChange({
                ...overrides,
                aggregate: event.target.value as SheetChartAggregate,
              })
            }
          >
            {AGGREGATE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {tx(option.label)}
              </option>
            ))}
          </select>
          {hasFilters ? (
            <div className="office-chart-filters" role="group" aria-label={tx("Filter chart")}>
              <button
                type="button"
                className="office-chart-filter-chip"
                data-active={activeFilters.length === 0}
                aria-pressed={activeFilters.length === 0}
                data-chart-filter-all={chart.id}
                onClick={() => {
                  onOverridesChange({
                    ...overrides,
                    filterValues: [],
                  });
                }}
              >
                {tx("All")}
              </button>
              {series.availableFilters.slice(0, 12).map((filterValue) => {
                const selected = activeFilters.some(
                  (entry) => normFilter(entry) === normFilter(filterValue),
                );
                return (
                  <button
                    key={filterValue}
                    type="button"
                    className="office-chart-filter-chip"
                    data-active={selected}
                    aria-pressed={selected}
                    data-chart-filter={filterValue}
                    onClick={() => toggleFilter(filterValue)}
                  >
                    {filterValue}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
      {series.problem === "range" ? (
        <p className="office-chart-empty">{tx("This chart's range is not valid.")}</p>
      ) : series.problem === "empty" ? (
        <p className="office-chart-empty">{tx("This chart has no numbers to draw.")}</p>
      ) : chart.type === "donut" ? (
        <DonutChart {...plot} />
      ) : chart.type === "line" ? (
        <LineChart {...plot} />
      ) : chart.type === "column" ? (
        <ColumnChart {...plot} />
      ) : (
        <BarChart {...plot} />
      )}
    </figure>
  );
}
