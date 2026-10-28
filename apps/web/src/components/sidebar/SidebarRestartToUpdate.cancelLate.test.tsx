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

// "Update now" and a Cancel the agent's work came first: a Cancel once the
// agent started installing (in this window or another), another window's
// Cancel the agent's pass then refused the request after, without saying
// "Update cancelled", and this window's Cancel that could not be saved.

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
import { resetServiceUpdateFlowForTests, SERVICE_REQUEST_EXPIRED } from "../serviceUpdateFlow";
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
const IDLE: ServerPrepareServiceUpdateResult = { idle: true, stoppedThreads: 0, blockers: [] };

// What the agent writes for M4's refusal, and around the restart it makes for a held request.
const DETACHED =
  "SpecWithCode cannot be updated right now: The SpecWithCode service is using a database log that was deleted from disk. Restart SpecWithCode, then update";
// What the toast shows for it: the older agent's restart reads as what Update now does.
const DETACHED_SHOWN =
  "SpecWithCode cannot be updated right now: The SpecWithCode service is using a database log that was deleted from disk. Press Update now: SpecWithCode saves that log, restarts its background service and then updates";
const RESTARTING = "Restarting SpecWithCode to recover its database";

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

/** The agent starts installing for the request, which the desktop reports taken up; unread yet. */
function agentStartsInstalling() {
  agent = {
    ...agent,
    status: "installing",
    message: "Installing SpecWithCode 0.2.5",
    updatedAt: iso(Date.now() + 500),
    pendingInstall: { ...agent.pendingInstall!, handled: true },
  };
}

/** The install ends with the service on 0.2.5, restarted, so holding nothing. */
async function serviceInstalled() {
  held = false;
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

describe("Update now: a Cancel once the agent started installing", () => {
  it("says the install cannot be cancelled and never restarts the app", async () => {
    const store = useSessionStorage();
    await pressUpdateNow();
    expect(store.has(FOLLOW_UP_KEY)).toBe(true);
    // The toast still offers Cancel until the window reads "installing".
    agentStartsInstalling();
    await pressCancelInToast();
    await advance(0);
    expect(calls).toEqual(["cancelServiceUpdate"]);
    expect(state.addToast).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "warning",
        title: "Could not cancel the update",
        description:
          "SpecWithCode had already started installing the service update; it cannot be cancelled. The app will not restart.",
      }),
    );
    expect(store.has(FOLLOW_UP_KEY)).toBe(false);
    await advance(4_000);
    await serviceInstalled();
    expect(calls).not.toContain("installUpdate:0.2.5");
    expect(reload).toHaveBeenCalled();
    // Reloaded, the window leaves the app's update to a press of its own.
    reloadWindow(store);
    state.service = agent;
    render();
    await advance(4_000);
    expect(label()).toBe("Restart to update");
    expect(calls).not.toContain("installUpdate:0.2.5");
  });

  it("says only that the install cannot be cancelled when the app has no update to follow it", async () => {
    state.app = { ...downloaded, status: "idle", availableVersion: null, downloadedVersion: null };
    agent = m4Refusal();
    state.service = agent;
    render();
    await advance(0);
    await click();
    expect(calls).toEqual(STOP_AND_INSTALL);
    agentStartsInstalling();
    await pressCancelInToast();
    await advance(0);
    expect(state.addToast).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "warning",
        description:
          "SpecWithCode had already started installing the service update; it cannot be cancelled.",
      }),
    );
  });

  it("never restarts the app when another window's Cancel came once the agent started installing", async () => {
    const store = useSessionStorage();
    await pressUpdateNow();
    agentStartsInstalling();
    await advance(2_000);
    expect(store.has(FOLLOW_UP_KEY)).toBe(true);
    // Another window cancels: the desktop no longer reports the request.
    await publish({ ...agent, pendingInstall: null });
    await advance(2_000);
    expect(store.has(FOLLOW_UP_KEY)).toBe(false);
    await serviceInstalled();
    expect(calls).not.toContain("installUpdate:0.2.5");
    expect(reload).toHaveBeenCalled();
    expect(errorToasts()).toEqual([]);
  });

  it("never restarts the app after a reload when another window's Cancel came once the agent started installing", async () => {
    const store = useSessionStorage();
    await pressUpdateNow();
    agentStartsInstalling();
    reloadWindow(store);
    // Another window cancels too late, and the install restarts the service:
    // the reloaded window's looks get no answer.
    agent = { ...agent, pendingInstall: null };
    state.service = agent;
    lookFails = true;
    render();
    await advance(12_000);
    lookFails = false;
    await serviceInstalled();
    expect(calls).not.toContain("installUpdate:0.2.5");
    expect(store.has(FOLLOW_UP_KEY)).toBe(false);
  });

  it("still restarts the app after a reload when the agent installs for the window's own request while its restart cuts off looks", async () => {
    const store = useSessionStorage();
    await pressUpdateNow();
    agentStartsInstalling();
    reloadWindow(store);
    // The desktop still reports the request the agent installs for.
    state.service = agent;
    lookFails = true;
    render();
    await advance(12_000);
    expect(store.has(FOLLOW_UP_KEY)).toBe(true);
    lookFails = false;
    await serviceInstalled();
    expect(calls).toContain("installUpdate:0.2.5");
  });
});

