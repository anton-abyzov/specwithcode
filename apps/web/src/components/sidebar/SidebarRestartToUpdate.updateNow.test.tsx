import type {
  DesktopUpdateActionResult,
  DesktopUpdateState,
  ServerPrepareServiceUpdateInput,
  ServerPrepareServiceUpdateResult,
  ServiceUpdateBlocker,
  StudioServiceInstallOptions,
  StudioServiceUpdateState,
} from "@specweave-studio/contracts";
import type { ReactElement, ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// "Update now" for the service and the app in one press, end to end through
// the sidebar button, its toast and the requests from About and the header pill.

const state = vi.hoisted(() => ({
  app: null as DesktopUpdateState | null,
  service: null as StudioServiceUpdateState | null,
  addToast: vi.fn((_toast: unknown) => "toast-1"),
  updateToast: vi.fn(),
  closeToast: vi.fn(),
  prepare: vi.fn(),
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
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../state/entities", () => ({ useProjects: () => [] }));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../../state/server", () => ({ serverEnvironment: { prepareServiceUpdate: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.prepare }));
vi.mock("../desktopUpdate.toast", () => ({ showDesktopUpdateDownloadedToast: vi.fn() }));
vi.mock("../ui/spinner", () => ({ Spinner: () => null }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactElement }) => render,
  TooltipPopup: () => null,
}));

import {
  completeConfirmDialogClose,
  readConfirmDialogState,
  registerConfirmDialogHost,
  resetConfirmDialogForTests,
  respondToConfirmDialog,
} from "../../confirmDialog";
import {
  resetServiceUpdateFlowForTests,
  SERVICE_HOLD_ENDED,
  useServiceUpdateFlow,
} from "../serviceUpdateFlow";
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

const FOLLOW_UP_KEY = "specwithcode.serviceUpdate.thenInstallApp";
const STOP_AND_INSTALL = ["prepare:false", "prepare:true+hold", "installServiceUpdate:force"];
// What the app's own restart sends: a look, a drain of the service it started, the install.
const APP_ONLY = ["prepare:false", "prepare:true+hold:app-restart", "installUpdate:0.2.5"];
const NOT_AVAILABLE = "SpecWithCode 0.2.5 is not available to the service on this Mac yet.";

const RUNNING: ServerPrepareServiceUpdateResult = {
  idle: false,
  stoppedThreads: 0,
  blockers: [
    {
      kind: "run",
      count: 1,
      threadId: "thread-1",
      threadTitle: "Fix login",
      projectId: "project-1",
      projectTitle: "EasyChamp",
    } as unknown as ServiceUpdateBlocker,
  ],
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
// What a look (stopWork false) reports, and what stopping reports.
let checked: ServerPrepareServiceUpdateResult = { idle: true, stoppedThreads: 0, blockers: [] };
let prepared: ServerPrepareServiceUpdateResult = { idle: true, stoppedThreads: 0, blockers: [] };
const reload = vi.fn();

// A drain before an app restart is told apart from the service's own stop.
function prepareCall(input: ServerPrepareServiceUpdateInput): string {
  if (input.releaseHold) return "prepare:release";
  const reason = input.reason === "app-restart" ? ":app-restart" : "";
  return `prepare:${input.stopWork}${input.hold ? `+hold${reason}` : ""}`;
}

function answerPrepare(held: (input: ServerPrepareServiceUpdateInput) => boolean | undefined) {
  state.prepare.mockImplementation(async (value: { input: ServerPrepareServiceUpdateInput }) => {
    calls.push(prepareCall(value.input));
    if (!value.input.stopWork) return { _tag: "Success", value: checked };
    return { _tag: "Success", value: { ...prepared, held: held(value.input) } };
  });
}

const bridge = {
  checkForUpdate: vi.fn(async () => ({ checked: true, state: state.app ?? downloaded })),
  downloadUpdate: vi.fn(async () => ({
    accepted: true,
    completed: true,
    state: state.app ?? downloaded,
  })),
  getUpdateState: vi.fn(async () => state.app ?? downloaded),
  getServiceUpdateState: vi.fn<() => Promise<StudioServiceUpdateState>>(async () =>
    reported(agent),
  ),
  installUpdate: vi.fn(async (options?: { expectedVersion?: string }) => {
    calls.push(`installUpdate:${options?.expectedVersion ?? ""}`);
    return { ...installResult, state: state.app ?? downloaded };
  }),
  installServiceUpdate: vi.fn<(options?: StudioServiceInstallOptions) => Promise<unknown>>(),
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

let renderer: ReactTestRenderer | null = null;
let mountCalls: string[] = [];

function render() {
  act(() => {
    renderer = create(<SidebarRestartToUpdate />);
  });
  mountCalls = calls.splice(0);
}

function rerender() {
  act(() => {
    renderer?.update(<SidebarRestartToUpdate />);
  });
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
  return node ? node.findByType("span").children.join("") : null;
}

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
    description: string;
    actionProps: { children: unknown; onClick?: () => void };
  };
}

async function pressTryAgain() {
  expect(lastToast().actionProps.children).toBe("Try again");
  await act(async () => {
    lastToast().actionProps.onClick?.();
  });
}

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

/** The window reloads: its flow starts over, its sessionStorage stays. */
function reloadWindow(store: Map<string, string>) {
  const kept = new Map(store);
  act(() => renderer?.unmount());
  renderer = null;
  resetServiceUpdateFlowForTests();
  for (const [key, value] of kept) store.set(key, value);
  calls.length = 0;
}

/** Update now for the service and the app, then the hold runs out before the install began. */
async function failAfterHoldRanOut() {
  agent = { ...serviceWaiting, updatedAt: new Date(Date.now() + 1_000).toISOString() };
  state.service = serviceWaiting;
  render();
  await click();
  expect(calls).toEqual(STOP_AND_INSTALL);
  await advance(15 * 60_000);
  checked = { ...checked, held: false };
  await advance(12_000);
  expect(lastToast().description).toBe(SERVICE_HOLD_ENDED);
  expect(label()).toBe("Retry update");
}

/** Update now for both, and the service's agent does not have 0.2.5 yet. */
async function failAsNotAvailable() {
  agent = {
    ...serviceWaiting,
    status: "up-to-date",
    availableVersion: null,
    downloadedVersion: null,
  };
  state.service = agent;
  render();
  await click();
  expect(calls).toEqual(STOP_AND_INSTALL);
  // The agent ran for the request: the desktop reports none pending any more.
  agent = { ...agent, updatedAt: new Date(Date.now() + 1_000).toISOString(), pendingInstall: null };
  await advance(2_000);
  expect(lastToast().description).toBe(NOT_AVAILABLE);
  // Asking the service again would fail the same way: the button restarts the app alone.
  expect(label()).toBe("Restart to update");
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
  agent = serviceWaiting;
  pending = null;
  checked = { idle: true, stoppedThreads: 0, blockers: [] };
  prepared = { idle: true, stoppedThreads: 0, blockers: [], held: true };
  state.prepare.mockReset();
  answerPrepare(() => true);
  reload.mockReset();
  bridge.getServiceUpdateState.mockReset();
  bridge.getServiceUpdateState.mockImplementation(async () => reported(agent));
  bridge.installUpdate.mockClear();
  bridge.installServiceUpdate.mockReset();
  bridge.installServiceUpdate.mockImplementation(installService);
  bridge.cancelServiceUpdate.mockClear();
  bridge.ownsBundledService.mockClear();
  resetServiceUpdateFlowForTests();
  resetConfirmDialogForTests();
  Object.assign(globalThis, {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    document: { hasFocus: () => true },
  });
  (globalThis as { window?: unknown }).window = globalThis;
  (globalThis as { desktopBridge?: unknown }).desktopBridge = bridge;
  (globalThis as { location?: unknown }).location = { reload };
});

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

