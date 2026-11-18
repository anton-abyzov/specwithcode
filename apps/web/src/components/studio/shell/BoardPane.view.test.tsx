// @vitest-environment jsdom
import {
  EnvironmentId,
  ProjectId,
  type ProjectBoardCard,
  type ProjectBoardIncrementResult,
  type ProjectBoardResult,
} from "@specweave-studio/contracts";
import { act, cloneElement, useState, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ProjectPaneBarProps } from "./ProjectPaneBar";

// The same mocks as BoardPane.test.tsx: the board and the increment read answer separately.
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
const board = (cards: ProjectBoardCard[], detail = true): ProjectBoardResult => ({
  projectId,
  cards,
  counts: {
    planned: cards.filter((entry) => entry.column === "planned").length,
    active: cards.filter((entry) => entry.column === "active").length,
    review: cards.filter((entry) => entry.column === "review").length,
    done: cards.filter((entry) => entry.column === "done").length,
  },
  ...(detail ? { detail: true } : {}),
});
const detailOf = (entry: ProjectBoardCard): ProjectBoardIncrementResult => ({
  projectId,
  incrementId: entry.incrementId,
  increment: {
    card: entry,
    problem: "Sign-in breaks on the second device.",
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
  },
});

class NoResizeObserver {
  observe() {}
  disconnect() {}
}

/** Planned in the DOM first, but stacked Active, In review, Planned, Done. */
const fourCards = () => [
  card("0001-plan", "planned"),
  card("0002-build", "active"),
  card("0003-build", "active"),
  card("0004-check", "review", { tasks: { total: 2, done: 2 } }),
];

