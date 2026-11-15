import {
  type SheetChart as SheetChartBlock,
  type SheetChartSeries,
  compactNumber,
} from "@specweave-studio/shared/officeSheet";
import { XIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useTx } from "../../i18n";

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

/** Round the top of a value axis up to 1, 2 or 5 times a power of ten. */
function niceCeiling(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const scaled = value / power;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return step * power;
}

interface Scale {
  readonly low: number;
  readonly high: number;
  readonly y: (value: number) => number;
  readonly ticks: ReadonlyArray<number>;
}

function valueScale(series: SheetChartSeries): Scale {
  const high = niceCeiling(Math.max(0, series.max));
  const low = series.min < 0 ? -niceCeiling(Math.abs(series.min)) : 0;
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

function BarChart(props: { readonly series: SheetChartSeries }): ReactNode {
  const { points } = props.series;
  const scale = valueScale(props.series);
  const band = (WIDTH - PAD.left - PAD.right) / points.length;
  const bar = Math.min(48, band * 0.64);
  const every = Math.ceil(points.length / 12);
  const labelChars = Math.max(3, Math.floor((band * every) / 6.5));
  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="office-chart-plot" role="img">
      <Axis scale={scale} />
      {points.map((point, index) => {
        const x = PAD.left + band * index + (band - bar) / 2;
        const top = scale.y(Math.max(0, point.value));
        const bottom = scale.y(Math.min(0, point.value));
        return (
          <g key={`${point.label}:${index}`}>
            <rect
              x={x}
              y={top}
              width={bar}
              height={Math.max(1, bottom - top)}
              rx={2}
              fill={seriesColor(0)}
            >
              <title>{`${point.label}: ${compactNumber(point.value)}`}</title>
            </rect>
            {points.length <= 12 ? (
              <text
                x={x + bar / 2}
                y={point.value >= 0 ? top - 4 : bottom + 11}
                className="office-chart-value"
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
          </g>
        );
      })}
    </svg>
  );
}

function LineChart(props: { readonly series: SheetChartSeries }): ReactNode {
  const { points } = props.series;
  const scale = valueScale(props.series);
  const inner = WIDTH - PAD.left - PAD.right;
  const step = points.length > 1 ? inner / (points.length - 1) : 0;
  const x = (index: number) => (points.length > 1 ? PAD.left + step * index : PAD.left + inner / 2);
  const every = Math.ceil(points.length / 8);
  const path = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${x(index)},${scale.y(point.value)}`)
    .join(" ");
  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="office-chart-plot" role="img">
      <Axis scale={scale} />
      <path d={path} fill="none" stroke={seriesColor(0)} strokeWidth={2} strokeLinejoin="round" />
      {points.map((point, index) => (
        <g key={`${point.label}:${index}`}>
          {points.length <= 40 ? (
            <circle cx={x(index)} cy={scale.y(point.value)} r={3} fill={seriesColor(0)}>
              <title>{`${point.label}: ${compactNumber(point.value)}`}</title>
            </circle>
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
        </g>
      ))}
    </svg>
  );
}

const DONUT_SLICES = 7;

function DonutChart(props: { readonly series: SheetChartSeries }): ReactNode {
  const tx = useTx();
  const positive = props.series.points.filter((point) => point.value > 0);
  const sorted = positive.toSorted((a, b) => b.value - a.value);
  const head = sorted.slice(0, DONUT_SLICES);
  const tail = sorted.slice(DONUT_SLICES);
  const slices =
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
  const radius = 70;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <div className="office-chart-donut">
      <svg viewBox="0 0 200 200" className="office-chart-ring" role="img">
        <g transform="rotate(-90 100 100)">
          {slices.map((slice, index) => {
            const length = slice.share * circumference;
            const dash = `${Math.max(0, length - 1.5)} ${circumference}`;
            const start = offset;
            offset += length;
            return (
              <circle
                key={`${slice.label}:${index}`}
                cx={100}
                cy={100}
                r={radius}
                fill="none"
                stroke={seriesColor(index)}
                strokeWidth={26}
                strokeDasharray={dash}
                strokeDashoffset={-start}
              >
                <title>{`${slice.label}: ${compactNumber(slice.value)}`}</title>
              </circle>
            );
          })}
        </g>
        <text x={100} y={98} textAnchor="middle" className="office-chart-total">
          {compactNumber(props.series.total)}
        </text>
        <text x={100} y={116} textAnchor="middle" className="office-chart-tick">
          {tx("Total")}
        </text>
      </svg>
      <ul className="office-chart-legend">
        {slices.map((slice, index) => (
          <li key={`${slice.label}:${index}`}>
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
    </div>
  );
}

/** One chart block of a sheet, drawn from the computed values of its ranges. */
export function SheetChartCard(props: {
  readonly chart: SheetChartBlock;
  readonly series: SheetChartSeries;
  readonly onRemove?: (() => void) | undefined;
}): ReactNode {
  const tx = useTx();
  const { chart, series } = props;
  return (
    <figure className="office-chart" data-chart-type={chart.type} data-chart-id={chart.id}>
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
      {series.problem === "range" ? (
        <p className="office-chart-empty">{tx("This chart's range is not valid.")}</p>
      ) : series.problem === "empty" ? (
        <p className="office-chart-empty">{tx("This chart has no numbers to draw.")}</p>
      ) : chart.type === "donut" ? (
        <DonutChart series={series} />
      ) : chart.type === "line" ? (
        <LineChart series={series} />
      ) : (
        <BarChart series={series} />
      )}
    </figure>
  );
}
