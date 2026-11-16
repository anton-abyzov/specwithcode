import { describe, expect, it } from "vite-plus/test";

import type {
  ProjectBoardBlocker,
  ProjectBoardCard,
  ThreadIncrementCriterion,
  ThreadIncrementTask,
} from "@specweave-studio/contracts";

import {
  BOARD_VIEW_THREADS,
  blockerActions,
  columnWhy,
  criteriaSummary,
  criterionState,
  problemSummary,
  taskHolder,
  taskIsClosed,
  threadTaskLabel,
  threadsAtWork,
  viewPrimaryAction,
  viewTaskOrder,
  viewThreadSections,
  type ViewThread,
} from "./boardIncrementModel";

const CLAIMED_AT = "2026-11-15T10:00:00.000Z";

const task = (overrides: Partial<ThreadIncrementTask> = {}): ThreadIncrementTask => ({
  id: "T-03",
  title: "Wire the search box",
  status: "claimed",
  criteria: [],
  note: null,
  owner: "agent@desk",
  changedAt: CLAIMED_AT,
  leased: true,
  ...overrides,
});

interface TestThread extends ViewThread {
  readonly id: string;
}
const thread = (id: string, overrides: Partial<ViewThread> = {}): TestThread => ({
  id,
  tone: "working",
  binding: "claim",
  boundTaskId: "T-03",
  boundAt: CLAIMED_AT,
  ...overrides,
});

const card = (overrides: Partial<ProjectBoardCard> = {}): ProjectBoardCard => ({
  incrementId: "0040-search",
  title: "Search",
  status: "active",
  column: "active",
  tasks: { total: 6, done: 2 },
  blocked: false,
  updatedAt: null,
  pullRequests: [],
  specPath: "/work/atlas/.specweave/increments/0040-search/spec.md",
  ...overrides,
});

describe("taskHolder", () => {
  it("names the one live thread whose claim owns the task now", () => {
    const holder = thread("a");
    expect(taskHolder(task(), [holder, thread("b", { binding: "link" })])).toBe(holder);
  });

  it("matches the claim time as the same instant whatever its ISO spelling", () => {
    const holder = thread("a", { boundAt: "2026-11-15T05:00:00-05:00" });
    expect(taskHolder(task(), [holder])).toBe(holder);
    expect(taskHolder(task({ changedAt: "2026-11-15T10:00:00Z" }), [thread("b")])).not.toBeNull();
  });

  it("holds a blocked task too", () => {
    expect(taskHolder(task({ status: "blocked" }), [thread("a")])).not.toBeNull();
  });

  it("names nobody when any one condition is missing", () => {
    const threads = [thread("a")];
    expect(taskHolder(task(), [thread("a", { binding: "link" })])).toBeNull();
    expect(taskHolder(task(), [thread("a", { binding: null })])).toBeNull();
    expect(taskHolder(task(), [thread("a", { boundTaskId: "T-04" })])).toBeNull();
    expect(taskHolder(task(), [thread("a", { boundAt: "2026-11-15T10:00:01.000Z" })])).toBeNull();
    expect(taskHolder(task(), [thread("a", { boundAt: null })])).toBeNull();
    expect(taskHolder(task(), [thread("a", { boundAt: "not a time" })])).toBeNull();
    expect(taskHolder(task({ changedAt: undefined }), threads)).toBeNull();
    expect(taskHolder(task({ owner: undefined }), threads)).toBeNull();
    expect(taskHolder(task({ owner: "" }), threads)).toBeNull();
    expect(taskHolder(task({ leased: false }), threads)).toBeNull();
    expect(taskHolder(task({ leased: undefined }), threads)).toBeNull();
    for (const status of ["planned", "stale", "done", "released", "skipped"] as const)
      expect(taskHolder(task({ status }), threads)).toBeNull();
    expect(taskHolder(task(), [thread("a", { tone: "resolved" })])).toBeNull();
    expect(taskHolder(task(), [thread("a", { tone: "unknown" })])).toBeNull();
    expect(taskHolder(task(), [])).toBeNull();
  });

  it("names nobody when two threads both fit", () => {
    expect(taskHolder(task(), [thread("a"), thread("b", { tone: "idle" })])).toBeNull();
  });
});

