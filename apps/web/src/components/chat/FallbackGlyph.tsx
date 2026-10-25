import type { SVGProps } from "react";

import { cn } from "~/lib/utils";

type GlyphProps = Omit<SVGProps<SVGSVGElement>, "ref">;

/**
 * A switched track: the picked model's line runs on faintly while the thread
 * branches up onto another one. 16px grid, the same 2px weight as EffortGlyph and
 * AccessGlyph; the track left behind is a faint tint, the branch the current color.
 */
export function FallbackGlyph({ className, ...props }: GlyphProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className={cn("shrink-0", className)}
      data-fallback-glyph=""
      {...props}
    >
      <path
        d="M8.5 11.5h6"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        opacity={0.4}
      />
      <path
        d="M1.5 11.5h3c3 0 3.5-7 6.5-7h3.25"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      />
      <path
        d="M12.25 2.25 14.5 4.5l-2.25 2.25"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
