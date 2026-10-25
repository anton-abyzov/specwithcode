import type { ThreadIncrementProgress, ThreadId } from "@specweave-studio/contracts";
import { summarizeTodoPlanPayload } from "@specweave-studio/shared/planProgress";
import { describe, expect, it } from "vite-plus/test";

import {
  compactThreadPlan,
  deriveThreadPlanView,
  describeThreadPlan,
  displayFolder,
  incrementNumber,
  incrementPlanSteps,
  isDocumentPath,
  isExternalStepLink,
  BINDING_LABELS,
} from "./threadPlanProgress";

function increment(overrides: Partial<ThreadIncrementProgress> = {}): ThreadIncrementProgress {
  return {
    threadId: "t1" as ThreadId,
    incrementId: "0930-studio-plan-card",
    binding: "name",
    boundTaskId: null,
    title: "Plan card",
    status: "active",
    incrementPath: "/repo/.specweave/increments/0930-studio-plan-card",
    specPath: "/repo/.specweave/increments/0930-studio-plan-card/spec.md",
    readable: true,
    tasks: [
      { id: "T-01", title: "Contract", status: "done", criteria: [], note: null },
      { id: "T-02", title: "Reader", status: "claimed", criteria: [], note: null },
      { id: "T-03", title: "Card", status: "blocked", criteria: [], note: "Needs design" },
      { id: "T-04", title: "Docs", status: "skipped", criteria: [], note: "Later" },
      { id: "T-05", title: "Ship", status: "planned", criteria: [], note: null },
    ],
    criteria: [],
    verify: null,
    ...overrides,
  };
}

const todo = [
  { step: "Read", status: "completed" },
  { step: "Write", status: "inProgress" },
  { step: "Test", status: "pending" },
];

describe("deriveThreadPlanView", () => {
  it("gives a worker thread a card before it has an increment or todo list", () => {
    expect(deriveThreadPlanView({ increment: null, todoSteps: null })).toBeNull();
    const view = deriveThreadPlanView({ increment: null, todoSteps: null, alwaysShow: true })!;
    expect(view).toMatchObject({ source: "none", steps: [], increment: null, total: 0 });
    // A real plan still wins over the placeholder.
    expect(
      deriveThreadPlanView({ increment: null, todoSteps: todo, alwaysShow: true })?.source,
    ).toBe("todo");
  });
  it("uses the bound increment over the agent's todo list", () => {
    const view = deriveThreadPlanView({ increment: increment(), todoSteps: todo })!;
    expect(view.source).toBe("increment");
    expect(view).toMatchObject({ completed: 2, total: 5, current: "Reader", next: "Card" });
    expect(view.steps.map((step) => step.state)).toEqual([
      "done",
      "current",
      "blocked",
      "skipped",
      "open",
    ]);
  });

  it("makes the task this thread holds current and nests the live todo list under it", () => {
    const bound = increment({
      binding: "claim",
      boundTaskId: "T-04",
      tasks: [
        { id: "T-01", title: "Contract", status: "done", criteria: [], note: null },
        { id: "T-02", title: "Reader", status: "claimed", criteria: [], note: null },
        { id: "T-03", title: "Card", status: "planned", criteria: [], note: null },
        { id: "T-04", title: "Docs", status: "claimed", criteria: [], note: null },
        { id: "T-05", title: "Ship", status: "planned", criteria: [], note: null },
      ],
    });
    const view = deriveThreadPlanView({ increment: bound, todoSteps: todo })!;
    expect(view).toMatchObject({ completed: 1, total: 5, current: "Docs", next: "Ship" });
    const docs = view.steps.find((step) => step.id === "T-04")!;
    expect(docs.mine).toBe(true);
    expect(docs.children?.map((step) => [step.text, step.state])).toEqual([
      ["Read", "done"],
      ["Write", "current"],
      ["Test", "open"],
    ]);
    expect(view.steps.find((step) => step.id === "T-02")!.children).toBeUndefined();
    expect(compactThreadPlan(bound, null)).toMatchObject({ current: "Docs", next: "Ship" });
  });

  it("nests the todo list under the first task in progress when the thread holds none", () => {
    const view = deriveThreadPlanView({ increment: increment(), todoSteps: todo })!;
    expect(view.steps.find((step) => step.id === "T-02")!.children).toHaveLength(3);
    expect(view.steps.some((step) => step.mine)).toBe(false);
  });

  it("falls back to the todo list when the increment cannot be read, keeping its link", () => {
    const unreadable = increment({ readable: false, tasks: [] });
    const view = deriveThreadPlanView({ increment: unreadable, todoSteps: todo })!;
    expect(view).toMatchObject({ source: "todo", completed: 1, total: 3, current: "Write" });
    expect(view.increment).toBe(unreadable);
  });

  it("is null with neither", () => {
    expect(deriveThreadPlanView({ increment: null, todoSteps: [] })).toBeNull();
  });

  it("shows a card for a thread that changed code without a plan, flagged unplanned", () => {
    const none = deriveThreadPlanView({ increment: null, todoSteps: null, unplanned: true })!;
    expect(none).toMatchObject({ source: "none", unplanned: true, total: 0 });
    // Its todo list still leads, and keeps the flag for the card's actions.
    const withTodo = deriveThreadPlanView({ increment: null, todoSteps: todo, unplanned: true })!;
    expect(withTodo).toMatchObject({ source: "todo", unplanned: true, total: 3 });
    // A bound increment answers the question; a stale flag never shows over it.
    const bound = deriveThreadPlanView({
      increment: increment(),
      todoSteps: null,
      unplanned: true,
    })!;
    expect(bound.unplanned).toBeUndefined();
    expect(deriveThreadPlanView({ increment: null, todoSteps: null })).toBeNull();
  });
});

