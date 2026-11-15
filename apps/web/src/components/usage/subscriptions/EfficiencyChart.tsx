import { useEffect, useState } from "react";

import { cn } from "../../../lib/utils";
import { formatDay } from "./SubscriptionRow";
import type { DashboardColumn, DashboardRange } from "./efficiency";

const CHART_HEIGHT = 200;
const GRID = [100, 75, 50, 25, 0];

function columnTitle(column: DashboardColumn, range: DashboardRange): string {
  return range === "1y"
    ? new Date(column.start).toLocaleDateString(undefined, { month: "long", year: "numeric" })
    : `Week of ${formatDay(column.start)}`;
}

function axisLabel(column: DashboardColumn, range: DashboardRange): string {
  return range === "1y"
    ? new Date(column.start).toLocaleDateString(undefined, { month: "short" })
    : formatDay(column.start);
}

/** True one frame after mount, so bars grow from the baseline once. */
export function useGrowIn(): boolean {
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return grown;
}

/**
 * The score for each week (or month, over a year): one column each, the
 * range's columns at full strength and the ones before it dimmed for context.
 * Pointing at or focusing a column reads out its groups; clicking selects it,
 * which scopes the resets table.
 */
export function EfficiencyChart({
  columns,
  range,
  selected,
  onSelect,
}: {
  readonly columns: readonly DashboardColumn[];
  readonly range: DashboardRange;
  readonly selected: number | null;
  readonly onSelect: (index: number | null) => void;
}) {
  const grown = useGrowIn();
  const [hovered, setHovered] = useState<number | null>(null);
  const shown = hovered ?? selected;
  const column = shown === null ? null : (columns[shown] ?? null);
  return (
    <div className="flex flex-col gap-2" data-efficiency-chart="">
      <div className="flex gap-2">
        <div
          className="flex shrink-0 flex-col justify-between text-right text-xs text-muted-foreground tabular-nums"
          style={{ height: CHART_HEIGHT }}
          aria-hidden
        >
          {GRID.map((tick) => (
            <span key={tick} className="leading-none">
              {tick}%
            </span>
          ))}
        </div>
        <div className="relative min-w-0 flex-1">
          <div
            className="pointer-events-none absolute inset-x-0 top-0 flex flex-col justify-between"
            style={{ height: CHART_HEIGHT }}
            aria-hidden
          >
            {GRID.map((tick) => (
              <span key={tick} className="h-px bg-border/60" />
            ))}
          </div>
          <div className="relative flex gap-1.5 sm:gap-2.5" role="group" aria-label="Efficiency by period">
            {columns.map((entry, index) => {
              const score = entry.score;
              const isSelected = selected === index;
              return (
                <button
                  key={entry.start}
                  type="button"
                  disabled={score === null}
                  aria-pressed={isSelected}
                  aria-label={
                    score === null
                      ? `${columnTitle(entry, range)}: no reset recorded`
                      : `${columnTitle(entry, range)}: ${Math.round(score)}% across ${entry.resets} ${entry.resets === 1 ? "reset" : "resets"}`
                  }
                  data-efficiency-column={index}
                  data-in-range={entry.inRange ? "" : undefined}
                  className={cn(
                    "group flex min-w-0 flex-1 flex-col gap-1 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    score !== null && "cursor-pointer",
                  )}
                  onPointerEnter={() => setHovered(score === null ? null : index)}
                  onPointerLeave={() => setHovered(null)}
                  onFocus={() => setHovered(score === null ? null : index)}
                  onBlur={() => setHovered(null)}
                  onClick={() => onSelect(isSelected ? null : index)}
                >
                  <span
                    className={cn(
                      "flex w-full flex-col-reverse overflow-hidden rounded-sm",
                      score === null ? "border border-dashed border-border/60" : "bg-muted",
                      isSelected && "ring-2 ring-foreground/70 ring-offset-1 ring-offset-background",
                    )}
                    style={{ height: CHART_HEIGHT }}
                  >
                    {score === null ? null : (
                      <span
                        className={cn(
                          "w-full rounded-sm bg-primary transition-[height,opacity] duration-500 ease-out motion-reduce:transition-none",
                          entry.inRange ? "opacity-100" : "opacity-45",
                          "group-hover:opacity-100",
                        )}
                        style={{
                          height: grown ? `${Math.max(1, score)}%` : "0%",
                          transitionDelay: `${index * 25}ms`,
                        }}
                      />
                    )}
                  </span>
                  {/* Every third column is labelled, centred on it and free to overhang its neighbours. */}
                  <span className="flex h-4 justify-center text-xs whitespace-nowrap text-muted-foreground">
                    {index % 3 === 2 ? axisLabel(entry, range) : ""}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <p className="min-h-10 text-xs text-muted-foreground" aria-live="polite" data-efficiency-readout="">
        {column === null || column.score === null ? (
          "Point at a column for each group, or click one to see its resets."
        ) : (
          <>
            <span className="font-medium text-foreground">
              {columnTitle(column, range)}: {Math.round(column.score)}%
            </span>
            {column.groups.map((group) => (
              <span key={group.key}>
                {" · "}
                {group.label} {Math.round(group.usedPercent)}%
                {Math.round(group.targetPercent) === 100
                  ? ""
                  : ` of ${Math.round(group.targetPercent)}%`}
              </span>
            ))}
          </>
        )}
      </p>
    </div>
  );
}

/** The score as a ring: the arc is the score, the track is what was planned and not used. */
export function ScoreRing({ score }: { readonly score: number | null }) {
  const grown = useGrowIn();
  const radius = 44;
  const length = 2 * Math.PI * radius;
  const shown = score === null || !grown ? 0 : Math.max(0, Math.min(100, score));
  return (
    <svg
      width="104"
      height="104"
      viewBox="0 0 104 104"
      role="img"
      aria-label={score === null ? "Efficiency: not enough history yet" : `Efficiency ${Math.round(score)}%`}
      className="shrink-0"
    >
      <circle cx="52" cy="52" r={radius} fill="none" strokeWidth="9" className="stroke-muted" />
      <circle
        cx="52"
        cy="52"
        r={radius}
        fill="none"
        strokeWidth="9"
        strokeLinecap="round"
        className="stroke-primary transition-[stroke-dashoffset] duration-700 ease-out motion-reduce:transition-none"
        strokeDasharray={length}
        strokeDashoffset={length * (1 - shown / 100)}
        transform="rotate(-90 52 52)"
      />
    </svg>
  );
}
