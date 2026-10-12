// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const env = vi.hoisted(() => ({ isElectron: false }));
vi.mock("../../../env", () => env);

import { ProjectPaneBar, type ProjectPaneBarProps } from "./ProjectPaneBar";

let container: HTMLDivElement;
let root: Root;
const props = (overrides: Partial<ProjectPaneBarProps> = {}): ProjectPaneBarProps => ({
  tab: "threads",
  onTabChange: vi.fn(),
  counts: { threads: { value: 2, label: "waiting on you", tone: "waiting" } },
  onNewThread: vi.fn(),
  onOpenPlan: vi.fn(),
  onOpenUsage: vi.fn(),
  expanded: false,
  onToggleExpanded: vi.fn(),
  onClose: vi.fn(),
  ...overrides,
});
const render = (bar: ProjectPaneBarProps, tools?: ReactNode) =>
  act(() => root.render(<ProjectPaneBar {...bar} tools={tools} />));

beforeEach(() => {
  env.isElectron = false;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("the project panel's header row", () => {
  it("holds the tabs, the tab's tools, expand and close in one row", async () => {
    await render(props(), <button type="button" aria-label="Find a thread" />);
    const rows = container.querySelectorAll(".sws-pane-head");
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect([...row.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent?.trim())).toEqual(
      ["Threads2 waiting on you", "Library", "PRs", "Scheduled"],
    );
    for (const label of ["New", "Find a thread", "Expand panel", "Hide overview"])
      expect(row.querySelector(`[aria-label="${label}"]`)).not.toBeNull();
    expect(row.classList.contains("drag-region")).toBe(false);
  });
  it("drags the window from the title row in the desktop app", async () => {
    env.isElectron = true;
    await render(props());
    expect(container.querySelector(".sws-pane-head")?.classList.contains("drag-region")).toBe(true);
  });
  it("moves between tabs with the arrow keys and names the expand state", async () => {
    const bar = props({ tab: "prs", expanded: true });
    await render(bar);
    const selected = container.querySelector<HTMLButtonElement>('[aria-selected="true"]')!;
    expect(selected.dataset.tab).toBe("prs");
    await act(async () =>
      selected.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
    );
    expect(bar.onTabChange).toHaveBeenCalledWith("scheduled");
    const restore = container.querySelector<HTMLButtonElement>('[aria-label="Restore panel"]')!;
    expect(restore.getAttribute("aria-pressed")).toBe("true");
    await act(async () => restore.click());
    expect(bar.onToggleExpanded).toHaveBeenCalledTimes(1);
  });
});
