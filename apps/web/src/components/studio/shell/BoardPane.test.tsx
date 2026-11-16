// @vitest-environment jsdom
import {
  EnvironmentId,
  ProjectId,
  type ProjectBoardCard,
  type ProjectBoardResult,
} from "@specweave-studio/contracts";
import { act, cloneElement, useState, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ProjectPaneBarProps } from "./ProjectPaneBar";

const runtime = vi.hoisted(() => ({
  inputs: [] as Array<{ query?: string; doneLimit?: number }>,
  detailInputs: [] as Array<{ incrementId: string; includeDone?: boolean }>,
  reply: null as unknown,
  error: null as string | null,
  detail: null as unknown,
  detailError: null as string | null,
  refresh: vi.fn(),
  openLink: vi.fn(async (_url: string) => undefined),
  viewed: [] as string[],
  working: {
    byIncrement: new Map<string, unknown[]>(),
    multiMachine: false,
    answered: true,
    loaders: null,
  },
}));
vi.mock("./BoardThreads", async (original) => ({
  ...(await original<typeof import("./BoardThreads")>()),
  useBoardThreads: () => runtime.working,
}));
vi.mock("../../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, {}, children),
  TooltipPopup: () => null,
}));
vi.mock("../../../studio/projectWorkspace", () => ({
  projectWorkspace: {
    board: ({ input }: { input: { query?: string; doneLimit?: number } }) => {
      runtime.inputs.push(input);
      return { kind: "board", input };
    },
    boardIncrement: ({ input }: { input: { incrementId: string; includeDone?: boolean } }) => {
      runtime.detailInputs.push(input);
      return { kind: "increment", input };
    },
  },
}));
vi.mock("../../../state/query", () => ({
  useEnvironmentQuery: (atom: { kind: string } | null) =>
    atom === null
      ? { data: undefined, error: null, isPending: false, refresh: runtime.refresh }
      : atom.kind === "increment"
        ? {
            data: runtime.detail ?? undefined,
            error: runtime.detailError,
            isPending: false,
            refresh: runtime.refresh,
          }
        : { data: runtime.reply, error: runtime.error, isPending: false, refresh: runtime.refresh },
}));
vi.mock("../../../browser/useOpenLink", () => ({ useOpenLink: () => runtime.openLink }));
vi.mock("../../../hooks/useNowMinute", () => ({ useNowMinute: () => "2026-11-14T12:00" }));
vi.mock("./ProjectPaneBar", () => ({ ProjectPaneBar: () => null }));
vi.mock("./LibraryFileViewer", () => ({
  LibraryFileViewer: ({ path }: { path: string }) => {
    runtime.viewed.push(path);
    return <div data-testid="viewer">{path}</div>;
  },
}));

const { BoardPane } = await import("./BoardPane");

const projectId = ProjectId.make("atlas");
const card = (
  incrementId: string,
  column: ProjectBoardCard["column"],
  extra: Partial<ProjectBoardCard> = {},
): ProjectBoardCard => ({
  incrementId,
  title: `Title ${incrementId}`,
  status: column === "done" ? "completed" : column === "planned" ? "planned" : "active",
  column,
  tasks: { total: 4, done: 1 },
  blocked: false,
  updatedAt: "2026-11-14T09:00:00.000Z",
  pullRequests: [],
  specPath: `/work/atlas/.specweave/increments/${incrementId}/spec.md`,
  ...extra,
});
const board = (
  cards: ProjectBoardCard[],
  counts?: Partial<ProjectBoardResult["counts"]>,
  detail?: boolean,
): ProjectBoardResult => ({
  projectId,
  cards,
  counts: {
    planned: cards.filter((entry) => entry.column === "planned").length,
    active: cards.filter((entry) => entry.column === "active").length,
    review: cards.filter((entry) => entry.column === "review").length,
    done: cards.filter((entry) => entry.column === "done").length,
    ...counts,
  },
  ...(detail === undefined ? {} : { detail }),
});

