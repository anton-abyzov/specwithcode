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

// "Update now" for the service and the app when answers and presses cross: a
// read still on its way, a state the desktop has not published yet, a press
// while a question is open or while the app waits for running work, a reload.

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
  cancelServiceUpdate,
  resetServiceUpdateFlowForTests,
  SERVICE_HOLD_ENDED,
  startServiceUpdateNow,
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
  bridge.checkForUpdate.mockReset();
  bridge.checkForUpdate.mockImplementation(async () => ({
    checked: true,
    state: state.app ?? downloaded,
  }));
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

const upToDate = (): StudioServiceUpdateState => ({
  ...serviceWaiting,
  status: "up-to-date",
  availableVersion: null,
  downloadedVersion: null,
});

/** A forced request the desktop reports as pending, written at `requestedAt`. */
function pendingForce(
  requestedAt: number,
): NonNullable<StudioServiceUpdateState["pendingInstall"]> {
  return {
    requestedAt: new Date(requestedAt).toISOString(),
    mode: "force",
    version: "0.2.5",
    holdUntil: new Date(requestedAt + 15 * 60_000).toISOString(),
    handled: false,
  };
}

/** Another window presses Update now: its agent has 0.2.5 and the service holds the work. */
async function otherWindowPressesUpdateNow() {
  const requestedAt = Date.now();
  agent = {
    ...serviceWaiting,
    updatedAt: new Date(requestedAt + 500).toISOString(),
    pendingInstall: pendingForce(requestedAt),
  };
  checked = { ...RUNNING, held: true };
  state.service = agent;
  rerender();
  await advance(0);
  expect(label()).toBe("Updating…");
}

/** About (or the header pill) asks for the downloaded update. */
async function pressAbout(request: { requireService?: boolean } = {}) {
  let handled = false;
  await act(async () => {
    handled = requestRestartToUpdate(request);
  });
  await advance(0);
  return handled;
}

async function answerDialog(response: boolean | "alternate") {
  await act(async () => {
    respondToConfirmDialog(response);
    completeConfirmDialogClose();
  });
  await advance(0);
}

/** After the not-available failure, About and "Restart when idle" while a task runs. */
async function waitForIdleAfterNotAvailable() {
  registerConfirmDialogHost();
  await failAsNotAvailable();
  checked = RUNNING;
  await pressAbout();
  expect(readConfirmDialogState()).toMatchObject({
    status: "confirming",
    confirmLabel: "Restart when idle",
  });
  await answerDialog(true);
  expect(label()).toMatch(/^Restarts when idle, or in 2:0\d$/);
}

const description = () => String(button()?.props["aria-label"]);
const WAIT_TEXT = "once running work finishes";

