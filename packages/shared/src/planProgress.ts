/**
 * Where a list of steps stands: how many are finished, the one being worked
 * and the one after it. Shared by the thread shell (an agent's own todo list)
 * and the SpecWeave increment card, so "3/5" means the same everywhere.
 */

export type PlanStepState = "done" | "current" | "open" | "blocked" | "skipped";

export interface PlanProgressStep {
  readonly text: string;
  readonly state: PlanStepState;
}

export interface PlanProgressSummary {
  /** Finished steps; skipped ones count as finished, as SpecWeave's closure gate counts them. */
  readonly completed: number;
  readonly total: number;
  /** The step in progress, else the first open one. Null when everything is finished. */
  readonly current: string | null;
  /** The open step after `current`, so a row can say what comes next. */
  readonly next: string | null;
}

const MAX_STEP_TEXT = 160;

function clip(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > MAX_STEP_TEXT ? `${flat.slice(0, MAX_STEP_TEXT - 1)}…` : flat;
}

export function summarizePlanSteps(steps: ReadonlyArray<PlanProgressStep>): PlanProgressSummary {
  const finished = (step: PlanProgressStep) => step.state === "done" || step.state === "skipped";
  const completed = steps.filter(finished).length;
  const currentIndex = (() => {
    const running = steps.findIndex((step) => step.state === "current");
    if (running !== -1) return running;
    return steps.findIndex((step) => !finished(step));
  })();
  const nextIndex =
    currentIndex === -1
      ? -1
      : steps.findIndex((step, index) => index > currentIndex && !finished(step));
  return {
    completed,
    total: steps.length,
    current: currentIndex === -1 ? null : clip(steps[currentIndex]!.text),
    next: nextIndex === -1 ? null : clip(steps[nextIndex]!.text),
  };
}

/** A provider todo list (`pending` / `running` / `completed`) as plan steps. */
export function todoStepsAsPlanSteps(
  steps: ReadonlyArray<{ readonly text: string; readonly status: string }>,
): PlanProgressStep[] {
  return steps.map((step) => ({
    text: step.text,
    state:
      step.status === "completed"
        ? "done"
        : step.status === "running"
          ? "current"
          : ("open" as const),
  }));
}

/**
 * The summary of a stored todo-list plan payload, or null when it is not one
 * or has no steps. Tolerant: the shell must never fail on a plan it cannot read.
 */
export function summarizeTodoPlanPayload(payload: unknown): PlanProgressSummary | null {
  if (typeof payload !== "object" || payload === null) return null;
  const plan = payload as { kind?: unknown; steps?: unknown };
  if (plan.kind !== "todo_list" || !Array.isArray(plan.steps)) return null;
  const steps = plan.steps.flatMap((step: unknown) => {
    if (typeof step !== "object" || step === null) return [];
    const { text, status } = step as { text?: unknown; status?: unknown };
    return typeof text === "string" && typeof status === "string" ? [{ text, status }] : [];
  });
  return steps.length === 0 ? null : summarizePlanSteps(todoStepsAsPlanSteps(steps));
}
