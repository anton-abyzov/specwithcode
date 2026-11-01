// @vitest-environment jsdom
import { act, createElement, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  params: { environmentId: "m4", threadId: "t1" } as Record<string, string>,
  navigate: vi.fn(),
  aideHidden: false,
  hiddenRefs: [] as unknown[],
  views: 0,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (config: object) => config,
  useParams: (options: { select: (params: Record<string, string>) => unknown }) =>
    options.select(state.params),
  useNavigate: () => state.navigate,
  Outlet: () => null,
  redirect: vi.fn(),
}));
vi.mock("../components/ThreadRouteView", () => ({
  ThreadRouteView: () => {
    state.views += 1;
    return null;
  },
}));
vi.mock("../studio/hiddenAideRoute", () => ({
  useHiddenAideThread: (ref: unknown) => {
    state.hiddenRefs.push(ref);
    return state.aideHidden;
  },
}));
// The global shortcuts are not under test here.
vi.mock("../hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => ({
    activeDraftThread: null,
    activeThread: null,
    defaultProjectRef: null,
    handleNewThread: vi.fn(),
    routeThreadRef: null,
  }),
}));
vi.mock("../hooks/useScratchProject", () => ({
  useScratchProject: () => ({ environmentId: null, startScratchThread: vi.fn() }),
}));
vi.mock("../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/environments")>()),
  usePrimaryEnvironmentId: () => null,
}));
vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  useEnvironmentScope: () => false,
}));
vi.mock("../hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks/useSettings")>()),
  useLegacySidebarEnabled: () => false,
}));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => [],
}));

import { Route } from "./_chat";

let root: ReturnType<typeof createRoot>;
const render = async () => {
  const component = (
    Route as unknown as { component: ComponentType & { preload?: () => Promise<unknown> } }
  ).component;
  await component.preload?.();
  await act(async () => root.render(createElement(component)));
};
beforeEach(() => {
  root = createRoot(document.createElement("div"));
  state.navigate.mockReset();
  state.aideHidden = false;
  state.hiddenRefs = [];
  state.views = 0;
  state.params = { environmentId: "m4", threadId: "t1" };
});
afterEach(async () => {
  await act(async () => root.unmount());
});

it("sends a hidden personal assistant's chat to Overview without opening it", async () => {
  state.aideHidden = true;
  await render();
  expect(state.hiddenRefs.at(-1)).toEqual({ environmentId: "m4", threadId: "t1" });
  expect(state.views).toBe(0);
  expect(state.navigate).toHaveBeenCalledWith({ to: "/", replace: true });
});

it("opens any other chat as before", async () => {
  await render();
  expect(state.views).toBeGreaterThan(0);
  expect(state.navigate).not.toHaveBeenCalled();
});

it("never checks a draft against the setting", async () => {
  state.params = { draftId: "d1" };
  await render();
  expect(state.hiddenRefs.at(-1)).toBeNull();
  expect(state.navigate).not.toHaveBeenCalled();
});
