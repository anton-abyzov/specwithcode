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

/** Thread lines a card shows before "N more". */
export const BOARD_CARD_THREADS = 3;

/** The states a card's thread line can be in, most urgent first. */
const TONE_URGENCY = ["waiting", "failed", "working", "background", "unknown", "idle", "resolved"];

/**
 * A card's threads in the order they matter: one that needs the person first,
 * then the ones at work, the resolved ones last; newest first within a state.
 */
export function boardThreadOrder<T extends { readonly tone: string; readonly updatedAt: string }>(
  threads: ReadonlyArray<T>,
): T[] {
  const rank = (tone: string) => {
    const index = TONE_URGENCY.indexOf(tone);
    return index === -1 ? TONE_URGENCY.length : index;
  };
  return threads.toSorted(
    (left, right) =>
      rank(left.tone) - rank(right.tone) || right.updatedAt.localeCompare(left.updatedAt),
  );
}

/**
 * What a click on the card itself opens. One thread works on it: that thread.
 * Several, or none: the spec, and each thread has its own line to click.
 */
export function boardCardTarget(input: {
  readonly threads: number;
  readonly specPath: string | null;
}): "thread" | "spec" | "none" {
  if (input.threads === 1) return "thread";
  return input.specPath === null ? "none" : "spec";
}

/**
 * The request an open card with no thread hands the coordinator, and the word
 * on its button; null for finished work.
 */
export function boardAsk(
  card: Pick<ProjectBoardCard, "incrementId" | "column" | "tasks">,
): { readonly label: string; readonly prompt: string } | null {
  if (card.column === "done") return null;
  if (card.column === "review")
    return {
      label: "Review and close",
      prompt: `Verify, review and close increment ${card.incrementId}.`,
    };
  const started = card.column === "active" && card.tasks.done > 0;
  return {
    label: started ? "Continue" : "Start",
    prompt: started
      ? `Continue increment ${card.incrementId}: pick up its next open task.`
      : `Start work on increment ${card.incrementId}: read its spec and begin with the first task.`,
  };
}
