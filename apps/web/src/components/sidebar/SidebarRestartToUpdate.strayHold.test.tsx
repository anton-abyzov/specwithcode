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

// "Update now" when a stop's hold outlives the attempt it was taken for: the
// hold is let go once nothing needs it, and kept for an update that does (a
// press made again in this window, or a newer one in another window).

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
const requests = () => calls.filter((call) => call.startsWith("installServiceUpdate"));

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

/**
 * Update now from M4's state, and the service restarts under the request. The
 * stop that holds the work again answers held, and the read that comes before
 * asking again answers, with the state it was asked in, only once the
 * function returned runs.
 */
async function heldAgainWhileReading(): Promise<() => Promise<void>> {
  await pressUpdateNow();
  await serviceRestarted();
  const finishStop = slowStop();
  await advance(10_000);
  expect(stops()).toEqual(["prepare:true+hold"]);
  let answer: () => void = () => undefined;
  const read = bridge.getServiceUpdateState.getMockImplementation()!;
  let hangNext = true;
  bridge.getServiceUpdateState.mockImplementation(async () => {
    if (!hangNext) return read();
    hangNext = false;
    const before = agent;
    await new Promise<void>((resolve) => (answer = resolve));
    return before;
  });
  await finishStop(true);
  expect(held).toBe(true);
  return async () => {
    await act(async () => answer());
    await advance(0);
  };
}

/** As heldAgainWhileReading; another window then cancels, and the next read ends the attempt. */
async function cancelledWhileAskingAgain(): Promise<() => Promise<void>> {
  const releaseRead = await heldAgainWhileReading();
  // Another window's Cancel: the desktop withdraws the request.
  agent = { ...agent, pendingInstall: null, updatedAt: iso(Date.now() + 100) };
  state.service = agent;
  await advance(2_500);
  expect(label()).toBe("Update now");
  return releaseRead;
}

describe("Update now when another window cancels while this one asks again under a new hold", () => {
  it("lets that hold go once a read of the agent ended the attempt", async () => {
    const releaseRead = await cancelledWhileAskingAgain();
    calls.length = 0;
    await releaseRead();
    await advance(12_000);
    expect(calls).toContain("prepare:release");
    expect(calls).not.toContain("installServiceUpdate:force");
    expect(held).toBe(false);
    expect(label()).toBe("Update now");
  });

  it("keeps the hold of a press made again while that press stops the work", async () => {
    const releaseRead = await cancelledWhileAskingAgain();
    calls.length = 0;
    const finishStop = slowStop();
    await click();
    expect(calls).toEqual(["prepare:false", "prepare:true+hold"]);
    await releaseRead();
    await finishStop(true);
    await advance(2_000);
    expect(calls).toEqual(STOP_AND_INSTALL);
    expect(held).toBe(true);
    expect(label()).toBe("Updating…");
  });

  it("keeps the hold of a press made again while the desktop writes its request", async () => {
    const releaseRead = await cancelledWhileAskingAgain();
    let written: () => void = () => undefined;
    const install = bridge.installServiceUpdate.getMockImplementation()!;
    bridge.installServiceUpdate.mockImplementation(async (options) => {
      await new Promise<void>((resolve) => (written = resolve));
      return install(options);
    });
    calls.length = 0;
    await click();
    expect(calls).toEqual(["prepare:false", "prepare:true+hold"]);
    await releaseRead();
    await act(async () => written());
    await advance(2_000);
    expect(calls).toEqual(STOP_AND_INSTALL);
    expect(held).toBe(true);
    expect(label()).toBe("Updating…");
  });

  it("keeps the hold of a newer press in another window", async () => {
    const releaseRead = await cancelledWhileAskingAgain();
    // Another window presses Update now: its stop holds the work, and the
    // desktop reports its request.
    const pressedAt = Date.now();
    agent = {
      ...agent,
      pendingInstall: {
        requestedAt: iso(pressedAt),
        mode: "force",
        version: "0.2.5",
        holdUntil: iso(pressedAt + 15 * 60_000),
        handled: false,
      },
    };
    state.service = agent;
    held = true;
    calls.length = 0;
    await releaseRead();
    await advance(2_000);
    expect(calls).not.toContain("prepare:release");
    expect(held).toBe(true);
  });
});

describe("Update now when the agent fails the request while this window asks again", () => {
  /** The agent fails for good, and the desktop no longer reports the request. */
  async function agentFailsForGood() {
    agent = {
      ...agent,
      status: "error",
      message:
        "SpecWithCode cannot be updated right now: the service does not match its installation",
      lastInstall: { version: "0.2.5", at: iso(Date.now()), result: "failed" },
      updatedAt: iso(Date.now() + 100),
      pendingInstall: null,
    };
    state.service = agent;
    await advance(2_500);
    expect(label()).toBe("Retry update");
  }

  it("keeps the failure and Retry update", async () => {
    const releaseRead = await heldAgainWhileReading();
    await agentFailsForGood();
    await releaseRead();
    await advance(2_000);
    expect(label()).toBe("Retry update");
    expect(lastToast().type).toBe("error");
  });

  it("asks only for Retry update's request once the failed attempt's read answers", async () => {
    const releaseRead = await heldAgainWhileReading();
    await agentFailsForGood();
    calls.length = 0;
    await click();
    expect(stops()).toEqual(["prepare:true+hold"]);
    expect(requests()).toEqual(["installServiceUpdate:force"]);
    calls.length = 0;
    // The ask the failed attempt began under its hold reads the agent only now.
    await releaseRead();
    await advance(2_000);
    expect(requests()).toEqual([]);
  });
});

describe("Update now when a stop answers after its attempt failed", () => {
  it("keeps the hold of a newer press in another window", async () => {
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
    // Another window presses Update now: its stop holds the work, and the
    // desktop reports its request.
    const pressedAt = Date.now();
    agent = {
      ...agent,
      pendingInstall: {
        requestedAt: iso(pressedAt),
        mode: "force",
        version: "0.2.5",
        holdUntil: iso(pressedAt + 15 * 60_000),
        handled: false,
      },
    };
    state.service = agent;
    held = true;
    calls.length = 0;
    // This window's stop ends now, holding.
    await finishStop(true);
    await advance(1_000);
    expect(calls).not.toContain("prepare:release");
    expect(held).toBe(true);
  });
});
