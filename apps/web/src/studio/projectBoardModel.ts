/**
 * The project panel's Board tab: SpecWeave increments as cards in Blocked,
 * Active, In review, Planned and Done. Pure rules only; the pane is
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
 * What sits under a group's cards: more of what the client already holds,
 * then, for Done only, older cards the server has not sent yet.
 */
export function boardColumnMore(input: {
  readonly column: BoardGroupId;
  /** Cards of the group the board holds, after any filter. */
  readonly held: number;
  readonly shown: number;
  /** Done cards the server has sent, whatever a filter keeps; `held` when absent. */
  readonly loaded?: number;
  /** Done cards the server counts. */
  readonly total: number;
}): { readonly kind: "more" | "older"; readonly label: string } | null {
  const hidden = input.held - input.shown;
  if (hidden > 0) {
    return { kind: "more", label: `Show ${Math.min(hidden, BOARD_COLUMN_PAGE)} more` };
  }
  const loaded = input.loaded ?? input.held;
  if (input.column === "done" && input.total > loaded && loaded < PROJECT_BOARD_DONE_MAX) {
    return { kind: "older", label: "Show older" };
  }
  return null;
}

export function boardIsEmpty(result: Pick<ProjectBoardResult, "counts">): boolean {
  return PROJECT_BOARD_COLUMNS.every((column) => result.counts[column] === 0);
}

export { PROJECT_BOARD_COLUMNS };

/** Thread lines a card shows before "N more". */
export const BOARD_CARD_THREADS = 2;

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

/**
 * A thread on a machine that cannot be reached may still hold the work: it is
 * not resolved, only out of sight. A request to start or continue such an
 * increment names that thread and its machine and asks the coordinator to
 * check first, so a second worker is not started beside it. Empty without one.
 */