describe("threadTaskLabel", () => {
  it("says which task a thread holds, or that it is only linked", () => {
    const holder = thread("a");
    const linked = thread("b", { binding: "link", boundTaskId: null, boundAt: null });
    const threads = [holder, linked];
    const tasks = [task({ id: "T-01", status: "done" }), task()];
    expect(threadTaskLabel(holder, tasks, threads)).toBe("holds T-03");
    expect(threadTaskLabel(linked, tasks, threads)).toBe("linked, task unknown");
  });

  it("says nothing for a resolved thread", () => {
    const resolved = thread("a", { tone: "resolved" });
    expect(threadTaskLabel(resolved, [task()], [resolved])).toBeNull();
  });

  it("calls an offline thread linked, never the holder", () => {
    const offline = thread("a", { tone: "unknown" });
    expect(threadTaskLabel(offline, [task()], [offline])).toBe("linked, task unknown");
  });
});

describe("viewThreadSections", () => {
  const threads = [
    ...Array.from({ length: 7 }, (_, index) => ({ id: `open-${index}`, tone: "working" })),
    { id: "closed-1", tone: "resolved" },
    { id: "closed-2", tone: "resolved" },
  ];

  it("shows five open threads, counts the rest, and keeps resolved ones apart", () => {
    const sections = viewThreadSections(threads, false);
    expect(BOARD_VIEW_THREADS).toBe(5);
    expect(sections.shown.map((entry) => entry.id)).toEqual([
      "open-0",
      "open-1",
      "open-2",
      "open-3",
      "open-4",
    ]);
    expect(sections.more).toBe(2);
    expect(sections.finished.map((entry) => entry.id)).toEqual(["closed-1", "closed-2"]);
  });

  it("shows every open thread when expanded", () => {
    const sections = viewThreadSections(threads, true);
    expect(sections.shown).toHaveLength(7);
    expect(sections.more).toBe(0);
    expect(sections.finished).toHaveLength(2);
  });

  it("has nothing more with five or fewer", () => {
    expect(viewThreadSections(threads.slice(0, 3), false).more).toBe(0);
  });
});

describe("blockerActions", () => {
  const blocker = (overrides: Partial<ProjectBoardBlocker> = {}): ProjectBoardBlocker => ({
    taskId: "T-03",
    title: "Wire the search box",
    note: "needs the API key",
    by: "agent@desk",
    at: "2026-11-15T10:00:00.000Z",
    ...overrides,
  });
  const blockedTask = task({ status: "blocked" });

  it("offers the thread only when one provably holds the blocked task", () => {
    const holder = thread("a");
    expect(
      blockerActions({
        incrementId: "0040-search",
        blocker: blocker(),
        tasks: [blockedTask],
        threads: [holder],
      }).thread,
    ).toBe(holder);
    expect(
      blockerActions({
        incrementId: "0040-search",
        blocker: blocker(),
        tasks: [blockedTask],
        threads: [thread("a", { binding: "link" })],
      }).thread,
    ).toBeNull();
    expect(
      blockerActions({
        incrementId: "0040-search",
        blocker: blocker(),
        tasks: [],
        threads: [holder],
      }).thread,
    ).toBeNull();
  });

  it("carries the task, the reason, who blocked it and when in both requests", () => {
    const actions = blockerActions({
      incrementId: "0040-search",
      blocker: blocker(),
      tasks: [blockedTask],
      threads: [],
    });
    expect(actions.unblock.label).toBe("Unblock with the coordinator");
    expect(actions.ask.label).toBe("Ask the coordinator why T-03 is blocked");
    for (const prompt of [actions.unblock.prompt, actions.ask.prompt]) {
      expect(prompt).toContain(
        'Increment 0040-search, task T-03 "Wire the search box" is blocked.',
      );
      expect(prompt).toContain("Reason: needs the API key.");
      expect(prompt).toContain("Blocked by agent@desk at 2026-11-15T10:00:00.000Z.");
    }
    expect(actions.unblock.prompt).toContain("Unblock it:");
    expect(actions.ask.prompt).toContain("Find out why it is still blocked");
  });

  it("says what it does not know when the ledger left it out", () => {
    const { ask } = blockerActions({
      incrementId: "0040-search",
      blocker: blocker({ taskId: "T-07", title: "", note: "  ", by: null, at: null }),
      tasks: [],
      threads: [],
    });
    expect(ask.label).toBe("Ask the coordinator why T-07 is blocked");
    expect(ask.prompt).toContain("Increment 0040-search, task T-07 is blocked.");
    expect(ask.prompt).toContain("Reason: none given.");
    expect(ask.prompt).toContain("Blocked by an unknown writer at an unknown time.");
  });
});

