import {
  DESKTOP_INSTALL_APPLY_MS,
  type DesktopUpdateActionResult,
  type DesktopUpdateState,
  type ServerPrepareServiceUpdateInput,
  type ServerPrepareServiceUpdateResult,
  type StudioServiceInstallOptions,
  type StudioServiceUpdateState,
} from "@specweave-studio/contracts";
import type { ReactElement, ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// "Update now" for the service and the app: the app's install follows the
// service's, through a retry, a hold that runs out and a reload of the window.

const state = vi.hoisted(() => ({
  app: null as DesktopUpdateState | null,
  service: null as StudioServiceUpdateState | null,
  addToast: vi.fn((_toast: unknown) => "toast-1"),
  updateToast: vi.fn(),
  closeToast: vi.fn(),
  announce: vi.fn(),
  prepare: vi.fn(),
  navigate: vi.fn(),
  // What the update feed answers when the restart asks it again; null keeps the download.
  feed: null as DesktopUpdateState | null,
}));

vi.mock("../../env", () => ({ isElectron: true }));
vi.mock("../../state/desktopUpdate", () => ({ useDesktopUpdateState: () => state.app }));
vi.mock("../../state/serviceUpdate", () => ({
  useStudioServiceUpdateState: () => state.service,
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: state.addToast, update: state.updateToast, close: state.closeToast },
  stackedThreadToast: (toast: unknown) => toast,
  hiddenToastActionProps: { children: null },
}));
vi.mock("../../state/environments", () => ({ usePrimaryEnvironmentId: () => "env-1" }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../../state/entities", () => ({ useProjects: () => [] }));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../../state/server", () => ({ serverEnvironment: { prepareServiceUpdate: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.prepare }));
vi.mock("../desktopUpdate.toast", () => ({ showDesktopUpdateDownloadedToast: state.announce }));
vi.mock("../ui/spinner", () => ({ Spinner: () => null }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactElement }) => render,
  TooltipPopup: () => null,
}));

import { resetConfirmDialogForTests } from "../../confirmDialog";
import { resetServiceUpdateFlowForTests, SERVICE_HOLD_ENDED } from "../serviceUpdateFlow";
import { requestRestartToUpdate } from "./restartToUpdateRequests";
import { SidebarRestartToUpdate } from "./SidebarRestartToUpdate";

const downloaded: DesktopUpdateState = {
  enabled: true,
  status: "downloaded",
  channel: "latest",
  currentVersion: "0.2.4",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: "0.2.5",
  downloadedVersion: "0.2.5",
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: 100,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: true,
  productionBuild: true,
};

const serviceWaiting: StudioServiceUpdateState = {
  status: "waiting-for-quiet",
  identity: "m4",
  installedVersion: "0.2.4",
  availableVersion: "0.2.5",
  downloadedVersion: "0.2.5",
  checkedAt: null,
  quietSince: null,
  message: null,
  lastInstall: null,
};

const calls: string[] = [];
let installResult: Omit<DesktopUpdateActionResult, "state">;
let agent: StudioServiceUpdateState = serviceWaiting;
// The request the desktop reports pending, as the desktop this renderer ships
// with does: it stamps each request it takes and drops one cancelled. A state
// that names its own pendingInstall is reported as it is.
let pending: NonNullable<StudioServiceUpdateState["pendingInstall"]> | null = null;
const reported = (agentState: StudioServiceUpdateState): StudioServiceUpdateState => ({
  pendingInstall: pending,
  ...agentState,
});
// What a look (stopWork false) reports, and what stopping reports.
let checked: ServerPrepareServiceUpdateResult = { idle: true, stoppedThreads: 0, blockers: [] };
let prepared: ServerPrepareServiceUpdateResult = { idle: true, stoppedThreads: 0, blockers: [] };
const reload = vi.fn();