describe("BoardPane increment view", () => {
  let root: Root;
  let container: HTMLDivElement;
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
    runtime.working = {
      byIncrement: new Map(),
      multiMachine: false,
      answered: true,
      cut: false,
      loaders: null,
    };
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
  function Page(props: { layout: "split" | "full"; initial: string | null }) {
    // Each render hands the pane new props, so a re-render reads the mocks again.
    "use no memo";
    const [open, setOpen] = useState<string | null>(props.initial);
    return (
      <BoardPane
        environmentId={EnvironmentId.make("host")}
        projectId={projectId}
        workspaceRoot="/work/atlas"
        bar={{} as ProjectPaneBarProps}
        specweave
        setup={null}
        threads={[]}
        onOpenThread={() => undefined}
        onAsk={() => undefined}
        openIncrement={open}
        onOpenIncrement={(id, options) => {
          calls.push(options === undefined ? { id } : { id, options });
          setOpen(id);
        }}
        layout={props.layout}
      />
    );
  }
  const render = (extra: { layout?: "split" | "full"; initial?: string | null } = {}) =>
    act(async () =>
      root.render(<Page layout={extra.layout ?? "split"} initial={extra.initial ?? null} />),
    );

  const pane = () => container.querySelector<HTMLElement>(".sws-board")!;
  const view = () => container.querySelector<HTMLElement>("section.sws-board-view");
  const opener = (id: string) =>
    container.querySelector<HTMLButtonElement>(`button[data-board-card="${id}"]`)!;
  const groupBar = (group: string) =>
    container.querySelector<HTMLButtonElement>(`[data-group="${group}"] .sws-group-bar`)!;
  const labelled = (label: string) =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  const byText = (scope: HTMLElement, text: string) =>
    [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
      (entry) => entry.textContent === text,
    )!;
  const key = async (target: HTMLElement, name: string) => {
    const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
    await act(async () => target.dispatchEvent(event));
    return event;
  };
  const viewTitle = () => {
    const region = view()!;
    return container.querySelector<HTMLElement>(
      `#${CSS.escape(region.getAttribute("aria-labelledby")!)}`,
    );
  };

  describe("opening", () => {
    it("opens a card's view without replacing history, labelled by its heading", async () => {
      runtime.reply = board(fourCards());
      await render();
      expect(view()).toBeNull();
      expect(pane().hasAttribute("data-view")).toBe(false);
      await act(async () => opener("0002-build").click());
      expect(calls).toEqual([{ id: "0002-build" }]);
      expect(viewTitle()?.textContent).toBe("Title 0002-build");
      expect(viewTitle()?.tagName).toBe("H3");
      expect(view()!.closest(".sws-board")).toBe(pane());
      expect(pane().dataset.view).toBe("split");
      expect(
        container.querySelector('article[data-increment="0002-build"]')!.hasAttribute("data-open"),
      ).toBe(true);
      expect(runtime.detailInputs.at(-1)).toEqual({ projectId, incrementId: "0002-build" });
    });

    it("opens from Enter and Space through the card's own button activation", async () => {
      runtime.reply = board(fourCards());
      await render();
      const target = opener("0002-build");
      expect(target.tagName).toBe("BUTTON");
      expect(target.type).toBe("button");
      target.focus();
      // The pane leaves Enter and Space to the browser, which turns them into a click.
      for (const name of ["Enter", " "]) {
        const event = await key(target, name);
        expect(event.defaultPrevented).toBe(false);
      }
      expect(calls).toEqual([]);
      await act(async () => target.click());
      expect(calls).toEqual([{ id: "0002-build" }]);
      expect(view()).not.toBeNull();
    });

    it("never opens or changes the card from Enter or Space elsewhere", async () => {
      runtime.reply = board([
        ...fourCards(),
        card("0005-stuck", "active", { blocked: true, blockedTasks: 1 }),
      ]);
      runtime.detail = detailOf(card("0002-build", "active"));
      await render();
      const search = container.querySelector<HTMLInputElement>('[aria-label="Find an increment"]')!;
      search.focus();
      for (const name of ["Enter", " "]) await key(search, name);
      expect(calls).toEqual([]);
      expect(view()).toBeNull();

      const bar = groupBar("blocked");
      for (const name of ["Enter", " "]) await key(bar, name);
      await act(async () => bar.click());
      expect(groupBar("blocked").getAttribute("aria-expanded")).toBe("false");
      expect(calls).toEqual([]);
      await act(async () => groupBar("blocked").click());

      await act(async () => opener("0002-build").click());
      calls.length = 0;
      const spec = byText(view()!, "Open spec file");
      spec.focus();
      for (const name of ["Enter", " "]) {
        const event = await key(spec, name);
        expect(event.defaultPrevented).toBe(false);
      }
      await act(async () => spec.click());
      expect(calls).toEqual([]);
      expect(viewTitle()?.textContent).toBe("Title 0002-build");
      expect(runtime.viewed.at(-1)).toBe("/work/atlas/.specweave/increments/0002-build/spec.md");
    });
  });

  describe("arrows", () => {
    it("walk cards in the stacked order only while focus is on a card", async () => {
      runtime.reply = board(fourCards());
      await render();
      const first = opener("0002-build");
      first.focus();
      await key(first, "ArrowDown");
      expect(document.activeElement).toBe(opener("0003-build"));
      await key(document.activeElement as HTMLElement, "ArrowDown");
      // Stacked, In review comes before Planned although Planned is first in the page.
      expect(document.activeElement).toBe(opener("0004-check"));
      await key(document.activeElement as HTMLElement, "ArrowDown");
      expect(document.activeElement).toBe(opener("0001-plan"));
      await key(document.activeElement as HTMLElement, "ArrowDown");
      expect(document.activeElement).toBe(opener("0001-plan"));
      await key(document.activeElement as HTMLElement, "ArrowUp");
      expect(document.activeElement).toBe(opener("0004-check"));
      expect(calls).toEqual([]);

      const search = container.querySelector<HTMLInputElement>('[aria-label="Find an increment"]')!;
      search.focus();
      const fromSearch = await key(search, "ArrowDown");
      expect(fromSearch.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(search);
    });

    it("re-target the open view with replace, and do nothing from inside the view", async () => {
      runtime.reply = board(fourCards());
      await render();
      const first = opener("0002-build");
      first.focus();
      await act(async () => first.click());
      await key(first, "ArrowDown");
      expect(document.activeElement).toBe(opener("0003-build"));
      expect(calls).toEqual([
        { id: "0002-build" },
        { id: "0003-build", options: { replace: true } },
      ]);
      expect(viewTitle()?.textContent).toBe("Title 0003-build");
      await key(opener("0003-build"), "ArrowUp");
      expect(calls.at(-1)).toEqual({ id: "0002-build", options: { replace: true } });

      calls.length = 0;
      const close = labelled("Close the increment view");
      close.focus();
      await key(close, "ArrowDown");
      await key(viewTitle()!, "ArrowUp");
      expect(calls).toEqual([]);
      expect(viewTitle()?.textContent).toBe("Title 0002-build");
    });
  });

  describe("closing", () => {
    it("closes on Escape with replace and gives focus back to the card", async () => {
      runtime.reply = board(fourCards());
      await render();
      await act(async () => opener("0003-build").click());
      const close = labelled("Close the increment view");
      close.focus();
      await key(close, "Escape");
      expect(calls.at(-1)).toEqual({ id: null, options: { replace: true } });
      expect(view()).toBeNull();
      expect(pane().hasAttribute("data-view")).toBe(false);
      expect(document.activeElement).toBe(opener("0003-build"));
      expect(opener("0003-build").getAttribute("aria-expanded")).toBe("false");
    });

    it("hands focus to the group's heading when its group was folded", async () => {
      runtime.reply = board([
        card("0002-build", "active"),
        card("0003-stuck", "active", { blocked: true, blockedTasks: 1 }),
      ]);
      await render();
      await act(async () => opener("0002-build").click());
      await act(async () => groupBar("active").click());
      expect(container.querySelector('[data-board-card="0002-build"]')).toBeNull();
      expect(viewTitle()?.textContent).toBe("Title 0002-build");
      const close = labelled("Close the increment view");
      close.focus();
      await key(close, "Escape");
      expect(document.activeElement).toBe(groupBar("active"));
    });

    it("hands focus to the group's heading when a refresh removed the card", async () => {
      runtime.reply = board([card("0001-plan", "planned"), card("0004-check", "review")]);
      await render();
      await act(async () => opener("0004-check").click());
      runtime.reply = board([card("0001-plan", "planned")]);
      await render();
      expect(view()).not.toBeNull();
      const close = labelled("Close the increment view");
      close.focus();
      await key(close, "Escape");
      expect(calls.at(-1)).toEqual({ id: null, options: { replace: true } });
      expect(document.activeElement).toBe(groupBar("review"));
    });
  });

  describe("folded groups", () => {
    const stuck = () => card("0005-stuck", "active", { blocked: true, blockedTasks: 1 });

    it("walks only the cards on screen, Blocked first, and never into a folded group", async () => {
      runtime.reply = board([...fourCards(), stuck()]);
      await render();
      await act(async () => groupBar("review").click());
      opener("0005-stuck").focus();
      await key(opener("0005-stuck"), "ArrowDown");
      expect(document.activeElement).toBe(opener("0002-build"));
      await key(opener("0002-build"), "ArrowDown");
      await key(opener("0003-build"), "ArrowDown");
      // In review is folded: the next card on screen is the planned one.
      expect(document.activeElement).toBe(opener("0001-plan"));
      await act(async () => opener("0003-build").click());
      await act(async () => labelled("Next card").click());
      expect(calls.at(-1)).toEqual({ id: "0001-plan", options: { replace: true } });
    });

    it("unfolds the group of an increment opened by a link, and remembers it", async () => {
      localStorage.setItem(
        "studio:project-board-folded:v1",
        JSON.stringify({ "host:atlas": ["review", "done"] }),
      );
      runtime.reply = board(fourCards());
      await render({ initial: "0004-check" });
      expect(viewTitle()?.textContent).toBe("Title 0004-check");
      expect(groupBar("review").getAttribute("aria-expanded")).toBe("true");
      expect(opener("0004-check")).not.toBeNull();
      expect(JSON.parse(localStorage.getItem("studio:project-board-folded:v1")!)).toEqual({
        "host:atlas": ["done"],
      });
    });

    it("unfolds nothing when the open card changes group", async () => {
      runtime.reply = board([card("0002-build", "active"), stuck()]);
      await render();
      await act(async () => groupBar("blocked").click());
      await act(async () => opener("0002-build").click());
      // A refresh finds the open card blocked: it moves under Blocked, which stays folded.
      runtime.reply = board([
        card("0002-build", "active", { blocked: true, blockedTasks: 1 }),
        stuck(),
      ]);
      await render();
      expect(viewTitle()?.textContent).toBe("Title 0002-build");
      expect(groupBar("blocked").getAttribute("aria-expanded")).toBe("false");
      expect(container.querySelector('[data-board-card="0002-build"]')).toBeNull();
    });

    it("opens the group at once and follows a planned card the threads move to Active", async () => {
      localStorage.setItem(
        "studio:project-board-folded:v1",
        JSON.stringify({ "host:atlas": ["planned", "active"] }),
      );
      const atWork = {
        thread: { id: "t1", environmentId: "host", title: "Thread t1" },
        tone: "working",
        status: "Working",
        updatedAt: "2026-11-14T09:00:00.000Z",
        machine: {
          label: "Desk",
          moved: false,
          executionMachineId: "host",
          state: "live",
          description: "Runs on Desk",
        },
        color: "violet",
      };
      runtime.reply = board(fourCards());
      runtime.working = {
        byIncrement: new Map(),
        multiMachine: false,
        answered: false,
        cut: false,
        loaders: null,
      };
      await render({ initial: "0001-plan" });
      // The threads have not answered, and may never: the card is shown where it is now.
      expect(viewTitle()?.textContent).toBe("Title 0001-plan");
      expect(groupBar("planned").getAttribute("aria-expanded")).toBe("true");
      expect(opener("0001-plan")).not.toBeNull();
      // The threads answer: one is at work on the planned card, so it is Active.
      runtime.working = {
        byIncrement: new Map([["0001-plan", [atWork]]]),
        multiMachine: false,
        answered: true,
        cut: false,
        loaders: null,
      };
      await render({ initial: "0001-plan" });
      expect(groupBar("active").getAttribute("aria-expanded")).toBe("true");
      expect(groupBar("planned").getAttribute("aria-expanded")).toBe("false");
      expect(opener("0001-plan").closest("[data-group]")!.getAttribute("data-group")).toBe(
        "active",
      );
      // It moved before it settled: the fold it opened was given back.
      expect(JSON.parse(localStorage.getItem("studio:project-board-folded:v1")!)).toEqual({
        "host:atlas": ["planned"],
      });
    });

    it("follows no other move, and leaves a fold made by hand alone", async () => {
      const key = "studio:project-board-folded:v1";
      const stored = () =>
        (JSON.parse(localStorage.getItem(key)!) as Record<string, string[]>)[
          "host:atlas"
        ]!.toSorted();
      localStorage.setItem(key, JSON.stringify({ "host:atlas": ["planned", "blocked"] }));
      const others = () => [...fourCards().slice(1), stuck()];
      runtime.reply = board([card("0001-plan", "planned"), ...others()]);
      // A machine that is off never answers, so the planned card never settles by itself.
      runtime.working = {
        byIncrement: new Map(),
        multiMachine: false,
        answered: false,
        cut: false,
        loaders: null,
      };
      await render({ initial: "0001-plan" });
      expect(stored()).toEqual(["blocked"]);
      // The person folds Planned again, by hand.
      await act(async () => groupBar("planned").click());
      expect(stored()).toEqual(["blocked", "planned"]);
      // A refresh finds the open card blocked, and a later one finds it planned again.
      runtime.reply = board([
        card("0001-plan", "planned", { blocked: true, blockedTasks: 1 }),
        ...others(),
      ]);
      await render({ initial: "0001-plan" });
      expect(stored()).toEqual(["blocked", "planned"]);
      runtime.reply = board([card("0001-plan", "planned"), ...others()]);
      await render({ initial: "0001-plan" });
      expect(stored()).toEqual(["blocked", "planned"]);
      expect(viewTitle()?.textContent).toBe("Title 0001-plan");
    });

    it("leaves a fold of Active made by hand alone when the threads promote the card", async () => {
      const key = "studio:project-board-folded:v1";
      localStorage.setItem(key, JSON.stringify({ "host:atlas": ["planned"] }));
      runtime.reply = board(fourCards());
      runtime.working = {
        byIncrement: new Map(),
        multiMachine: false,
        answered: false,
        cut: false,
        loaders: null,
      };
      await render({ initial: "0001-plan" });
      // The person folds Active before the threads have answered.
      await act(async () => groupBar("active").click());
      runtime.working = {
        byIncrement: new Map([
          [
            "0001-plan",
            [
              {
                thread: { id: "t1", environmentId: "host", title: "Thread t1" },
                tone: "working",
                status: "Working",
                updatedAt: "2026-11-14T09:00:00.000Z",
                machine: {
                  label: "Desk",
                  moved: false,
                  executionMachineId: "host",
                  state: "live",
                  description: "Runs on Desk",
                },
                color: "violet",
              },
            ],
          ],
        ]),
        multiMachine: false,
        answered: true,
        cut: false,
        loaders: null,
      };
      await render({ initial: "0001-plan" });
      expect(groupBar("active").getAttribute("aria-expanded")).toBe("false");
      expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ "host:atlas": ["active"] });
      expect(viewTitle()?.textContent).toBe("Title 0001-plan");
    });

    it("does not follow a card the board moves, only one the threads promote", async () => {
      const key = "studio:project-board-folded:v1";
      localStorage.setItem(key, JSON.stringify({ "host:atlas": ["planned", "blocked"] }));
      const others = () => [...fourCards().slice(1), stuck()];
      runtime.reply = board([card("0001-plan", "planned"), ...others()]);
      runtime.working = {
        byIncrement: new Map(),
        multiMachine: false,
        answered: false,
        cut: false,
        loaders: null,
      };
      await render({ initial: "0001-plan" });
      runtime.reply = board([
        card("0001-plan", "planned", { blocked: true, blockedTasks: 1 }),
        ...others(),
      ]);
      await render({ initial: "0001-plan" });
      // Blocked stays folded and Planned keeps the fold the link opened: nothing is given back.
      expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ "host:atlas": ["blocked"] });
    });

    it("never waits on the threads for a card that cannot move", async () => {
      localStorage.setItem(
        "studio:project-board-folded:v1",
        JSON.stringify({ "host:atlas": ["review"] }),
      );
      runtime.reply = board(fourCards());
      // A machine that is off never answers.
      runtime.working = {
        byIncrement: new Map(),
        multiMachine: false,
        answered: false,
        cut: false,
        loaders: null,
      };
      await render({ initial: "0004-check" });
      expect(groupBar("review").getAttribute("aria-expanded")).toBe("true");
      // Settled at once: the person can fold it again and it stays folded.
      await act(async () => groupBar("review").click());
      expect(groupBar("review").getAttribute("aria-expanded")).toBe("false");
      expect(viewTitle()?.textContent).toBe("Title 0004-check");
    });
  });

  describe("a card that moves under the keyboard", () => {
    it("keeps focus on the card when a refresh moves it to another group", async () => {
      runtime.reply = board(fourCards());
      await render();
      opener("0002-build").focus();
      runtime.reply = board([
        card("0001-plan", "planned"),
        card("0002-build", "active", { blocked: true, blockedTasks: 1 }),
        card("0003-build", "active"),
        card("0004-check", "review"),
      ]);
      await render();
      expect(opener("0002-build").closest("[data-group]")!.getAttribute("data-group")).toBe(
        "blocked",
      );
      expect(document.activeElement).toBe(opener("0002-build"));
    });

    it("moves focus to the group's heading when a refresh takes the card away", async () => {
      runtime.reply = board(fourCards());
      await render();
      opener("0003-build").focus();
      runtime.reply = board(fourCards().filter((entry) => entry.incrementId !== "0003-build"));
      await render();
      expect(document.activeElement).toBe(groupBar("active"));
    });

    it("moves focus to the heading when the card lands in a folded group", async () => {
      const stuck = card("0005-stuck", "active", { blocked: true, blockedTasks: 1 });
      runtime.reply = board([...fourCards(), stuck]);
      await render();
      await act(async () => groupBar("blocked").click());
      opener("0002-build").focus();
      runtime.reply = board([
        ...fourCards().filter((entry) => entry.incrementId !== "0002-build"),
        card("0002-build", "active", { blocked: true, blockedTasks: 1 }),
        stuck,
      ]);
      await render();
      // The card is under Blocked now, which is folded: the place it left gets the keyboard.
      expect(document.activeElement).toBe(groupBar("active"));
    });

    it("never takes the keyboard from somewhere else", async () => {
      runtime.reply = board(fourCards());
      await render();
      opener("0003-build").focus();
      const search = container.querySelector<HTMLInputElement>('[aria-label="Find an increment"]')!;
      search.focus();
      runtime.reply = board(fourCards().filter((entry) => entry.incrementId !== "0003-build"));
      await render();
      expect(document.activeElement).toBe(search);
    });
  });

  describe("layout", () => {
    it("moves focus to the view heading when the view fills the panel", async () => {
      runtime.reply = board(fourCards());
      await render({ layout: "full" });
      const target = opener("0002-build");
      target.focus();
      await act(async () => target.click());
      expect(pane().dataset.view).toBe("full");
      expect(document.activeElement).toBe(viewTitle());
      await key(viewTitle()!, "Escape");
      expect(pane().hasAttribute("data-view")).toBe(false);
      expect(document.activeElement).toBe(opener("0002-build"));
    });

    it("keeps focus on the card when the view sits beside the board", async () => {
      runtime.reply = board(fourCards());
      await render({ layout: "split" });
      const target = opener("0002-build");
      target.focus();
      await act(async () => target.click());
      expect(pane().dataset.view).toBe("split");
      expect(document.activeElement).toBe(target);
    });

    it("opens the view a link names, without a click", async () => {
      runtime.reply = board(fourCards());
      await render({ initial: "0004-check" });
      expect(viewTitle()?.textContent).toBe("Title 0004-check");
      expect(opener("0004-check").getAttribute("aria-expanded")).toBe("true");
      expect(calls).toEqual([]);
    });
  });

  it("steps to the previous and next card in board order with replace, stopping at the ends", async () => {
    runtime.reply = board(fourCards());
    await render();
    await act(async () => opener("0002-build").click());
    expect(labelled("Previous card").disabled).toBe(true);
    expect(labelled("Next card").disabled).toBe(false);
    await act(async () => labelled("Next card").click());
    await act(async () => labelled("Next card").click());
    await act(async () => labelled("Next card").click());
    expect(calls.slice(1)).toEqual([
      { id: "0003-build", options: { replace: true } },
      { id: "0004-check", options: { replace: true } },
      { id: "0001-plan", options: { replace: true } },
    ]);
    expect(viewTitle()?.textContent).toBe("Title 0001-plan");
    expect(labelled("Next card").disabled).toBe(true);
    expect(labelled("Previous card").disabled).toBe(false);
    await act(async () => labelled("Previous card").click());
    expect(calls.at(-1)).toEqual({ id: "0004-check", options: { replace: true } });
  });

  describe("missing parts", () => {
    it("opens with the card's own facts on a server without the detail read", async () => {
      runtime.reply = board([card("0002-build", "active")], false);
      await render();
      await act(async () => opener("0002-build").click());
      expect(viewTitle()?.textContent).toBe("Title 0002-build");
      expect(view()!.textContent).toContain("1/4 tasks");
      expect(view()!.textContent).toContain("Tasks and criteria need a newer server");
      expect(runtime.detailInputs).toEqual([]);
      // The spec file still opens.
      await act(async () => byText(view()!, "Spec file").click());
      expect(runtime.viewed).toEqual(["/work/atlas/.specweave/increments/0002-build/spec.md"]);
    });

    it("says an increment removed from disk is gone and offers the way back", async () => {
      runtime.reply = board([card("0002-build", "active")]);
      runtime.detail = { projectId, incrementId: "0099-gone", increment: null };
      await render({ initial: "0099-gone" });
      expect(runtime.detailInputs.at(-1)).toEqual({ projectId, incrementId: "0099-gone" });
      expect(view()!.textContent).toContain("This increment is no longer on disk.");
      await act(async () => byText(view()!, "Back to the board").click());
      expect(calls).toEqual([{ id: null, options: { replace: true } }]);
      expect(view()).toBeNull();
      expect(opener("0002-build")).not.toBeNull();
    });

    it("shows a failed increment read without breaking the board", async () => {
      runtime.reply = board(fourCards());
      runtime.detailError = "The machine went offline";
      await render();
      await act(async () => opener("0002-build").click());
      expect(view()!.textContent).toContain(
        "The increment could not be read: The machine went offline",
      );
      expect(viewTitle()?.textContent).toBe("Title 0002-build");
      expect(container.querySelectorAll("button[data-board-card]")).toHaveLength(4);
      expect(container.textContent).not.toContain("The board could not be read");
    });
  });
});