export function boardOutOfReachNote(
  threads: ReadonlyArray<{
    readonly tone: string;
    readonly thread: { readonly title: string };
    readonly machine: { readonly label: string };
  }>,
): string {
  const held = threads.filter((entry) => entry.tone === "unknown");
  const first = held[0];
  if (first === undefined) return "";
  const machine = first.machine.label.split(" → ").at(-1) ?? first.machine.label;
  const others = held.length - 1;
  const more = others === 0 ? "" : ` and ${others} more ${others === 1 ? "thread" : "threads"}`;
  return ` Check first: the thread "${first.thread.title || "Untitled thread"}" on ${machine}${more} cannot be reached now and may still hold this work. Do not start another worker beside it.`;
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
 * Whether the card is listed under Blocked: it is paused or has a blocked
 * task. A card that is both counts once; finished work never counts.
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
    reasons.push({
      taskId: null,
      text: boardNoteText(card.pausedReason ?? "") || "no reason given",
    });
  for (const blocker of card.blockers ?? [])
    reasons.push({
      taskId: blocker.taskId,
      text: boardNoteText(blocker.note ?? "") || "blocked, no reason given",
    });
  return reasons;
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

/* Groups -------------------------------------------------------------------- */

/**
 * What the board lists cards under, in the order a stacked list shows them:
 * the stuck work first, then the work in motion. Blocked is not a column of
 * the server's; it is every open card that is paused or has a blocked task.
 */
export const BOARD_GROUPS = ["blocked", "active", "review", "planned", "done"] as const;
export type BoardGroupId = (typeof BOARD_GROUPS)[number];

/** Side by side, Blocked is a band on top and the columns read in the order work moves. */
export const BOARD_GROUPS_WIDE: ReadonlyArray<BoardGroupId> = ["blocked", ...PROJECT_BOARD_COLUMNS];

export const BOARD_GROUP_LABELS: Record<BoardGroupId, string> = {
  blocked: "Blocked",
  ...BOARD_COLUMN_LABELS,
};

/** The one group a card is listed under. */
export function boardCardGroup(card: BlockedFields): BoardGroupId {
  return boardCardBlocked(card) ? "blocked" : card.column;
}

export function boardGroups<C extends BlockedFields>(
  cards: ReadonlyArray<C>,
): Record<BoardGroupId, C[]> {
  const groups: Record<BoardGroupId, C[]> = {
    blocked: [],
    active: [],
    review: [],
    planned: [],
    done: [],
  };
  for (const card of cards) groups[boardCardGroup(card)].push(card);
  return groups;
}

/**
 * What each heading counts. The server cuts only Done, and a Done card is
 * never blocked, so every blocked card is held: a column's count is the
 * server's less the cards that moved to Blocked, and the five add up.
 */
export function boardGroupCounts(
  counts: ProjectBoardResult["counts"],
  blocked: ReadonlyArray<Pick<ProjectBoardCard, "column">>,
): Record<BoardGroupId, number> {
  const result: Record<BoardGroupId, number> = { blocked: blocked.length, ...counts };
  for (const card of blocked) result[card.column] = Math.max(0, result[card.column] - 1);
  return result;
}

/** The label a card under Blocked carries, so it still says where the work stands. */
export function boardStateLabel(card: BlockedFields): string | undefined {
  return boardCardGroup(card) === "blocked" ? BOARD_COLUMN_LABELS[card.column] : undefined;
}

/* Machines ------------------------------------------------------------------ */

/** What the edge, the legend and the filter read of a card's thread. */
export interface BoardMachineThread {
  readonly tone: string;
  /** The machine's color id. */
  readonly color: string;
  readonly machine: {
    readonly executionMachineId: string;
    readonly label: string;
    readonly moved: boolean;
  };
}

export interface BoardCardMachine {
  readonly id: string;
  readonly name: string;
  readonly color: string;
}

/** Segments a card's edge shows; its label and the legend name every machine. */
export const BOARD_EDGE_MACHINES = 3;

/** The edge in words: "Runs on desk, laptop and 2 more machines". */
export function boardEdgeLabel(machines: ReadonlyArray<Pick<BoardCardMachine, "name">>): string {
  const named = machines.slice(0, BOARD_EDGE_MACHINES).map((machine) => machine.name);
  const rest = machines.length - named.length;
  if (rest > 0)
    return `Runs on ${named.join(", ")} and ${rest} more ${rest === 1 ? "machine" : "machines"}`;
  const last = named.pop();
  return named.length === 0 ? `Runs on ${last}` : `Runs on ${named.join(", ")} and ${last}`;
}

/**
 * The machines a card's work runs on: one entry per machine that has a
 * thread of the card which is not resolved, in the card's thread order. A
 * thread on a machine that cannot be reached still counts; its line names it.
 */
export function boardCardMachines(threads: ReadonlyArray<BoardMachineThread>): BoardCardMachine[] {
  const machines = new Map<string, BoardCardMachine>();
  for (const thread of threads) {
    if (thread.tone === "resolved") continue;
    const id = thread.machine.executionMachineId;
    if (machines.has(id)) continue;
    machines.set(id, {
      id,
      name: thread.machine.label.split(" → ").at(-1) ?? thread.machine.label,
      color: thread.color,
    });
  }
  return [...machines.values()];
}

/** The filter entry for open work nobody holds. */
export const BOARD_NO_THREAD = "no-thread";

export interface BoardMachineOption {
  /** A machine id, or `BOARD_NO_THREAD`. */
  readonly id: string;
  readonly name: string;
  /** Null for "No thread". */
  readonly color: string | null;
  readonly cards: number;
}

/**
 * Whether the machine filter keeps the card: the same rule the edge is drawn
 * by. The edge, the legend and the filter speak of open work only: finished
 * work runs nowhere, and only its newest cards are loaded.
 */
export function boardCardOnMachine(
  card: Pick<ProjectBoardCard, "column">,
  threads: ReadonlyArray<BoardMachineThread>,
  pick: string | null,
): boolean {
  if (pick === null) return true;
  if (card.column === "done") return false;
  const machines = boardCardMachines(threads);
  if (pick === BOARD_NO_THREAD) return machines.length === 0;
  return machines.some((machine) => machine.id === pick);
}

/**
 * The legend's entries: each machine with an open card, most cards first, then
 * "No thread" for open cards without an unresolved thread. That last one is
 * only known once every thread has said which increment it works on.
 */
export function boardMachineOptions(
  cards: ReadonlyArray<Pick<ProjectBoardCard, "incrementId" | "column">>,
  threads: ReadonlyMap<string, ReadonlyArray<BoardMachineThread>>,
  answered: boolean,
): BoardMachineOption[] {
  const options = new Map<string, { name: string; color: string; cards: number }>();
  let free = 0;
  for (const card of cards) {
    if (card.column === "done") continue;
    const machines = boardCardMachines(threads.get(card.incrementId) ?? []);
    if (machines.length === 0) free += 1;
    for (const machine of machines) {
      const held = options.get(machine.id);
      if (held) held.cards += 1;
      else options.set(machine.id, { name: machine.name, color: machine.color, cards: 1 });
    }
  }
  const result: BoardMachineOption[] = [...options]
    .map(([id, entry]) => ({ id, ...entry }))
    .toSorted((left, right) => right.cards - left.cards || left.name.localeCompare(right.name));
  if (answered && free > 0 && result.length > 0)
    result.push({ id: BOARD_NO_THREAD, name: "No thread", color: null, cards: free });
  return result;
}

/* Reasons and pull requests ------------------------------------------------- */

const isDigit = (value: string | undefined) => value !== undefined && /\p{N}/u.test(value);

/**
 * A run of text without a space that is one thing and not squeezed prose: a
 * link, a path or a file name. A slash between two numbers is a ratio
 * ("12/40"), not a path.
 */
function isOneThing(token: string): boolean {
  if (token.includes("://") || token.includes("\\") || /^(data|mailto|file):/i.test(token))
    return true;
  if (/\p{L}\/|\/\p{L}|^[.~]*\//u.test(token)) return true;
  return /\.[\p{L}\p{N}]{1,8}$/u.test(token.replace(/[.,;:!?)\]]+$/, ""));
}