function prepareCall(input: ServerPrepareServiceUpdateInput): string {
  if (input.releaseHold) return "prepare:release";
  return `prepare:${input.stopWork}${input.hold ? "+hold" : ""}`;
}

async function installService(options?: StudioServiceInstallOptions) {
  calls.push(`installServiceUpdate:${options?.force ? "force" : "normal"}`);
  pending = {
    requestedAt: new Date().toISOString(),
    mode: options?.force ? "force" : "normal",
    version: options?.version ?? null,
    holdUntil: options?.holdUntil ?? null,
    handled: false,
  };
  return reported(agent);
}

const bridge: {
  checkForUpdate: ReturnType<typeof vi.fn>;
  downloadUpdate: ReturnType<typeof vi.fn>;
  getUpdateState: ReturnType<typeof vi.fn>;
  getServiceUpdateState: ReturnType<typeof vi.fn<() => Promise<StudioServiceUpdateState>>>;
  installUpdate: ReturnType<typeof vi.fn>;
  installServiceUpdate: ReturnType<
    typeof vi.fn<(options?: StudioServiceInstallOptions) => Promise<StudioServiceUpdateState>>
  >;
  cancelServiceUpdate?: ReturnType<typeof vi.fn<() => Promise<StudioServiceUpdateState>>>;
  getUpdatePreferences: ReturnType<typeof vi.fn>;
  ownsBundledService?: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
} = {
  checkForUpdate: vi.fn(async () => {
    if (state.feed !== null) {
      calls.push(`check:${state.feed.availableVersion}`);
      state.app = state.feed;
    }
    return { checked: true, state: state.app ?? downloaded };
  }),
  downloadUpdate: vi.fn(async () => {
    const current = state.app ?? downloaded;
    calls.push(`download:${current.availableVersion}`);
    state.app = {
      ...current,
      status: "downloaded",
      downloadedVersion: current.availableVersion,
      downloadPercent: 100,
    };
    return { accepted: true, completed: true, state: state.app };
  }),
  getUpdateState: vi.fn(async () => state.app ?? downloaded),
  getServiceUpdateState: vi.fn(async () => reported(agent)),
  installUpdate: vi.fn(async (options?: { expectedVersion?: string }) => {
    calls.push(`installUpdate:${options?.expectedVersion ?? ""}`);
    return { ...installResult, state: state.app ?? downloaded };
  }),
  installServiceUpdate: vi.fn(installService),
  cancelServiceUpdate: vi.fn(async () => {
    calls.push("cancelServiceUpdate");
    pending = null;
    return reported(agent);
  }),
  getUpdatePreferences: vi.fn(async () => ({
    checkAutomatically: true,
    downloadAutomatically: true,
    installAutomatically: true,
  })),
  ownsBundledService: vi.fn(async () => true),
};
const cancelServiceUpdate = bridge.cancelServiceUpdate!;
const ownsBundledService = bridge.ownsBundledService!;

let renderer: ReactTestRenderer | null = null;
let focused = true;
const focusListeners = new Set<() => void>();
const windowStub = {
  addEventListener: (type: string, listener: () => void) => {
    if (type === "focus") focusListeners.add(listener);
  },
  removeEventListener: (type: string, listener: () => void) => {
    if (type === "focus") focusListeners.delete(listener);
  },
};

// Mounting looks once for an update hold this window did not start; what it
// sent is kept here so the other tests see only their own calls.
let mountCalls: string[] = [];

function render() {
  act(() => {
    renderer = create(<SidebarRestartToUpdate />);
  });
  mountCalls = calls.splice(0);
}

function button() {
  return renderer?.root.findAllByType("button")[0] ?? null;
}

async function click() {
  await act(async () => {
    button()?.props.onClick();
  });
}

function label() {
  const node = button();
  if (!node) return null;
  return node.findByType("span").children.join("");
}