/** One thread line as the hook hands it over. */
const working = (
  id: string,
  tone: string,
  machine: { label?: string; moved?: boolean; color?: string; id?: string } = {},
) => ({
  thread: { id, environmentId: "host", title: `Thread ${id}` },
  tone,
  status: tone === "resolved" ? null : tone === "waiting" ? "Needs you" : "Working",
  updatedAt: "2026-11-14T09:00:00.000Z",
  machine: {
    label: machine.label ?? "Desk",
    moved: machine.moved ?? false,
    executionMachineId: machine.id ?? "host",
    state: "live",
    description: machine.moved ? "Moved from Desk, runs on Laptop" : "Runs on Desk",
  },
  color: machine.color ?? "violet",
});
const threadsOn = (entries: Array<[string, unknown[]]>, answered = true) => ({
  byIncrement: new Map(entries),
  multiMachine: false,
  answered,
  loaders: null,
});

class NoResizeObserver {
  observe() {}
  disconnect() {}
}

describe("BoardPane", () => {
  let root: Root;
  let container: HTMLDivElement;
  const opened: string[] = [];
  const asked: string[] = [];
  const calls: Array<{ id: string | null; options?: { readonly replace?: boolean } }> = [];

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("ResizeObserver", NoResizeObserver);
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    runtime.inputs.length = 0;
    runtime.detailInputs.length = 0;
    runtime.viewed.length = 0;
    runtime.reply = null;
    runtime.error = null;
    runtime.detail = null;
    runtime.detailError = null;
    runtime.refresh.mockClear();
    runtime.openLink.mockClear();
    runtime.working = threadsOn([]);
    opened.length = 0;
    asked.length = 0;
    calls.length = 0;
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** The page around the pane: it owns which increment is open, as navigation state would. */
  function Page(props: { specweave?: boolean; canAsk?: boolean; layout?: "split" | "full" }) {
    // Each render hands the pane new props, so a re-render reads the mocks again.
    "use no memo";
    const [open, setOpen] = useState<string | null>(null);
    return (
      <BoardPane
        environmentId={EnvironmentId.make("host")}
        projectId={projectId}
        workspaceRoot="/work/atlas"
        bar={{} as ProjectPaneBarProps}
        specweave={props.specweave ?? true}
        setup={<button type="button">Set up SpecWeave</button>}
        threads={[]}
        onOpenThread={(thread) => opened.push(thread.id)}
        onAsk={props.canAsk === false ? undefined : (prompt) => asked.push(prompt)}
        openIncrement={open}
        onOpenIncrement={(id, options) => {
          calls.push(options === undefined ? { id } : { id, options });
          setOpen(id);
        }}
        layout={props.layout ?? "split"}
      />
    );
  }
  const render = (extra: { specweave?: boolean; canAsk?: boolean } = {}) =>
    act(async () => root.render(<Page {...extra} />));

  const button = (label: string) =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  const column = (name: string) => container.querySelector<HTMLElement>(`[data-column="${name}"]`)!;
  const cardIds = (name: string) =>
    [...column(name).querySelectorAll<HTMLElement>("[data-increment]")].map(
      (entry) => entry.dataset.increment,
    );
  const headings = () =>
    [...container.querySelectorAll(".sws-board-column h3")].map((heading) => heading.textContent);
  const article = (id: string) =>
    container.querySelector<HTMLElement>(`article[data-increment="${id}"]`)!;
  const view = () => container.querySelector<HTMLElement>("section.sws-board-view");

  it("shows four columns with their counts and cards", async () => {
    runtime.reply = board(
      [
        card("0001-plan", "planned", { tasks: { total: 0, done: 0 } }),
        card("0002-build", "active", {
          blocked: true,
          pullRequests: ["https://github.com/acme/app/pull/371"],
        }),
        card("0003-check", "review", { tasks: { total: 2, done: 2 } }),
        card("0004-shipped", "done"),
      ],
      { done: 558 },
    );
    await render();
    expect(headings()).toEqual([
      "Planned1 increments",
      "Active1 increments",
      "In review1 increments",
      "Done558 increments",
    ]);
    const active = column("active");
    expect(active.textContent).toContain("0002");
    expect(active.textContent).toContain("Title 0002-build");
    expect(active.textContent).toContain("1/4 tasks");
    expect(active.textContent).toContain("Blocked");
    expect(active.textContent).toContain("#371");
    expect(column("planned").textContent).not.toContain("tasks");
    // Stacked in a narrow panel, work in motion comes before the backlog.
    expect(["active", "review", "planned", "done"].map((name) => column(name).style.order)).toEqual(
      ["0", "1", "2", "3"],
    );
  });

  it("opens the increment view from a card and the pull request from its chip", async () => {
    runtime.reply = board([
      card("0002-build", "active", { pullRequests: ["https://github.com/acme/app/pull/371"] }),
    ]);
    await render();
    await act(async () => button("Open pull request #371")!.click());
    expect(runtime.openLink).toHaveBeenCalledWith("https://github.com/acme/app/pull/371");
    expect(view()).toBeNull();
    expect(calls).toEqual([]);
    const open = button("Open 0002 Title 0002-build")!;
    expect(open.getAttribute("aria-expanded")).toBe("false");
    await act(async () => open.click());
    expect(calls).toEqual([{ id: "0002-build" }]);
    expect(open.getAttribute("aria-expanded")).toBe("true");
    expect(open.getAttribute("aria-controls")).toBe(view()!.id);
    // The card opens the view, not the spec: the spec is one click away inside it.
    expect(runtime.viewed).toEqual([]);
    expect(container.textContent).not.toContain("Open the spec of");
    await act(async () =>
      [...view()!.querySelectorAll("button")]
        .find((entry) => entry.textContent === "Spec file")!
        .click(),
    );
    expect(container.querySelector('[data-testid="viewer"]')?.textContent).toBe(
      "/work/atlas/.specweave/increments/0002-build/spec.md",
    );
  });

  it("offers to turn the board on in a project without SpecWeave, and reads nothing", async () => {
    await render({ specweave: false });
    expect(container.querySelector("#sws-pane-board h3")?.textContent).toBe(
      "Start a board for this project",
    );
    expect(container.textContent).toContain("Set up SpecWeave");
    expect(runtime.inputs).toEqual([]);
  });

  it("opens a card's one thread from its line, while the card itself opens the view", async () => {
    runtime.reply = board([card("0002-build", "active")]);
    runtime.working = threadsOn([["0002-build", [working("t1", "working")]]]);
    await render();
    const line = article("0002-build").querySelector<HTMLButtonElement>(
      'button[aria-label="Open thread Thread t1, Working"]',
    )!;
    expect(line.textContent).toContain("Working");
    await act(async () => line.click());
    expect(opened).toEqual(["t1"]);
    expect(view()).toBeNull();
    expect(button("Open the thread working on 0002 Title 0002-build")).toBeNull();
    // One machine: no machine mark, no colored edge.
    expect(container.querySelector(".sws-board-machine")).toBeNull();
    expect(article("0002-build").hasAttribute("data-machine-color")).toBe(false);
    await act(async () => button("Open 0002 Title 0002-build")!.click());
    expect(opened).toEqual(["t1"]);
    expect(calls).toEqual([{ id: "0002-build" }]);
    expect(view()).not.toBeNull();
    expect(runtime.viewed).toEqual([]);
  });

  it("lists every thread of a card with several, most urgent first, each opening its own", async () => {
    runtime.reply = board([card("0002-build", "active")]);
    runtime.working = {
      ...threadsOn([
        [
          "0002-build",
          [
            working("t1", "waiting", {
              color: "teal",
              id: "laptop",
              label: "Desk → Laptop",
              moved: true,
            }),
            working("t2", "working"),
            working("t3", "working"),
            working("t4", "resolved"),
          ],
        ],
      ]),
      multiMachine: true,
    };
    await render();
    const cardNode = article("0002-build");
    expect(cardNode.querySelectorAll(".sws-board-thread")).toHaveLength(3);
    await act(async () =>
      cardNode
        .querySelector<HTMLButtonElement>('button[aria-label="Open thread Thread t2, Working"]')!
        .click(),
    );
    expect(opened).toEqual(["t2"]);
    // The card's edge and the line take the color of the machine the lead thread runs on,
    // and a thread that moved shows the arrow.
    expect(cardNode.dataset.machineColor).toBe("teal");
    const marks = [...cardNode.querySelectorAll<HTMLElement>(".sws-board-machine")];
    expect(marks.map((mark) => mark.dataset.machineColor)).toEqual(["teal", "violet", "violet"]);
    expect(marks[0]!.dataset.moved).toBe("true");
    expect(marks[0]!.textContent).toContain("→ Laptop");
    expect(marks[1]!.textContent).not.toContain("→");
    await act(async () =>
      cardNode.querySelector<HTMLButtonElement>(".sws-board-thread-more")!.click(),
    );
    expect(cardNode.querySelectorAll(".sws-board-thread")).toHaveLength(4);
    // Several threads: the card still opens the view, never one of them.
    await act(async () => button("Open 0002 Title 0002-build")!.click());
    expect(calls).toEqual([{ id: "0002-build" }]);
    expect(opened).toEqual(["t2"]);
  });

  it("hands the coordinator a request for an open card with no thread", async () => {
    runtime.reply = board([
      card("0001-plan", "planned", { tasks: { total: 3, done: 0 } }),
      card("0002-build", "active"),
      card("0003-check", "review", { tasks: { total: 2, done: 2 } }),
      card("0004-shipped", "done"),
    ]);
    await render();
    await act(async () => button("Start 0001 Title 0001-plan with the coordinator")!.click());
    await act(async () => button("Continue 0002 Title 0002-build with the coordinator")!.click());
    await act(async () =>
      button("Review and close 0003 Title 0003-check with the coordinator")!.click(),
    );
    expect(asked).toEqual([
      "Start work on increment 0001-plan: read its spec and begin with the first task.",
      "Continue increment 0002-build: pick up its next open task.",
      "Verify, review and close increment 0003-check.",
    ]);
    expect(column("done").querySelector(".sws-board-chip-ask")).toBeNull();
    expect(calls).toEqual([]);
    // Before the threads have said what they work on, a card is not offered as free.
    runtime.working = threadsOn([], false);
    await render();
    expect(container.querySelector(".sws-board-chip-ask")).toBeNull();
    runtime.working = threadsOn([]);
    // Someone who cannot send gets no such button.
    await render({ canAsk: false });
    expect(container.querySelector(".sws-board-chip-ask")).toBeNull();
  });

  it("pages a long column 40 at a time and asks the server for older Done cards", async () => {
    const active = Array.from({ length: 71 }, (_, index) =>
      card(`${String(1000 + index)}-active`, "active"),
    );
    const done = Array.from({ length: 30 }, (_, index) =>
      card(`${String(100 + index).padStart(4, "0")}-done`, "done"),
    );
    runtime.reply = board([...active, ...done], { done: 558 });
    await render();
    expect(cardIds("active")).toHaveLength(40);
    const moreActive = column("active").querySelector<HTMLButtonElement>(".sws-board-more")!;
    expect(moreActive.textContent).toBe("Show 31 more");
    await act(async () => moreActive.click());
    expect(cardIds("active")).toHaveLength(71);
    expect(column("active").querySelector(".sws-board-more")).toBeNull();

    const older = column("done").querySelector<HTMLButtonElement>(".sws-board-more")!;
    expect(older.textContent).toBe("Show older");
    await act(async () => older.click());
    expect(runtime.inputs.at(-1)).toMatchObject({ doneLimit: 90 });
  });

  it("searches as typed, after a short pause", async () => {
    runtime.reply = board([card("0002-build", "active")]);
    await render();
    const input = container.querySelector<HTMLInputElement>('[aria-label="Find an increment"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, " login ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(runtime.inputs.at(-1)).not.toHaveProperty("query");
    await act(async () => vi.advanceTimersByTime(300));
    expect(runtime.inputs.at(-1)).toMatchObject({ query: "login" });

    runtime.reply = board([]);
    await render();
    expect(container.textContent).toContain('No increment matches "login".');
  });

  it("starts each column at its first page again after a new search", async () => {
    const done = Array.from({ length: 30 }, (_, index) =>
      card(`${String(100 + index).padStart(4, "0")}-done`, "done"),
    );
    runtime.reply = board(done, { done: 558 });
    await render();
    await act(async () =>
      column("done").querySelector<HTMLButtonElement>(".sws-board-more")!.click(),
    );
    expect(runtime.inputs.at(-1)).toMatchObject({ doneLimit: 90 });
    const input = container.querySelector<HTMLInputElement>('[aria-label="Find an increment"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "login");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => vi.advanceTimersByTime(300));
    expect(runtime.inputs.at(-1)).toEqual({ projectId, query: "login" });
  });

  it("asks again every 30 seconds while the page is visible", async () => {
    runtime.reply = board([card("0002-build", "active")]);
    await render();
    await act(async () => vi.advanceTimersByTime(61_000));
    expect(runtime.refresh).toHaveBeenCalledTimes(2);
  });

  it("says so when there are no increments or the read fails", async () => {
    runtime.reply = board([]);
    await render();
    expect(container.textContent).toContain("No increments yet.");
    await act(async () => root.unmount());
    root = createRoot(container);
    runtime.reply = null;
    runtime.error = "offline";
    await render();
    expect(container.textContent).toContain("The board could not be read: offline");
  });

  describe("column by thread evidence", () => {
    it("shows a planned card with a working, waiting, failed or background thread under Active", async () => {
      runtime.reply = board([
        card("0001-a", "planned"),
        card("0002-b", "planned"),
        card("0003-c", "planned"),
        card("0004-d", "planned"),
        card("0005-e", "planned"),
        card("0006-f", "active"),
      ]);
      runtime.working = threadsOn([
        ["0001-a", [working("t1", "working")]],
        ["0002-b", [working("t2", "waiting")]],
        ["0003-c", [working("t3", "failed")]],
        ["0004-d", [working("t4", "background")]],
      ]);
      await render();
      expect(cardIds("planned")).toEqual(["0005-e"]);
      expect(cardIds("active").toSorted()).toEqual([
        "0001-a",
        "0002-b",
        "0003-c",
        "0004-d",
        "0006-f",
      ]);
      expect(headings().slice(0, 2)).toEqual(["Planned1 increments", "Active5 increments"]);
    });

    it("never moves a card for an idle, resolved or unknown thread", async () => {
      runtime.reply = board([
        card("0001-a", "planned"),
        card("0002-b", "planned"),
        card("0003-c", "planned"),
      ]);
      runtime.working = threadsOn([
        ["0001-a", [working("t1", "idle")]],
        ["0002-b", [working("t2", "unknown")]],
        ["0003-c", [working("t3", "resolved")]],
      ]);
      await render();
      expect(cardIds("planned")).toEqual(["0001-a", "0002-b", "0003-c"]);
      expect(cardIds("active")).toEqual([]);
      expect(headings().slice(0, 2)).toEqual(["Planned3 increments", "Active0 increments"]);
    });

    it("keeps a moved card in Active until the next refresh after its thread goes idle", async () => {
      runtime.reply = board([card("0001-a", "planned"), card("0002-b", "planned")]);
      runtime.working = threadsOn([["0001-a", [working("t1", "working")]]]);
      await render();
      expect(cardIds("active")).toEqual(["0001-a"]);

      runtime.working = threadsOn([["0001-a", [working("t1", "idle")]]]);
      await render();
      expect(cardIds("active")).toEqual(["0001-a"]);
      await act(async () => vi.advanceTimersByTime(29_000));
      expect(cardIds("active")).toEqual(["0001-a"]);
      expect(headings().slice(0, 2)).toEqual(["Planned1 increments", "Active1 increments"]);

      await act(async () => vi.advanceTimersByTime(1_000));
      expect(cardIds("active")).toEqual([]);
      expect(cardIds("planned")).toEqual(["0001-a", "0002-b"]);
      expect(headings().slice(0, 2)).toEqual(["Planned2 increments", "Active0 increments"]);
    });

    it("moves nothing before the threads have answered", async () => {
      runtime.reply = board([card("0001-a", "planned")]);
      runtime.working = threadsOn([], false);
      await render();
      expect(cardIds("planned")).toEqual(["0001-a"]);
      expect(headings()[0]).toBe("Planned1 increments");
      runtime.working = threadsOn([["0001-a", [working("t1", "working")]]]);
      await render();
      expect(cardIds("active")).toEqual(["0001-a"]);
    });
  });

  describe("blocked state on the card", () => {
    const blocker = (taskId: string, note: string | null) => ({
      taskId,
      title: `Task ${taskId}`,
      note,
      by: "agent@desk",
      at: "2026-11-14T08:00:00.000Z",
    });
    const chip = (id: string) =>
      article(id).querySelector(".sws-board-chip-blocked")?.textContent ?? null;
    const reasons = (id: string) =>
      [...article(id).querySelectorAll(".sws-board-reasons li")].map((entry) => entry.textContent);
    const rest = (id: string) => article(id).querySelector(".sws-board-rest") !== null;

    it("says what is stuck and why for each kind of block", async () => {
      runtime.reply = board([
        card("0011-both", "active", {
          blocked: true,
          paused: true,
          pausedReason: "Waiting for the signing keys",
          blockedTasks: 2,
          blockers: [blocker("T-03", "The staging API is down"), blocker("T-05", null)],
        }),
        card("0012-paused", "active", {
          status: "paused",
          blocked: true,
          paused: true,
          pausedReason: null,
        }),
        card("0013-one", "active", {
          blocked: true,
          paused: false,
          blockedTasks: 1,
          blockers: [blocker("T-02", "Needs a design decision")],
        }),
        card("0014-many", "active", {
          blocked: true,
          paused: false,
          blockedTasks: 3,
          blockers: [blocker("T-01", "a"), blocker("T-02", "b"), blocker("T-03", "c")],
        }),
        card("0015-old", "active", { blocked: true }),
        card("0016-free", "active"),
        card("0017-shipped", "done", { blocked: true, blockedTasks: 1 }),
      ]);
      await render();

      expect(chip("0011-both")).toBe("Paused + 2 tasks blocked");
      expect(reasons("0011-both")).toEqual([
        "Paused: Waiting for the signing keys",
        "T-03 The staging API is down",
        "and 1 more, open the card to see it",
      ]);
      expect(rest("0011-both")).toBe(false);

      expect(chip("0012-paused")).toBe("Paused");
      expect(reasons("0012-paused")).toEqual(["Paused: no reason given"]);

      expect(chip("0013-one")).toBe("1 task blocked");
      expect(reasons("0013-one")).toEqual(["T-02 Needs a design decision"]);
      // Three tasks are open and one is stuck: the rest can go on.
      expect(rest("0013-one")).toBe(true);

      expect(chip("0014-many")).toBe("3 tasks blocked");
      expect(reasons("0014-many")).toEqual([
        "T-01 a",
        "T-02 b",
        "and 1 more, open the card to see it",
      ]);
      // Every open task is blocked: nothing else to continue.
      expect(rest("0014-many")).toBe(false);

      // An older server knows only that something is blocked.
      expect(chip("0015-old")).toBe("Blocked");
      expect(reasons("0015-old")).toEqual([]);

      expect(chip("0016-free")).toBeNull();
      expect(chip("0017-shipped")).toBeNull();
      expect(
        [...container.querySelectorAll<HTMLElement>("article[data-blocked]")].map(
          (entry) => entry.dataset.increment,
        ),
      ).toEqual(["0011-both", "0012-paused", "0013-one", "0014-many", "0015-old"]);
    });

    it("shows a blocked task's missing reason and offers Resume for a paused card", async () => {
      runtime.reply = board([
        card("0021-paused", "active", { blocked: true, paused: true, pausedReason: "Holiday" }),
        card("0022-stuck", "active", {
          blocked: true,
          blockedTasks: 1,
          blockers: [blocker("T-04", "  ")],
        }),
      ]);
      await render();
      expect(reasons("0022-stuck")).toEqual(["T-04 blocked, no reason given"]);
      expect(button("Continue 0021 Title 0021-paused with the coordinator")).toBeNull();
      await act(async () => button("Resume 0021 Title 0021-paused with the coordinator")!.click());
      expect(asked).toEqual([
        'Resume increment 0021-paused: it is paused ("Holiday"). Check whether that still holds, then pick up its next open task.',
      ]);
    });
  });

  describe("Blocked only filter", () => {
    const blockedBoard = () =>
      board([
        card("0001-plan", "planned", { blocked: true, paused: true, pausedReason: "Later" }),
        card("0002-plan", "planned"),
        card("0003-build", "active", { blocked: true, blockedTasks: 1 }),
        card("0004-build", "active"),
        card("0005-check", "review", { tasks: { total: 2, done: 2 } }),
        card("0006-shipped", "done"),
      ]);
    const filter = () => container.querySelector<HTMLButtonElement>(".sws-board-filter");
    const note = () => container.querySelector<HTMLElement>(".sws-board-filter-note");
    const allIds = () => ["planned", "active", "review", "done"].flatMap(cardIds);

    it("narrows every column to its blocked cards and lets the note clear it", async () => {
      runtime.reply = blockedBoard();
      await render();
      expect(filter()!.textContent).toBe("Blocked only · 2 cards");
      expect(filter()!.getAttribute("aria-pressed")).toBe("false");
      expect(note()).toBeNull();
      await act(async () => filter()!.click());
      expect(filter()!.getAttribute("aria-pressed")).toBe("true");
      expect(allIds()).toEqual(["0001-plan", "0003-build"]);
      // The headings still count the whole column.
      expect(headings()).toEqual([
        "Planned2 increments",
        "Active2 increments",
        "In review1 increments",
        "Done1 increments",
      ]);
      expect(note()!.textContent).toContain("Showing only the cards that are paused");
      await act(async () =>
        [...note()!.querySelectorAll("button")]
          .find((entry) => entry.textContent === "Show all cards")!
          .click(),
      );
      expect(filter()!.getAttribute("aria-pressed")).toBe("false");
      expect(note()).toBeNull();
      expect(allIds()).toHaveLength(6);
    });

    it("toggles the same filter from each column's blocked heading", async () => {
      runtime.reply = blockedBoard();
      await render();
      const plannedBlocked = button("1 blocked in Planned: show blocked cards only")!;
      expect(plannedBlocked.textContent).toBe("1 blocked");
      expect(button("1 blocked in Active: show blocked cards only")).not.toBeNull();
      expect(column("review").querySelector(".sws-board-column-blocked")).toBeNull();
      await act(async () => plannedBlocked.click());
      expect(filter()!.getAttribute("aria-pressed")).toBe("true");
      expect(plannedBlocked.getAttribute("aria-pressed")).toBe("true");
      expect(allIds()).toEqual(["0001-plan", "0003-build"]);
      await act(async () => button("1 blocked in Active: show blocked cards only")!.click());
      expect(filter()!.getAttribute("aria-pressed")).toBe("false");
      expect(allIds()).toHaveLength(6);
    });

    it("counts a card that is paused and has blocked tasks once", async () => {
      runtime.reply = board([
        card("0001-both", "active", { blocked: true, paused: true, blockedTasks: 2 }),
      ]);
      await render();
      expect(filter()!.textContent).toBe("Blocked only · 1 card");
      expect(button("1 blocked in Active: show blocked cards only")).not.toBeNull();
    });

    it("is not offered when no card is blocked", async () => {
      runtime.reply = board([card("0001-plan", "planned"), card("0002-build", "active")]);
      await render();
      expect(filter()).toBeNull();
      expect(container.querySelector(".sws-board-column-blocked")).toBeNull();
      expect(container.querySelector(".sws-board-tools")!.textContent).not.toContain("Blocked");
    });

    it("drops itself when the last blocked card goes away", async () => {
      runtime.reply = blockedBoard();
      await render();
      await act(async () => filter()!.click());
      expect(allIds()).toEqual(["0001-plan", "0003-build"]);
      runtime.reply = board([card("0002-plan", "planned"), card("0004-build", "active")]);
      await render();
      expect(filter()).toBeNull();
      expect(note()).toBeNull();
      expect(allIds()).toEqual(["0002-plan", "0004-build"]);
      // A card blocked later does not bring back a filter nobody turned on again.
      runtime.reply = blockedBoard();
      await render();
      expect(filter()!.getAttribute("aria-pressed")).toBe("false");
      expect(allIds()).toHaveLength(6);
    });
  });
});
