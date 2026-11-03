import type { ReactNode } from "react";

import { cn } from "../lib/utils";

/**
 * Keeps text measurable while the composer's outer label box collapses.
 *
 * `keepWhenCompact` holds a shorter, truncated label instead of collapsing to
 * the icon: the machine a chat runs on stays named in narrow composers, such
 * as the thread beside an open report.
 */
export function ComposerContextLabel({
  children,
  displayMode = "toolbar",
  keepWhenCompact = false,
}: {
  children: ReactNode;
  displayMode?: "toolbar" | "panel";
  keepWhenCompact?: boolean;
}) {
  return (
    <span
      data-composer-label
      className={cn(
        "min-w-0",
        displayMode === "panel"
          ? "flex-1 truncate text-left"
          : keepWhenCompact
            ? "max-w-[240px] group-data-[compact]/composer-context:max-w-[7rem]"
            : "max-w-[240px] group-data-[compact]/composer-context:max-w-0",
      )}
    >
      <span
        data-composer-label-motion
        className={cn(
          "block w-full min-w-0 truncate",
          displayMode === "toolbar" &&
            (keepWhenCompact
              ? "max-w-[240px]"
              : "max-w-[240px] transition-opacity duration-180 ease-drawer group-data-[compact]/composer-context:opacity-0 motion-reduce:transition-none"),
        )}
      >
        {children}
      </span>
    </span>
  );
}
