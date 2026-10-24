/**
 * Threads that changed code in a SpecWeave project without an increment, a
 * declared small fix or "No increment needed": the Threads pane's notice (a
 * filter button plus Hide) and the chip on each such row. Increments are
 * recommended, not required, so this reads as information, never a warning.
 * See docs/studio/plan-progress.md.
 */
import { ListChecksIcon, XIcon } from "lucide-react";

import { Tip } from "./Tip";

export function UnplannedThreadsFilter({
  count,
  pressed,
  onToggle,
  onHide,
}: {
  count: number;
  pressed: boolean;
  onToggle: () => void;
  /** Hides the notice for this project; the sort menu turns it back on. */
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
        <ListChecksIcon aria-hidden />
        {count === 1
          ? "1 thread changed code without an increment"
          : `${count} threads changed code without an increment`}
        {pressed ? <span className="sws-unplanned-clear">Show all</span> : null}
      </button>
      <Tip label="Hide this notice. Turn it back on from the sort menu." side="bottom">
        <button
          type="button"
          className="sws-unplanned-hide"
          aria-label="Hide the notice about threads without an increment"
          data-unplanned-hide
          onClick={onHide}
        >
          <XIcon aria-hidden />
        </button>
      </Tip>
    </span>
  );
}

/** Not a button: it sits inside the row's open button, like the progress chip. */
export function UnplannedThreadChip() {
  return (
    <Tip
      label="Changed code without an increment. Increments are recommended, not required."
      side="top"
    >
      {/* The row's separator dot goes on the outer span, outside the pill. */}
      <span className="sws-thread-unplanned" data-thread-unplanned>
        <span>No increment</span>
      </span>
    </Tip>
  );
}