const OPENERS = "([{";
const CLOSERS = ")]}";

/**
 * Adds the space a writer left out after a comma or semicolon. `depth` is how
 * many brackets are open before the token: a list in brackets may hold spaces.
 * `from` is where the token starts in its note and `loose` holds the places of
 * brackets that never close, which open nothing.
 */
function spaceAfterMarks(
  token: string,
  depth: number,
  from: number,
  loose: ReadonlySet<number>,
): { text: string; depth: number } {
  let open = depth;
  const bracket = (mark: string, at: number) => {
    if (OPENERS.includes(mark)) open += loose.has(from + at) ? 0 : 1;
    else if (CLOSERS.includes(mark)) open = Math.max(0, open - 1);
  };
  if (isOneThing(token)) {
    for (let at = 0; at < token.length; at += 1) bracket(token[at]!, at);
    return { text: token, depth: open };
  }
  let result = "";
  for (let at = 0; at < token.length; at += 1) {
    const mark = token[at]!;
    result += mark;
    bracket(mark, at);
    if (mark !== "," && mark !== ";") continue;
    const next = token[at + 1];
    if (next === undefined || !/[\p{L}\p{N}]/u.test(next)) continue;
    // Arguments and lists in brackets ("f(a,b)") are written that way.
    if (open > 0) continue;
    // "1,234" and "1,5x" are one number, and "&amp;" is one character.
    if (mark === "," && isDigit(token[at - 1]) && isDigit(next)) continue;
    if (mark === ";" && /&#?\w+;$/.test(result)) continue;
    result += " ";
  }
  return { text: result, depth: open };
}

/**
 * A block or pause reason as the board shows it: punctuation spacing only.
 * Agents often write these with the spaces squeezed out. Outside backticks
 * this collapses runs of whitespace and puts the space back after a comma or
 * semicolon that a letter or digit (of any script) follows, except between two
 * digits, inside brackets, in a character reference and in a link, path or
 * file name. It never splits a word: where a word ends inside a squeezed run
 * of letters and digits cannot be known, and a guess would also cut task ids,
 * versions and hashes. Text in backticks is left exactly as written. Requests
 * to the coordinator quote the note unrepaired.
 */
export function boardNoteText(note: string): string {
  const parts = note.split(/(`[^`]*`)/);
  // A list in brackets may run across spaces, so the depth is carried from
  // word to word. A bracket that never closes is not a list (":(" or a
  // sentence cut short) and opens nothing, or everything after it would be
  // left unrepaired; the lists that do close stay as written.
  const unclosed: number[] = [];
  let offset = 0;
  parts.forEach((part, index) => {
    if (index % 2 === 0)
      for (let at = 0; at < part.length; at += 1) {
        if (OPENERS.includes(part[at]!)) unclosed.push(offset + at);
        else if (CLOSERS.includes(part[at]!)) unclosed.pop();
      }
    offset += part.length;
  });
  const loose = new Set(unclosed);
  let depth = 0;
  offset = 0;
  return parts
    .map((part, index) => {
      let from = offset;
      offset += part.length;
      if (index % 2 === 1) return part;
      return part
        .split(/(\s+)/)
        .map((token, order) => {
          const start = from;
          from += token.length;
          if (order % 2 === 1) return " ";
          const spaced = spaceAfterMarks(token, depth, start, loose);
          depth = spaced.depth;
          return spaced.text;
        })
        .join("");
    })
    .join("")
    .trim();
}

/** What a pull request's state reads as beside its number. */
const PULL_REQUEST_STATE_WORDS: Record<string, string> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
};

/**
 * What the project's threads know of each pull request, by URL. Only a link a
 * thread has read from the host has a state; one it only linked has no word,
 * and "Open" is never assumed. The newest link wins.
 */
export function boardPullRequestStates(
  threads: ReadonlyArray<{
    readonly deletedAt?: string | null | undefined;
    readonly pullRequests?:
      | ReadonlyArray<{
          readonly url: string;
          readonly source?: string | undefined;
          readonly linkedAt: string;
          readonly snapshot?:
            | { readonly state: string; readonly isDraft?: boolean | undefined }
            | null
            | undefined;
        }>
      | undefined;
  }>,
): Map<string, string> {
  const newest = new Map<string, { linkedAt: string; word: string }>();
  for (const thread of threads) {
    if (thread.deletedAt != null) continue;
    for (const link of thread.pullRequests ?? []) {
      const snapshot = link.snapshot;
      if (link.source === "stack-dismissed" || !snapshot) continue;
      const state = snapshot.state === "open" && snapshot.isDraft ? "draft" : snapshot.state;
      const held = newest.get(link.url);
      if (held && held.linkedAt >= link.linkedAt) continue;
      newest.set(link.url, {
        linkedAt: link.linkedAt,
        word: PULL_REQUEST_STATE_WORDS[state] ?? state,
      });
    }
  }
  return new Map([...newest].map(([url, entry]) => [url, entry.word]));
}

export type BoardPullRequestChip =
  | { readonly kind: "one"; readonly url: string; readonly label: string }
  | {
      readonly kind: "many";
      readonly label: string;
      readonly items: ReadonlyArray<{ readonly url: string; readonly label: string }>;
    };

/** One chip for a card's pull requests: the number of a single one, else "N PRs" and a menu. */
export function boardPullRequestChip(urls: ReadonlyArray<string>): BoardPullRequestChip | null {
  const [first] = urls;
  if (first === undefined) return null;
  if (urls.length === 1) return { kind: "one", url: first, label: pullRequestLabel(first) };
  return {
    kind: "many",
    label: `${urls.length} PRs`,
    items: urls.map((url) => ({ url, label: pullRequestLabel(url) })),
  };
}

/* Where a card was read from, and how far the project folder lags ---------- */

/** Fills `{name}` slots in an English phrase, translated or not (`useTx`). */
type BoardPhrase = (english: string, values?: Readonly<Record<string, string | number>>) => string;

/**
 * Increments of the project that are not done: Planned, Active and In review.
 * The server's whole-project count when it sends one, so a search does not
 * change it; an older server's column counts otherwise.
 */
export function boardNotDone(result: Pick<ProjectBoardResult, "counts" | "notDone">): number {
  return result.notDone ?? result.counts.planned + result.counts.active + result.counts.review;
}

/** The tooltip of a card's source line. */
export const boardSourceTitle = (tx: BoardPhrase) =>
  tx("This is the newest copy of the increment. The project folder's copy is older or missing.");

/**
 * "From worktree fix-x" or "From origin/main" for a card whose copy is not the
 * project folder's. With `age` (compactAge of when the branch was last
 * fetched: "2h", "now", or "" when unknown) a remote copy also says that.
 */
export function boardSourceLine(
  source: NonNullable<ProjectBoardCard["source"]>,
  tx: BoardPhrase,
  age = "",
): string {
  if (source.kind === "worktree") return tx("From worktree {name}", { name: source.name });
  if (age === "now") return tx("From {branch}, fetched just now", { branch: source.name });
  if (age !== "") return tx("From {branch}, fetched {age} ago", { branch: source.name, age });
  return tx("From {branch}", { branch: source.name });
}

/**
 * "Project folder is 61 commits behind origin/main", with a title that adds
 * when the branch was last fetched; null when it is not behind or the server
 * does not say.
 */
export function boardBehindLine(
  behind: ProjectBoardResult["behind"],
  tx: BoardPhrase,
  age = "",
): { readonly text: string; readonly title: string } | null {
  if (behind === undefined || behind.count <= 0) return null;
  const values = { count: behind.count, branch: behind.ref };
  const text =
    behind.count === 1
      ? tx("Project folder is {count} commit behind {branch}", values)
      : tx("Project folder is {count} commits behind {branch}", values);
  const fetched =
    age === "now"
      ? tx("Last fetched just now.")
      : age !== ""
        ? tx("Last fetched {age} ago.", { age })
        : null;
  return { text, title: fetched ? `${text}. ${fetched}` : `${text}.` };
}