describe("columnWhy", () => {
  it("says nothing when the column agrees with the status file", () => {
    expect(
      columnWhy({
        card: card({ columnReason: "status" }),
        movedByThreads: false,
        threadsAtWork: 2,
      }),
    ).toBeNull();
    expect(columnWhy({ card: card(), movedByThreads: false, threadsAtWork: 0 })).toBeNull();
    expect(
      columnWhy({
        card: card({ column: "planned", status: "planned", columnReason: "status" }),
        movedByThreads: false,
        threadsAtWork: 0,
      }),
    ).toBeNull();
  });

  it("explains In review by the tasks", () => {
    expect(
      columnWhy({
        card: card({ column: "review", status: "active", columnReason: "tasks" }),
        movedByThreads: false,
        threadsAtWork: 0,
      }),
    ).toEqual({ column: "In review", because: "every task is done or skipped", status: "active" });
  });

  it("explains Active by the ledger in one sentence", () => {
    expect(
      columnWhy({
        card: card({
          status: "planned",
          columnReason: "ledger",
          tasks: { total: 24, done: 14, active: 1 },
          blockedTasks: 2,
        }),
        movedByThreads: false,
        threadsAtWork: 3,
      }),
    ).toEqual({
      column: "Active",
      because:
        "14 tasks are done, 2 tasks are blocked, 1 task is claimed and 3 threads are working",
      status: "planned",
    });
    expect(
      columnWhy({
        card: card({ status: "planned", columnReason: "ledger", tasks: { total: 4, done: 1 } }),
        movedByThreads: false,
        threadsAtWork: 0,
      })?.because,
    ).toBe("1 task is done");
    // Skipped tasks count as closed on the card, but they are not why it moved.
    expect(
      columnWhy({
        card: card({
          status: "planned",
          columnReason: "ledger",
          tasks: { total: 4, done: 2, finished: 0 },
          blockedTasks: 1,
        }),
        movedByThreads: false,
        threadsAtWork: 0,
      })?.because,
    ).toBe("1 task is blocked");
    expect(
      columnWhy({
        card: card({
          status: "planned",
          columnReason: "ledger",
          tasks: { total: 4, done: 0 },
          blockedTasks: 1,
        }),
        movedByThreads: false,
        threadsAtWork: 1,
      })?.because,
    ).toBe("1 task is blocked and 1 thread is working");
  });

  it("explains a card its threads moved, and calls a missing status nothing", () => {
    expect(
      columnWhy({
        card: card({ status: "unknown", tasks: { total: 4, done: 0 } }),
        movedByThreads: true,
        threadsAtWork: 2,
      }),
    ).toEqual({ column: "Active", because: "2 threads are working", status: "nothing" });
    expect(
      columnWhy({
        card: card({ status: "planned", tasks: { total: 4, done: 0 } }),
        movedByThreads: true,
        threadsAtWork: 0,
      })?.because,
    ).toBe("work has started");
  });
});

describe("threadsAtWork", () => {
  it("counts only threads that show work", () => {
    expect(
      threadsAtWork(
        ["working", "background", "waiting", "failed", "idle", "resolved", "unknown"].map(
          (tone) => ({ tone }),
        ),
      ),
    ).toBe(4);
    expect(threadsAtWork([])).toBe(0);
  });
});

