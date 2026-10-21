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

// "Update now" when the service refused the press's hold: the agent's forced
// pass then runs unheld, and update.py refuses a request it would restart the
// service for only when held. That refusal answers the unheld request: the
// window holds the work and asks again, and fails only on a later refusal.

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

// What the agent writes for M4's refusal.
const DETACHED =
  "SpecWithCode cannot be updated right now: The SpecWithCode service is using a database log that was deleted from disk. Restart SpecWithCode, then update";

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

/** M4's agent before it fetched 0.2.5: the service refuses to hold work for it. */
const lacksRelease = (): StudioServiceUpdateState => ({
  ...m4Refusal(),
  status: "available",
  message: null,
  downloadedVersion: null,
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

/** The agent's forced pass refuses on the detached log: the request was not held. */
async function refuses(changes: Partial<StudioServiceUpdateState> = {}) {
  await publish({
    ...agent,
    status: "error",
    message: DETACHED,
    updatedAt: iso(Date.now() + 500),
    ...changes,
  });
}

describe("Update now when the service refused the press's hold", () => {
  it("holds the work and asks again when the agent refuses the unheld request for want of the hold", async () => {
    await pressRefused();
    await refuses();
    await advance(2_000);
    expect(calls).toEqual(["prepare:true+hold", "installServiceUpdate:force"]);
    expect(held).toBe(true);
    expect(label()).toBe("Updating…");
    expect(lastToast().type).not.toBe("error");
    expect(state.closeToast).not.toHaveBeenCalled();
  });

  it("holds the work, asks again and installs when the refusal comes while the stop for the agent's release drains", async () => {
    const store = useSessionStorage();
    agent = lacksRelease();
    state.service = agent;
    render();
    await advance(0);
    stopHolds.push(false);
    await click();
    expect(calls).toEqual(STOP_AND_INSTALL);
    calls.length = 0;
    // The agent fetches 0.2.5 for the request: the window stops and holds the work.
    const finishStop = slowStop();
    await publish({
      ...agent,
      status: "downloaded",
      downloadedVersion: "0.2.5",
      updatedAt: iso(Date.now() + 500),
    });
    await advance(2_000);
    expect(calls).toEqual(["prepare:true+hold"]);
    // Its forced pass, made before that hold, refuses on the detached log.
    await refuses();
    await advance(4_000);
    expect(lastToast().type).not.toBe("error");
    expect(label()).toBe("Updating…");
    expect(calls).toEqual(["prepare:true+hold"]);
    await finishStop(true);
    expect(calls).toEqual(["prepare:true+hold", "installServiceUpdate:force"]);
    // The agent's helpers find the request held now: it installs 0.2.5, then the app.
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
    expect(store.has(FOLLOW_UP_KEY)).toBe(true);
  });

  it("fails when the agent refuses the request it was asked again under the hold", async () => {
    await pressRefused();
    await refuses();
    await advance(2_000);
    expect(calls).toEqual(["prepare:true+hold", "installServiceUpdate:force"]);
    calls.length = 0;
    await advance(1_000);
    await refuses();
    await advance(2_000);
    expect(lastToast().type).toBe("error");
    expect(lastToast().description).toContain("database log that was deleted from disk");
    expect(calls).toEqual(["cancelServiceUpdate", "prepare:release"]);
    expect(label()).toBe("Retry update");
  });

  it("fails when the service refuses the second hold too", async () => {
    await pressRefused();
    stopHolds.push(false);
    await refuses();
    await advance(4_000);
    expect(calls).toEqual(["prepare:true+hold", "cancelServiceUpdate", "prepare:release"]);
    expect(lastToast().type).toBe("error");
    expect(label()).toBe("Retry update");
  });

  it("fails when the agent ends the refused request as failed, so the desktop no longer reports it", async () => {
    await pressRefused();
    // It tried to install for the request, and ended it with its retry's refusal.
    await refuses({
      pendingInstall: null,
      lastInstall: { version: "0.2.5", at: iso(Date.now()), result: "failed" },
    });
    await advance(2_000);
    expect(stops()).toEqual([]);
    expect(lastToast().type).toBe("error");
  });

  it("fails when the agent refuses the request after it began to install", async () => {
    await pressRefused();
    await publish({
      ...agent,
      status: "installing",
      message: "Installing SpecWithCode 0.2.5",
      updatedAt: iso(Date.now() + 500),
    });
    await advance(2_000);
    expect(label()).not.toBe("Update now");
    await refuses();
    await advance(2_000);
    expect(lastToast().type).toBe("error");
  });

  it("fails a retry the desktop could not write, though the agent last refused for want of the hold", async () => {
    agent = m4Refusal();
    state.service = agent;
    render();
    await advance(0);
    await click();
    expect(calls).toEqual(STOP_AND_INSTALL);
    // The agent refuses the held request again: update.py could not restart the service.
    await refuses();
    await advance(2_000);
    expect(label()).toBe("Retry update");
    // The retry: the service refuses the hold, and the desktop cannot write the request.
    stopHolds.push(false);
    bridge.installServiceUpdate.mockImplementationOnce(async () => {
      calls.push("installServiceUpdate:force");
      throw new Error("The desktop could not write the request.");
    });
    calls.length = 0;
    await click();
    await advance(0);
    expect(calls.slice(0, 3)).toEqual(STOP_AND_INSTALL);
    expect(lastToast().type).toBe("error");
    expect(lastToast().description).toContain("could not write the request");
  });
});
