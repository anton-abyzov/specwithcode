/**
 * Where a thread's work stands, for the plan card in the thread and the
 * compact "3/5" beside it in lists. A SpecWeave increment the thread is bound
 * to wins; otherwise the agent's own todo list (Claude TodoWrite, Codex plan
 * updates and the like). Pure rules only; see docs/studio/plan-progress.md.
 */
import type {
  OrchestrationV2ThreadPlanProgress,
  ThreadIncrementProgress,
  ThreadIncrementTaskStatus,
} from "@specweave-studio/contracts";
import {
  summarizePlanSteps,
  type PlanProgressSummary,
  type PlanStepState,
} from "@specweave-studio/shared/planProgress";

/** "none": a worker thread with neither, whose card offers to link an increment. */
export type ThreadPlanSource = "increment" | "todo" | "none";

export interface ThreadPlanStep {
  readonly key: string;
  /** The SpecWeave task id, such as `T-03`; null for a todo item. */
  readonly id: string | null;
  readonly text: string;
  readonly state: PlanStepState;
  /** Said beside the step: a block or skip reason, or "stale claim". */
  readonly note: string | null;
  /** The task this thread holds (its last ledger write claimed or blocked it). */
  readonly mine?: boolean;
  /** What the step links to: an https URL, or an absolute path on the thread's host. */
  readonly href?: string;
  /** The commit a done task's evidence names, when it gives no link. */
  readonly commit?: string;
  /** A done task whose evidence names no link or commit. */
  readonly unverified?: boolean;
  /** The agent's live todo list, nested under the task this thread holds. */
  readonly children?: ReadonlyArray<ThreadPlanStep>;
}

export interface ThreadPlanView extends PlanProgressSummary {
  readonly source: ThreadPlanSource;
  readonly steps: ReadonlyArray<ThreadPlanStep>;
  /** Present when the thread is bound to an increment, even one whose tasks cannot be read. */
  readonly increment: ThreadIncrementProgress | null;
  /** In a SpecWeave project, the thread changed code with no increment, small fix or "none". */
  readonly unplanned?: boolean;
}

export interface ThreadPlanCompact extends PlanProgressSummary {
  readonly source: Exclude<ThreadPlanSource, "none">;
  /** The increment id when the progress comes from one. */
  readonly label: string | null;
}

/** `0996` for `0996-connect-launches`: what a chip or card header has room for. */
export function incrementNumber(incrementId: string): string {
  return incrementId.replace(/^(\d+)-.*/u, "$1");
}

const TASK_STATE: Record<ThreadIncrementTaskStatus, PlanStepState> = {
  planned: "open",
  released: "open",
  stale: "open",
  claimed: "current",
  blocked: "blocked",
  done: "done",
  skipped: "skipped",
};

/** The task this thread holds: the one its last ledger write touched, while claimed or blocked. */
export function threadTaskId(increment: ThreadIncrementProgress): string | null {
  const task = increment.tasks.find((candidate) => candidate.id === increment.boundTaskId);
  return task && (task.status === "claimed" || task.status === "blocked") ? task.id : null;
}

export function incrementPlanSteps(
  increment: ThreadIncrementProgress,
  todo: ReadonlyArray<ThreadPlanStep> = [],
): ThreadPlanStep[] {
  const mine = threadTaskId(increment);
  // Without a held task, the live todo list belongs under the first task in progress.
  const parent = mine ?? increment.tasks.find((task) => task.status === "claimed")?.id ?? null;
  return increment.tasks.map((task) => ({
    key: task.id,
    id: task.id,
    // The ledger's card line as written: never rewritten into another tense.
    text: task.line ?? task.title,
    state: TASK_STATE[task.status],
    note: task.status === "stale" ? "Stale claim" : task.note,
    ...(task.link ? { href: task.link } : {}),
    ...(task.commit ? { commit: task.commit } : {}),
    ...(task.status === "done" && !task.link && !task.commit ? { unverified: true } : {}),
    ...(task.id === mine ? { mine: true } : {}),
    ...(task.id === parent && todo.length > 0 ? { children: todo } : {}),
  }));
}

/**
 * Like summarizePlanSteps, except that the task this thread holds is "now"
 * even when other agents hold earlier ones, and "next" is the first open task
 * after it.
 */
export function summarizeIncrementSteps(steps: ReadonlyArray<ThreadPlanStep>): PlanProgressSummary {
  const summary = summarizePlanSteps(steps);
  const index = steps.findIndex((step) => step.mine);
  if (index === -1) return summary;
  const open = (step: ThreadPlanStep) => step.state === "open";
  const next = steps.slice(index + 1).find(open) ?? steps.find(open) ?? null;
  return { ...summary, current: steps[index]!.text, next: next?.text ?? null };
}