beforeEach(() => {
  vi.useFakeTimers();
  calls.length = 0;
  installResult = { accepted: true, completed: false, failed: false };
  state.app = downloaded;
  state.service = null;
  state.addToast.mockClear();
  state.updateToast.mockReset();
  state.closeToast.mockReset();
  state.announce.mockReset();
  state.navigate.mockReset();
  state.feed = null;
  bridge.checkForUpdate.mockClear();
  bridge.downloadUpdate.mockClear();
  agent = serviceWaiting;
  pending = null;
  checked = { idle: true, stoppedThreads: 0, blockers: [] };
  prepared = { idle: true, stoppedThreads: 0, blockers: [], held: true };
  state.prepare.mockReset();
  state.prepare.mockImplementation(async (value: { input: ServerPrepareServiceUpdateInput }) => {
    calls.push(prepareCall(value.input));
    return { _tag: "Success", value: value.input.stopWork ? prepared : checked };
  });
  reload.mockReset();
  bridge.getServiceUpdateState.mockClear();
  bridge.getServiceUpdateState.mockImplementation(async () => reported(agent));
  bridge.installUpdate.mockClear();
  bridge.installServiceUpdate.mockClear();
  bridge.installServiceUpdate.mockImplementation(installService);
  bridge.cancelServiceUpdate = cancelServiceUpdate;
  cancelServiceUpdate.mockClear();
  // The app started its own service unless a test attaches it to one.
  bridge.ownsBundledService = ownsBundledService;
  ownsBundledService.mockReset();
  ownsBundledService.mockResolvedValue(true);
  resetServiceUpdateFlowForTests();
  resetConfirmDialogForTests();
  focused = true;
  focusListeners.clear();
  Object.assign(globalThis, windowStub, { document: { hasFocus: () => focused } });
  (globalThis as { window?: unknown }).window = globalThis;
  (globalThis as { desktopBridge?: unknown }).desktopBridge = bridge;
  (globalThis as { location?: unknown }).location = { reload };
});

const FOLLOW_UP_KEY = "specwithcode.serviceUpdate.thenInstallApp";

/** A window's sessionStorage, which survives its reload. */
function useSessionStorage(): Map<string, string> {
  const store = new Map<string, string>();
  (globalThis as { sessionStorage?: unknown }).sessionStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  return store;
}

function rerender() {
  act(() => {
    renderer?.update(<SidebarRestartToUpdate />);
  });
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  resetServiceUpdateFlowForTests();
  resetConfirmDialogForTests();
  vi.useRealTimers();
  delete (globalThis as { desktopBridge?: unknown }).desktopBridge;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { location?: unknown }).location;
  delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
});

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** The newest options the persistent service-update toast was given. */
function lastToast() {
  const updates = state.updateToast.mock.calls;
  return (
    updates.length > 0 ? updates[updates.length - 1]![1] : state.addToast.mock.calls.at(-1)?.[0]
  ) as {
    type: string;
    title: string;
    description: string;
    actionProps: { children: unknown; onClick?: () => void };
    data: {
      onClose?: () => void;
      secondaryActionProps?: { children: unknown; onClick?: () => void };
    };
  };
}

const STOP_AND_INSTALL = ["prepare:false", "prepare:true+hold", "installServiceUpdate:force"];

