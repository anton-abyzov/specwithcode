// @vitest-environment jsdom
import {
  EnvironmentId,
  ProjectId,
  type ProjectBoardBlocker,
  type ProjectBoardCard,
  type ProjectBoardIncrement,
  type ProjectBoardIncrementResult,
  type ThreadIncrementCriterion,
  type ThreadIncrementTask,
} from "@specweave-studio/contracts";
import { act, cloneElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { BoardIncrementViewProps, BoardViewFile } from "./BoardIncrementView";
import type { BoardThread } from "./BoardThreads";

const runtime = vi.hoisted(() => ({
  inputs: [] as Array<{ projectId: string; incrementId: string; includeDone?: boolean }>,
  reply: null as unknown,
  error: null as string | null,
  pending: false,
  refresh: vi.fn(),
}));
vi.mock("../../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, {}, children),
  TooltipPopup: () => null,
}));
vi.mock("../../../studio/projectWorkspace", () => ({
  projectWorkspace: {
    boardIncrement: ({
      input,
    }: {
      input: { projectId: string; incrementId: string; includeDone?: boolean };
    }) => {
      runtime.inputs.push(input);
      return input;
    },
  },
}));
vi.mock("../../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: runtime.reply,
    error: runtime.error,
    isPending: runtime.pending,
    refresh: runtime.refresh,
  }),
}));

const { BoardIncrementView } = await import("./BoardIncrementView");
const { BOARD_VIEW_REFRESH_MS } = await import("../../../studio/boardIncrementModel");

const projectId = ProjectId.make("atlas");
const ID = "0042-login-form";
const SPEC = `/work/atlas/.specweave/increments/${ID}/spec.md`;
const NOW = Date.parse("2026-11-16T12:00:00.000Z");
const BLOCKED_AT = "2026-11-16T10:00:00.000Z";

const makeCard = (extra: Partial<ProjectBoardCard> = {}): ProjectBoardCard => ({
  incrementId: ID,
  title: "Login form",
  status: "active",
  column: "active",
  tasks: { total: 6, done: 2 },
  blocked: false,
  updatedAt: "2026-11-16T11:00:00.000Z",
  pullRequests: [],
  specPath: SPEC,
  ...extra,
});
const task = (
  id: string,
  status: ThreadIncrementTask["status"],
  extra: Partial<ThreadIncrementTask> = {},
): ThreadIncrementTask => ({
  id,
  title: `Task ${id}`,
  status,
  criteria: [],
  note: null,
  ...extra,
});
const blocker = (
  taskId: string,
  extra: Partial<ProjectBoardBlocker> = {},
): ProjectBoardBlocker => ({
  taskId,
  title: `Task ${taskId}`,
  note: "Waiting for the API key",
  by: "agent@desk",
  at: BLOCKED_AT,
  ...extra,
});
const criterion = (
  id: string,
  state: ThreadIncrementCriterion["state"],
  met = state === "verified" || state === "evidenced",
): ThreadIncrementCriterion => ({ id, text: `Criterion ${id} text`, met, state });
const detail = (
  card: ProjectBoardCard,
  extra: Partial<ProjectBoardIncrement> = {},
): ProjectBoardIncrementResult => ({
  projectId,
  incrementId: card.incrementId,
  increment: {
    card,
    problem: "People cannot sign in.\n\nThe form loses focus on every keystroke.",
    readable: true,
    tasks: [],
    doneTasks: 0,
    blockers: [],
    criteria: [],
    verify: null,
    review: null,
    abandoned: false,
    abandonedReason: null,
    closedAt: null,
    reports: [],
    ...extra,
  },
});

/** One thread linked to the increment, as the board hands it over. */
const thread = (
  id: string,
  tone: string,
  extra: {
    binding?: string | null;
    boundTaskId?: string | null;
    boundAt?: string | null;
    moved?: string;
    status?: string | null;
  } = {},
): BoardThread =>
  ({
    thread: { id, environmentId: "host", title: `Thread ${id}` },
    tone,
    status:
      extra.status !== undefined
        ? extra.status
        : tone === "resolved" || tone === "unknown"
          ? null
          : tone === "waiting"
            ? "Needs you"
            : tone === "idle"
              ? "Idle"
              : "Working",
    updatedAt: "2026-11-16T11:00:00.000Z",
    machine: {
      label: extra.moved ? `${extra.moved} → Laptop` : "Laptop",
      moved: extra.moved !== undefined,
      executionMachineId: "host",
      state: tone === "unknown" ? "unknown" : "live",
      description: extra.moved ? `Moved from ${extra.moved}, runs on Laptop` : "Runs on Laptop",
    },
    color: "violet",
    binding: extra.binding ?? null,
    boundTaskId: extra.boundTaskId ?? null,
    boundAt: extra.boundAt ?? null,
  }) as unknown as BoardThread;