describe("Update now for the service and the app", () => {
  describe("a failed attempt", () => {
    it("leaves no app install for a reload to find, so the agent's own install quits nothing", async () => {
      const store = useSessionStorage();
      agent = { ...serviceWaiting, updatedAt: new Date(Date.now() + 1_000).toISOString() };
      state.service = serviceWaiting;
      render();
      await click();
      expect(JSON.parse(store.get(FOLLOW_UP_KEY)!)).toMatchObject({ serviceVersion: "0.2.5" });
      await advance(15 * 60_000);
      checked = { ...checked, held: false };
      await advance(12_000);
      expect(lastToast().description).toBe(SERVICE_HOLD_ENDED);
      expect(store.has(FOLLOW_UP_KEY)).toBe(false);
      // The window reloads, then the agent installs 0.2.5 at a quiet moment of its own.
      reloadWindow(store);
      agent = { ...serviceWaiting, status: "installing", updatedAt: new Date().toISOString() };
      state.service = agent;
      render();
      await advance(0);
      expect(label()).toBe("Installing…");
      agent = { ...serviceWaiting, status: "installed", installedVersion: "0.2.5" };
      await advance(2_000);
      await advance(5_000);
      expect(calls).not.toContain("installUpdate:0.2.5");
    });

    it("follows the install the agent starts on its own instead of offering a retry", async () => {
      await failAfterHoldRanOut();
      agent = { ...serviceWaiting, status: "installing", updatedAt: new Date().toISOString() };
      state.service = agent;
      rerender();
      await advance(0);
      expect(label()).toBe("Installing…");
      agent = { ...serviceWaiting, status: "installed", installedVersion: "0.2.5" };
      await advance(2_000);
      await advance(1_500);
      // Nothing installs the app without a press: the window reloads into the new service.
      expect(calls).not.toContain("installUpdate:0.2.5");
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it("offers the app's own restart once the service runs the version on its own", async () => {
      await failAfterHoldRanOut();
      agent = {
        ...serviceWaiting,
        status: "up-to-date",
        installedVersion: "0.2.5",
        availableVersion: null,
        downloadedVersion: null,
        updatedAt: new Date().toISOString(),
      };
      state.service = agent;
      rerender();
      await advance(0);
      expect(state.closeToast).toHaveBeenCalledWith("toast-1");
      expect(label()).toBe("Restart to update");
      calls.length = 0;
      await click();
      expect(calls).toEqual(APP_ONLY);
    });

    it("installs only the app when the service already runs the version a retry asks for", async () => {
      await failAfterHoldRanOut();
      // The agent installed 0.2.5 on its own and then reported an error: the failure stays.
      state.service = {
        ...serviceWaiting,
        status: "error",
        installedVersion: "0.2.5",
        message: "Could not remove the previous release.",
        updatedAt: new Date().toISOString(),
      };
      rerender();
      await advance(0);
      expect(label()).toBe("Retry update");
      calls.length = 0;
      await click();
      await advance(0);
      // Nothing is stopped for the service or asked of its agent.
      expect(calls).toEqual(APP_ONLY);
    });

    it("ends when the service already runs the version a retry asks for and nothing else is left", async () => {
      state.app = null;
      agent = { ...serviceWaiting, status: "downloaded" };
      state.service = agent;
      render();
      await click();
      agent = { ...serviceWaiting, status: "error", message: "Did not install." };
      await advance(2_000);
      expect(label()).toBe("Retry update");
      state.service = {
        ...serviceWaiting,
        status: "error",
        installedVersion: "0.2.5",
        message: "Could not remove the previous release.",
        updatedAt: new Date().toISOString(),
      };
      rerender();
      calls.length = 0;
      await pressTryAgain();
      expect(calls).toEqual([]);
      expect(state.closeToast).toHaveBeenCalledWith("toast-1");
    });

    it("installs the app on its own from About when the service's agent lacks the release", async () => {
      await failAsNotAvailable();
      calls.length = 0;
      state.closeToast.mockClear();
      let handled = false;
      await act(async () => {
        handled = requestRestartToUpdate();
      });
      await advance(0);
      expect(handled).toBe(true);
      // Asking the service again would fail the same way.
      expect(calls).toEqual(APP_ONLY);
      expect(bridge.installServiceUpdate).toHaveBeenCalledTimes(1);
      // The failed service update is over: its notice closes.
      expect(state.closeToast).toHaveBeenCalledWith("toast-1");
    });

    it("asks the service again from About once a retry fails for another reason", async () => {
      await failAsNotAvailable();
      // The retry's request cannot be written: its agent may well have the release now.
      bridge.installServiceUpdate.mockImplementationOnce(async () => {
        calls.push("installServiceUpdate:force");
        throw new Error("The update agent could not be started.");
      });
      await pressTryAgain();
      expect(lastToast().description).toBe("The update agent could not be started.");
      calls.length = 0;
      await act(async () => {
        requestRestartToUpdate();
      });
      await advance(0);
      expect(calls).toEqual(STOP_AND_INSTALL);
    });

    it("installs only the app from the toast's Try again when the service already runs the version", async () => {
      await failAfterHoldRanOut();
      state.service = {
        ...serviceWaiting,
        status: "error",
        installedVersion: "0.2.5",
        message: "Could not remove the previous release.",
        updatedAt: new Date().toISOString(),
      };
      rerender();
      await advance(0);
      calls.length = 0;
      // Try again carries no app install of its own: the press before it asked for one.
      await pressTryAgain();
      await advance(0);
      expect(calls).toEqual(APP_ONLY);
    });

    it("installs only the app from Try again once the sidebar that registered first is gone", async () => {
      await failAfterHoldRanOut();
      state.service = {
        ...serviceWaiting,
        status: "error",
        installedVersion: "0.2.5",
        message: "Could not remove the previous release.",
        updatedAt: new Date().toISOString(),
      };
      rerender();
      await advance(0);
      // Another sidebar mounts, then the first one unmounts.
      const first = renderer;
      render();
      act(() => first?.unmount());
      calls.length = 0;
      await pressTryAgain();
      await advance(0);
      expect(calls).toEqual(APP_ONLY);
    });

    it("keeps the failure when a state older than the agent's answer still says installing", async () => {
      state.app = null;
      agent = { ...serviceWaiting, status: "downloaded" };
      state.service = agent;
      render();
      await click();
      const installingAt = new Date(Date.now() + 500).toISOString();
      agent = { ...serviceWaiting, status: "installing", updatedAt: installingAt };
      await advance(2_000);
      expect(label()).toBe("Installing…");
      agent = {
        ...serviceWaiting,
        status: "error",
        message: "Did not install.",
        updatedAt: new Date(Date.now() + 1_000).toISOString(),
      };
      await advance(2_000);
      expect(label()).toBe("Retry update");
      // The state published to this window lags behind the agent's own answer.
      state.service = { ...serviceWaiting, status: "installing", updatedAt: installingAt };
      rerender();
      await advance(0);
      expect(label()).toBe("Retry update");
      expect(lastToast().description).toBe("Did not install.");
    });

    it("keeps the failure of an install that ran too long while the agent still says installing", async () => {
      state.app = null;
      agent = { ...serviceWaiting, status: "downloaded" };
      state.service = agent;
      render();
      await click();
      agent = {
        ...serviceWaiting,
        status: "installing",
        updatedAt: new Date(Date.now() + 500).toISOString(),
      };
      await advance(2_000);
      expect(label()).toBe("Installing…");
      await advance(45 * 60_000);
      expect(lastToast().description).toBe(
        "The install has not finished after 45 minutes. See Settings > About for the receipt.",
      );
      // The same install, published again: not one the agent started on its own.
      state.service = { ...agent, updatedAt: new Date().toISOString() };
      rerender();
      await advance(0);
      expect(label()).toBe("Retry update");
      // Nor is it over once the service runs 0.2.5 while the agent still installs:
      // the failure stays, and nothing is looked at afresh.
      calls.length = 0;
      state.closeToast.mockClear();
      state.service = { ...agent, installedVersion: "0.2.5", updatedAt: new Date().toISOString() };
      rerender();
      await advance(5_000);
      expect(label()).toBe("Retry update");
      expect(state.closeToast).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
    });

    it("waits for running work like the app's own restart, then installs only the app", async () => {
      registerConfirmDialogHost();
      await failAsNotAvailable();
      checked = RUNNING;
      calls.length = 0;
      await act(async () => {
        requestRestartToUpdate();
      });
      await advance(0);
      expect(readConfirmDialogState()).toMatchObject({
        status: "confirming",
        confirmLabel: "Restart when idle",
      });
      await act(async () => {
        respondToConfirmDialog(true);
      });
      expect(label()).toMatch(/^Restarts when idle, or in 2:0\d$/);
      checked = { idle: true, stoppedThreads: 0, blockers: [] };
      await advance(15_000);
      expect(calls).toEqual(["prepare:false", ...APP_ONLY]);
    });

    it("restarts only the app when pressed while it waits for running work", async () => {
      registerConfirmDialogHost();
      await failAsNotAvailable();
      checked = RUNNING;
      calls.length = 0;
      await act(async () => {
        requestRestartToUpdate();
      });
      await advance(0);
      await act(async () => {
        respondToConfirmDialog(true);
        completeConfirmDialogClose();
      });
      await click();
      expect(readConfirmDialogState()).toMatchObject({ status: "confirming" });
      await act(async () => {
        respondToConfirmDialog("alternate");
      });
      expect(calls).toEqual(["prepare:false", ...APP_ONLY]);
    });

    it("follows the agent's own install after it failed in a window that took over a hold", async () => {
      state.app = null;
      agent = { ...serviceWaiting, updatedAt: new Date(Date.now() - 60_000).toISOString() };
      state.service = agent;
      checked = { ...checked, held: true };
      render();
      await advance(0);
      expect(label()).toBe("Update now");
      await click();
      expect(calls.at(-1)).toBe("installServiceUpdate:force");
      agent = {
        ...serviceWaiting,
        status: "error",
        message: "Did not install.",
        updatedAt: new Date().toISOString(),
      };
      await advance(2_000);
      expect(label()).toBe("Retry update");
      checked = { ...checked, held: false };
      agent = { ...serviceWaiting, status: "installing", updatedAt: new Date().toISOString() };
      state.service = agent;
      rerender();
      await advance(0);
      expect(label()).toBe("Installing…");
    });

    it("still asks the service from the toast's Try again when its agent lacked the release", async () => {
      await failAsNotAvailable();
      calls.length = 0;
      await pressTryAgain();
      expect(calls).toEqual(STOP_AND_INSTALL);
    });

    it("keeps the app's install when the hold ran out and the toast's Try again is chosen", async () => {
      await failAfterHoldRanOut();
      checked = { ...checked, held: true };
      calls.length = 0;
      await pressTryAgain();
      expect(calls).toEqual(STOP_AND_INSTALL);
      agent = { ...serviceWaiting, status: "installed", installedVersion: "0.2.5" };
      await advance(2_000);
      expect(calls.at(-1)).toBe("installUpdate:0.2.5");
    });

    it("saves the app's install anew when the toast's Try again asks for a newer version", async () => {
      const store = useSessionStorage();
      agent = { ...serviceWaiting, status: "downloaded" };
      state.service = agent;
      render();
      await click();
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
      await pressTryAgain();
      expect(bridge.installServiceUpdate.mock.calls.at(-1)![0]!.version).toBe("0.2.6");
      const saved = JSON.parse(store.get(FOLLOW_UP_KEY)!) as { serviceVersion: string; at: number };
      expect(saved).toMatchObject({ appVersion: "0.2.5", serviceVersion: "0.2.6" });
      expect(Date.now() - saved.at).toBeLessThan(1_000);
    });
  });

  describe("a retry after a failure the window withdrew", () => {
    /** Closes the service update's toast with its X. */
    async function closeToastWithX() {
      const options = lastToast() as unknown as { data?: { onClose?: () => void } };
      expect(typeof options.data?.onClose).toBe("function");
      await act(async () => {
        options.data!.onClose!();
      });
    }

    /** Update now; the agent fails the request, so the window withdraws it and lets the work go. */
    async function failOnce() {
      state.service = serviceWaiting;
      render();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      agent = {
        ...serviceWaiting,
        status: "error",
        message: "Did not install.",
        updatedAt: new Date(Date.now() + 1_000).toISOString(),
      };
      await advance(2_000);
      expect(label()).toBe("Retry update");
      expect(calls.slice(-2)).toEqual(["cancelServiceUpdate", "prepare:release"]);
    }

    /** The retry's install never finishes, and its failure's toast is closed. */
    async function retryTimesOutAndIsClosed() {
      agent = {
        ...serviceWaiting,
        status: "installing",
        updatedAt: new Date(Date.now() + 500).toISOString(),
      };
      await advance(2_000);
      expect(label()).toBe("Installing…");
      await advance(45 * 60_000);
      expect(lastToast().description).toContain("has not finished after 45 minutes");
      calls.length = 0;
      await closeToastWithX();
      await advance(0);
    }

    it("withdraws the retry's request when its timed-out install is closed", async () => {
      await failOnce();
      calls.length = 0;
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      await retryTimesOutAndIsClosed();
      // The install may still run, so the work stays held for it.
      expect(calls).toEqual(["cancelServiceUpdate"]);
    });

    it("withdraws it too when the failure's release answers only after the retry began", async () => {
      let answerRelease: () => void = () => undefined;
      state.prepare.mockImplementation(
        async (value: { input: ServerPrepareServiceUpdateInput }) => {
          calls.push(prepareCall(value.input));
          if (value.input.releaseHold) {
            await new Promise<void>((resolve) => (answerRelease = resolve));
            return { _tag: "Success", value: { ...checked, held: false } };
          }
          return { _tag: "Success", value: value.input.stopWork ? prepared : checked };
        },
      );
      await failOnce();
      calls.length = 0;
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      await act(async () => answerRelease());
      await advance(0);
      await retryTimesOutAndIsClosed();
      expect(calls).toEqual(["cancelServiceUpdate"]);
    });
  });

  describe("a service whose agent had not found the release", () => {
    beforeEach(() => {
      agent = {
        ...serviceWaiting,
        status: "up-to-date",
        availableVersion: null,
        downloadedVersion: null,
      };
      state.service = agent;
    });

    it("writes the request again once the service holds the work for it", async () => {
      // The service holds work only for a release its agent has found.
      let stops = 0;
      answerPrepare(() => {
        stops += 1;
        return stops > 1;
      });
      const sentAt: number[] = [];
      bridge.installServiceUpdate.mockImplementation(async (options) => {
        sentAt.push(Date.now());
        return installService(options);
      });
      render();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      await advance(2_000);
      agent = { ...serviceWaiting, status: "downloaded", updatedAt: new Date().toISOString() };
      await advance(2_000);
      await advance(2_000);
      // Held now, after the first request: the helpers act only on a request written inside the hold.
      expect(calls).toEqual([
        ...STOP_AND_INSTALL,
        "prepare:true+hold",
        "installServiceUpdate:force",
      ]);
      expect(sentAt[1]).toBeGreaterThan(sentAt[0]!);
      // The same request: version, force and hold end stay as they were.
      expect(bridge.installServiceUpdate.mock.calls[1]![0]).toEqual(
        bridge.installServiceUpdate.mock.calls[0]![0],
      );
    });

    it("asks to hold the work again only once when the service still refuses", async () => {
      answerPrepare(() => false);
      render();
      await click();
      agent = { ...serviceWaiting, status: "downloaded", updatedAt: new Date().toISOString() };
      for (let step = 0; step < 4; step += 1) await advance(2_000);
      expect(calls.filter((call) => call === "prepare:true+hold")).toHaveLength(2);
      expect(calls.filter((call) => call === "installServiceUpdate:force")).toHaveLength(1);
    });
  });

  describe("an older agent that has gone quiet", () => {
    it("is not asked again while the request before is still being taken", async () => {
      state.service = serviceWaiting;
      render();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      // The desktop is still running the agent for the next request.
      bridge.installServiceUpdate.mockImplementation((options) => {
        calls.push(`installServiceUpdate:${options?.force ? "force" : "normal"}`);
        return new Promise(() => undefined);
      });
      const requests = () => calls.filter((call) => call === "installServiceUpdate:force");
      await advance(32_000);
      expect(requests()).toHaveLength(2);
      // Well past another quiet 30 seconds, that request is still being taken.
      await advance(50_000);
      expect(requests()).toHaveLength(2);
    });

    it("is not asked again while the held work still winds down", async () => {
      state.service = serviceWaiting;
      render();
      const pressedAt = Date.now();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      // The agent answered once and went quiet; a task still finishes under the hold.
      agent = {
        ...serviceWaiting,
        updatedAt: new Date(pressedAt + 500).toISOString(),
        pendingInstall: {
          requestedAt: new Date(pressedAt).toISOString(),
          mode: "force",
          version: "0.2.5",
          holdUntil: new Date(pressedAt + 15 * 60_000).toISOString(),
          handled: false,
        },
      };
      checked = { ...RUNNING, held: true };
      calls.length = 0;
      await advance(90_000);
      expect(
        calls.filter(
          (call) => call.startsWith("prepare:true") || call.startsWith("installServiceUpdate"),
        ),
      ).toEqual([]);
      expect(label()).toBe("Updating…");
    });
  });

  describe("the version a press asks the service for", () => {
    it("is the release the app found when nothing is downloaded yet", async () => {
      state.app = {
        ...downloaded,
        status: "available",
        currentVersion: "0.2.5",
        availableVersion: "0.2.6",
        downloadedVersion: null,
        downloadPercent: null,
      };
      agent = {
        ...serviceWaiting,
        status: "up-to-date",
        availableVersion: null,
        downloadedVersion: null,
      };
      state.service = agent;
      render();
      expect(label()).toBe("Update now");
      await click();
      expect(bridge.installServiceUpdate.mock.calls[0]![0]!.version).toBe("0.2.6");
    });

    it("is never a development app's own version", async () => {
      state.app = {
        ...downloaded,
        enabled: false,
        status: "disabled",
        currentVersion: "0.2.6",
        availableVersion: null,
        downloadedVersion: null,
        downloadPercent: null,
        productionBuild: false,
      };
      agent = { ...serviceWaiting, status: "downloaded" };
      state.service = agent;
      render();
      expect(label()).toBe("Update now");
      await click();
      expect(bridge.installServiceUpdate.mock.calls[0]![0]!.version).toBe("0.2.5");
    });

    it("is the release the app already runs when the service is behind it", async () => {
      // The app updated to 0.2.6 on its own; the service runs 0.2.4 and its agent has 0.2.5.
      state.app = {
        ...downloaded,
        status: "up-to-date",
        currentVersion: "0.2.6",
        availableVersion: null,
        downloadedVersion: null,
        downloadPercent: null,
      };
      agent = { ...serviceWaiting, status: "downloaded" };
      state.service = agent;
      render();
      expect(label()).toBe("Update now");
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      expect(bridge.installServiceUpdate.mock.calls[0]![0]!.version).toBe("0.2.6");
    });
  });

  it("says it looks for a newer app release when the app's download was replaced as the service updated", async () => {
    state.service = serviceWaiting;
    render();
    await click();
    // A newer release replaced the download: the app looks for it, and that look takes a while.
    installResult = { accepted: false, completed: false, reason: "no-download" };
    bridge.checkForUpdate.mockImplementationOnce(() => new Promise(() => undefined));
    agent = { ...serviceWaiting, status: "installed", installedVersion: "0.2.5" };
    await advance(2_000);
    expect(calls.at(-1)).toBe("installUpdate:0.2.5");
    expect(bridge.checkForUpdate).toHaveBeenCalled();
    expect(label()).toBe("Checking for a newer version…");
  });

  it("says nothing more when the app's install already follows the restarting service", async () => {
    state.service = serviceWaiting;
    render();
    await click();
    agent = { ...serviceWaiting, status: "installed", installedVersion: "0.2.5" };
    await advance(2_000);
    expect(calls.at(-1)).toBe("installUpdate:0.2.5");
    expect(label()).toBe("Restarting…");
    state.addToast.mockClear();
    let handled = false;
    await act(async () => {
      handled = requestRestartToUpdate();
    });
    expect(handled).toBe(true);
    expect(state.addToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "The service update is finishing" }),
    );
  });

  describe("after a reload", () => {
    it("does not look again when nothing may be under way", async () => {
      agent = {
        ...serviceWaiting,
        status: "up-to-date",
        availableVersion: null,
        downloadedVersion: null,
      };
      state.service = agent;
      state.prepare.mockImplementation(
        async (value: { input: ServerPrepareServiceUpdateInput }) => {
          calls.push(prepareCall(value.input));
          return { _tag: "Failure" };
        },
      );
      render();
      await advance(0);
      await advance(30_000);
      expect([...mountCalls, ...calls].filter((call) => call === "prepare:false")).toHaveLength(1);
    });

    it("stops looking again after 36 tries", async () => {
      agent = { ...serviceWaiting, status: "installing", updatedAt: new Date().toISOString() };
      state.service = agent;
      state.prepare.mockImplementation(
        async (value: { input: ServerPrepareServiceUpdateInput }) => {
          calls.push(prepareCall(value.input));
          return { _tag: "Failure" };
        },
      );
      render();
      await advance(0);
      for (let step = 0; step < 60; step += 1) await advance(5_000);
      const looks = [...mountCalls, ...calls].filter((call) => call === "prepare:false");
      expect(looks.length).toBeGreaterThan(1);
      expect(looks.length).toBeLessThanOrEqual(37);
    });

    describe("with the app's install saved for a finished service update", () => {
      const pressedAt = () => Date.now() - 120_000;
      let store: Map<string, string>;

      beforeEach(() => {
        store = useSessionStorage();
        store.set(
          FOLLOW_UP_KEY,
          JSON.stringify({ appVersion: "0.2.5", serviceVersion: "0.2.5", at: pressedAt() }),
        );
        checked = { idle: true, stoppedThreads: 0, blockers: [], held: false };
      });

      const installedAfterPress = (version: string): StudioServiceUpdateState => ({
        ...serviceWaiting,
        status: "installed",
        installedVersion: version,
        lastInstall: {
          version,
          at: new Date(Date.now() - 60_000).toISOString(),
          result: "updated",
        },
      });

      it("never reloads a window that cannot install the app", async () => {
        agent = installedAfterPress("0.2.5");
        state.service = agent;
        function FlowOnly() {
          useServiceUpdateFlow(state.service);
          return null;
        }
        act(() => {
          renderer = create(<FlowOnly />);
        });
        await advance(0);
        await advance(5_000);
        expect(reload).not.toHaveBeenCalled();
      });

      it("leaves it alone when the service runs another version", async () => {
        agent = installedAfterPress("0.2.6");
        state.service = agent;
        render();
        await advance(0);
        await advance(5_000);
        expect(calls).not.toContain("installUpdate:0.2.5");
      });

      it("does not install the app while the agent installs another release", async () => {
        agent = {
          ...installedAfterPress("0.2.5"),
          status: "installing",
          availableVersion: "0.2.6",
          downloadedVersion: "0.2.6",
          updatedAt: new Date().toISOString(),
        };
        state.service = agent;
        render();
        await advance(0);
        expect(label()).toBe("Installing…");
        expect(calls).not.toContain("installUpdate:0.2.5");
      });
    });
  });
});
