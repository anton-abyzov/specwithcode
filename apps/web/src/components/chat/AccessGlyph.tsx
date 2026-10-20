import type { SVGProps } from "react";

import { cn } from "~/lib/utils";

export type AccessGlyphSteps = 0 | 1 | 2 | 3 | 4;

// 16px grid, same weight as EffortGlyph: a 270° dial open at the bottom, cut
// into four 2px segments with round ends, filling clockwise from lower left.
const CENTER_X = 8;
const CENTER_Y = 8.6;
const RADIUS = 6.25;
const START_DEGREES = 135;
const SEGMENT_DEGREES = 270 / 4;
const GAP_DEGREES = 26;

const point = (degrees: number) => {
  const radians = (degrees * Math.PI) / 180;
  const x = CENTER_X + RADIUS * Math.cos(radians);
  const y = CENTER_Y + RADIUS * Math.sin(radians);
  return `${x.toFixed(3)} ${y.toFixed(3)}`;
};

const SEGMENT_PATHS = [0, 1, 2, 3].map((index) => {
  const start = START_DEGREES + index * SEGMENT_DEGREES + GAP_DEGREES / 2;
  const end = START_DEGREES + (index + 1) * SEGMENT_DEGREES - GAP_DEGREES / 2;
  return `M${point(start)}A${RADIUS} ${RADIUS} 0 0 1 ${point(end)}`;
});

type GlyphProps = Omit<SVGProps<SVGSVGElement>, "ref">;

/**
 * How much an agent may do on its own, as a dial: more lit segments, fewer
 * prompts. Lit segments use the current text color, the rest a faint tint.
 */
export function AccessGlyph({
  steps,
  className,
  ...props
}: GlyphProps & { steps: AccessGlyphSteps }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className={cn("shrink-0", className)}
      data-access-glyph=""
      data-access-steps={steps}
      {...props}
    >
      {SEGMENT_PATHS.map((d, index) => (
        <path
          key={d}
          d={d}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          opacity={index < steps ? 1 : 0.25}
          data-filled={index < steps ? "true" : undefined}
        />
      ))}
      <circle cx={CENTER_X} cy={CENTER_Y} r={1.5} fill="currentColor" />
    </svg>
  );
}

export const ReadOnlyAccessGlyph = (props: GlyphProps) => <AccessGlyph steps={0} {...props} />;
export const SupervisedAccessGlyph = (props: GlyphProps) => <AccessGlyph steps={1} {...props} />;
export const AutoAcceptEditsAccessGlyph = (props: GlyphProps) => (
  <AccessGlyph steps={2} {...props} />
);
export const AutoAccessGlyph = (props: GlyphProps) => <AccessGlyph steps={3} {...props} />;
export const FullAccessGlyph = (props: GlyphProps) => <AccessGlyph steps={4} {...props} />;
