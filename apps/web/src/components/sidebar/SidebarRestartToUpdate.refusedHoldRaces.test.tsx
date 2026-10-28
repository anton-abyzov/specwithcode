import type {
  DesktopUpdateActionResult,
  DesktopUpdateState,
  ServerPrepareServiceUpdateInput,
  ServerPrepareServiceUpdateResult,
  StudioServiceInstallOptions,
  StudioServiceUpdateState,
} from "@specweave-studio/contracts";
import type { ReactElement, ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// "Update now" pressed while the agent lacks the release, so the service
// refuses to hold the work for the request until the agent has it: windows
// that only follow that request, a stop whose answer is lost, a reload, a
// retry, and a service too old to say whether it holds.

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
import { resetServiceUpdateFlowForTests } from "../serviceUpdateFlow";
import { SidebarRestartToUpdate } from "./SidebarRestartToUpdate";
import { SERVICE_RESTARTED } from "./SidebarRestartToUpdate.logic";

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
const IDLE: ServerPrepareServiceUpdateResult = { idle: true, stoppedThreads: 0, blockers: [] };

// What the agent writes for M4's refusal, and around the restart it makes for a held request.
const DETACHED =
  "SpecWithCode cannot be updated right now: The SpecWithCode service is using a database log that was deleted from disk. Restart SpecWithCode, then update";
// What the toast shows for it: the older agent's restart reads as what Update now does.
const DETACHED_SHOWN =
  "SpecWithCode cannot be updated right now: The SpecWithCode service is using a database log that was deleted from disk. Press Update now: SpecWithCode saves that log, restarts its background service and then updates";
const RESTARTING = "Restarting SpecWithCode to recover its database";
const RESTARTED = "Restarted SpecWithCode to recover its database; installing after a quiet moment";

const calls: string[] = [];
let installResult: Omit<DesktopUpdateActionResult, "state">;
let agent: StudioServiceUpdateState = serviceWaiting;
// Whether the service holds its work: a stop that holds takes the hold, a
// release lets it go, and a restart loses it (the hold lives in the process).
let held = false;
// While true, looks get no answer: the service is restarting.
let lookFails = false;
// Runs once the next look has its answer: what changed while it was asked.
let afterLook: (() => void) | null = null;
// How each stop ends, in turn; holding once these run out. "lost": the stop
// held the work, but its answer never reached the window; "none": no answer
// and no hold. A function answers only when the stop's drain ends.
let stopHolds: Array<boolean | "lost" | "none" | (() => Promise<boolean>)> = [];
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

/** The desktop publishes the agent's newest state. */
async function publish(next: StudioServiceUpdateState) {
  agent = next;
  state.service = next;
  rerender();
  await advance(0);
}

const iso = (ms: number) => new Date(ms).toISOString();

/** The next stop's drain ends only once the returned function runs, held unless told otherwise. */
function slowStop(): (holds?: boolean) => Promise<void> {
  let finish: (holds: boolean) => void = () => undefined;
  stopHolds.push(() => new Promise<boolean>((resolve) => (finish = resolve)));
  return async (holds = true) => {
    await act(async () => finish(holds));
    await advance(0);
  };
}

const asksAgain = () =>
  calls.filter(
    (call) => call.startsWith("prepare:true") || call.startsWith("installServiceUpdate"),
  );
const stops = () => calls.filter((call) => call === "prepare:true+hold");

/** M4's state: the agent's last pass refused on a detached database log, with 0.2.5 downloaded. */
const m4Refusal = (): StudioServiceUpdateState => ({
  ...serviceWaiting,
  status: "error",
  checkedAt: iso(Date.now() - 30 * 60_000),
  message: DETACHED,
  updatedAt: iso(Date.now() - 60_000),
  pendingInstall: null,
  agentStartFailed: false,
});

/** The service is back from its restart, holding nothing; the agent waits for a quiet moment. */
async function serviceRestarted() {
  held = false;
  await publish({
    ...agent,
    status: "waiting-for-quiet",
    message: RESTARTED,
    updatedAt: iso(Date.now() + 500),
  });
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
  held = false;
  lookFails = false;
  afterLook = null;
  stopHolds = [];
  state.prepare.mockReset();
  state.prepare.mockImplementation(async (value: { input: ServerPrepareServiceUpdateInput }) => {
    const { input } = value;
    calls.push(prepareCall(input));
    if (input.releaseHold) {
      held = false;
      return { _tag: "Success", value: { ...IDLE, held } };
    }
    if (!input.stopWork) {
      if (lookFails) return { _tag: "Failure" };
      const answer = { ...IDLE, held };
      const after = afterLook;
      afterLook = null;
      after?.();
      return { _tag: "Success", value: answer };
    }
    const next = stopHolds.shift() ?? true;
    if (next === "lost" || next === "none") {
      if (next === "lost") held = true;
      return { _tag: "Failure" };
    }
    const holds = typeof next === "function" ? await next() : next;
    if (holds) held = true;
    return { _tag: "Success", value: { ...IDLE, held: holds } };
  });
  reload.mockReset();
  bridge.getServiceUpdateState.mockReset();
  bridge.getServiceUpdateState.mockImplementation(async () => agent);
  bridge.installUpdate.mockClear();
  bridge.installServiceUpdate.mockReset();
  bridge.installServiceUpdate.mockImplementation(async (options?: StudioServiceInstallOptions) => {
    calls.push(`installServiceUpdate:${options?.force ? "force" : "normal"}`);
    // The desktop stamps each request it takes, with the hold it was given.
    if (options?.holdUntil !== undefined) {
      agent = {
        ...agent,
        pendingInstall: {
          requestedAt: iso(Date.now()),
          mode: "force",
          version: options.version ?? null,
          holdUntil: options.holdUntil,
          handled: false,
        },
      };
    }
    return { ...agent };
  });
  bridge.cancelServiceUpdate.mockReset();
  bridge.cancelServiceUpdate.mockImplementation(async () => {
    calls.push("cancelServiceUpdate");
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

/** The window reloads: its flow starts over, its sessionStorage stays. */
function reloadWindow(store: Map<string, string>) {
  const kept = new Map(store);
  act(() => renderer?.unmount());
  renderer = null;
  resetServiceUpdateFlowForTests();
  for (const [key, value] of kept) store.set(key, value);
  calls.length = 0;
}

/** M4's agent before it fetched 0.2.5: the service refuses to hold work for it. */
const lacksRelease = (): StudioServiceUpdateState => ({
  ...m4Refusal(),
  status: "available",
  message: null,
  downloadedVersion: null,
});

async function installAndFinish() {
  await publish({
    ...agent,
    status: "installing",
    message: "Installing SpecWithCode 0.2.5",
    updatedAt: iso(Date.now() + 500),
    pendingInstall: { ...agent.pendingInstall!, handled: true },
  });
  await advance(8_000);
  await publish({
    ...agent,
    status: "installed",
    installedVersion: "0.2.5",
    availableVersion: null,
    downloadedVersion: null,
    message: null,
    lastInstall: { version: "0.2.5", at: iso(Date.now()), result: "updated" },
    updatedAt: iso(Date.now() + 500),
    pendingInstall: null,
  });
  await advance(8_000);
}

/** The error toasts shown so far, the update's own included. */
function errorToasts(): string[] {
  return [
    ...state.addToast.mock.calls.map((call) => call[0] as { type: string; description: string }),
    ...state.updateToast.mock.calls.map((call) => call[1] as { type: string; description: string }),
  ]
    .filter((toast) => toast.type === "error")
    .map((toast) => toast.description);
}

/** The agent's pass refuses on the detached log. */
async function refuses(changes: Partial<StudioServiceUpdateState> = {}) {
  await publish({
    ...agent,
    status: "error",
    message: DETACHED,
    updatedAt: iso(Date.now() + 500),
    ...changes,
  });
}

/** The agent fetched 0.2.5 for the request. */
async function releaseFetched() {
  await publish({
    ...agent,
    status: "downloaded",
    message: null,
    downloadedVersion: "0.2.5",
    updatedAt: iso(Date.now() + 500),
  });
}

/** Another window's request, written `ago` ms back while the agent lacked the release. */
function otherWindowsRequest(ago: number): StudioServiceUpdateState {
  const at = Date.now() - ago;
  return {
    ...lacksRelease(),
    updatedAt: iso(at - 1_000),
    pendingInstall: {
      requestedAt: iso(at),
      mode: "force",
      version: "0.2.5",
      holdUntil: iso(at + 15 * 60_000),
      handled: false,
    },
  };
}

describe("A window following a request the agent refused before its window held the work", () => {
  it("keeps following it when it pressed while the request was pending", async () => {
    agent = otherWindowsRequest(5_000);
    state.service = agent;
    render();
    await advance(0);
    calls.length = 0;
    await click();
    expect(calls).toEqual([]);
    expect(label()).toBe("Updating…");
    // The agent fetches 0.2.5; the window that asked then holds the work and
    // asks again, after the agent's unheld pass refused on the detached log.
    await releaseFetched();
    await advance(2_000);
    await refuses();
    await advance(4_000);
    expect(errorToasts()).toEqual([]);
    expect(calls).not.toContain("cancelServiceUpdate");
    expect(calls).not.toContain("prepare:release");
    expect(label()).toBe("Updating…");
  });

  it("keeps following it when it took it up from a held service", async () => {
    held = true;
    agent = { ...otherWindowsRequest(5_000), status: "downloaded", downloadedVersion: "0.2.5" };
    state.service = agent;
    render();
    await advance(0);
    expect(label()).toBe("Updating…");
    calls.length = 0;
    await refuses({ updatedAt: iso(Date.now() - 500) });
    await advance(4_000);
    expect(errorToasts()).toEqual([]);
    expect(calls).not.toContain("cancelServiceUpdate");
    expect(calls).not.toContain("prepare:release");
  });

  const cancels = () => calls.filter((call) => call === "cancelServiceUpdate").length;

  it("withdraws it once and shows no error when Cancel is pressed there", async () => {
    agent = otherWindowsRequest(5_000);
    state.service = agent;
    render();
    await advance(0);
    calls.length = 0;
    await click();
    await releaseFetched();
    await advance(2_000);
    await refuses();
    await advance(4_000);
    expect(label()).toBe("Updating…");
    await pressCancelInToast();
    await advance(4_000);
    expect({ cancels: cancels(), errors: errorToasts() }).toEqual({ cancels: 1, errors: [] });
    expect(label()).toBe("Update now");
  });

  it("withdraws it once and shows no error when Cancel is pressed there after it took it up from a held service", async () => {
    held = true;
    agent = { ...otherWindowsRequest(5_000), status: "downloaded", downloadedVersion: "0.2.5" };
    state.service = agent;
    render();
    await advance(0);
    calls.length = 0;
    await refuses({ updatedAt: iso(Date.now() - 500) });
    await advance(4_000);
    expect(label()).toBe("Updating…");
    await pressCancelInToast();
    await advance(4_000);
    expect({ cancels: cancels(), errors: errorToasts() }).toEqual({ cancels: 1, errors: [] });
    expect(label()).toBe("Update now");
  });

  it("takes it up from the refusal without failing, and closing its toast withdraws nothing", async () => {
    // Open and idle, as the window that asked holds the work once the agent
    // has the release.
    agent = { ...otherWindowsRequest(30_000), status: "downloading" };
    state.service = agent;
    render();
    await advance(0);
    expect(label()).toBe("Update now");
    await releaseFetched();
    await advance(1_000);
    held = true;
    calls.length = 0;
    // The agent's unheld pass refuses before that window asks again.
    await refuses();
    await advance(3_000);
    expect(label()).toBe("Updating…");
    // That window asks again under its hold: the desktop stamps the request anew.
    agent = {
      ...agent,
      pendingInstall: { ...agent.pendingInstall!, requestedAt: iso(Date.now()) },
    };
    await publish({
      ...agent,
      status: "waiting-for-quiet",
      message: RESTARTING,
      updatedAt: iso(Date.now() + 500),
    });
    await advance(4_000);
    expect(errorToasts()).toEqual([]);
    const close = (lastToast() as { data?: { onClose?: () => void } }).data?.onClose;
    await act(async () => close?.());
    await advance(2_000);
    expect(calls).not.toContain("cancelServiceUpdate");
    expect(calls).not.toContain("prepare:release");
    expect(held).toBe(true);
  });

  it("fails at once on a refusal that no request gets past", async () => {
    agent = otherWindowsRequest(5_000);
    state.service = agent;
    render();
    await advance(0);
    await click();
    expect(label()).toBe("Updating…");
    await releaseFetched();
    await advance(2_000);
    await refuses({
      message:
        "SpecWithCode cannot be updated right now: the service does not match its installation",
    });
    await advance(2_000);
    expect(errorToasts()).toEqual([
      "SpecWithCode cannot be updated right now: the service does not match its installation",
    ]);
  });

  it("shows the refusal once the request is no longer live", async () => {
    agent = otherWindowsRequest(5_000);
    state.service = agent;
    render();
    await advance(0);
    await click();
    expect(label()).toBe("Updating…");
    await releaseFetched();
    await advance(2_000);
    await refuses();
    await advance(4_000);
    expect(errorToasts()).toEqual([]);
    // The window that asked is gone: the request's hold runs out.
    await advance(15 * 60_000);
    expect(errorToasts().length).toBeGreaterThan(0);
  });
});

/** Every description the update's toasts showed. */
function toastDescriptions(): string[] {
  return [
    ...state.addToast.mock.calls.map((call) => (call[0] as { description: string }).description),
    ...state.updateToast.mock.calls.map((call) => (call[1] as { description: string }).description),
  ].map(String);
}

/**
 * Update now while the agent lacks the release: the service holds nothing for
 * the press, whose stop's answer is lost, and refuses the stop of the first
 * look that finds nothing held. The agent then fetches 0.2.5, and its unheld
 * pass refuses on the detached log while the stop taken for the release drains.
 */
async function pressUnanswered() {
  agent = lacksRelease();
  state.service = agent;
  render();
  await advance(0);
  stopHolds.push("none", false);
  await click();
  expect(calls).toEqual(STOP_AND_INSTALL);
  expect(held).toBe(false);
  calls.length = 0;
  await advance(11_000);
  expect(stops()).toEqual(["prepare:true+hold"]);
  const finishStop = slowStop();
  await releaseFetched();
  await advance(2_000);
  await refuses();
  await advance(2_000);
  await finishStop(true);
  await advance(4_000);
}

describe("Update now when the press's stop got no answer", () => {
  it("holds the work once the agent has the release and asks again, never saying the service restarted", async () => {
    await pressUnanswered();
    expect(errorToasts()).toEqual([]);
    expect(calls).not.toContain("cancelServiceUpdate");
    expect(asksAgain()).toEqual([
      "prepare:true+hold",
      "prepare:true+hold",
      "installServiceUpdate:force",
    ]);
    expect(held).toBe(true);
    expect(toastDescriptions().some((text) => text.includes(SERVICE_RESTARTED))).toBe(false);
  });

  it("says the service restarted once a look found the work held before it", async () => {
    agent = m4Refusal();
    state.service = agent;
    render();
    await advance(0);
    // The stop holds the work, but its answer is lost.
    stopHolds.push("lost");
    await click();
    expect(calls).toEqual(STOP_AND_INSTALL);
    await advance(10_000);
    await serviceRestarted();
    await advance(10_000);
    expect(toastDescriptions().some((text) => text.includes(SERVICE_RESTARTED))).toBe(true);
  });

  it("says the service restarted when it holds the work again a second time", async () => {
    agent = m4Refusal();
    state.service = agent;
    render();
    await advance(0);
    // Neither the press's stop nor the first look's stop gets an answer.
    stopHolds.push("none", "none");
    await click();
    expect(calls).toEqual(STOP_AND_INSTALL);
    calls.length = 0;
    await advance(10_000);
    expect(toastDescriptions().some((text) => text.includes(SERVICE_RESTARTED))).toBe(false);
    held = false;
    await advance(10_000);
    expect(stops()).toEqual(["prepare:true+hold", "prepare:true+hold"]);
    expect(toastDescriptions().some((text) => text.includes(SERVICE_RESTARTED))).toBe(true);
  });
});

describe("Update now on a service too old to say whether it holds", () => {
  it("fails the press when the agent refuses for want of the hold", async () => {
    // Stops and looks answer without `held`, as services before the hold did.
    state.prepare.mockImplementation(async (value: { input: ServerPrepareServiceUpdateInput }) => {
      calls.push(prepareCall(value.input));
      return { _tag: "Success", value: { ...IDLE } };
    });
    agent = m4Refusal();
    state.service = agent;
    render();
    await advance(0);
    await click();
    expect(calls).toEqual(STOP_AND_INSTALL);
    calls.length = 0;
    await refuses();
    await advance(4_000);
    expect(errorToasts()).toEqual([DETACHED_SHOWN]);
    expect(label()).toBe("Retry update");
  });
});

describe("Update now after a reload once the stop taken for the agent's release was refused", () => {
  /**
   * Update now while the agent lacks the release: the service refuses the
   * press's hold, and refuses again once the agent fetched 0.2.5. The window
   * then reloads, its request still pending.
   */
  async function reloadAfterRefusedHold() {
    const store = useSessionStorage();
    agent = lacksRelease();
    state.service = agent;
    render();
    await advance(0);
    stopHolds.push(false, false);
    await click();
    expect(calls).toEqual(STOP_AND_INSTALL);
    calls.length = 0;
    await releaseFetched();
    await advance(2_000);
    expect(calls).toEqual(["prepare:true+hold"]);
    expect(held).toBe(false);
    reloadWindow(store);
    render();
    await advance(0);
    expect(label()).toBe("Updating…");
    state.addToast.mockClear();
    state.updateToast.mockClear();
  }

  it("neither says the service restarted nor stops the work again", async () => {
    await reloadAfterRefusedHold();
    await advance(12_000);
    expect(toastDescriptions().some((text) => text.includes(SERVICE_RESTARTED))).toBe(false);
    expect(asksAgain()).toEqual([]);
    expect(label()).toBe("Updating…");
  });

  it("fails on the agent's refusal, as it did before the reload", async () => {
    await reloadAfterRefusedHold();
    await refuses();
    await advance(4_000);
    expect(errorToasts()).toEqual([DETACHED_SHOWN]);
    expect(label()).toBe("Retry update");
  });

  it("holds the work once the agent answers after a reload when the press's stop got no answer", async () => {
    const store = useSessionStorage();
    agent = m4Refusal();
    state.service = agent;
    render();
    await advance(0);
    // The press's stop gets no answer and holds nothing.
    stopHolds.push("none");
    await click();
    expect(calls).toEqual(STOP_AND_INSTALL);
    // The desktop reports the request.
    await publish({ ...agent });
    reloadWindow(store);
    render();
    await advance(0);
    expect(label()).toBe("Updating…");
    // The agent's pass refuses the unheld request on the detached log.
    await refuses();
    await advance(12_000);
    expect(asksAgain()).toEqual(["prepare:true+hold", "installServiceUpdate:force"]);
    expect(held).toBe(true);
    expect(errorToasts()).toEqual([]);
    // Nothing said the service held the work before the reload, or restarted.
    expect(toastDescriptions().some((text) => text.includes(SERVICE_RESTARTED))).toBe(false);
  });
});

describe("Update now after a reload once the work was stopped again for the agent's release", () => {
  /**
   * Update now while the agent lacks the release: the service refuses the
   * press's hold. The agent fetches 0.2.5, the window stops the work again,
   * and the agent's unheld pass refuses the request while that stop drains.
   * Returns the stop's end.
   */
  async function stopForReleaseDrains(): Promise<(holds?: boolean) => Promise<void>> {
    agent = lacksRelease();
    state.service = agent;
    render();
    await advance(0);
    stopHolds.push(false);
    await click();
    expect(calls).toEqual(STOP_AND_INSTALL);
    calls.length = 0;
    const finishStop = slowStop();
    await releaseFetched();
    await advance(2_000);
    expect(calls).toEqual(["prepare:true+hold"]);
    await refuses();
    await advance(4_000);
    expect(errorToasts()).toEqual([]);
    return finishStop;
  }

  /** The window reloads, its request still pending, and looks at the service. */
  async function reloads(store: Map<string, string>) {
    reloadWindow(store);
    state.service = agent;
    render();
    await advance(0);
  }

  it("asks again under the hold when it reloaded before it did, and installs both", async () => {
    const store = useSessionStorage();
    const finishStop = await stopForReleaseDrains();
    // The stop holds the work; the read before the request is asked again
    // under that hold gets no answer before the window reloads.
    bridge.getServiceUpdateState.mockImplementationOnce(() => new Promise(() => undefined));
    await finishStop(true);
    expect(held).toBe(true);
    await reloads(store);
    await advance(4_000);
    expect(errorToasts()).toEqual([]);
    expect(asksAgain()).toEqual(["installServiceUpdate:force"]);
    expect(held).toBe(true);
    await installAndFinish();
    expect(calls).toContain("installUpdate:0.2.5");
  });

  it("asks again under the hold a stop the reload cut off took all the same", async () => {
    const store = useSessionStorage();
    const finishStop = await stopForReleaseDrains();
    reloadWindow(store);
    await finishStop(true);
    expect(held).toBe(true);
    state.service = agent;
    render();
    await advance(4_000);
    expect(errorToasts()).toEqual([]);
    expect(asksAgain()).toEqual(["installServiceUpdate:force"]);
    await installAndFinish();
    expect(calls).toContain("installUpdate:0.2.5");
  });

  it("stops the work again when the service let go of the hold the reload cut off", async () => {
    const store = useSessionStorage();
    await stopForReleaseDrains();
    // The service ends the drain the reload cut off, and the hold it took.
    await reloads(store);
    await advance(4_000);
    expect(errorToasts()).toEqual([]);
    expect(asksAgain()).toEqual(["prepare:true+hold", "installServiceUpdate:force"]);
    expect(held).toBe(true);
    await installAndFinish();
    expect(calls).toContain("installUpdate:0.2.5");
  });

  it("fails on a refusal written after the request was asked again under the hold, after a reload", async () => {
    const store = useSessionStorage();
    const finishStop = await stopForReleaseDrains();
    await finishStop(true);
    expect(asksAgain()).toEqual(["prepare:true+hold", "installServiceUpdate:force"]);
    await reloads(store);
    await advance(4_000);
    expect(errorToasts()).toEqual([]);
    // Asked under the hold before the reload: not asked again.
    expect(asksAgain()).toEqual([]);
    await refuses();
    await advance(4_000);
    expect(errorToasts()).toEqual([DETACHED_SHOWN]);
  });

  it("fails on the agent's refusal after a reload once that stop was refused too, though the work is held since", async () => {
    const store = useSessionStorage();
    agent = lacksRelease();
    state.service = agent;
    render();
    await advance(0);
    stopHolds.push(false, false);
    await click();
    calls.length = 0;
    await releaseFetched();
    await advance(2_000);
    expect(calls).toEqual(["prepare:true+hold"]);
    // A hold this window did not take.
    held = true;
    await reloads(store);
    await refuses();
    await advance(4_000);
    expect(asksAgain()).toEqual([]);
    expect(errorToasts()).toEqual([DETACHED_SHOWN]);
  });
});

describe("Update now when the agent's refusal of the unheld request is still its state after the hold", () => {
  it("waits for the agent's answer to the request asked again under the hold, then installs both", async () => {
    agent = lacksRelease();
    state.service = agent;
    render();
    await advance(0);
    stopHolds.push(false);
    await click();
    expect(calls).toEqual(STOP_AND_INSTALL);
    calls.length = 0;
    const finishStop = slowStop();
    await releaseFetched();
    await advance(2_000);
    // The agent's unheld pass refuses while the stop taken for the release drains.
    await refuses();
    await advance(4_000);
    await finishStop(true);
    expect(asksAgain()).toEqual(["prepare:true+hold", "installServiceUpdate:force"]);
    // Reads still return that refusal: the agent has not answered the request
    // asked under the hold yet.
    await advance(6_000);
    expect(errorToasts()).toEqual([]);
    expect(calls).not.toContain("cancelServiceUpdate");
    expect(calls).not.toContain("prepare:release");
    expect(held).toBe(true);
    await installAndFinish();
    expect(calls.filter((call) => call.startsWith("installUpdate"))).toEqual([
      "installUpdate:0.2.5",
    ]);
  });
});

describe("Update now when the agent's refusal of the unheld request is written as the request is asked again", () => {
  it("waits for the agent's answer to the request asked under the hold, then installs both", async () => {
    agent = lacksRelease();
    state.service = agent;
    render();
    await advance(0);
    stopHolds.push(false);
    await click();
    expect(calls).toEqual(STOP_AND_INSTALL);
    calls.length = 0;
    const finishStop = slowStop();
    await releaseFetched();
    await advance(2_000);
    // The agent's unheld pass refuses in the very millisecond the stop holds
    // the work and the window asks again: it never read that request.
    agent = { ...agent, status: "error", message: DETACHED, updatedAt: iso(Date.now()) };
    await finishStop(true);
    expect(asksAgain()).toEqual(["prepare:true+hold", "installServiceUpdate:force"]);
    await advance(6_000);
    expect(errorToasts()).toEqual([]);
    expect(held).toBe(true);
    await installAndFinish();
    expect(calls.filter((call) => call.startsWith("installUpdate"))).toEqual([
      "installUpdate:0.2.5",
    ]);
  });
});

describe("Update now when the window asked again while the agent downloaded the release", () => {
  it("holds, asks again and installs when the agent refuses while the stop for the release drains", async () => {
    agent = lacksRelease();
    state.service = agent;
    render();
    await advance(0);
    stopHolds.push(false);
    await click();
    expect(calls).toEqual(STOP_AND_INSTALL);
    calls.length = 0;
    // The agent starts its download, then writes nothing for a while: the
    // window, idle and not holding the work, asks again.
    await publish({
      ...agent,
      status: "downloading",
      message: "Downloading SpecWithCode 0.2.5",
      updatedAt: iso(Date.now() + 500),
    });
    await advance(45_000);
    expect(calls).toContain("installServiceUpdate:force");
    calls.length = 0;
    const finishStop = slowStop();
    await releaseFetched();
    await advance(2_000);
    expect(calls).toEqual(["prepare:true+hold"]);
    await refuses();
    await advance(4_000);
    expect(errorToasts()).toEqual([]);
    await finishStop(true);
    expect(asksAgain()).toEqual(["prepare:true+hold", "installServiceUpdate:force"]);
    expect(held).toBe(true);
  });
});

/** Update now from M4's state, the service refusing the press's hold. */
async function pressRefused() {
  agent = m4Refusal();
  state.service = agent;
  render();
  await advance(0);
  stopHolds.push(false);
  await click();
  expect(calls).toEqual(STOP_AND_INSTALL);
  expect(held).toBe(false);
  calls.length = 0;
}

/**
 * Retry update: the service refuses this press's hold too, and the agent
 * refuses the unheld request for want of the hold before any stop holds it.
 */
async function retryRefusedThenRefusal() {
  stopHolds.push(false);
  await click();
  expect(calls).toEqual(STOP_AND_INSTALL);
  calls.length = 0;
  await advance(1_000);
  await refuses();
  await advance(2_000);
}

describe("Retry update after an attempt the agent refused", () => {
  it("holds the work and asks again on the unheld refusal after both holds were refused", async () => {
    await pressRefused();
    stopHolds.push(false);
    await refuses();
    await advance(4_000);
    expect(errorToasts()).toEqual([DETACHED_SHOWN]);
    expect(label()).toBe("Retry update");
    calls.length = 0;
    await retryRefusedThenRefusal();
    expect(lastToast().type).not.toBe("error");
    expect(label()).toBe("Updating…");
    expect(asksAgain()).toEqual(["prepare:true+hold", "installServiceUpdate:force"]);
    expect(held).toBe(true);
  });

  it("holds the work and asks again on the unheld refusal after a refusal under the hold", async () => {
    await pressRefused();
    await refuses();
    await advance(2_000);
    expect(asksAgain()).toEqual(["prepare:true+hold", "installServiceUpdate:force"]);
    await advance(1_000);
    await refuses();
    await advance(2_000);
    expect(errorToasts()).toEqual([DETACHED_SHOWN]);
    expect(label()).toBe("Retry update");
    await advance(60_000);
    held = false;
    calls.length = 0;
    await retryRefusedThenRefusal();
    expect(lastToast().type).not.toBe("error");
    expect(label()).toBe("Updating…");
    expect(asksAgain()).toEqual(["prepare:true+hold", "installServiceUpdate:force"]);
    expect(held).toBe(true);
  });
});

describe("A window that follows another window's request after its own press was refused", () => {
  it("shows the agent's refusal once the request is no longer live", async () => {
    agent = lacksRelease();
    state.service = agent;
    render();
    await advance(0);
    stopHolds.push(false);
    await click();
    expect(calls).toEqual(STOP_AND_INSTALL);
    await publish({ ...agent });
    await pressCancelInToast();
    await advance(2_000);
    expect(label()).toBe("Update now");
    // Another window presses once the agent has the release; this one follows.
    agent = { ...otherWindowsRequest(1_000), status: "downloaded", downloadedVersion: "0.2.5" };
    held = true;
    await publish(agent);
    await advance(2_000);
    expect(label()).toBe("Updating…");
    await refuses();
    await advance(4_000);
    expect(errorToasts()).toEqual([]);
    // That request's hold runs out.
    await advance(15 * 60_000);
    expect(errorToasts().length).toBeGreaterThan(0);
  });
});

describe("Update now when the agent's refusal under the hold says nothing of when it was written", () => {
  it("fails the press", async () => {
    agent = lacksRelease();
    state.service = agent;
    render();
    await advance(0);
    stopHolds.push(false);
    await click();
    expect(calls).toEqual(STOP_AND_INSTALL);
    calls.length = 0;
    await releaseFetched();
    await advance(2_000);
    expect(asksAgain()).toEqual(["prepare:true+hold", "installServiceUpdate:force"]);
    const { updatedAt: _written, ...unwritten } = agent;
    await publish({ ...unwritten, status: "error", message: DETACHED });
    await advance(4_000);
    expect(errorToasts()).toEqual([DETACHED_SHOWN]);
    expect(label()).toBe("Retry update");
  });
});

describe("Update now when another window cancels while the stop taken for the release drains", () => {
  /**
   * Update now while the agent lacks the release: the service refuses the
   * press's hold, and the agent fetches 0.2.5, so the window stops and holds
   * the work again. Returns the end of that stop's drain.
   */
  async function stopForReleaseDrains(): Promise<(holds?: boolean) => Promise<void>> {
    agent = lacksRelease();
    state.service = agent;
    render();
    await advance(0);
    stopHolds.push(false);
    await click();
    expect(calls).toEqual(STOP_AND_INSTALL);
    calls.length = 0;
    const finishStop = slowStop();
    await releaseFetched();
    await advance(2_000);
    expect(calls).toEqual(["prepare:true+hold"]);
    return finishStop;
  }

  /** Another window's Cancel: the desktop withdraws the request, and the hold is let go. */
  function otherWindowCancels() {
    agent = { ...agent, pendingInstall: null };
    held = false;
  }

  it("lets go of the hold the stop takes after the agent refused the withdrawn request", async () => {
    const finishStop = await stopForReleaseDrains();
    // The agent's unheld pass refuses on the detached log.
    await refuses();
    await advance(2_000);
    // The drain ends after that Cancel and takes the hold, answering before
    // the window reads the agent again.
    otherWindowCancels();
    await finishStop(true);
    await advance(4_000);
    expect(calls).toContain("prepare:release");
    expect(held).toBe(false);
    expect(calls).not.toContain("installServiceUpdate:force");
    expect(errorToasts()).toEqual([]);
    expect(label()).toBe("Update now");
  });

  it("lets go of that hold when a read saw the Cancel before the stop answered", async () => {
    const finishStop = await stopForReleaseDrains();
    await refuses();
    await advance(2_000);
    otherWindowCancels();
    await advance(2_000);
    expect(label()).toBe("Update now");
    await finishStop(true);
    await advance(4_000);
    expect(calls).toContain("prepare:release");
    expect(held).toBe(false);
    expect(calls).not.toContain("installServiceUpdate:force");
  });

  it("lets go of that hold when the agent has only fetched the release", async () => {
    const finishStop = await stopForReleaseDrains();
    otherWindowCancels();
    await finishStop(true);
    await advance(4_000);
    expect(calls).toContain("prepare:release");
    expect(held).toBe(false);
    expect(calls).not.toContain("installServiceUpdate:force");
    expect(label()).toBe("Update now");
  });
});

describe("Update now when this window cancels while the agent's refusal of the unheld request waits on the hold", () => {
  const cancels = () => calls.filter((call) => call === "cancelServiceUpdate").length;

  /**
   * Update now while the agent lacks the release; the agent fetches it, and its
   * unheld pass refuses on the detached log while the stop taken for the
   * release drains. Returns the end of that drain.
   */
  async function refusedWhileStopDrains(): Promise<(holds?: boolean) => Promise<void>> {
    agent = lacksRelease();
    state.service = agent;
    render();
    await advance(0);
    stopHolds.push(false);
    await click();
    expect(calls).toEqual(STOP_AND_INSTALL);
    calls.length = 0;
    const finishStop = slowStop();
    await releaseFetched();
    await advance(2_000);
    await refuses();
    await advance(2_000);
    expect(errorToasts()).toEqual([]);
    return finishStop;
  }

  it("withdraws the request once and shows no error", async () => {
    const finishStop = await refusedWhileStopDrains();
    await pressCancelInToast();
    await advance(0);
    expect({ cancels: cancels(), errors: errorToasts() }).toEqual({ cancels: 1, errors: [] });
    expect(label()).toBe("Update now");
    // The drain ends after the Cancel: its hold serves nothing.
    await finishStop(true);
    await advance(4_000);
    expect({ cancels: cancels(), errors: errorToasts() }).toEqual({ cancels: 1, errors: [] });
    expect(held).toBe(false);
    expect(calls).not.toContain("installServiceUpdate:force");
  });

  it("withdraws the request once and shows no error when a read comes while the desktop writes the Cancel", async () => {
    const finishStop = await refusedWhileStopDrains();
    // The desktop withdraws the request at once, but answers only later.
    let answerCancel: () => void = () => undefined;
    bridge.cancelServiceUpdate.mockImplementationOnce(() => {
      calls.push("cancelServiceUpdate");
      agent = { ...agent, pendingInstall: null };
      return new Promise<StudioServiceUpdateState>((resolve) => {
        answerCancel = () => resolve({ ...agent });
      });
    });
    await pressCancelInToast();
    await advance(2_000);
    expect({ cancels: cancels(), errors: errorToasts() }).toEqual({ cancels: 1, errors: [] });
    await act(async () => answerCancel());
    await advance(0);
    await finishStop(true);
    await advance(4_000);
    expect({ cancels: cancels(), errors: errorToasts() }).toEqual({ cancels: 1, errors: [] });
    expect(held).toBe(false);
    expect(label()).toBe("Update now");
  });

  it("goes on with the update when the Cancel could not be saved", async () => {
    const finishStop = await refusedWhileStopDrains();
    bridge.cancelServiceUpdate.mockImplementationOnce(async () => {
      calls.push("cancelServiceUpdate");
      throw new Error("The update could not be cancelled. Try again in a moment.");
    });
    await pressCancelInToast();
    await advance(2_000);
    expect(state.addToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Could not cancel the update" }),
    );
    expect(label()).toBe("Updating…");
    // The stop taken for the release holds the work; a look finds it held, and
    // once the agent stays silent the request is asked again under that hold.
    await finishStop(true);
    await advance(40_000);
    expect(asksAgain()).toEqual(["prepare:true+hold", "installServiceUpdate:force"]);
    expect(held).toBe(true);
    expect(label()).toBe("Updating…");
    expect({ cancels: cancels(), errors: errorToasts() }).toEqual({
      cancels: 1,
      errors: ["The update could not be cancelled. Try again in a moment."],
    });
  });
});
