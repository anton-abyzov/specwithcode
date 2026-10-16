import { effortRank } from "@specweave-studio/shared/effortLevel";

import { cn } from "~/lib/utils";

export type EffortGlyphMark = "agents" | "sparkle";

export interface EffortGlyphLevel {
  /** Filled bars out of five. */
  readonly bars: 0 | 1 | 2 | 3 | 4 | 5;
  /** Ultracode adds an agent graph, Ultrathink a sparkle, both over a full meter. */
  readonly mark: EffortGlyphMark | null;
}

// Shared ladder ranks: Off, Minimal, Low, Medium, High, Extra High, Max, Ultra.
const BARS_BY_RANK = [0, 1, 1, 2, 3, 4, 5, 5] as const;

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/** How full the meter is for an effort value, or null for a value off the ladder. */
export function effortGlyphLevel(value: string | null | undefined): EffortGlyphLevel | null {
  if (!value) return null;
  const key = normalize(value);
  if (key === "ultracode") return { bars: 5, mark: "agents" };
  if (key === "ultrathink") return { bars: 5, mark: "sparkle" };
  const rank = effortRank(value);
  return rank === undefined ? null : { bars: BARS_BY_RANK[rank] ?? 5, mark: null };
}

const EFFORT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  off: "No extended reasoning",
  none: "No extended reasoning",
  minimal: "Barely reasons, quickest replies",
  low: "Quick replies with light reasoning",
  medium: "Balanced speed and depth",
  high: "Deeper reasoning for harder problems",
  xhigh: "Extended reasoning for complex work",
  max: "Longest reasoning, slowest replies",
  ultracode: "Extra High plus multi-agent workflows",
  ultrathink: "Deepest thinking, for this message only",
};

const EFFORT_LABELS: Readonly<Record<string, string>> = {
  off: "Off",
  none: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultracode: "Ultracode",
  ultrathink: "Ultrathink",
};

/** A provider label that is only the raw level id ("medium") gets its display name. */
export function effortLevelLabel(value: string, label: string): string {
  return normalize(label) === normalize(value) ? (EFFORT_LABELS[normalize(value)] ?? label) : label;
}

/** One line on what an effort level does, when the level is a known one. */
export function effortLevelDescription(value: string): string | null {
  return EFFORT_DESCRIPTIONS[normalize(value)] ?? null;
}

// 16px grid: five 2px bars, 1px apart, rising to the right on a common baseline.
// The top-left corner stays clear for the Ultracode and Ultrathink marks.
const BAR_HEIGHTS = [3, 5.5, 8, 10.5, 13] as const;
const BASELINE = 14.5;

/**
 * A five-bar meter for reasoning effort. Filled bars use the current text color,
 * empty ones a faint tint of it, so it reads in light and dark themes alike.
 */
export function EffortGlyph({
  value,
  className,
  ...props
}: {
  value: string;
  className?: string | undefined;
  "data-composer-control-icon"?: boolean;
}) {
  const level = effortGlyphLevel(value) ?? { bars: 0, mark: null };
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className={cn("shrink-0", className)}
      data-effort-glyph={value}
      data-effort-bars={level.bars}
      {...props}
    >
      {BAR_HEIGHTS.map((height, index) => (
        <rect
          key={height}
          x={1 + index * 3}
          y={BASELINE - height}
          width={2}
          height={height}
          rx={0.75}
          fill="currentColor"
          opacity={index < level.bars ? 1 : 0.25}
          data-filled={index < level.bars ? "true" : undefined}
        />
      ))}
      {level.mark === "agents" ? (
        <g data-effort-mark="agents">
          <path
            d="M1.6 1.6 5.9 1.6M1.6 1.6 3.75 5.6M5.9 1.6 3.75 5.6"
            fill="none"
            stroke="currentColor"
            strokeWidth={0.75}
            strokeLinecap="round"
          />
          <circle cx={1.6} cy={1.6} r={1.05} fill="currentColor" />
          <circle cx={5.9} cy={1.6} r={1.05} fill="currentColor" />
          <circle cx={3.75} cy={5.6} r={1.05} fill="currentColor" />
        </g>
      ) : null}
      {level.mark === "sparkle" ? (
        <path
          data-effort-mark="sparkle"
          d="M3.75 0.25C4.05 2.45 4.55 2.95 6.75 3.25 4.55 3.55 4.05 4.05 3.75 6.25 3.45 4.05 2.95 3.55 0.75 3.25 2.95 2.95 3.45 2.45 3.75 0.25Z"
          fill="currentColor"
        />
      ) : null}
    </svg>
  );
}
