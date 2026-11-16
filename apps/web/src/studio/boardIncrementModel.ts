/**
 * The board's increment view: one increment with its blockers, threads, tasks,
 * criteria and pull requests. Pure rules only; the view is
 * components/studio/shell/BoardIncrementView.tsx and its data comes from
 * `projects.boardIncrement` plus the thread list the board already holds.
 */
import type {
  ProjectBoardBlocker,
  ProjectBoardCard,
  ThreadIncrementCriterion,
  ThreadIncrementTask,
} from "@specweave-studio/contracts";

import {
  BOARD_COLUMN_LABELS,
  boardAsk,
  boardCardPaused,
  threadIsLive,
  threadShowsWork,
} from "./projectBoardModel";

/** Threads the view lists before "N more". */
export const BOARD_VIEW_THREADS = 5;
/** How often the view reads again while a thread works on the increment. */
export const BOARD_VIEW_REFRESH_MS = 10_000;

/** What the view needs to know about a thread linked to the increment. */
export interface ViewThread {
  readonly tone: string;
  /** How it is bound: only a `claim` says which task it wrote to. */
  readonly binding: string | null;
  readonly boundTaskId: string | null;
  /** The time of its last ledger write on that task. */
  readonly boundAt: string | null;
}

const sameInstant = (left: string | null | undefined, right: string | null | undefined) => {
  if (!left || !right) return false;
  const a = Date.parse(left);
  return Number.isFinite(a) && a === Date.parse(right);
};

type HeldTask = Pick<ThreadIncrementTask, "id" | "status" | "owner" | "changedAt" | "leased">;

/**
 * The one thread that holds a task, or null. A thread holds it only when
 * three things agree: the thread is bound by its own claim on that task, that
 * write is the very event that owns the task now (so the owner matches), and
 * the owner's two-hour lease still runs. Two threads that both fit are not
 * "the" holder, and a resolved or unreachable thread holds nothing.
 */
export function taskHolder<T extends ViewThread>(
  task: HeldTask,
  threads: ReadonlyArray<T>,
): T | null {
  if (task.leased !== true || !task.owner) return null;
  if (task.status !== "claimed" && task.status !== "blocked") return null;
  const fitting = threads.filter(
    (thread) =>
      threadIsLive(thread.tone) &&
      thread.binding === "claim" &&
      thread.boundTaskId === task.id &&
      sameInstant(thread.boundAt, task.changedAt),
  );
  return fitting.length === 1 ? fitting[0]! : null;
}

/**
 * What a thread's row says about its task: the one it holds, "linked, task
 * unknown" when nothing proves which, and nothing once it is resolved.
 */
export function threadTaskLabel<T extends ViewThread>(
  thread: T,
  tasks: ReadonlyArray<HeldTask>,
  threads: ReadonlyArray<T>,
): string | null {
  if (thread.tone === "resolved") return null;
  const held = tasks.find((task) => taskHolder(task, threads) === thread);
  return held ? `holds ${held.id}` : "linked, task unknown";
}

/** Live threads first in their urgency order, the rest behind "N more", resolved ones apart. */
export function viewThreadSections<T extends { readonly tone: string }>(
  threads: ReadonlyArray<T>,
  expanded: boolean,
): {
  readonly shown: ReadonlyArray<T>;
  readonly more: number;
  readonly finished: ReadonlyArray<T>;
} {
  const open = threads.filter((thread) => thread.tone !== "resolved");
  const shown = expanded ? open : open.slice(0, BOARD_VIEW_THREADS);
  return {
    shown,
    more: open.length - shown.length,
    finished: threads.filter((thread) => thread.tone === "resolved"),
  };
}

/* Blockers ------------------------------------------------------------------ */

const blockerFacts = (incrementId: string, blocker: ProjectBoardBlocker) =>
  [
    `Increment ${incrementId}, task ${blocker.taskId}${blocker.title ? ` "${blocker.title}"` : ""} is blocked.`,
    `Reason: ${blocker.note?.trim() || "none given"}.`,
    `Blocked by ${blocker.by ?? "an unknown writer"} at ${blocker.at ?? "an unknown time"}.`,
  ].join(" ");

/**
 * What a blocker offers. "Open that thread" needs one live thread that
 * provably holds the blocked task; without it the coordinator is asked, with
 * the task, the reason, who blocked it and when.
 */
export function blockerActions<T extends ViewThread>(input: {
  readonly incrementId: string;
  readonly blocker: ProjectBoardBlocker;
  readonly tasks: ReadonlyArray<HeldTask>;
  readonly threads: ReadonlyArray<T>;
}): {
  readonly thread: T | null;
  readonly unblock: { readonly label: string; readonly prompt: string };
  readonly ask: { readonly label: string; readonly prompt: string };
} {
  const { blocker } = input;
  const task = input.tasks.find((entry) => entry.id === blocker.taskId);
  const facts = blockerFacts(input.incrementId, blocker);
  return {
    thread: task ? taskHolder(task, input.threads) : null,
    unblock: {
      label: "Unblock with the coordinator",
      prompt: `${facts} Unblock it: resolve what it waits for, or tell me what only I can do.`,
    },
    ask: {
      label: `Ask the coordinator why ${blocker.taskId} is blocked`,
      prompt: `${facts} Find out why it is still blocked and what it needs.`,
    },
  };
}

/* Why it is in this column -------------------------------------------------- */

const count = (value: number, one: string, many: string) => `${value} ${value === 1 ? one : many}`;
const sentenceList = (parts: ReadonlyArray<string>) =>
  parts.length <= 1
    ? (parts[0] ?? "")
    : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;

/**
 * One sentence for a card whose column disagrees with its status file, null
 * when they agree. `movedByThreads` is the client's own move into Active.
 */
