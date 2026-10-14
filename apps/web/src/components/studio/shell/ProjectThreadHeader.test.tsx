// @vitest-environment jsdom
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  isElectron: false,
  openMenu: vi.fn(),
  rename: vi.fn(async () => ({ _tag: "Success" })),
}));
vi.mock("../../../env", () => ({
  get isElectron() {
    return state.isElectron;
  },
}));
vi.mock("../../../hooks/useThreadActionMenu", () => ({
  useThreadActionMenu: () => ({ openMenu: state.openMenu, closeMenu: vi.fn() }),
}));
vi.mock("../../../state/threads", () => ({ threadEnvironment: { updateMetadata: {} } }));
vi.mock("../../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => state.rename,
}));
vi.mock("./ModelBadge", () => ({
  ModelBadge: (props: { model: string }) => <span className="sws-model">{props.model}</span>,
}));

import { ProjectThreadHeader } from "./ProjectThreadHeader";

const thread = {
  id: "worker",
  environmentId: "host",
  title: "Studio background auto-update",
  settledOverride: null,
  archivedAt: null,
  pullRequests: [],
  modelSelection: { instanceId: "claude-native", model: "worker-model" },
} as unknown as EnvironmentThreadShell;

let container: HTMLDivElement;
let root: Root;
const handlers = {
  onBack: vi.fn(),
  onToggleResolved: vi.fn(),
  onToggleExpanded: vi.fn(),
  onClose: vi.fn(),
  onOpenPullRequest: vi.fn(),
};
const render = (expanded = false) =>
  act(() =>
    root.render(
      <ProjectThreadHeader
        thread={thread}
        subagentCount={2}
        providerEntry={null}
        projectCwd="/scratch/atlas"
        canChange
        expanded={expanded}
        {...handlers}
      />,
    ),
  );
const button = (label: string) =>
  container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;

beforeEach(() => {
  state.isElectron = false;
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("an open thread's header", () => {
  it("is one row: Threads breadcrumb, title, chips and the thread's controls", async () => {
    await render();
    const rows = container.querySelectorAll(".sws-pane-head");
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.classList.contains("sws-thread-head")).toBe(true);
    const crumb = button("Back to project threads");
    expect(crumb.textContent).toBe("Threads");
    expect(row.querySelector("h2")?.textContent).toBe("Studio background auto-update");
    expect(row.querySelector(".sws-thread-head-chips")?.textContent).toContain("worker-model");
    expect(row.querySelector(".sws-thread-head-chips")?.textContent).toContain("2 subagents");
    // Focus order follows the row: back, then the thread's controls left to right.
    expect([...row.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual([
      "Back to project threads",
      "Resolve thread",
      "Thread actions",
      "Expand panel",
      "Close thread pane",
    ]);
    expect(row.classList.contains("drag-region")).toBe(false);
  });
  it("hands the embedded chat a slot for its panel toggles before the thread's controls", async () => {
    let slot: HTMLSpanElement | null = null;
    await act(() =>
      root.render(
        <ProjectThreadHeader
          thread={thread}
          subagentCount={0}
          providerEntry={null}
          projectCwd="/scratch/atlas"
          canChange
          expanded={false}
          toolsSlotRef={(node) => {
            slot = node;
          }}
          {...handlers}
        />,
      ),
    );
    const row = container.querySelector(".sws-thread-head")!;
    expect(slot).toBe(row.querySelector(".sws-thread-head-tools"));
    expect(
      slot!.nextElementSibling?.querySelector('[aria-label="Resolve thread"]') ??
        slot!.nextElementSibling,
    ).toBeTruthy();
  });
  it("goes back from the breadcrumb and runs each control", async () => {
    await render(true);
    await act(async () => button("Back to project threads").click());
    expect(handlers.onBack).toHaveBeenCalledTimes(1);
    await act(async () => button("Resolve thread").click());
    expect(handlers.onToggleResolved).toHaveBeenCalledTimes(1);
    expect(button("Restore panel").getAttribute("aria-pressed")).toBe("true");
    await act(async () => button("Restore panel").click());
    expect(handlers.onToggleExpanded).toHaveBeenCalledTimes(1);
    await act(async () => button("Close thread pane").click());
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });
  it("renames on a double-click of the title", async () => {
    await render();
    await act(async () =>
      container.querySelector("h2")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
    );
    const input = container.querySelector<HTMLInputElement>('[aria-label="Thread title"]')!;
    expect(input.closest(".sws-pane-head")).not.toBeNull();
    input.value = "Auto-update";
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(state.rename).toHaveBeenCalledWith({
      environmentId: "host",
      input: { threadId: "worker", title: "Auto-update" },
    });
  });
  it("drags the window from the title row in the desktop app", async () => {
    state.isElectron = true;
    await render();
    expect(container.querySelector(".sws-pane-head")?.classList.contains("drag-region")).toBe(true);
  });
});

it.each([
  { archivedAt: "2026-10-14T00:00:00Z", settledOverride: null },
  { archivedAt: null, settledOverride: "settled" },
])("shows Resolved and an explicit Reopen action for %j", async (lifecycle) => {
  await act(() => root.render(<ProjectThreadHeader
    thread={{ ...thread, ...lifecycle } as EnvironmentThreadShell}
    subagentCount={0} providerEntry={null} projectCwd="/scratch/atlas"
    canChange expanded={false} {...handlers}
  />));
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Resolved");
  expect(button("Reopen thread").textContent).toBe("Reopen");
  await act(async () => button("Reopen thread").click());
  expect(handlers.onToggleResolved).toHaveBeenCalledOnce();
});
