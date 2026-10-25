/**
 * Threads that changed code in a SpecWeave project without an increment, a
 * declared small fix or "No increment needed": the Threads pane's notice (a
 * filter button plus Dismiss) and the glyph on each such row. Increments are
 * recommended, not required, so this reads as information, never a warning.
 * See docs/studio/plan-progress.md.
 */
import type { SVGProps } from "react";
import { XIcon } from "lucide-react";

import { cn } from "~/lib/utils";

import { Tip } from "./Tip";

/**
 * Finding the way without a map: a compass needle, its leading half a faint tint like
 * the fallback detour's cut road. 16px grid, the same 1.75px weight as the fallback
 * glyph, and a silhouette apart from the plan's list and the pull request's branch on
 * the same line. Calm, with no warning mark, since an increment is recommended, not
 * required.
 */
export function UnplannedGlyph({ className, ...props }: Omit<SVGProps<SVGSVGElement>, "ref">) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={cn("shrink-0", className)}
      data-unplanned-glyph=""
      {...props}
    >
      <path
        d="M12.75 3.25 9.75 9.75 6.25 6.25Z"
        fill="currentColor"
        fillOpacity={0.35}
        stroke="none"
      />
      <path d="M12.75 3.25 9.75 9.75 3.25 12.75 6.25 6.25Z" />
      <path d="M6.25 6.25 9.75 9.75" />
    </svg>
  );
}

export function UnplannedThreadsFilter({
  count,
  pressed,
  onToggle,
  onHide,
}: {
  count: number;
  pressed: boolean;
  onToggle: () => void;
  /** Acknowledges the threads counted now; the notice returns for a new one. */
  onHide: () => void;
}) {
  return (
    <span className="sws-unplanned-notice" data-unplanned-notice>
      <button
        type="button"
        className="sws-unplanned-filter"
        aria-pressed={pressed}
        data-unplanned-filter
        onClick={onToggle}
      >
        {/* The same glyph as each row, so the notice explains it. */}
        <UnplannedGlyph />
        {count === 1
          ? "1 thread changed code without an increment"
          : `${count} threads changed code without an increment`}
        {pressed ? <span className="sws-unplanned-clear">Show all</span> : null}
      </button>
      <Tip
        label="Dismiss. It comes back only when another thread changes code without an increment. Turn it off for good from the sort menu."
        side="bottom"
      >
        <button
          type="button"
          className="sws-unplanned-hide"
          aria-label="Dismiss the notice about threads without an increment"
          data-unplanned-hide
          onClick={onHide}
        >
          <XIcon aria-hidden />
        </button>
      </Tip>
    </span>
  );
}

/**
 * Not a button: it sits inside the row's open button, like the progress chip. The
 * glyph alone keeps the meta line short. Hover names it; keyboard focus lands on the
 * row, whose accessible name carries the same words; a tap opens the thread, whose
 * plan bar says "No increment" in full. Only a viewer who can change the thread is told
 * where to act: a read-only viewer's plan bar has no "Link increment" or "No increment
 * needed".
 */
export function UnplannedThreadChip(props: { canAct: boolean }) {
  const action = props.canAct
    ? "Open the thread to link an increment or mark it not needed."
    : null;
  return (
    <Tip
      label={
        <span className="sws-model-state-tip">
          <strong>No increment</strong>
          <span className="sws-model-state-tip-detail">
            Changed code without an increment. Increments are recommended, not required.
          </span>
          {action ? <span className="sws-model-state-tip-detail">{action}</span> : null}
        </span>
      }
      side="top"
    >
      <span className="sws-thread-unplanned" data-thread-unplanned>
        <UnplannedGlyph />
        <span className="sr-only">
          {`No increment: changed code without an increment.${action ? ` ${action}` : ""}`}
        </span>
      </span>
    </Tip>
  );
}
