// @vitest-environment jsdom
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@specweave-studio/shared/keybindings";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  activeThread: null as null | { environmentId: string; projectId: string },
}));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => DEFAULT_RESOLVED_KEYBINDINGS,
}));
vi.mock("../hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => ({ activeThread: state.activeThread, activeDraftThread: null }),
}));
vi.mock("./settings/useSettingsProjectGroups", () => ({ useSettingsProjectGroups: () => [] }));
vi.mock("./chat/TimelineDetailMenu", () => ({ findLogicalProjectKey: () => "atlas" }));

import {
  closeInPlaceProjectSettings,
  openProjectSettings,
  readInPlaceProjectSettings,
  takeProjectSettingsRequest,
} from "../studio/projectSettingsRequests";
import { ProjectSettingsShortcut } from "./ProjectSettingsShortcut";

function makeRouter(initial: string) {
  const root = createRootRoute({
    component: () =>
      createElement("div", null, createElement(ProjectSettingsShortcut), createElement(Outlet)),
  });
  const routes = [
    createRoute({
      getParentRoute: () => root,
      path: "/projects/$projectKey",
      component: () => null,
    }),
    createRoute({
      getParentRoute: () => root,
      path: "/$environmentId/$threadId",
      component: () => null,
    }),
  ];
  return createRouter({
    routeTree: root.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [initial] }),
  });
}

const press = () =>
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "<", code: "Comma", ctrlKey: true, shiftKey: true }),
  );

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  container = document.createElement("div");
  root = createRoot(container);
  closeInPlaceProjectSettings();
  takeProjectSettingsRequest("atlas");
  state.activeThread = null;
});
afterEach(async () => {
  await act(async () => root.unmount());
});

describe("project settings shortcut", () => {
  it("opens on the project page and keeps its open thread", async () => {
    const router = makeRouter("/projects/atlas?thread=worker-1");
    await act(async () => root.render(createElement(RouterProvider, { router })));
    const before = router.state.location.href;
    await act(async () => press());
    expect(router.state.location.href).toBe(before);
    expect(router.state.location.href).toContain("thread=worker-1");
    // The project page takes this request and opens its own dialog in place.
    expect(takeProjectSettingsRequest("atlas")).toBe(true);
    expect(readInPlaceProjectSettings()).toBeNull();
  });

  it("opens over a full chat thread without leaving it", async () => {
    state.activeThread = { environmentId: "env-1", projectId: "p-1" };
    const router = makeRouter("/env-1/thread-1");
    await act(async () => root.render(createElement(RouterProvider, { router })));
    await act(async () => press());
    expect(router.state.location.pathname).toBe("/env-1/thread-1");
    expect(readInPlaceProjectSettings()).toEqual({
      projectKey: "atlas",
      target: { tab: "general" },
    });
    expect(takeProjectSettingsRequest("atlas")).toBe(false);
  });
});

describe("openProjectSettings (command palette entries)", () => {
  it("asks the project page when it is in view, else opens in place", () => {
    openProjectSettings("atlas", "atlas", { tab: "memory", row: "goal" });
    expect(takeProjectSettingsRequest("atlas")).toBe(true);
    expect(readInPlaceProjectSettings()).toBeNull();
    openProjectSettings(null, "atlas", { tab: "memory" });
    expect(readInPlaceProjectSettings()).toEqual({
      projectKey: "atlas",
      target: { tab: "memory" },
    });
    closeInPlaceProjectSettings();
    expect(readInPlaceProjectSettings()).toBeNull();
  });
});
