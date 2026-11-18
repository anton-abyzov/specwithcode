import { act, useState } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, type BrowserExtensionStatus } from "@specweave-studio/contracts";

import { chromeRowState, type ChromeRowInput } from "../../onboarding/chromeRowState.logic";
import { BROWSER_EXTENSION_POLL_MS } from "../settings/BrowserExtensionSetup";
import { ChromeAccessRow, ChromeAccessRowView } from "./ChromeAccessRow";

const state = vi.hoisted(() => ({
  connected: true,
  read: true,
  operate: true,
  grant: true,
  locked: false,
  query: { data: null as unknown, error: null, isPending: false, refresh: vi.fn() },
  useQuery: vi.fn(),
  command: vi.fn(),
  clipboard: vi.fn(async (_text: string) => undefined),
  clearClipboard: vi.fn(async (_text: string) => true),
  profiles: vi.fn(async () => null as unknown),
  openUrl: vi.fn(async () => undefined),
}));
vi.mock("../../studio/projectWorkspace", () => ({
  projectWorkspace: {
    browserExtensionStatus: (input: unknown) => input,
    browserExtensionPairing: "pairing",
    browserExtensionReconnect: "reconnect",
    browserExtensionPeer: "peer",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (input: unknown) => state.command(command, input),
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: (_id: unknown, scope: unknown) =>
    String(scope).includes("terminal")
      ? state.operate
      : String(scope).includes("access")
        ? state.grant
        : state.read,
}));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => ({ connection: { phase: state.connected ? "connected" : "disconnected" } }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => {
    state.useQuery(atom);
    return atom === null ? { ...state.query, data: null } : state.query;
  },
}));
vi.mock("../../teamRules/useTeamRules", () => ({ useTeamRules: () => ({ summary: undefined }) }));
vi.mock("../../teamRules/teamRulesView", () => ({
  teamRulesToolLock: () => (state.locked ? { reason: "team" } : null),
}));
vi.mock("../../hooks/useCopyToClipboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useCopyToClipboard")>()),
  writeTextToClipboard: (text: string) => state.clipboard(text),
}));
vi.mock("../../browser/externalBrowsers", () => ({
  canUseExternalBrowsers: () => true,
  readChromeProfiles: () => state.profiles(),
  openUrlInExternalBrowser: (...args: unknown[]) => state.openUrl(...(args as [])),
  clearClipboardIfText: (text: string) => state.clearClipboard(text),
}));

const m4 = EnvironmentId.make("m4");
const status = (overrides: Partial<BrowserExtensionStatus> = {}): BrowserExtensionStatus => ({
  relayUrl: "ws://127.0.0.1:4777",
  bundledVersion: "0.1.0",
  storeUrl: null,
  profiles: [],
  recentActions: [],
  ...overrides,
});
const profile = (id: string, label: string) => ({
  id,
  label,
  extensionVersion: "0.1.0",
  browser: "Chrome 141",
  connectedAt: "2026-11-18T09:00:00Z",
  attachedTabs: 0,
  lease: null,
});

let renderer: ReactTestRenderer;
let setOpen: (open: boolean) => void = () => {};
const onOpenChange = vi.fn();
function Harness({ initiallyOpen = false }: { initiallyOpen?: boolean }) {
  const [open, set] = useState(initiallyOpen);
  setOpen = set;
  return (
    <ChromeAccessRow
      environmentId={m4}
      machine="M4 Max"
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        set(next);
      }}
    />
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {});
  vi.clearAllMocks();
  state.connected = true;
  state.read = true;
  state.operate = true;
  state.grant = true;
  state.locked = false;
  state.query = { data: status(), error: null, isPending: false, refresh: vi.fn() };
  state.command.mockResolvedValue({
    _tag: "Success",
    value: { pairingCode: "SECRET-1", relayUrl: "ws://x" },
  });
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const render = async (node = <Harness />) => {
  await act(() => {
    renderer = create(node);
  });
};
const rerender = async () => {
  await act(() => renderer.update(<Harness />));
};
const text = () => JSON.stringify(renderer.toJSON());
const nodeText = (node: { children: ReadonlyArray<unknown> }): string =>
  node.children
    .map((child) =>
      typeof child === "string" ? child : nodeText(child as { children: ReadonlyArray<unknown> }),
    )
    .join("");