describe("BoardIncrementView", () => {
  let root: Root;
  let container: HTMLDivElement;
  const opened: string[] = [];
  const asked: string[] = [];
  const links: string[] = [];
  const files: Array<{ files: ReadonlyArray<BoardViewFile>; path: string }> = [];
  let closed = 0;
  let stepped: string[] = [];

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    runtime.inputs.length = 0;
    runtime.reply = null;
    runtime.error = null;
    runtime.pending = false;
    runtime.refresh.mockClear();
    opened.length = 0;
    asked.length = 0;
    links.length = 0;
    files.length = 0;
    closed = 0;
    stepped = [];
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const render = (
    extra: Partial<Omit<BoardIncrementViewProps, "onAsk">> & { canAsk?: boolean } = {},
  ) => {
    const { canAsk, ...props } = extra;
    return act(async () =>
      root.render(
        <BoardIncrementView
          id="board-view"
          environmentId={EnvironmentId.make("host")}
          projectId={projectId}
          incrementId={ID}
          card={makeCard()}
          supported
          movedByThreads={false}
          threads={[]}
          showMachine={false}
          pullRequestStates={new Map()}
          now={NOW}
          onClose={() => (closed += 1)}
          onStep={{ previous: () => stepped.push("previous"), next: null }}
          onOpenThread={(entry) => opened.push(entry.id)}
          onOpenLink={(url) => links.push(url)}
          onOpenFiles={(list, path) => files.push({ files: list, path })}
          onAsk={canAsk === false ? undefined : (prompt) => asked.push(prompt)}
          {...props}
        />,
      ),
    );
  };
  const byText = (text: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (entry) => entry.textContent?.trim() === text,
    ) ?? null;
  const byLabel = (label: string) =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  const click = (target: HTMLElement | null) =>
    act(async () => {
      expect(target).not.toBeNull();
      target!.click();
    });
  const primary = () => container.querySelector<HTMLButtonElement>("button[data-primary]");
  const section = (name: string) =>
    container.querySelector<HTMLElement>(`section[aria-label="${name}"]`);
  const threadRows = () =>
    [...container.querySelectorAll<HTMLElement>(".sws-board-view-thread")].map(
      (row) => row.querySelector(".sws-board-view-thread-title")!.textContent,
    );
  const blockerBox = (taskId: string) =>
    container.querySelector<HTMLElement>(`.sws-board-view-blocker[data-task="${taskId}"]`)!;

  describe("header", () => {
    it("shows the way back, the number, the column, step buttons and the title as the heading", async () => {
      const card = makeCard();
      runtime.reply = detail(card, {
        criteria: [
          criterion("AC-01", "verified"),
          criterion("AC-02", "open"),
          criterion("AC-03", "evidenced"),
        ],
      });
      await render({ card });
      expect(byText("Board")).not.toBeNull();
      expect(container.querySelector(".sws-board-view-head .sws-board-card-id")?.textContent).toBe(
        "0042",
      );
      expect(container.querySelector(".sws-board-view-column")?.textContent).toBe("Active");
      // The region is named by its title.
      const region = container.querySelector<HTMLElement>("section.sws-board-view")!;
      const heading = document.getElementById(region.getAttribute("aria-labelledby")!)!;
      expect(heading.tagName).toBe("H3");
      expect(heading.textContent).toBe("Login form");
      expect(container.querySelector(".sws-board-view-progress")?.textContent).toBe(
        "2/6 tasks2/3 criteria",
      );
      // Only the first paragraph of the Problem sits under the header.
      expect(container.querySelector(".sws-board-view-summary")?.textContent).toBe(
        "People cannot sign in.",
      );

      expect(byLabel("Previous card")!.disabled).toBe(false);
      expect(byLabel("Next card")!.disabled).toBe(true);
      await click(byLabel("Previous card"));
      expect(stepped).toEqual(["previous"]);
      await click(byLabel("Close the increment view"));
      await click(byText("Board"));
      expect(closed).toBe(2);
    });

    it("names an abandoned increment Abandoned and gives its reason, with no primary action", async () => {
      const card = makeCard({ column: "planned", status: "abandoned" });
      runtime.reply = detail(card, {
        abandoned: true,
        abandonedReason: "Superseded by the new sign-in flow",
        closedAt: "2026-11-10T09:00:00.000Z",
      });
      await render({ card });
      expect(container.querySelector(".sws-board-view-column")?.textContent).toBe("Abandoned");
      expect(container.textContent).toContain("Superseded by the new sign-in flow");
      expect(container.querySelector(".sws-board-view-age")?.textContent).toMatch(/^closed /u);
      expect(primary()).toBeNull();
      expect(byText("Ask the coordinator")).toBeNull();
    });

    it("says no reason was recorded for an abandoned increment without one", async () => {
      const card = makeCard({ column: "planned" });
      runtime.reply = detail(card, { abandoned: true, abandonedReason: null });
      await render({ card });
      expect(container.textContent).toContain("No reason was recorded.");
    });
  });

  it("orders the body as the spec does: pause, blockers, why, threads, tasks, criteria, pull requests, problem", async () => {
    const card = makeCard({
      paused: true,
      pausedReason: "Waiting for design",
      blocked: true,
      blockedTasks: 1,
      columnReason: "ledger",
      status: "planned",
      pullRequests: ["https://github.com/acme/app/pull/12"],
    });
    runtime.reply = detail(card, {
      tasks: [
        task("T-01", "planned"),
        task("T-02", "blocked", { note: "Waiting for the API key" }),
      ],
      blockers: [blocker("T-02")],
      criteria: [criterion("AC-01", "open")],
    });
    await render({ card, threads: [thread("t1", "working")] });
    const order = [
      ...container.querySelectorAll<HTMLElement>(
        ".sws-board-view-body .sws-board-view-blocker, .sws-board-view-body .sws-board-view-why, .sws-board-view-body section.sws-board-view-section",
      ),
    ].map((entry) =>
      entry.dataset.kind === "paused"
        ? "paused"
        : entry.dataset.task
          ? entry.dataset.task
          : entry.classList.contains("sws-board-view-why")
            ? "why"
            : entry.getAttribute("aria-label"),
    );
    expect(order).toEqual([
      "paused",
      "T-02",
      "why",
      "Threads",
      "Tasks",
      "Acceptance criteria",
      "Pull requests",
      "Problem",
    ]);
  });

  describe("paused and blocked", () => {
    it("shows the pause reason and offers Resume", async () => {
      const card = makeCard({ paused: true, pausedReason: "Waiting for design", blocked: true });
      runtime.reply = detail(card);
      await render({ card });
      const paused = container.querySelector<HTMLElement>('[data-kind="paused"]')!;
      expect(paused.textContent).toContain("Paused");
      expect(paused.textContent).toContain("Waiting for design");
      expect(primary()?.textContent).toBe("Resume");
      await click(primary());
      expect(asked).toEqual([
        `Resume increment ${ID}: it is paused ("Waiting for design"). Check whether that still holds, then pick up its next open task.`,
      ]);
    });

    it("lists the pause before each blocker when it is both", async () => {
      const card = makeCard({
        paused: true,
        pausedReason: "Waiting for design",
        blocked: true,
        blockedTasks: 2,
      });
      runtime.reply = detail(card, {
        tasks: [task("T-02", "blocked"), task("T-04", "blocked")],
        blockers: [blocker("T-02"), blocker("T-04", { note: "Needs a second reviewer" })],
      });
      await render({ card });
      const boxes = [...container.querySelectorAll<HTMLElement>(".sws-board-view-blocker")];
      expect(boxes.map((box) => box.dataset.kind ?? box.dataset.task)).toEqual([
        "paused",
        "T-02",
        "T-04",
      ]);
      expect(boxes[2]!.textContent).toContain("Needs a second reviewer");
    });
  });

  describe("blockers", () => {
    const blockedTask = (extra: Partial<ThreadIncrementTask> = {}) =>
      task("T-02", "blocked", {
        title: "Wire the form",
        note: "Waiting for the API key",
        owner: "agent@desk",
        changedAt: BLOCKED_AT,
        leased: true,
        ...extra,
      });
    const blockedCard = makeCard({ blocked: true, blockedTasks: 1 });
    const facts = `Increment ${ID}, task T-02 "Wire the form" is blocked. Reason: Waiting for the API key. Blocked by agent@desk at ${BLOCKED_AT}.`;

    it("names the task, its title, the full reason, who and when, and asks the coordinator to unblock it", async () => {
      runtime.reply = detail(blockedCard, {
        tasks: [blockedTask()],
        blockers: [blocker("T-02", { title: "Wire the form" })],
      });
      await render({ card: blockedCard });
      const box = blockerBox("T-02");
      expect(box.querySelector(".sws-board-view-blocker-title")?.textContent).toBe(
        "T-02 is blocked",
      );
      expect(box.querySelector(".sws-board-view-blocker-reason")?.textContent).toBe(
        "Waiting for the API key",
      );
      expect(box.querySelector(".sws-board-view-blocker-meta")?.textContent).toBe(
        "Wire the form · blocked by agent@desk · 2h ago",
      );
      await click(byText("Unblock with the coordinator"));
      expect(asked).toEqual([
        `${facts} Unblock it: resolve what it waits for, or tell me what only I can do.`,
      ]);
      // No thread provably holds it: ask, never guess.
      expect(byText("Open that thread")).toBeNull();
      await click(byText("Ask the coordinator why T-02 is blocked"));
      expect(asked[1]).toBe(`${facts} Find out why it is still blocked and what it needs.`);
    });

    it("opens the one live thread whose claim still holds the task", async () => {
      runtime.reply = detail(blockedCard, {
        tasks: [blockedTask()],
        blockers: [blocker("T-02", { title: "Wire the form" })],
      });
      // The same instant written another way still matches.
      const holder = thread("t1", "working", {
        binding: "claim",
        boundTaskId: "T-02",
        boundAt: "2026-11-16T10:00:00Z",
      });
      await render({ card: blockedCard, threads: [holder, thread("t2", "working")] });
      const box = blockerBox("T-02");
      expect(box.querySelector(".sws-board-view-blocker-meta")?.textContent).toContain(
        "in Thread t1",
      );
      expect(byText("Ask the coordinator why T-02 is blocked")).toBeNull();
      await click(byText("Open that thread"));
      expect(opened).toEqual(["t1"]);
    });

    it.each([
      [
        "two threads both fit",
        [
          thread("t1", "working", { binding: "claim", boundTaskId: "T-02", boundAt: BLOCKED_AT }),
          thread("t2", "waiting", { binding: "claim", boundTaskId: "T-02", boundAt: BLOCKED_AT }),
        ],
        {},
      ],
      [
        "the lease ran out",
        [thread("t1", "working", { binding: "claim", boundTaskId: "T-02", boundAt: BLOCKED_AT })],
        { leased: false },
      ],
      [
        "the thread is bound by its branch, not a claim",
        [thread("t1", "working", { binding: "branch", boundTaskId: "T-02", boundAt: BLOCKED_AT })],
        {},
      ],
      [
        "a later write owns the task",
        [
          thread("t1", "working", {
            binding: "claim",
            boundTaskId: "T-02",
            boundAt: "2026-11-16T09:00:00.000Z",
          }),
        ],
        {},
      ],
      [
        "the only fitting thread is on an unreachable machine",
        [thread("t1", "unknown", { binding: "claim", boundTaskId: "T-02", boundAt: BLOCKED_AT })],
        {},
      ],
    ] as const)("asks the coordinator when %s", async (_case, threads, taskExtra) => {
      runtime.reply = detail(blockedCard, {
        tasks: [blockedTask(taskExtra)],
        blockers: [blocker("T-02", { title: "Wire the form" })],
      });
      await render({ card: blockedCard, threads: [...threads] });
      expect(byText("Open that thread")).toBeNull();
      await click(byText("Ask the coordinator why T-02 is blocked"));
      expect(asked).toEqual([`${facts} Find out why it is still blocked and what it needs.`]);
    });

    it("says when no reason was given, and shows no coordinator buttons to someone who cannot send", async () => {
      runtime.reply = detail(blockedCard, {
        tasks: [blockedTask({ note: null })],
        blockers: [blocker("T-02", { note: null, by: null, at: null })],
      });
      await render({ card: blockedCard, canAsk: false });
      const box = blockerBox("T-02");
      expect(box.querySelector(".sws-board-view-blocker-reason")?.textContent).toBe(
        "No reason was given.",
      );
      expect(box.querySelectorAll("button")).toHaveLength(0);
    });

    it("renders a 400 character reason without spaces in full", async () => {
      const reason = "x".repeat(200) + "y".repeat(200);
      runtime.reply = detail(blockedCard, {
        tasks: [blockedTask({ note: reason })],
        blockers: [blocker("T-02", { note: reason })],
      });
      await render({ card: blockedCard });
      expect(blockerBox("T-02").querySelector(".sws-board-view-blocker-reason")?.textContent).toBe(
        reason,
      );
    });
  });

  describe("threads", () => {
    it("shows five, expands the rest in place and keeps finished ones behind their own toggle", async () => {
      const card = makeCard();
      runtime.reply = detail(card);
      const threads = [
        ...Array.from({ length: 7 }, (_, index) => thread(`t${index + 1}`, "working")),
        thread("r1", "resolved"),
        thread("r2", "resolved"),
      ];
      await render({ card, threads });
      expect(section("Threads")!.querySelector(".sws-board-view-heading-note")?.textContent).toBe(
        "7",
      );
      expect(threadRows()).toEqual([
        "Thread t1",
        "Thread t2",
        "Thread t3",
        "Thread t4",
        "Thread t5",
      ]);
      await click(byText("2 more"));
      expect(threadRows()).toHaveLength(7);
      expect(opened).toEqual([]);
      expect(byText("2 more")).toBeNull();
      await click(byText("2 finished"));
      expect(threadRows().slice(-2)).toEqual(["Thread r1", "Thread r2"]);
      await click(byLabel("Open thread Thread t3, Working"));
      expect(opened).toEqual(["t3"]);
    });

    it("lists only finished threads when nothing else is on it", async () => {
      const card = makeCard({ column: "done", status: "completed", tasks: { total: 6, done: 6 } });
      runtime.reply = detail(card);
      await render({ card, threads: [thread("r1", "resolved")] });
      expect(section("Threads")!.querySelector(".sws-board-view-heading-note")?.textContent).toBe(
        "1 finished",
      );
      expect(threadRows()).toEqual(["Thread r1"]);
    });

    it("says which task a thread holds, or that it is unknown, and where a moved thread came from", async () => {
      const card = makeCard();
      runtime.reply = detail(card, {
        tasks: [
          task("T-03", "claimed", { owner: "agent@desk", changedAt: BLOCKED_AT, leased: true }),
        ],
      });
      await render({
        card,
        threads: [
          thread("t1", "working", { binding: "claim", boundTaskId: "T-03", boundAt: BLOCKED_AT }),
          thread("t2", "waiting", { moved: "Desk" }),
        ],
      });
      const rows = [...container.querySelectorAll<HTMLElement>(".sws-board-view-thread")];
      expect(rows[0]!.querySelector(".sws-board-view-thread-meta")?.textContent).toBe(
        "Workingholds T-03",
      );
      expect(rows[1]!.querySelector(".sws-board-view-thread-meta")?.textContent).toBe(
        "Needs youlinked, task unknownmoved from Desk",
      );
      expect(rows[1]!.querySelector(".sws-board-machine")?.textContent).toContain("→ Laptop");
    });

    it("lists an offline thread without counting it as working", async () => {
      const card = makeCard({
        status: "planned",
        columnReason: "ledger",
        tasks: { total: 6, done: 0 },
      });
      runtime.reply = detail(card);
      await render({
        card,
        movedByThreads: true,
        threads: [thread("t1", "working"), thread("t2", "unknown"), thread("t3", "idle")],
      });
      expect(threadRows()).toEqual(["Thread t1", "Thread t2", "Thread t3"]);
      expect(byLabel("Open thread Thread t2, Status unknown")?.textContent).toContain(
        "Status unknown",
      );
      expect(container.querySelector(".sws-board-view-why")?.textContent).toBe(
        "In Active because 1 thread is working. Its status file still says planned.",
      );
    });

    it("says when no thread works on it", async () => {
      const card = makeCard();
      runtime.reply = detail(card);
      await render({ card });
      expect(section("Threads")!.textContent).toContain("No thread works on this yet.");
    });
  });

  describe("tasks", () => {
    it("lists open tasks blocked first, and shows done ones only when asked", async () => {
      const card = makeCard({ blocked: true, blockedTasks: 1 });
      const open = detail(card, {
        tasks: [
          task("T-03", "planned"),
          task("T-04", "claimed", { owner: "agent@desk", changedAt: BLOCKED_AT, leased: true }),
          task("T-05", "blocked", { note: "No test server" }),
        ],
        doneTasks: 2,
        blockers: [blocker("T-05")],
      });
      runtime.reply = open;
      await render({
        card,
        threads: [
          thread("t1", "working", { binding: "claim", boundTaskId: "T-04", boundAt: BLOCKED_AT }),
        ],
      });
      const ids = () =>
        [...section("Tasks")!.querySelectorAll(".sws-board-view-task > .sws-board-card-id")].map(
          (entry) => entry.textContent,
        );
      const statuses = () =>
        [...section("Tasks")!.querySelectorAll(".sws-board-view-task-status")].map(
          (entry) => entry.textContent,
        );
      expect(ids()).toEqual(["T-05", "T-04", "T-03"]);
      expect(statuses()).toEqual(["Blocked", "In progress", "Open"]);
      expect(section("Tasks")!.textContent).toContain("No test server");
      expect(section("Tasks")!.querySelector(".sws-board-view-heading-note")?.textContent).toBe(
        "3 open",
      );
      expect(runtime.inputs.at(-1)).toEqual({ projectId, incrementId: ID });

      // The thread holding T-04 is a chip that opens it.
      await click(byLabel("Open thread Thread t1, which holds T-04"));
      expect(opened).toEqual(["t1"]);

      const show = byText("Show 2 done")!;
      expect(show.getAttribute("aria-expanded")).toBe("false");
      runtime.reply = detail(card, {
        tasks: [...open.increment!.tasks, task("T-01", "done"), task("T-02", "skipped")],
        doneTasks: 2,
        blockers: [blocker("T-05")],
      });
      await click(show);
      expect(runtime.inputs.at(-1)).toEqual({ projectId, incrementId: ID, includeDone: true });
      expect(ids()).toEqual(["T-05", "T-04", "T-03", "T-01", "T-02"]);
      expect(statuses().slice(-2)).toEqual(["Done", "Skipped"]);
      const hide = byText("Hide done")!;
      expect(hide.getAttribute("aria-expanded")).toBe("true");
      runtime.reply = open;
      await click(hide);
      expect(runtime.inputs.at(-1)).toEqual({ projectId, incrementId: ID });
      expect(ids()).toEqual(["T-05", "T-04", "T-03"]);
    });

    it("hands the coordinator a stale claim to release", async () => {
      const card = makeCard();
      runtime.reply = detail(card, {
        tasks: [task("T-03", "stale", { owner: "agent@desk", leased: false })],
      });
      await render({ card });
      expect(section("Tasks")!.textContent).toContain("Stale claim");
      await click(byText("Release with the coordinator"));
      expect(asked).toEqual([
        `Increment ${ID}, task T-03: its claim by agent@desk is older than two hours. Release it or pick it up.`,
      ]);
    });

    it("says every task is done, or that the spec has none yet", async () => {
      const card = makeCard({ column: "review", tasks: { total: 6, done: 6 } });
      runtime.reply = detail(card, { doneTasks: 6 });
      await render({ card });
      expect(section("Tasks")!.textContent).toContain("Every task is done or skipped.");
      expect(section("Tasks")!.querySelector(".sws-board-view-heading-note")?.textContent).toBe(
        "6 done",
      );

      const empty = makeCard({
        tasks: { total: 0, done: 0 },
        updatedAt: "2026-11-16T11:30:00.000Z",
      });
      runtime.reply = detail(empty);
      await render({ card: empty });
      expect(section("Tasks")!.textContent).toContain("The spec has no tasks yet.");
      expect(primary()?.textContent).toBe("Plan the tasks");
    });
  });

  it("lists each acceptance criterion with its proof state and a summary", async () => {
    const card = makeCard();
    runtime.reply = detail(card, {
      criteria: [
        criterion("AC-01", "verified"),
        criterion("AC-02", "evidenced"),
        criterion("AC-03", "declared", true),
        criterion("AC-04", "skipped", true),
        criterion("AC-05", "open"),
        criterion("AC-06", "uncovered"),
        criterion("AC-07", "unknown"),
        { id: "AC-08", text: "Older server, met only", met: true },
      ],
    });
    await render({ card });
    const criteria = section("Acceptance criteria")!;
    expect(criteria.querySelector(".sws-board-view-heading-note")?.textContent).toBe(
      "1 of 8 verified",
    );
    const rows = [...criteria.querySelectorAll("li")].map((row) => [
      row.querySelector(".sws-board-view-ac")!.textContent,
      row.querySelector(".sws-board-view-ac-text")!.textContent,
      row.querySelector(".sws-board-view-ac-state")!.textContent,
    ]);
    expect(rows).toEqual([
      ["AC-01", "Criterion AC-01 text", "Verified"],
      ["AC-02", "Criterion AC-02 text", "Done, not verified yet"],
      ["AC-03", "Criterion AC-03 text", "Ticked in the spec, no evidence"],
      ["AC-04", "Criterion AC-04 text", "Skipped"],
      ["AC-05", "Criterion AC-05 text", "Open"],
      ["AC-06", "Criterion AC-06 text", "No task covers it"],
      ["AC-07", "Criterion AC-07 text", "Unknown"],
      ["AC-08", "Older server, met only", "Done, not verified yet"],
    ]);
  });

  it("opens each pull request through the link opener, with its state when known", async () => {
    const card = makeCard({
      pullRequests: ["https://github.com/acme/app/pull/12", "https://github.com/acme/app/pull/9"],
    });
    runtime.reply = detail(card);
    await render({
      card,
      pullRequestStates: new Map([["https://github.com/acme/app/pull/12", "Merged"]]),
    });
    const merged = byLabel("Open pull request #12, Merged")!;
    expect(merged.textContent).toBe("#12 Merged");
    expect(byLabel("Open pull request #9")?.textContent).toBe("#9");
    await click(merged);
    await click(byLabel("Open pull request #9"));
    expect(links).toEqual([
      "https://github.com/acme/app/pull/12",
      "https://github.com/acme/app/pull/9",
    ]);
  });

  describe("spec file", () => {
    it("opens the spec from the Problem and from the header, and shows the full Problem", async () => {
      const card = makeCard();
      runtime.reply = detail(card, {
        reports: [{ path: "/work/atlas/reports/review.md", name: "review.md" }],
      });
      await render({ card });
      const problem = section("Problem")!;
      expect(
        [...problem.querySelectorAll(".sws-board-view-problem")].map((entry) => entry.textContent),
      ).toEqual(["People cannot sign in.", "The form loses focus on every keystroke."]);
      await click(byText("Open spec file"));
      await click(byText("Spec file"));
      expect(files).toEqual([
        { files: [{ path: SPEC, name: "0042 spec.md" }], path: SPEC },
        { files: [{ path: SPEC, name: "0042 spec.md" }], path: SPEC },
      ]);
      await click(byText("Reports"));
      expect(files[2]).toEqual({
        files: [{ path: "/work/atlas/reports/review.md", name: "review.md" }],
        path: "/work/atlas/reports/review.md",
      });
    });

    it("offers to plan an increment that has no spec", async () => {
      const card = makeCard({ specPath: null, tasks: { total: 0, done: 0 } });
      runtime.reply = detail(card, { problem: null });
      await render({ card });
      expect(byText("Open spec file")).toBeNull();
      expect(byText("Spec file")).toBeNull();
      expect(section("Tasks")!.textContent).toContain(
        "No spec yet: this increment has a folder and a title but no spec.md.",
      );
      expect(primary()?.textContent).toBe("Plan it with the coordinator");
      await click(primary());
      expect(asked).toEqual([
        `Plan increment ${ID}: it has a folder and a title but no spec.md. Write the problem, the acceptance criteria and the tasks.`,
      ]);
    });
  });

  describe("why it sits in its column", () => {
    it("explains a column the status file disagrees with", async () => {
      const card = makeCard({
        status: "planned",
        columnReason: "ledger",
        blockedTasks: 1,
        blocked: true,
        tasks: { total: 6, done: 2, active: 1 },
      });
      runtime.reply = detail(card);
      await render({ card });
      expect(container.querySelector(".sws-board-view-why")?.textContent).toBe(
        "In Active because 2 tasks are done, 1 task is blocked and 1 task is claimed. Its status file still says planned.",
      );
    });

    it("explains In review reached by tasks", async () => {
      const card = makeCard({
        column: "review",
        columnReason: "tasks",
        tasks: { total: 6, done: 6 },
      });
      runtime.reply = detail(card, { doneTasks: 6 });
      await render({ card });
      expect(container.querySelector(".sws-board-view-why")?.textContent).toBe(
        "In In review because every task is done or skipped. Its status file still says active.",
      );
    });

    it("says nothing when the column follows the status file", async () => {
      const card = makeCard({ columnReason: "status" });
      runtime.reply = detail(card);
      await render({ card });
      expect(container.querySelector(".sws-board-view-why")).toBeNull();
    });
  });

  it("shows the verify and review line on a done increment, with no primary action", async () => {
    const card = makeCard({ column: "done", status: "completed", tasks: { total: 6, done: 6 } });
    runtime.reply = detail(card, {
      doneTasks: 6,
      verify: { ok: true, ranAt: "2026-11-15T12:00:00.000Z" },
      review: {
        policy: null,
        latest: {
          model: "Model A",
          family: "acme",
          head: "abc1234",
          verdict: "ship",
          at: "2026-11-15T13:00:00.000Z",
          reportPath: "/work/atlas/reports/review.md",
        },
        authorFamily: null,
        policySatisfied: null,
      },
      closedAt: "2026-11-15T14:00:00.000Z",
    });
    await render({ card, threads: [thread("t1", "idle")] });
    const line = container.querySelector(".sws-board-view-why")!.textContent!;
    expect(line).toMatch(/^Verified on .*2026\. Reviewed by Model A: ship\.$/u);
    expect(container.querySelector(".sws-board-view-column")?.textContent).toBe("Done");
    expect(primary()).toBeNull();
    expect(byText("Ask the coordinator")).toBeNull();
  });

  describe("an older server", () => {
    it("shows the card's facts, says tasks need a newer server and reads nothing", async () => {
      const card = makeCard({
        blocked: true,
        pullRequests: ["https://github.com/acme/app/pull/12"],
      });
      await render({ card, supported: false, threads: [thread("t1", "working")] });
      expect(runtime.inputs).toEqual([]);
      expect(container.querySelector("h3")?.textContent).toBe("Login form");
      expect(container.querySelector(".sws-board-view-progress")?.textContent).toBe("2/6 tasks");
      expect(byLabel("Open pull request #12")).not.toBeNull();
      expect(container.textContent).toContain("Tasks and criteria need a newer server");
      // It only knows the card is blocked: a bare Blocked block, no invented task.
      const boxes = [...container.querySelectorAll<HTMLElement>(".sws-board-view-blocker")];
      expect(boxes).toHaveLength(1);
      expect(boxes[0]!.querySelector(".sws-board-view-blocker-title")?.textContent).toBe("Blocked");
      // Without the detail, threads do not claim a task either way.
      expect(container.textContent).not.toContain("linked, task unknown");
      await act(async () => vi.advanceTimersByTime(BOARD_VIEW_REFRESH_MS * 3));
      expect(runtime.refresh).not.toHaveBeenCalled();
    });

    it("says so when the increment is not on the board either", async () => {
      await render({ card: null, supported: false });
      expect(container.textContent).toContain(
        "This increment is not on the board, and the machine that serves this project needs a newer SpecWithCode to read it.",
      );
    });
  });

  describe("missing and loading states", () => {
    it("says a removed increment is gone and offers the way back", async () => {
      runtime.reply = { projectId, incrementId: ID, increment: null };
      await render();
      expect(container.textContent).toContain("This increment is no longer on disk.");
      await click(byText("Back to the board"));
      expect(closed).toBe(1);
    });

    it("says the read failed", async () => {
      runtime.error = "offline";
      await render();
      expect(container.textContent).toContain("The increment could not be read: offline");
      expect(container.textContent).not.toContain("Reading tasks and criteria");
    });

    it("says it is reading, with and without the card", async () => {
      runtime.pending = true;
      await render();
      expect(container.textContent).toContain("Reading tasks and criteria…");
      expect(container.querySelector("h3")?.textContent).toBe("Login form");
      await act(async () => root.unmount());
      root = createRoot(container);
      await render({ card: null });
      expect(container.textContent).toContain("Reading the increment…");
      expect(container.querySelector("h3")?.textContent).toBe("login form");
    });

    it("takes the card from the answer when the board does not hold it", async () => {
      runtime.reply = detail(makeCard({ title: "From the read" }));
      await render({ card: null });
      expect(container.querySelector("h3")?.textContent).toBe("From the read");
      expect(section("Tasks")).not.toBeNull();
    });
  });

  describe("primary action", () => {
    it("opens the lead live thread, and keeps a question for the coordinator beside it", async () => {
      const card = makeCard();
      runtime.reply = detail(card);
      // The board hands threads most urgent first; the resolved and offline ones are skipped.
      await render({
        card,
        threads: [
          thread("t0", "unknown"),
          thread("t1", "waiting"),
          thread("t2", "working"),
          thread("r1", "resolved"),
        ],
      });
      expect(primary()?.textContent).toBe("Open thread");
      await click(primary());
      expect(opened).toEqual(["t1"]);
      await click(byText("Ask the coordinator"));
      expect(asked).toEqual([`About increment ${ID}: `]);
    });

    it.each([
      ["Continue", makeCard(), `Continue increment ${ID}: pick up its next open task.`],
      [
        "Start",
        makeCard({ column: "planned", status: "planned", tasks: { total: 3, done: 0 } }),
        `Start work on increment ${ID}: read its spec and begin with the first task.`,
      ],
      [
        "Review and close",
        makeCard({ column: "review", tasks: { total: 6, done: 6 } }),
        `Verify, review and close increment ${ID}.`,
      ],
    ] as const)("asks the coordinator to %s without a live thread", async (label, card, prompt) => {
      runtime.reply = detail(card);
      await render({ card, threads: [thread("r1", "resolved")] });
      expect(primary()?.textContent).toBe(label);
      expect(byText("Open thread")).toBeNull();
      await click(primary());
      expect(asked).toEqual([prompt]);
    });

    it("adds the same sentence to a request to unblock a task", async () => {
      const card = makeCard({ blocked: true, blockedTasks: 1, blockers: [blocker("T-02")] });
      runtime.reply = detail(card, { blockers: [blocker("T-02")] });
      await render({ card, threads: [thread("t1", "unknown")] });
      await click(byText("Unblock with the coordinator"));
      expect(asked).toHaveLength(1);
      expect(asked[0]).toMatch(
        /Unblock it: resolve what it waits for, or tell me what only I can do\. Check first: the thread "Thread t1" on Laptop cannot be reached now/,
      );
    });

    it("names a thread that cannot be reached in the request, so no second worker starts", async () => {
      const card = makeCard();
      runtime.reply = detail(card);
      await render({ card, threads: [thread("t1", "unknown"), thread("r1", "resolved")] });
      expect(primary()?.textContent).toBe("Continue");
      await click(primary());
      expect(asked).toEqual([
        `Continue increment ${ID}: pick up its next open task. Check first: the thread "Thread t1" on Laptop cannot be reached now and may still hold this work. Do not start another worker beside it.`,
      ]);
    });

    it("offers none to someone who cannot send", async () => {
      const card = makeCard();
      runtime.reply = detail(card);
      await render({ card, canAsk: false });
      expect(primary()).toBeNull();
      expect(byText("Ask the coordinator")).toBeNull();
    });
  });

  describe("refresh", () => {
    it("reads again when the board brings a newer change for the card", async () => {
      runtime.reply = detail(makeCard());
      await render({ card: makeCard() });
      await render({ card: makeCard() });
      expect(runtime.refresh).not.toHaveBeenCalled();
      await render({ card: makeCard({ updatedAt: "2026-11-16T11:45:00.000Z" }) });
      expect(runtime.refresh).toHaveBeenCalledTimes(1);
    });

    it("reads again every 10 seconds only while a thread shows work", async () => {
      runtime.reply = detail(makeCard());
      await render({ threads: [thread("t1", "idle"), thread("t2", "unknown")] });
      await act(async () => vi.advanceTimersByTime(BOARD_VIEW_REFRESH_MS * 3));
      expect(runtime.refresh).not.toHaveBeenCalled();
      await render({ threads: [thread("t1", "working")] });
      await act(async () => vi.advanceTimersByTime(BOARD_VIEW_REFRESH_MS * 3));
      expect(runtime.refresh).toHaveBeenCalledTimes(3);
      await render({ threads: [thread("t1", "resolved")] });
      await act(async () => vi.advanceTimersByTime(BOARD_VIEW_REFRESH_MS * 3));
      expect(runtime.refresh).toHaveBeenCalledTimes(3);
    });
  });

  it("makes every clickable thing a named button", async () => {
    const card = makeCard({
      blocked: true,
      blockedTasks: 1,
      paused: true,
      pausedReason: "Waiting for design",
      pullRequests: ["https://github.com/acme/app/pull/12"],
    });
    runtime.reply = detail(card, {
      tasks: [
        task("T-02", "blocked", { owner: "agent@desk", changedAt: BLOCKED_AT, leased: true }),
        task("T-03", "stale", { owner: "agent@desk" }),
      ],
      doneTasks: 1,
      blockers: [blocker("T-02")],
      criteria: [criterion("AC-01", "open")],
      reports: [{ path: "/work/atlas/reports/review.md", name: "review.md" }],
    });
    await render({
      card,
      showMachine: true,
      threads: [
        thread("t1", "working", { binding: "claim", boundTaskId: "T-02", boundAt: BLOCKED_AT }),
        ...Array.from({ length: 6 }, (_, index) => thread(`w${index}`, "working")),
        thread("r1", "resolved"),
      ],
    });
    const clickable = [...container.querySelectorAll<HTMLElement>("*")].filter((element) => {
      const key = Object.keys(element).find((name) => name.startsWith("__reactProps$"));
      const props = key ? (element as unknown as Record<string, { onClick?: unknown }>)[key] : null;
      return typeof props?.onClick === "function";
    });
    expect(clickable.length).toBeGreaterThan(10);
    for (const element of clickable) {
      expect(element.tagName).toBe("BUTTON");
      expect((element as HTMLButtonElement).type).toBe("button");
      const name = element.getAttribute("aria-label") ?? element.textContent ?? "";
      expect(name.trim()).not.toBe("");
    }
    expect(container.querySelectorAll('[role="button"]')).toHaveLength(0);
    // Nothing but the heading (focused on open) takes focus outside the tab order.
    expect([...container.querySelectorAll("[tabindex]")].map((element) => element.tagName)).toEqual(
      ["H3"],
    );
  });
});