export function todoPlanSteps(
  steps: ReadonlyArray<{ readonly step: string; readonly status: string }>,
): ThreadPlanStep[] {
  const seen = new Map<string, number>();
  return steps.map((step) => {
    const occurrence = seen.get(step.step) ?? 0;
    seen.set(step.step, occurrence + 1);
    return {
      key: `${step.step}:${occurrence}`,
      id: null,
      text: step.step,
      state:
        step.status === "completed" ? "done" : step.status === "inProgress" ? "current" : "open",
      note: null,
    };
  });
}

/**
 * The plan card's content, or null when the thread has neither an increment
 * nor a todo list. A worker thread (`alwaysShow`) and a thread that changed
 * code without a plan (`unplanned`) still get a card then, so each shows
 * where it stands and how to link its increment.
 */
export function deriveThreadPlanView(input: {
  readonly increment: ThreadIncrementProgress | null;
  readonly todoSteps: ReadonlyArray<{ readonly step: string; readonly status: string }> | null;
  readonly alwaysShow?: boolean;
  readonly unplanned?: boolean;
}): ThreadPlanView | null {
  const { increment } = input;
  const todo = input.todoSteps === null ? [] : todoPlanSteps(input.todoSteps);
  if (increment !== null && increment.readable && increment.tasks.length > 0) {
    const steps = incrementPlanSteps(increment, todo);
    return { source: "increment", steps, increment, ...summarizeIncrementSteps(steps) };
  }
  // A bound increment answers the question; the flag only applies without one.
  const unplanned = increment === null && input.unplanned === true ? { unplanned: true } : {};
  if (todo.length > 0) {
    return { source: "todo", steps: todo, increment, ...unplanned, ...summarizePlanSteps(todo) };
  }
  if (increment !== null) {
    return { source: "increment", steps: [], increment, ...summarizePlanSteps([]) };
  }
  if (input.alwaysShow || input.unplanned) {
    return { source: "none", steps: [], increment: null, ...unplanned, ...summarizePlanSteps([]) };
  }
  return null;
}

/**
 * The compact progress lists show, or null when there is nothing to count.
 * A bound increment always shows, `0/0` while it has no tasks yet, so the
 * row still names the increment the thread works on.
 */
export function compactThreadPlan(
  increment: ThreadIncrementProgress | null,
  todo: OrchestrationV2ThreadPlanProgress | null | undefined,
): ThreadPlanCompact | null {
  if (increment !== null && increment.readable && increment.tasks.length > 0) {
    return {
      source: "increment",
      label: increment.incrementId,
      ...summarizeIncrementSteps(incrementPlanSteps(increment)),
    };
  }
  if (increment !== null) {
    return {
      source: "increment",
      label: increment.incrementId,
      completed: 0,
      total: 0,
      current: null,
      next: null,
    };
  }
  if (todo && todo.total > 0) return { source: "todo", label: null, ...todo };
  return null;
}

export const BINDING_LABELS: Record<ThreadIncrementProgress["binding"], string> = {
  manual: "linked by hand",
  claim: "bound by SpecWeave for this thread",
  branch: "bound by its increment branch",
  checkpoint: "bound by SpecWeave's checkpoint",
  name: "matched by title or branch",
};

/** One sentence for a tooltip or screen reader: "Increment 0920: 3 of 5 done. Now: …. Next: …". */
export function describeThreadPlan(plan: ThreadPlanCompact): string {
  const head =
    plan.source === "increment" && plan.label !== null
      ? plan.total === 0
        ? `Increment ${plan.label}: no tasks yet.`
        : `Increment ${plan.label}: ${plan.completed} of ${plan.total} tasks done.`
      : `Plan: ${plan.completed} of ${plan.total} steps done.`;
  return [
    head,
    plan.current ? `Now: ${plan.current}.` : null,
    plan.next ? `Next: ${plan.next}.` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

/** Whether a step link opens in the browser (https) rather than as a file on the host. */
export function isExternalStepLink(href: string): boolean {
  return /^https:\/\//iu.test(href);
}

/**
 * Whether a host path names a file the app's viewer can show, by its
 * extension; a folder (an increment's `reports/`) goes to the editor.
 */
export function isDocumentPath(path: string): boolean {
  return /\.[a-z0-9]+$/iu.test(path.slice(path.lastIndexOf("/") + 1));
}

/**
 * `~/Projects/x` for a folder under a macOS or Linux home directory; the path
 * itself otherwise. The folder lives on the thread's host, whose home the
 * client does not know, so the usual home roots stand in for it.
 */
export function displayFolder(path: string): string {
  const home = /^(?:\/Users|\/home)\/[^/]+(?=\/|$)/u.exec(path)?.[0];
  return home === undefined ? path : `~${path.slice(home.length)}`;
}