describe("compactThreadPlan", () => {
  it("says 2/5 for the increment and describes it for screen readers", () => {
    const compact = compactThreadPlan(increment(), {
      completed: 1,
      total: 1,
      current: null,
      next: null,
    })!;
    expect(compact).toMatchObject({ source: "increment", completed: 2, total: 5 });
    expect(describeThreadPlan(compact)).toBe(
      "Increment 0930-studio-plan-card: 2 of 5 tasks done. Now: Reader. Next: Card.",
    );
  });

  it("uses the shell's todo summary without an increment", () => {
    const shell = summarizeTodoPlanPayload({
      kind: "todo_list",
      steps: [
        { text: "Read", status: "completed" },
        { text: "Write", status: "running" },
      ],
    });
    expect(compactThreadPlan(null, shell)).toMatchObject({
      source: "todo",
      completed: 1,
      total: 2,
      current: "Write",
      next: null,
    });
    expect(compactThreadPlan(null, null)).toBeNull();
  });

  it("names a provider checklist as the agent's, never as an increment", () => {
    const compact = compactThreadPlan(null, { completed: 3, total: 5, current: null, next: null })!;
    expect(compact).toMatchObject({ source: "todo", label: null });
    expect(describeThreadPlan(compact)).toBe(
      "The agent's checklist, not an increment: 3 of 5 steps done.",
    );
  });

  it("still names a bound increment with no tasks yet, as 0/0", () => {
    const empty = increment({ incrementId: "0996-connect-launches", tasks: [] });
    const compact = compactThreadPlan(empty, {
      completed: 2,
      total: 4,
      current: null,
      next: null,
    })!;
    expect(compact).toEqual({
      source: "increment",
      label: "0996-connect-launches",
      completed: 0,
      total: 0,
      current: null,
      next: null,
    });
    expect(describeThreadPlan(compact)).toBe("Increment 0996-connect-launches: no tasks yet.");
    expect(incrementNumber(compact.label!)).toBe("0996");
  });
});

describe("displayFolder", () => {
  it("abbreviates home folders", () => {
    expect(displayFolder("/Users/anton/Projects/x")).toBe("~/Projects/x");
    expect(displayFolder("/home/dev")).toBe("~");
    expect(displayFolder("/srv/repo")).toBe("/srv/repo");
  });
});

describe("card lines and links", () => {
  const carded = increment({
    tasks: [
      {
        id: "T-01",
        title: "Contract",
        status: "done",
        criteria: [],
        note: null,
        line: "Wrote the contract",
        link: "https://github.com/o/r/pull/7",
      },
      {
        id: "T-02",
        title: "Reader",
        status: "done",
        criteria: [],
        note: null,
        link: "/repo/.specweave/increments/0930-studio-plan-card/reports/task-T-02.txt",
      },
      { id: "T-03", title: "Fold", status: "done", criteria: [], note: null, commit: "abc1234" },
      { id: "T-04", title: "Docs", status: "done", criteria: [], note: null },
      {
        id: "T-05",
        title: "Card",
        status: "claimed",
        criteria: [],
        note: null,
        line: "Rendering the rows",
      },
    ],
  });

  it("shows the ledger line as written, falling back to the title", () => {
    expect(incrementPlanSteps(carded).map((step) => step.text)).toEqual([
      "Wrote the contract",
      "Reader",
      "Fold",
      "Docs",
      "Rendering the rows",
    ]);
  });

  it("carries the link, the commit and marks a done row without either unverified", () => {
    const steps = incrementPlanSteps(carded);
    expect(steps[0]).toMatchObject({ href: "https://github.com/o/r/pull/7" });
    expect(steps[0]).not.toHaveProperty("unverified");
    expect(steps[1]?.href).toMatch(/reports\/task-T-02\.txt$/u);
    expect(steps[2]).toMatchObject({ commit: "abc1234" });
    expect(steps[2]).not.toHaveProperty("unverified");
    expect(steps[3]).toMatchObject({ unverified: true });
    expect(steps[3]).not.toHaveProperty("href");
    // An open or current row is never "unverified".
    expect(steps[4]).toMatchObject({ state: "current" });
    expect(steps[4]).not.toHaveProperty("unverified");
  });

  it("uses the current row's line as the headline", () => {
    const view = deriveThreadPlanView({ increment: carded, todoSteps: null })!;
    expect(view.current).toBe("Rendering the rows");
  });

  it("tells browser links from host paths", () => {
    expect(isExternalStepLink("https://claude.ai/artifact/abc")).toBe(true);
    expect(isExternalStepLink("/repo/.specweave/increments/x/reports/a.txt")).toBe(false);
  });

  it("labels branch and claim binding", () => {
    expect(BINDING_LABELS.branch).toBe("bound by its increment branch");
    expect(BINDING_LABELS.claim).toBe("bound by SpecWeave for this thread");
  });

  it("sends files to the viewer and folders to the editor", () => {
    expect(isDocumentPath("/repo/.specweave/increments/0996-x/spec.md")).toBe(true);
    expect(isDocumentPath("/repo/.specweave/increments/0996-x/reports/verify.json")).toBe(true);
    expect(isDocumentPath("/repo/.specweave/increments/0996-x/reports")).toBe(false);
    expect(isDocumentPath("/repo/.specweave/increments/0996-x")).toBe(false);
  });
});
