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

// "Update now" around a held restart, one case for each guard on its way:
// how close to the hold's end the work is held again, what the toast says
// after a renewal, a retry or a look, which window takes a lapse over, and
// how long a stop or the app's restart is waited for.

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
    title: string;
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

// A provider step still finishing in the service.
const EFFECT = {
  kind: "effect" as const,
  count: 1,
  threadId: null,
  threadTitle: null,
  projectId: null,
  projectTitle: null,
};

/** Stops (not looks) report `blockers` from now on. */
function stopsReport(blockers: ReadonlyArray<typeof EFFECT>, times = Number.POSITIVE_INFINITY) {
  const prepare = state.prepare.getMockImplementation()!;
  let left = times;
  state.prepare.mockImplementation(async (value: { input: ServerPrepareServiceUpdateInput }) => {
    const result = await prepare(value);
    const { stopWork, releaseHold } = value.input;
    if (left > 0 && stopWork && !releaseHold && result._tag === "Success") {
      left -= 1;
      return { ...result, value: { ...result.value, idle: false, blockers } };
    }
    return result;
  });
}

/** Presses the toast's own action ("Try again" or "Update now"). */
async function pressToastAction() {
  const action = (lastToast() as { actionProps?: { onClick?: () => void } }).actionProps;
  await act(async () => {
    action?.onClick?.();
  });
}

const installing = (): StudioServiceUpdateState => ({
  ...agent,
  status: "installing",
  message: "Installing SpecWithCode 0.2.5",
  updatedAt: iso(Date.now() + 500),
  pendingInstall: agent.pendingInstall ? { ...agent.pendingInstall, handled: true } : null,
});

