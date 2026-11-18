import type { ReactNode } from "react";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { NativeConnectionsPanel } from "./NativeConnectionsPanel";
import { ConnectionsLibrarySettings } from "../settings/ConnectionsLibrarySettings";
vi.mock("../../studio/machineNickname", () => ({
  useMachineNickname: (_id: string, label?: string | null) => label ?? "",
  useMachineNicknames: () => (id: string, label?: string | null) => label ?? id,
  machineNickname: (id: string, label?: string | null) => label ?? id,
}));
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
  mayWrite: true,
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
vi.mock("./BuiltInToolsBlock", () => ({
  BuiltInToolsBlock: () => <section data-testid="built-in-tools" />,
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.apply }));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: (_id: string, scope: string) =>
    state.permitted && (scope === "filesystem:read" || state.mayWrite),
}));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => ({
    label: "Mac",
    connection: { phase: state.connected ? "connected" : "available" },
  }),
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
  state.mayWrite = true;
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
const renderTab = () =>
  act(() => {
    renderer = create(<NativeConnectionsPanel environmentId={mac} />);
  });
const labelled = (label: string) =>
  renderer.root.findAll((n) => n.type === "button" && n.props["aria-label"] === label)[0]!;
const named = (label: string) =>
  renderer.root
    .findAllByType("button")
    .find((b) => JSON.stringify(b.props.children) === JSON.stringify(label))!;