describe("The app's install after an install no request asks for", () => {
  it("never follows an install the agent runs on its own, after a reload", async () => {
    const store = useSessionStorage();
    // A press saved the app's install, and its window reloaded before its
    // request was written. The agent then installs 0.2.5 on its own.
    store.set(
      FOLLOW_UP_KEY,
      JSON.stringify({ appVersion: "0.2.5", serviceVersion: "0.2.5", at: Date.now() }),
    );
    agent = {
      ...m4Refusal(),
      status: "installing",
      message: "Installing SpecWithCode 0.2.5",
      updatedAt: iso(Date.now() + 500),
    };
    state.service = agent;
    render();
    await advance(0);
    expect(label()).toBe("Installing…");
    await advance(2_000);
    expect(store.has(FOLLOW_UP_KEY)).toBe(false);
    await serviceInstalled();
    expect(calls).not.toContain("installUpdate:0.2.5");
    expect(reload).toHaveBeenCalled();
  });

  it("never follows an install the agent runs on its own while its restart cuts off looks, after a reload", async () => {
    const store = useSessionStorage();
    store.set(
      FOLLOW_UP_KEY,
      JSON.stringify({ appVersion: "0.2.5", serviceVersion: "0.2.5", at: Date.now() }),
    );
    agent = {
      ...m4Refusal(),
      status: "installing",
      message: "Installing SpecWithCode 0.2.5",
      updatedAt: iso(Date.now() + 500),
    };
    state.service = agent;
    // The install restarts the service: the reloaded window's looks get no answer.
    lookFails = true;
    render();
    await advance(12_000);
    lookFails = false;
    await serviceInstalled();
    expect(calls).not.toContain("installUpdate:0.2.5");
    expect(store.has(FOLLOW_UP_KEY)).toBe(false);
    expect(label()).toBe("Restart to update");
  });
});

