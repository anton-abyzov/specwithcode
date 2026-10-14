import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { NativeConnectionsPanel } from "./NativeConnectionsPanel";
import { ConnectionsLibrarySettings } from "../settings/ConnectionsLibrarySettings";

const state = vi.hoisted(() => ({
  permitted: true,
  connected: true,
  query: {
    data: null as unknown,
    error: null as string | null,
    isPending: false,
    refresh: vi.fn(),
  },
  scope: {} as Record<string, unknown>,
  search: {} as Record<string, string>,
  environments: [] as Array<{ environmentId: string; label: string }>,
  request: vi.fn((input: unknown) => input),
  useQuery: vi.fn(),
}));
vi.mock("../../studio/projectWorkspace", () => ({
  projectWorkspace: { nativeConnections: state.request },
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => state.permitted }));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => ({ connection: { phase: state.connected ? "connected" : "disconnected" } }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => {
    state.useQuery(atom);
    return state.query;
  },
}));
vi.mock("../settings/SettingsScopeContext", () => ({ useSettingsScope: () => state }));
vi.mock("../settings/settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SettingsSection: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
}));

let renderer: ReactTestRenderer;
const mac = EnvironmentId.make("mac");
const projectId = ProjectId.make("project-one");
const snapshot = {
  observedAt: "2026-10-14T00:00:00Z",
  runtime: "unverified",
  truncated: false,
  sources: [],
  connections: [],
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  state.permitted = true;
  state.connected = true;
  state.query = { data: snapshot, error: null, isPending: false, refresh: vi.fn() };
  state.scope = { kind: "all" };
  state.search = {};
  state.environments = [
    { environmentId: mac, label: "Mac" },
    { environmentId: "remote", label: "Remote" },
  ];
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});
const text = () => JSON.stringify(renderer.toJSON());
const renderPanel = () =>
  act(() => {
    renderer = create(<NativeConnectionsPanel environmentId={mac} projectId={projectId} />);
  });

it.each(["offline", "denied"])(
  "does not issue discovery or expose cached data when %s",
  async (mode) => {
    state.connected = mode !== "offline";
    state.permitted = mode !== "denied";
    await renderPanel();
    expect(state.request).not.toHaveBeenCalled();
    expect(state.useQuery).toHaveBeenLastCalledWith(null);
    expect(text()).not.toContain("No MCP declarations");
    expect(text()).toContain(
      mode === "offline" ? "Connect this machine" : "Filesystem read access",
    );
  },
);
it("queries the exact destination and project and exposes refresh", async () => {
  await renderPanel();
  expect(state.request).toHaveBeenCalledWith({ environmentId: mac, input: { projectId } });
  await act(() => renderer.root.findByType("button").props.onClick());
  expect(state.query.refresh).toHaveBeenCalledOnce();
});
it("hides prior success on failure and distinguishes loading", async () => {
  state.query.error = "Unavailable";
  await renderPanel();
  expect(text()).toContain("Could not inspect");
  expect(text()).not.toContain("No MCP declarations");
  state.query = { ...state.query, error: null, data: null, isPending: true };
  await act(() => renderer.update(<NativeConnectionsPanel environmentId={mac} />));
  expect(text()).toContain("Reading native");
  expect(renderer.root.findByType("button").props.disabled).toBe(true);
});
it("does not silently switch a removed machine and allows explicit recovery", async () => {
  await act(() => {
    renderer = create(<ConnectionsLibrarySettings />);
  });
  await act(() =>
    renderer.root.findByType("select").props.onChange({ target: { value: "remote" } }),
  );
  expect(state.request).toHaveBeenLastCalledWith({ environmentId: "remote", input: {} });
  state.environments = [{ environmentId: mac, label: "Mac" }];
  state.request.mockClear();
  await act(() => renderer.update(<ConnectionsLibrarySettings />));
  expect(text()).toContain("no longer in this scope");
  expect(state.request).not.toHaveBeenCalled();
  await act(() => renderer.root.findByType("select").props.onChange({ target: { value: mac } }));
  expect(state.request).toHaveBeenLastCalledWith({ environmentId: mac, input: {} });
});
it("resets selection for project scope and refuses unavailable scopes", async () => {
  await act(() => {
    renderer = create(<ConnectionsLibrarySettings />);
  });
  await act(() =>
    renderer.root.findByType("select").props.onChange({ target: { value: "remote" } }),
  );
  state.search = { project: "logical-project" };
  state.scope = {
    kind: "project",
    members: [{ environmentId: mac, id: projectId, workspaceRoot: "/fixture" }],
  };
  await act(() => renderer.update(<ConnectionsLibrarySettings />));
  expect(state.request).toHaveBeenLastCalledWith({ environmentId: mac, input: { projectId } });
  state.scope = { kind: "unavailable", message: "Project missing" };
  state.request.mockClear();
  await act(() => renderer.update(<ConnectionsLibrarySettings />));
  expect(text()).toContain("Project missing");
  expect(state.request).not.toHaveBeenCalled();
});
