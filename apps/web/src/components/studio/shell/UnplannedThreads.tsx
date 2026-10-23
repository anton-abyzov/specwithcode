/**
 * Threads that changed code in a SpecWeave project without an increment, a
 * declared small fix or "No increment needed": the Threads pane's filter
 * button and the chip on each such row. See docs/studio/plan-progress.md.
 */
import { FileWarningIcon } from "lucide-react";

import { Tip } from "./Tip";

export function UnplannedThreadsFilter({
  count,
  pressed,
  onToggle,
}: {
  count: number;
  pressed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="sws-unplanned-filter"
      aria-pressed={pressed}
      data-unplanned-filter
      onClick={onToggle}
    >
      <FileWarningIcon aria-hidden />
      {count === 1
        ? "1 thread changed code without an increment"
        : `${count} threads changed code without an increment`}
      {pressed ? <span className="sws-unplanned-clear">Show all</span> : null}
    </button>
  );
}

/** Not a button: it sits inside the row's open button, like the progress chip. */
export function UnplannedThreadChip() {
  return (
    <Tip label="Changed code without an increment or a declared small fix" side="top">
      {/* The row's separator dot goes on the outer span, outside the pill. */}
      <span className="sws-thread-unplanned" data-thread-unplanned>
        <span>Unplanned</span>
      </span>
    </Tip>
  );
}
