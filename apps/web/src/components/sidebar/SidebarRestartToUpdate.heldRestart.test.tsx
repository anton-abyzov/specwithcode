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

// "Update now" when the service restarts under the request it held work for:
// update.py restarts a service that lost its database for a held request, and
// the new process holds nothing. The window that wrote the request holds the
// work again and writes the request again under the new hold.

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
  resetServiceUpdateFlowForTests,
  SERVICE_HOLD_ENDED,
  SERVICE_REQUEST_EXPIRED,
} from "../serviceUpdateFlow";
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

/** Another window pressed Update now; this one finds the request held and follows it. */
async function followOtherWindowsRequest() {
  const requestedAt = Date.now() - 5_000;
  held = true;
  agent = {
    ...m4Refusal(),
    status: "waiting-for-quiet",
    message: RESTARTING,
    updatedAt: iso(requestedAt + 500),
    pendingInstall: {
      requestedAt: iso(requestedAt),
      mode: "force",
      version: "0.2.5",
      holdUntil: iso(requestedAt + 15 * 60_000),
      handled: false,
    },
  };
  state.service = agent;
  render();
  await advance(0);
  expect(label()).toBe("Updating…");
  await advance(10_000);
  calls.length = 0;
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

describe("Update now when the service restarts under its request", () => {
  it("holds the work again, asks again and installs the app after the service", async () => {
    const store = useSessionStorage();
    await pressUpdateNow();
    // The service restarts: looks get no answer for a while.
    lookFails = true;
    await advance(10_000);
    lookFails = false;
    await serviceRestarted();
    await advance(10_000);
    // Held again, and the same request written again under the new hold.
    expect(asksAgain()).toEqual(["prepare:true+hold", "installServiceUpdate:force"]);
    expect(held).toBe(true);
    expect(label()).toBe("Updating…");
    expect(state.closeToast).not.toHaveBeenCalled();
    expect(store.has(FOLLOW_UP_KEY)).toBe(true);
    // The agent's helpers find the request held now: it installs 0.2.5.
    await publish({
      ...agent,
      status: "installing",
      message: "Installing SpecWithCode 0.2.5",
      updatedAt: iso(Date.now() + 500),
      pendingInstall: { ...agent.pendingInstall!, handled: true },
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
      updatedAt: iso(Date.now() + 500),
      pendingInstall: null,
    });
    await advance(4_000);
    expect(calls).toContain("installUpdate:0.2.5");
    expect(state.closeToast).not.toHaveBeenCalled();
  });

  it("says the service restarted while it holds the work again, and not once it holds it", async () => {
    await pressUpdateNow();
    const finishStop = slowStop();
    await serviceRestarted();
    await advance(10_000);
    expect(asksAgain()).toEqual(["prepare:true+hold"]);
    expect(lastToast().description).toContain(SERVICE_RESTARTED);
    expect(lastToast().data?.secondaryActionProps?.children).toBe("Cancel update");
    await finishStop();
    expect(lastToast().description).not.toContain(SERVICE_RESTARTED);
    expect(asksAgain()).toEqual(["prepare:true+hold", "installServiceUpdate:force"]);
  });

  it("holds the work again once at a time while a stop drains", async () => {
    await pressUpdateNow();
    const finishStop = slowStop();
    await serviceRestarted();
    // Looks keep finding nothing held while the stop drains.
    await advance(30_000);
    await finishStop();
    expect(asksAgain()).toEqual(["prepare:true+hold", "installServiceUpdate:force"]);
  });

  it("holds the work again three times at most for one request", async () => {
    await pressUpdateNow();
    for (let restart = 0; restart < 4; restart += 1) {
      await serviceRestarted();
      await advance(10_000);
    }
    // After the third, the window only follows the request.
    expect(stops()).toHaveLength(3);
    expect(label()).toBe("Updating…");
    expect(lastToast().description).not.toContain(SERVICE_RESTARTED);
    expect(state.closeToast).not.toHaveBeenCalled();
  });

  it("holds the work again for a renewed request, though it did so three times for the one before", async () => {
    await pressUpdateNow();
    for (let restart = 0; restart < 3; restart += 1) {
      await serviceRestarted();
      await advance(10_000);
    }
    expect(stops()).toHaveLength(3);
    // The agent lets the request lapse: the window renews it.
    await publish({
      ...agent,
      status: "error",
      message: SERVICE_REQUEST_EXPIRED,
      updatedAt: iso(Date.now()),
      pendingInstall: null,
    });
    await advance(2_000);
    expect(stops()).toHaveLength(4);
    await serviceRestarted();
    calls.length = 0;
    await advance(10_000);
    expect(asksAgain()).toEqual(["prepare:true+hold", "installServiceUpdate:force"]);
  });

  it("asks again when the stop's answer is lost, and stops saying the service restarted once a look finds the work held", async () => {
    await pressUpdateNow();
    stopHolds.push("lost");
    await serviceRestarted();
    await advance(10_000);
    expect(asksAgain()).toEqual(["prepare:true+hold", "installServiceUpdate:force"]);
    expect(lastToast().description).toContain(SERVICE_RESTARTED);
    await advance(10_000);
    expect(lastToast().description).not.toContain(SERVICE_RESTARTED);
    expect(asksAgain()).toEqual(["prepare:true+hold", "installServiceUpdate:force"]);
  });

  it("holds the work again when a stop that got no answer held nothing", async () => {
    await pressUpdateNow();
    stopHolds.push("none");
    await serviceRestarted();
    await advance(10_000);
    expect(asksAgain()).toEqual(["prepare:true+hold", "installServiceUpdate:force"]);
    await advance(10_000);
    expect(asksAgain()).toEqual([
      "prepare:true+hold",
      "installServiceUpdate:force",
      "prepare:true+hold",
      "installServiceUpdate:force",
    ]);
    expect(held).toBe(true);
  });

  it("neither asks again nor stops the work again when the restarted service refuses to hold it", async () => {
    await pressUpdateNow();
    stopHolds.push(false);
    await serviceRestarted();
    await advance(20_000);
    expect(asksAgain()).toEqual(["prepare:true+hold"]);
    expect(label()).toBe("Updating…");
    // The agent waits for a quiet moment on its own, and the toast says so.
    expect(lastToast().description).not.toContain(SERVICE_RESTARTED);
    expect(lastToast().description).toContain(RESTARTED);
  });

  it("lets the work go when Update is cancelled while the stop drains", async () => {
    await pressUpdateNow();
    const finishStop = slowStop();
    await serviceRestarted();
    await advance(10_000);
    expect(asksAgain()).toEqual(["prepare:true+hold"]);
    calls.length = 0;
    await pressCancelInToast();
    await advance(0);
    expect(calls).toEqual(["cancelServiceUpdate", "prepare:release"]);
    // The stop answers after the Cancel: the hold it took serves no request.
    await finishStop();
    expect(calls).toEqual(["cancelServiceUpdate", "prepare:release", "prepare:release"]);
    expect(held).toBe(false);
    expect(label()).toBe("Update now");
  });

  it("follows the install, without holding the work again, when the agent installs as the hold is lost", async () => {
    await pressUpdateNow();
    held = false;
    afterLook = () => {
      agent = {
        ...agent,
        status: "installing",
        message: "Installing SpecWithCode 0.2.5",
        updatedAt: iso(Date.now() + 500),
        pendingInstall: { ...agent.pendingInstall!, handled: true },
      };
    };
    await advance(10_000);
    expect(asksAgain()).toEqual([]);
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
    await advance(4_000);
    expect(calls).toContain("installUpdate:0.2.5");
    expect(asksAgain()).toEqual([]);
  });

  it("renews the request, without ending it, when the agent let it lapse as the hold was lost", async () => {
    await pressUpdateNow();
    held = false;
    afterLook = () => {
      agent = {
        ...agent,
        status: "error",
        message: SERVICE_REQUEST_EXPIRED,
        // Written just before the look answered: before the renewal.
        updatedAt: iso(Date.now() - 500),
        pendingInstall: null,
      };
    };
    await advance(10_000);
    expect(asksAgain()).toEqual(["prepare:true+hold", "installServiceUpdate:force"]);
    expect(label()).toBe("Updating…");
    expect(state.closeToast).not.toHaveBeenCalled();
  });

  it("holds the work again on the next look when the agent cannot be read as the hold is lost", async () => {
    await pressUpdateNow();
    held = false;
    afterLook = () => {
      bridge.getServiceUpdateState.mockImplementationOnce(async () => {
        throw new Error("The desktop did not answer.");
      });
    };
    await advance(10_000);
    expect(asksAgain()).toEqual([]);
    expect(label()).toBe("Updating…");
    expect(state.closeToast).not.toHaveBeenCalled();
    await advance(10_000);
    expect(asksAgain()).toEqual(["prepare:true+hold", "installServiceUpdate:force"]);
  });

  it("leaves a later press alone when a stop made before a Cancel answers after it", async () => {
    await pressUpdateNow();
    const finishStop = slowStop();
    await serviceRestarted();
    await advance(10_000);
    await pressCancelInToast();
    // The desktop publishes the withdrawal: no request is pending.
    await publish(agent);
    expect(label()).toBe("Update now");
    // Update now again: the work is held for the new request.
    calls.length = 0;
    await click();
    expect(calls).toEqual(STOP_AND_INSTALL);
    // The first stop answers only now, refused.
    await finishStop(false);
    // The service restarts under the new request: its work is held again.
    await serviceRestarted();
    calls.length = 0;
    await advance(10_000);
    expect(asksAgain()).toEqual(["prepare:true+hold", "installServiceUpdate:force"]);
  });

  it("follows the renewal the pressing window wrote when the request lapsed as the hold was lost", async () => {
    await followOtherWindowsRequest();
    held = false;
    afterLook = () => {
      const at = Date.now();
      agent = {
        ...agent,
        status: "error",
        message: SERVICE_REQUEST_EXPIRED,
        updatedAt: iso(at - 500),
        pendingInstall: {
          requestedAt: iso(at),
          mode: "force",
          version: "0.2.5",
          holdUntil: iso(at + 15 * 60_000),
          handled: false,
        },
      };
    };
    await advance(10_000);
    expect(asksAgain()).toEqual([]);
    expect(label()).toBe("Updating…");
    expect(lastToast().type).not.toBe("error");
  });

  it("says the hold ended, without holding the work again, when the service restarts in its last minute", async () => {
    const pressedAt = await pressUpdateNow();
    await advance(pressedAt + 15 * 60_000 - 45_000 - Date.now());
    await serviceRestarted();
    calls.length = 0;
    await advance(10_000);
    expect(stops()).toEqual([]);
    expect(lastToast().description).toBe(SERVICE_HOLD_ENDED);
  });

  it("ends without holding the work again when the request was cancelled as the hold was lost", async () => {
    await pressUpdateNow();
    // Another window cancels: the service lets the work go, and the desktop
    // no longer reports the request by the time the window reads it.
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
    expect(asksAgain()).toEqual([]);
    expect(state.closeToast).toHaveBeenCalledWith("toast-1");
  });

  it("ends without holding the work again when another window's newer request is pending", async () => {
    await pressUpdateNow();
    held = false;
    afterLook = () => {
      const at = Date.now() + 1_000;
      agent = {
        ...agent,
        updatedAt: iso(at),
        pendingInstall: {
          requestedAt: iso(at),
          mode: "force",
          version: "0.2.5",
          holdUntil: iso(at + 15 * 60_000),
          handled: false,
        },
      };
    };
    await advance(10_000);
    expect(asksAgain()).toEqual([]);
    expect(state.closeToast).toHaveBeenCalledWith("toast-1");
  });

  it("ends without holding the work again when another window cancels after the agent said it restarted the service", async () => {
    await pressUpdateNow();
    await serviceRestarted();
    // The Cancel lands before the agent's next pass: it still says it restarted.
    afterLook = () => {
      agent = { ...agent, pendingInstall: null };
    };
    await advance(10_000);
    expect(asksAgain()).toEqual([]);
    expect(state.closeToast).toHaveBeenCalledWith("toast-1");
  });
});
