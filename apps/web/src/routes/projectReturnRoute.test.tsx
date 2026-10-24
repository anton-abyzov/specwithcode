// @vitest-environment jsdom
import { act, createElement, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({
  search: {} as Record<string, unknown>,
  navigate: vi.fn(),
  props: null as null | {
    onProjectKeyMoved: (key: string) => void;
    onSelectThread: (id: string | null) => void;
  },
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (config: object) => ({
    ...config,
    useParams: () => ({ projectKey: "legacy-key" }),
    useSearch: () => state.search,
    useNavigate: () => state.navigate,
  }),
  redirect: vi.fn(),
}));
vi.mock("../components/studio/ProjectWorkspace", () => ({
  ProjectWorkspace: (props: NonNullable<typeof state.props>) => {
    state.props = props;
    return null;
  },
}));
import { Route } from "./projects.$projectKey";
let root: ReturnType<typeof createRoot>;
beforeEach(async () => {
  root = createRoot(document.createElement("div"));
  state.navigate.mockReset();
  state.props = null;
  // The web project config code-splits routes, just as the production router does.
  const component = (
    Route as unknown as { component: ComponentType & { preload?: () => Promise<unknown> } }
  ).component;
  await component.preload?.();
});
afterEach(async () => {
  await act(async () => root.unmount());
});
it("retains restoration intent through delayed project-key normalization", async () => {
  state.search = {
    thread: "worker",
    threadEnvironment: "m3",
    checkout: "m4:p",
    restoreThread: true,
  };
  await act(async () =>
    root.render(createElement((Route as unknown as { component: ComponentType }).component)),
  );
  state.props!.onProjectKeyMoved("canonical-key");
  expect(state.navigate).toHaveBeenCalledWith(
    expect.objectContaining({
      params: { projectKey: "canonical-key" },
      search: state.search,
      replace: true,
    }),
  );
});
it("explicit overview from a restored page clears the restoration marker without options", async () => {
  state.search = { thread: "worker", checkout: "m4:p", restoreThread: true };
  await act(async () =>
    root.render(createElement((Route as unknown as { component: ComponentType }).component)),
  );
  expect(() => state.props!.onSelectThread(null)).not.toThrow();
  expect(state.navigate).toHaveBeenCalledWith(
    expect.objectContaining({ search: { checkout: "m4:p" } }),
  );
});
