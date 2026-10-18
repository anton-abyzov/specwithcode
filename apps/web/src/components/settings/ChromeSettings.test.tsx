import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  type BrowserBridgeCheck,
  type BrowserBridgeStatus,
  EnvironmentId,
} from "@specweave-studio/contracts";
import { ChromeSettings, diagnoseChrome, MachineChromeCard } from "./ChromeSettings";

const state = vi.hoisted(() => ({
  permitted: true,
  operate: true,
  connected: true,
  query: {
    data: null as unknown,
    error: null as string | null,
    isPending: false,
    refresh: vi.fn(),
  },
  search: {} as Record<string, string>,
  selectScope: vi.fn(),
  environments: [] as Array<{ environmentId: string; label: string }>,
  primary: null as string | null,
  request: vi.fn((input: unknown) => input),
  useQuery: vi.fn(),
  command: vi.fn(),
}));
vi.mock("../../studio/projectWorkspace", () => ({
  projectWorkspace: {
    browserBridgeStatus: state.request,
    browserBridgeTest: "test",
    browserBridgeReconnect: "reconnect",
  },
}));
vi.mock("./BrowserExtensionSettings", () => ({
  BrowserExtensionCard: ({
    machine,
    thisComputer,
  }: {
    machine: string;
    thisComputer?: string | null;
  }) => (
    <section
      aria-label={`SpecWithCode Browser extension on ${machine}`}
      data-this-computer={thisComputer ?? "same"}
    />
  ),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (input: unknown) => state.command(command, input),
}));
vi.mock("../../state/session", async () => {
  const { AuthTerminalOperateScope } = await import("@specweave-studio/contracts");
  return {
    useEnvironmentScope: (_id: unknown, scope: unknown) =>
      scope === AuthTerminalOperateScope ? state.operate : state.permitted,
  };
});
vi.mock("../../state/environments", () => ({
  useEnvironment: () => ({ connection: { phase: state.connected ? "connected" : "disconnected" } }),
  useEnvironments: () => ({ environments: state.environments }),
  usePrimaryEnvironmentId: () => state.primary,
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => {
    state.useQuery(atom);
    return state.query;
  },
}));
vi.mock("./SettingsScopeContext", () => ({ useSettingsScope: () => state }));
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SettingsSection: ({ children, title }: { children: React.ReactNode; title: string }) => (
    <section aria-label={title}>{children}</section>
  ),
  useRelativeTimeTick: () => 0,
}));

const m4 = EnvironmentId.make("m4");
const status: BrowserBridgeStatus = {
  platform: "darwin",
  chrome: { installed: true, running: true },
  extension: { nativeHostInstalled: true, liveConnections: 2, pairedBrowserName: "m4 marketing" },
  claudeAccount: "owner@example.com",
  chromeProfiles: null,
  providers: [
    { provider: "claude", route: "built_in" },
    { provider: "codex", route: "own_extension" },
    { provider: "gemini", route: "not_set_up" },
  ],
  lastCheck: null,
};
const check = (state: BrowserBridgeCheck["state"], extra: Partial<BrowserBridgeCheck> = {}) =>
  ({
    state,
    browsers: [],
    checkedAt: "2026-10-16T09:00:00Z",
    durationMs: 900,
    ...extra,
  }) as BrowserBridgeCheck;

let renderer: ReactTestRenderer;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  state.permitted = true;
  state.operate = true;
  state.connected = true;
  state.query = { data: status, error: null, isPending: false, refresh: vi.fn() };
  state.search = {};
  state.primary = null;
  state.environments = [
    { environmentId: "m4", label: "M4 Max" },
    { environmentId: "m1", label: "M1" },
  ];
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});
const text = () => JSON.stringify(renderer.toJSON());
const button = (label: string) =>
  renderer.root.findAll(
    (node) => node.props.onClick && [node.props.children].flat(2).includes(label),
  )[0]!;

describe("diagnoseChrome", () => {
  it("asks for Reconnect when hosts are alive but the bridge is not connected", () => {
    const result = diagnoseChrome(status, check("not_connected"), "M4 Max");
    expect(result?.action).toBe("reconnect");
    expect(result?.detail).toContain("owner@example.com");
    expect(result?.detail).toContain("SpecWithCode");
  });
  it("puts machine facts before the check result", () => {
    expect(
      diagnoseChrome({ ...status, chrome: { installed: true, running: false } }, null, "M1")?.title,
    ).toBe("Open Chrome on M1");
    expect(
      diagnoseChrome(
        { ...status, extension: { ...status.extension, liveConnections: 0 } },
        check("not_connected"),
        "M1",
      )?.title,
    ).toBe("Install or turn on the extension");
    expect(diagnoseChrome(status, check("cli_missing"), "M1")?.title).toContain("Claude Code");
  });
  it("is silent when connected or unchecked with a healthy machine", () => {
    expect(diagnoseChrome(status, check("connected"), "M4")).toBeNull();
    expect(diagnoseChrome(status, null, "M4")).toBeNull();
  });
});

