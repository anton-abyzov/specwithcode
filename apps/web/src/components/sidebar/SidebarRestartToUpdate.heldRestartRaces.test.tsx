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

// "Update now" when the service restarts under the request it held work for,
// raced by what else happens meanwhile: a Cancel in another window, a stop
// whose answer is lost, a reload, a failure, a desktop read that fails or
// never answers, and desktops too old to report requests.

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

const FOLLOW_UP_KEY = "specwithcode.serviceUpdate.thenInstallApp";
const STOP_AND_INSTALL = ["prepare:false", "prepare:true+hold", "installServiceUpdate:force"];
const IDLE: ServerPrepareServiceUpdateResult = { idle: true, stoppedThreads: 0, blockers: [] };

// What the agent writes for M4's refusal, and around the restart it makes for a held request.
const DETACHED =
  "SpecWithCode cannot be updated right now: The SpecWithCode service is using a database log that was deleted from disk. Restart SpecWithCode, then update";
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

/**
 * Update now from `before`, M4's state by default. The agent's forced pass
 * refuses on the detached log again, and update.py restarts the service for
 * the held request. Returns when it was pressed.
 */
async function pressUpdateNow(before: StudioServiceUpdateState = m4Refusal()): Promise<number> {
  agent = before;
  state.service = before;
  render();
  await advance(0);
  expect(label()).toBe("Update now");
  calls.length = 0;
  const pressedAt = Date.now();
  await click();
  expect(calls).toEqual(STOP_AND_INSTALL);
  expect(label()).toBe("Updating…");
  await publish({
    ...agent,
    status: "waiting-for-quiet",
    message: RESTARTING,
    updatedAt: iso(Date.now() + 500),
  });
  await advance(12_000);
  expect(held).toBe(true);
  calls.length = 0;
  return pressedAt;
}

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

// While set, desktop reads of the agent throw, or never answer.
let readsFail = false;
let readsHang = false;

function breakAgentReads() {
  const read = bridge.getServiceUpdateState.getMockImplementation()!;
  bridge.getServiceUpdateState.mockImplementation(async () => {
    if (readsFail) throw new Error("The desktop did not answer.");
    if (readsHang) return new Promise<StudioServiceUpdateState>(() => undefined);
    return read();
  });
}

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

beforeEach(() => {
  readsFail = false;
  readsHang = false;
});

