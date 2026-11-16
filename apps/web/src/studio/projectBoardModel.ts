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

/** Thread states that show work on an increment; idle, offline and resolved ones do not. */
const WORK_TONES: ReadonlySet<string> = new Set(["working", "background", "waiting", "failed"]);
export function threadShowsWork(tone: string): boolean {
  return WORK_TONES.has(tone);
}

/** A thread that can still be opened and asked: not resolved and not on an unreachable machine. */
export function threadIsLive(tone: string): boolean {
  return tone !== "resolved" && tone !== "unknown";
}

/* Blocked state ------------------------------------------------------------ */

type BlockedFields = Pick<
  ProjectBoardCard,
  "blocked" | "status" | "column" | "tasks" | "paused" | "blockedTasks"
>;

/** An older server sends no `paused`; its status still says so. */
export function boardCardPaused(card: {
  readonly paused?: boolean | undefined;
  readonly status?: string | undefined;
}): boolean {
  return card.paused ?? card.status === "paused";
}

/**
 * Whether the Blocked only filter keeps the card: it is paused or has a
 * blocked task. A card that is both counts once; finished work never counts.
 */
export function boardCardBlocked(card: BlockedFields): boolean {
  if (card.column === "done") return false;
  return card.blocked || boardCardPaused(card) || (card.blockedTasks ?? 0) > 0;
}

const tasksBlocked = (count: number) => `${count} ${count === 1 ? "task" : "tasks"} blocked`;

/**
 * The chip that says what is stuck: the whole increment (Paused), some tasks,
 * or both. A bare "Blocked" is left only for a server too old to count them.
 */
export function boardBlockedChip(card: BlockedFields): string | null {
  if (!boardCardBlocked(card)) return null;
  const paused = boardCardPaused(card);
  const blocked = card.blockedTasks ?? 0;
  if (paused) return blocked > 0 ? `Paused + ${tasksBlocked(blocked)}` : "Paused";
  return blocked > 0 ? tasksBlocked(blocked) : "Blocked";
}

/** Some tasks are stuck but others are still open, so work can go on. */
export function boardRestCanContinue(card: BlockedFields): boolean {
  const blocked = card.blockedTasks ?? 0;
  if (card.column === "done" || blocked === 0 || boardCardPaused(card)) return false;
  return card.tasks.total - card.tasks.done > blocked;
}

/** Reason lines a card shows; the increment view lists every blocker. */
export const BOARD_CARD_REASONS = 2;

export interface BoardReason {
  /** The blocked task, or null for the pause of the whole increment. */
  readonly taskId: string | null;
  readonly text: string;
}

/** Why the card is stuck, the pause first, then the blocked tasks in spec order. */
export function boardReasons(
  card: Pick<ProjectBoardCard, "column" | "status" | "paused" | "pausedReason" | "blockers">,
): BoardReason[] {
  if (card.column === "done") return [];
  const reasons: BoardReason[] = [];
  if (boardCardPaused(card) && card.paused !== undefined)
    reasons.push({ taskId: null, text: card.pausedReason?.trim() || "no reason given" });
  for (const blocker of card.blockers ?? [])
    reasons.push({
      taskId: blocker.taskId,
      text: blocker.note?.trim() || "blocked, no reason given",
    });
  return reasons;
}

/** How many cards of each column the Blocked only filter keeps, and the cards themselves. */
export function boardBlockedCounts(
  columns: Record<ProjectBoardColumn, ReadonlyArray<ProjectBoardCard>>,
): Record<ProjectBoardColumn, number> & { readonly all: number } {
  const counts = { planned: 0, active: 0, review: 0, done: 0, all: 0 };
  for (const column of PROJECT_BOARD_COLUMNS) {
    counts[column] = columns[column].filter(boardCardBlocked).length;
    counts.all += counts[column];
  }
  return counts;
}

export function boardFilterLabel(blocked: number): string {
  return `Blocked only · ${blocked} ${blocked === 1 ? "card" : "cards"}`;
}

/* Column by evidence -------------------------------------------------------- */

/**
 * The planned cards a thread is at work on. The server already moved the ones
 * whose ledger shows work; the thread list is only known here.
 */
export function boardThreadEvidence(
  cards: ReadonlyArray<Pick<ProjectBoardCard, "incrementId" | "column">>,
  threads: ReadonlyMap<string, ReadonlyArray<{ readonly tone: string }>>,
): string[] {
  return cards
    .filter(
      (card) =>
        card.column === "planned" &&
        (threads.get(card.incrementId) ?? []).some((thread) => threadShowsWork(thread.tone)),
    )
    .map((card) => card.incrementId);
}

/** The cards threads moved into Active, and the board refresh they were last settled at. */
export interface BoardPromotions {
  readonly revision: number;
  readonly ids: ReadonlySet<string>;
}
export const NO_BOARD_PROMOTIONS: BoardPromotions = { revision: 0, ids: new Set() };

/**
 * A thread flips between working and idle many times a minute, and a card
 * must not jump columns with it. Within one board refresh a card only ever
 * moves into Active; the next refresh settles on what the threads say then.
 */
export function nextBoardPromotions(
  previous: BoardPromotions,
  revision: number,
  evidence: ReadonlyArray<string>,
): BoardPromotions {
  if (revision !== previous.revision) {
    const same =
      evidence.length === previous.ids.size && evidence.every((id) => previous.ids.has(id));
    return { revision, ids: same ? previous.ids : new Set(evidence) };
  }
  if (evidence.every((id) => previous.ids.has(id))) return previous;
  return { revision, ids: new Set([...previous.ids, ...evidence]) };
}

/**
 * The board with those cards in Active. Planned is never cut by the server,
 * so moving a card and its count is exact, and every heading counts what its
 * column shows.
 */
export function boardWithPromotions<R extends Pick<ProjectBoardResult, "cards" | "counts">>(
  result: R,
  promoted: ReadonlySet<string>,
): R {
  let moved = 0;
  const cards = result.cards.map((card) => {
    if (card.column !== "planned" || !promoted.has(card.incrementId)) return card;
    moved += 1;
    return { ...card, column: "active" as const };
  });
  if (moved === 0) return result;
  return {
    ...result,
    cards,
    counts: {
      ...result.counts,
      planned: result.counts.planned - moved,
      active: result.counts.active + moved,
    },
  };
}

/* Requests for the coordinator ---------------------------------------------- */

/**
 * The request an open card with no thread hands the coordinator, and the word
 * on its button; null for finished work. Paused work is resumed, not continued.
 */
export function boardAsk(
  card: Pick<ProjectBoardCard, "incrementId" | "column" | "tasks"> &
    Partial<Pick<ProjectBoardCard, "status" | "paused" | "pausedReason" | "blockedTasks">>,
): { readonly label: string; readonly prompt: string } | null {
  if (card.column === "done") return null;
  if (boardCardPaused(card)) {
    const reason = card.pausedReason?.trim();
    return {
      label: "Resume",
      prompt: `Resume increment ${card.incrementId}: it is paused${reason ? ` ("${reason}")` : ""}. Check whether that still holds, then pick up its next open task.`,
    };
  }
  if (card.column === "review")
    return {
      label: "Review and close",
      prompt: `Verify, review and close increment ${card.incrementId}.`,
    };
  const started =
    card.tasks.done > 0 || (card.tasks.active ?? 0) > 0 || (card.blockedTasks ?? 0) > 0;
  return {
    label: started ? "Continue" : "Start",
    prompt: started
      ? `Continue increment ${card.incrementId}: pick up its next open task.`
      : `Start work on increment ${card.incrementId}: read its spec and begin with the first task.`,
  };
}
