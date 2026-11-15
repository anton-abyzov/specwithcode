// @vitest-environment jsdom
import {
  EnvironmentId,
  ProjectId,
  type ProjectBoardCard,
  type ProjectBoardResult,
} from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ProjectPaneBarProps } from "./ProjectPaneBar";

const runtime = vi.hoisted(() => ({
  inputs: [] as Array<{ query?: string; doneLimit?: number }>,
  reply: null as unknown,
  error: null as string | null,
  refresh: vi.fn(),
  openLink: vi.fn(async (_url: string) => undefined),
  viewed: [] as string[],
}));
vi.mock("../../../studio/projectWorkspace", () => ({
  projectWorkspace: {
    board: ({ input }: { input: { query?: string; doneLimit?: number } }) => {
      runtime.inputs.push(input);
      return input;
    },
  },
}));
vi.mock("../../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: runtime.reply,
    error: runtime.error,
    isPending: false,
    refresh: runtime.refresh,
  }),
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
  status: column === "done" ? "completed" : "active",
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
});

describe("BoardPane", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    runtime.inputs.length = 0;
    runtime.viewed.length = 0;
    runtime.reply = null;
    runtime.error = null;
    runtime.refresh.mockClear();
    runtime.openLink.mockClear();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const render = () =>
    act(async () =>
      root.render(
        <BoardPane
          environmentId={EnvironmentId.make("host")}
          projectId={projectId}
          workspaceRoot="/work/atlas"
          bar={{} as ProjectPaneBarProps}
        />,
      ),
    );
  const column = (name: string) =>
    container.querySelector<HTMLElement>(`[data-column="${name}"]`)!;
  const cardIds = (name: string) =>
    [...column(name).querySelectorAll<HTMLElement>("[data-increment]")].map(
      (entry) => entry.dataset.increment,
    );

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
    expect(
      [...container.querySelectorAll("section h3")].map((heading) => heading.textContent),
    ).toEqual(["Planned1 increments", "Active1 increments", "In review1 increments", "Done558 increments"]);
    const active = column("active");
    expect(active.textContent).toContain("0002");
    expect(active.textContent).toContain("Title 0002-build");
    expect(active.textContent).toContain("1/4 tasks");
    expect(active.textContent).toContain("Blocked");
    expect(active.textContent).toContain("#371");
    expect(column("planned").textContent).not.toContain("tasks");
    // Stacked in a narrow panel, work in motion comes before the backlog.
    expect(
      ["active", "review", "planned", "done"].map((name) => column(name).style.order),
    ).toEqual(["0", "1", "2", "3"]);
  });

  it("opens the spec from a card and the pull request from its chip", async () => {
    runtime.reply = board([
      card("0002-build", "active", { pullRequests: ["https://github.com/acme/app/pull/371"] }),
    ]);
    await render();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Open pull request #371"]')!
        .click(),
    );
    expect(runtime.openLink).toHaveBeenCalledWith("https://github.com/acme/app/pull/371");
    expect(runtime.viewed).toEqual([]);
    await act(async () =>
      container.querySelector<HTMLButtonElement>("button.sws-board-card-open")!.click(),
    );
    expect(container.querySelector('[data-testid="viewer"]')?.textContent).toBe(
      "/work/atlas/.specweave/increments/0002-build/spec.md",
    );
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
});
