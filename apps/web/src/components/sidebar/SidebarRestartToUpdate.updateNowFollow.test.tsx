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

// "Update now" followed across a reload, a hold the service refused before its
// agent had the release, and another window's request.

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

const FOLLOW_UP_KEY = "specwithcode.serviceUpdate.thenInstallApp";
const STOP_AND_INSTALL = ["prepare:false", "prepare:true+hold", "installServiceUpdate:force"];
const NOT_AVAILABLE = "SpecWithCode 0.2.5 is not available to the service on this Mac yet.";

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
// The request the desktop reports pending, as the desktop this renderer ships
// with does: it stamps each request it takes and drops one cancelled. A state
// that names its own pendingInstall is reported as it is.
let pending: NonNullable<StudioServiceUpdateState["pendingInstall"]> | null = null;
const reported = (agentState: StudioServiceUpdateState): StudioServiceUpdateState => ({
  pendingInstall: pending,
  ...agentState,
});

async function installService(options?: StudioServiceInstallOptions) {
  calls.push(`installServiceUpdate:${options?.force ? "force" : "normal"}`);
  pending = {
    requestedAt: new Date().toISOString(),
    mode: options?.force ? "force" : "normal",
    version: options?.version ?? null,
    holdUntil: options?.holdUntil ?? null,
    handled: false,
  };
  return reported(agent);
}
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
  getServiceUpdateState: vi.fn<() => Promise<StudioServiceUpdateState>>(async () =>
    reported(agent),
  ),
  installUpdate: vi.fn(async (options?: { expectedVersion?: string }) => {
    calls.push(`installUpdate:${options?.expectedVersion ?? ""}`);
    return { ...installResult, state: state.app ?? downloaded };
  }),
  installServiceUpdate: vi.fn<(options?: StudioServiceInstallOptions) => Promise<unknown>>(),
  cancelServiceUpdate: vi.fn(async () => {
    calls.push("cancelServiceUpdate");
    pending = null;
    return reported(agent);
  }),
  getUpdatePreferences: vi.fn(async () => ({
    checkAutomatically: true,
    downloadAutomatically: true,
    installAutomatically: true,
  })),
  ownsBundledService: vi.fn(async () => true),
};

let renderer: ReactTestRenderer | null = null;
let mountCalls: string[] = [];

