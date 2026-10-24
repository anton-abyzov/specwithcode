import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  BROWSER_EXTENSION_STORE_URL,
  type BrowserExtensionCheck,
  type BrowserExtensionStatus,
  EnvironmentId,
} from "@specweave-studio/contracts";
import { BROWSER_EXTENSION_POLL_MS, BrowserExtensionCard } from "./BrowserExtensionSettings";

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
  request: vi.fn((input: unknown) => input),
  useQuery: vi.fn(),
  command: vi.fn(),
  confirm: vi.fn(async () => true),
  preferSpecWithCodeBrowser: true,
  canWriteSettings: true,
}));
vi.mock("../../studio/projectWorkspace", () => ({
  projectWorkspace: {
    browserExtensionStatus: state.request,
    browserExtensionPairing: "pairing",
    browserExtensionTest: "test",
    browserExtensionReconnect: "reconnect",
    browserExtensionStop: "stop",
    browserExtensionPeer: "peer",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (input: unknown) => state.command(command, input),
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: (_id: unknown, scope: { _tag?: string } | string) =>
    String(scope).includes("terminal")
      ? state.operate
      : String(scope) === "settings:write"
        ? state.canWriteSettings
        : state.permitted,
}));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: (
    _id: unknown,
    select: (settings: { preferSpecWithCodeBrowser: boolean }) => unknown,
  ) => select({ preferSpecWithCodeBrowser: state.preferSpecWithCodeBrowser }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { updateSettings: "updateSettings" },
}));
vi.mock("../../state/entities", () => ({
  useThreadShell: ({ threadId }: { threadId: string }) =>
    ({ "thread-7": { title: "Publish the launch post" }, aide: { title: "Aide" } })[threadId] ??
    null,
}));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => ({ connection: { phase: state.connected ? "connected" : "disconnected" } }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => {
    state.useQuery(atom);
    return state.query;
  },
}));
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ dialogs: { confirm: state.confirm } }),
}));
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({ children, title }: { children: React.ReactNode; title: string }) => (
    <section aria-label={title}>{children}</section>
  ),
  useRelativeTimeTick: () => 0,
}));

const m4 = EnvironmentId.make("m4");
const status: BrowserExtensionStatus = {
  relayUrl: "ws://127.0.0.1:4777",
  bundledVersion: "0.1.0",
  storeUrl: null,
  profiles: [
    {
      id: "p1",
      label: "Marketing",
      extensionVersion: "0.1.0",
      browser: "Chrome 141",
      connectedAt: "2026-10-16T09:00:00Z",
      attachedTabs: 2,
      lease: {
        threadId: "thread-7",
        since: "2026-10-16T09:01:00Z",
        lastActionAt: "2026-10-16T09:02:00Z",
      },
      threads: [
        {
          threadId: "thread-7",
          tabs: 1,
          since: "2026-10-16T09:01:00Z",
          lastActionAt: "2026-10-16T09:02:00Z",
        },
        {
          threadId: "aide",
          tabs: 1,
          since: "2026-10-16T09:00:30Z",
          lastActionAt: "2026-10-16T09:01:30Z",
        },
      ],
    },
    {
      id: "p2",
      label: "Personal",
      extensionVersion: "0.1.0",
      browser: "Chrome 141",
      connectedAt: "2026-10-16T08:00:00Z",
      attachedTabs: 0,
      lease: null,
    },
  ],
  recentActions: [
    {
      at: "2026-10-16T09:02:00Z",
      profile: "Marketing",
      threadId: "thread-7",
      tool: "chrome_open",
      url: "https://example.com/",
    },
  ],
};

let renderer: ReactTestRenderer;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  state.permitted = true;
  state.operate = true;
  state.connected = true;
  state.query = { data: status, error: null, isPending: false, refresh: vi.fn() };
  state.confirm.mockResolvedValue(true);
  state.preferSpecWithCodeBrowser = true;
  state.canWriteSettings = true;
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const text = () => JSON.stringify(renderer.toJSON());
const button = (label: string) =>
  renderer.root.findAll(
    (node) =>
      typeof node.type !== "string" &&
      node.props.onClick &&
      [node.props.children].flat(2).includes(label),
  )[0]!;
