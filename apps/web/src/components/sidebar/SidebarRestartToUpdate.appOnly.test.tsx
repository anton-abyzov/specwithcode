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

// "Update now" once the service's agent lacks the release: presses install the
// app alone until the agent has it. And presses while another update step runs.

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
  startServiceUpdateNow,
} from "../serviceUpdateFlow";
import { requestRestartToUpdate } from "./restartToUpdateRequests";
import { SidebarRestartToUpdate } from "./SidebarRestartToUpdate";
import { APP_RESTART_UNKNOWN } from "./SidebarRestartToUpdate.logic";

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

const STOP_AND_INSTALL = ["prepare:false", "prepare:true+hold", "installServiceUpdate:force"];
// What the app's own restart sends: a look, a drain of the service it started, the install.
const APP_ONLY = ["prepare:false", "prepare:true+hold:app-restart", "installUpdate:0.2.5"];
const NOT_AVAILABLE = "SpecWithCode 0.2.5 is not available to the service on this Mac yet.";
// Where a window keeps, across a reload, the release the service's agent lacked.
const LACKED_RELEASE_KEY = "specwithcode.serviceUpdate.lackedRelease";

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
  getServiceUpdateState: vi.fn<() => Promise<StudioServiceUpdateState>>(async () => agent),
  installUpdate: vi.fn(async (options?: { expectedVersion?: string }) => {
    calls.push(`installUpdate:${options?.expectedVersion ?? ""}`);
    return { ...installResult, state: state.app ?? downloaded };
  }),
  installServiceUpdate: vi.fn<(options?: StudioServiceInstallOptions) => Promise<unknown>>(),
  cancelServiceUpdate: vi.fn(async () => {
    calls.push("cancelServiceUpdate");
    return { ...agent };
  }),
  getUpdatePreferences: vi.fn(async () => ({
    checkAutomatically: true,
    downloadAutomatically: true,
    installAutomatically: true,
  })),
  ownsBundledService: vi.fn(async () => true),
};

let renderer: ReactTestRenderer | null = null;

