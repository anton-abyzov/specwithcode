/**
 * The project panel's Board tab: SpecWeave increments as cards in Planned,
 * Active, In review and Done. Pure rules only; the pane is
 * components/studio/shell/BoardPane.tsx and the cards come from `projects.board`.
 */
import {
  PROJECT_BOARD_COLUMNS,
  PROJECT_BOARD_DONE_MAX,
  type ProjectBoardCard,
  type ProjectBoardColumn,
  type ProjectBoardResult,
} from "@specweave-studio/contracts";

export const BOARD_COLUMN_LABELS: Record<ProjectBoardColumn, string> = {
  planned: "Planned",
  active: "Active",
  review: "In review",
  done: "Done",
};

/** Cards a column shows before "Show more", and how many each click adds. */
export const BOARD_COLUMN_PAGE = 40;
/** Done cards each "Show older" click asks the server for on top of what it has. */
export const BOARD_DONE_STEP = 60;

/**
 * Stacked in a narrow panel, the work in motion comes first; side by side the
 * columns read left to right in the order work moves.
 */
export const BOARD_STACK_ORDER: Record<ProjectBoardColumn, number> = {
  active: 0,
  review: 1,
  planned: 2,
  done: 3,
};

export function boardColumns(
  cards: ReadonlyArray<ProjectBoardCard>,
): Record<ProjectBoardColumn, ProjectBoardCard[]> {
  const columns: Record<ProjectBoardColumn, ProjectBoardCard[]> = {
    planned: [],
    active: [],
    review: [],
    done: [],
  };
  for (const card of cards) columns[card.column].push(card);
  return columns;
}

/** `1334-direct-lan-path` → `1334`; a folder with no number keeps its name. */
export function incrementNumber(incrementId: string): string {
  return /^\d{4,}[A-Za-z]?/.exec(incrementId)?.[0] ?? incrementId;
}

/** The card's heading: its title, else the folder name without its number, in words. */
export function boardCardTitle(card: Pick<ProjectBoardCard, "incrementId" | "title">): string {
  if (card.title) return card.title;
  const rest = card.incrementId.slice(incrementNumber(card.incrementId).length).replace(/^-/, "");
  return rest ? rest.replaceAll("-", " ") : card.incrementId;
}

/** `https://github.com/acme/app/pull/371` → `#371`. */
export function pullRequestLabel(url: string): string {
  const number = /\/pull\/(\d+)/.exec(url)?.[1];
  return number ? `#${number}` : "PR";
}

export function boardProgress(tasks: ProjectBoardCard["tasks"]): {
  readonly label: string;
  readonly percent: number;
} | null {
  if (tasks.total <= 0) return null;
  const done = Math.min(tasks.done, tasks.total);
  return {
    label: `${done}/${tasks.total} ${tasks.total === 1 ? "task" : "tasks"}`,
    percent: Math.round((done / tasks.total) * 100),
  };
}

/**
 * What sits under a column's cards: more of what the client already holds,
 * then, for Done only, older cards the server has not sent yet.
 */
export function boardColumnMore(input: {
  readonly column: ProjectBoardColumn;
  readonly held: number;
  readonly shown: number;
  readonly total: number;
}): { readonly kind: "more" | "older"; readonly label: string } | null {
  const hidden = input.held - input.shown;
  if (hidden > 0) {
    return { kind: "more", label: `Show ${Math.min(hidden, BOARD_COLUMN_PAGE)} more` };
  }
  if (input.column === "done" && input.total > input.held && input.held < PROJECT_BOARD_DONE_MAX) {
    return { kind: "older", label: "Show older" };
  }
  return null;
}

export function boardIsEmpty(result: Pick<ProjectBoardResult, "counts">): boolean {
  return PROJECT_BOARD_COLUMNS.every((column) => result.counts[column] === 0);
}

export { PROJECT_BOARD_COLUMNS };