/** The store link the "Add to Chrome" button opens. */
const storeLink = () =>
  renderer.root.findAll(
    (node) =>
      typeof node.type !== "string" &&
      node.props.render &&
      [node.props.children].flat(2).includes("Add to Chrome"),
  )[0]!.props.render.props.href;
const render = () =>
  act(() => {
    renderer = create(<BrowserExtensionCard environmentId={m4} machine="M4 Max" />);
  });

describe("BrowserExtensionCard", () => {
  it("turns the SpecWithCode Browser preference for Claude threads on and off", async () => {
    await render();
    const toggle = () =>
      renderer.root.find(
        (node) =>
          typeof node.type !== "string" &&
          node.props["aria-label"] === "Use SpecWithCode Browser in Claude threads" &&
          node.props.onCheckedChange !== undefined,
      );
    expect(text()).toContain("Claude threads there start without");
    expect(toggle().props.checked).toBe(true);
    expect(toggle().props.disabled).toBe(false);
    await act(() => toggle().props.onCheckedChange(false));
    expect(state.command).toHaveBeenCalledWith("updateSettings", {
      environmentId: m4,
      input: { patch: { preferSpecWithCodeBrowser: false } },
    });
    // Shown off when off, and read-only without settings access.
    state.preferSpecWithCodeBrowser = false;
    state.canWriteSettings = false;
    await render();
    expect(toggle().props.checked).toBe(false);
    expect(toggle().props.disabled).toBe(true);
  });

  it("does not query an offline machine", async () => {
    state.connected = false;
    await render();
    expect(state.useQuery).toHaveBeenLastCalledWith(null);
    expect(text()).toContain("offline");
  });

  it("lists profiles, Stop only where an agent holds one", async () => {
    await render();
    expect(state.request).toHaveBeenCalledWith({ environmentId: m4, input: {} });
    expect(text()).toContain("Add to Chrome");
    // Servers that predate fromStore send no flag: no hand-loaded warning.
    expect(text()).not.toContain("Loaded by hand");
    expect(text()).toContain("Every chat, project thread and Aide");
    expect(text()).toContain("Ready · 2 Chrome profiles paired");
    expect(text()).toContain("Marketing");
    // Threads by title, never by id.
    expect(text()).toContain("Publish the launch post");
    expect(text()).toContain("Aide");
    expect(text()).toContain("in use by 2 threads");
    expect(text()).not.toContain("Thread thread-7");
    // One Test button; Reconnect waits for a failed check.
    expect(text()).toContain("Test connection");
    expect(text()).not.toContain("Reconnect");
    expect(text()).toContain("chrome_open");
    expect(
      renderer.root.findAll(
        (node) =>
          typeof node.type === "string" &&
          node.props["data-testid"] === "browser-extension-profile",
      ),
    ).toHaveLength(2);
    expect(
      renderer.root.findAll(
        (node) =>
          node.props.onClick &&
          [node.props.children].flat(2).includes("Stop") &&
          typeof node.type !== "string",
      ),
    ).toHaveLength(2);
    state.command.mockResolvedValue({ _tag: "Success", value: status });
    // Stop on a thread's row lets go of that thread's tabs only.
    await act(() => button("Stop").props.onClick());
    expect(state.command).toHaveBeenCalledWith("stop", {
      environmentId: m4,
      input: { profileId: "p1", threadId: "thread-7" },
    });
    await act(() => button("Stop all").props.onClick());
    expect(state.command).toHaveBeenCalledWith("stop", {
      environmentId: m4,
      input: { profileId: "p1" },
    });
  });

  it("shows one thread from an older service that reports only a lease", async () => {
    const [first, second] = status.profiles;
    const { threads: _threads, ...older } = first!;
    state.query.data = { ...status, profiles: [older, second!] };
    await render();
    expect(
      renderer.root.findAll(
        (node) =>
          typeof node.type === "string" && node.props["data-testid"] === "browser-extension-thread",
      ),
    ).toHaveLength(1);
    expect(text()).toContain("Publish the launch post");
  });

  it("names a thread from another machine by the title and machine it sent", async () => {
    const [first, second] = status.profiles;
    const remote = {
      threadId: "peer:env-m1:t9",
      tabs: 2,
      since: "2026-10-16T09:01:00Z",
      lastActionAt: "2026-10-16T09:03:00Z",
      title: "Check the invoice page",
      machine: "M1 Air",
    };
    state.query.data = {
      ...status,
      profiles: [{ ...first!, threads: [remote] }, second!],
      recentActions: [
        {
          at: remote.lastActionAt,
          profile: "Marketing",
          threadId: remote.threadId,
          tool: "chrome_click",
          title: remote.title,
          machine: remote.machine,
        },
      ],
    };
    await render();
    expect(text()).toContain("Check the invoice page");
    expect(text()).toContain("M1 Air");
    expect(text()).not.toContain("peer:env-m1");
    expect(text()).not.toContain("A thread no longer listed");
    expect(text()).toContain("Threads on your other connected machines");
  });

  it("asks before another machine uses this Chrome, and takes access back", async () => {
    state.query.data = {
      ...status,
      peers: [
        {
          id: "s1",
          machine: "M1 Air",
          label: "SpecWithCode workers · env-m1",
          state: "pending",
          requestedAt: "2026-10-16T09:02:00Z",
        },
        {
          id: "s2",
          machine: "Mini",
          label: "SpecWithCode workers · env-mini",
          state: "allowed",
          requestedAt: "2026-10-16T08:00:00Z",
        },
      ],
    };
    await render();
    expect(text()).toContain("Your other machines");
    expect(text()).toContain("M1 Air");
    expect(text()).toContain("wants its threads to use Chrome on M4 Max");
    expect(text()).toContain("Signed in as SpecWithCode workers · env-m1");
    expect(text()).toContain("can use Chrome on M4 Max");
    state.command.mockResolvedValue({ _tag: "Success", value: status });
    await act(() => button("Allow").props.onClick());
    expect(state.command).toHaveBeenCalledWith("peer", {
      environmentId: m4,
      input: { id: "s1", allow: true },
    });
    await act(() => button("Remove access").props.onClick());
    expect(state.command).toHaveBeenCalledWith("peer", {
      environmentId: m4,
      input: { id: "s2", allow: false },
    });
  });

  it("links the store listing, even from a server that predates it", async () => {
    state.query.data = {
      ...status,
      profiles: [],
      storeUrl: "https://chromewebstore.google.com/detail/x",
    };
    await render();
    expect(storeLink()).toBe("https://chromewebstore.google.com/detail/x");
    expect(text()).not.toContain("Load unpacked");
    expect(text()).not.toContain("Developer mode");

    state.query.data = { ...status, profiles: [], storeUrl: null };
    await render();
    expect(storeLink()).toBe(BROWSER_EXTENSION_STORE_URL);
  });

  it("asks a hand-loaded profile to switch to the store install", async () => {
    state.query.data = {
      ...status,
      profiles: status.profiles.map((profile, index) => ({ ...profile, fromStore: index !== 0 })),
    };
    await render();
    expect(text()).toContain("Loaded by hand, so it does not update itself.");
    expect(text().match(/browser-extension-hand-loaded/g)).toHaveLength(1);
  });

  it("shows an empty state with no profiles", async () => {
    state.query.data = { ...status, profiles: [], recentActions: [] };
    await render();
    // Nothing paired: the setup is the page, with no test to run yet.
    expect(text()).toContain("Not set up");
    expect(text()).toContain("browser-extension-setup");
    expect(text()).not.toContain("Pair another Chrome profile");
    expect(text()).not.toContain("Test connection");
  });

  it("offers Reconnect only after a check finds a profile not answering", async () => {
    await render();
    state.command.mockResolvedValue({
      _tag: "Success",
      value: {
        state: "error",
        profiles: [{ id: "p1", label: "Marketing", ok: false, message: "No answer" }],
        checkedAt: "2026-10-16T09:03:00Z",
      },
    });
    await act(() => button("Test connection").props.onClick());
    expect(text()).toContain("Reconnect");
  });

  it("hides the pairing code until revealed, and resets only after confirm", async () => {
    await render();
    expect(text()).not.toContain("SECRET-1");
    state.command.mockResolvedValue({
      _tag: "Success",
      value: { pairingCode: "SECRET-1", relayUrl: "ws://x" },
    });
    await act(() => button("Show pairing code").props.onClick());
    expect(state.command).toHaveBeenCalledWith("pairing", { environmentId: m4, input: {} });
    expect(text()).toContain("SECRET-1");

    state.confirm.mockResolvedValueOnce(false);
    await act(() => button("Reset code").props.onClick());
    expect(state.command).toHaveBeenCalledTimes(1);

    state.command.mockResolvedValue({
      _tag: "Success",
      value: { pairingCode: "SECRET-2", relayUrl: "ws://x" },
    });
    await act(() => button("Reset code").props.onClick());
    expect(state.command).toHaveBeenLastCalledWith("pairing", {
      environmentId: m4,
      input: { reset: true },
    });
    expect(text()).toContain("SECRET-2");

    await act(() => button("Hide").props.onClick());
    expect(text()).not.toContain("SECRET-2");
  });

  it("warns that another computer's code fails in Chrome here", async () => {
    await render();
    expect(text()).not.toContain("browser-extension-other-computer");
    const onSwitch = vi.fn();
    await act(() => {
      renderer = create(
        <BrowserExtensionCard
          environmentId={m4}
          machine="MacBookPro.lan"
          thisComputer="M4 Max"
          onSwitchToThisComputer={onSwitch}
        />,
      );
    });
    expect(text()).toContain("browser-extension-other-computer");
    expect(text()).toContain("This code works only in Chrome on ");
    await act(() => button("Set up Chrome on ").props.onClick());
    expect(onSwitch).toHaveBeenCalled();

    state.confirm.mockResolvedValueOnce(false);
    await act(() => button("Show pairing code").props.onClick());
    expect(state.confirm).toHaveBeenCalledWith(expect.stringContaining("Chrome on MacBookPro.lan"));
    expect(state.command).not.toHaveBeenCalled();
  });

  it("tests the connection and shows per-profile results", async () => {
    const check: BrowserExtensionCheck = {
      state: "connected",
      checkedAt: "2026-10-16T09:05:00Z",
      profiles: [
        { id: "p1", label: "Marketing", ok: true, tabCount: 3, roundTripMs: 42 },
        { id: "p2", label: "Personal", ok: false, message: "Chrome is closed" },
      ],
    };
    state.command.mockResolvedValue({ _tag: "Success", value: check });
    await render();
    await act(() => button("Test connection").props.onClick());
    expect(state.command).toHaveBeenCalledWith("test", { environmentId: m4, input: {} });
    expect(text()).toContain("42 ms");
    expect(text()).toContain("Chrome is closed");
    // A profile did not answer, so Reconnect appears.
    await act(() => button("Reconnect").props.onClick());
    expect(state.command).toHaveBeenCalledWith("reconnect", { environmentId: m4, input: {} });
    expect(state.query.refresh).toHaveBeenCalled();
  });

  it("polls status while open", async () => {
    vi.useFakeTimers();
    await render();
    expect(state.query.refresh).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTime(BROWSER_EXTENSION_POLL_MS * 2));
    expect(state.query.refresh).toHaveBeenCalledTimes(2);
  });

  it("disables pairing and checks without terminal access", async () => {
    state.operate = false;
    await render();
    expect(button("Test connection").props.disabled).toBe(true);
    expect(button("Show pairing code").props.disabled).toBe(true);
  });
});
