/**
 * One group of the board: a heading that folds it, its cards, and what sits
 * under them. Folded, the cards are not rendered at all, so the keyboard and
 * the card walk never land in them; side by side a folded column is a rail.
 */
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { BoardGroupId } from "../../../studio/projectBoardModel";

export function BoardGroupSection(props: {
  group: BoardGroupId;
  label: string;
  /** What the heading counts: every card of the group, or the ones a filter keeps. */
  count: number;
  folded: boolean;
  /** A search opens every group on purpose; folding one then would change nothing. */
  locked: boolean;
  onToggle: () => void;
  /** Cards and, under them, "Show more" and notes. */
  children: ReactNode;
}) {
  const { group, label, count, folded, locked } = props;
  const headingId = `sws-board-${group}`;
  const listId = `sws-board-${group}-cards`;
  return (
    <section
      className="sws-board-group"
      data-group={group}
      data-folded={folded ? "" : undefined}
      aria-labelledby={headingId}
    >
      <h3 id={headingId}>
        <button
          type="button"
          className="sws-group-bar sws-board-group-bar"
          aria-expanded={!folded}
          aria-controls={folded ? undefined : listId}
          aria-disabled={locked || undefined}
          onClick={locked ? undefined : props.onToggle}
        >
          {folded ? <ChevronRightIcon aria-hidden /> : <ChevronDownIcon aria-hidden />}
          <span>{label}</span>
          <span className="sws-group-count">
            {count}
            <span className="sr-only"> {count === 1 ? "increment" : "increments"}</span>
          </span>
        </button>
      </h3>
      {folded ? null : (
        <div className="sws-board-group-body" id={listId}>
          {props.children}
        </div>
      )}
    </section>
  );
}