function render() {
  act(() => {
    renderer = create(<SidebarRestartToUpdate />);
  });
  calls.length = 0;
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
  checked = { idle: true, stoppedThreads: 0, blockers: [] };
  prepared = { idle: true, stoppedThreads: 0, blockers: [], held: true };
  state.prepare.mockReset();
  answerPrepare(() => true);
  reload.mockReset();
  bridge.getServiceUpdateState.mockReset();
  bridge.getServiceUpdateState.mockImplementation(async () => agent);
  bridge.installUpdate.mockClear();
  bridge.installServiceUpdate.mockReset();
  bridge.installServiceUpdate.mockImplementation(async (options?: StudioServiceInstallOptions) => {
    calls.push(`installServiceUpdate:${options?.force ? "force" : "normal"}`);
    return { ...agent };
  });
  bridge.cancelServiceUpdate.mockReset();
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

const noAppUpdate = (): DesktopUpdateState => ({
  ...downloaded,
  status: "idle",
  availableVersion: null,
  downloadedVersion: null,
});

const FINISHING = expect.objectContaining({ title: "The service update is finishing" });

/** The next cancel's withdrawal is written only once the returned function runs. */
function slowCancel(): () => void {
  let finish: (value: StudioServiceUpdateState) => void = () => undefined;
  bridge.cancelServiceUpdate.mockImplementationOnce(() => {
    calls.push("cancelServiceUpdate");
    return new Promise<StudioServiceUpdateState>((resolve) => {
      finish = resolve;
    });
  });
  return () => finish({ ...agent });
}

/** Closes the service update's toast with its X. */
function closeToastWithX() {
  const options = lastToast() as unknown as { data?: { onClose?: () => void } };
  expect(typeof options.data?.onClose).toBe("function");
  act(() => {
    options.data!.onClose!();
  });
}

/** The desktop publishes the agent's newest state: it found 0.2.5. */
async function agentFindsRelease() {
  state.service = { ...serviceWaiting, status: "downloaded", updatedAt: new Date().toISOString() };
  rerender();
  await advance(0);
}

/** The desktop publishes the agent's newest state: it installed 0.2.5 on its own. */
async function serviceTakesRelease() {
  agent = {
    ...serviceWaiting,
    status: "up-to-date",
    installedVersion: "0.2.5",
    availableVersion: null,
    downloadedVersion: null,
    updatedAt: new Date().toISOString(),
    pendingInstall: null,
  };
  state.service = agent;
  rerender();
  await advance(0);
}

describe("Update now once the service's agent lacks the release", () => {
  describe("a later press for the app's update", () => {
    it("restarts the app alone once the failure's toast is closed", async () => {
      await failAsNotAvailable();
      closeToastWithX();
      await advance(0);
      expect(label()).toBe("Restart to update");
      calls.length = 0;
      await click();
      expect(calls).toEqual(APP_ONLY);
    });

    it("restarts the app alone from About once the failure's toast is closed", async () => {
      await failAsNotAvailable();
      closeToastWithX();
      await advance(0);
      calls.length = 0;
      expect(await pressAbout()).toBe(true);
      expect(calls).toEqual(APP_ONLY);
    });

    it("asks about restarting the app, not about stopping work for the service", async () => {
      registerConfirmDialogHost();
      await failAsNotAvailable();
      closeToastWithX();
      await advance(0);
      checked = RUNNING;
      await click();
      expect(readConfirmDialogState()).toMatchObject({
        status: "confirming",
        confirmLabel: "Restart when idle",
      });
    });

    it("restarts the app alone after a reload", async () => {
      const store = useSessionStorage();
      await failAsNotAvailable();
      reloadWindow(store);
      render();
      await advance(0);
      expect(label()).toBe("Restart to update");
      calls.length = 0;
      await click();
      expect(calls).toEqual(APP_ONLY);
    });

    it("restarts the app alone after a wait for idle whose install was refused", async () => {
      await waitForIdleAfterNotAvailable();
      installResult = { accepted: false, completed: false, reason: "no-download" };
      checked = { idle: true, stoppedThreads: 0, blockers: [] };
      calls.length = 0;
      for (let step = 0; step < 4; step += 1) await advance(5_000);
      expect(calls).toContain("installUpdate:0.2.5");
      expect(label()).toBe("Restart to update");
      installResult = { accepted: true, completed: false, failed: false };
      calls.length = 0;
      await click();
      expect(calls).toEqual(APP_ONLY);
    });

    it("keeps the app restart's drain when the failed attempt's withdrawal lands late", async () => {
      const finishCancel = slowCancel();
      await failAsNotAvailable();
      expect(calls.at(-1)).toBe("cancelServiceUpdate");
      calls.length = 0;
      await click();
      expect(calls).toEqual(APP_ONLY);
      await act(async () => {
        finishCancel();
      });
      await advance(0);
      expect(calls).toEqual(APP_ONLY);
    });

    it("asks the service again once a rolled-back install's toast is closed", async () => {
      state.service = serviceWaiting;
      render();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      agent = {
        ...serviceWaiting,
        status: "installing",
        updatedAt: new Date(Date.now() + 500).toISOString(),
      };
      state.service = agent;
      await advance(2_000);
      rerender();
      expect(label()).toBe("Installing…");
      // The install was rolled back: the agent is idle on the old version and offers nothing.
      agent = {
        ...serviceWaiting,
        status: "up-to-date",
        availableVersion: null,
        downloadedVersion: null,
        updatedAt: new Date(Date.now() + 1_000).toISOString(),
      };
      state.service = agent;
      await advance(2_000);
      rerender();
      expect(lastToast().type).toBe("error");
      expect(lastToast().description).toContain("rolled back");
      closeToastWithX();
      await advance(2_000);
      rerender();
      // Not for want of the release: a press still asks the service.
      expect(label()).toBe("Update now");
      calls.length = 0;
      await click();
      await advance(2_000);
      expect(calls).toContain("installServiceUpdate:force");
      expect(calls.filter((call) => call.startsWith("installUpdate"))).toEqual([]);
    });

    it("asks the service again once a Try again that asked it anew was cancelled", async () => {
      await failAsNotAvailable();
      calls.length = 0;
      await pressTryAgain();
      await advance(0);
      expect(calls).toEqual(STOP_AND_INSTALL);
      // Cancelled before the agent answered: nothing says it still lacks the release.
      bridge.cancelServiceUpdate.mockImplementationOnce(async () => {
        calls.push("cancelServiceUpdate");
        return { ...agent, pendingInstall: null };
      });
      const toast = lastToast() as unknown as {
        data: { secondaryActionProps: { children: unknown; onClick: () => void } };
      };
      expect(toast.data.secondaryActionProps.children).toBe("Cancel update");
      await act(async () => {
        toast.data.secondaryActionProps.onClick();
      });
      await advance(0);
      expect(label()).toBe("Update now");
      calls.length = 0;
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
    });
  });

  describe("the agent finds the release meanwhile", () => {
    it("offers Update now in the very render that shows the agent has the release", async () => {
      await failAsNotAvailable();
      closeToastWithX();
      await advance(0);
      expect(label()).toBe("Restart to update");
      agent = {
        ...serviceWaiting,
        status: "downloaded",
        updatedAt: new Date(Date.now() + 5_000).toISOString(),
      };
      state.service = agent;
      rerender();
      expect(label()).toBe("Update now");
    });

    it("updates the service first when found while the app's question is open", async () => {
      registerConfirmDialogHost();
      await failAsNotAvailable();
      checked = RUNNING;
      await pressAbout();
      expect(readConfirmDialogState()).toMatchObject({ confirmLabel: "Restart when idle" });
      await agentFindsRelease();
      calls.length = 0;
      await answerDialog("alternate");
      // The service update asks for itself before it stops the work.
      expect(readConfirmDialogState()).toMatchObject({
        status: "confirming",
        confirmLabel: "Stop and update now",
      });
      await answerDialog(true);
      expect(calls).toEqual(STOP_AND_INSTALL);
    });

    it("updates the service first when found during the app's wait for idle", async () => {
      await waitForIdleAfterNotAvailable();
      await agentFindsRelease();
      checked = { idle: true, stoppedThreads: 0, blockers: [] };
      calls.length = 0;
      for (let step = 0; step < 6; step += 1) await advance(5_000);
      expect(calls).toContain("installServiceUpdate:force");
      expect(calls.filter((call) => call.startsWith("installUpdate"))).toEqual([]);
    });

    it("updates the service first when found while the question is open, with sessionStorage", async () => {
      const store = useSessionStorage();
      registerConfirmDialogHost();
      await failAsNotAvailable();
      expect(store.has(LACKED_RELEASE_KEY)).toBe(true);
      checked = RUNNING;
      await pressAbout();
      expect(readConfirmDialogState()).toMatchObject({ confirmLabel: "Restart when idle" });
      await agentFindsRelease();
      expect(store.has(LACKED_RELEASE_KEY)).toBe(false);
      calls.length = 0;
      await answerDialog("alternate");
      expect(readConfirmDialogState()).toMatchObject({
        status: "confirming",
        confirmLabel: "Stop and update now",
      });
      await answerDialog(true);
      expect(calls).toEqual(STOP_AND_INSTALL);
    });

    it("updates the service first when found during the wait for idle, with sessionStorage", async () => {
      const store = useSessionStorage();
      await waitForIdleAfterNotAvailable();
      expect(store.has(LACKED_RELEASE_KEY)).toBe(true);
      await agentFindsRelease();
      expect(store.has(LACKED_RELEASE_KEY)).toBe(false);
      checked = { idle: true, stoppedThreads: 0, blockers: [] };
      calls.length = 0;
      for (let step = 0; step < 6; step += 1) await advance(5_000);
      expect(calls).toContain("installServiceUpdate:force");
      expect(calls.filter((call) => call.startsWith("installUpdate"))).toEqual([]);
    });

    it("ends a wait for idle whose question about the service update is cancelled", async () => {
      await waitForIdleAfterNotAvailable();
      await agentFindsRelease();
      checked = RUNNING;
      // The wait comes due while work runs: the service update asks before it stops it.
      for (let step = 0; step < 26; step += 1) await advance(5_000);
      expect(readConfirmDialogState()).toMatchObject({
        status: "confirming",
        confirmLabel: "Stop and update now",
      });
      calls.length = 0;
      await answerDialog(false);
      await advance(30_000);
      expect(readConfirmDialogState()).toMatchObject({ status: "idle" });
      expect(label()).not.toMatch(/^Restarts when idle/);
      // Nothing is stopped or restarted: neither the service nor the app.
      expect(calls).toEqual([]);
    });

    it("restarts nothing when the service's question after the app's is cancelled", async () => {
      registerConfirmDialogHost();
      await failAsNotAvailable();
      checked = RUNNING;
      await pressAbout();
      expect(readConfirmDialogState()).toMatchObject({ confirmLabel: "Restart when idle" });
      await agentFindsRelease();
      await answerDialog("alternate");
      expect(readConfirmDialogState()).toMatchObject({
        status: "confirming",
        confirmLabel: "Stop and update now",
      });
      calls.length = 0;
      await answerDialog(false);
      await advance(30_000);
      expect(calls).toEqual([]);
      expect(label()).toBe("Update now");
    });

    /** A press while the restart waits for idle restarts now: the service first. */
    async function pressHandsOverToService(press: () => Promise<unknown>) {
      await waitForIdleAfterNotAvailable();
      await agentFindsRelease();
      checked = RUNNING;
      await press();
      expect(readConfirmDialogState()).toMatchObject({ confirmLabel: "Restart when idle" });
      await answerDialog("alternate");
      expect(readConfirmDialogState()).toMatchObject({ confirmLabel: "Stop and update now" });
      calls.length = 0;
      await answerDialog(true);
      // Its look came before its question.
      expect(calls).toEqual(STOP_AND_INSTALL.slice(1));
      expect(label()).toBe("Updating…");
      expect(String(button()?.props["aria-label"])).not.toContain("once running work finishes");
    }

    it("ends the wait for idle once a press hands it over to the service update", async () => {
      await pressHandsOverToService(click);
    });

    it("ends the wait for idle once About hands it over, as the button does", async () => {
      await pressHandsOverToService(() => pressAbout());
    });

    it("restarts the app alone when the service took the release while the question was open", async () => {
      registerConfirmDialogHost();
      await failAsNotAvailable();
      checked = RUNNING;
      await pressAbout();
      expect(readConfirmDialogState()).toMatchObject({ confirmLabel: "Restart when idle" });
      await serviceTakesRelease();
      calls.length = 0;
      await answerDialog("alternate");
      // The look came before the question: the drain and the app's install follow.
      expect(calls).toEqual(APP_ONLY.slice(1));
    });

    it("restarts the app alone once idle when the service took the release meanwhile", async () => {
      await waitForIdleAfterNotAvailable();
      await serviceTakesRelease();
      checked = { idle: true, stoppedThreads: 0, blockers: [] };
      calls.length = 0;
      for (let step = 0; step < 6; step += 1) await advance(5_000);
      // Nothing is stopped for the service, which already runs 0.2.5.
      expect(calls).toEqual(APP_ONLY);
    });
  });

  describe("beside another update", () => {
    it("keeps the failure while a Try again still asks, when the app restarts on its own", async () => {
      registerConfirmDialogHost();
      await failAsNotAvailable();
      checked = RUNNING;
      await pressAbout();
      expect(readConfirmDialogState()).toMatchObject({ confirmLabel: "Restart when idle" });
      // Try again asks the service meanwhile: its question waits for the open one.
      await pressTryAgain();
      state.closeToast.mockClear();
      calls.length = 0;
      await answerDialog("alternate");
      expect(calls).toContain("installUpdate:0.2.5");
      expect(state.closeToast).not.toHaveBeenCalled();
      expect(lastToast().description).toBe(NOT_AVAILABLE);
      // Its question answered, the Try again goes on.
      expect(readConfirmDialogState()).toMatchObject({
        status: "confirming",
        confirmLabel: "Stop and update now",
      });
      await answerDialog(true);
      expect(calls).toContain("installServiceUpdate:force");
    });

    it("keeps following another window's update that went live while the question was open", async () => {
      registerConfirmDialogHost();
      await failAsNotAvailable();
      checked = RUNNING;
      await pressAbout();
      expect(readConfirmDialogState()).toMatchObject({
        status: "confirming",
        confirmLabel: "Restart when idle",
      });
      // While the question is open, another window presses Update now: its agent has the release now.
      await otherWindowPressesUpdateNow();
      await answerDialog(true);
      expect(label()).toBe("Updating…");
      // Once idle, the app's install follows that update instead of restarting into it.
      checked = { idle: true, stoppedThreads: 0, blockers: [], held: true };
      calls.length = 0;
      await advance(15_000);
      await advance(2_000);
      expect(calls.filter((call) => call.startsWith("installUpdate"))).toEqual([]);
    });

    it("restarts the app alone, once idle, beside a request without a hold time", async () => {
      await waitForIdleAfterNotAvailable();
      // Another window's request, written without a hold time, holds the service.
      const requestedAt = Date.now();
      agent = {
        ...serviceWaiting,
        updatedAt: new Date(requestedAt + 500).toISOString(),
        pendingInstall: {
          requestedAt: new Date(requestedAt).toISOString(),
          mode: "force",
          version: "0.2.5",
          holdUntil: null,
          handled: false,
        },
      };
      checked = { ...RUNNING, held: true };
      state.service = agent;
      rerender();
      await advance(0);
      // Followed, but with no hold time it is not live: the button may press again.
      expect(label()).toBe("Update now");
      checked = { idle: true, stoppedThreads: 0, blockers: [], held: true };
      calls.length = 0;
      await advance(15_000);
      await advance(2_000);
      expect(calls).not.toContain("installServiceUpdate:force");
      expect(calls).toContain("installUpdate:0.2.5");
    });

    it("shows another window's update it follows, not the app's restart alone", async () => {
      // The app downloaded 0.2.6, which the agent lacks.
      state.app = { ...downloaded, availableVersion: "0.2.6", downloadedVersion: "0.2.6" };
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
      agent = {
        ...agent,
        updatedAt: new Date(Date.now() + 1_000).toISOString(),
        pendingInstall: null,
      };
      await advance(2_000);
      expect(lastToast().description).toBe(
        "SpecWithCode 0.2.6 is not available to the service on this Mac yet.",
      );
      closeToastWithX();
      await advance(0);
      // Another window updates the service to 0.2.5, the release its agent found; the work is held.
      const requestedAt = Date.now() + 2_000;
      checked = { ...RUNNING, held: true };
      agent = {
        ...serviceWaiting,
        status: "waiting-for-quiet",
        message: "Work is running (attempt 1)",
        updatedAt: new Date(requestedAt + 1_000).toISOString(),
        pendingInstall: pendingForce(requestedAt),
      };
      state.service = agent;
      rerender();
      await advance(0);
      await advance(2_000);
      expect(label()).toBe("Updating…");
    });
  });
});

describe("a press while another update step runs", () => {
  it("About does nothing while the app's install is under way", async () => {
    state.service = null;
    bridge.installUpdate.mockImplementationOnce((options?: { expectedVersion?: string }) => {
      calls.push(`installUpdate:${options?.expectedVersion ?? ""}`);
      return new Promise<never>(() => undefined);
    });
    render();
    await click();
    expect(calls.at(-1)).toBe("installUpdate:0.2.5");
    calls.length = 0;
    expect(await pressAbout()).toBe(true);
    await advance(2_000);
    expect(calls).toEqual([]);
  });

  it("About does nothing while the restart question is open", async () => {
    registerConfirmDialogHost();
    state.service = null;
    checked = RUNNING;
    render();
    await click();
    expect(readConfirmDialogState()).toMatchObject({ status: "confirming" });
    calls.length = 0;
    expect(await pressAbout()).toBe(true);
    expect(calls).toEqual([]);
  });

  it("About does nothing while the newest release is looked up", async () => {
    state.service = null;
    bridge.checkForUpdate.mockImplementationOnce(() => new Promise<never>(() => undefined));
    render();
    await click();
    expect(bridge.checkForUpdate).toHaveBeenCalledTimes(1);
    calls.length = 0;
    expect(await pressAbout()).toBe(true);
    await advance(2_000);
    expect(bridge.checkForUpdate).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
  });

  it("About does not restart the app while Try again asks about running work", async () => {
    registerConfirmDialogHost();
    await failAsNotAvailable();
    checked = RUNNING;
    await pressTryAgain();
    expect(readConfirmDialogState()).toMatchObject({ status: "confirming" });
    checked = { idle: true, stoppedThreads: 0, blockers: [] };
    calls.length = 0;
    expect(await pressAbout()).toBe(true);
    await advance(2_000);
    expect(calls.filter((call) => call.startsWith("installUpdate"))).toEqual([]);
  });

  it("About says nothing during a service-only restart", async () => {
    state.app = noAppUpdate();
    state.service = serviceWaiting;
    render();
    await click();
    expect(calls).toEqual(STOP_AND_INSTALL);
    agent = { ...serviceWaiting, status: "installed", installedVersion: "0.2.5" };
    await advance(2_000);
    expect(label()).toBe("Restarting…");
    state.addToast.mockClear();
    expect(await pressAbout()).toBe(true);
    expect(state.addToast).not.toHaveBeenCalledWith(FINISHING);
  });

  it("About during a cancel does not say the service update is finishing", async () => {
    state.service = serviceWaiting;
    render();
    await click();
    expect(calls).toEqual(STOP_AND_INSTALL);
    const finishCancel = slowCancel();
    let cancelled: Promise<void> = Promise.resolve();
    act(() => {
      cancelled = cancelServiceUpdate();
    });
    state.addToast.mockClear();
    expect(await pressAbout()).toBe(true);
    expect(state.addToast).not.toHaveBeenCalledWith(FINISHING);
    await act(async () => {
      finishCancel();
      await cancelled;
    });
  });

  it("a wait for idle tries again after a restart that could not get the newest release", async () => {
    await waitForIdleAfterNotAvailable();
    bridge.checkForUpdate.mockImplementationOnce(async () => ({
      checked: true,
      state: {
        ...downloaded,
        status: "error",
        downloadedVersion: null,
        message: "Feed unreachable",
      },
    }));
    checked = { idle: true, stoppedThreads: 0, blockers: [] };
    calls.length = 0;
    await advance(15_000);
    expect(calls.filter((call) => call.startsWith("installUpdate"))).toEqual([]);
    await advance(15_000);
    expect(calls).toContain("installUpdate:0.2.5");
  });

  it("asks the service when neither the version it gets nor the one it runs is known", async () => {
    state.app = noAppUpdate();
    agent = {
      ...serviceWaiting,
      installedVersion: null,
      availableVersion: null,
      downloadedVersion: null,
    };
    state.service = agent;
    render();
    expect(label()).toBe("Update now");
    await click();
    expect(calls).toEqual(STOP_AND_INSTALL);
  });

  it("asks nothing of the service for a press made on an older state, once it runs that version", async () => {
    state.app = noAppUpdate();
    // The desktop published that the agent installed 0.2.5 on its own.
    agent = {
      ...serviceWaiting,
      status: "up-to-date",
      installedVersion: "0.2.5",
      availableVersion: null,
      downloadedVersion: null,
      updatedAt: new Date().toISOString(),
    };
    state.service = agent;
    render();
    // Settings still shows the state from before, with 0.2.5 waiting.
    const older = { ...serviceWaiting, updatedAt: new Date(Date.now() - 60_000).toISOString() };
    let started: unknown;
    await act(async () => {
      started = await startServiceUpdateNow(older);
    });
    expect(started).toBe(true);
    expect(calls).toEqual([]);
  });

  it("installs the app with the newest restart when the service already runs the version asked for", async () => {
    // Update now for both: the agent installs 0.2.5, then reports an error this window reads.
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
    agent = {
      ...serviceWaiting,
      status: "error",
      installedVersion: "0.2.5",
      message: "Could not remove the previous release.",
      updatedAt: new Date(Date.now() + 1_000).toISOString(),
    };
    await advance(2_000);
    expect(label()).toBe("Retry update");
    closeToastWithX();
    await advance(0);
    // Asking the feed for the newest release takes a moment.
    bridge.checkForUpdate.mockImplementation(
      () =>
        new Promise<{ checked: boolean; state: DesktopUpdateState }>((resolve) => {
          setTimeout(() => resolve({ checked: true, state: state.app ?? downloaded }), 300);
        }),
    );
    calls.length = 0;
    await click();
    await advance(300);
    await advance(0);
    await advance(1_000);
    expect(calls).toEqual(APP_ONLY);
  });
});

describe("an app restart when the service cannot say what runs", () => {
  /** From now on the service answers no look, and no stop. */
  function serviceStopsAnswering() {
    state.prepare.mockImplementation(async (value: { input: ServerPrepareServiceUpdateInput }) => {
      calls.push(prepareCall(value.input));
      return { _tag: "Failure" };
    });
  }

  it("asks before it restarts, rather than restarting at once", async () => {
    serviceStopsAnswering();
    registerConfirmDialogHost();
    render();
    expect(label()).toBe("Restart to update");
    await click();
    expect(readConfirmDialogState()).toMatchObject({
      status: "confirming",
      message: APP_RESTART_UNKNOWN,
    });
    expect(calls).toEqual(["prepare:false"]);
    expect(bridge.installUpdate).not.toHaveBeenCalled();
  });

  it("keeps waiting for idle while the service no longer says what runs", async () => {
    checked = RUNNING;
    registerConfirmDialogHost();
    render();
    await click();
    await answerDialog(true);
    expect(label()).toBe("Restarts when idle, or in 2:00");
    serviceStopsAnswering();
    calls.length = 0;
    await advance(31_000);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call === "prepare:false")).toBe(true);
    expect(bridge.installUpdate).not.toHaveBeenCalled();
    expect(label()).toMatch(/^Restarts when idle, or in 1:2\d$/);
  });
});
