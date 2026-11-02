import type { SVGProps } from "react";

import { cn } from "~/lib/utils";
import type { ModStatGlyphName } from "./protocol";

type GlyphProps = Omit<SVGProps<SVGSVGElement>, "ref">;

// 16px grid, the same weight as EffortGlyph and AccessGlyph.
const GLYPH_PATHS: Record<ModStatGlyphName, ReadonlyArray<string>> = {
  // A closed circle with a bar across it: work that cannot move.
  blocked: ["M8 1.75a6.25 6.25 0 1 0 0 12.5a6.25 6.25 0 0 0 0-12.5Z", "M5 8h6"],
  // A clock with its hands set: a claim nobody has touched for a while.
  stale: ["M8 1.75a6.25 6.25 0 1 0 0 12.5a6.25 6.25 0 0 0 0-12.5Z", "M8 4.75V8l2.25 1.5"],
  // A check inside corner brackets: finished, waiting for proof.
  verify: [
    "M1.75 5V3.25a1.5 1.5 0 0 1 1.5-1.5H5",
    "M11 1.75h1.75a1.5 1.5 0 0 1 1.5 1.5V5",
    "M14.25 11v1.75a1.5 1.5 0 0 1-1.5 1.5H11",
    "M5 14.25H3.25a1.5 1.5 0 0 1-1.5-1.5V11",
    "m5.25 8.25 1.9 1.9 3.6-4",
  ],
  // Two ends of a line that do not meet: a criterion no task covers.
  gap: ["M1.75 8h3.5", "M10.75 8h3.5", "M6.75 3.5l-1.5 9", "M10.75 3.5l-1.5 9"],
  // A speech bubble: an agent waiting on an answer.
  waiting: [
    "M3.25 2.25h9.5a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H8l-3.25 2.5v-2.5h-1.5a1.5 1.5 0 0 1-1.5-1.5v-6a1.5 1.5 0 0 1 1.5-1.5Z",
  ],
  // A plain check: verified and able to close.
  ready: ["m2.5 8.5 3.75 3.75 7.25-8.25"],
};

/** Each glyph's color, set by the host so a mod cannot make a count look alarming. */
export const MOD_STAT_TONE_CLASS: Record<ModStatGlyphName, string> = {
  blocked: "text-destructive-foreground",
  stale: "text-warning-foreground",
  verify: "text-warning-foreground",
  gap: "text-warning-foreground",
  waiting: "text-foreground",
  ready: "text-success-foreground",
};

export function ModStatGlyph({
  name,
  className,
  ...props
}: GlyphProps & { name: ModStatGlyphName }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className={cn("shrink-0", className)}
      data-mod-stat-glyph={name}
      {...props}
    >
      {GLYPH_PATHS[name].map((d) => (
        <path
          key={d}
          d={d}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}