const installed = (): StudioServiceUpdateState => ({
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

/** The agent lets the request lapse before it could start. */
async function lapses() {
  await publish({
    ...agent,
    status: "error",
    message: SERVICE_REQUEST_EXPIRED,
    updatedAt: iso(Date.now() + 500),
    pendingInstall: null,
  });
}

describe("Update now around a held restart: guards", () => {
  it("holds the work again when the service restarts 90 s before the hold ends", async () => {
    const pressedAt = await pressUpdateNow();
    await advance(pressedAt + 15 * 60_000 - 90_000 - Date.now());
    await serviceRestarted();
    calls.length = 0;
    await advance(10_000);
    expect(stops()).toEqual(["prepare:true+hold"]);
    expect(lastToast().description).not.toBe(SERVICE_HOLD_ENDED);
  });

  it("stops saying the service restarted once a lapse is renewed while the work is held again", async () => {
    await pressUpdateNow();
    const finishStop = slowStop();
    await serviceRestarted();
    await advance(10_000);
    expect(lastToast().description).toContain(SERVICE_RESTARTED);
    await lapses();
    await advance(2_000);
    expect(calls).toContain("installServiceUpdate:force");
    expect(lastToast().description).not.toContain(SERVICE_RESTARTED);
    await finishStop(true);
  });

  it("says what still runs as the stop that holds the work again reports it", async () => {
    await pressUpdateNow();
    stopsReport([EFFECT]);
    await serviceRestarted();
    await advance(10_000);
    expect(asksAgain()).toEqual(["prepare:true+hold", "installServiceUpdate:force"]);
    expect(lastToast().description).toContain("Still running: 1 provider step finishing.");
  });

  it("says the service restarted, not what ran in it before, while the work is held again", async () => {
    stopsReport([EFFECT], 1);
    agent = m4Refusal();
    state.service = agent;
    render();
    await advance(0);
    await click();
    expect(lastToast().description).toContain("Still running: 1 provider step finishing.");
    // The service restarts before the first look.
    await advance(3_000);
    const finishStop = slowStop();
    await serviceRestarted();
    calls.length = 0;
    await advance(10_000);
    expect(stops()).toEqual(["prepare:true+hold"]);
    expect(lastToast().description).toContain(SERVICE_RESTARTED);
    expect(lastToast().description).not.toContain("Still running");
    await finishStop();
    expect(lastToast().description).not.toContain(SERVICE_RESTARTED);
  });

  it("drops what still ran from the toast once a look finds it finished", async () => {
    stopsReport([EFFECT], 1);
    agent = m4Refusal();
    state.service = agent;
    render();
    await advance(0);
    await click();
    expect(lastToast().description).toContain("Still running: 1 provider step finishing.");
    await advance(12_000);
    expect(lastToast().description).not.toContain("Still running");
  });

  it("times the install of a retry afresh, not from the failed attempt's install", async () => {
    await pressUpdateNow();
    await publish(installing());
    await advance(4_000);
    await publish({
      ...agent,
      status: "error",
      message: "The update did not install.",
      updatedAt: iso(Date.now() + 500),
      pendingInstall: null,
    });
    await advance(2_000);
    expect(lastToast().type).toBe("error");
    // Half an hour later, Try again; the agent installs straight away.
    await advance(30 * 60_000);
    calls.length = 0;
    await pressToastAction();
    await advance(0);
    expect(calls).toContain("installServiceUpdate:force");
    await publish(installing());
    await advance(2_000);
    expect(lastToast().type).not.toBe("error");
    expect(lastToast().title).toMatch(/^Installing/);
  });

  it("says nothing of a restart when Retry update follows a failure while the work was held again", async () => {
    await pressUpdateNow();
    held = false;
    // The stop that holds the work again gets no answer and holds nothing.
    stopHolds.push("none");
    await advance(10_000);
    expect(stops()).toEqual(["prepare:true+hold"]);
    expect(lastToast().description).toContain(SERVICE_RESTARTED);
    await publish({
      ...agent,
      status: "error",
      message: "Checking for updates failed",
      checkedAt: null,
      updatedAt: iso(Date.now()),
    });
    await advance(4_000);
    expect(label()).toBe("Retry update");
    await publish({
      ...agent,
      status: "downloaded",
      message: null,
      checkedAt: iso(Date.now()),
      updatedAt: iso(Date.now()),
      pendingInstall: null,
    });
    calls.length = 0;
    await click();
    await advance(1_000);
    expect(calls).toContain("installServiceUpdate:force");
    expect(lastToast().description).not.toContain(SERVICE_RESTARTED);
  });

  it("sends no stop for the agent's release once a press failed", async () => {
    agent = { ...m4Refusal(), status: "available", message: null, downloadedVersion: null };
    state.service = agent;
    render();
    await advance(0);
    stopHolds.push(false);
    // The desktop cannot write the request, but only says so after a while.
    let refuse: () => void = () => undefined;
    bridge.installServiceUpdate.mockImplementationOnce(async () => {
      calls.push("installServiceUpdate:force");
      await new Promise<void>((resolve) => (refuse = resolve));
      throw new Error("The desktop could not write the request.");
    });
    await click();
    expect(calls).toEqual(STOP_AND_INSTALL);
    // A read of the agent is under way as the press fails; it finds the release.
    let answer: (next: StudioServiceUpdateState) => void = () => undefined;
    bridge.getServiceUpdateState.mockImplementationOnce(
      () => new Promise<StudioServiceUpdateState>((resolve) => (answer = resolve)),
    );
    await advance(2_000);
    await act(async () => refuse());
    await advance(0);
    expect(lastToast().type).toBe("error");
    calls.length = 0;
    // The desktop still reports a request pending: the one it wrote before it failed.
    const requestedAt = Date.now() - 2_000;
    await act(async () =>
      answer({
        ...agent,
        status: "downloaded",
        downloadedVersion: "0.2.5",
        updatedAt: iso(Date.now()),
        pendingInstall: {
          requestedAt: iso(requestedAt),
          mode: "force",
          version: "0.2.5",
          holdUntil: iso(requestedAt + 15 * 60_000),
          handled: false,
        },
      }),
    );
    await advance(2_000);
    expect(stops()).toEqual([]);
  });

  it("says the hold ended when the request is found lapsed as it is asked again after its hold", async () => {
    const pressedAt = await pressUpdateNow();
    const holdUntil = pressedAt + 15 * 60_000;
    await advance(holdUntil + 5_000 - Date.now());
    calls.length = 0;
    // The next look still finds the work held; the desktop lapses the request
    // right after, and the service lets its hold go.
    afterLook = () => {
      agent = { ...agent, pendingInstall: null };
      held = false;
    };
    await advance(10_000);
    await advance(10_000);
    expect(lastToast().description).toBe(SERVICE_HOLD_ENDED);
    expect(state.closeToast).not.toHaveBeenCalled();
  });

  it("withdraws its request and lets the work go when it lapses a fourth time", async () => {
    await pressUpdateNow();
    for (let renewal = 0; renewal < 3; renewal += 1) {
      await lapses();
      await advance(2_000);
    }
    expect(stops()).toHaveLength(3);
    calls.length = 0;
    await lapses();
    await advance(2_000);
    expect(lastToast().type).toBe("error");
    expect(calls).toEqual(["cancelServiceUpdate", "prepare:release"]);
    // Another window's press since does not take the failure over.
    const at = Date.now();
    await publish({
      ...agent,
      status: "waiting-for-quiet",
      message: null,
      updatedAt: iso(at),
      pendingInstall: {
        requestedAt: iso(at),
        mode: "force",
        version: "0.2.5",
        holdUntil: iso(at + 15 * 60_000),
        handled: false,
      },
    });
    await advance(2_000);
    expect(lastToast().type).toBe("error");
    expect(label()).toBe("Retry update");
  });

  it("does not follow a renewal written while this window cancels the request it follows", async () => {
    await followOtherWindowsRequest();
    // The agent let the request lapse, and the pressing window's renewal lands
    // as this one cancels.
    bridge.cancelServiceUpdate.mockImplementationOnce(async () => {
      calls.push("cancelServiceUpdate");
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
      return { ...agent };
    });
    await pressCancelInToast();
    await advance(0);
    expect(calls).toEqual(["cancelServiceUpdate", "prepare:release"]);
    expect(state.closeToast).toHaveBeenCalledWith("toast-1");
    expect(label()).not.toBe("Updating…");
  });

  it("withdraws the request of an install it took over when its timed-out toast is closed", async () => {
    // A press whose failure was dealt with (withdrawn, the work let go) before its toast closed.
    agent = m4Refusal();
    state.service = agent;
    render();
    await advance(0);
    await click();
    await publish({
      ...agent,
      status: "error",
      message: "The update did not install.",
      updatedAt: iso(Date.now() + 500),
    });
    await advance(2_000);
    expect(calls).toEqual([...STOP_AND_INSTALL, "cancelServiceUpdate", "prepare:release"]);
    const close = (lastToast().data as { onClose?: () => void } | undefined)?.onClose;
    await act(async () => close?.());
    await advance(0);
    // Another window presses, and the agent installs its request: this window takes it over.
    held = true;
    const at = Date.now();
    await publish({
      ...agent,
      status: "installing",
      message: "Installing SpecWithCode 0.2.5",
      updatedAt: iso(at),
      pendingInstall: {
        requestedAt: iso(at - 1_000),
        mode: "force",
        version: "0.2.5",
        holdUntil: iso(at + 15 * 60_000),
        handled: true,
      },
    });
    await advance(2_000);
    expect(label()).not.toBe("Update now");
    // The install never finishes: the window gives up on it after 45 minutes.
    await advance(46 * 60_000);
    expect(lastToast().type).toBe("error");
    calls.length = 0;
    const closeTimedOut = (lastToast().data as { onClose?: () => void } | undefined)?.onClose;
    await act(async () => closeTimedOut?.());
    await advance(0);
    expect(calls).toContain("cancelServiceUpdate");
  });

  it("holds a later press's work again only once while its stop drains, when an older stop answers", async () => {
    await pressUpdateNow();
    const finishFirst = slowStop();
    await serviceRestarted();
    await advance(10_000);
    await pressCancelInToast();
    await publish(agent);
    expect(label()).toBe("Update now");
    // Update now again: the service restarts under this press too, and its
    // work is held again by a stop that drains.
    calls.length = 0;
    await click();
    expect(calls).toEqual(STOP_AND_INSTALL);
    const finishSecond = slowStop();
    await serviceRestarted();
    calls.length = 0;
    await advance(10_000);
    expect(stops()).toEqual(["prepare:true+hold"]);
    // The first press's stop answers only now.
    await finishFirst(false);
    calls.length = 0;
    await advance(20_000);
    expect(stops()).toEqual([]);
    await finishSecond();
    expect(asksAgain()).toEqual(["installServiceUpdate:force"]);
  });

  it("gives the app 75 s to restart into its update before the update ends", async () => {
    await pressUpdateNow();
    await publish(installing());
    await advance(4_000);
    await publish(installed());
    await advance(4_000);
    expect(calls).toContain("installUpdate:0.2.5");
    await advance(66_000);
    expect(state.closeToast).not.toHaveBeenCalled();
    await advance(10_000);
    expect(state.closeToast).toHaveBeenCalledWith("toast-1");
  });

  it("lets the request go ahead 90 s after a stop that never answers", async () => {
    agent = m4Refusal();
    state.service = agent;
    render();
    await advance(0);
    stopHolds.push(() => new Promise<boolean>(() => undefined));
    await click();
    expect(calls).toEqual(["prepare:false", "prepare:true+hold"]);
    expect(label()).toBe("Stopping tasks…");
    await advance(60_000);
    expect(calls).not.toContain("installServiceUpdate:force");
    await advance(31_000);
    expect(calls).toContain("installServiceUpdate:force");
    expect(label()).toBe("Updating…");
    expect(lastToast().type).not.toBe("error");
  });
});