describe("viewPrimaryAction", () => {
  const action = (
    overrides: Partial<ProjectBoardCard> = {},
    extra: { abandoned?: boolean; liveThreads?: number } = {},
  ) =>
    viewPrimaryAction({
      card: card(overrides),
      abandoned: extra.abandoned ?? false,
      liveThreads: extra.liveThreads ?? 0,
    });

  it("opens the thread when a live thread is on the increment", () => {
    expect(action({}, { liveThreads: 1 })).toEqual({ kind: "thread" });
    expect(action({ specPath: null }, { liveThreads: 2 })).toEqual({ kind: "thread" });
  });

  it("asks to plan an increment with no spec, then one with no tasks", () => {
    expect(action({ specPath: null })).toEqual({
      kind: "ask",
      label: "Plan it with the coordinator",
      prompt:
        "Plan increment 0040-search: it has a folder and a title but no spec.md. Write the problem, the acceptance criteria and the tasks.",
    });
    expect(action({ tasks: { total: 0, done: 0 } })).toEqual({
      kind: "ask",
      label: "Plan the tasks",
      prompt: "Plan the tasks of increment 0040-search: its spec names none yet.",
    });
  });

  it("otherwise asks what the card asks", () => {
    expect(action()).toMatchObject({ kind: "ask", label: "Continue" });
    expect(action({ column: "planned", tasks: { total: 6, done: 0 } })).toMatchObject({
      kind: "ask",
      label: "Start",
    });
    expect(action({ column: "review", tasks: { total: 6, done: 6 } })).toMatchObject({
      kind: "ask",
      label: "Review and close",
    });
    expect(action({ paused: true })).toMatchObject({ kind: "ask", label: "Resume" });
    expect(action({ paused: true, tasks: { total: 0, done: 0 } })).toMatchObject({
      kind: "ask",
      label: "Resume",
    });
  });

  it("offers nothing for done or abandoned work", () => {
    expect(action({ column: "done" }, { liveThreads: 1 })).toBeNull();
    expect(action({}, { abandoned: true, liveThreads: 1 })).toBeNull();
  });
});

describe("tasks and criteria", () => {
  it("orders blocked, in progress, stale, open, then finished, stable inside a rank", () => {
    const tasks = [
      { id: "T-01", status: "done" },
      { id: "T-02", status: "planned" },
      { id: "T-03", status: "claimed" },
      { id: "T-04", status: "skipped" },
      { id: "T-05", status: "released" },
      { id: "T-06", status: "blocked" },
      { id: "T-07", status: "stale" },
      { id: "T-08", status: "claimed" },
      { id: "T-09", status: "blocked" },
    ] as const;
    expect(viewTaskOrder(tasks).map((entry) => entry.id)).toEqual([
      "T-06",
      "T-09",
      "T-03",
      "T-08",
      "T-07",
      "T-02",
      "T-05",
      "T-01",
      "T-04",
    ]);
    expect(tasks[0].id).toBe("T-01");
  });

  it("closes only done and skipped tasks", () => {
    expect(taskIsClosed({ status: "done" })).toBe(true);
    expect(taskIsClosed({ status: "skipped" })).toBe(true);
    for (const status of ["planned", "claimed", "stale", "released", "blocked"] as const)
      expect(taskIsClosed({ status })).toBe(false);
  });

  const criterion = (
    overrides: Partial<ThreadIncrementCriterion> = {},
  ): ThreadIncrementCriterion => ({
    id: "AC-01",
    text: "Search finds a card",
    met: false,
    ...overrides,
  });

  it("reads a criterion's state, or derives it from met for an older server", () => {
    expect(criterionState(criterion({ state: "verified", met: true }))).toBe("verified");
    expect(criterionState(criterion({ state: "uncovered" }))).toBe("uncovered");
    expect(criterionState(criterion({ met: true }))).toBe("evidenced");
    expect(criterionState(criterion({ met: false }))).toBe("open");
  });

  it("sums up how many criteria are verified", () => {
    expect(criteriaSummary([])).toBeNull();
    expect(
      criteriaSummary([
        criterion({ state: "verified", met: true }),
        criterion({ id: "AC-02", state: "evidenced", met: true }),
        criterion({ id: "AC-03", state: "open" }),
        criterion({ id: "AC-04", state: "verified", met: true }),
        criterion({ id: "AC-05", met: true }),
      ]),
    ).toBe("2 of 5 verified");
  });

  it("takes the Problem's first paragraph for the header", () => {
    expect(problemSummary(null)).toBeNull();
    expect(problemSummary("")).toBeNull();
    expect(problemSummary("   \n\n  ")).toBeNull();
    expect(problemSummary("  Cards sit in Planned.\nThey flap.\n\nSecond paragraph.")).toBe(
      "Cards sit in Planned.\nThey flap.",
    );
    expect(problemSummary("One paragraph only.")).toBe("One paragraph only.");
  });
});
