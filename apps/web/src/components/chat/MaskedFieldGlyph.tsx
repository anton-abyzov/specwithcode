import type { SVGProps } from "react";

import { cn } from "~/lib/utils";

/**
 * A field whose value is hidden: a rounded input with three masking dots.
 * Drawn on EffortGlyph's 16px grid in the current text color.
 */
export function MaskedFieldGlyph({ className, ...props }: Omit<SVGProps<SVGSVGElement>, "ref">) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className={cn("shrink-0", className)}
      data-masked-field-glyph=""
      {...props}
    >
      <rect
        x={1.75}
        y={4.25}
        width={12.5}
        height={7.5}
        rx={2.25}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
      />
      <circle cx={5} cy={8} r={1.1} fill="currentColor" />
      <circle cx={8} cy={8} r={1.1} fill="currentColor" />
      <circle cx={11} cy={8} r={1.1} fill="currentColor" />
    </svg>
  );
}
