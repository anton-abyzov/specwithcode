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

// "Update now" in a window that only follows another window's request, or
// takes one up again after a reload: when the agent lets the request lapse,
// an old failure's toast is closed, or a look answers after a press.

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
// Whether each stop holds the work, in turn; true once these run out.
let stopHolds: boolean[] = [];
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
  ) as { type: string; description: string; data?: { onClose?: () => void } };
}

/** Closes the service update's toast with its X. */
async function closeToast() {
  const close = lastToast().data?.onClose;
  expect(typeof close).toBe("function");
  await act(async () => {
    close?.();
  });
  await advance(0);
}

/** About (or the header pill) asks for the downloaded update. */
async function pressAbout() {
  await act(async () => {
    requestRestartToUpdate();
  });
  await advance(0);
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
  version = "0.2.5",
): NonNullable<StudioServiceUpdateState["pendingInstall"]> {
  return {
    requestedAt: iso(requestedAt),
    mode: "force",
    version,
    holdUntil: iso(requestedAt + 15 * 60_000),
    handled: false,
  };
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

const asksAgain = () =>
  calls.filter(
    (call) => call.startsWith("prepare:true") || call.startsWith("installServiceUpdate"),
  );

/** Another window's request, held while work runs, written 9 minutes ago: followed here. */
async function followHeldRequest() {
  const requestedAt = Date.now() - 9 * 60_000;
  checked = { ...RUNNING, held: true };
  agent = {
    ...serviceWaiting,
    message: "Waiting for open terminals to close",
    updatedAt: iso(requestedAt + 500),
    pendingInstall: pendingForce(requestedAt),
  };
  state.service = agent;
  render();
  await advance(0);
  expect(label()).toBe("Updating…");
  calls.length = 0;
}

/**
 * The agent let the followed request lapse a second ago; `renewedAfter` ms
 * later the window that pressed renewed it, unless null.
 */
function agentLetsRequestLapse(renewedAfter: number | null) {
  const lapsedAt = Date.now() - 1_000;
  agent = {
    ...serviceWaiting,
    status: "error",
    message: SERVICE_REQUEST_EXPIRED,
    updatedAt: iso(lapsedAt),
    pendingInstall: renewedAfter === null ? null : pendingForce(lapsedAt + renewedAfter),
  };
}

const withdrawsOrReleases = () =>
  calls.filter((call) => call === "cancelServiceUpdate" || call === "prepare:release");

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
    return { _tag: "Success", value: { ...IDLE, held: stopHolds.shift() ?? true } };
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

describe("a window that only follows another window's request", () => {
  describe("when the agent lets that request lapse", () => {
    it("follows the renewal the window that pressed wrote, and withdraws nothing", async () => {
      await followHeldRequest();
      agentLetsRequestLapse(300);
      await advance(2_000);
      expect(withdrawsOrReleases()).toEqual([]);
      expect(lastToast().type).not.toBe("error");
      expect(label()).toBe("Updating…");
    });

    it("leaves the request and the work to the window that pressed, until it renews", async () => {
      await followHeldRequest();
      agentLetsRequestLapse(null);
      await advance(2_000);
      expect(lastToast()).toMatchObject({ type: "error", description: SERVICE_REQUEST_EXPIRED });
      expect(withdrawsOrReleases()).toEqual([]);
      // The renewal is published: the window follows it instead of its failure.
      await publish({ ...agent, pendingInstall: pendingForce(Date.now()) });
      expect(label()).toBe("Updating…");
      expect(lastToast().type).not.toBe("error");
      expect(withdrawsOrReleases()).toEqual([]);
    });

    it("withdraws nothing when that failure's toast is closed", async () => {
      await followHeldRequest();
      agentLetsRequestLapse(null);
      await advance(2_000);
      expect(lastToast().type).toBe("error");
      calls.length = 0;
      await closeToast();
      await advance(2_000);
      expect(withdrawsOrReleases()).toEqual([]);
    });

    it("withdraws nothing on close when a renewal shown late had already run out", async () => {
      await followHeldRequest();
      agentLetsRequestLapse(null);
      await advance(2_000);
      expect(lastToast()).toMatchObject({ type: "error", description: SERVICE_REQUEST_EXPIRED });
      const renewedAt = Date.now();
      await advance(16 * 60_000);
      // A publish still shows the renewal, whose hold ran out a minute ago;
      // the desktop no longer reports it.
      state.service = { ...agent, pendingInstall: pendingForce(renewedAt) };
      rerender();
      await advance(0);
      expect(lastToast()).toMatchObject({ type: "error", description: SERVICE_REQUEST_EXPIRED });
      calls.length = 0;
      await closeToast();
      await advance(2_000);
      expect(withdrawsOrReleases()).toEqual([]);
    });

    it("withdraws the renewal it follows when that renewal's timed-out install is closed", async () => {
      await followHeldRequest();
      agentLetsRequestLapse(null);
      await advance(2_000);
      expect(lastToast()).toMatchObject({ type: "error", description: SERVICE_REQUEST_EXPIRED });
      const renewedAt = Date.now();
      await publish({ ...agent, pendingInstall: pendingForce(renewedAt) });
      expect(label()).toBe("Updating…");
      // The agent installs the renewal, but the install outlasts its budget.
      agent = {
        ...serviceWaiting,
        status: "installing",
        updatedAt: iso(Date.now() + 500),
        pendingInstall: { ...pendingForce(renewedAt), handled: true },
      };
      await advance(2_000);
      expect(label()).toBe("Installing…");
      await advance(25 * 60_000);
      expect(lastToast().description).toContain("has not finished after 25 minutes");
      calls.length = 0;
      await closeToast();
      // As for any install that timed out: its request is withdrawn, and the
      // work stays held, since the install may still run.
      expect(withdrawsOrReleases()).toEqual(["cancelServiceUpdate"]);
    });

    it("installs the app after the renewal it follows, also after a reload", async () => {
      const store = useSessionStorage();
      await followHeldRequest();
      // About adds the app's install to the request followed here.
      await pressAbout();
      expect(calls).toEqual([]);
      expect(store.has(FOLLOW_UP_KEY)).toBe(true);
      agentLetsRequestLapse(null);
      await advance(2_000);
      // A failure installs nothing, also after a reload...
      expect(store.has(FOLLOW_UP_KEY)).toBe(false);
      const renewedAt = Date.now();
      await publish({ ...agent, pendingInstall: pendingForce(renewedAt) });
      expect(label()).toBe("Updating…");
      // ...but the renewal followed since does.
      reloadWindow(store);
      render();
      await advance(0);
      expect(label()).toBe("Updating…");
      agent = {
        ...serviceWaiting,
        status: "installing",
        updatedAt: iso(Date.now()),
        pendingInstall: { ...pendingForce(renewedAt), handled: true },
      };
      await advance(2_000);
      agent = {
        ...serviceWaiting,
        status: "installed",
        installedVersion: "0.2.5",
        availableVersion: null,
        downloadedVersion: null,
        updatedAt: iso(Date.now()),
        pendingInstall: null,
        lastInstall: { at: iso(Date.now()), version: "0.2.5", result: "updated" },
      };
      await advance(4_000);
      expect(calls).toContain("installUpdate:0.2.5");
    });
  });
});

describe("an old failure's toast closed after another window pressed", () => {
  it("leaves that window's newer request alone", async () => {
    state.service = serviceWaiting;
    render();
    const pressedAt = Date.now();
    await click();
    expect(calls).toEqual(STOP_AND_INSTALL);
    agent = {
      ...serviceWaiting,
      status: "installing",
      updatedAt: iso(pressedAt + 500),
      pendingInstall: { ...pendingForce(pressedAt), handled: true },
    };
    await advance(2_000);
    expect(label()).toBe("Installing…");
    // The install outlasts its budget: the failure stays, and the agent may still install.
    await advance(25 * 60_000);
    expect(lastToast().description).toContain("has not finished after 25 minutes");
    // The install ended since, and another window pressed Update now.
    const otherAt = Date.now();
    checked = { ...RUNNING, held: true };
    agent = {
      ...serviceWaiting,
      updatedAt: iso(otherAt + 500),
      pendingInstall: pendingForce(otherAt),
    };
    calls.length = 0;
    await closeToast();
    await advance(2_000);
    expect(withdrawsOrReleases()).toEqual([]);
  });
});

describe("a window that reloaded during its own Update now", () => {
  it("asks nothing for its request once that request's hold ran out", async () => {
    const store = useSessionStorage();
    // Update now before the agent has 0.2.5: the service refuses to hold the work.
    stopHolds = [false];
    agent = {
      ...serviceWaiting,
      status: "up-to-date",
      availableVersion: null,
      downloadedVersion: null,
      updatedAt: iso(Date.now() - 60_000),
      pendingInstall: null,
    };
    state.service = agent;
    render();
    const pressedAt = Date.now();
    await click();
    expect(calls).toEqual(STOP_AND_INSTALL);
    // The window reloads once the hold ran out; the agent never took the request up.
    reloadWindow(store);
    await advance(16 * 60_000);
    agent = { ...agent, pendingInstall: pendingForce(pressedAt) };
    state.service = agent;
    checked = { ...IDLE, held: false };
    render();
    await advance(0);
    // Another window presses Update now: its request is held, and followed here.
    const otherAt = Date.now();
    checked = { ...IDLE, held: true };
    await publish({
      ...serviceWaiting,
      updatedAt: iso(otherAt + 500),
      pendingInstall: pendingForce(otherAt),
    });
    expect(label()).toBe("Updating…");
    calls.length = 0;
    // Nothing runs and the agent went quiet: only a window's own request is asked again.
    await advance(60_000);
    expect(asksAgain()).toEqual([]);
  });

  it("does not install the app over a press made during its first look", async () => {
    const store = useSessionStorage();
    state.service = serviceWaiting;
    render();
    const pressedAt = Date.now();
    await click();
    expect(calls).toEqual(STOP_AND_INSTALL);
    // The window reloads; the service finished the update meanwhile.
    reloadWindow(store);
    const doneAt = pressedAt + 60_000;
    const finished: StudioServiceUpdateState = {
      ...serviceWaiting,
      status: "installed",
      installedVersion: "0.2.5",
      availableVersion: null,
      downloadedVersion: null,
      updatedAt: iso(doneAt),
      pendingInstall: null,
      lastInstall: { at: iso(doneAt), version: "0.2.5", result: "updated" },
    };
    await advance(2 * 60_000);
    // The app found 0.2.6 since and downloads it.
    state.app = {
      ...downloaded,
      status: "downloading",
      availableVersion: "0.2.6",
      downloadedVersion: null,
      downloadPercent: 40,
    };
    state.service = finished;
    agent = finished;
    checked = { ...IDLE, held: true };
    const answerLook = slowLook();
    render();
    await advance(0);
    // Another window asks for the service's 0.2.6, and a press here follows it.
    const otherAt = Date.now();
    await publish({
      ...finished,
      status: "downloaded",
      availableVersion: "0.2.6",
      downloadedVersion: "0.2.6",
      updatedAt: iso(otherAt + 500),
      pendingInstall: pendingForce(otherAt, "0.2.6"),
    });
    expect(label()).toBe("Update now");
    await click();
    expect(label()).toBe("Updating…");
    // The window's first look answers only now.
    await answerLook();
    await advance(2_000);
    expect(calls).not.toContain("installUpdate:0.2.5");
    expect(label()).toBe("Updating…");
  });
});

describe("a window that opens while the agent fetches a release", () => {
  it("looks again shortly when no request is pending, while the service cannot answer", async () => {
    // The service is restarting: looks get no answer at first.
    const answer = state.prepare.getMockImplementation()!;
    let looks = 0;
    let lookFails = true;
    state.prepare.mockImplementation(async (value: { input: ServerPrepareServiceUpdateInput }) => {
      if (value.input.stopWork) return answer(value);
      looks += 1;
      return lookFails ? { _tag: "Failure" } : answer(value);
    });
    // The desktop reports no request, only the agent fetching 0.2.5.
    agent = {
      ...serviceWaiting,
      status: "downloading",
      downloadedVersion: null,
      updatedAt: iso(Date.now()),
      pendingInstall: null,
    };
    state.service = agent;
    render();
    await advance(0);
    expect(looks).toBe(1);
    lookFails = false;
    checked = { ...IDLE, held: true };
    await advance(5_000);
    expect(looks).toBe(2);
    expect(lastToast()).toBeDefined();
  });
});
