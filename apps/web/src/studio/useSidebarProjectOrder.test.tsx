// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { SidebarProjectOrder } from "@specweave-studio/contracts";

const state = vi.hoisted(() => ({
  config: null as { settings: { sidebarProjectOrder: SidebarProjectOrder } } | null,
  update: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.config }));
vi.mock("../state/server", () => ({ primaryServerConfigAtom: {} }));
vi.mock("../hooks/useSettings", () => ({
  useUpdatePrimarySettings: () => state.update,
}));
import { useSidebarProjectOrder } from "./useSidebarProjectOrder";

let root: Root;
let current: ReturnType<typeof useSidebarProjectOrder>;
function Probe() {
  const result = useSidebarProjectOrder();
  useEffect(() => {
    current = result;
  });
  return null;
}
const render = () => act(async () => root.render(<Probe />));
const host = (order: SidebarProjectOrder) => {
  state.config = { settings: { sidebarProjectOrder: order } };
};

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  state.config = null;
  state.update.mockClear();
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
});

describe("useSidebarProjectOrder", () => {
  it("reads the host's order and keeps a copy for the next start", async () => {
    host({ pinned: ["a"], unpinned: ["b"] });
    await render();
    expect(current[0]).toEqual({ pinned: ["a"], unpinned: ["b"] });
    expect(JSON.parse(localStorage.getItem("studio:sidebar-project-order:v1")!)).toEqual({
      pinned: ["a"],
      unpinned: ["b"],
    });
  });

  it("writes a move to the host and shows it before the host answers", async () => {
    host({ pinned: [], unpinned: ["a", "b"] });
    await render();
    await act(async () => current[1]({ pinned: ["b"], unpinned: ["a"] }));
    expect(state.update).toHaveBeenCalledWith({
      sidebarProjectOrder: { pinned: ["b"], unpinned: ["a"] },
    });
    expect(current[0]).toEqual({ pinned: ["b"], unpinned: ["a"] });
    // Another window's newer order replaces the optimistic one.
    host({ pinned: [], unpinned: ["b", "a"] });
    await render();
    expect(current[0]).toEqual({ pinned: [], unpinned: ["b", "a"] });
  });

  it("sends pins from older builds to a host with no order, and keeps them", async () => {
    localStorage.setItem("studio:sidebar-pinned-projects:v1", JSON.stringify(["a"]));
    await render();
    expect(current[0]).toEqual({ pinned: ["a"], unpinned: [] });
    host({ pinned: [], unpinned: [] });
    await render();
    expect(state.update).toHaveBeenCalledWith({
      sidebarProjectOrder: { pinned: ["a"], unpinned: [] },
    });
    expect(localStorage.getItem("studio:sidebar-pinned-projects:v1")).not.toBeNull();
  });

  it("keeps pins across restarts when an older service drops the setting", async () => {
    // Regression: a 1.0.19 service ignored sidebarProjectOrder, the client read
    // its empty default, and the pins moved out of this browser were lost.
    localStorage.setItem(
      "studio:sidebar-pinned-projects:v1",
      JSON.stringify(["github.com/anton-abyzov/specweave", "logical-project:easychamp"]),
    );
    host({ pinned: [], unpinned: [] });
    await render();
    await act(async () =>
      current[1]({
        pinned: ["logical-project:easychamp"],
        unpinned: ["github.com/anton-abyzov/specweave"],
      }),
    );
    // The service sends its settings again, still without an order.
    host({ pinned: [], unpinned: [] });
    await render();
    expect(current[0].pinned).toEqual(["logical-project:easychamp"]);
    // Restart: a new mount reads the same storage and the same empty host.
    await act(async () => root.unmount());
    root = createRoot(document.createElement("div"));
    host({ pinned: [], unpinned: [] });
    await render();
    expect(current[0].pinned).toEqual(["logical-project:easychamp"]);
  });

  it("prefers an order the host holds over this browser's", async () => {
    localStorage.setItem("studio:sidebar-pinned-projects:v1", JSON.stringify(["a"]));
    host({ pinned: ["b"], unpinned: [] });
    await render();
    expect(current[0]).toEqual({ pinned: ["b"], unpinned: [] });
    expect(state.update).not.toHaveBeenCalled();
  });

  it("keeps the order in this browser where no host anchors the app", async () => {
    await render();
    await act(async () => current[1]({ pinned: ["a"], unpinned: [] }));
    expect(state.update).not.toHaveBeenCalled();
    expect(current[0]).toEqual({ pinned: ["a"], unpinned: [] });
  });
});