export function columnWhy(input: {
  readonly card: Pick<
    ProjectBoardCard,
    "column" | "status" | "tasks" | "columnReason" | "blockedTasks"
  >;
  readonly movedByThreads: boolean;
  readonly threadsAtWork: number;
}): { readonly column: string; readonly because: string; readonly status: string } | null {
  const { card } = input;
  const status = card.status === "unknown" ? "nothing" : card.status;
  if (card.column === "review" && card.columnReason === "tasks")
    return {
      column: BOARD_COLUMN_LABELS.review,
      because: "every task is done or skipped",
      status,
    };
  if (card.column !== "active" || (card.columnReason !== "ledger" && !input.movedByThreads))
    return null;
  const parts: string[] = [];
  if (card.tasks.done > 0) parts.push(count(card.tasks.done, "task is done", "tasks are done"));
  if ((card.blockedTasks ?? 0) > 0)
    parts.push(count(card.blockedTasks ?? 0, "task is blocked", "tasks are blocked"));
  if ((card.tasks.active ?? 0) > 0)
    parts.push(count(card.tasks.active ?? 0, "task is claimed", "tasks are claimed"));
  if (input.threadsAtWork > 0)
    parts.push(count(input.threadsAtWork, "thread is working", "threads are working"));
  if (parts.length === 0) parts.push("work has started");
  return { column: BOARD_COLUMN_LABELS.active, because: sentenceList(parts), status };
}

/** Threads that count as working: never an idle, resolved, offline or unknown one. */
export function threadsAtWork(threads: ReadonlyArray<{ readonly tone: string }>): number {
  return threads.filter((thread) => threadShowsWork(thread.tone)).length;
}

/* Actions ------------------------------------------------------------------- */

export type ViewPrimaryAction =
  | { readonly kind: "thread" }
  | { readonly kind: "ask"; readonly label: string; readonly prompt: string };

/**
 * The view's one primary action. A live thread on the increment: open it.
 * Otherwise what the card itself would ask the coordinator, or a request to
 * plan it when it has no spec or no tasks. Finished work has none.
 */
export function viewPrimaryAction(input: {
  readonly card: Pick<
    ProjectBoardCard,
    | "incrementId"
    | "column"
    | "tasks"
    | "status"
    | "paused"
    | "pausedReason"
    | "blockedTasks"
    | "specPath"
  >;
  readonly abandoned: boolean;
  readonly liveThreads: number;
}): ViewPrimaryAction | null {
  const { card } = input;
  if (card.column === "done" || input.abandoned) return null;
  if (input.liveThreads > 0) return { kind: "thread" };
  if (card.specPath === null)
    return {
      kind: "ask",
      label: "Plan it with the coordinator",
      prompt: `Plan increment ${card.incrementId}: it has a folder and a title but no spec.md. Write the problem, the acceptance criteria and the tasks.`,
    };
  if (card.tasks.total === 0 && !boardCardPaused(card))
    return {
      kind: "ask",
      label: "Plan the tasks",
      prompt: `Plan the tasks of increment ${card.incrementId}: its spec names none yet.`,
    };
  const ask = boardAsk(card);
  return ask ? { kind: "ask", ...ask } : null;
}

/** "Ask the coordinator" beside "Open thread": a question about the increment, left open. */
export function viewCoordinatorPrompt(incrementId: string): string {
  return `About increment ${incrementId}: `;
}

/* Tasks and criteria -------------------------------------------------------- */

const TASK_RANK: Record<ThreadIncrementTask["status"], number> = {
  blocked: 0,
  claimed: 1,
  stale: 2,
  planned: 3,
  released: 3,
  done: 4,
  skipped: 4,
};
export const TASK_STATUS_LABELS: Record<ThreadIncrementTask["status"], string> = {
  blocked: "Blocked",
  claimed: "In progress",
  stale: "Stale claim",
  planned: "Open",
  released: "Open",
  done: "Done",
  skipped: "Skipped",
};

/** Blocked first, then in progress, stale claims, open, and finished ones last; spec order within. */
export function viewTaskOrder<T extends Pick<ThreadIncrementTask, "status">>(
  tasks: ReadonlyArray<T>,
): T[] {
  return tasks
    .map((task, index) => ({ task, index }))
    .toSorted(
      (left, right) =>
        TASK_RANK[left.task.status] - TASK_RANK[right.task.status] || left.index - right.index,
    )
    .map((entry) => entry.task);
}

export const taskIsClosed = (task: Pick<ThreadIncrementTask, "status">) =>
  task.status === "done" || task.status === "skipped";

type CriterionState = NonNullable<ThreadIncrementCriterion["state"]>;
export const CRITERION_STATE_LABELS: Record<CriterionState, string> = {
  verified: "Verified",
  evidenced: "Done, not verified yet",
  declared: "Ticked in the spec, no evidence",
  skipped: "Skipped",
  open: "Open",
  uncovered: "No task covers it",
  unknown: "Unknown",
};

/** A criterion's proof state; an older server sends only `met`. */
export function criterionState(criterion: ThreadIncrementCriterion): CriterionState {
  return criterion.state ?? (criterion.met ? "evidenced" : "open");
}

/** "2 of 5 verified": how many criteria have verified proof, of all the spec names. */
export function criteriaSummary(criteria: ReadonlyArray<ThreadIncrementCriterion>): string | null {
  if (criteria.length === 0) return null;
  const verified = criteria.filter((entry) => criterionState(entry) === "verified").length;
  return `${verified} of ${criteria.length} verified`;
}

/** The first paragraph of the Problem, for the lines under the header. */
export function problemSummary(problem: string | null): string | null {
  const first = problem?.split(/\n\s*\n/u)[0]?.trim();
  return first ? first : null;
}
