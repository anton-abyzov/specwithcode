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
    cut: false,
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
// The menu as plain markup: its trigger, then its items in place.
vi.mock("../../ui/menu", () => ({
  Menu: ({ children }: { children: ReactNode }) => <>{children}</>,
  MenuTrigger: ({ render, children, ...props }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, props, children),
  MenuPopup: ({ children }: { children: ReactNode }) => <div role="menu">{children}</div>,
  MenuItem: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" role="menuitem" onClick={onClick}>
      {children}
    </button>
  ),
}));
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
  cut: false,
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
    localStorage.clear();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** The page around the pane: it owns which increment is open, as navigation state would. */
  function Page(props: {
    specweave?: boolean;
    canAsk?: boolean;
    layout?: "split" | "full";
    columns?: boolean;
    project?: string;
  }) {
    // Each render hands the pane new props, so a re-render reads the mocks again.
    "use no memo";
    const [open, setOpen] = useState<string | null>(null);
    return (
      <BoardPane
        environmentId={EnvironmentId.make("host")}
        projectId={props.project ? ProjectId.make(props.project) : projectId}
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
        columns={props.columns ?? false}
      />
    );
  }
  const render = (
    extra: { specweave?: boolean; canAsk?: boolean; columns?: boolean; project?: string } = {},
  ) => act(async () => root.render(<Page {...extra} />));

  const button = (label: string) =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  const group = (name: string) => container.querySelector<HTMLElement>(`[data-group="${name}"]`)!;
  const cardIds = (name: string) =>
    [...(group(name)?.querySelectorAll<HTMLElement>("[data-increment]") ?? [])].map(
      (entry) => entry.dataset.increment,
    );
  const headings = () =>
    [...container.querySelectorAll(".sws-board-group h3")].map((heading) => heading.textContent);
  const heading = (name: string) => group(name).querySelector("h3")!.textContent;
  const bar = (name: string) => group(name).querySelector<HTMLButtonElement>(".sws-group-bar")!;
  const groupOrder = () =>
    [...container.querySelectorAll<HTMLElement>("[data-group]")].map((node) => node.dataset.group);
  const type = async (text: string) => {
    const input = container.querySelector<HTMLInputElement>('[aria-label="Find an increment"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => vi.advanceTimersByTime(300));
  };
  const article = (id: string) =>
    container.querySelector<HTMLElement>(`article[data-increment="${id}"]`)!;
  const view = () => container.querySelector<HTMLElement>("section.sws-board-view");

  it("shows the groups with their counts and cards, Blocked first", async () => {
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
    // Stacked, the stuck work comes first, then the work in motion, then the backlog.
    expect(groupOrder()).toEqual(["blocked", "active", "review", "planned", "done"]);
    expect(headings()).toEqual([
      "Blocked1 increment",
      "Active0 increments",
      "In review1 increment",
      "Planned1 increment",
      "Done558 increments",
    ]);
    const blocked = group("blocked");
    expect(blocked.textContent).toContain("0002");
    expect(blocked.textContent).toContain("Title 0002-build");
    expect(blocked.textContent).toContain("1/4 tasks done");
    expect(blocked.textContent).toContain("Blocked");
    expect(blocked.textContent).toContain("#371");
    // Under Blocked the card still says where the work stands.
    expect(article("0002-build").querySelector(".sws-board-card-state")?.textContent).toBe(
      "Active",
    );
    expect(article("0003-check").querySelector(".sws-board-card-state")).toBeNull();
    // No tasks yet: no meter and no count, only the offer to plan them.
    expect(group("planned").textContent).not.toContain("tasks done");
    expect(article("0001-plan").querySelector(".sws-board-meter")).toBeNull();
    // The task count is read with the card.
    const open = button("Open 0002 Title 0002-build")!;
    expect(document.getElementById(open.getAttribute("aria-describedby")!)?.textContent).toBe(
      "1/4 tasks done",
    );
    // A finished card shows no meter and no action.
    expect(article("0004-shipped").querySelector(".sws-board-meter")).toBeNull();
    expect(article("0004-shipped").querySelector(".sws-board-action")).toBeNull();
  });

  it("says how many increments are not done, and how far the project folder lags", async () => {
    runtime.reply = {
      ...board(
        [
          card("0001-plan", "planned"),
          card("0002-build", "active", {
            source: { kind: "worktree", name: "fix-lane" },
          }),
          card("0003-check", "review", {
            source: { kind: "remote", name: "origin/main", fetchedAt: null },
          }),
          card("0004-shipped", "done"),
        ],
        { done: 558 },
      ),
      // The whole project's number: a search narrows the columns, not this.
      notDone: 12,
      behind: { ref: "origin/main", count: 61, fetchedAt: "2026-11-14T09:00:00.000Z" },
    };
    await render();
    const summary = container.querySelector(".sws-board-summary");
    expect(summary?.querySelector(".sws-board-not-done")?.textContent).toBe("12 not done");
    const behind = summary?.querySelector<HTMLElement>(".sws-board-behind");
    expect(behind?.textContent).toBe("Project folder is 61 commits behind origin/main");
    // The column counts stay plain numbers.
    expect(headings()).toContain("Planned1 increment");
    expect(article("0002-build").querySelector(".sws-board-card-source")?.textContent).toBe(
      "From worktree fix-lane",
    );
    expect(article("0003-check").querySelector(".sws-board-card-source")?.textContent).toBe(
      "From origin/main",
    );
    expect(article("0001-plan").querySelector(".sws-board-card-source")).toBeNull();
  });

  it("adds up the columns for an older server, with no behind line", async () => {
    runtime.reply = board([card("0001-plan", "planned"), card("0002-build", "active")], {
      review: 3,
      done: 9,
    });
    await render();
    expect(container.querySelector(".sws-board-not-done")?.textContent).toBe("5 not done");
    expect(container.querySelector(".sws-board-behind")).toBeNull();
  });

  it("puts Blocked before the columns in the order work moves when side by side", async () => {
    runtime.reply = board([
      card("0001-plan", "planned"),
      card("0002-build", "active", { blocked: true, blockedTasks: 1 }),
    ]);
    await render({ columns: true });
    expect(groupOrder()).toEqual(["blocked", "planned", "active", "review", "done"]);
    expect(container.querySelector(".sws-board-columns")!.getAttribute("data-layout")).toBe(
      "columns",
    );
    // With the increment view open beside it the board is a stacked list again.
    await act(async () => button("Open 0001 Title 0001-plan")!.click());
    expect(groupOrder()).toEqual(["blocked", "active", "review", "planned", "done"]);
    expect(container.querySelector(".sws-board-columns")!.getAttribute("data-layout")).toBe(
      "stack",
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

  it("shows its setup in a project without SpecWeave, and reads nothing", async () => {
    await render({ specweave: false });
    // The tab's own words come from BoardSetup (1396); the old heading is gone.
    expect(container.textContent).not.toContain("Start a board for this project");
    expect(container.querySelector("#sws-pane-board button")?.textContent).toBe("Set up SpecWeave");
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
    expect(article("0002-build").querySelector(".sws-board-card-edge")).toBeNull();
    // The card's one action opens the same thread.
    await act(async () => button("Open thread Thread t1 on 0002")!.click());
    expect(opened).toEqual(["t1", "t1"]);
    opened.length = 1;
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
    expect(cardNode.querySelectorAll(".sws-board-thread")).toHaveLength(2);
    await act(async () =>
      cardNode
        .querySelector<HTMLButtonElement>('button[aria-label="Open thread Thread t2, Working"]')!
        .click(),
    );
    expect(opened).toEqual(["t2"]);
    // The card's edge takes the color of every machine an unresolved thread runs on, in
    // thread order; each line names its machine in that color, and a moved thread shows the arrow.
    expect(
      [...cardNode.querySelectorAll<HTMLElement>(".sws-board-card-edge > span")].map(
        (segment) => segment.dataset.machineColor,
      ),
    ).toEqual(["teal", "violet"]);
    const marks = [...cardNode.querySelectorAll<HTMLElement>(".sws-board-machine")];
    expect(marks.map((mark) => mark.dataset.machineColor)).toEqual(["teal", "violet"]);
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
    expect(group("done").querySelector(".sws-board-action")).toBeNull();
    expect(calls).toEqual([]);
    // Before the threads have said what they work on, a card is not offered as free.
    runtime.working = threadsOn([], false);
    await render();
    expect(container.querySelector(".sws-board-action")).toBeNull();
    runtime.working = threadsOn([]);
    // Someone who cannot send gets no such button.
    await render({ canAsk: false });
    expect(container.querySelector(".sws-board-action")).toBeNull();
  });

  it("gives every open card one action by what its threads can do", async () => {
    runtime.reply = board([
      card("0001-idle", "active"),
      card("0002-resolved", "active"),
      card("0003-offline", "active"),
      card("0004-two", "active"),
      card("0005-unplanned", "planned", { tasks: { total: 0, done: 0 } }),
    ]);
    runtime.working = threadsOn([
      ["0001-idle", [working("t1", "idle")]],
      ["0002-resolved", [working("t2", "resolved")]],
      ["0003-offline", [working("t3", "unknown")]],
      ["0004-two", [working("t4", "resolved"), working("t5", "waiting")]],
    ]);
    await render();
    const action = (id: string) =>
      [...article(id).querySelectorAll(".sws-board-action")].map((node) => node.textContent);
    // A thread that can be opened: open it, never start a second worker beside it.
    expect(action("0001-idle")).toEqual(["Open thread"]);
    // Only a resolved thread: nobody holds the work, so ask the coordinator.
    expect(action("0002-resolved")).toEqual(["Continue"]);
    // A thread on a machine that cannot be reached may still hold it: the
    // request names that thread, so the coordinator checks before starting anyone.
    expect(action("0003-offline")).toEqual(["Continue"]);
    await act(async () => button("Continue 0003 Title 0003-offline with the coordinator")!.click());
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("0003-offline");
    expect(asked[0]).toContain(
      'Check first: the thread "Thread t3" on Desk cannot be reached now and may still hold this work.',
    );
    asked.length = 0;
    await act(async () =>
      button("Continue 0002 Title 0002-resolved with the coordinator")!.click(),
    );
    expect(asked[0]).not.toContain("Check first");
    asked.length = 0;
    expect(action("0005-unplanned")).toEqual(["Plan the tasks"]);
    // The first thread that can be opened, not the first in the list.
    expect(action("0004-two")).toEqual(["Open thread"]);
    await act(async () => button("Open thread Thread t5 on 0004")!.click());
    expect(opened).toEqual(["t5"]);
    expect(asked).toEqual([]);
  });

  it("folds several pull requests into one chip with a menu", async () => {
    const pull = (number: number) => `https://github.com/acme/app/pull/${number}`;
    runtime.reply = board([
      card("0002-build", "active", { pullRequests: [pull(524), pull(76), pull(75)] }),
    ]);
    await render();
    const trigger = button("3 PRs on 0002: choose one to open")!;
    expect(trigger.textContent).toBe("3 PRs");
    const items = [...article("0002-build").querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map((item) => item.textContent)).toEqual(["#524", "#76", "#75"]);
    await act(async () => items[1]!.click());
    expect(runtime.openLink).toHaveBeenCalledWith(pull(76));
    expect(calls).toEqual([]);
    expect(view()).toBeNull();
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
    const moreActive = group("active").querySelector<HTMLButtonElement>(".sws-board-more")!;
    expect(moreActive.textContent).toBe("Show 31 more");
    await act(async () => moreActive.click());
    expect(cardIds("active")).toHaveLength(71);
    expect(group("active").querySelector(".sws-board-more")).toBeNull();

    const older = group("done").querySelector<HTMLButtonElement>(".sws-board-more")!;
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
      group("done").querySelector<HTMLButtonElement>(".sws-board-more")!.click(),
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
    // 1396 AC-15: a planning request for the coordinator, not a CLI hint.
    expect(container.textContent).toContain("No work planned yet.");
    expect(container.textContent).not.toContain("create-increment");
    const plan = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Plan the first piece of work",
    );
    await act(async () => plan!.click());
    expect(asked).toEqual([
      "Let's plan the first piece of work for this project. Ask me what it should be, then plan it as an increment.",
    ]);
    await act(async () => root.unmount());
    root = createRoot(container);
    await render({ canAsk: false });
    expect(container.textContent).toContain("No work planned yet.");
    expect(container.textContent).not.toContain("Plan the first piece of work");
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
      expect([heading("planned"), heading("active")]).toEqual([
        "Planned1 increment",
        "Active5 increments",
      ]);
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
      expect([heading("planned"), heading("active")]).toEqual([
        "Planned3 increments",
        "Active0 increments",
      ]);
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
      expect([heading("planned"), heading("active")]).toEqual([
        "Planned1 increment",
        "Active1 increment",
      ]);

      await act(async () => vi.advanceTimersByTime(1_000));
      expect(cardIds("active")).toEqual([]);
      expect(cardIds("planned")).toEqual(["0001-a", "0002-b"]);
      expect([heading("planned"), heading("active")]).toEqual([
        "Planned2 increments",
        "Active0 increments",
      ]);
    });

    it("moves nothing before the threads have answered", async () => {
      runtime.reply = board([card("0001-a", "planned")]);
      runtime.working = threadsOn([], false);
      await render();
      expect(cardIds("planned")).toEqual(["0001-a"]);
      expect(heading("planned")).toBe("Planned1 increment");
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
      [...article(id).querySelectorAll(".sws-board-reasons li:not(.sws-board-stuck)")].map(
        (entry) => entry.textContent,
      );
    const stuck = (id: string) =>
      article(id).querySelector(".sws-board-stuck")?.textContent ?? null;
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

      // Only paused: the reason line already starts "Paused:", so no line says it twice.
      expect(chip("0012-paused")).toBeNull();
      expect(reasons("0012-paused")).toEqual(["Paused: no reason given"]);

      expect(chip("0013-one")).toBe("1 task blocked");
      expect(reasons("0013-one")).toEqual(["T-02 Needs a design decision"]);
      // Three tasks are open and one is stuck: the rest can go on.
      expect(rest("0013-one")).toBe(true);
      expect(stuck("0013-one")).toBe("1 task blocked · rest can continue");
      expect(stuck("0011-both")).toBe("Paused + 2 tasks blocked");

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

  describe("the Blocked group", () => {
    const blockedBoard = () =>
      board([
        card("0001-plan", "planned", { blocked: true, paused: true, pausedReason: "Later" }),
        card("0002-plan", "planned"),
        card("0003-build", "active", { blocked: true, blockedTasks: 1 }),
        card("0004-build", "active"),
        card("0005-check", "review", { tasks: { total: 2, done: 2 } }),
        card("0006-shipped", "done"),
      ]);
    const allIds = () => ["blocked", "active", "review", "planned", "done"].flatMap(cardIds);

    it("takes every stuck card out of its column, and the counts still add up", async () => {
      runtime.reply = blockedBoard();
      await render();
      expect(cardIds("blocked")).toEqual(["0001-plan", "0003-build"]);
      expect(cardIds("planned")).toEqual(["0002-plan"]);
      expect(cardIds("active")).toEqual(["0004-build"]);
      expect(headings()).toEqual([
        "Blocked2 increments",
        "Active1 increment",
        "In review1 increment",
        "Planned1 increment",
        "Done1 increment",
      ]);
      expect(
        ["0001-plan", "0003-build"].map(
          (id) => article(id).querySelector(".sws-board-card-state")?.textContent,
        ),
      ).toEqual(["Planned", "Active"]);
      // Every card is on the board once.
      expect(allIds().toSorted()).toHaveLength(6);
      expect(new Set(allIds()).size).toBe(6);
    });

    it("has no switch, note or heading button for blocked work any more", async () => {
      runtime.reply = blockedBoard();
      await render();
      expect(container.querySelector(".sws-board-filter")).toBeNull();
      expect(container.querySelector(".sws-board-filter-note")).toBeNull();
      expect(container.querySelector(".sws-board-column-blocked")).toBeNull();
      expect(container.textContent).not.toContain("Blocked only");
    });

    it("counts a card that is paused and has blocked tasks once", async () => {
      runtime.reply = board([
        card("0001-both", "active", { blocked: true, paused: true, blockedTasks: 2 }),
      ]);
      await render();
      expect(heading("blocked")).toBe("Blocked1 increment");
      expect(heading("active")).toBe("Active0 increments");
    });

    it("is not shown when no card is blocked, and goes when the last one clears", async () => {
      runtime.reply = board([card("0001-plan", "planned"), card("0002-build", "active")]);
      await render();
      expect(groupOrder()).toEqual(["active", "review", "planned", "done"]);
      runtime.reply = blockedBoard();
      await render();
      expect(groupOrder()[0]).toBe("blocked");
      runtime.reply = board([card("0002-plan", "planned"), card("0004-build", "active")]);
      await render();
      expect(groupOrder()).toEqual(["active", "review", "planned", "done"]);
      expect(allIds()).toEqual(["0004-build", "0002-plan"]);
    });
  });

  describe("folding a group", () => {
    const some = () =>
      board([
        card("0001-plan", "planned"),
        card("0002-build", "active"),
        card("0003-stuck", "active", { blocked: true, blockedTasks: 1 }),
        ...Array.from({ length: 45 }, (_, index) => card(`${String(100 + index)}-done`, "done")),
      ]);

    it("hides a group's cards and its Show more behind its heading, and keeps the count", async () => {
      runtime.reply = some();
      await render();
      expect(bar("done").getAttribute("aria-expanded")).toBe("true");
      expect(group("done").querySelector(".sws-board-more")!.textContent).toBe("Show 5 more");
      await act(async () => bar("done").click());
      expect(bar("done").getAttribute("aria-expanded")).toBe("false");
      expect(bar("done").hasAttribute("aria-controls")).toBe(false);
      expect(cardIds("done")).toEqual([]);
      expect(group("done").querySelector(".sws-board-more")).toBeNull();
      expect(heading("done")).toBe("Done45 increments");
      expect(group("done").hasAttribute("data-folded")).toBe(true);
      // The others are untouched.
      expect(cardIds("active")).toEqual(["0002-build"]);
      await act(async () => bar("done").click());
      expect(cardIds("done")).toHaveLength(40);
    });

    it("remembers the folds of each project across a reload", async () => {
      runtime.reply = some();
      await render();
      await act(async () => bar("blocked").click());
      await act(async () => bar("done").click());
      await act(async () => root.unmount());
      root = createRoot(container);
      await render();
      expect(bar("blocked").getAttribute("aria-expanded")).toBe("false");
      expect(bar("done").getAttribute("aria-expanded")).toBe("false");
      expect(bar("active").getAttribute("aria-expanded")).toBe("true");
      // Another project's board starts open.
      await act(async () => root.unmount());
      root = createRoot(container);
      await render({ project: "other" });
      expect(bar("blocked").getAttribute("aria-expanded")).toBe("true");
      expect(bar("done").getAttribute("aria-expanded")).toBe("true");
      // Unfolding everything leaves nothing stored for the project.
      await act(async () => root.unmount());
      root = createRoot(container);
      await render();
      await act(async () => bar("blocked").click());
      await act(async () => bar("done").click());
      expect(JSON.parse(localStorage.getItem("studio:project-board-folded:v1")!)).toEqual({});
    });

    it("opens every group while a search is typed and gives the folds back after", async () => {
      runtime.reply = some();
      await render();
      await act(async () => bar("active").click());
      expect(cardIds("active")).toEqual([]);
      await type("build");
      expect(bar("active").getAttribute("aria-expanded")).toBe("true");
      expect(bar("active").getAttribute("aria-disabled")).toBe("true");
      expect(cardIds("active")).toEqual(["0002-build"]);
      // Locked while searching: a press changes nothing and stores nothing.
      await act(async () => bar("active").click());
      expect(cardIds("active")).toEqual(["0002-build"]);
      await type("");
      expect(bar("active").getAttribute("aria-expanded")).toBe("false");
      expect(bar("active").hasAttribute("aria-disabled")).toBe(false);
      expect(cardIds("active")).toEqual([]);
    });

    it("marks a folded group in the side by side layout, where it becomes a rail", async () => {
      runtime.reply = some();
      await render({ columns: true });
      await act(async () => bar("done").click());
      expect(group("done").hasAttribute("data-folded")).toBe(true);
      expect(group("done").querySelector(".sws-board-group-body")).toBeNull();
      expect(heading("done")).toBe("Done45 increments");
    });
  });

  describe("machines", () => {
    const fleet = (answered = true) => ({
      ...threadsOn(
        [
          ["0001-a", [working("t1", "working", { id: "desk", label: "Desk", color: "violet" })]],
          [
            "0002-b",
            [
              working("t2", "idle", { id: "laptop", label: "Laptop", color: "teal" }),
              working("t3", "working", { id: "desk", label: "Desk", color: "violet" }),
            ],
          ],
          ["0003-c", [working("t4", "resolved", { id: "laptop", label: "Laptop", color: "teal" })]],
          ["0005-e", [working("t5", "resolved", { id: "desk", label: "Desk", color: "violet" })]],
        ],
        answered,
      ),
      multiMachine: true,
    });
    const cards = () =>
      board([
        card("0001-a", "active"),
        card("0002-b", "active"),
        card("0003-c", "active", { blocked: true, blockedTasks: 1 }),
        card("0004-d", "planned"),
        card("0005-e", "done"),
      ]);
    const legend = () => container.querySelector<HTMLElement>(".sws-board-legend");
    const entries = () =>
      [...legend()!.querySelectorAll<HTMLElement>(".sws-board-legend-entry")].map(
        (entry) => entry.textContent,
      );
    const entry = (id: string) =>
      legend()!.querySelector<HTMLButtonElement>(`.sws-board-legend-entry[data-machine="${id}"]`)!;
    const shown = () => ["blocked", "active", "review", "planned", "done"].flatMap(cardIds);

    it("says what the edge colors mean, in the colors the cards carry", async () => {
      runtime.reply = cards();
      runtime.working = fleet();
      await render();
      expect(legend()!.textContent).toContain("Runs on");
      expect(entries()).toEqual(["All", "Desk2 cards", "Laptop1 card", "No thread2 cards"]);
      expect(entry("no-thread").disabled).toBe(false);
      expect(
        [...legend()!.querySelectorAll<HTMLElement>("[data-machine-dot]")].map(
          (dot) => dot.dataset.machineColor,
        ),
      ).toEqual(["violet", "teal"]);
      // A card with threads on two machines carries both, in its thread order.
      expect(
        [...article("0002-b").querySelectorAll<HTMLElement>(".sws-board-card-edge > span")].map(
          (segment) => segment.dataset.machineColor,
        ),
      ).toEqual(["teal", "violet"]);
      // The edge says the same in words, so color is never the only sign.
      expect(
        article("0002-b").querySelector(".sws-board-card-edge")!.getAttribute("aria-label"),
      ).toBe("Runs on Laptop and Desk");
      // A resolved thread colors nothing.
      expect(article("0003-c").querySelector(".sws-board-card-edge")).toBeNull();
      expect(article("0005-e").querySelector(".sws-board-card-edge")).toBeNull();
    });

    it("counts and colors open work only: finished work runs nowhere", async () => {
      runtime.reply = board([card("0001-a", "active"), card("0005-e", "done")]);
      runtime.working = {
        ...threadsOn([
          ["0001-a", [working("t1", "working", { id: "desk", label: "Desk" })]],
          // Finished, with a thread nobody settled, on another machine.
          ["0005-e", [working("t5", "idle", { id: "laptop", label: "Laptop", color: "teal" })]],
        ]),
        multiMachine: true,
      };
      await render();
      expect(entries()).toEqual(["Desk1 card"]);
      expect(article("0005-e").querySelector(".sws-board-card-edge")).toBeNull();
      // Its thread line still names the machine.
      expect(article("0005-e").querySelector(".sws-board-machine")!.textContent).toContain(
        "Laptop",
      );
    });

    it("narrows every group to one machine and counts what it shows", async () => {
      runtime.reply = cards();
      runtime.working = fleet();
      await render();
      expect(entry("desk").getAttribute("aria-pressed")).toBe("false");
      await act(async () => entry("desk").click());
      expect(entry("desk").getAttribute("aria-pressed")).toBe("true");
      expect(shown()).toEqual(["0001-a", "0002-b"]);
      expect(headings()).toEqual([
        "Blocked0 increments",
        "Active2 increments",
        "In review0 increments",
        "Planned0 increments",
        "Done1 increment",
      ]);
      await act(async () => entry("laptop").click());
      expect(shown()).toEqual(["0002-b"]);
      // Open work nobody holds: a resolved thread does not count, finished work never does.
      await act(async () => entry("no-thread").click());
      expect(shown()).toEqual(["0003-c", "0004-d"]);
      // Pressing the chosen entry again, or All, shows every card.
      await act(async () => entry("no-thread").click());
      expect(shown()).toHaveLength(5);
      await act(async () => entry("desk").click());
      await act(async () =>
        [...legend()!.querySelectorAll("button")]
          .find((node) => node.textContent === "All")!
          .click(),
      );
      expect(shown()).toHaveLength(5);
      expect(heading("blocked")).toBe("Blocked1 increment");
    });

    it("leaves finished work out while a machine is chosen, and says so", async () => {
      runtime.reply = board(
        [card("0001-a", "active"), card("0002-b", "active"), card("0005-e", "done")],
        { done: 40 },
      );
      runtime.working = fleet();
      await render();
      expect(group("done").querySelector(".sws-board-group-note")).toBeNull();
      expect(group("done").querySelector(".sws-board-more")!.textContent).toBe("Show older");
      await act(async () => entry("desk").click());
      expect(cardIds("done")).toEqual([]);
      expect(group("done").querySelector(".sws-board-group-note")!.textContent).toBe(
        "Finished work is not sorted by machine. Choose All to see it.",
      );
      // The heading keeps the whole count, and nothing offers to load more of nothing.
      expect(heading("done")).toBe("Done40 increments");
      expect(group("done").querySelector(".sws-board-more")).toBeNull();
    });

    it("lets a choice go when its machine has no card left", async () => {
      runtime.reply = cards();
      runtime.working = fleet();
      await render();
      await act(async () => entry("laptop").click());
      expect(shown()).toEqual(["0002-b"]);
      runtime.working = {
        ...threadsOn([
          ["0001-a", [working("t1", "working", { id: "desk", label: "Desk" })]],
          ["0002-b", [working("t3", "working", { id: "desk", label: "Desk" })]],
        ]),
        multiMachine: true,
      };
      await render();
      expect(shown()).toHaveLength(5);
      // The machine comes back: the board is not narrowed again unasked.
      runtime.working = fleet();
      await render();
      expect(entry("laptop").getAttribute("aria-pressed")).toBe("false");
      expect(shown()).toHaveLength(5);
    });

    it("lets a choice go when a search leaves its machine no match", async () => {
      runtime.reply = cards();
      runtime.working = fleet();
      await render();
      await act(async () => entry("laptop").click());
      expect(shown()).toEqual(["0002-b"]);
      // The search finds a card on another machine: showing nothing would read as "not found".
      await type("0001");
      runtime.reply = board([card("0001-a", "active")]);
      await render();
      expect(shown()).toEqual(["0001-a"]);
      await type("");
      runtime.reply = cards();
      await render();
      expect(entry("laptop").getAttribute("aria-pressed")).toBe("false");
      expect(shown()).toHaveLength(5);
    });

    it("keeps a choice whose machine is the only one a search leaves", async () => {
      runtime.reply = cards();
      runtime.working = fleet();
      await render();
      await act(async () => entry("desk").click());
      expect(shown()).toEqual(["0001-a", "0002-b"]);
      // Every match is on the chosen machine, so it is the legend's only entry.
      await type("0001");
      runtime.reply = board([card("0001-a", "active")]);
      await render();
      expect(entries()).toEqual(["All", "Desk1 card"]);
      expect(entry("desk").getAttribute("aria-pressed")).toBe("true");
      expect(shown()).toEqual(["0001-a"]);
      await type("");
      runtime.reply = cards();
      await render();
      expect(entry("desk").getAttribute("aria-pressed")).toBe("true");
      expect(shown()).toEqual(["0001-a", "0002-b"]);
      // The only entry left can still be let go.
      await type("0001");
      runtime.reply = board([card("0001-a", "active")]);
      await render();
      await act(async () => entry("desk").click());
      expect(shown()).toEqual(["0001-a"]);
      expect(legend()!.querySelector("button")).toBeNull();
    });

    it("waits for the threads before it counts, narrows or offers No thread", async () => {
      runtime.reply = cards();
      runtime.working = fleet(false);
      await render();
      expect(entries()).toEqual(["All", "Desk", "Laptop"]);
      expect(legend()!.querySelector('[role="status"]')!.textContent).toBe("Reading threads…");
      // Half the threads are joined: a machine cannot be chosen from that.
      expect(entry("desk").disabled).toBe(true);
      await act(async () => entry("desk").click());
      expect(shown()).toHaveLength(5);
    });

    it("keeps a choice while the threads are read again, and lets it be let go", async () => {
      runtime.reply = cards();
      runtime.working = fleet();
      await render();
      await act(async () => entry("laptop").click());
      // The list is being read again and the machine is not in it for a moment.
      runtime.working = {
        ...threadsOn(
          [["0001-a", [working("t1", "working", { id: "desk", label: "Desk" })]]],
          false,
        ),
        multiMachine: true,
      };
      await render();
      // The board stays narrowed meanwhile: it does not widen and narrow under the person.
      expect(shown()).toEqual([]);
      expect([...legend()!.querySelectorAll("button")].map((node) => node.textContent)).toContain(
        "All",
      );
      runtime.working = fleet(false);
      await render();
      expect(entry("laptop").getAttribute("aria-pressed")).toBe("true");
      expect(entry("laptop").disabled).toBe(false);
      expect(shown()).toEqual(["0002-b"]);
      await act(async () => entry("laptop").click());
      expect(shown()).toHaveLength(5);
    });

    it("can let a kept choice go when no machine has an entry for now", async () => {
      runtime.reply = cards();
      runtime.working = fleet();
      await render();
      await act(async () => entry("laptop").click());
      // A machine went off: the list never answers, and no open card has a thread left.
      runtime.working = { ...threadsOn([], false), multiMachine: true };
      await render();
      expect(shown()).toEqual([]);
      const all = [...legend()!.querySelectorAll("button")].find(
        (node) => node.textContent === "All",
      )!;
      await act(async () => all.click());
      expect(shown()).toHaveLength(5);
    });

    it("says so when the project has more threads than it reads", async () => {
      runtime.reply = cards();
      runtime.working = { ...fleet(false), cut: true };
      await render();
      expect(legend()!.querySelector('[role="status"]')!.textContent).toBe(
        "This project has more threads than the board reads, so it cannot be narrowed by machine.",
      );
      expect(entry("desk").disabled).toBe(true);
      // No card is offered as free either: its thread may be one that was not read.
      expect(article("0004-d").querySelector(".sws-board-action")).toBeNull();
      expect(article("0001-a").querySelector(".sws-board-action")!.textContent).toBe("Open thread");
    });

    it("is only a legend with one entry, and absent when nothing has a colored edge", async () => {
      const onDesk = {
        ...threadsOn([["0001-a", [working("t1", "working", { id: "desk", label: "Desk" })]]]),
        multiMachine: true,
      };
      // One machine and open work nobody holds: two entries, so they narrow.
      runtime.reply = cards();
      runtime.working = onDesk;
      await render();
      expect(entries()).toEqual(["All", "Desk1 card", "No thread3 cards"]);
      await act(async () => entry("no-thread").click());
      expect(shown()).toEqual(["0003-c", "0002-b", "0004-d"]);
      await act(async () => entry("no-thread").click());
      // Every open card on the one machine: a single entry, with nothing to press.
      runtime.reply = board([card("0001-a", "active"), card("0005-e", "done")]);
      await render();
      expect(legend()!.querySelector("button")).toBeNull();
      expect(entries()).toEqual(["Desk1 card"]);
      runtime.reply = cards();
      // One machine and no moved thread: no edge anywhere, so nothing to explain.
      runtime.working = threadsOn([["0001-a", [working("t1", "working")]]]);
      await render();
      expect(legend()).toBeNull();
      expect(container.querySelector(".sws-board-card-edge")).toBeNull();
    });
  });
});
