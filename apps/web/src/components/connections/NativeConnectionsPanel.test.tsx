import type { ReactNode } from "react";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { NativeConnectionsPanel } from "./NativeConnectionsPanel";
import { ConnectionsLibrarySettings } from "../settings/ConnectionsLibrarySettings";
import { Select } from "../ui/select";
vi.mock("../ui/tooltip", async () => {
  const { cloneElement, isValidElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipTrigger({ render, children }: { render?: ReactNode; children?: ReactNode }) {
      return isValidElement(render) ? cloneElement(render, undefined, children) : children;
    },
    TooltipPopup: () => null,
  };
});

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
  apply: vi.fn(),
}));
vi.mock("../../studio/projectWorkspace", () => ({
  projectWorkspace: { nativeConnections: state.request, nativeConnectionApply: {} },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.apply }));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => state.permitted }));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => ({ connection: { phase: state.connected ? "connected" : "available" } }),
  useEnvironments: () => ({ environments: [] }),
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
  SettingsSection: ({
    children,
    headerAction,
  }: {
    children: React.ReactNode;
    headerAction?: React.ReactNode;
  }) => (
    <section>
      {headerAction}
      {children}
    </section>
  ),
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
  const refresh = renderer.root
    .findAllByType("button")
    .find((b) => JSON.stringify(b.props.children).includes("Refresh"))!;
  await act(() => refresh.props.onClick());
  expect(state.query.refresh).toHaveBeenCalledOnce();
});
it("edits directly without preview on a machine that predates managing servers", async () => {
  state.apply.mockResolvedValueOnce({ _tag: "Success", value: snapshot });
  state.query.data = {
    ...snapshot,
    sources: [{ id: "codex-user", provider: "codex", scope: "user", status: "read" }],
    connections: [
      {
        id: "codex:codex-user:a",
        name: "docs",
        provider: "codex",
        sourceId: "codex-user",
        scope: "user",
        transport: "stdio",
        state: "disabled",
        shadowed: false,
      },
    ],
  };
  await renderPanel();
  expect(text()).not.toContain("Add server");
  // Without the manage set, the details carry the quick enable.
  await act(() =>
    renderer.root
      .findAll((n) => n.type === "button" && n.props["aria-label"] === "docs Codex details")[0]!
      .props.onClick(),
  );
  const enable = renderer.root.findAll(
    (n) => n.type === "button" && n.props["aria-label"] === "Enable: docs",
  )[0]!;
  await act(() => enable.props.onClick());
  expect(state.apply).toHaveBeenLastCalledWith({
    environmentId: mac,
    input: { action: "enable", connectionId: "codex:codex-user:a" },
  });
});
it("previews a change, saves it after review, and offers Undo", async () => {
  const change = {
    preview: true,
    files: [{ tool: "Cursor", path: "~/.cursor/mcp.json", lines: ["Remove docs"] }],
  };
  state.apply
    .mockResolvedValueOnce({ _tag: "Success", value: { ...snapshot, change } })
    .mockResolvedValueOnce({
      _tag: "Success",
      value: { ...snapshot, change: { ...change, preview: false, id: "1760000000000-abcdef12" } },
    })
    .mockResolvedValueOnce({ _tag: "Success", value: snapshot });
  state.query.data = {
    ...snapshot,
    plugins: [],
    otherTools: [
      {
        tool: "cursor",
        status: "read",
        connections: [{ id: "cursor:abc", name: "docs", transport: "stdio", state: "configured" }],
      },
    ],
  };
  await renderPanel();
  const byLabel = (label: string) =>
    renderer.root.findAll((n) => n.type === "button" && n.props["aria-label"] === label)[0]!;
  await act(() => byLabel("docs Cursor details").props.onClick());
  await act(() => byLabel("Remove: docs").props.onClick());
  expect(state.apply).toHaveBeenLastCalledWith({
    environmentId: mac,
    input: { action: "remove", connectionId: "cursor:abc", preview: true },
  });
  expect(text()).toContain("Review the change");
  expect(text()).toContain("~/.cursor/mcp.json");
  const button = (label: string) =>
    renderer.root
      .findAllByType("button")
      .find((b) => JSON.stringify(b.props.children) === JSON.stringify(label))!;
  await act(() => button("Save").props.onClick());
  expect(state.apply).toHaveBeenLastCalledWith({
    environmentId: mac,
    input: { action: "remove", connectionId: "cursor:abc" },
  });
  expect(text()).toContain("Saved to 1 file.");
  await act(() => button("Undo").props.onClick());
  expect(state.apply).toHaveBeenLastCalledWith({
    environmentId: mac,
    input: { action: "undo", changeId: "1760000000000-abcdef12" },
  });
  expect(text()).not.toContain("Saved to");
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
  await act(() => renderer.root.findByType(Select).props.onValueChange("remote"));
  expect(state.request).toHaveBeenLastCalledWith({ environmentId: "remote", input: {} });
  state.environments = [{ environmentId: mac, label: "Mac" }];
  state.request.mockClear();
  await act(() => renderer.update(<ConnectionsLibrarySettings />));
  expect(text()).toContain("no longer in this scope");
  expect(state.request).not.toHaveBeenCalled();
  await act(() => renderer.root.findByType(Select).props.onValueChange(mac));
  expect(state.request).toHaveBeenLastCalledWith({ environmentId: mac, input: {} });
});
it("resets selection for project scope and refuses unavailable scopes", async () => {
  await act(() => {
    renderer = create(<ConnectionsLibrarySettings />);
  });
  await act(() => renderer.root.findByType(Select).props.onValueChange("remote"));
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