describe("Update now when the service restarts under its request: races", () => {
  it("ends and lets the hold go when another window cancels while the work is held again", async () => {
    const store = useSessionStorage();
    agent = m4Refusal();
    state.service = agent;
    render();
    await advance(0);
    await click();
    expect(calls).toEqual(STOP_AND_INSTALL);
    // The agent writes nothing for the request, and the service restarts under it.
    await advance(4_000);
    held = false;
    const finishStop = slowStop();
    calls.length = 0;
    await advance(10_000);
    expect(stops()).toEqual(["prepare:true+hold"]);
    // Another window cancels while that stop drains: the desktop reports no request.
    await publish({ ...agent, pendingInstall: null });
    await advance(4_000);
    calls.length = 0;
    // The drain ends holding the work, for a request no longer pending.
    await finishStop(true);
    await advance(1_000);
    expect(calls).toEqual(["prepare:release"]);
    expect(held).toBe(false);
    expect(state.closeToast).toHaveBeenCalledWith("toast-1");
    expect(label()).toBe("Update now");
    expect(store.has(FOLLOW_UP_KEY)).toBe(false);
  });

  it("holds the work again when the press's stop got no answer and the service restarted before the first look", async () => {
    agent = m4Refusal();
    state.service = agent;
    render();
    await advance(0);
    // The stop holds the work, but its answer never reaches the window.
    stopHolds.push("lost");
    await click();
    expect(calls).toEqual(STOP_AND_INSTALL);
    expect(held).toBe(true);
    // update.py restarts the service for the held request within seconds.
    await advance(3_000);
    await serviceRestarted();
    calls.length = 0;
    await advance(10_000);
    expect(asksAgain()).toEqual(["prepare:true+hold", "installServiceUpdate:force"]);
    expect(held).toBe(true);
    expect(label()).toBe("Updating…");
  });

  it("holds the work again when the stop taken once the agent had the release got no answer and the service restarted", async () => {
    agent = lacksRelease();
    state.service = agent;
    render();
    await advance(0);
    stopHolds.push(false, "lost");
    await click();
    expect(calls).toEqual(STOP_AND_INSTALL);
    expect(held).toBe(false);
    calls.length = 0;
    // The agent fetches 0.2.5 for the request: the window stops and holds the
    // work, and that stop's answer is lost.
    await publish({
      ...agent,
      status: "downloaded",
      downloadedVersion: "0.2.5",
      updatedAt: iso(Date.now() + 500),
    });
    await advance(2_000);
    expect(calls).toEqual(["prepare:true+hold"]);
    expect(held).toBe(true);
    // update.py restarts the service for the held request before the next look.
    await serviceRestarted();
    calls.length = 0;
    await advance(10_000);
    expect(asksAgain()).toEqual(["prepare:true+hold", "installServiceUpdate:force"]);
    expect(held).toBe(true);
  });

  it("holds the work again after a reload once the service restarted under the hold taken when the agent had the release", async () => {
    const store = useSessionStorage();
    agent = lacksRelease();
    state.service = agent;
    render();
    await advance(0);
    stopHolds.push(false);
    await click();
    expect(calls).toEqual(STOP_AND_INSTALL);
    calls.length = 0;
    await publish({
      ...agent,
      status: "downloaded",
      downloadedVersion: "0.2.5",
      updatedAt: iso(Date.now() + 500),
    });
    await advance(2_000);
    expect(asksAgain()).toEqual(["prepare:true+hold", "installServiceUpdate:force"]);
    expect(held).toBe(true);
    // The agent's pass restarts the service for the held request; the window reloads.
    await publish({
      ...agent,
      status: "waiting-for-quiet",
      message: RESTARTING,
      updatedAt: iso(Date.now() + 500),
    });
    await serviceRestarted();
    reloadWindow(store);
    render();
    await advance(0);
    await advance(12_000);
    expect(asksAgain()).toEqual(["prepare:true+hold", "installServiceUpdate:force"]);
    expect(held).toBe(true);
    expect(label()).toBe("Updating…");
  });

  it("holds the work again when the service restarts just after a reload that found it held", async () => {
    const store = useSessionStorage();
    await pressUpdateNow();
    reloadWindow(store);
    render();
    await advance(0);
    expect(label()).toBe("Updating…");
    // update.py restarts the service a few seconds after the reload.
    await advance(3_000);
    calls.length = 0;
    await serviceRestarted();
    await advance(12_000);
    expect(asksAgain()).toEqual(["prepare:true+hold", "installServiceUpdate:force"]);
    expect(held).toBe(true);
  });

  it("lets a late stop's hold go once the agent failed the request", async () => {
    agent = { ...m4Refusal(), status: "downloaded", message: null };
    state.service = agent;
    render();
    await advance(0);
    expect(label()).toBe("Update now");
    // The agent has not fetched what the service needs to hold work for: refused.
    stopHolds.push(false);
    await click();
    expect(calls).toEqual(STOP_AND_INSTALL);
    expect(held).toBe(false);
    calls.length = 0;
    // The agent answers the request with the release: the window stops and
    // holds the work, and that stop drains.
    const finishStop = slowStop();
    await publish({
      ...agent,
      status: "waiting-for-quiet",
      message: "Waiting for a quiet moment before installing SpecWithCode 0.2.5",
      updatedAt: iso(Date.now() + 500),
    });
    await advance(2_500);
    expect(calls).toEqual(["prepare:true+hold"]);
    // The agent gives up on the request while the stop drains: the desktop
    // reports none pending once the agent answered it without installing.
    await publish({
      ...agent,
      status: "error",
      message: "The update did not install.",
      updatedAt: iso(Date.now() + 500),
      pendingInstall: null,
    });
    await advance(3_000);
    expect(lastToast().type).toBe("error");
    calls.length = 0;
    await finishStop(true);
    await advance(1_000);
    expect(calls).toEqual(["prepare:release"]);
    expect(held).toBe(false);
  });

  it("lets the hold go when the agent refuses the request again while the work is held again", async () => {
    await pressUpdateNow();
    held = false;
    const finishStop = slowStop();
    await advance(10_000);
    expect(stops()).toEqual(["prepare:true+hold"]);
    // The agent's next try is refused for good, written after the request.
    await publish({ ...agent, status: "error", message: DETACHED, updatedAt: iso(Date.now()) });
    await advance(4_000);
    expect(lastToast().type).toBe("error");
    expect(calls).toContain("cancelServiceUpdate");
    calls.length = 0;
    // The drain ends holding the work: no request is pending for it.
    await finishStop(true);
    await advance(1_000);
    expect(calls).toEqual(["prepare:release"]);
    expect(held).toBe(false);
  });

  it("lets the hold go when the agent fails the request while the work is held again", async () => {
    await pressUpdateNow();
    const finishStop = slowStop();
    await serviceRestarted();
    await advance(10_000);
    expect(stops()).toEqual(["prepare:true+hold"]);
    await publish({
      ...agent,
      status: "error",
      message: "The update did not install.",
      updatedAt: iso(Date.now() + 500),
      pendingInstall: null,
    });
    await advance(2_000);
    expect(lastToast().type).toBe("error");
    calls.length = 0;
    await finishStop(true);
    await advance(1_000);
    expect(calls).toEqual(["prepare:release"]);
    expect(held).toBe(false);
  });

  it("stops saying it holds the work again once three stops for that got no answer", async () => {
    await pressUpdateNow();
    stopHolds.push("none", "none", "none");
    for (let restart = 0; restart < 4; restart += 1) {
      await serviceRestarted();
      await advance(10_000);
    }
    expect(stops()).toHaveLength(3);
    expect(held).toBe(false);
    expect(label()).toBe("Updating…");
    expect(lastToast().description).not.toContain(SERVICE_RESTARTED);
  });

  it("never installs the app for a press another window cancelled as the hold was lost", async () => {
    const store = useSessionStorage();
    await pressUpdateNow();
    expect(store.has(FOLLOW_UP_KEY)).toBe(true);
    held = false;
    afterLook = () => {
      agent = {
        ...agent,
        status: "downloaded",
        message: "Update cancelled",
        updatedAt: iso(Date.now() + 1_000),
        pendingInstall: null,
      };
    };
    await advance(10_000);
    expect(state.closeToast).toHaveBeenCalledWith("toast-1");
    expect(store.has(FOLLOW_UP_KEY)).toBe(false);
    await publish(agent);
    await advance(60_000);
    calls.length = 0;
    // Later the agent installs 0.2.5 at a quiet moment of its own: no press asked for it.
    await publish({
      ...agent,
      status: "installing",
      message: "Installing SpecWithCode 0.2.5",
      updatedAt: iso(Date.now()),
    });
    await advance(4_000);
    await publish({
      ...agent,
      status: "installed",
      installedVersion: "0.2.5",
      availableVersion: null,
      downloadedVersion: null,
      message: null,
      lastInstall: { version: "0.2.5", at: iso(Date.now()), result: "updated" },
      updatedAt: iso(Date.now()),
      pendingInstall: null,
    });
    await advance(4_000);
    expect(calls).not.toContain("installUpdate:0.2.5");
  });

  it("lets the hold go when the request is withdrawn as the window asks again under the new hold", async () => {
    await pressUpdateNow();
    const finishStop = slowStop();
    await serviceRestarted();
    await advance(10_000);
    expect(asksAgain()).toEqual(["prepare:true+hold"]);
    // Another window cancels; this window reads that only as it asks again.
    agent = {
      ...agent,
      status: "downloaded",
      message: "Update cancelled",
      updatedAt: iso(Date.now() + 500),
      pendingInstall: null,
    };
    calls.length = 0;
    await finishStop(true);
    await advance(0);
    expect(calls).toEqual(["prepare:release"]);
    expect(held).toBe(false);
    expect(state.closeToast).toHaveBeenCalledWith("toast-1");
  });

  it("writes the request again under the new hold when the agent cannot be read just then", async () => {
    breakAgentReads();
    await pressUpdateNow();
    const finishStop = slowStop();
    await serviceRestarted();
    await advance(10_000);
    expect(asksAgain()).toEqual(["prepare:true+hold"]);
    readsFail = true;
    await finishStop();
    readsFail = false;
    expect(asksAgain()).toEqual(["prepare:true+hold", "installServiceUpdate:force"]);
    expect(state.closeToast).not.toHaveBeenCalled();
    expect(label()).toBe("Updating…");
  });

  it("keeps a stray hold while the agent cannot be read", async () => {
    breakAgentReads();
    await pressUpdateNow();
    const finishStop = slowStop();
    await serviceRestarted();
    await advance(10_000);
    await pressCancelInToast();
    await advance(0);
    expect(calls.slice(-2)).toEqual(["cancelServiceUpdate", "prepare:release"]);
    calls.length = 0;
    readsFail = true;
    await finishStop(true);
    await advance(0);
    readsFail = false;
    // Whether another press needs it is unknown: the service lets it go when it lapses.
    expect(calls).toEqual([]);
    expect(held).toBe(true);
  });

  it("holds the work again although desktop reads never answer as the service restarts", async () => {
    breakAgentReads();
    await pressUpdateNow();
    await serviceRestarted();
    readsHang = true;
    await advance(10_000);
    readsHang = false;
    await advance(30_000);
    expect(asksAgain()).toEqual(["prepare:true+hold", "installServiceUpdate:force"]);
    expect(held).toBe(true);
  });

  it("follows the install, and installs the app, after a desktop read that never answered", async () => {
    breakAgentReads();
    await pressUpdateNow();
    readsHang = true;
    await advance(3_000);
    readsHang = false;
    await installAndFinish();
    expect(calls).toContain("installUpdate:0.2.5");
  });
});
