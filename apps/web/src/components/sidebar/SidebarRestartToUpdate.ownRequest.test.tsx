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

// "Update now" for a request this window wrote, when another window cancels
// it, a press only follows another window's request, the window reloads, or a
// stop answers after the attempt ended.

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

import { resetConfirmDialogForTests } from "../../confirmDialog";
import {
  cancelServiceUpdate,
  resetServiceUpdateFlowForTests,
  SERVICE_HOLD_ENDED,
  SERVICE_REQUEST_EXPIRED,
} from "../serviceUpdateFlow";
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

const OWN_REQUEST_KEY = "specwithcode.serviceUpdate.ownRequest";
const FOLLOW_UP_KEY = "specwithcode.serviceUpdate.thenInstallApp";
const STOP_AND_INSTALL = ["prepare:false", "prepare:true+hold", "installServiceUpdate:force"];

const IDLE: ServerPrepareServiceUpdateResult = { idle: true, stoppedThreads: 0, blockers: [] };
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
// What a look (stopWork false) reports.
let checked: ServerPrepareServiceUpdateResult = IDLE;
// Whether each stop holds the work, in turn; true once these run out. A
// function answers only when the stop's drain ends.
let stopHolds: Array<boolean | (() => Promise<boolean>)> = [];
// Looks answer only once these resolve, in turn.
let lookWaits: Array<Promise<void>> = [];
const reload = vi.fn();

function prepareCall(input: ServerPrepareServiceUpdateInput): string {
  if (input.releaseHold) return "prepare:release";
  const reason = input.reason === "app-restart" ? ":app-restart" : "";
  return `prepare:${input.stopWork}${input.hold ? `+hold${reason}` : ""}`;
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
  cancelServiceUpdate: vi.fn<() => Promise<StudioServiceUpdateState>>(),
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
    data?: { secondaryActionProps?: { children: unknown; onClick?: () => void } };
  };
}