function render() {
  act(() => {
    renderer = create(<SidebarRestartToUpdate />);
  });
  mountCalls = calls.splice(0);
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
  pending = null;
  checked = { idle: true, stoppedThreads: 0, blockers: [] };
  prepared = { idle: true, stoppedThreads: 0, blockers: [], held: true };
  state.prepare.mockReset();
  answerPrepare(() => true);
  reload.mockReset();
  bridge.getServiceUpdateState.mockReset();
  bridge.getServiceUpdateState.mockImplementation(async () => reported(agent));
  bridge.installUpdate.mockClear();
  bridge.installServiceUpdate.mockReset();
  bridge.installServiceUpdate.mockImplementation(installService);
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

const upToDate = (): StudioServiceUpdateState => ({
  ...serviceWaiting,
  status: "up-to-date",
  availableVersion: null,
  downloadedVersion: null,
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

const appHas026: DesktopUpdateState = {
  ...downloaded,
  availableVersion: "0.2.6",
  downloadedVersion: "0.2.6",
};

/** The agent's state once another window cancelled the request: none is pending. */
const cancelledElsewhere = (): StudioServiceUpdateState => ({
  ...serviceWaiting,
  status: "downloaded",
  message: "Update cancelled",
  updatedAt: new Date(Date.now() + 1_000).toISOString(),
  pendingInstall: null,
});

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

/** A look at the service gets no answer; stopping and holding is not answered either. */
function lookUnanswered() {
  state.prepare.mockImplementation(async (value: { input: ServerPrepareServiceUpdateInput }) => {
    calls.push(prepareCall(value.input));
    return { _tag: "Failure" };
  });
}

describe("Update now followed across a reload and other windows", () => {
  describe("a reload during Update now for both", () => {
    it("installs the app once the service is up to date on the version asked for", async () => {
      const store = useSessionStorage();
      state.service = serviceWaiting;
      render();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      reloadWindow(store);
      checked = { ...checked, held: false };
      // The agent installed 0.2.5 for the press, then its next pass found nothing newer.
      const doneAt = new Date(Date.now() + 1_000).toISOString();
      agent = {
        ...serviceWaiting,
        status: "up-to-date",
        installedVersion: "0.2.5",
        availableVersion: null,
        downloadedVersion: null,
        updatedAt: new Date(Date.now() + 2_000).toISOString(),
        lastInstall: { version: "0.2.5", at: doneAt, result: "updated" },
      };
      state.service = agent;
      render();
      await advance(0);
      expect(calls.at(-1)).toBe("installUpdate:0.2.5");
    });

    it("does not install the app after the agent installs another version on its own", async () => {
      const store = useSessionStorage();
      state.service = serviceWaiting;
      render();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      expect(store.has(FOLLOW_UP_KEY)).toBe(true);
      reloadWindow(store);
      checked = { ...checked, held: false };
      // The agent installs 0.2.6, a newer release it found, at a quiet moment of its own.
      agent = {
        ...serviceWaiting,
        status: "installing",
        availableVersion: "0.2.6",
        downloadedVersion: "0.2.6",
        updatedAt: new Date(Date.now() + 1_000).toISOString(),
      };
      state.service = agent;
      render();
      await advance(0);
      const doneAt = new Date(Date.now() + 3_000).toISOString();
      agent = {
        ...agent,
        status: "installed",
        installedVersion: "0.2.6",
        availableVersion: null,
        downloadedVersion: null,
        updatedAt: doneAt,
        lastInstall: { version: "0.2.6", at: doneAt, result: "updated" },
      };
      await advance(4_000);
      expect(calls.filter((call) => call.startsWith("installUpdate"))).toEqual([]);
    });

    it("does not install the app when the service does not say when it installed", async () => {
      const store = useSessionStorage();
      state.service = serviceWaiting;
      render();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      reloadWindow(store);
      checked = { ...checked, held: false };
      agent = {
        ...serviceWaiting,
        status: "installed",
        installedVersion: "0.2.5",
        availableVersion: null,
        downloadedVersion: null,
        updatedAt: new Date(Date.now() + 1_000).toISOString(),
        lastInstall: null,
      };
      state.service = agent;
      render();
      await advance(0);
      expect(calls.filter((call) => call.startsWith("installUpdate"))).toEqual([]);
    });

    it("installs the app when the service does not answer a look yet", async () => {
      const store = useSessionStorage();
      state.service = serviceWaiting;
      render();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      reloadWindow(store);
      // The service is restarting into its new version: a look gets no answer.
      lookUnanswered();
      const doneAt = new Date(Date.now() + 1_000).toISOString();
      agent = {
        ...serviceWaiting,
        status: "installed",
        installedVersion: "0.2.5",
        updatedAt: doneAt,
        lastInstall: { version: "0.2.5", at: doneAt, result: "updated" },
      };
      state.service = agent;
      render();
      await advance(0);
      await advance(2_000);
      expect(calls).toContain("installUpdate:0.2.5");
    });

    it("looks again every 5 seconds, 36 times, while a look gets no answer", async () => {
      agent = { ...serviceWaiting, status: "installing", updatedAt: new Date().toISOString() };
      state.service = agent;
      lookUnanswered();
      render();
      await advance(0);
      const looks = () => [...mountCalls, ...calls].filter((call) => call === "prepare:false");
      await advance(4_000);
      expect(looks()).toHaveLength(1);
      for (let step = 0; step < 60; step += 1) await advance(5_000);
      expect(looks()).toHaveLength(37);
    });

    it("looks again 36 times anew once a look got its answer", async () => {
      const requestedAt = Date.now();
      // Another window's request while the agent fetches the release: nothing is held yet.
      agent = {
        ...serviceWaiting,
        status: "downloading",
        downloadedVersion: null,
        updatedAt: new Date(requestedAt + 500).toISOString(),
        pendingInstall: pendingForce(requestedAt),
      };
      state.service = agent;
      lookUnanswered();
      render();
      await advance(0);
      const looks = () => [...mountCalls, ...calls].filter((call) => call === "prepare:false");
      for (let step = 0; step < 20; step += 1) await advance(5_000);
      expect(looks()).toHaveLength(21);
      // One look gets its answer: the service holds nothing.
      checked = { ...checked, held: false };
      answerPrepare(() => false);
      await advance(5_000);
      await advance(30_000);
      expect(looks()).toHaveLength(22);
      // A later state finds the service without an answer again.
      lookUnanswered();
      agent = { ...agent, updatedAt: new Date().toISOString() };
      state.service = agent;
      rerender();
      await advance(0);
      for (let step = 0; step < 60; step += 1) await advance(5_000);
      expect(looks()).toHaveLength(22 + 37);
    });

    it("forgets the app's install once another window cancels the request", async () => {
      const store = useSessionStorage();
      state.service = serviceWaiting;
      render();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      expect(store.has(FOLLOW_UP_KEY)).toBe(true);
      reloadWindow(store);
      // Another window cancels while this one reloads, and the service holds nothing.
      agent = cancelledElsewhere();
      checked = { ...checked, held: false };
      state.service = agent;
      render();
      await advance(0);
      await advance(2_000);
      expect(store.has(FOLLOW_UP_KEY)).toBe(false);
      // Later the agent installs 0.2.5 at a quiet moment of its own: the window only reloads.
      await advance(10 * 60_000);
      agent = { ...serviceWaiting, status: "installing", updatedAt: new Date().toISOString() };
      state.service = agent;
      rerender();
      await advance(0);
      expect(label()).toBe("Installing…");
      agent = { ...serviceWaiting, status: "installed", installedVersion: "0.2.5" };
      await advance(2_000);
      await advance(5_000);
      expect(calls).not.toContain("installUpdate:0.2.5");
      expect(reload).toHaveBeenCalled();
    });

    it("does not install the app after another window's cancel, through a second reload", async () => {
      const store = useSessionStorage();
      state.service = serviceWaiting;
      render();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      reloadWindow(store);
      agent = cancelledElsewhere();
      checked = { ...checked, held: false };
      state.service = agent;
      render();
      await advance(0);
      await advance(10 * 60_000);
      // The agent installed 0.2.5 on its own; the service restarted and this window reloads into it.
      reloadWindow(store);
      const doneAt = new Date(Date.now() + 1_000).toISOString();
      agent = {
        ...serviceWaiting,
        status: "installed",
        installedVersion: "0.2.5",
        updatedAt: doneAt,
        lastInstall: { version: "0.2.5", at: doneAt, result: "updated" },
      };
      state.service = agent;
      render();
      await advance(0);
      expect([...mountCalls, ...calls]).not.toContain("installUpdate:0.2.5");
    });

    /** Update now for both, then this window's Cancel while the agent waits for quiet. */
    async function pressThenCancel(store: Map<string, string>) {
      state.service = serviceWaiting;
      render();
      const pressedAt = Date.now();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      expect(JSON.parse(store.get(FOLLOW_UP_KEY)!)).toMatchObject({ serviceVersion: "0.2.5" });
      agent = {
        ...serviceWaiting,
        updatedAt: new Date(pressedAt + 500).toISOString(),
        pendingInstall: pendingForce(pressedAt),
      };
      await advance(2_000);
      await act(async () => {
        await cancelServiceUpdate();
      });
      expect(store.has(FOLLOW_UP_KEY)).toBe(false);
      checked = { ...checked, held: false };
    }

    /** Later the agent installs 0.2.5 at a quiet moment of its own. */
    async function agentInstallsOnItsOwn() {
      agent = {
        ...serviceWaiting,
        status: "installing",
        updatedAt: new Date().toISOString(),
        pendingInstall: null,
      };
      state.service = agent;
      rerender();
      await advance(2_000);
      const doneAt = new Date().toISOString();
      agent = {
        ...serviceWaiting,
        status: "installed",
        installedVersion: "0.2.5",
        updatedAt: doneAt,
        pendingInstall: null,
        lastInstall: { version: "0.2.5", at: doneAt, result: "updated" },
      };
      state.service = agent;
      rerender();
      await advance(5_000);
    }

    it("leaves no app install for a reload once this window's Cancel ended the update", async () => {
      const store = useSessionStorage();
      await pressThenCancel(store);
      reloadWindow(store);
      agent = { ...agent, updatedAt: new Date().toISOString(), pendingInstall: null };
      state.service = agent;
      render();
      await advance(10 * 60_000);
      await agentInstallsOnItsOwn();
      expect([...mountCalls, ...calls]).not.toContain("installUpdate:0.2.5");
    });

    it("does not install the app when the agent installs on its own after this window's Cancel", async () => {
      const store = useSessionStorage();
      await pressThenCancel(store);
      await advance(10 * 60_000);
      calls.length = 0;
      await agentInstallsOnItsOwn();
      expect(calls).not.toContain("installUpdate:0.2.5");
    });

    it("installs the app once the service's install ends during a look that gets no answer", async () => {
      const store = useSessionStorage();
      store.set(
        FOLLOW_UP_KEY,
        JSON.stringify({ appVersion: "0.2.5", serviceVersion: "0.2.5", at: Date.now() - 60_000 }),
      );
      agent = { ...serviceWaiting, status: "installing", updatedAt: new Date().toISOString() };
      state.service = agent;
      // The service restarts into its new version: each look takes a second and gets no answer.
      let answering = false;
      state.prepare.mockImplementation(
        async (value: { input: ServerPrepareServiceUpdateInput }) => {
          calls.push(prepareCall(value.input));
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          if (!answering) return { _tag: "Failure" };
          return { _tag: "Success", value: { ...checked, held: false } };
        },
      );
      render();
      await advance(500);
      // The agent finishes while that look is under way; the desktop publishes it once.
      const doneAt = new Date().toISOString();
      agent = {
        ...serviceWaiting,
        status: "installed",
        installedVersion: "0.2.5",
        availableVersion: null,
        downloadedVersion: null,
        updatedAt: doneAt,
        lastInstall: { version: "0.2.5", at: doneAt, result: "updated" },
      };
      state.service = agent;
      rerender();
      await advance(600);
      answering = true;
      // The next look, 5 seconds on, goes by the newest state.
      await advance(5_000);
      await advance(1_100);
      expect([...mountCalls, ...calls]).toContain("installUpdate:0.2.5");
    });

    it("keeps the app's install while its request is pending without a hold", async () => {
      const store = useSessionStorage();
      // The agent has not fetched 0.2.5 yet: the service refuses the hold.
      agent = { ...upToDate(), updatedAt: new Date(Date.now() - 60_000).toISOString() };
      state.service = agent;
      answerPrepare(() => false);
      render();
      const pressedAt = Date.now();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      reloadWindow(store);
      // The agent fetched the release and waits to install the request; nothing is held.
      agent = {
        ...serviceWaiting,
        updatedAt: new Date(pressedAt + 1_000).toISOString(),
        pendingInstall: pendingForce(pressedAt),
      };
      checked = { ...checked, held: false };
      state.service = agent;
      render();
      await advance(0);
      await advance(2_000);
      expect(store.has(FOLLOW_UP_KEY)).toBe(true);
      agent = {
        ...serviceWaiting,
        status: "installing",
        updatedAt: new Date().toISOString(),
        pendingInstall: { ...pendingForce(pressedAt), handled: true },
      };
      state.service = agent;
      rerender();
      await advance(0);
      agent = {
        ...serviceWaiting,
        status: "installed",
        installedVersion: "0.2.5",
        availableVersion: null,
        downloadedVersion: null,
        updatedAt: new Date().toISOString(),
        pendingInstall: null,
      };
      await advance(2_000);
      await advance(5_000);
      expect([...mountCalls, ...calls]).toContain("installUpdate:0.2.5");
    });

    it("keeps the app's install while the agent's pass fetches the release, though none is pending", async () => {
      const store = useSessionStorage();
      // The agent has not fetched 0.2.5 yet: the service refuses the hold.
      agent = { ...upToDate(), updatedAt: new Date(Date.now() - 60_000).toISOString() };
      state.service = agent;
      answerPrepare(() => false);
      render();
      const pressedAt = Date.now();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      reloadWindow(store);
      // The agent's pass fetches the release for the request; the desktop reports
      // none pending (a pass under way outlives a lapse), and nothing is held.
      agent = {
        ...serviceWaiting,
        status: "downloading",
        downloadedVersion: null,
        updatedAt: new Date(pressedAt + 1_000).toISOString(),
        pendingInstall: null,
      };
      checked = { ...checked, held: false };
      state.service = agent;
      render();
      await advance(2_000);
      expect(store.has(FOLLOW_UP_KEY)).toBe(true);
      agent = { ...serviceWaiting, status: "installing", updatedAt: new Date().toISOString() };
      state.service = agent;
      rerender();
      await advance(0);
      agent = {
        ...serviceWaiting,
        status: "installed",
        installedVersion: "0.2.5",
        availableVersion: null,
        downloadedVersion: null,
        updatedAt: new Date().toISOString(),
      };
      await advance(7_000);
      expect([...mountCalls, ...calls]).toContain("installUpdate:0.2.5");
    });
  });

  describe("an attempt that ended", () => {
    it("never asks again for its request over another window's later one", async () => {
      state.service = serviceWaiting;
      render();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      await advance(12_000);
      expect(label()).toBe("Updating…");
      // Another window withdrew the request and released the hold.
      pending = null;
      checked = { idle: true, stoppedThreads: 0, blockers: [], held: false };
      await advance(12_000);
      expect(state.closeToast).toHaveBeenCalledWith("toast-1");
      // Later another window presses Update now, for 0.2.6.
      const requestedAt = Date.now();
      agent = {
        ...serviceWaiting,
        availableVersion: "0.2.6",
        downloadedVersion: "0.2.6",
        updatedAt: new Date(requestedAt + 500).toISOString(),
        pendingInstall: { ...pendingForce(requestedAt), version: "0.2.6" },
      };
      checked = { idle: true, stoppedThreads: 0, blockers: [], held: true };
      state.service = agent;
      rerender();
      await advance(0);
      expect(label()).toBe("Updating…");
      bridge.installServiceUpdate.mockClear();
      // The agent goes quiet: only the window that asked may ask again.
      await advance(60_000);
      expect(bridge.installServiceUpdate).not.toHaveBeenCalled();
    });

    it("follows the app's restart for 75 seconds before it ends", async () => {
      state.service = serviceWaiting;
      render();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      agent = { ...serviceWaiting, status: "installed", installedVersion: "0.2.5" };
      await advance(2_000);
      expect(calls.at(-1)).toBe("installUpdate:0.2.5");
      await advance(45_000);
      expect(state.closeToast).not.toHaveBeenCalledWith("toast-1");
      expect(label()).toBe("Restarting…");
      await advance(30_000);
      expect(state.closeToast).toHaveBeenCalledWith("toast-1");
    });

    it("ends another window's request quietly when its hold runs out", async () => {
      state.service = serviceWaiting;
      render();
      await advance(0);
      await otherWindowPressesUpdateNow();
      await advance(15 * 60_000);
      checked = { ...RUNNING, held: false };
      await advance(12_000);
      expect(lastToast().description).not.toBe(SERVICE_HOLD_ENDED);
      expect(state.closeToast).toHaveBeenCalledWith("toast-1");
    });
  });

  describe("a hold the service refused before its agent had the release", () => {
    it("is asked again once the agent waits for quiet with the release", async () => {
      agent = upToDate();
      state.service = agent;
      let stops = 0;
      answerPrepare(() => {
        stops += 1;
        return stops > 1;
      });
      render();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      await advance(2_000);
      // The agent fetched the release and went straight to waiting for work to wind down.
      agent = {
        ...serviceWaiting,
        status: "waiting-for-quiet",
        updatedAt: new Date().toISOString(),
      };
      await advance(2_000);
      await advance(2_000);
      expect(calls).toEqual([
        ...STOP_AND_INSTALL,
        "prepare:true+hold",
        "installServiceUpdate:force",
      ]);
    });

    it("is asked again when the agent goes from downloading straight to waiting for quiet", async () => {
      agent = upToDate();
      state.service = agent;
      let stops = 0;
      answerPrepare(() => {
        stops += 1;
        return stops > 1;
      });
      render();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      agent = {
        ...serviceWaiting,
        status: "downloading",
        updatedAt: new Date(Date.now() + 500).toISOString(),
      };
      await advance(2_000);
      // "downloaded" lasted less than a poll: the next read already says it waits for quiet.
      agent = {
        ...serviceWaiting,
        status: "waiting-for-quiet",
        updatedAt: new Date(Date.now() + 500).toISOString(),
      };
      await advance(2_000);
      await advance(2_000);
      expect(calls).toEqual([
        ...STOP_AND_INSTALL,
        "prepare:true+hold",
        "installServiceUpdate:force",
      ]);
    });

    it("is asked again on a retry once the agent fetches the release again", async () => {
      agent = upToDate();
      state.service = agent;
      // The service holds only once its agent has the release: each stop is refused, then held.
      let stops = 0;
      answerPrepare(() => {
        stops += 1;
        return stops % 2 === 0;
      });
      render();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      await advance(2_000);
      agent = { ...serviceWaiting, status: "downloaded", updatedAt: new Date().toISOString() };
      await advance(2_000);
      await advance(2_000);
      expect(calls.filter((call) => call === "prepare:true+hold")).toHaveLength(2);
      // The install fails.
      agent = {
        ...serviceWaiting,
        status: "error",
        message: "The install failed.",
        updatedAt: new Date(Date.now() + 1_000).toISOString(),
      };
      await advance(2_000);
      expect(lastToast().type).toBe("error");
      // Meanwhile the agent dropped the release: Try again is refused, then the agent fetches it again.
      agent = { ...upToDate(), updatedAt: new Date(Date.now() - 1_000).toISOString() };
      await advance(0);
      await pressTryAgain();
      await advance(2_000);
      agent = {
        ...serviceWaiting,
        status: "downloaded",
        updatedAt: new Date(Date.now() + 1_000).toISOString(),
      };
      await advance(2_000);
      await advance(2_000);
      expect(calls.filter((call) => call === "prepare:true+hold")).toHaveLength(4);
    });

    it("is not asked again for a state the agent wrote before the request", async () => {
      // The agent has 0.2.5 on disk; the app found 0.2.6, which the agent lacks: the hold is refused.
      state.app = appHas026;
      agent = {
        ...serviceWaiting,
        status: "downloaded",
        updatedAt: new Date(Date.now() - 60_000).toISOString(),
      };
      state.service = agent;
      answerPrepare(() => false);
      render();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      expect(bridge.installServiceUpdate.mock.calls[0]![0]).toMatchObject({ version: "0.2.6" });
      await advance(2_000);
      await advance(2_000);
      expect(calls.filter((call) => call === "prepare:true+hold")).toHaveLength(1);
    });

    it("is not asked again for a state that does not say when it was written", async () => {
      state.app = appHas026;
      agent = { ...serviceWaiting, status: "downloaded" };
      state.service = agent;
      answerPrepare(() => false);
      render();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      await advance(2_000);
      await advance(2_000);
      expect(calls.filter((call) => call === "prepare:true+hold")).toHaveLength(1);
    });

    it("is not asked again once the service already holds the work", async () => {
      agent = upToDate();
      state.service = agent;
      answerPrepare(() => false);
      render();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      // The service holds the work now (another window's press held it).
      checked = { idle: true, stoppedThreads: 0, blockers: [], held: true };
      await advance(12_000);
      agent = {
        ...serviceWaiting,
        status: "downloaded",
        updatedAt: new Date(Date.now() + 1_000).toISOString(),
      };
      await advance(2_000);
      await advance(2_000);
      expect(calls.filter((call) => call === "prepare:true+hold")).toHaveLength(1);
    });

    it("is not asked again when the first stop got no answer", async () => {
      agent = upToDate();
      state.service = agent;
      state.prepare.mockImplementation(
        async (value: { input: ServerPrepareServiceUpdateInput }) => {
          calls.push(prepareCall(value.input));
          if (!value.input.stopWork) return { _tag: "Success", value: checked };
          return { _tag: "Failure" };
        },
      );
      render();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      agent = {
        ...serviceWaiting,
        status: "downloaded",
        updatedAt: new Date(Date.now() + 1_000).toISOString(),
      };
      await advance(2_000);
      await advance(2_000);
      expect(calls.filter((call) => call === "prepare:true+hold")).toHaveLength(1);
    });

    it("is not asked again while this window's cancel is under way", async () => {
      agent = upToDate();
      state.service = agent;
      answerPrepare(() => false);
      render();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      const finishCancel = slowCancel();
      let cancelled: Promise<void> = Promise.resolve();
      act(() => {
        cancelled = cancelServiceUpdate();
      });
      calls.length = 0;
      // The agent found the release as the person pressed Cancel.
      agent = {
        ...serviceWaiting,
        status: "downloaded",
        updatedAt: new Date(Date.now() + 1_000).toISOString(),
      };
      await advance(2_000);
      await advance(2_000);
      await act(async () => {
        finishCancel();
        await cancelled;
      });
      expect(calls.filter((call) => call.startsWith("prepare:true"))).toEqual([]);
    });

    it("is not asked again by a window that follows another window's request", async () => {
      agent = upToDate();
      state.service = agent;
      answerPrepare(() => false);
      render();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      // This window cancels its own request before the agent found the release.
      await act(async () => {
        await cancelServiceUpdate();
      });
      expect(calls.at(-1)).toBe("prepare:release");
      // Later another window presses Update now, once its agent has the release.
      await otherWindowPressesUpdateNow();
      calls.length = 0;
      await advance(4_000);
      expect(calls.filter((call) => call.startsWith("prepare:true"))).toEqual([]);
    });

    /** This window's press; the agent fetches 0.2.5; another window cancels. */
    async function pressThenCancelElsewhereDuringFetch() {
      agent = { ...upToDate(), updatedAt: new Date(Date.now() - 60_000).toISOString() };
      state.service = agent;
      answerPrepare(() => false);
      render();
      const pressedAt = Date.now();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      agent = {
        ...serviceWaiting,
        status: "downloading",
        downloadedVersion: null,
        updatedAt: new Date(pressedAt + 1_000).toISOString(),
        pendingInstall: pendingForce(pressedAt),
      };
      state.service = agent;
      await advance(2_000);
      rerender();
      expect(label()).toBe("Updating…");
      // No request is pending, the service holds nothing, and the agent ends its
      // pass with the release on disk. A stop now would be held.
      agent = cancelledElsewhere();
      checked = { ...checked, held: false };
      answerPrepare(() => true);
      state.service = agent;
      rerender();
      calls.length = 0;
    }

    it("is not asked again once another window cancels while the agent fetches", async () => {
      await pressThenCancelElsewhereDuringFetch();
      await advance(32_000);
      expect(
        calls.filter(
          (call) => call.startsWith("prepare:true") || call.startsWith("installServiceUpdate"),
        ),
      ).toEqual([]);
    });

    it("does not install the app once another window cancels while the agent fetches", async () => {
      await pressThenCancelElsewhereDuringFetch();
      await advance(4_000);
      // The agent installs 0.2.5 later, at a quiet moment of its own.
      agent = {
        ...serviceWaiting,
        status: "installing",
        updatedAt: new Date().toISOString(),
        pendingInstall: null,
      };
      state.service = agent;
      rerender();
      await advance(2_000);
      const doneAt = new Date(Date.now() + 1_000).toISOString();
      agent = {
        ...serviceWaiting,
        status: "installed",
        installedVersion: "0.2.5",
        updatedAt: doneAt,
        lastInstall: { version: "0.2.5", at: doneAt, result: "updated" },
        pendingInstall: null,
      };
      state.service = agent;
      rerender();
      await advance(7_000);
      expect(calls).not.toContain("installUpdate:0.2.5");
    });
  });

  describe("the agent's answer to a request", () => {
    it("does not say the release is missing while the state names it", async () => {
      agent = { ...serviceWaiting, status: "downloaded" };
      state.service = agent;
      render();
      // A pass that read the settings just before the request writes its answer after it.
      bridge.installServiceUpdate.mockImplementation(
        async (options?: StudioServiceInstallOptions) => {
          calls.push(`installServiceUpdate:${options?.force ? "force" : "normal"}`);
          // It reports none pending, but names the release: the agent has it.
          return {
            ...agent,
            status: "disabled",
            message: "Automatic update checks are off",
            updatedAt: new Date(Date.now() + 200).toISOString(),
            pendingInstall: null,
          };
        },
      );
      await click();
      await advance(0);
      expect(calls).toEqual(STOP_AND_INSTALL);
      expect(label()).toBe("Updating…");
      expect(lastToast().description).not.toBe(NOT_AVAILABLE);
    });
  });
});