describe("SidebarRestartToUpdate", () => {
  it("updates a service that runs an older release together with the app, before its agent has it", async () => {
    // The agent has not looked for 0.2.5 yet; the forced request makes it fetch it.
    agent = {
      ...serviceWaiting,
      status: "up-to-date",
      availableVersion: null,
      downloadedVersion: null,
    };
    state.service = agent;
    // The service holds work only for a release its agent has found.
    let stops = 0;
    state.prepare.mockImplementation(async (value: { input: ServerPrepareServiceUpdateInput }) => {
      calls.push(prepareCall(value.input));
      if (!value.input.stopWork) return { _tag: "Success", value: checked };
      stops += 1;
      return { _tag: "Success", value: { ...prepared, held: stops > 1 } };
    });
    render();
    expect(label()).toBe("Update now");
    await click();
    expect(calls).toEqual(STOP_AND_INSTALL);
    expect(bridge.installServiceUpdate.mock.calls[0]![0]).toMatchObject({
      force: true,
      version: "0.2.5",
    });
    agent = {
      ...serviceWaiting,
      status: "downloading",
      downloadedVersion: null,
      message: "Downloading SpecWithCode 0.2.5",
      updatedAt: new Date().toISOString(),
    };
    await advance(2_000);
    expect(label()).toBe("Updating…");
    // The toast says what the agent does, not that it checks for running work.
    expect(lastToast().description).toBe(
      "The SpecWithCode service on this Mac still runs 0.2.4. Downloading SpecWithCode 0.2.5",
    );
    expect(calls.filter((call) => call === "prepare:true+hold")).toHaveLength(1);
    // The agent has it now: work that started meanwhile is stopped and held once more.
    agent = {
      ...serviceWaiting,
      status: "downloaded",
      message: null,
      updatedAt: new Date().toISOString(),
    };
    await advance(2_000);
    await advance(2_000);
    expect(calls.filter((call) => call === "prepare:true+hold")).toHaveLength(2);
    agent = { ...serviceWaiting, status: "installing" };
    await advance(2_000);
    agent = { ...serviceWaiting, status: "installed", installedVersion: "0.2.5" };
    await advance(2_000);
    expect(calls.at(-1)).toBe("installUpdate:0.2.5");
  });

  it("asks the service for the newer release its agent found, then installs the app", async () => {
    // The agent found 0.2.6 but has not fetched it; the app has 0.2.5 on disk.
    agent = {
      ...serviceWaiting,
      status: "available",
      availableVersion: "0.2.6",
      downloadedVersion: null,
    };
    state.service = agent;
    render();
    expect(label()).toBe("Update now");
    await click();
    expect(calls).toEqual(STOP_AND_INSTALL);
    expect(bridge.installServiceUpdate.mock.calls[0]![0]!.version).toBe("0.2.6");
    agent = { ...serviceWaiting, status: "installed", installedVersion: "0.2.6" };
    await advance(2_000);
    expect(calls.at(-1)).toBe("installUpdate:0.2.5");
  });

  it("asks the service for the newest release the feed offers at the press", async () => {
    const store = useSessionStorage();
    state.service = serviceWaiting;
    // A newer release came out after 0.2.5 was downloaded; the agent still offers 0.2.5.
    state.feed = {
      ...downloaded,
      status: "available",
      availableVersion: "0.2.6",
      downloadedVersion: null,
    };
    render();
    await click();
    await advance(2_000);
    expect(calls).toContain("check:0.2.6");
    expect(bridge.installServiceUpdate.mock.calls.map((call) => call[0]?.version)).toEqual([
      "0.2.6",
    ]);
    // A reload installs the app once the service runs that same release.
    expect(JSON.parse(store.get(FOLLOW_UP_KEY) ?? "null")).toMatchObject({
      serviceVersion: "0.2.6",
    });
  });

  it("adds the app's install to a service update already under way", async () => {
    // Update now for the service alone, before the app had its update.
    state.app = { ...downloaded, status: "idle", availableVersion: null, downloadedVersion: null };
    state.service = serviceWaiting;
    render();
    await click();
    expect(calls).toEqual(STOP_AND_INSTALL);
    expect(label()).toBe("Updating…");
    // The app's download finishes; About's Install (or the header pill) is pressed.
    state.app = downloaded;
    rerender();
    calls.length = 0;
    let handled = false;
    await act(async () => {
      handled = requestRestartToUpdate();
    });
    expect(handled).toBe(true);
    // Nothing is stopped or asked again: the press only adds the app's install.
    expect(calls).toEqual([]);
    agent = { ...serviceWaiting, status: "installed", installedVersion: "0.2.5" };
    await advance(2_000);
    expect(calls.at(-1)).toBe("installUpdate:0.2.5");
    await advance(5_000);
    expect(reload).not.toHaveBeenCalled();
  });

  it("retries a failed service update with the app's install when the app's Install is pressed", async () => {
    state.app = { ...downloaded, status: "idle", availableVersion: null, downloadedVersion: null };
    state.service = serviceWaiting;
    render();
    await click();
    agent = { ...serviceWaiting, status: "error", message: "Did not install." };
    await advance(2_000);
    expect(label()).toBe("Retry update");
    state.app = downloaded;
    rerender();
    calls.length = 0;
    await act(async () => {
      requestRestartToUpdate();
    });
    // The retry, not the app alone: the app would relaunch while the service updates.
    expect(calls).toEqual(STOP_AND_INSTALL);
    agent = { ...serviceWaiting, status: "installed", installedVersion: "0.2.5" };
    await advance(2_000);
    expect(calls.at(-1)).toBe("installUpdate:0.2.5");
  });

  it("says why the app's install cannot be added once the service is restarting", async () => {
    state.app = { ...downloaded, status: "idle", availableVersion: null, downloadedVersion: null };
    state.service = serviceWaiting;
    render();
    await click();
    agent = { ...serviceWaiting, status: "installed", installedVersion: "0.2.5" };
    await advance(2_000);
    expect(label()).toBe("Restarting…");
    state.app = { ...downloaded, availableVersion: "0.2.6", downloadedVersion: "0.2.6" };
    rerender();
    await act(async () => {
      requestRestartToUpdate();
    });
    expect(state.addToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "info", title: "The service update is finishing" }),
    );
  });

  it("ends the update when the app accepts its install but stays open", async () => {
    state.service = serviceWaiting;
    render();
    await click();
    agent = { ...serviceWaiting, status: "installed", installedVersion: "0.2.5" };
    await advance(2_000);
    expect(calls.at(-1)).toBe("installUpdate:0.2.5");
    expect(label()).toBe("Restarting…");
    await advance(DESKTOP_INSTALL_APPLY_MS);
    expect(state.addToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "SpecWithCode did not restart" }),
    );
    // The update ends with it: the button works again and nothing is followed.
    expect(state.closeToast).toHaveBeenCalledWith("toast-1");
    state.service = agent;
    rerender();
    expect(label()).toBe("Restart to update");
    expect(button()?.props.disabled).toBe(false);
    calls.length = 0;
    bridge.getServiceUpdateState.mockClear();
    await advance(30_000);
    expect(calls).toEqual([]);
    expect(bridge.getServiceUpdateState).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("says so when the hold runs out before the work finished, and keeps the app's install", async () => {
    agent = { ...serviceWaiting, updatedAt: new Date(Date.now() + 1_000).toISOString() };
    state.service = serviceWaiting;
    render();
    await click();
    expect(label()).toBe("Updating…");
    await advance(15 * 60_000);
    // The service let its hold go: no cancel elsewhere, the time ran out.
    checked = { idle: true, stoppedThreads: 0, blockers: [], held: false };
    await advance(12_000);
    expect(lastToast()).toMatchObject({
      type: "error",
      title: "Could not install SpecWithCode 0.2.5",
      description: SERVICE_HOLD_ENDED,
      actionProps: { children: "Try again" },
    });
    expect(label()).toBe("Retry update");
    checked = { idle: true, stoppedThreads: 0, blockers: [], held: true };
    calls.length = 0;
    await click();
    expect(calls).toEqual(STOP_AND_INSTALL);
    agent = { ...serviceWaiting, status: "installed", installedVersion: "0.2.5" };
    await advance(2_000);
    expect(calls.at(-1)).toBe("installUpdate:0.2.5");
  });

  describe("service only", () => {
    beforeEach(() => {
      state.app = null;
      agent = { ...serviceWaiting, status: "downloaded" };
      state.service = agent;
    });

    it("fails when the agent answers that it has nothing to install", async () => {
      render();
      await click();
      agent = {
        ...serviceWaiting,
        status: "up-to-date",
        availableVersion: null,
        downloadedVersion: null,
        updatedAt: new Date(Date.now() + 1_000).toISOString(),
        pendingInstall: null,
      };
      await advance(2_000);
      expect(lastToast()).toMatchObject({
        type: "error",
        description: "SpecWithCode 0.2.5 is not available to the service on this Mac yet.",
      });
      expect(label()).toBe("Retry update");
      // Work may start again at once.
      expect(calls.at(-1)).toBe("prepare:release");
    });

    it("keeps the app's install across a reload after a retry for a newer version", async () => {
      const store = useSessionStorage();
      state.app = downloaded;
      render();
      await click();
      expect(JSON.parse(store.get(FOLLOW_UP_KEY)!)).toMatchObject({ serviceVersion: "0.2.5" });
      agent = {
        ...serviceWaiting,
        status: "error",
        availableVersion: "0.2.6",
        downloadedVersion: null,
        message:
          "SpecWithCode 0.2.5 was asked for, but 0.2.6 is the update now available; choose Update now again to install it.",
      };
      await advance(2_000);
      await advance(60_000);
      await click();
      expect(bridge.installServiceUpdate.mock.calls.at(-1)![0]!.version).toBe("0.2.6");
      // Saved anew for the version now asked for, with a fresh time.
      const saved = JSON.parse(store.get(FOLLOW_UP_KEY)!) as { serviceVersion: string; at: number };
      expect(saved).toMatchObject({ appVersion: "0.2.5", serviceVersion: "0.2.6" });
      expect(Date.now() - saved.at).toBeLessThan(1_000);
    });
  });

  describe("an update hold this window did not start", () => {
    beforeEach(() => {
      state.app = null;
      agent = { ...serviceWaiting, updatedAt: new Date(Date.now() - 60_000).toISOString() };
      state.service = agent;
      checked = { idle: true, stoppedThreads: 0, blockers: [], held: true };
    });

    it("still installs the app after a reload when the service holds nothing any more", async () => {
      const store = useSessionStorage();
      store.set(
        FOLLOW_UP_KEY,
        JSON.stringify({ appVersion: "0.2.5", serviceVersion: "0.2.5", at: Date.now() - 60_000 }),
      );
      state.app = downloaded;
      // The install gate lifted, so the service answers that nothing is held.
      checked = { idle: true, stoppedThreads: 0, blockers: [], held: false };
      agent = { ...serviceWaiting, status: "installing", updatedAt: new Date().toISOString() };
      state.service = agent;
      render();
      await advance(0);
      expect(label()).toBe("Installing…");
      agent = { ...serviceWaiting, status: "installed", installedVersion: "0.2.5" };
      await advance(2_000);
      expect(calls.at(-1)).toBe("installUpdate:0.2.5");
      await advance(5_000);
      expect(reload).not.toHaveBeenCalled();
    });

    /** The window reloads `ago` after the press for both, while the agent installs 0.2.5. */
    async function reloadDuringInstall(ago: number) {
      const store = useSessionStorage();
      store.set(
        FOLLOW_UP_KEY,
        JSON.stringify({ appVersion: "0.2.5", serviceVersion: "0.2.5", at: Date.now() - ago }),
      );
      state.app = downloaded;
      checked = { idle: true, stoppedThreads: 0, blockers: [], held: false };
      agent = { ...serviceWaiting, status: "installing", updatedAt: new Date().toISOString() };
      state.service = agent;
      render();
      await advance(0);
      expect(label()).toBe("Installing…");
      agent = { ...serviceWaiting, status: "installed", installedVersion: "0.2.5" };
      await advance(2_000);
      await advance(5_000);
    }

    it("installs the app after a reload six minutes after the press", async () => {
      await reloadDuringInstall(6 * 60_000);
      expect(calls).toContain("installUpdate:0.2.5");
    });

    it("installs the app after a reload 44 minutes after the press", async () => {
      await reloadDuringInstall(44 * 60_000);
      expect(calls).toContain("installUpdate:0.2.5");
    });

    it("installs nothing after a reload once the press is over 45 minutes old", async () => {
      // An install the agent runs on its own then is not that press's.
      await reloadDuringInstall(50 * 60_000);
      expect(calls).not.toContain("installUpdate:0.2.5");
    });

    it("looks again when the service did not answer after a reload, and still installs the app", async () => {
      const store = useSessionStorage();
      store.set(
        FOLLOW_UP_KEY,
        JSON.stringify({ appVersion: "0.2.5", serviceVersion: "0.2.5", at: Date.now() - 60_000 }),
      );
      state.app = downloaded;
      agent = { ...serviceWaiting, status: "installing", updatedAt: new Date().toISOString() };
      state.service = agent;
      // The helper is restarting the service: it cannot answer yet.
      let answering = false;
      state.prepare.mockImplementation(
        async (value: { input: ServerPrepareServiceUpdateInput }) => {
          calls.push(prepareCall(value.input));
          if (!answering) return { _tag: "Failure" };
          return { _tag: "Success", value: { ...checked, held: false } };
        },
      );
      render();
      await advance(0);
      expect(mountCalls).toEqual(["prepare:false"]);
      expect(label()).toBe("Restart to update");
      // No new state is published while the helper runs: the window looks again on its own.
      answering = true;
      await advance(5_000);
      expect(label()).toBe("Installing…");
      agent = { ...serviceWaiting, status: "installed", installedVersion: "0.2.5" };
      await advance(2_000);
      expect(calls.at(-1)).toBe("installUpdate:0.2.5");
      expect(reload).not.toHaveBeenCalled();
    });

    it("installs the app after a reload that missed the end of the service update", async () => {
      const store = useSessionStorage();
      const pressedAt = Date.now() - 120_000;
      store.set(
        FOLLOW_UP_KEY,
        JSON.stringify({ appVersion: "0.2.5", serviceVersion: "0.2.5", at: pressedAt }),
      );
      state.app = downloaded;
      checked = { idle: true, stoppedThreads: 0, blockers: [], held: false };
      agent = {
        ...serviceWaiting,
        status: "installed",
        installedVersion: "0.2.5",
        lastInstall: {
          version: "0.2.5",
          at: new Date(pressedAt + 60_000).toISOString(),
          result: "updated",
        },
      };
      state.service = agent;
      render();
      await advance(0);
      expect(calls.at(-1)).toBe("installUpdate:0.2.5");
      expect(lastToast()).toMatchObject({
        type: "success",
        title: "Updated the service to SpecWithCode 0.2.5",
      });
      await advance(5_000);
      expect(reload).not.toHaveBeenCalled();
    });

    it("leaves an install that finished before the press alone after a reload", async () => {
      const store = useSessionStorage();
      const pressedAt = Date.now() - 60_000;
      store.set(
        FOLLOW_UP_KEY,
        JSON.stringify({ appVersion: "0.2.5", serviceVersion: "0.2.5", at: pressedAt }),
      );
      state.app = downloaded;
      checked = { idle: true, stoppedThreads: 0, blockers: [], held: false };
      agent = {
        ...serviceWaiting,
        status: "installed",
        installedVersion: "0.2.5",
        lastInstall: {
          version: "0.2.5",
          at: new Date(pressedAt - 60_000).toISOString(),
          result: "updated",
        },
      };
      state.service = agent;
      render();
      await advance(0);
      expect(calls).not.toContain("installUpdate:0.2.5");
      expect(label()).toBe("Restart to update");
    });
  });
});