async function pressCancelInToast() {
  const cancel = lastToast().data?.secondaryActionProps;
  expect(cancel?.children).toBe("Cancel update");
  await act(async () => {
    cancel?.onClick?.();
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

/** The desktop publishes the agent's newest state. */
async function publish(next: StudioServiceUpdateState) {
  agent = next;
  state.service = next;
  rerender();
  await advance(0);
}

const iso = (ms: number) => new Date(ms).toISOString();

/** A forced request the desktop reports as pending, written at `requestedAt`. */
function pendingForce(
  requestedAt: number,
): NonNullable<StudioServiceUpdateState["pendingInstall"]> {
  return {
    requestedAt: iso(requestedAt),
    mode: "force",
    version: "0.2.5",
    holdUntil: iso(requestedAt + 15 * 60_000),
    handled: false,
  };
}

/** The agent's state once another window cancelled the request: none is pending. */
const cancelledElsewhere = (): StudioServiceUpdateState => ({
  ...serviceWaiting,
  status: "downloaded",
  message: "Update cancelled",
  updatedAt: iso(Date.now() + 1_000),
  pendingInstall: null,
});

/** The next stop's drain ends only once the returned function runs, held unless told otherwise. */
function slowStop(): (held?: boolean) => Promise<void> {
  let finish: (held: boolean) => void = () => undefined;
  stopHolds.push(() => new Promise<boolean>((resolve) => (finish = resolve)));
  return async (held = true) => {
    await act(async () => finish(held));
    await advance(0);
  };
}

/** The agent's state before the press: up to date, without 0.2.5. */
const lacksRelease = (): StudioServiceUpdateState => ({
  ...serviceWaiting,
  status: "up-to-date",
  availableVersion: null,
  downloadedVersion: null,
  updatedAt: iso(Date.now() - 60_000),
  pendingInstall: null,
});

/**
 * Update now before the agent has 0.2.5: the service refuses to hold the work.
 * The desktop reports the request pending from then on. Returns when it was asked.
 */
async function pressBeforeAgentHasRelease(): Promise<number> {
  stopHolds.unshift(false);
  agent = lacksRelease();
  state.service = agent;
  render();
  const pressedAt = Date.now();
  await click();
  expect(calls).toEqual(STOP_AND_INSTALL);
  agent = { ...agent, pendingInstall: pendingForce(pressedAt) };
  return pressedAt;
}

/** The agent fetched 0.2.5 for the request at `pressedAt`. */
const agentHasRelease = (pressedAt: number): StudioServiceUpdateState => ({
  ...serviceWaiting,
  status: "downloaded",
  updatedAt: iso(pressedAt + 1_000),
  pendingInstall: pendingForce(pressedAt),
});

/** Once the agent has the release, the work is stopped again; that stop still drains. */
async function pressThenSecondStopDrains() {
  const pressedAt = await pressBeforeAgentHasRelease();
  const finishStop = slowStop();
  agent = agentHasRelease(pressedAt);
  await advance(2_000);
  expect(calls).toEqual([...STOP_AND_INSTALL, "prepare:true+hold"]);
  calls.length = 0;
  return { pressedAt, finishStop };
}

/** The next look answers only once the returned function runs, with what `checked` says then. */
function slowLook(): () => Promise<void> {
  let finish: () => void = () => undefined;
  lookWaits.push(new Promise<void>((resolve) => (finish = resolve)));
  return async () => {
    await act(async () => finish());
    await advance(0);
  };
}

const appHas026: DesktopUpdateState = {
  ...downloaded,
  availableVersion: "0.2.6",
  downloadedVersion: "0.2.6",
};

const asksAgain = () =>
  calls.filter(
    (call) => call.startsWith("prepare:true") || call.startsWith("installServiceUpdate"),
  );

/**
 * Update now, then the agent lets the request lapse while work winds down:
 * the desktop reports none pending, and the request is renewed. With `slow`,
 * the renewal's stop drains until the returned function runs.
 */
async function pressThenLapse(slow = false) {
  state.service = serviceWaiting;
  render();
  const pressedAt = Date.now();
  await click();
  expect(calls).toEqual(STOP_AND_INSTALL);
  agent = {
    ...serviceWaiting,
    message: "Waiting for open terminals to close",
    updatedAt: iso(pressedAt + 500),
    pendingInstall: pendingForce(pressedAt),
  };
  await advance(2_000);
  const finishStop = slow ? slowStop() : null;
  calls.length = 0;
  agent = {
    ...serviceWaiting,
    status: "error",
    message: SERVICE_REQUEST_EXPIRED,
    updatedAt: iso(Date.now()),
    pendingInstall: null,
  };
  await advance(2_000);
  return finishStop;
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
  checked = IDLE;
  stopHolds = [];
  lookWaits = [];
  state.prepare.mockReset();
  state.prepare.mockImplementation(async (value: { input: ServerPrepareServiceUpdateInput }) => {
    calls.push(prepareCall(value.input));
    if (!value.input.stopWork) {
      const wait = lookWaits.shift();
      if (wait !== undefined) await wait;
      return { _tag: "Success", value: checked };
    }
    const next = stopHolds.shift() ?? true;
    const held = typeof next === "function" ? await next() : next;
    return { _tag: "Success", value: { ...IDLE, held } };
  });
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
  bridge.cancelServiceUpdate.mockImplementation(async () => {
    calls.push("cancelServiceUpdate");
    // The desktop withdraws the request: none is pending any more.
    agent = { ...agent, pendingInstall: null };
    return { ...agent };
  });
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

describe("Update now for a request this window wrote", () => {
  describe("cancelled in another window", () => {
    it("asks nothing more once the agent ends its pass for the cancel", async () => {
      const pressedAt = await pressBeforeAgentHasRelease();
      agent = { ...agentHasRelease(pressedAt), status: "downloading", downloadedVersion: null };
      await advance(2_000);
      calls.length = 0;
      // Another window cancels: none pending, nothing held. The agent then ends
      // its pass with the release on disk.
      checked = { ...IDLE, held: false };
      agent = cancelledElsewhere();
      await advance(40_000);
      expect(asksAgain()).toEqual([]);
      expect(state.closeToast).toHaveBeenCalledWith("toast-1");
    });

    it("ends quietly when the agent writes nothing after the cancel", async () => {
      const pressedAt = await pressBeforeAgentHasRelease();
      agent = { ...agentHasRelease(pressedAt), status: "downloading", downloadedVersion: null };
      await advance(2_000);
      calls.length = 0;
      // The other window's Cancel: none pending, nothing held, and the agent quiet since.
      checked = { ...IDLE, held: false };
      agent = { ...agent, pendingInstall: null };
      await advance(2_000);
      expect(state.closeToast).toHaveBeenCalledWith("toast-1");
      await advance(60_000);
      expect(asksAgain()).toEqual([]);
    });

    it("never asks again for a request cancelled before the agent answered it", async () => {
      await pressBeforeAgentHasRelease();
      await advance(2_000);
      calls.length = 0;
      // The agent has written nothing since the request; the desktop reports none pending.
      checked = { ...IDLE, held: false };
      agent = { ...agent, pendingInstall: null };
      await advance(60_000);
      expect(asksAgain()).toEqual([]);
    });

    it("lets the work start again when it cancels while the second stop drains", async () => {
      const { finishStop } = await pressThenSecondStopDrains();
      checked = { ...IDLE, held: false };
      agent = cancelledElsewhere();
      await advance(2_000);
      expect(state.closeToast).toHaveBeenCalledWith("toast-1");
      // The drain ends and the service holds the work again at its end: let it go.
      await finishStop();
      await advance(30_000);
      expect(calls).toEqual(["prepare:release"]);
    });

    it("does not ask again when the cancel lands just before the second stop answers", async () => {
      const { finishStop } = await pressThenSecondStopDrains();
      // Cancelled after this window last read the agent; the drain then answers held.
      agent = cancelledElsewhere();
      await finishStop();
      expect(calls).toEqual(["prepare:release"]);
      expect(state.closeToast).toHaveBeenCalledWith("toast-1");
      await advance(30_000);
      expect(asksAgain()).toEqual([]);
      expect(label()).toBe("Update now");
    });

    it("lets work start again on its own Cancel, whatever the agent wrote meanwhile", async () => {
      state.service = serviceWaiting;
      render();
      const pressedAt = Date.now();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      agent = {
        ...serviceWaiting,
        updatedAt: iso(pressedAt + 500),
        pendingInstall: pendingForce(pressedAt),
      };
      await advance(2_000);
      let finishCancel: (value: StudioServiceUpdateState) => void = () => undefined;
      bridge.cancelServiceUpdate.mockImplementationOnce(() => {
        calls.push("cancelServiceUpdate");
        return new Promise<StudioServiceUpdateState>((resolve) => (finishCancel = resolve));
      });
      let cancelled: Promise<void> = Promise.resolve();
      act(() => {
        cancelled = cancelServiceUpdate();
      });
      // The withdrawal is written and the agent ends its pass before the desktop answers.
      agent = cancelledElsewhere();
      await advance(2_000);
      await act(async () => {
        finishCancel({ ...agent });
        await cancelled;
      });
      expect(calls.slice(STOP_AND_INSTALL.length)).toEqual([
        "cancelServiceUpdate",
        "prepare:release",
      ]);
    });

    it("follows the request while a slow desktop still writes it", async () => {
      agent = { ...serviceWaiting, updatedAt: iso(Date.now() - 60_000), pendingInstall: null };
      state.service = agent;
      let answer: (value: StudioServiceUpdateState) => void = () => undefined;
      bridge.installServiceUpdate.mockImplementationOnce(() => {
        calls.push("installServiceUpdate:force");
        return new Promise<StudioServiceUpdateState>((resolve) => (answer = resolve));
      });
      render();
      const pressedAt = Date.now();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      // A read before the request is written: the agent's state from before it, none pending.
      await advance(2_000);
      await act(async () => answer({ ...agent, pendingInstall: pendingForce(pressedAt) }));
      expect(state.closeToast).not.toHaveBeenCalled();
      expect(label()).toBe("Updating…");
    });

    it("is not ended by what the agent wrote, without a time, for an earlier cancel", async () => {
      // An agent that does not say when it wrote, read before the request: none pending.
      agent = {
        ...serviceWaiting,
        status: "downloaded",
        message: "Update cancelled",
        pendingInstall: null,
      };
      state.service = agent;
      render();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      await advance(4_000);
      expect(state.closeToast).not.toHaveBeenCalled();
      expect(label()).toBe("Updating…");
    });

    it("says so when the hold runs out, also when the desktop reports the request lapsed", async () => {
      state.service = serviceWaiting;
      render();
      const pressedAt = Date.now();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      checked = { ...RUNNING, held: true };
      agent = {
        ...serviceWaiting,
        updatedAt: iso(pressedAt + 500),
        pendingInstall: pendingForce(pressedAt),
      };
      await advance(15 * 60_000);
      // The agent gives up as the hold ends; the desktop reports the request lapsed.
      checked = { ...RUNNING, held: false };
      agent = {
        ...agent,
        message: "Work is still running",
        updatedAt: iso(Date.now()),
        pendingInstall: null,
      };
      await advance(12_000);
      expect(lastToast()).toMatchObject({ type: "error", description: SERVICE_HOLD_ENDED });
    });

    it("does not stop the work again once the request lapsed before the agent had the release", async () => {
      const pressedAt = await pressBeforeAgentHasRelease();
      checked = { ...RUNNING, held: false };
      agent = { ...agentHasRelease(pressedAt), status: "downloading", downloadedVersion: null };
      await advance(15 * 60_000);
      calls.length = 0;
      // The download took longer than the hold: the desktop reports the request lapsed.
      agent = { ...agentHasRelease(pressedAt), updatedAt: iso(Date.now()), pendingInstall: null };
      await advance(4_000);
      expect(asksAgain()).toEqual([]);
    });
  });

  describe("a look that answers after the install began", () => {
    it("keeps following the install, though the service says nothing is held", async () => {
      state.service = serviceWaiting;
      render();
      const pressedAt = Date.now();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      agent = {
        ...serviceWaiting,
        updatedAt: iso(pressedAt + 500),
        pendingInstall: pendingForce(pressedAt),
      };
      const answerLook = slowLook();
      // The look 10 seconds on is still under way when the agent starts installing.
      await advance(10_000);
      agent = {
        ...agent,
        status: "installing",
        updatedAt: iso(Date.now()),
        pendingInstall: { ...pendingForce(pressedAt), handled: true },
      };
      await advance(2_000);
      expect(label()).toBe("Installing…");
      checked = { ...IDLE, held: false };
      await answerLook();
      expect(label()).toBe("Installing…");
      expect(state.closeToast).not.toHaveBeenCalled();
    });
  });

  describe("a stop that answers after the attempt ended", () => {
    it("lets the hold go when this window's Cancel came first", async () => {
      const { finishStop } = await pressThenSecondStopDrains();
      await pressCancelInToast();
      expect(calls).toEqual(["cancelServiceUpdate", "prepare:release"]);
      calls.length = 0;
      await finishStop();
      expect(calls).toEqual(["prepare:release"]);
    });

    it("lets the hold go when the install failed first", async () => {
      const { finishStop } = await pressThenSecondStopDrains();
      agent = {
        ...serviceWaiting,
        status: "error",
        message: "SpecWithCode 0.2.5 failed verification",
        updatedAt: iso(Date.now() + 500),
        pendingInstall: null,
      };
      await advance(2_000);
      expect(lastToast().type).toBe("error");
      expect(state.closeToast).not.toHaveBeenCalled();
      calls.length = 0;
      await finishStop();
      expect(calls).toEqual(["prepare:release"]);
    });

    it("keeps a hold the service did not take", async () => {
      const { finishStop } = await pressThenSecondStopDrains();
      await pressCancelInToast();
      calls.length = 0;
      await finishStop(false);
      expect(calls).toEqual([]);
    });

    it("keeps the hold for the update this window started since", async () => {
      const { finishStop } = await pressThenSecondStopDrains();
      await pressCancelInToast();
      // Pressed again: this attempt's own stop still drains, its request not yet written.
      const finishNewStop = slowStop();
      await click();
      expect(label()).toBe("Stopping tasks…");
      calls.length = 0;
      await finishStop();
      expect(calls).toEqual([]);
      await finishNewStop();
      expect(calls).toEqual(["installServiceUpdate:force"]);
    });

    it("keeps the hold for another window's request", async () => {
      const { finishStop } = await pressThenSecondStopDrains();
      await pressCancelInToast();
      // Another window presses Update now meanwhile.
      const requestedAt = Date.now();
      agent = {
        ...serviceWaiting,
        updatedAt: iso(requestedAt + 500),
        pendingInstall: pendingForce(requestedAt),
      };
      calls.length = 0;
      await finishStop();
      expect(calls).toEqual([]);
    });

    it("keeps the hold while the agent installs on its own", async () => {
      const { finishStop } = await pressThenSecondStopDrains();
      await pressCancelInToast();
      agent = {
        ...serviceWaiting,
        status: "installing",
        updatedAt: iso(Date.now() + 500),
        pendingInstall: null,
      };
      calls.length = 0;
      await finishStop();
      expect(calls).toEqual([]);
    });

    it("lets the hold go when Cancel came while a renewed request's stop drained", async () => {
      const finishStop = await pressThenLapse(true);
      expect(calls).toEqual(["prepare:true+hold"]);
      calls.length = 0;
      await pressCancelInToast();
      expect(calls).toEqual(["cancelServiceUpdate", "prepare:release"]);
      expect(state.closeToast).toHaveBeenCalled();
      calls.length = 0;
      await finishStop?.();
      expect(calls).toEqual(["prepare:release"]);
    });
  });

  describe("renewed after the agent let it lapse, on a desktop that reports requests", () => {
    it("asks again, holding the work, though the lapse leaves none pending", async () => {
      await pressThenLapse();
      expect(calls).toEqual(["prepare:true+hold", "installServiceUpdate:force"]);
      expect(lastToast().type).not.toBe("error");
      expect(state.closeToast).not.toHaveBeenCalled();
      expect(label()).toBe("Updating…");
    });

    it("renews once while the renewal's stop drains, then asks", async () => {
      const finishStop = await pressThenLapse(true);
      await advance(40_000);
      // The lapse, read again meanwhile, is no answer to the renewal.
      expect(calls).toEqual(["prepare:true+hold"]);
      expect(lastToast().type).not.toBe("error");
      expect(state.closeToast).not.toHaveBeenCalled();
      calls.length = 0;
      await finishStop?.();
      expect(calls).toEqual(["installServiceUpdate:force"]);
      await advance(10_000);
      expect(lastToast().type).not.toBe("error");
      expect(label()).toBe("Updating…");
    });
  });

  describe("followed from another window, whose hold the service refused", () => {
    /** Another window's request, written `agentWroteAfter` ms before the agent's last state. */
    async function followRefusedRequest(agentWroteAfter: number) {
      const requestedAt = Date.now() - 5_000;
      checked = { ...RUNNING, held: false };
      agent = {
        ...serviceWaiting,
        status: "downloading",
        downloadedVersion: null,
        updatedAt: iso(requestedAt + agentWroteAfter),
        pendingInstall: pendingForce(requestedAt),
      };
      state.service = agent;
      render();
      await advance(0);
      await click();
      expect(calls).toEqual([]);
      expect(label()).toBe("Updating…");
    }

    it("is followed while the desktop reports it", async () => {
      await followRefusedRequest(1_000);
      await advance(30_000);
      expect(label()).toBe("Updating…");
      expect(state.closeToast).not.toHaveBeenCalled();
    });

    it("ends once the desktop no longer reports it", async () => {
      // The agent has not written since that window pressed.
      await followRefusedRequest(-1_000);
      await advance(12_000);
      // The pressing window cancels.
      agent = { ...agent, pendingInstall: null };
      await advance(12_000);
      expect(state.closeToast).toHaveBeenCalledWith("toast-1");
      expect(asksAgain()).toEqual([]);
    });

    it("ends at once when the agent answers the cancel", async () => {
      await followRefusedRequest(1_000);
      await advance(12_000);
      agent = cancelledElsewhere();
      await advance(2_000);
      expect(state.closeToast).toHaveBeenCalledWith("toast-1");
    });

    it("keeps following once a hold it saw is lost while the desktop still reports it", async () => {
      await followRefusedRequest(1_000);
      // The pressing window held the work once its agent had the release.
      checked = { ...RUNNING, held: true };
      await advance(12_000);
      // The service restarted: the new process holds nothing. The window
      // that pressed holds it again; this one only follows.
      checked = { ...RUNNING, held: false };
      calls.length = 0;
      await advance(20_000);
      expect(state.closeToast).not.toHaveBeenCalled();
      expect(label()).toBe("Updating…");
      expect(asksAgain()).toEqual([]);
      // It ends once the desktop no longer reports it.
      agent = { ...agent, pendingInstall: null };
      await advance(10_000);
      expect(state.closeToast).toHaveBeenCalledWith("toast-1");
    });

    it("keeps following a request it found held once the service restarts", async () => {
      const requestedAt = Date.now() - 5_000;
      checked = { ...RUNNING, held: true };
      agent = {
        ...serviceWaiting,
        updatedAt: iso(requestedAt + 500),
        pendingInstall: pendingForce(requestedAt),
      };
      state.service = agent;
      render();
      await advance(0);
      expect(label()).toBe("Updating…");
      checked = { ...RUNNING, held: false };
      calls.length = 0;
      await advance(22_000);
      expect(state.closeToast).not.toHaveBeenCalled();
      expect(label()).toBe("Updating…");
      expect(asksAgain()).toEqual([]);
    });

    it("keeps following a held update past what the agent wrote for an earlier cancel", async () => {
      // Held, its request not written yet; the agent's cancel is from before.
      checked = { ...RUNNING, held: true };
      agent = {
        ...serviceWaiting,
        status: "downloaded",
        message: "Update cancelled",
        updatedAt: iso(Date.now() - 60_000),
        pendingInstall: null,
      };
      state.service = agent;
      render();
      await advance(0);
      expect(state.addToast).toHaveBeenCalled();
      await advance(4_000);
      expect(state.closeToast).not.toHaveBeenCalled();
    });
  });

  describe("after the window that pressed reloaded", () => {
    it("still holds the work once the agent has the release", async () => {
      const store = useSessionStorage();
      const pressedAt = await pressBeforeAgentHasRelease();
      agent = { ...agentHasRelease(pressedAt), status: "downloading", downloadedVersion: null };
      state.service = agent;
      await advance(2_000);
      reloadWindow(store);
      checked = { ...RUNNING, held: false };
      render();
      await advance(0);
      expect(label()).toBe("Updating…");
      calls.length = 0;
      await publish({
        ...agentHasRelease(pressedAt),
        status: "waiting-for-quiet",
        updatedAt: iso(Date.now()),
      });
      await advance(2_000);
      expect(calls).toEqual(["prepare:true+hold", "installServiceUpdate:force"]);
      // The same request as before the reload: the version it named, and its hold.
      expect(bridge.installServiceUpdate.mock.calls.at(-1)?.[0]).toEqual({
        force: true,
        holdUntil: iso(pressedAt + 15 * 60_000),
        version: "0.2.5",
      });
    });

    it("holds the work again when the reload cut off the second stop", async () => {
      const store = useSessionStorage();
      await pressThenSecondStopDrains();
      // The reload interrupts that stop; the service lets its hold go.
      reloadWindow(store);
      checked = { ...RUNNING, held: false };
      state.service = agent;
      render();
      await advance(0);
      expect(label()).toBe("Updating…");
      await advance(2_000);
      expect(asksAgain()).toEqual(["prepare:true+hold", "installServiceUpdate:force"]);
    });

    it("does not stop the work a third time", async () => {
      const store = useSessionStorage();
      stopHolds = [false, false];
      const pressedAt = await pressBeforeAgentHasRelease();
      agent = agentHasRelease(pressedAt);
      await advance(2_000);
      expect(calls).toEqual([...STOP_AND_INSTALL, "prepare:true+hold"]);
      reloadWindow(store);
      checked = { ...RUNNING, held: false };
      state.service = agent;
      render();
      await advance(0);
      expect(label()).toBe("Updating…");
      await advance(4_000);
      expect(asksAgain()).toEqual([]);
    });

    it("does not take up a request it did not write", async () => {
      const store = useSessionStorage();
      store.set(
        OWN_REQUEST_KEY,
        JSON.stringify({
          version: "0.2.5",
          holdUntil: iso(Date.now() + 10 * 60_000),
          holdAskedAgain: false,
        }),
      );
      checked = { ...RUNNING, held: false };
      agent = agentHasRelease(Date.now() - 5_000);
      state.service = agent;
      render();
      await advance(4_000);
      expect(calls).toEqual([]);
      expect(state.addToast).not.toHaveBeenCalled();
    });

    /** The window reloads while its request for 0.2.5 waits; the app found 0.2.6 since. */
    async function reloadAfterPressForOlderRelease(store: Map<string, string>) {
      const pressedAt = await pressBeforeAgentHasRelease();
      agent = { ...agentHasRelease(pressedAt), status: "downloading", downloadedVersion: null };
      state.service = agent;
      await advance(2_000);
      reloadWindow(store);
      state.app = appHas026;
      checked = { ...IDLE, held: false };
      return pressedAt;
    }

    it("keeps a press for a newer release made during its first look", async () => {
      const store = useSessionStorage();
      await reloadAfterPressForOlderRelease(store);
      const answerLook = slowLook();
      render();
      await advance(0);
      const finishStop = slowStop();
      await click();
      expect(label()).toBe("Stopping tasks…");
      // The window's look answers while the press still stops the work.
      await answerLook();
      expect(label()).toBe("Stopping tasks…");
      await finishStop();
      expect(bridge.installServiceUpdate.mock.calls.at(-1)?.[0]).toMatchObject({
        version: "0.2.6",
      });
    });

    it("lets a press for a newer release go on when its look answers after the window's", async () => {
      const store = useSessionStorage();
      await reloadAfterPressForOlderRelease(store);
      const answerWindowLook = slowLook();
      const answerPressLook = slowLook();
      render();
      await advance(0);
      await click();
      await answerWindowLook();
      await answerPressLook();
      expect(bridge.installServiceUpdate.mock.calls.at(-1)?.[0]).toMatchObject({
        version: "0.2.6",
      });
    });

    /** Update now, held while work still runs; then the window reloads. */
    async function pressHeldThenReload(store: Map<string, string>) {
      state.service = serviceWaiting;
      render();
      const pressedAt = Date.now();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      checked = { ...RUNNING, held: true };
      agent = {
        ...serviceWaiting,
        message: "Waiting for open terminals to close",
        updatedAt: iso(pressedAt + 500),
        pendingInstall: pendingForce(pressedAt),
      };
      await advance(2_000);
      reloadWindow(store);
      state.service = agent;
      render();
      await advance(0);
      expect(label()).toBe("Updating…");
      calls.length = 0;
    }

    it("renews its held request when the agent lets it lapse", async () => {
      await pressHeldThenReload(useSessionStorage());
      agent = {
        ...serviceWaiting,
        status: "error",
        message: SERVICE_REQUEST_EXPIRED,
        updatedAt: iso(Date.now()),
        pendingInstall: null,
      };
      await advance(2_000);
      expect(asksAgain()).toEqual(["prepare:true+hold", "installServiceUpdate:force"]);
      expect(lastToast().type).not.toBe("error");
      expect(label()).toBe("Updating…");
    });

    it("says so when the hold of its held request runs out", async () => {
      await pressHeldThenReload(useSessionStorage());
      await advance(15 * 60_000);
      checked = { ...RUNNING, held: false };
      agent = { ...agent, updatedAt: iso(Date.now()), pendingInstall: null };
      await advance(12_000);
      expect(lastToast()).toMatchObject({ type: "error", description: SERVICE_HOLD_ENDED });
      expect(state.closeToast).not.toHaveBeenCalled();
    });

    it("installs the app after the service it followed again", async () => {
      const store = useSessionStorage();
      state.service = serviceWaiting;
      render();
      const pressedAt = Date.now();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      const asked = { ...serviceWaiting, pendingInstall: pendingForce(pressedAt) };
      agent = { ...asked, updatedAt: iso(pressedAt + 500) };
      await advance(2_000);
      reloadWindow(store);
      state.addToast.mockClear();
      checked = { ...RUNNING, held: true };
      state.service = agent;
      render();
      await advance(0);
      // Followed again: the toast shows the update.
      expect(state.addToast).toHaveBeenCalled();
      agent = { ...asked, status: "installing", updatedAt: iso(Date.now()) };
      await advance(2_000);
      agent = {
        ...asked,
        pendingInstall: null,
        status: "installed",
        installedVersion: "0.2.5",
        updatedAt: iso(Date.now()),
        lastInstall: { at: iso(Date.now()), version: "0.2.5", result: "updated" },
      };
      await advance(4_000);
      expect(calls).toContain("installUpdate:0.2.5");
    });

    it("forgets the app's install after a failure no window showed, though its look got no answer", async () => {
      const store = useSessionStorage();
      state.service = serviceWaiting;
      render();
      const pressedAt = Date.now();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      expect(store.has(FOLLOW_UP_KEY)).toBe(true);
      agent = {
        ...serviceWaiting,
        updatedAt: iso(pressedAt + 500),
        pendingInstall: pendingForce(pressedAt),
      };
      await advance(2_000);
      // The window reloads; meanwhile the agent's pass fails, and nothing is pending.
      reloadWindow(store);
      agent = {
        ...serviceWaiting,
        status: "error",
        message: "The download failed.",
        updatedAt: iso(Date.now()),
        pendingInstall: null,
      };
      state.service = agent;
      // The service does not answer the reloaded window's first look.
      state.prepare.mockImplementationOnce(async () => ({ _tag: "Failure" }));
      checked = { ...IDLE, held: false };
      render();
      await advance(0);
      expect(store.has(FOLLOW_UP_KEY)).toBe(false);
      // Later the agent installs 0.2.5 at a quiet moment of its own.
      await publish({
        ...serviceWaiting,
        status: "installing",
        updatedAt: iso(Date.now()),
        pendingInstall: null,
      });
      agent = {
        ...serviceWaiting,
        status: "installed",
        installedVersion: "0.2.5",
        updatedAt: iso(Date.now()),
        pendingInstall: null,
        lastInstall: { at: iso(Date.now()), version: "0.2.5", result: "updated" },
      };
      await advance(7_000);
      expect(calls).not.toContain("installUpdate:0.2.5");
    });

    it("forgets its request once its update ended", async () => {
      const store = useSessionStorage();
      state.service = serviceWaiting;
      render();
      const pressedAt = Date.now();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      expect(store.has(OWN_REQUEST_KEY)).toBe(true);
      agent = {
        ...serviceWaiting,
        updatedAt: iso(pressedAt + 500),
        pendingInstall: pendingForce(pressedAt),
      };
      // Another window cancels: the service lets the work go, and the
      // desktop no longer reports the request.
      checked = { ...RUNNING, held: false };
      agent = { ...agent, pendingInstall: null };
      await advance(12_000);
      expect(state.closeToast).toHaveBeenCalledWith("toast-1");
      expect(store.has(OWN_REQUEST_KEY)).toBe(false);
      reloadWindow(store);
      state.addToast.mockClear();
      state.service = agent;
      render();
      await advance(4_000);
      expect(state.addToast).not.toHaveBeenCalled();
    });
  });
});