const buttons = () =>
  renderer.root.findAll((node) => typeof node.type !== "string" && node.props.onClick);
const button = (label: string) =>
  (buttons().find((node) => [node.props.children].flat(2).includes(label)) ??
    buttons().find((node) => nodeText(node).startsWith(label)))!;
const kind = () =>
  renderer.root.find((node) => node.props["data-chrome-state"] !== undefined).props[
    "data-chrome-state"
  ];
const bodyHidden = () =>
  renderer.root.find(
    (node) => typeof node.type === "string" && node.props["data-slot"] === "access-row-body",
  ).props.hidden;

describe("ChromeAccessRowView", () => {
  const input = (overrides: Partial<ChromeRowInput> = {}): ChromeRowInput => ({
    online: true,
    teamRulesLocked: false,
    allowed: true,
    status: { bundledVersion: "0.1.0", profiles: [] },
    codeHandedOut: false,
    ...overrides,
  });
  const view = async (given: ChromeRowInput, open = false, canAnswer = true) => {
    const onAnswer = vi.fn();
    const onReconnect = vi.fn();
    await render(
      <ChromeAccessRowView
        canAnswer={canAnswer}
        state={chromeRowState(given)}
        machine="M4 Max"
        open={open}
        onOpenChange={onOpenChange}
        steps={<p>steps</p>}
        storeUrl="https://chromewebstore.google.com/x"
        onReconnect={onReconnect}
        onAnswer={onAnswer}
      />,
    );
    return { onAnswer, onReconnect };
  };

  it.each([
    ["offline", input({ online: false, status: null }), "M4 Max is offline."],
    ["team-rules", input({ teamRulesLocked: true }), "Turned off by your team's rules."],
    ["not-allowed", input({ allowed: false }), "This window cannot pair a browser with "],
    ["loading", input({ status: null }), "Checking Chrome…"],
    [
      "chrome-missing",
      input({ status: { bundledVersion: "0.1.0", profiles: [], chromeInstalled: false } }),
      "Chrome is not installed on M4 Max.",
    ],
  ] as const)("%s has no action", async (expected, given, line) => {
    await view(given, true);
    expect(kind()).toBe(expected);
    expect(text()).toContain(line);
    expect(buttons()).toHaveLength(0);
    // The steps stay shut even when the row was left open.
    expect(bodyHidden()).toBe(true);
  });

  it("always says agents use only the profiles you pair", async () => {
    await view(input({ online: false, status: null }));
    expect(text()).toContain(
      "Agents use only the Chrome profiles you pair, and only while they are paired.",
    );
  });

  it("not set up offers Set up, which opens the steps", async () => {
    await view(input());
    expect(kind()).toBe("not-set-up");
    expect(bodyHidden()).toBe(true);
    await act(() => button("Set up").props.onClick());
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it("open, the steps show with why the extension is safer", async () => {
    await view(input(), true);
    expect(bodyHidden()).toBe(false);
    expect(text()).toContain("They never read Chrome's files on disk");
    expect(button("Hide")).toBeDefined();
  });

  it("paired names its profiles and offers another", async () => {
    await view(
      input({
        status: {
          bundledVersion: "0.1.0",
          profiles: [
            { id: "p1", label: "Work", extensionVersion: "0.1.0" },
            { id: "p2", label: "Chrome", extensionVersion: "0.0.9", fromStore: false },
          ],
        },
      }),
    );
    expect(kind()).toBe("paired");
    expect(text()).toContain("Paired: {names}".replace("{names}", "Work, Chrome"));
    expect(text()).toContain("Agents use the profile you name.");
    expect(text()).toContain("an older extension.");
    expect(text()).toContain("not from the Chrome Web Store.");
    expect(text()).toContain("give it a name agents can tell apart.");
    expect(button("Pair another profile")).toBeDefined();
  });

  it("paired but not answering offers Reconnect", async () => {
    const { onReconnect } = await view(
      input({ status: { bundledVersion: "0.1.0", profiles: [], paired: true } }),
    );
    expect(kind()).toBe("not-answering");
    await act(() => button("Reconnect").props.onClick());
    expect(onReconnect).toHaveBeenCalled();
  });

  it("another machine asking is answered with Allow or Decline", async () => {
    const { onAnswer } = await view(
      input({
        status: {
          bundledVersion: "0.1.0",
          profiles: [{ id: "p1", label: "Work", extensionVersion: "0.1.0" }],
          peers: [{ id: "g1", machine: "Studio", state: "pending" }],
        },
      }),
    );
    expect(kind()).toBe("approval");
    expect(text()).toContain("asks to use this Chrome for its threads.");
    await act(() => button("Decline").props.onClick());
    expect(onAnswer).toHaveBeenCalledWith(false);
  });

  it("a window that cannot change access says where to answer instead", async () => {
    await view(
      input({
        status: {
          bundledVersion: "0.1.0",
          profiles: [],
          peers: [{ id: "g1", machine: "Studio", state: "pending" }],
        },
      }),
      false,
      false,
    );
    expect(kind()).toBe("approval");
    expect(text()).toContain("This window cannot answer it");
    expect(buttons()).toHaveLength(0);
  });
});

describe("ChromeAccessRow", () => {
  it("reads nothing while offline or without access", async () => {
    state.connected = false;
    await render();
    expect(state.useQuery).toHaveBeenLastCalledWith(null);
    expect(kind()).toBe("offline");
  });

  it("copies the code without showing it, then waits for Chrome", async () => {
    await render(<Harness initiallyOpen />);
    await act(() => button("Copy code").props.onClick());
    expect(state.command).toHaveBeenCalledWith("pairing", { environmentId: m4, input: {} });
    expect(state.clipboard).toHaveBeenCalledWith("SECRET-1");
    expect(text()).not.toContain("SECRET-1");
    expect(kind()).toBe("waiting");
    expect(text()).toContain("Waiting for Chrome…");

    await act(() => button("Show").props.onClick());
    expect(text()).toContain("SECRET-1");
    await act(() => button("Hide").props.onClick());
    expect(text()).not.toContain("SECRET-1");
  });

  it("clears a copied code two minutes later", async () => {
    vi.useFakeTimers();
    await render(<Harness initiallyOpen />);
    await act(() => button("Copy code").props.onClick());
    expect(state.clearClipboard).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTime(120_000));
    expect(state.clearClipboard).toHaveBeenCalledWith("SECRET-1");
  });

  it("a second copy restarts the two minutes", async () => {
    vi.useFakeTimers();
    await render(<Harness initiallyOpen />);
    await act(() => button("Copy code").props.onClick());
    await act(() => vi.advanceTimersByTime(90_000));
    await act(() => button("Copied").props.onClick());
    await act(() => vi.advanceTimersByTime(60_000));
    expect(state.clearClipboard).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTime(60_000));
    expect(state.clearClipboard).toHaveBeenCalledTimes(1);
  });

  it("polls every 3 s only while open", async () => {
    vi.useFakeTimers();
    await render();
    await act(() => vi.advanceTimersByTime(BROWSER_EXTENSION_POLL_MS * 3));
    expect(state.query.refresh).not.toHaveBeenCalled();
    await act(() => setOpen(true));
    await act(() => vi.advanceTimersByTime(BROWSER_EXTENSION_POLL_MS * 2));
    expect(state.query.refresh).toHaveBeenCalledTimes(2);
  });

  it("closes the steps and clears the clipboard once a profile pairs", async () => {
    await render(<Harness initiallyOpen />);
    await act(() => button("Copy code").props.onClick());
    state.query = { ...state.query, data: status({ profiles: [profile("p1", "Work")] }) };
    await rerender();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(state.clearClipboard).toHaveBeenCalledWith("SECRET-1");
    expect(kind()).toBe("paired");
  });

  it("pairing a second profile also closes the steps", async () => {
    state.query = { ...state.query, data: status({ profiles: [profile("p1", "Work")] }) };
    await render();
    await act(() => button("Pair another profile").props.onClick());
    await act(() => button("Copy code").props.onClick());
    // The first profile is still paired: the code waits for a new one.
    expect(state.clearClipboard).not.toHaveBeenCalled();
    expect(text()).toContain("Waiting for Chrome…");
    state.query = {
      ...state.query,
      data: status({ profiles: [profile("p1", "Work"), profile("p2", "Brand")] }),
    };
    await rerender();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(state.clearClipboard).toHaveBeenCalledWith("SECRET-1");
  });

  it("an answer the machine refuses says so", async () => {
    state.query = {
      ...state.query,
      data: status({
        peers: [
          {
            id: "g1",
            machine: "Studio",
            label: "Studio",
            state: "pending",
            requestedAt: "2026-11-18T00:00:00Z",
          },
        ],
      }),
    };
    state.command.mockResolvedValue({ _tag: "Failure", cause: "refused" });
    await render();
    await act(() => button("Allow").props.onClick());
    expect(state.command).toHaveBeenCalledWith("peer", {
      environmentId: m4,
      input: { id: "g1", allow: true },
    });
    expect(text()).toContain("That did not go through. Try again.");
  });

  it("a paired profile reconnecting is not a new pairing", async () => {
    state.query = { ...state.query, data: status({ profiles: [profile("p1", "Work")] }) };
    await render();
    await act(() => button("Pair another profile").props.onClick());
    await act(() => button("Copy code").props.onClick());
    onOpenChange.mockClear();
    state.query = { ...state.query, data: status({ profiles: [] }) };
    await rerender();
    // The relay gives the reconnect a new id; the name stays.
    state.query = { ...state.query, data: status({ profiles: [profile("p3", "Work")] }) };
    await rerender();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(state.clearClipboard).not.toHaveBeenCalled();
    expect(text()).toContain("Waiting for Chrome…");
  });

  it("a new profile that connects as another leaves is a pairing", async () => {
    state.query = { ...state.query, data: status({ profiles: [profile("p1", "Work")] }) };
    await render();
    await act(() => button("Pair another profile").props.onClick());
    await act(() => button("Copy code").props.onClick());
    state.query = { ...state.query, data: status({ profiles: [profile("p2", "Brand")] }) };
    await rerender();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(state.clearClipboard).toHaveBeenCalledWith("SECRET-1");
  });

  it("on a Mac too, reads Chrome's profiles once the steps open", async () => {
    vi.stubGlobal("window", { desktopBridge: { getClientPlatform: () => "darwin" } });
    state.profiles.mockResolvedValue([{ directory: "Default", name: "Your Chrome" }]);
    await render(<Harness initiallyOpen />);
    expect(state.profiles).toHaveBeenCalledTimes(1);
    expect(text()).toContain("Opens the store page in Chrome.");
  });

  it("where no profile can be read, the store link opens in the profile Chrome used last", async () => {
    vi.stubGlobal("window", { desktopBridge: { getClientPlatform: () => "darwin" } });
    state.profiles.mockResolvedValue(null);
    await render(<Harness initiallyOpen />);
    expect(text()).toContain("It opens in the Chrome profile you used last.");
  });

  it("elsewhere, reads Chrome's profiles once Set up is pressed and opens the store in the one picked", async () => {
    vi.stubGlobal("window", { desktopBridge: { getClientPlatform: () => "win32" } });
    state.profiles.mockResolvedValue([
      { directory: "Default", name: "Personal" },
      { directory: "Profile 1", name: "Work" },
    ]);
    await render();
    expect(state.profiles).not.toHaveBeenCalled();
    await act(() => button("Set up").props.onClick());
    expect(state.profiles).toHaveBeenCalledTimes(1);
    await act(() =>
      renderer.root
        .find((node) => node.props["data-chrome-profile"] === "Profile 1" && node.type === "button")
        .props.onClick(),
    );
    await act(() => button("Add to Chrome").props.onClick());
    expect(state.openUrl).toHaveBeenCalledWith(expect.stringContaining("chromewebstore"), {
      browserId: "chrome",
      profileDirectory: "Profile 1",
    });
  });
});
