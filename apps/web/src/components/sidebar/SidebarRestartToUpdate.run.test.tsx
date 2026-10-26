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

// Update now as one durable run (0988): the press begins the run and names it
// in its request; every window then only follows it, with no button to press.

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
import { RUN_NO_PROGRESS_LINE, RUN_SERVICE_BACK_LINE } from "../serviceUpdateRunView";
import { requestRestartToUpdate } from "./restartToUpdateRequests";
import { SidebarRestartToUpdate } from "./SidebarRestartToUpdate";
import { AUTOMATIC_WAIT_POLL_MS, LIVE_CHANGE_LOOK_MS } from "./useServiceQuestionBlockers";

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

describe("Update now as one run", () => {
  it("begins the run and names it, with its deadline, in the one install request", async () => {
    await renderPressReady();
    await act(async () => {
      button()?.props.onClick();
    });
    await settle();
    expect(calls).toEqual([
      "prepare:false",
      "run:begin",
      "prepare:true+hold",
      `installServiceUpdate:force:run-1:${new Date(T0 + 30 * 60_000).toISOString()}`,
    ]);
    // The app installs after the service in the desktop, not from this window.
    expect(calls).not.toContain("installUpdate");
  });

  it("falls back to the update before runs when the agent does not advertise them", async () => {
    supported = false;
    await renderPressReady();
    await act(async () => {
      button()?.props.onClick();
    });
    await settle();
    expect(calls).toEqual([
      "prepare:false",
      "run:begin",
      "prepare:true+hold",
      "installServiceUpdate:force",
    ]);
  });

  it("offers no button while the run is live and shows its step and times", async () => {
    state.service = { ...serviceWaiting, status: "installing", run: liveRun() };
    render();
    expect(button()?.props.disabled).toBe(true);
    expect(label()).toBe("Installing 7/16…");
    expect(lastToast()).toMatchObject({
      type: "loading",
      title: "Installing SpecWithCode 1.0.70",
      actionProps: { children: null },
    });
    expect(lastToast().description).toContain("Step 7 of 16: check before restart.");
    expect(lastToast().description).toContain("1:10 elapsed, about 2:40 expected.");
    // Settings and the header pill press too: the run is followed, nothing asked.
    expect(requestRestartToUpdate()).toBe(true);
    expect(requestRestartToUpdate({ requireService: true })).toBe(true);
    await settle();
    expect(calls).toEqual([]);

    state.service = {
      ...state.service,
      run: liveRun({
        step: { ...liveRun().step!, i: 13, label: "readiness", serviceBack: true },
      }),
    };
    rerender();
    expect(lastToast().description).toContain(RUN_SERVICE_BACK_LINE);
  });

  it("says in amber that nothing moved for 2 minutes, with no button and no failure", () => {
    state.service = { ...serviceWaiting, status: "installing", run: liveRun({ noProgress: true }) };
    render();
    expect(lastToast()).toMatchObject({ type: "warning", actionProps: { children: null } });
    expect(lastToast().description).toContain(RUN_NO_PROGRESS_LINE);
    expect(button()?.props.disabled).toBe(true);
  });

  it("names the threads whose questions the install waits on", async () => {
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
        } as unknown as ServiceUpdateBlocker,
      ],
    };
    state.service = { ...serviceWaiting, run: liveRun({ phase: "waiting", step: null }) };
    render();
    await settle();
    expect(calls).toEqual(["prepare:false"]);
    expect(lastToast().description).toContain('Waiting for answers in "Fix login".');
    // The sidebar says it too, in visible text, not only in a tooltip.
    expect(
      renderer?.root.findByProps({ "data-testid": "sidebar-update-question-wait" }).children,
    ).toEqual(['Waiting for answers in "Fix login".']);
    // Asked again every 30 seconds, never stopping work.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(calls).toEqual(["prepare:false", "prepare:false"]);
  });

  it("says in a short hint that an automatic install waits on open questions (0991)", async () => {
    const waitingOn = {
      idle: false,
      stoppedThreads: 0,
      blockers: [
        {
          kind: "request",
          count: 2,
          threadId: "thread-1",
          threadTitle: "Fix login",
          projectId: "project-1",
          projectTitle: "EasyChamp",
          questions: 2,
          approvals: 0,
        } as unknown as ServiceUpdateBlocker,
      ],
    };
    // The install began waiting while a turn still ran: no question yet.
    looked = checked;
    state.app = null;
    render();
    await settle();
    const line = () =>
      renderer?.root.findAllByProps({ "data-testid": "sidebar-update-question-wait" }) ?? [];
    expect(line()).toEqual([]);
    // A question asked later shows on the next look, without a press.
    looked = waitingOn;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOMATIC_WAIT_POLL_MS);
    });
    expect(line()[0]?.children).toEqual(["Update waits on 2 questions."]);
    expect(label()).toBe("Update now");
    expect(button()?.props.disabled).toBe(false);
    // Once the question is answered the line goes on the next look.
    looked = checked;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOMATIC_WAIT_POLL_MS);
    });
    expect(line()).toEqual([]);
    // Only looked: an automatic install never stops work or closes a question.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call === "prepare:false")).toBe(true);
  });

  it("drops an answered question at once, as Needs you does, and asks the service again", async () => {
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
        {
          kind: "request",
          count: 1,
          threadId: "thread-2",
          threadTitle: "Docs",
          projectId: "project-1",
          projectTitle: "EasyChamp",
          questions: 1,
          approvals: 0,
        } as unknown as ServiceUpdateBlocker,
      ],
    };
    state.app = null;
    state.live = new Map([
      ["thread-1", "q1"],
      ["thread-2", "q2"],
    ]);
    render();
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOMATIC_WAIT_POLL_MS);
    });
    const line = () =>
      renderer?.root.findAllByProps({ "data-testid": "sidebar-update-question-wait" }) ?? [];
    expect(line()[0]?.children).toEqual(["Update waits on 2 questions."]);
    calls.length = 0;
    // The person answers in "Docs": the live shell says so before the service is asked.
    state.live = new Map([["thread-1", "q1"]]);
    rerender();
    expect(line()[0]?.children).toEqual(["Update waits on 1 question."]);
    // A thread that waits on nothing the person can see (resolved, archived) is never counted.
    state.live = new Map();
    rerender();
    expect(line()).toEqual([]);
    // Each change asks the service again soon after, not at the next 2-minute look.
    looked = checked;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIVE_CHANGE_LOOK_MS);
    });
    expect(calls).toEqual(["prepare:false"]);
  });

  it("can dismiss the hint for this version", async () => {
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
        } as unknown as ServiceUpdateBlocker,
      ],
    };
    state.app = null;
    render();
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOMATIC_WAIT_POLL_MS);
    });
    const line = () =>
      renderer?.root.findAllByProps({ "data-testid": "sidebar-update-question-wait" }) ?? [];
    expect(line()).toHaveLength(1);
    act(() => {
      renderer?.root
        .findByProps({ "data-testid": "sidebar-update-question-wait-dismiss" })
        .props.onClick();
    });
    expect(line()).toEqual([]);
    expect(label()).toBe("Update now");
    // It stays dismissed after a reload, until a newer version waits.
    act(() => renderer?.unmount());
    render();
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOMATIC_WAIT_POLL_MS);
    });
    expect(line()).toEqual([]);
    state.service = { ...serviceWaiting, availableVersion: "1.0.71", downloadedVersion: "1.0.71" };
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOMATIC_WAIT_POLL_MS);
    });
    expect(line()).toHaveLength(1);
  });

  it("asks during an automatic wait only while the window is shown (0991)", async () => {
    let visibilityState: DocumentVisibilityState = "visible";
    const listeners = new Set<() => void>();
    vi.stubGlobal("document", {
      get visibilityState() {
        return visibilityState;
      },
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    });
    try {
      state.app = null;
      render();
      await settle();
      calls.length = 0;
      // A window in the background asks nothing, however long the install waits.
      visibilityState = "hidden";
      await act(async () => {
        await vi.advanceTimersByTimeAsync(AUTOMATIC_WAIT_POLL_MS * 3);
      });
      expect(calls).toEqual([]);
      // Shown again: it asks at once, then every AUTOMATIC_WAIT_POLL_MS, not every 30 seconds.
      visibilityState = "visible";
      await act(async () => {
        for (const listener of listeners) listener();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(calls).toEqual(["prepare:false"]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(calls).toEqual(["prepare:false"]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(AUTOMATIC_WAIT_POLL_MS);
      });
      expect(calls).toEqual(["prepare:false", "prepare:false"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports the outcome once, with Restart now for an app that did not update", async () => {
    const failed = liveRun({
      phase: "verified",
      terminal: true,
      step: null,
      app: { phase: "failed", message: "App update did not apply." },
      message: "App update did not apply.",
      outcome: "failed",
      endedAt: new Date(T0 + 60_000).toISOString(),
    });
    state.service = { ...serviceWaiting, installedVersion: "1.0.70", run: failed };
    render();
    expect(lastToast()).toMatchObject({
      type: "error",
      title: "The service updated to 1.0.70, but the app did not",
      actionProps: { children: "Restart now" },
    });
    await act(async () => {
      lastToast().actionProps.onClick?.();
    });
    expect(calls).toContain("run:retry-app");
    expect(calls).toContain("run:acknowledge");
    // Another window, or this one after a reload, does not report it again.
    act(() => renderer?.unmount());
    state.addToast.mockClear();
    state.updateToast.mockReset();
    resetServiceUpdateFlowForTests();
    render();
    expect(state.addToast).not.toHaveBeenCalled();
  });
});