describe("Update now when answers and presses cross", () => {
  describe("a failure", () => {
    it("stays when a read answers after the hold ran out, and nothing more is asked", async () => {
      agent = { ...serviceWaiting, updatedAt: new Date(Date.now() + 1_000).toISOString() };
      state.service = serviceWaiting;
      render();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      await advance(15 * 60_000);
      // The desktop answers a read a little later than the service answers its check.
      bridge.getServiceUpdateState.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(agent), 300)),
      );
      checked = { ...checked, held: false };
      calls.length = 0;
      await advance(12_000);
      expect(lastToast().description).toBe(SERVICE_HOLD_ENDED);
      await advance(3 * 60_000);
      expect(label()).toBe("Retry update");
      expect(lastToast().description).toBe(SERVICE_HOLD_ENDED);
      expect(calls).not.toContain("installServiceUpdate:force");
      expect(calls).not.toContain("prepare:true+hold");
    });

    it("of the install request stays when a read answers after it", async () => {
      agent = { ...serviceWaiting, updatedAt: new Date(Date.now() - 60_000).toISOString() };
      state.service = serviceWaiting;
      const start = Date.now();
      bridge.getServiceUpdateState.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(agent), 1_500)),
      );
      bridge.installServiceUpdate.mockImplementation(async (options) => {
        calls.push(`installServiceUpdate:${options?.force ? "force" : "normal"}`);
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        throw new Error("The update agent could not be started.");
      });
      render();
      await click();
      // The agent takes the request and waits for quiet, written after it.
      agent = { ...serviceWaiting, updatedAt: new Date(start + 2_000).toISOString() };
      for (let step = 0; step < 40; step += 1) await advance(200);
      expect(label()).toBe("Retry update");
      expect(lastToast().description).toBe("The update agent could not be started.");
    });

    it("keeps the app's install when the desktop publishes the agent's install before a poll", async () => {
      state.service = serviceWaiting;
      render();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      agent = { ...serviceWaiting, status: "installing", updatedAt: new Date().toISOString() };
      state.service = agent;
      rerender();
      await advance(0);
      agent = { ...serviceWaiting, status: "installed", installedVersion: "0.2.5" };
      await advance(2_000);
      await advance(2_000);
      expect(calls.at(-1)).toBe("installUpdate:0.2.5");
      expect(reload).not.toHaveBeenCalled();
    });

    it("keeps the retry's version and the app's install when the agent starts installing during its question", async () => {
      registerConfirmDialogHost();
      await failAfterHoldRanOut();
      checked = { ...RUNNING, held: true };
      calls.length = 0;
      await act(async () => {
        lastToast().actionProps.onClick?.();
      });
      await advance(0);
      expect(readConfirmDialogState()).toMatchObject({
        status: "confirming",
        confirmLabel: "Stop and update now",
      });
      agent = { ...serviceWaiting, status: "installing", updatedAt: new Date().toISOString() };
      state.service = agent;
      rerender();
      await advance(0);
      await answerDialog(true);
      expect(bridge.installServiceUpdate.mock.calls.at(-1)![0]!.version).toBe("0.2.5");
      agent = { ...serviceWaiting, status: "installed", installedVersion: "0.2.5" };
      await advance(2_000);
      await advance(2_000);
      expect(calls.at(-1)).toBe("installUpdate:0.2.5");
    });

    it("stays while the agent needs a manual step on the version asked for", async () => {
      await failAfterHoldRanOut();
      state.service = {
        ...serviceWaiting,
        status: "manual-required",
        installedVersion: "0.2.5",
        message: "Finish the update in Terminal.",
        updatedAt: new Date().toISOString(),
      };
      rerender();
      await advance(0);
      expect(label()).toBe("Retry update");
    });
  });

  describe("the version the service runs, before the desktop republishes", () => {
    /** Update now for both; the agent installs 0.2.5 and reports an error this window reads. */
    async function failAfterInstallError() {
      state.service = serviceWaiting;
      render();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      agent = {
        ...serviceWaiting,
        status: "installing",
        updatedAt: new Date(Date.now() + 500).toISOString(),
      };
      await advance(2_000);
      expect(label()).toBe("Installing…");
      agent = {
        ...serviceWaiting,
        status: "error",
        installedVersion: "0.2.5",
        message: "Could not remove the previous release.",
        updatedAt: new Date(Date.now() + 1_000).toISOString(),
      };
      await advance(2_000);
      expect(label()).toBe("Retry update");
      // The published state still says 0.2.4: the desktop publishes up to 20 s apart.
      calls.length = 0;
    }

    it("lets the toast's Try again install only the app", async () => {
      await failAfterInstallError();
      await pressTryAgain();
      await advance(0);
      expect(calls).toEqual(APP_ONLY);
    });

    it("lets the button's Retry update install only the app", async () => {
      await failAfterInstallError();
      await click();
      await advance(0);
      expect(calls).toEqual(APP_ONLY);
    });

    it("asks for the release the newest state offers", async () => {
      await failAfterHoldRanOut();
      // Since the failure the agent found 0.2.6; this window read nothing newer.
      state.service = {
        ...serviceWaiting,
        status: "downloaded",
        availableVersion: "0.2.6",
        downloadedVersion: "0.2.6",
        updatedAt: new Date().toISOString(),
      };
      rerender();
      await advance(0);
      calls.length = 0;
      await pressTryAgain();
      expect(calls).toEqual(STOP_AND_INSTALL);
      expect(bridge.installServiceUpdate.mock.calls.at(-1)![0]!.version).toBe("0.2.6");
    });

    it("installs only the app once the newest state runs the release a retry asks for", async () => {
      await failAfterHoldRanOut();
      // The agent installed 0.2.6, the release it had found meanwhile, and reported an error.
      state.service = {
        ...serviceWaiting,
        status: "error",
        installedVersion: "0.2.6",
        availableVersion: "0.2.6",
        downloadedVersion: "0.2.6",
        message: "Could not remove the previous release.",
        updatedAt: new Date().toISOString(),
      };
      rerender();
      await advance(0);
      expect(label()).toBe("Retry update");
      calls.length = 0;
      await pressTryAgain();
      await advance(0);
      expect(calls).toEqual(APP_ONLY);
    });

    it("restarts no app for a service-only retry", async () => {
      agent = { ...serviceWaiting, status: "downloaded" };
      state.service = agent;
      render();
      // Settings' service install asks for no app install.
      await act(async () => {
        await startServiceUpdateNow(agent);
      });
      expect(calls).toEqual(STOP_AND_INSTALL);
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
      await advance(0);
      calls.length = 0;
      await pressTryAgain();
      await advance(0);
      expect(calls).toEqual([]);
      expect(state.closeToast).toHaveBeenCalledWith("toast-1");
    });
  });

  describe("after the service's agent lacked the release", () => {
    it("offers the app's own restart on the button, and restarts only the app", async () => {
      await failAsNotAvailable();
      expect(description()).toContain("Restarts the app to install it.");
      calls.length = 0;
      await click();
      await advance(0);
      expect(calls).toEqual(APP_ONLY);
    });

    it("installs only the app on the next press after its question was cancelled", async () => {
      registerConfirmDialogHost();
      await failAsNotAvailable();
      checked = RUNNING;
      await pressAbout();
      expect(readConfirmDialogState()).toMatchObject({ confirmLabel: "Restart when idle" });
      await answerDialog(false);
      // The failure stays, and with it the app's restart on the button.
      expect(state.closeToast).not.toHaveBeenCalled();
      expect(label()).toBe("Restart to update");
      checked = { idle: true, stoppedThreads: 0, blockers: [] };
      calls.length = 0;
      await pressAbout();
      expect(calls).toEqual(APP_ONLY);
    });

    it("installs only the app again after the app's install was refused", async () => {
      await failAsNotAvailable();
      installResult = { accepted: false, completed: false, reason: "no-download" };
      calls.length = 0;
      await pressAbout();
      expect(calls).toEqual([...APP_ONLY, "prepare:release"]);
      expect(state.closeToast).not.toHaveBeenCalled();
      installResult = { accepted: true, completed: false, failed: false };
      calls.length = 0;
      await pressAbout();
      expect(calls).toEqual(APP_ONLY);
    });

    it("asks the app's question again from About while it waits for idle, and keeps the wait", async () => {
      await waitForIdleAfterNotAvailable();
      // The failed service update is over: the app restarts on its own once idle.
      expect(state.closeToast).toHaveBeenCalledWith("toast-1");
      calls.length = 0;
      await pressAbout();
      expect(readConfirmDialogState()).toMatchObject({
        status: "confirming",
        confirmLabel: "Restart when idle",
      });
      await answerDialog(false);
      expect(label()).toMatch(/^Restarts when idle/);
      expect(calls).not.toContain("installServiceUpdate:force");
    });

    it("restarts only the app once the hold window passes while work still runs", async () => {
      await waitForIdleAfterNotAvailable();
      calls.length = 0;
      for (let step = 0; step < 30; step += 1) await advance(5_000);
      // Looks aside: one drain of the service the app started, one install.
      expect(calls.filter((call) => call !== "prepare:false")).toEqual([
        "prepare:true+hold:app-restart",
        "installUpdate:0.2.5",
      ]);
    });

    it("never quits the app for a service update another window started during the wait", async () => {
      await waitForIdleAfterNotAvailable();
      await otherWindowPressesUpdateNow();
      // That update stops the work: nothing runs now.
      checked = { idle: true, stoppedThreads: 0, blockers: [], held: true };
      calls.length = 0;
      for (let step = 0; step < 30; step += 1) await advance(5_000);
      expect(calls).not.toContain("installUpdate:0.2.5");
      // The app's install follows that update instead of the wait.
      expect(description()).not.toContain(WAIT_TEXT);
      agent = { ...serviceWaiting, status: "installed", installedVersion: "0.2.5" };
      await advance(2_000);
      expect(calls.at(-1)).toBe("installUpdate:0.2.5");
    });

    it("adds the app's install to that update without asking when About is chosen", async () => {
      await waitForIdleAfterNotAvailable();
      await otherWindowPressesUpdateNow();
      await pressAbout();
      expect(readConfirmDialogState()).toMatchObject({ status: "idle" });
      expect(description()).not.toContain(WAIT_TEXT);
      agent = { ...serviceWaiting, status: "installed", installedVersion: "0.2.5" };
      await advance(2_000);
      expect(calls.at(-1)).toBe("installUpdate:0.2.5");
    });

    it("lets a service update that went live during the app's question install the app after it", async () => {
      registerConfirmDialogHost();
      await failAsNotAvailable();
      checked = RUNNING;
      await pressAbout();
      expect(readConfirmDialogState()).toMatchObject({ confirmLabel: "Restart when idle" });
      await otherWindowPressesUpdateNow();
      calls.length = 0;
      await answerDialog("alternate");
      expect(calls).not.toContain("prepare:true+hold:app-restart");
      expect(calls).not.toContain("installUpdate:0.2.5");
      agent = { ...serviceWaiting, status: "installed", installedVersion: "0.2.5" };
      await advance(2_000);
      expect(calls.at(-1)).toBe("installUpdate:0.2.5");
    });

    it("ends the wait once a service update that went live during the app's question takes its install", async () => {
      await waitForIdleAfterNotAvailable();
      await pressAbout();
      expect(readConfirmDialogState()).toMatchObject({ confirmLabel: "Restart when idle" });
      await otherWindowPressesUpdateNow();
      calls.length = 0;
      await answerDialog("alternate");
      // The app installs once that update is done: no wait is left to restart it.
      expect(description()).not.toContain(WAIT_TEXT);
      expect(calls).not.toContain("installUpdate:0.2.5");
      agent = { ...serviceWaiting, status: "installed", installedVersion: "0.2.5" };
      await advance(2_000);
      expect(calls.at(-1)).toBe("installUpdate:0.2.5");
    });

    it("asks the service again once its agent reports the release", async () => {
      await failAsNotAvailable();
      state.service = {
        ...serviceWaiting,
        status: "downloaded",
        updatedAt: new Date().toISOString(),
      };
      rerender();
      await advance(0);
      // The failure is over: the update for both is offered again.
      expect(state.closeToast).toHaveBeenCalledWith("toast-1");
      expect(label()).toBe("Update now");
      calls.length = 0;
      await pressAbout();
      expect(calls).toEqual(STOP_AND_INSTALL);
    });

    it("updates the service for Settings' service row all the same", async () => {
      await failAsNotAvailable();
      calls.length = 0;
      expect(await pressAbout({ requireService: true })).toBe(true);
      expect(calls).toEqual(STOP_AND_INSTALL);
    });

    it("asks the service again from the button when there is no app install to fall back on", async () => {
      state.app = {
        ...downloaded,
        status: "up-to-date",
        currentVersion: "0.2.5",
        availableVersion: null,
        downloadedVersion: null,
        downloadPercent: null,
      };
      agent = upToDate();
      state.service = agent;
      render();
      expect(label()).toBe("Update now");
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      agent = {
        ...agent,
        updatedAt: new Date(Date.now() + 1_000).toISOString(),
        pendingInstall: null,
      };
      await advance(2_000);
      expect(lastToast().description).toBe(NOT_AVAILABLE);
      expect(label()).toBe("Retry update");
      calls.length = 0;
      await click();
      await advance(0);
      expect(calls).toEqual(STOP_AND_INSTALL);
    });
  });

  describe("a wait for idle", () => {
    it("restarts once work finishes while the window renders every second", async () => {
      registerConfirmDialogHost();
      checked = RUNNING;
      render();
      expect(label()).toBe("Restart to update");
      await click();
      await advance(0);
      await answerDialog(true);
      checked = { idle: true, stoppedThreads: 0, blockers: [] };
      calls.length = 0;
      // A real window renders the countdown every second.
      for (let second = 0; second < 20; second += 1) await advance(1_000);
      expect(calls).toEqual(APP_ONLY);
    });

    it("restarts once when its deadline and a look at running work come due during a slow feed check", async () => {
      await waitForIdleAfterNotAvailable();
      // From now on the release feed takes a second to answer.
      bridge.checkForUpdate.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        return { checked: true, state: state.app ?? downloaded };
      });
      calls.length = 0;
      for (let step = 0; step < 30; step += 1) await advance(5_000);
      expect(calls.filter((call) => call !== "prepare:false")).toEqual([
        "prepare:true+hold:app-restart",
        "installUpdate:0.2.5",
      ]);
    });

    it("restarts the app as due, without a handover, while a press for the service asks first", async () => {
      await waitForIdleAfterNotAvailable();
      const waitedFrom = Date.now();
      // The agent found the release meanwhile: a due wait would update the service first.
      state.service = serviceWaiting;
      rerender();
      await advance(0);
      // From now on the release feed takes a second to answer.
      bridge.checkForUpdate.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        return { checked: true, state: state.app ?? downloaded };
      });
      await advance(waitedFrom + 2 * 60_000 - 1_500 - Date.now());
      calls.length = 0;
      // Settings' service row is pressed; the wait comes due while its question
      // is open, before the window has rendered that question.
      await act(async () => {
        requestRestartToUpdate({ requireService: true });
        await vi.advanceTimersByTimeAsync(3_000);
      });
      await advance(0);
      expect(readConfirmDialogState()).toMatchObject({ confirmLabel: "Stop and update now" });
      // The wait does not ask the service a second time: the app restarts as it came due.
      expect(calls.filter((call) => call !== "prepare:false")).toEqual([
        "prepare:true+hold:app-restart",
        "installUpdate:0.2.5",
      ]);
    });

    it("ends once it hands over to a service update whose question is cancelled", async () => {
      registerConfirmDialogHost();
      checked = RUNNING;
      render();
      await click();
      await advance(0);
      await answerDialog(true);
      // The service's agent finds a release meanwhile: the restart now updates both.
      state.service = serviceWaiting;
      rerender();
      await advance(120_000);
      expect(readConfirmDialogState()).toMatchObject({ confirmLabel: "Stop and update now" });
      await answerDialog(false);
      expect(label()).toBe("Update now");
      // The work the user kept stays kept: nothing asks again.
      await advance(30_000);
      expect(readConfirmDialogState()).toMatchObject({ status: "idle" });
    });

    it("stays when Settings' service update is cancelled at its question, and ends once one starts", async () => {
      await waitForIdleAfterNotAvailable();
      await pressAbout({ requireService: true });
      expect(readConfirmDialogState()).toMatchObject({ confirmLabel: "Stop and update now" });
      await answerDialog(false);
      expect(label()).toMatch(/^Restarts when idle/);
      checked = { idle: true, stoppedThreads: 0, blockers: [] };
      calls.length = 0;
      await pressAbout({ requireService: true });
      expect(calls).toEqual(STOP_AND_INSTALL);
      expect(description()).not.toContain(WAIT_TEXT);
    });
  });

  describe("the app's install a reload keeps", () => {
    it("is forgotten once the agent answered the request without installing", async () => {
      const store = useSessionStorage();
      // The app found 0.2.5 before the service's agent: the service refuses to hold the work.
      agent = upToDate();
      state.service = agent;
      answerPrepare(() => false);
      checked = { ...checked, held: false };
      render();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      expect(JSON.parse(store.get(FOLLOW_UP_KEY)!)).toMatchObject({ serviceVersion: "0.2.5" });
      // The window reloads before the agent answers: no window shows the failure.
      reloadWindow(store);
      render();
      await advance(0);
      agent = { ...upToDate(), updatedAt: new Date(Date.now() + 1_000).toISOString() };
      state.service = agent;
      rerender();
      await advance(2_000);
      expect(store.has(FOLLOW_UP_KEY)).toBe(false);
      // Later the agent finds 0.2.5 and installs it at a quiet moment of its own.
      await advance(12 * 60_000);
      agent = { ...serviceWaiting, status: "installing", updatedAt: new Date().toISOString() };
      state.service = agent;
      rerender();
      await advance(0);
      expect(label()).toBe("Installing…");
      agent = { ...serviceWaiting, status: "installed", installedVersion: "0.2.5" };
      await advance(2_000);
      await advance(5_000);
      expect(calls).not.toContain("installUpdate:0.2.5");
    });

    it("is forgotten when a reloaded window withdraws the request the agent settled", async () => {
      const store = useSessionStorage();
      // An older agent: its states say nothing of when it wrote them.
      agent = upToDate();
      state.service = agent;
      render();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      // It answered the request without installing: none is pending any more.
      pending = null;
      reloadWindow(store);
      checked = { ...checked, held: true };
      render();
      await advance(0);
      expect([...mountCalls, ...calls]).toContain("prepare:release");
      expect(store.has(FOLLOW_UP_KEY)).toBe(false);
    });

    it("stays until the agent answers the request itself", async () => {
      const store = useSessionStorage();
      agent = upToDate();
      state.service = agent;
      // Stopping the work takes a while.
      state.prepare.mockImplementation(
        async (value: { input: ServerPrepareServiceUpdateInput }) => {
          calls.push(prepareCall(value.input));
          if (!value.input.stopWork) return { _tag: "Success", value: checked };
          await new Promise((resolve) => setTimeout(resolve, 3_000));
          return { _tag: "Success", value: prepared };
        },
      );
      const pressedAt = Date.now();
      render();
      await click();
      await advance(3_000);
      expect(calls).toEqual(STOP_AND_INSTALL);
      // The desktop publishes late a pass of the agent's own that says it is up
      // to date: written while the work stopped, before the request.
      state.service = { ...upToDate(), updatedAt: new Date(pressedAt + 1_000).toISOString() };
      rerender();
      await advance(0);
      expect(store.has(FOLLOW_UP_KEY)).toBe(true);
      // A pass that read the settings just before the request: the request is still pending.
      agent = {
        ...upToDate(),
        updatedAt: new Date(pressedAt + 4_000).toISOString(),
        pendingInstall: pendingForce(pressedAt + 3_000),
      };
      state.service = agent;
      rerender();
      await advance(1_000);
      expect(store.has(FOLLOW_UP_KEY)).toBe(true);
      // The window reloads, and the agent installs for the request.
      reloadWindow(store);
      checked = { ...checked, held: true };
      render();
      await advance(0);
      agent = { ...agent, status: "installing", updatedAt: new Date().toISOString() };
      await advance(2_000);
      agent = { ...serviceWaiting, status: "installed", installedVersion: "0.2.5" };
      await advance(2_000);
      expect(calls.at(-1)).toBe("installUpdate:0.2.5");
    });

    it("installs the app after a reload that finds the service on the version asked for", async () => {
      const store = useSessionStorage();
      state.service = serviceWaiting;
      render();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      // The window reloads as the service finishes: the agent wrote that it runs 0.2.5.
      reloadWindow(store);
      checked = { ...checked, held: false };
      const doneAt = new Date(Date.now() + 1_000).toISOString();
      agent = {
        ...serviceWaiting,
        status: "installed",
        installedVersion: "0.2.5",
        updatedAt: doneAt,
        lastInstall: { version: "0.2.5", at: doneAt, result: "updated" },
      };
      state.service = agent;
      render();
      await advance(0);
      expect(calls.at(-1)).toBe("installUpdate:0.2.5");
    });

    it("stays after a reload when an older agent's settled state says nothing of when it was written", async () => {
      const store = useSessionStorage();
      state.service = serviceWaiting;
      render();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      reloadWindow(store);
      // An older agent writes no times: this error may be from before the request.
      checked = { ...checked, held: false };
      agent = { ...serviceWaiting, status: "error", message: "The download failed." };
      state.service = agent;
      render();
      await advance(0);
      expect(store.has(FOLLOW_UP_KEY)).toBe(true);
      // The agent takes the request after all.
      agent = { ...serviceWaiting, status: "installing" };
      state.service = agent;
      rerender();
      await advance(0);
      agent = { ...serviceWaiting, status: "installed", installedVersion: "0.2.5" };
      await advance(2_000);
      expect(calls.at(-1)).toBe("installUpdate:0.2.5");
    });
  });

  describe("an agent", () => {
    it("that has gone quiet is asked again each time the previous ask has finished", async () => {
      state.service = serviceWaiting;
      render();
      await click();
      calls.length = 0;
      await advance(32_000);
      await advance(32_000);
      await advance(32_000);
      expect(
        calls.filter((call) => call === "installServiceUpdate:force").length,
      ).toBeGreaterThanOrEqual(2);
    });

    it("with a request pending is looked at again after a reload with no answer", async () => {
      agent = { ...upToDate(), pendingInstall: pendingForce(Date.now() - 10_000) };
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
      const looks = [...mountCalls, ...calls].filter((call) => call === "prepare:false");
      expect(looks.length).toBeGreaterThan(1);
    });
  });

  describe("a press that only follows another window's request", () => {
    /** Another window's request, written at `requestedAt`, while its agent fetches 0.2.5. */
    const fetching = (requestedAt: number): StudioServiceUpdateState => ({
      ...serviceWaiting,
      status: "downloading",
      downloadedVersion: null,
      updatedAt: new Date(requestedAt + 1_000).toISOString(),
      pendingInstall: pendingForce(requestedAt),
    });

    it("keeps following it after an update this window followed ended with its hold", async () => {
      const firstAt = Date.now() - 5_000;
      checked = { ...RUNNING, held: true };
      agent = {
        ...serviceWaiting,
        updatedAt: new Date(firstAt + 500).toISOString(),
        pendingInstall: pendingForce(firstAt),
      };
      state.service = agent;
      render();
      await advance(0);
      expect(label()).toBe("Updating…");
      // That update is cancelled: it ends with its hold.
      checked = { ...RUNNING, held: false };
      agent = { ...agent, pendingInstall: null };
      await advance(12_000);
      expect(state.closeToast).toHaveBeenCalledWith("toast-1");
      // The other window presses again before its agent has the release: no hold.
      agent = fetching(Date.now());
      state.service = agent;
      rerender();
      await advance(0);
      state.closeToast.mockClear();
      calls.length = 0;
      await click();
      expect(calls).toEqual([]);
      expect(label()).toBe("Updating…");
      await advance(30_000);
      expect(label()).toBe("Updating…");
      expect(state.closeToast).not.toHaveBeenCalled();
    });

    it("leaves the work to the window that pressed once the agent has the release", async () => {
      // This window's own press found no release: the service refused to hold the work.
      agent = upToDate();
      state.service = agent;
      answerPrepare(() => false);
      render();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      await act(async () => {
        await cancelServiceUpdate();
      });
      // Another window presses before its agent has the release; this one follows it.
      const otherAt = Date.now();
      agent = fetching(otherAt);
      state.service = agent;
      rerender();
      await advance(0);
      calls.length = 0;
      await click();
      expect(calls).toEqual([]);
      expect(label()).toBe("Updating…");
      // The agent has it now: the window that pressed holds the work, not this one.
      answerPrepare(() => true);
      agent = {
        ...serviceWaiting,
        updatedAt: new Date(Date.now() + 1_000).toISOString(),
        pendingInstall: pendingForce(otherAt),
      };
      await advance(4_000);
      expect(calls.filter((call) => call.startsWith("prepare:true"))).toEqual([]);
      expect(label()).toBe("Updating…");
    });
  });

  describe("the work held again once the agent has the release", () => {
    /** Update now before the agent has 0.2.5: the service refuses to hold the work. */
    async function pressBeforeAgentHasRelease(): Promise<number> {
      agent = upToDate();
      state.service = agent;
      answerPrepare(() => false);
      render();
      const pressedAt = Date.now();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      agent = { ...upToDate(), pendingInstall: pendingForce(pressedAt) };
      return pressedAt;
    }

    /** The agent fetched 0.2.5 for the request at `pressedAt`. */
    const agentHasRelease = (pressedAt: number): StudioServiceUpdateState => ({
      ...serviceWaiting,
      updatedAt: new Date(pressedAt + 1_000).toISOString(),
      pendingInstall: pendingForce(pressedAt),
    });

    it("shows what still runs as soon as the second stop answers", async () => {
      const pressedAt = await pressBeforeAgentHasRelease();
      prepared = { ...RUNNING, held: true };
      answerPrepare(() => true);
      agent = agentHasRelease(pressedAt);
      await advance(2_000);
      expect(calls).toContain("prepare:true+hold");
      expect(lastToast().description).toContain("Fix login");
    });

    it("is not asked for again once the agent began installing while the work stopped", async () => {
      const pressedAt = await pressBeforeAgentHasRelease();
      let finishStop: (held: boolean) => void = () => undefined;
      state.prepare.mockImplementation(
        async (value: { input: ServerPrepareServiceUpdateInput }) => {
          calls.push(prepareCall(value.input));
          if (!value.input.stopWork) return { _tag: "Success", value: checked };
          const held = await new Promise<boolean>((resolve) => (finishStop = resolve));
          return { _tag: "Success", value: { ...prepared, held } };
        },
      );
      agent = agentHasRelease(pressedAt);
      await advance(2_000);
      expect(calls).toContain("prepare:true+hold");
      // The agent begins installing while that stop still drains.
      agent = {
        ...agentHasRelease(pressedAt),
        status: "installing",
        updatedAt: new Date(Date.now() + 500).toISOString(),
        pendingInstall: { ...pendingForce(pressedAt), handled: true },
      };
      await advance(2_000);
      expect(label()).toBe("Installing…");
      calls.length = 0;
      await act(async () => finishStop(true));
      await advance(0);
      expect(calls.filter((call) => call.startsWith("installServiceUpdate"))).toEqual([]);
    });

    it("asks the agent again only once the newest ask finished, when two overlap", async () => {
      const pressedAt = await pressBeforeAgentHasRelease();
      // Each ask from here on is answered only when let go.
      const finish: Array<() => void> = [];
      bridge.installServiceUpdate.mockImplementation((options?: StudioServiceInstallOptions) => {
        calls.push(`installServiceUpdate:${options?.force ? "force" : "normal"}`);
        return new Promise((resolve) => finish.push(() => resolve({ ...agent })));
      });
      const asks = () => calls.filter((call) => call === "installServiceUpdate:force").length;
      calls.length = 0;
      // Nothing runs and the agent stays quiet: the window asks again.
      await advance(32_000);
      expect(asks()).toBe(1);
      // The agent has the release: the work is held again and asked for under the hold.
      answerPrepare(() => true);
      agent = {
        ...agentHasRelease(pressedAt),
        updatedAt: new Date(Date.now() + 500).toISOString(),
      };
      await advance(2_000);
      expect(calls).toContain("prepare:true+hold");
      expect(asks()).toBe(2);
      // The first ask finishes while the second is still being taken: nothing more meanwhile.
      await act(async () => finish[0]!());
      await advance(45_000);
      expect(asks()).toBe(2);
    });
  });
});