describe("ChromeSettings", () => {
  it("shows the machine picker first and opens the machine from the link", async () => {
    state.search = { machine: "m1" };
    await act(() => {
      renderer = create(<ChromeSettings />);
    });
    const tabs = renderer.root.findAll(
      (node) => typeof node.type === "string" && node.props.role === "tab",
    );
    expect(tabs.map((tab) => tab.props["aria-selected"])).toEqual([false, true]);
    expect(text()).toContain("Chrome on M1");
    await act(() => tabs[0]!.props.onClick());
    expect(state.selectScope).toHaveBeenCalledWith({ machine: "m4" });
  });
});

describe("ChromeSettings this computer", () => {
  it("lists this computer first, marked, and opens on it", async () => {
    state.environments = [
      { environmentId: "m1", label: "M1" },
      { environmentId: "m4", label: "M4 Max" },
    ];
    state.primary = "m4";
    await act(() => {
      renderer = create(<ChromeSettings />);
    });
    const tabs = renderer.root.findAll(
      (node) => typeof node.type === "string" && node.props.role === "tab",
    );
    expect(tabs.map((tab) => tab.props["aria-selected"])).toEqual([true, false]);
    const marked = (tab: (typeof tabs)[number]) =>
      tab.findAll((node) => node.props.children === "This computer").length > 0;
    expect(tabs.map(marked)).toEqual([true, false]);
    expect(text()).toContain('"data-this-computer":"same"');
  });

  it("tells the card which computer you are on when another is picked", async () => {
    state.primary = "m4";
    state.search = { machine: "m1" };
    await act(() => {
      renderer = create(<ChromeSettings />);
    });
    expect(text()).toContain('"data-this-computer":"M4 Max"');
  });
});

describe("MachineChromeCard", () => {
  const render = () =>
    act(() => {
      renderer = create(<MachineChromeCard environmentId={m4} machine="M4 Max" />);
    });

  it("does not query an offline machine", async () => {
    state.connected = false;
    await render();
    expect(state.useQuery).toHaveBeenLastCalledWith(null);
    expect(text()).toContain("offline");
  });

  it("shows facts, provider routes and the shared-bridge snippet", async () => {
    await render();
    expect(state.request).toHaveBeenCalledWith({ environmentId: m4, input: {} });
    expect(text()).toContain("Not checked yet");
    expect(text()).toContain("Hidden by macOS privacy settings");
    expect(text()).toContain("m4 marketing");
    expect(text()).toContain("Gemini");
    expect(text()).toContain("--claude-in-chrome-mcp");
  });

  it("tests the connection and shows the round trip result", async () => {
    state.command.mockResolvedValue({
      _tag: "Success",
      value: check("connected", { tabCount: 2, browsers: [{ name: "m4 marketing", inUse: true }] }),
    });
    await render();
    await act(() => button("Test connection").props.onClick());
    expect(state.command).toHaveBeenCalledWith("test", { environmentId: m4, input: {} });
    expect(text()).toContain("Connected");
    expect(text()).toContain("2 agent tabs");
    expect(text()).toContain("in use");
    expect(state.query.refresh).toHaveBeenCalled();
  });

  it("explains a lost connection and offers Reconnect", async () => {
    state.query.data = { ...status, lastCheck: check("not_connected") };
    let resolve: (value: unknown) => void = () => {};
    state.command.mockReturnValue(new Promise((r) => (resolve = r)));
    await render();
    expect(text()).toContain("not connected");
    expect(button("Reconnect").props.variant).toBe("default");
    act(() => {
      void button("Reconnect").props.onClick();
    });
    expect(state.command).toHaveBeenCalledWith("reconnect", { environmentId: m4, input: {} });
    expect(text()).toContain("Waiting up to 2 minutes");
    await act(async () => resolve({ _tag: "Success", value: check("connected") }));
    expect(text()).not.toContain("Waiting up to 2 minutes");
  });

  it("disables checks for devices without terminal access", async () => {
    state.operate = false;
    await render();
    expect(button("Test connection").props.disabled).toBe(true);
    expect(button("Reconnect").props.disabled).toBe(true);
    expect(text()).toContain("not test it");
  });
});