const byTestId = (id: string) => renderer.root.findAll((n) => n.props["data-testid"] === id);
/** The matrix sits behind "Compare by AI tool"; the plain list is the default view. */
const compare = () => act(() => named("Compare by AI tool").props.onClick());
const entry = (provider: "codex" | "claude", name: string, more: Record<string, unknown> = {}) => ({
  id: `${provider}:${provider}-user:${name}`,
  name,
  provider,
  sourceId: `${provider}-user`,
  scope: "user",
  transport: "http",
  state: "configured",
  shadowed: false,
  ...more,
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
  expect(text()).not.toContain("Enter details by hand");
  // An older machine cannot preview, so the list offers no edits of its own.
  expect(labelled("Turn on: docs")).toBeUndefined();
  await compare();
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
  await compare();
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
it("follows the page's machine and never falls back to another one", async () => {
  state.scope = { kind: "environment", environmentId: mac };
  await act(() => {
    renderer = create(<ConnectionsLibrarySettings />);
  });
  expect(state.request).toHaveBeenLastCalledWith({ environmentId: mac, input: {} });
  state.scope = { kind: "environment", environmentId: "remote" };
  await act(() => renderer.update(<ConnectionsLibrarySettings />));
  expect(state.request).toHaveBeenLastCalledWith({ environmentId: "remote", input: {} });
  // A machine that left the list is not replaced by the one that is still there.
  state.scope = { kind: "unavailable", message: "This environment is no longer available." };
  state.request.mockClear();
  await act(() => renderer.update(<ConnectionsLibrarySettings />));
  expect(text()).toContain("no longer available");
  expect(state.request).not.toHaveBeenCalled();
});
it("asks for a machine when none is connected", async () => {
  state.scope = { kind: "all" };
  await act(() => {
    renderer = create(<ConnectionsLibrarySettings />);
  });
  expect(text()).toContain("Connect a machine to see its MCP servers.");
  expect(state.request).not.toHaveBeenCalled();
});

it("shows the plain list first and keeps the matrix one click away, empty or not", async () => {
  await renderTab();
  expect(text()).toContain("Your servers on Mac");
  expect(text()).toContain("No MCP servers on Mac yet");
  expect(byTestId("connection-matrix")).toEqual([]);
  expect(byTestId("built-in-tools")).toHaveLength(1);
  expect(named("Compare by AI tool").props["aria-pressed"]).toBe(false);
  await compare();
  expect(byTestId("connection-matrix")).toHaveLength(1);
  expect(named("Compare by AI tool").props["aria-pressed"]).toBe(true);
  await compare();
  expect(byTestId("server-list-empty")).toHaveLength(1);
});
it("keeps the sentence about declarations under About this list", async () => {
  await renderTab();
  const about = byTestId("server-list-about")[0]!;
  const sentence = "No MCP declarations found in the inspected configuration files.";
  expect(JSON.stringify(renderer.toJSON()).split(sentence)).toHaveLength(2);
  expect(about.findAll((n) => n.type === "p" && n.children.includes(sentence))).toHaveLength(1);
  expect(text()).toContain("It cannot tell whether a server is signed in or running.");
});
it("lists a server once with its kind, its tools and where other entries come from", async () => {
  state.query.data = {
    ...snapshot,
    plugins: [],
    connections: [
      entry("codex", "linear"),
      entry("claude", "linear", { state: "disabled", parked: true }),
      entry("codex", "figma", { plugin: "Figma", transport: "stdio" }),
      entry("claude", "notes", { state: "disabled", parked: true }),
    ],
  };
  await renderTab();
  const rows = byTestId("server-row");
  expect(rows).toHaveLength(3);
  const shown = (index: number) =>
    rows[index]!.findAll((n) => typeof n.type === "string")
      .flatMap((n) => n.children.filter((child) => typeof child === "string"))
      .join(" ");
  expect(shown(0)).toContain("figma");
  expect(shown(0)).toContain("Program on this machine");
  // A plugin's entry says where it comes from and is not edited from the list.
  expect(text()).toContain("Codex: from the Figma plugin");
  expect(labelled("Remove: figma")).toBeUndefined();
  expect(text()).toContain("Web address");
  // Off in one of two tools names the tool; off everywhere marks the row.
  expect(text()).toContain("Claude Code, off");
  expect(rows[2]!.findAll((n) => n.children.includes("Off"))).not.toEqual([]);
  expect(labelled("Turn on: notes")).toBeDefined();
  expect(labelled("Turn off: notes")).toBeUndefined();
});
it("marks what the project's own folder declares on the Project page", async () => {
  state.query.data = {
    ...snapshot,
    plugins: [],
    connections: [
      entry("claude", "docs", { sourceId: "claude-project", scope: "project" }),
      entry("codex", "linear"),
    ],
  };
  await renderPanel();
  expect(byTestId("built-in-tools")).toEqual([]);
  const rows = byTestId("server-row");
  expect(rows[0]!.findAll((n) => n.children.includes("This project"))).not.toEqual([]);
  expect(rows[1]!.findAll((n) => n.children.includes("This project"))).toEqual([]);
  expect(text()).toContain("Claude Code: from this project's folder");
  expect(labelled("Remove: docs")).toBeUndefined();
});
it("turns a server off in two tools with one review and an Undo per tool", async () => {
  const file = (tool: string, path: string) => ({ tool, path, lines: ["Turn off linear"] });
  const preview = (tool: string, path: string) => ({
    _tag: "Success",
    value: { ...snapshot, change: { preview: true, files: [file(tool, path)] } },
  });
  const saved = (tool: string, path: string, id: string) => ({
    _tag: "Success",
    value: { ...snapshot, change: { preview: false, id, files: [file(tool, path)] } },
  });
  state.apply
    .mockResolvedValueOnce(preview("Codex", "~/.codex/config.toml"))
    .mockResolvedValueOnce(preview("Claude Code", "~/.claude.json"))
    .mockResolvedValueOnce(saved("Codex", "~/.codex/config.toml", "change-codex"))
    .mockResolvedValueOnce(saved("Claude Code", "~/.claude.json", "change-claude"))
    .mockResolvedValueOnce({ _tag: "Success", value: snapshot });
  state.query.data = {
    ...snapshot,
    plugins: [],
    connections: [entry("codex", "linear"), entry("claude", "linear")],
  };
  await renderTab();
  await act(() => labelled("Turn off: linear").props.onClick());
  expect(state.apply.mock.calls.map((call) => call[0].input)).toEqual([
    { action: "disable", connectionId: "codex:codex-user:linear", preview: true },
    { action: "disable", connectionId: "claude:claude-user:linear", preview: true },
  ]);
  // One review names each tool's own file.
  expect(byTestId("change-preview")).toHaveLength(1);
  expect(text()).toContain("~/.codex/config.toml");
  expect(text()).toContain("~/.claude.json");
  await act(() => named("Save").props.onClick());
  expect(state.apply.mock.calls.slice(2).map((call) => call[0].input)).toEqual([
    { action: "disable", connectionId: "codex:codex-user:linear" },
    { action: "disable", connectionId: "claude:claude-user:linear" },
  ]);
  expect(byTestId("change-preview")).toEqual([]);
  expect(labelled("Undo: Codex")).toBeDefined();
  expect(labelled("Undo: Claude Code")).toBeDefined();
  await act(() => labelled("Undo: Claude Code").props.onClick());
  expect(state.apply).toHaveBeenLastCalledWith({
    environmentId: mac,
    input: { action: "undo", changeId: "change-claude" },
  });
  // The row keeps what the last apply did: Codex still offers its own Undo.
  expect(labelled("Undo: Claude Code")).toBeUndefined();
  expect(text()).toContain("Undone");
  expect(labelled("Undo: Codex")).toBeDefined();
});
it("writes nothing when one tool's preview is refused", async () => {
  state.apply
    .mockResolvedValueOnce({
      _tag: "Success",
      value: { ...snapshot, change: { preview: true, files: [] } },
    })
    .mockRejectedValueOnce(new Error("offline"));
  state.query.data = {
    ...snapshot,
    plugins: [],
    connections: [entry("codex", "linear"), entry("claude", "linear")],
  };
  await renderTab();
  await act(() => labelled("Remove: linear").props.onClick());
  expect(state.apply).toHaveBeenCalledTimes(2);
  expect(byTestId("change-preview")).toEqual([]);
  expect(text()).toContain("did not confirm the change");
});
it("offers a search once the list is longer than eight servers", async () => {
  const many = (count: number) =>
    Array.from({ length: count }, (_, index) => entry("codex", `server-${index}`));
  state.query.data = { ...snapshot, plugins: [], connections: many(8) };
  await renderTab();
  expect(renderer.root.findAll((n) => n.type === "input")).toEqual([]);
  state.query = { ...state.query, data: { ...snapshot, plugins: [], connections: many(9) } };
  await act(() => renderer.update(<NativeConnectionsPanel environmentId={mac} />));
  const search = renderer.root.find((n) => n.type === "input");
  await act(() => search.props.onChange({ target: { value: "server-7" } }));
  expect(byTestId("server-row")).toHaveLength(1);
});
it("offers no list edits to a sign-in that cannot change the machine's files", async () => {
  state.query.data = { ...snapshot, plugins: [], connections: [entry("codex", "linear")] };
  state.mayWrite = false;
  await renderTab();
  expect(byTestId("server-row")).toHaveLength(1);
  expect(labelled("Remove: linear")).toBeUndefined();
  expect(named("Enter details by hand")).toBeUndefined();
});
it("tells a machine on an older version to update instead of offering the add", async () => {
  // No plugin list: the machine predates the review step.
  await renderTab();
  expect(text()).toContain("Update SpecWithCode on Mac to add servers from here.");
  expect(text()).toContain("cannot show you a change before it is written");
  expect(byTestId("add-server-paste")).toEqual([]);
  expect(byTestId("add-server-catalog")).toEqual([]);
  expect(text()).not.toContain("Pick one below");
  expect(state.apply).not.toHaveBeenCalled();
});
it("points an empty list at the add box and opens the by-hand form from there", async () => {
  state.query.data = { ...snapshot, plugins: [] };
  await renderTab();
  expect(text()).toContain("No MCP servers on Mac yet");
  expect(text()).toContain("Pick one below, or paste what the server's setup page gives you.");
  expect(byTestId("add-server-paste")).not.toEqual([]);
  await act(() => named("Enter details by hand").props.onClick());
  expect(byTestId("connection-editor")).not.toEqual([]);
  expect(byTestId("add-server-paste")).toEqual([]);
});
it("offers no add to a sign-in that cannot change the machine's files", async () => {
  state.query.data = { ...snapshot, plugins: [] };
  state.mayWrite = false;
  await renderTab();
  expect(byTestId("add-server-section")).toEqual([]);
  expect(text()).toContain("No MCP servers on Mac yet");
  expect(text()).not.toContain("Pick one below");
});
it("says Added, and nothing about sign-in state, on the row the guided add saved", async () => {
  const files = [{ tool: "Codex", path: "~/.codex/config.toml", lines: ["Add linear"] }];
  state.apply
    .mockResolvedValueOnce({
      _tag: "Success",
      value: { ...snapshot, change: { preview: true, files } },
    })
    .mockResolvedValueOnce({
      _tag: "Success",
      value: { ...snapshot, change: { preview: false, id: "change-1", files } },
    });
  state.query.data = { ...snapshot, plugins: [] };
  await renderTab();
  const submit = (id: string) =>
    act(async () => void (await byTestId(id)[0]!.props.onSubmit({ preventDefault() {} })));
  await act(() =>
    byTestId("add-server-paste")[0]!.props.onChange({
      target: { value: "https://mcp.linear.app/mcp" },
    }),
  );
  await submit("add-server-pick-form");
  await submit("add-server-summary");
  expect(state.apply).toHaveBeenLastCalledWith({
    environmentId: mac,
    input: {
      action: "add",
      name: "linear",
      tools: ["codex", "claude"],
      server: { url: "https://mcp.linear.app/mcp" },
      preview: true,
    },
  });
  await act(async () => void (await named("Save on Mac").props.onClick()));
  expect(state.query.refresh).toHaveBeenCalled();
  state.query = {
    ...state.query,
    data: {
      ...snapshot,
      plugins: [],
      connections: [entry("codex", "linear"), entry("claude", "linear")],
    },
  };
  await act(() => renderer.update(<NativeConnectionsPanel environmentId={mac} />));
  expect(byTestId("server-row")).toHaveLength(1);
  const row = byTestId("server-row")[0]!
    .findAll((node) => typeof node.type === "string")
    .flatMap((node) => node.children.filter((child) => typeof child === "string"))
    .join(" ");
  expect(row).toContain("linear");
  expect(row).toContain("Added");
  expect(text()).not.toContain("Connected");
  expect(text()).not.toContain("Needs sign-in");
});
