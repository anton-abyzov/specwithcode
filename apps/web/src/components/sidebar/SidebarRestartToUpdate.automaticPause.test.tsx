import type {
  DesktopUpdateState,
  ServerPrepareServiceUpdateInput,
  ServerPrepareServiceUpdateResult,
  ServiceUpdateBlocker,
  StudioServiceInstallOptions,
  StudioServiceUpdateRun,
  StudioServiceUpdateRunAction,
  StudioServiceUpdateRunResult,
  StudioServiceUpdateState,
} from "@specweave-studio/contracts";
import type { ReactElement, ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// An automatic install waiting for running work (1085): the sidebar says when
// the agent pauses that work, with Install now (the Update now run) and Later.

const state = vi.hoisted(() => ({
  app: null as DesktopUpdateState | null,
  service: null as StudioServiceUpdateState | null,
  addToast: vi.fn((_toast: unknown) => "toast-1"),
  updateToast: vi.fn(),
  closeToast: vi.fn(),
  prepare: vi.fn(),
  /** Needs you's live threads waiting on the person; null while the shell is not live. */
  live: null as ReadonlyMap<string, string> | null,
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
vi.mock("./useLiveWaitingThreads", () => ({ useLiveWaitingThreads: () => state.live }));
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
import { resetServiceUpdateRunFlowForTests } from "../serviceUpdateRunFlow";
import { formatPauseTime } from "../serviceUpdateRunView";
import { SidebarRestartToUpdate } from "./SidebarRestartToUpdate";

const T0 = Date.parse("2026-10-21T12:00:00.000Z");

const downloaded: DesktopUpdateState = {
  enabled: true,
  status: "downloaded",
  channel: "latest",
  currentVersion: "1.0.69",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: "1.0.70",
  downloadedVersion: "1.0.70",
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
  installedVersion: "1.0.69",
  availableVersion: "1.0.70",
  downloadedVersion: "1.0.70",
  checkedAt: null,
  quietSince: null,
  message: null,
  lastInstall: null,
};

const PAUSE_AT = new Date(T0 + 11 * 60_000).toISOString();
const LATER = new Date(T0 + 90_000 + 60 * 60_000).toISOString();

// The agent refused the automatic install for a running turn and said when it pauses it.
const pausing: StudioServiceUpdateState = { ...serviceWaiting, automaticPauseAt: PAUSE_AT };

const liveRun = (values: Partial<StudioServiceUpdateRun> = {}): StudioServiceUpdateRun => ({
  runId: "run-1",
  phase: "installing",
  terminal: false,
  targetVersion: "1.0.70",
  appTargetVersion: "1.0.70",
  startedAt: new Date(T0).toISOString(),
  deadlineAt: new Date(T0 + 30 * 60_000).toISOString(),
  lastSignAt: new Date(T0 + 60_000).toISOString(),
  noProgress: false,
  step: {
    label: "checkBeforeRestart",
    i: 7,
    n: 16,
    phaseStartedAt: new Date(T0 + 50_000).toISOString(),
    // The helper began 20 seconds after the press: its clock times the install.
    startedAt: new Date(T0 + 20_000).toISOString(),
    expectedMs: 160_000,
    serviceBack: false,
  },
  app: null,
  message: null,
  outcome: null,
  endedAt: null,
  ...values,
});

const calls: string[] = [];
let supported = true;
const checked: ServerPrepareServiceUpdateResult = { idle: true, stoppedThreads: 0, blockers: [] };
let looked: ServerPrepareServiceUpdateResult = checked;
const storage = new Map<string, string>();

const bridge = {
  getUpdateState: vi.fn(async () => state.app ?? downloaded),
  getServiceUpdateState: vi.fn(async () => state.service ?? serviceWaiting),
  checkForUpdate: vi.fn(async () => ({ checked: true, state: state.app ?? downloaded })),
  installUpdate: vi.fn(async () => {
    calls.push("installUpdate");
    return { accepted: true, completed: false, failed: false, state: downloaded };
  }),
  installServiceUpdate: vi.fn(async (options?: StudioServiceInstallOptions) => {
    calls.push(
      `installServiceUpdate:${options?.force ? "force" : "normal"}${options?.runId ? `:${options.runId}:${options.holdUntil}` : ""}`,
    );
    return state.service ?? serviceWaiting;
  }),
  serviceUpdateRun: vi.fn(
    async (action: StudioServiceUpdateRunAction): Promise<StudioServiceUpdateRunResult> => {
      calls.push(`run:${action.type}`);
      if (action.type !== "begin") return { supported, created: false, run: null };
      return supported
        ? { supported, created: true, run: liveRun({ phase: "preparing", step: null }) }
        : { supported, created: false, run: null };
    },
  ),
  cancelServiceUpdate: vi.fn(async () => state.service ?? serviceWaiting),
  postponeAutomaticServiceUpdate: vi.fn(async (): Promise<StudioServiceUpdateState> => {
    calls.push("postpone");
    // The desktop writes the postponement and answers with the moved time.
    state.service = { ...pausing, automaticPauseAt: LATER };
    return state.service;
  }),
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
}

/** Renders, then forgets what mounting asked (the window's look for a hold to adopt). */
async function renderPressReady() {
  render();
  await settle();
  calls.length = 0;
}

function rerender() {
  act(() => {
    renderer?.update(<SidebarRestartToUpdate />);
  });
}

const button = () => renderer?.root.findAllByType("button")[0] ?? null;
const label = () => button()?.findByType("span").children.join("") ?? null;

function lastToast() {
  const updates = state.updateToast.mock.calls;
  return (
    updates.length > 0 ? updates[updates.length - 1]![1] : state.addToast.mock.calls.at(-1)?.[0]
  ) as {
    type: string;
    title: string;
    description: string;
    actionProps: { children: unknown; onClick?: () => void };
  };
}

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0 + 90_000);
  calls.length = 0;
  supported = true;
  looked = checked;
  storage.clear();
  state.live = null;
  state.app = downloaded;
  state.service = serviceWaiting;
  state.addToast.mockClear();
  state.updateToast.mockReset();
  state.closeToast.mockReset();
  state.prepare.mockReset();
  state.prepare.mockImplementation(async (value: { input: ServerPrepareServiceUpdateInput }) => {
    calls.push(`prepare:${value.input.stopWork}${value.input.hold ? "+hold" : ""}`);
    return { _tag: "Success", value: value.input.stopWork ? { ...checked, held: true } : looked };
  });
  bridge.serviceUpdateRun.mockClear();
  bridge.installServiceUpdate.mockClear();
  bridge.postponeAutomaticServiceUpdate.mockClear();
  resetServiceUpdateFlowForTests();
  resetServiceUpdateRunFlowForTests();
  resetConfirmDialogForTests();
  Object.assign(globalThis, {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    document: { hasFocus: () => true },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
    },
  });
  (globalThis as { window?: unknown }).window = globalThis;
  (globalThis as { desktopBridge?: unknown }).desktopBridge = bridge;
  (globalThis as { location?: unknown }).location = { reload: vi.fn() };
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  resetServiceUpdateFlowForTests();
  resetServiceUpdateRunFlowForTests();
  vi.useRealTimers();
  delete (globalThis as { desktopBridge?: unknown }).desktopBridge;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { location?: unknown }).location;
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

const byTestId = (id: string) => renderer?.root.findAllByProps({ "data-testid": id }) ?? [];
const pauseLine = () => byTestId("sidebar-update-pause-wait")[0]?.children.join("") ?? null;

describe("an automatic install waiting for running work", () => {
  beforeEach(() => {
    state.app = null;
    state.service = pausing;
  });

  it("says when running work pauses and continues, with Install now and Later", async () => {
    render();
    await settle();
    expect(pauseLine()).toBe(
      `Installs at ${formatPauseTime(Date.parse(PAUSE_AT))}. Running turns pause then and continue after the update.`,
    );
    expect(byTestId("sidebar-update-pause-install-now")[0]?.children).toEqual(["Install now"]);
    expect(byTestId("sidebar-update-pause-later")[0]?.children).toEqual(["Later"]);
    // It is not the questions hint, and it cannot be dismissed.
    expect(byTestId("sidebar-update-question-wait")).toHaveLength(0);
    expect(byTestId("sidebar-update-question-wait-dismiss")).toHaveLength(0);
  });

  it("keeps the pause time, Install now and Later under the questions it waits on", async () => {
    looked = {
      idle: false,
      stoppedThreads: 0,
      blockers: [
        {
          kind: "request",
          count: 1,
          threadId: "thread-1",
          threadTitle: "Fix login",
          projectId: "project-1",
          projectTitle: "EasyChamp",
          questions: 1,
          approvals: 0,
        } as unknown as ServiceUpdateBlocker,
      ],
    };
    render();
    await settle();
    expect(byTestId("sidebar-update-question-wait")[0]?.children).toEqual([
      "Update waits on 1 question.",
    ]);
    expect(pauseLine()).toBe(
      `Installs at ${formatPauseTime(Date.parse(PAUSE_AT))}. Running turns pause then and continue after the update.`,
    );
    expect(byTestId("sidebar-update-pause-install-now")).toHaveLength(1);
    expect(byTestId("sidebar-update-pause-later")).toHaveLength(1);
    // The pause time cannot be dismissed with the questions hint.
    expect(byTestId("sidebar-update-question-wait-dismiss")).toHaveLength(0);
  });

  it("Install now starts the Update now run", async () => {
    await renderPressReady();
    await act(async () => {
      byTestId("sidebar-update-pause-install-now")[0]?.props.onClick();
    });
    await settle();
    expect(calls).toEqual([
      "prepare:false",
      "run:begin",
      "prepare:true+hold",
      `installServiceUpdate:force:run-1:${new Date(T0 + 30 * 60_000).toISOString()}`,
    ]);
    expect(calls).not.toContain("postpone");
  });

  it("Later postpones the pause, starts nothing and shows the moved time", async () => {
    await renderPressReady();
    await act(async () => {
      byTestId("sidebar-update-pause-later")[0]?.props.onClick();
    });
    await settle();
    expect(calls).toEqual(["postpone"]);
    expect(bridge.installServiceUpdate).not.toHaveBeenCalled();
    expect(bridge.serviceUpdateRun).not.toHaveBeenCalled();
    // The next publish carries the moved time into every window.
    rerender();
    expect(pauseLine()).toBe(
      `Installs at ${formatPauseTime(Date.parse(LATER))}. Running turns pause then and continue after the update.`,
    );
  });

  it("says why when Later could not be saved", async () => {
    bridge.postponeAutomaticServiceUpdate.mockImplementationOnce(async () => {
      calls.push("postpone");
      throw new Error("The update could not be postponed. Try again in a moment.");
    });
    await renderPressReady();
    await act(async () => {
      byTestId("sidebar-update-pause-later")[0]?.props.onClick();
    });
    await settle();
    expect(state.addToast.mock.calls.at(-1)?.[0]).toMatchObject({
      type: "error",
      title: "Could not postpone the update",
      description: "The update could not be postponed. Try again in a moment.",
    });
    expect(pauseLine()).toContain(formatPauseTime(Date.parse(PAUSE_AT)));
  });

  it("offers no Later on a desktop without it, and nothing without a pause time", async () => {
    const withoutLater = { ...bridge } as Partial<typeof bridge>;
    delete withoutLater.postponeAutomaticServiceUpdate;
    (globalThis as { desktopBridge?: unknown }).desktopBridge = withoutLater;
    render();
    await settle();
    expect(pauseLine()).not.toBeNull();
    expect(byTestId("sidebar-update-pause-install-now")).toHaveLength(1);
    expect(byTestId("sidebar-update-pause-later")).toHaveLength(0);
    // An agent before automatic pauses, or one not waiting on work.
    (globalThis as { desktopBridge?: unknown }).desktopBridge = bridge;
    state.service = serviceWaiting;
    rerender();
    expect(byTestId("sidebar-update-pause-wait")).toHaveLength(0);
    state.service = { ...serviceWaiting, automaticPauseAt: null };
    rerender();
    expect(byTestId("sidebar-update-pause-wait")).toHaveLength(0);
  });

  it("shows the agent's message with Update now when its automatic pause did not happen", async () => {
    const message =
      "The automatic pause did not happen: a turn could not be paused. Choose Update now to install.";
    state.service = { ...serviceWaiting, automaticPauseAt: null, message };
    await renderPressReady();
    expect(byTestId("sidebar-update-question-wait")[0]?.children).toEqual([message]);
    expect(byTestId("sidebar-update-missed-pause-update-now")[0]?.children).toEqual(["Update now"]);
    // Non-intrusive: no pause line or Later, and it can be dismissed.
    expect(byTestId("sidebar-update-pause-wait")).toHaveLength(0);
    expect(byTestId("sidebar-update-pause-later")).toHaveLength(0);
    expect(byTestId("sidebar-update-question-wait-dismiss")).toHaveLength(1);
    await act(async () => {
      byTestId("sidebar-update-missed-pause-update-now")[0]?.props.onClick();
    });
    await settle();
    expect(calls).toEqual([
      "prepare:false",
      "run:begin",
      "prepare:true+hold",
      `installServiceUpdate:force:run-1:${new Date(T0 + 30 * 60_000).toISOString()}`,
    ]);
  });

  it("offers no Update now beside a message that is not a missed pause", async () => {
    state.service = { ...serviceWaiting, automaticPauseAt: null, message: "Waiting for work." };
    render();
    await settle();
    expect(byTestId("sidebar-update-missed-pause-update-now")).toHaveLength(0);
    expect(byTestId("sidebar-update-question-wait")).toHaveLength(0);
  });
});