describe("Update now: another window's Cancel that the agent's pass refused the request after", () => {
  it("ends quietly when the agent refuses a request another window withdrew", async () => {
    const store = useSessionStorage();
    agent = m4Refusal();
    state.service = agent;
    render();
    await advance(0);
    await click();
    expect(calls).toEqual(STOP_AND_INSTALL);
    calls.length = 0;
    // Another window cancels before update.py restarts the service for the
    // request, and lets the hold go. The agent's pass then refuses on the
    // detached log again: it never took the request up, so it says no more.
    agent = {
      ...agent,
      status: "error",
      message: DETACHED,
      updatedAt: iso(Date.now() + 500),
      pendingInstall: null,
    };
    held = false;
    await advance(2_000);
    expect(state.closeToast).toHaveBeenCalledWith("toast-1");
    expect(errorToasts()).toEqual([]);
    expect(label()).toBe("Update now");
    expect(calls).toEqual([]);
    expect(store.has(FOLLOW_UP_KEY)).toBe(false);
  });

  it("ends quietly when the look that finds the hold gone reads that refusal", async () => {
    await pressUpdateNow();
    // Another window cancels and lets the hold go; this window reads it only
    // once its look finds nothing held.
    held = false;
    afterLook = () => {
      agent = {
        ...agent,
        status: "error",
        message: DETACHED,
        updatedAt: iso(Date.now() + 500),
        pendingInstall: null,
      };
    };
    await advance(10_000);
    expect(calls).toEqual(["prepare:false"]);
    expect(state.closeToast).toHaveBeenCalledWith("toast-1");
    expect(errorToasts()).toEqual([]);
    expect(label()).toBe("Update now");
  });

  it("lets the hold go when the agent refuses while this window's own Cancel is written", async () => {
    await pressUpdateNow();
    // The desktop takes a while to answer the Cancel; meanwhile the agent's
    // pass refuses on the detached log, and the desktop reports no request.
    let answerCancel: () => void = () => undefined;
    bridge.cancelServiceUpdate.mockImplementationOnce(() => {
      calls.push("cancelServiceUpdate");
      agent = {
        ...agent,
        status: "error",
        message: DETACHED,
        updatedAt: iso(Date.now() + 500),
        pendingInstall: null,
      };
      return new Promise<StudioServiceUpdateState>((resolve) => {
        answerCancel = () => resolve({ ...agent });
      });
    });
    await pressCancelInToast();
    await advance(2_000);
    await act(async () => answerCancel());
    await advance(0);
    expect(calls).toContain("prepare:release");
    expect(held).toBe(false);
    expect(label()).toBe("Update now");
    // The refusal read while the Cancel was written is not shown, nor withdrawn again.
    expect(errorToasts()).toEqual([]);
    expect(calls.filter((call) => call === "cancelServiceUpdate")).toHaveLength(1);
  });

  it("fails when the agent refuses the request after an install it tried for it", async () => {
    await pressUpdateNow();
    agentStartsInstalling();
    await advance(2_000);
    // The install was refused before the restart, and the agent tries again:
    // the request is pending again.
    agent = {
      ...agent,
      status: "waiting-for-quiet",
      message: "New work started before the restart; trying again",
      updatedAt: iso(Date.now() + 500),
      pendingInstall: { ...agent.pendingInstall!, handled: false },
    };
    await advance(2_000);
    // Its retry refuses on the detached log, and the agent ends the request as failed.
    agent = {
      ...agent,
      status: "error",
      message: DETACHED,
      lastInstall: { version: "0.2.5", at: iso(Date.now()), result: "failed" },
      updatedAt: iso(Date.now() + 500),
      pendingInstall: null,
    };
    await advance(2_000);
    expect(lastToast().type).toBe("error");
    expect(lastToast().description).toContain(DETACHED_SHOWN);
    expect(label()).toBe("Retry update");
  });
});

describe("Update now: this window's Cancel that could not be saved", () => {
  /** Update now with the service held for the request, which is pending. */
  async function pressed() {
    agent = { ...serviceWaiting, updatedAt: iso(Date.now() - 60_000) };
    state.service = agent;
    render();
    await advance(0);
    await click();
    expect(calls).toEqual(STOP_AND_INSTALL);
    calls.length = 0;
    await advance(2_000);
  }

  /** The agent lets the request lapse unstarted, as it writes that. */
  const lapsed = (): StudioServiceUpdateState => ({
    ...agent,
    status: "error",
    message: SERVICE_REQUEST_EXPIRED,
    updatedAt: iso(Date.now() + 500),
    pendingInstall: null,
  });

  /** Cancel, which the desktop cannot save; `meanwhile` runs as it tries. */
  async function cancelNotSaved(meanwhile: () => void = () => undefined) {
    bridge.cancelServiceUpdate.mockImplementationOnce(async () => {
      calls.push("cancelServiceUpdate");
      meanwhile();
      throw new Error("The update could not be cancelled. Try again in a moment.");
    });
    await pressCancelInToast();
    await advance(0);
    expect(state.addToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Could not cancel the update" }),
    );
  }

  const asksAgain = () =>
    calls.filter((call) => call === "prepare:true+hold" || call.startsWith("installServiceUpdate"));

  it("asks for nothing again once the agent let the request lapse as it was cancelled", async () => {
    await pressed();
    await cancelNotSaved(() => (agent = lapsed()));
    await advance(30_000);
    expect(asksAgain()).toEqual([]);
    // The next read shows the agent's answer, and the work is let go.
    expect(lastToast()).toMatchObject({ type: "error", description: SERVICE_REQUEST_EXPIRED });
    expect(held).toBe(false);
    expect(label()).toBe("Retry update");
  });

  it("asks for nothing again when the agent lets the request lapse after that Cancel", async () => {
    await pressed();
    await cancelNotSaved();
    await advance(4_000);
    expect(label()).toBe("Updating…");
    agent = lapsed();
    await advance(30_000);
    expect(asksAgain()).toEqual([]);
    expect(held).toBe(false);
    expect(label()).toBe("Retry update");
  });

  it("asks again for a request the agent let lapse when nobody cancelled", async () => {
    await pressed();
    agent = lapsed();
    await advance(6_000);
    expect(asksAgain().filter((call) => call.startsWith("installServiceUpdate"))).toEqual([
      "installServiceUpdate:force",
    ]);
  });
});
