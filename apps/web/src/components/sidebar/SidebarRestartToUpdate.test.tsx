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

const state = vi.hoisted(() => ({
  app: null as DesktopUpdateState | null,
  service: null as StudioServiceUpdateState | null,
  addToast: vi.fn((_toast: unknown) => "toast-1"),
  updateToast: vi.fn(),
  closeToast: vi.fn(),
  announce: vi.fn(),
  prepare: vi.fn(),
  navigate: vi.fn(),
  // What the update feed answers when the restart asks it again; null keeps the download.
  feed: null as DesktopUpdateState | null,
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
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../../state/entities", () => ({ useProjects: () => [] }));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../../state/server", () => ({ serverEnvironment: { prepareServiceUpdate: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.prepare }));
vi.mock("../desktopUpdate.toast", () => ({ showDesktopUpdateDownloadedToast: state.announce }));
vi.mock("../ui/spinner", () => ({ Spinner: () => null }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactElement }) => render,
  TooltipPopup: () => null,
}));

import {
  readConfirmDialogState,
  registerConfirmDialogHost,
  resetConfirmDialogForTests,
  respondToConfirmDialog,
} from "../../confirmDialog";
import { resetServiceUpdateFlowForTests, startServiceUpdateNow } from "../serviceUpdateFlow";
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
// What a look (stopWork false) reports, and what stopping reports.
let checked: ServerPrepareServiceUpdateResult = { idle: true, stoppedThreads: 0, blockers: [] };
let prepared: ServerPrepareServiceUpdateResult = { idle: true, stoppedThreads: 0, blockers: [] };
const reload = vi.fn();

function prepareCall(input: ServerPrepareServiceUpdateInput): string {
  if (input.releaseHold) return "prepare:release";
  return `prepare:${input.stopWork}${input.hold ? "+hold" : ""}`;
}

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

const bridge: {
  checkForUpdate: ReturnType<typeof vi.fn>;
  downloadUpdate: ReturnType<typeof vi.fn>;
  getUpdateState: ReturnType<typeof vi.fn>;
  getServiceUpdateState: ReturnType<typeof vi.fn<() => Promise<StudioServiceUpdateState>>>;
  installUpdate: ReturnType<typeof vi.fn>;
  installServiceUpdate: ReturnType<
    typeof vi.fn<(options?: StudioServiceInstallOptions) => Promise<StudioServiceUpdateState>>
  >;
  cancelServiceUpdate?: ReturnType<typeof vi.fn<() => Promise<StudioServiceUpdateState>>>;
  getUpdatePreferences: ReturnType<typeof vi.fn>;
  ownsBundledService?: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
} = {
  checkForUpdate: vi.fn(async () => {
    if (state.feed !== null) {
      calls.push(`check:${state.feed.availableVersion}`);
      state.app = state.feed;
    }
    return { checked: true, state: state.app ?? downloaded };
  }),
  downloadUpdate: vi.fn(async () => {
    const current = state.app ?? downloaded;
    calls.push(`download:${current.availableVersion}`);
    state.app = {
      ...current,
      status: "downloaded",
      downloadedVersion: current.availableVersion,
      downloadPercent: 100,
    };
    return { accepted: true, completed: true, state: state.app };
  }),
  getUpdateState: vi.fn(async () => state.app ?? downloaded),
  getServiceUpdateState: vi.fn(async () => reported(agent)),
  installUpdate: vi.fn(async (options?: { expectedVersion?: string }) => {
    calls.push(`installUpdate:${options?.expectedVersion ?? ""}`);
    return { ...installResult, state: state.app ?? downloaded };
  }),
  installServiceUpdate: vi.fn(installService),
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
const cancelServiceUpdate = bridge.cancelServiceUpdate!;
const ownsBundledService = bridge.ownsBundledService!;

const blocker = (kind: ServiceUpdateBlocker["kind"], count: number, title: string | null = null) =>
  ({
    kind,
    count,
    threadId: title === null ? null : "thread-1",
    threadTitle: title,
    projectId: title === null ? null : "project-1",
    projectTitle: title === null ? null : "EasyChamp",
  }) as unknown as ServiceUpdateBlocker;

let renderer: ReactTestRenderer | null = null;
let focused = true;
const focusListeners = new Set<() => void>();
const windowStub = {
  addEventListener: (type: string, listener: () => void) => {
    if (type === "focus") focusListeners.add(listener);
  },
  removeEventListener: (type: string, listener: () => void) => {
    if (type === "focus") focusListeners.delete(listener);
  },
};

// Mounting looks once for an update hold this window did not start; what it
// sent is kept here so the other tests see only their own calls.
let mountCalls: string[] = [];

function render() {
  act(() => {
    renderer = create(<SidebarRestartToUpdate />);
  });
  mountCalls = calls.splice(0);
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
  if (!node) return null;
  return node.findByType("span").children.join("");
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
  state.announce.mockReset();
  state.navigate.mockReset();
  state.feed = null;
  bridge.checkForUpdate.mockClear();
  bridge.downloadUpdate.mockClear();
  agent = serviceWaiting;
  pending = null;
  checked = { idle: true, stoppedThreads: 0, blockers: [] };
  prepared = { idle: true, stoppedThreads: 0, blockers: [], held: true };
  state.prepare.mockReset();
  state.prepare.mockImplementation(async (value: { input: ServerPrepareServiceUpdateInput }) => {
    calls.push(prepareCall(value.input));
    return { _tag: "Success", value: value.input.stopWork ? prepared : checked };
  });
  reload.mockReset();
  bridge.getServiceUpdateState.mockClear();
  bridge.getServiceUpdateState.mockImplementation(async () => reported(agent));
  bridge.installUpdate.mockClear();
  bridge.installServiceUpdate.mockClear();
  bridge.installServiceUpdate.mockImplementation(installService);
  bridge.cancelServiceUpdate = cancelServiceUpdate;
  cancelServiceUpdate.mockClear();
  // The app started its own service unless a test attaches it to one.
  bridge.ownsBundledService = ownsBundledService;
  ownsBundledService.mockReset();
  ownsBundledService.mockResolvedValue(true);
  resetServiceUpdateFlowForTests();
  resetConfirmDialogForTests();
  focused = true;
  focusListeners.clear();
  Object.assign(globalThis, windowStub, { document: { hasFocus: () => focused } });
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
});

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
    actionProps: { children: unknown; onClick?: () => void };
    data: {
      onClose?: () => void;
      secondaryActionProps?: { children: unknown; onClick?: () => void };
    };
  };
}

const STOP_AND_INSTALL = ["prepare:false", "prepare:true+hold", "installServiceUpdate:force"];

describe("SidebarRestartToUpdate", () => {
  it("renders nothing until an update is downloaded", () => {
    state.app = { ...downloaded, status: "idle", downloadedVersion: null, availableVersion: null };
    render();
    expect(button()).toBeNull();
  });

  it("installs the exact downloaded version and stays on Restarting…", async () => {
    render();
    expect(label()).toBe("Restart to update");
    await click();
    // Nothing runs, so the restart goes ahead without asking.
    expect(calls).toEqual(["prepare:false", "prepare:true+hold", "installUpdate:0.2.5"]);
    expect(readConfirmDialogState()).toMatchObject({ status: "idle" });
    expect(label()).toBe("Restarting…");
    expect(state.addToast).not.toHaveBeenCalled();
  });

  it("warns before an app restart cuts off running jobs", async () => {
    checked = {
      idle: false,
      stoppedThreads: 0,
      blockers: [blocker("run", 2, "Fix login"), blocker("queued", 1)],
    };
    registerConfirmDialogHost();
    render();
    await click();
    const dialog = readConfirmDialogState();
    expect(dialog).toMatchObject({
      status: "confirming",
      confirmLabel: "Restart when idle",
      alternateLabel: "Restart now",
      cancelLabel: "Cancel",
    });
    expect(dialog.status === "confirming" && dialog.message).toContain(
      "2 running, 1 queued in 1 thread",
    );
    // The work is listed under the summary, grouped by project.
    expect(dialog.status === "confirming" && dialog.details).toBeTruthy();
    await act(async () => {
      respondToConfirmDialog("alternate");
    });
    expect(calls).toEqual(["prepare:false", "prepare:true+hold", "installUpdate:0.2.5"]);
  });

  it("installs the newest release instead of an older download", async () => {
    state.feed = {
      ...downloaded,
      status: "available",
      availableVersion: "0.2.7",
      downloadedVersion: null,
    };
    checked = { idle: false, stoppedThreads: 0, blockers: [blocker("run", 1, "Fix login")] };
    registerConfirmDialogHost();
    render();
    await click();
    const dialog = readConfirmDialogState();
    // The dialog names the version that will actually be installed.
    expect(dialog.status === "confirming" && dialog.message).toContain("SpecWithCode 0.2.7");
    await act(async () => {
      respondToConfirmDialog("alternate");
    });
    expect(calls).toEqual([
      "check:0.2.7",
      "download:0.2.7",
      "prepare:false",
      "prepare:true+hold",
      "installUpdate:0.2.7",
    ]);
  });

  it("keeps the downloaded update when the feed has nothing newer", async () => {
    render();
    await click();
    expect(bridge.checkForUpdate).toHaveBeenCalled();
    expect(bridge.downloadUpdate).not.toHaveBeenCalled();
    expect(calls).toEqual(["prepare:false", "prepare:true+hold", "installUpdate:0.2.5"]);
  });

  it("restarts on its own once the work the user let finish is done", async () => {
    checked = { idle: false, stoppedThreads: 0, blockers: [blocker("run", 1, "Fix login")] };
    registerConfirmDialogHost();
    render();
    await click();
    await act(async () => {
      respondToConfirmDialog(true);
    });
    expect(calls).toEqual(["prepare:false"]);
    expect(label()).toBe("Restarts when idle, or in 2:00");
    // Still running at the next check: nothing restarts.
    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });
    expect(calls).toEqual(["prepare:false", "prepare:false"]);
    checked = { idle: true, stoppedThreads: 0, blockers: [] };
    await advance(15_000);
    expect(calls).toEqual([
      "prepare:false",
      "prepare:false",
      "prepare:false",
      "prepare:true+hold",
      "installUpdate:0.2.5",
    ]);
    expect(readConfirmDialogState().status).not.toBe("confirming");
    expect(label()).toBe("Restarting…");
  });

  it("stops the work and restarts once the hold window passes", async () => {
    checked = { idle: false, stoppedThreads: 0, blockers: [blocker("run", 1, "Fix login")] };
    registerConfirmDialogHost();
    render();
    await click();
    await act(async () => {
      respondToConfirmDialog(true);
    });
    await advance(60_000);
    expect(label()).toBe("Restarts when idle, or in 1:00");
    expect(calls).not.toContain("installUpdate:0.2.5");
    // Still running at two minutes: the work is stopped for the update, not waited on.
    await advance(60_000);
    expect(calls.slice(-2)).toEqual(["prepare:true+hold", "installUpdate:0.2.5"]);
    expect(label()).toBe("Restarting…");
  });

  it("uses the hold window from Settings", async () => {
    bridge.getUpdatePreferences.mockResolvedValueOnce({
      checkAutomatically: true,
      downloadAutomatically: true,
      installAutomatically: true,
      forceInstallAfterMinutes: 5,
    });
    checked = { idle: false, stoppedThreads: 0, blockers: [blocker("run", 1, "Fix login")] };
    registerConfirmDialogHost();
    render();
    await advance(0);
    await click();
    await act(async () => {
      respondToConfirmDialog(true);
    });
    expect(label()).toBe("Restarts when idle, or in 5:00");
    await advance(4 * 60_000);
    expect(calls).not.toContain("installUpdate:0.2.5");
    await advance(60_000);
    expect(calls.at(-1)).toBe("installUpdate:0.2.5");
  });

  it("leaves a fleet-installed service running through an app restart", async () => {
    // The app attached to the launchd service rather than starting its own.
    ownsBundledService.mockResolvedValue(false);
    state.service = {
      ...serviceWaiting,
      status: "up-to-date",
      installedVersion: "0.2.5",
      availableVersion: null,
      downloadedVersion: null,
    };
    render();
    expect(label()).toBe("Restart to update");
    await click();
    expect(calls).not.toContain("prepare:true+hold");
    expect(calls.at(-1)).toBe("installUpdate:0.2.5");
  });

  it("never drains a service the app attached to, even when the agent reports no service", async () => {
    // The 2026-10-16 case: attached to a launchd service the agent did not
    // recognise ("not-managed"); the drain held it for fifteen minutes.
    ownsBundledService.mockResolvedValue(false);
    state.service = { ...serviceWaiting, status: "not-managed", identity: null };
    render();
    await click();
    expect(calls).not.toContain("prepare:true+hold");
    expect(calls.at(-1)).toBe("installUpdate:0.2.5");
  });

  it("drains the service it started even when no agent reports on it", async () => {
    // Linux and Windows: no update agent, so no service state, but the app's own backend.
    state.service = null;
    render();
    await click();
    expect(calls).toEqual(["prepare:false", "prepare:true+hold", "installUpdate:0.2.5"]);
  });

  it("does not drain when the desktop cannot say it started the service", async () => {
    delete bridge.ownsBundledService;
    render();
    await click();
    expect(calls).not.toContain("prepare:true+hold");
    expect(calls.at(-1)).toBe("installUpdate:0.2.5");
  });

  it("says so when the app is still open a minute after an accepted install", async () => {
    render();
    await click();
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(label()).toBe("Restart to update");
    expect(state.addToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "SpecWithCode did not restart" }),
    );
  });

  it("installs the service first, then restarts the app once the service runs it", async () => {
    state.service = serviceWaiting;
    render();
    expect(label()).toBe("Update now");
    await click();
    // The app waits: a relaunch inside the agent's checks makes its install start over.
    expect(calls).toEqual(STOP_AND_INSTALL);
    expect(bridge.installServiceUpdate.mock.calls[0]![0]!.version).toBe("0.2.5");
    // One press: the button follows the update instead of offering it again.
    expect(label()).toBe("Updating…");
    expect(button()?.props.disabled).toBe(true);
    agent = { ...serviceWaiting, status: "installing" };
    await advance(2_000);
    expect(label()).toBe("Installing…");
    expect(calls).not.toContain("installUpdate:0.2.5");
    agent = { ...serviceWaiting, status: "installed", installedVersion: "0.2.5" };
    await advance(2_000);
    expect(calls.at(-1)).toBe("installUpdate:0.2.5");
    expect(calls.filter((call) => call === "installUpdate:0.2.5")).toHaveLength(1);
    expect(lastToast()).toMatchObject({
      type: "success",
      title: expect.stringMatching(/^Updated the service to SpecWithCode 0\.2\.5 in \d+:\d{2}$/),
      description: "Restarting the app to finish the update…",
    });
    expect(label()).toBe("Restarting…");
    // The app restarts itself; the window does not reload into the old app first.
    await advance(5_000);
    expect(reload).not.toHaveBeenCalled();
  });

  it("updates the service to the version the app already runs", async () => {
    // The app updated itself on quit; its service still runs 0.2.4.
    state.app = {
      ...downloaded,
      status: "idle",
      currentVersion: "0.2.5",
      availableVersion: null,
      downloadedVersion: null,
    };
    agent = {
      ...serviceWaiting,
      status: "up-to-date",
      availableVersion: null,
      downloadedVersion: null,
    };
    state.service = agent;
    render();
    expect(label()).toBe("Update now");
    await click();
    expect(calls).toEqual(STOP_AND_INSTALL);
    expect(bridge.installServiceUpdate.mock.calls[0]![0]!.version).toBe("0.2.5");
    agent = { ...serviceWaiting, status: "installed", installedVersion: "0.2.5" };
    await advance(2_000);
    // Only the service had to update: the window reloads, the app stays as it is.
    expect(calls).not.toContain("installUpdate:0.2.5");
    await advance(1_500);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("installs the newest app release when one replaced the download during the service update", async () => {
    state.service = serviceWaiting;
    render();
    await click();
    // 0.2.6 appeared while the service installed: the 0.2.5 download is gone.
    installResult = { accepted: false, completed: false, reason: "no-download" };
    state.app = {
      ...downloaded,
      status: "available",
      availableVersion: "0.2.6",
      downloadedVersion: null,
    };
    state.feed = state.app;
    bridge.installUpdate.mockImplementation(async (options?: { expectedVersion?: string }) => {
      calls.push(`installUpdate:${options?.expectedVersion ?? ""}`);
      const accepted = options?.expectedVersion === "0.2.6";
      return accepted
        ? { accepted: true, completed: false, failed: false, state: state.app ?? downloaded }
        : { ...installResult, state: state.app ?? downloaded };
    });
    agent = { ...serviceWaiting, status: "installed", installedVersion: "0.2.5" };
    await advance(2_000);
    await advance(1_000);
    expect(calls).toContain("installUpdate:0.2.5");
    expect(calls).toContain("download:0.2.6");
    expect(calls.at(-1)).toBe("installUpdate:0.2.6");
    expect(state.addToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "The service updated, but the app did not" }),
    );
    bridge.installUpdate.mockImplementation(async (options?: { expectedVersion?: string }) => {
      calls.push(`installUpdate:${options?.expectedVersion ?? ""}`);
      return { ...installResult, state: state.app ?? downloaded };
    });
  });

  it("says so and stays open when the app refuses its update after the service updated", async () => {
    state.service = serviceWaiting;
    render();
    await click();
    installResult = { accepted: false, completed: false, reason: "disabled" };
    agent = { ...serviceWaiting, status: "installed", installedVersion: "0.2.5" };
    await advance(2_000);
    expect(state.addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "The service updated, but the app did not",
        description: "Updates are off in this build.",
      }),
    );
    // The service update is over: no reload, and nothing is followed any more.
    await advance(5_000);
    expect(reload).not.toHaveBeenCalled();
    expect(state.closeToast).toHaveBeenCalledWith("toast-1");
    calls.length = 0;
    await advance(30_000);
    expect(calls).toEqual([]);
  });

  it("keeps the app open when the user keeps their work running", async () => {
    state.service = serviceWaiting;
    checked = { idle: false, stoppedThreads: 0, blockers: [blocker("run", 1)] };
    registerConfirmDialogHost();
    render();
    expect(label()).toBe("Update now");
    await click();
    expect(readConfirmDialogState()).toMatchObject({ status: "confirming" });
    await act(async () => {
      respondToConfirmDialog(false);
    });
    expect(calls).toEqual(["prepare:false"]);
    expect(label()).toBe("Update now");
    expect(button()?.props.disabled).toBe(false);
  });

  it("waits while the updater finishes another step instead of failing", async () => {
    // The 1.0.33 case: the updater still held a finished download.
    installResult = { accepted: false, completed: false, reason: "busy" };
    render();
    await click();
    expect(label()).toBe("Finishing update step…");
    expect(button()?.props.disabled).toBe(true);
    installResult = { accepted: true, completed: false };
    await advance(1_000);
    expect(calls.filter((call) => call === "installUpdate:0.2.5")).toHaveLength(2);
    expect(label()).toBe("Restarting…");
    expect(state.addToast).not.toHaveBeenCalled();
  });

  it("shows why a refused install did not happen and re-enables the button", async () => {
    installResult = { accepted: false, completed: false, reason: "no-download" };
    render();
    await click();
    expect(label()).toBe("Restart to update");
    expect(state.addToast).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining("newer release") }),
    );
    // The drained work may start again: the app did not restart.
    await advance(0);
    expect(calls).toEqual([
      "prepare:false",
      "prepare:true+hold",
      "installUpdate:0.2.5",
      "prepare:release",
    ]);
  });

  it("keeps the button during a background check", () => {
    state.app = { ...downloaded, status: "checking" };
    render();
    expect(label()).toBe("Restart to update");
  });

  it("does nothing when the restart warning is cancelled", async () => {
    checked = { idle: false, stoppedThreads: 0, blockers: [blocker("run", 1, "Fix login")] };
    registerConfirmDialogHost();
    render();
    await click();
    await act(async () => {
      respondToConfirmDialog(false);
    });
    expect(calls).toEqual(["prepare:false"]);
    expect(label()).toBe("Restart to update");
  });

  it("shows the button without a separate downloaded toast", () => {
    render();
    expect(label()).toBe("Restart to update");
    expect(state.announce).not.toHaveBeenCalled();
    expect(state.addToast).not.toHaveBeenCalled();
  });

  describe("service only", () => {
    beforeEach(() => {
      state.app = null;
      agent = { ...serviceWaiting, status: "downloaded" };
      state.service = agent;
    });

    it("stops and holds work, installs, follows the agent and reloads into the new version", async () => {
      render();
      expect(label()).toBe("Update now");
      const before = Date.now();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      const options = bridge.installServiceUpdate.mock.calls[0]![0]!;
      expect(options.force).toBe(true);
      expect(Date.parse(options.holdUntil!) - before).toBe(15 * 60_000);
      // The request names the version shown, so the agent installs no other.
      expect(options.version).toBe("0.2.5");
      // The click is answered at once; pressing again would only stop the work again.
      expect(state.addToast).toHaveBeenCalledTimes(1);
      expect(label()).toBe("Updating…");
      expect(button()?.props.disabled).toBe(true);

      agent = { ...serviceWaiting, status: "installing", message: "Installing SpecWithCode 0.2.5" };
      await advance(2_000);
      expect(label()).toBe("Installing…");
      expect(button()?.props.disabled).toBe(true);
      expect(lastToast().title).toBe("Installing SpecWithCode 0.2.5 · 0:02");

      agent = { ...serviceWaiting, status: "installed", installedVersion: "0.2.5" };
      await advance(2_000);
      expect(label()).toBe("Restarting…");
      expect(lastToast()).toMatchObject({
        type: "success",
        title: "Updated to SpecWithCode 0.2.5 in 0:04",
        description: "Reloading this window…",
      });
      await advance(1_500);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(state.addToast).toHaveBeenCalledTimes(1);
    });

    it.each(["error", "manual-required"] as const)(
      "reloads after a verified install even when its first observed result is a later %s",
      async (status) => {
        render();
        await click();
        const installedAt = Date.now() + 1_000;
        agent = {
          ...serviceWaiting,
          status,
          installedVersion: "0.2.5",
          availableVersion: null,
          downloadedVersion: null,
          updatedAt: new Date(installedAt + 500).toISOString(),
          lastInstall: {
            version: "0.2.5",
            at: new Date(installedAt).toISOString(),
            result: "updated",
          },
          message: "Discovery is limited to the newest 30 releases",
        };
        calls.length = 0;
        await advance(2_000);
        expect(label()).toBe("Restarting…");
        expect(lastToast()).toMatchObject({
          type: "success",
          title: expect.stringMatching(/^Updated to SpecWithCode 0\.2\.5 in \d+:\d{2}$/),
        });
        expect(lastToast().description).toContain(agent.message);
        expect(lastToast().description).toContain("Installed successfully");
        expect(calls).not.toContain("cancelServiceUpdate");
        expect(calls).not.toContain("prepare:release");
        await advance(1_500);
        expect(reload).toHaveBeenCalledTimes(1);
        expect(bridge.installServiceUpdate).toHaveBeenCalledTimes(1);
      },
    );

    it("asks before stopping running work, listing what ends", async () => {
      checked = {
        idle: false,
        stoppedThreads: 0,
        blockers: [blocker("run", 2, "Fix login"), blocker("queued", 1), blocker("request", 1)],
        openTerminals: 2,
      };
      registerConfirmDialogHost();
      render();
      await click();
      const dialog = readConfirmDialogState();
      expect(dialog).toMatchObject({
        status: "confirming",
        confirmLabel: "Stop and update now",
        cancelLabel: "Cancel",
      });
      const message = dialog.status === "idle" ? "" : dialog.message;
      expect(message.split("\n")).toEqual([
        "Stop running work and update now?",
        "2 tasks will be interrupted. You can continue them after the update.",
        "1 queued message will be cancelled.",
        "1 open question or approval will be closed.",
        "2 terminals will close.",
      ]);
      // Nothing is stopped while the user decides.
      expect(calls).toEqual(["prepare:false"]);
      expect(button()?.props.disabled).toBe(true);
      await act(async () => {
        respondToConfirmDialog(true);
      });
      expect(calls).toEqual(STOP_AND_INSTALL);
    });

    it("starts at once when nothing runs", async () => {
      registerConfirmDialogHost();
      render();
      await click();
      expect(readConfirmDialogState()).toEqual({ status: "idle" });
      expect(calls).toEqual(STOP_AND_INSTALL);
    });

    it("offers only Cancel while the agent works on the request, and Update now once its hold ends", async () => {
      agent = {
        ...serviceWaiting,
        message: "Waiting for open SpecWithCode terminals and agent processes to close",
        updatedAt: new Date(Date.now() + 1_000).toISOString(),
      };
      render();
      await click();
      await advance(2_000);
      expect(lastToast()).toMatchObject({
        type: "loading",
        title: "Updating to SpecWithCode 0.2.5 · 0:02",
        description:
          "The SpecWithCode service on this Mac still runs 0.2.4. Waiting for open SpecWithCode terminals and agent processes to close",
        actionProps: { children: null },
        data: { secondaryActionProps: { children: "Cancel update" } },
      });
      expect(label()).toBe("Updating…");
      expect(button()?.props.disabled).toBe(true);
      // A second press (here, or in Settings) follows the request instead of stopping work again.
      calls.length = 0;
      await click();
      await act(async () => {
        await startServiceUpdateNow(agent);
      });
      expect(calls).toEqual([]);
      // Work that keeps running turns the notice into a warning, still without Update now.
      await advance(22_000);
      expect(lastToast()).toMatchObject({
        type: "warning",
        title: expect.stringMatching(/^Waiting to install SpecWithCode 0\.2\.5 · 0:2\d$/),
        actionProps: { children: null },
      });
      // The agent stops retrying when the hold ends; Update now asks again.
      await advance(15 * 60_000);
      expect(label()).toBe("Update now");
      expect(button()?.props.disabled).toBe(false);
      const toast = lastToast();
      expect(toast.actionProps.children).toBe("Update now");
      calls.length = 0;
      await act(async () => {
        toast.actionProps.onClick?.();
      });
      expect(calls).toEqual(STOP_AND_INSTALL);
    });

    it("names what still runs", async () => {
      agent = { ...serviceWaiting, updatedAt: new Date(Date.now() + 1_000).toISOString() };
      prepared = {
        idle: false,
        stoppedThreads: 1,
        blockers: [blocker("run", 1, "Fix login")],
      };
      render();
      await click();
      await advance(2_000);
      expect(lastToast().description).toBe(
        "The SpecWithCode service on this Mac still runs 0.2.4. Still running: 1 running task in “Fix login” (EasyChamp).",
      );
    });

    it("follows a request the agent has not answered yet, and ignores its old waiting state", async () => {
      // The state read straight after the request is the agent's answer to an earlier one.
      agent = {
        ...serviceWaiting,
        message: "Waiting for running tasks, queued messages and open questions to finish",
        updatedAt: new Date(Date.now() - 60_000).toISOString(),
      };
      render();
      await click();
      await advance(4_000);
      expect(lastToast()).toMatchObject({
        title: "Updating to SpecWithCode 0.2.5 · 0:04",
        description:
          "The SpecWithCode service on this Mac still runs 0.2.4. Checking that nothing is running, then installing…",
        actionProps: { children: null },
        data: { secondaryActionProps: { children: "Cancel update" } },
      });
      expect(label()).toBe("Updating…");
      expect(button()?.props.disabled).toBe(true);

      agent = { ...agent, message: "Retrying (attempt 2)", updatedAt: new Date().toISOString() };
      await advance(2_000);
      expect(lastToast().description).toBe(
        "The SpecWithCode service on this Mac still runs 0.2.4. Retrying (attempt 2)",
      );
    });

    it("renews a request the agent let lapse while work wound down, then gives up", async () => {
      const expired = "The update request expired before it could start; choose Update now again.";
      render();
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      const lapse = async () => {
        agent = {
          ...serviceWaiting,
          status: "waiting-for-quiet",
          message: "Waiting for open Studio terminals and agent processes to close (copilot)",
          updatedAt: new Date().toISOString(),
        };
        await advance(2_000);
        agent = {
          ...agent,
          status: "error",
          message: expired,
          updatedAt: new Date().toISOString(),
        };
        await advance(2_000);
      };
      for (let renewal = 1; renewal <= 3; renewal += 1) {
        calls.length = 0;
        await lapse();
        // Asked again, still holding the work: no failure shown.
        expect(calls).toEqual(["prepare:true+hold", "installServiceUpdate:force"]);
        expect(lastToast().type).not.toBe("error");
      }
      calls.length = 0;
      await lapse();
      expect(calls).not.toContain("installServiceUpdate:force");
      expect(lastToast()).toMatchObject({ type: "error", description: expired });
    });

    it("keeps following the agent while a check hangs", async () => {
      agent = { ...serviceWaiting, updatedAt: new Date(Date.now() + 1_000).toISOString() };
      render();
      await click();
      calls.length = 0;
      // From now on the service never answers a check.
      state.prepare.mockImplementation((value: { input: ServerPrepareServiceUpdateInput }) => {
        calls.push(prepareCall(value.input));
        return new Promise(() => undefined);
      });
      await advance(22_000);
      // Each hanging check is given up after 5 s, so the next one still goes out.
      expect(calls).toEqual(["prepare:false", "prepare:false"]);
      expect(lastToast().type).toBe("warning");
      agent = { ...serviceWaiting, status: "installing" };
      await advance(2_000);
      expect(label()).toBe("Installing…");
    });

    it("keeps following the agent while the desktop still handles the request", async () => {
      bridge.installServiceUpdate.mockImplementation(() => {
        calls.push("installServiceUpdate:slow");
        return new Promise(() => undefined);
      });
      render();
      await click();
      expect(calls).toEqual(["prepare:false", "prepare:true+hold", "installServiceUpdate:slow"]);
      agent = { ...serviceWaiting, status: "installing" };
      await advance(2_000);
      expect(label()).toBe("Installing…");
    });

    it("cancels: releases the hold, withdraws the request and closes the toast", async () => {
      agent = { ...serviceWaiting, updatedAt: new Date(Date.now() + 1_000).toISOString() };
      render();
      await click();
      await advance(2_000);
      calls.length = 0;
      await act(async () => {
        lastToast().data.secondaryActionProps?.onClick?.();
      });
      // Withdrawn first, so an install that started meanwhile keeps its hold.
      expect(calls).toEqual(["cancelServiceUpdate", "prepare:release"]);
      expect(state.closeToast).toHaveBeenCalledWith("toast-1");
      expect(label()).toBe("Update now");
      // Nothing is followed any more.
      calls.length = 0;
      await advance(30_000);
      expect(calls).toEqual([]);
    });

    it("asks an older agent again once nothing runs and it has gone quiet", async () => {
      agent = serviceWaiting;
      render();
      await click();
      calls.length = 0;
      await advance(32_000);
      expect(calls).toContain("prepare:false");
      expect(calls).toContain("installServiceUpdate:force");
    });

    it("leaves a retrying agent alone", async () => {
      render();
      await click();
      calls.length = 0;
      // The agent keeps writing its state while it retries.
      for (let second = 0; second < 40; second += 2) {
        agent = { ...serviceWaiting, updatedAt: new Date(Date.now()).toISOString() };
        await advance(2_000);
      }
      expect(calls).toContain("prepare:false");
      expect(calls).not.toContain("installServiceUpdate:force");
    });

    it("ends its own update, without asking again, once another window cancels it", async () => {
      // An older agent that has gone quiet would otherwise be asked again.
      agent = serviceWaiting;
      render();
      await click();
      await advance(12_000);
      expect(label()).toBe("Updating…");
      calls.length = 0;
      // Another window withdrew the request and released the hold.
      pending = null;
      checked = { idle: true, stoppedThreads: 0, blockers: [], held: false };
      await advance(40_000);
      expect(calls).not.toContain("installServiceUpdate:force");
      expect(state.closeToast).toHaveBeenCalledWith("toast-1");
      // Nothing is followed or asked for any more.
      calls.length = 0;
      await advance(40_000);
      expect(calls).toEqual([]);
    });

    it("does not ask again while its own cancel is under way", async () => {
      agent = serviceWaiting;
      render();
      await click();
      await advance(28_000);
      calls.length = 0;
      let finishCancel: (value: StudioServiceUpdateState) => void = () => undefined;
      cancelServiceUpdate.mockImplementationOnce(() => {
        calls.push("cancelServiceUpdate");
        return new Promise((resolve) => {
          finishCancel = resolve;
        });
      });
      await act(async () => {
        lastToast().data.secondaryActionProps?.onClick?.();
      });
      // The next check finds the service idle and the agent silent while the
      // withdrawal is still being written.
      await advance(4_000);
      expect(calls).toContain("prepare:false");
      expect(calls).not.toContain("installServiceUpdate:force");
      await act(async () => {
        finishCancel({ ...agent });
      });
      expect(calls.at(-1)).toBe("prepare:release");
      expect(calls).not.toContain("installServiceUpdate:force");
      expect(state.closeToast).toHaveBeenCalledWith("toast-1");
    });

    it("says why the install failed and offers a retry", async () => {
      render();
      await click();
      agent = {
        ...serviceWaiting,
        status: "error",
        message: "SpecWithCode 0.2.5 did not install; SpecWithCode stayed on 0.2.4.",
      };
      await advance(2_000);
      expect(label()).toBe("Retry update");
      expect(lastToast()).toMatchObject({
        type: "error",
        description: "SpecWithCode 0.2.5 did not install; SpecWithCode stayed on 0.2.4.",
        actionProps: { children: "Try again" },
      });
      expect(button()?.props.disabled).toBe(false);
      // The agent gave up, so work may start again before the notice is closed.
      expect(calls.at(-1)).toBe("prepare:release");
    });

    it("tries again for the newer version the agent offers after refusing the shown one", async () => {
      render();
      await click();
      expect(bridge.installServiceUpdate.mock.calls[0]![0]!.version).toBe("0.2.5");
      agent = {
        ...serviceWaiting,
        status: "error",
        availableVersion: "0.2.6",
        downloadedVersion: null,
        message:
          "SpecWithCode 0.2.5 was asked for, but 0.2.6 is the update now available; choose Update now again to install it.",
      };
      await advance(2_000);
      expect(label()).toBe("Retry update");
      await click();
      expect(bridge.installServiceUpdate.mock.calls.at(-1)![0]!.version).toBe("0.2.6");
    });

    it("still installs when the service cannot say what runs", async () => {
      state.prepare.mockImplementation(async () => {
        calls.push("prepare:failed");
        return { _tag: "Failure" };
      });
      render();
      await click();
      expect(calls).toEqual(["prepare:failed", "prepare:failed", "installServiceUpdate:force"]);
    });

    it("asks in general terms when the service cannot say what runs", async () => {
      state.prepare.mockImplementation(async () => ({ _tag: "Failure" }));
      registerConfirmDialogHost();
      render();
      await click();
      expect(readConfirmDialogState()).toMatchObject({
        status: "confirming",
        message: expect.stringContaining("Running tasks will be interrupted"),
      });
    });

    it("retries after a failure and follows the new attempt, not the old error", async () => {
      render();
      await click();
      agent = { ...serviceWaiting, status: "error", message: "Did not install." };
      await advance(2_000);
      expect(label()).toBe("Retry update");
      calls.length = 0;
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);
      // The agent has not run yet and still reports the old error.
      await advance(4_000);
      expect(label()).toBe("Updating…");
      expect(lastToast().description).toBe(
        "The SpecWithCode service on this Mac still runs 0.2.4. Checking that nothing is running, then installing…",
      );
      agent = { ...serviceWaiting, status: "installed", installedVersion: "0.2.5" };
      await advance(2_000);
      expect(label()).toBe("Restarting…");
    });

    it("times a retried install afresh", async () => {
      render();
      await click();
      agent = { ...serviceWaiting, status: "installing" };
      await advance(2_000);
      expect(label()).toBe("Installing…");
      // The helper rolls back; the retry comes well after the first install began.
      agent = { ...serviceWaiting, status: "up-to-date", updatedAt: new Date().toISOString() };
      await advance(2_000);
      expect(label()).toBe("Retry update");
      await advance(11 * 60_000);
      await click();
      agent = { ...serviceWaiting, status: "installing", updatedAt: new Date().toISOString() };
      await advance(2_000);
      expect(label()).toBe("Installing…");
      await advance(60_000);
      expect(label()).toBe("Installing…");
    });

    it("withdraws a failed attempt and releases the hold once, as it fails", async () => {
      render();
      await click();
      calls.length = 0;
      agent = { ...serviceWaiting, status: "error", message: "Did not install." };
      await advance(2_000);
      expect(calls).toEqual(["cancelServiceUpdate", "prepare:release"]);
      calls.length = 0;
      // Closing its toast later asks nothing more: another window may have pressed since.
      await act(async () => {
        lastToast().data.onClose?.();
      });
      expect(calls).toEqual([]);
      expect(label()).toBe("Update now");
    });

    it("keeps the hold when a timed-out install is closed, since it may still run", async () => {
      render();
      await click();
      agent = { ...serviceWaiting, status: "installing" };
      await advance(2_000);
      // Still within the install helper's own budget: followed, not reported.
      await advance(10 * 60_000);
      expect(lastToast().title).toMatch(/^Installing SpecWithCode 0\.2\.5 · 10:0\d$/);
      await advance(15 * 60_000);
      expect(lastToast().description).toContain("has not finished after 25 minutes");
      calls.length = 0;
      await act(async () => {
        lastToast().data.onClose?.();
      });
      expect(calls).toEqual(["cancelServiceUpdate"]);
    });

    it("keeps the hold and follows the install when the agent started it before the cancel", async () => {
      agent = { ...serviceWaiting, updatedAt: new Date(Date.now() + 1_000).toISOString() };
      render();
      await click();
      await advance(2_000);
      calls.length = 0;
      cancelServiceUpdate.mockImplementationOnce(async () => {
        calls.push("cancelServiceUpdate");
        return { ...serviceWaiting, status: "installing", updatedAt: new Date().toISOString() };
      });
      await act(async () => {
        lastToast().data.secondaryActionProps?.onClick?.();
      });
      expect(calls).toEqual(["cancelServiceUpdate"]);
      expect(label()).toBe("Installing…");
      expect(state.closeToast).not.toHaveBeenCalled();
    });

    it("keeps the hold and says so when the cancel is not saved", async () => {
      agent = { ...serviceWaiting, updatedAt: new Date(Date.now() + 1_000).toISOString() };
      render();
      await click();
      await advance(2_000);
      calls.length = 0;
      cancelServiceUpdate.mockImplementationOnce(async () => {
        calls.push("cancelServiceUpdate");
        throw new Error("The update could not be cancelled. Try again in a moment.");
      });
      await act(async () => {
        lastToast().data.secondaryActionProps?.onClick?.();
      });
      expect(calls).toEqual(["cancelServiceUpdate"]);
      expect(state.addToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error", title: "Could not cancel the update" }),
      );
      expect(state.closeToast).not.toHaveBeenCalled();
      expect(lastToast().data.secondaryActionProps?.children).toBe("Cancel update");
    });
  });

  describe("an update hold this window did not start", () => {
    beforeEach(() => {
      state.app = null;
      agent = { ...serviceWaiting, updatedAt: new Date(Date.now() - 60_000).toISOString() };
      state.service = agent;
      checked = { idle: true, stoppedThreads: 0, blockers: [], held: true };
    });

    it("is shown after a reload, with Cancel, and is not asked for again", async () => {
      render();
      await advance(0);
      expect(mountCalls).toEqual(["prepare:false"]);
      expect(lastToast()).toMatchObject({
        title: "Preparing to install SpecWithCode 0.2.5",
        actionProps: { children: "Update now" },
        data: { secondaryActionProps: { children: "Cancel update" } },
      });
      expect(label()).toBe("Update now");
      // Idle and silent: this window sent no request, so it sends none.
      await advance(40_000);
      expect(calls).not.toContain("installServiceUpdate:force");
      calls.length = 0;
      await act(async () => {
        lastToast().data.secondaryActionProps?.onClick?.();
      });
      expect(calls).toEqual(["cancelServiceUpdate", "prepare:release"]);
      expect(state.closeToast).toHaveBeenCalledWith("toast-1");
    });

    it("follows a forced request the desktop reports: Cancel only, and a press sends nothing", async () => {
      const requestedAt = Date.now() - 90_000;
      agent = {
        ...serviceWaiting,
        updatedAt: new Date(Date.now() - 1_000).toISOString(),
        pendingInstall: {
          requestedAt: new Date(requestedAt).toISOString(),
          mode: "force",
          version: "0.2.5",
          holdUntil: new Date(requestedAt + 15 * 60_000).toISOString(),
          handled: false,
        },
      };
      state.service = agent;
      render();
      await advance(0);
      expect(mountCalls).toEqual(["prepare:false"]);
      // Timed from the press in the window that made it.
      expect(lastToast()).toMatchObject({
        type: "loading",
        title: "Updating to SpecWithCode 0.2.5 · 1:30",
        actionProps: { children: null },
        data: { secondaryActionProps: { children: "Cancel update" } },
      });
      expect(label()).toBe("Updating…");
      expect(button()?.props.disabled).toBe(true);
      calls.length = 0;
      await click();
      await advance(2_000);
      expect(calls).not.toContain("prepare:true+hold");
      expect(calls).not.toContain("installServiceUpdate:force");
      agent = { ...agent, status: "installing", updatedAt: new Date().toISOString() };
      await advance(2_000);
      expect(label()).toBe("Installing…");
    });

    it("still restarts the app after the service when the window reloaded during Update now", async () => {
      const store = new Map<string, string>();
      (globalThis as { sessionStorage?: unknown }).sessionStorage = {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      };
      try {
        store.set(
          "specwithcode.serviceUpdate.thenInstallApp",
          JSON.stringify({ appVersion: "0.2.5", serviceVersion: "0.2.5", at: Date.now() - 60_000 }),
        );
        state.app = downloaded;
        const requestedAt = Date.now() - 60_000;
        agent = {
          ...serviceWaiting,
          status: "installing",
          updatedAt: new Date(Date.now() - 1_000).toISOString(),
          pendingInstall: {
            requestedAt: new Date(requestedAt).toISOString(),
            mode: "force",
            version: "0.2.5",
            holdUntil: new Date(requestedAt + 15 * 60_000).toISOString(),
            handled: true,
          },
        };
        state.service = agent;
        render();
        await advance(0);
        expect(label()).toBe("Installing…");
        agent = {
          ...serviceWaiting,
          status: "installed",
          installedVersion: "0.2.5",
          pendingInstall: null,
        };
        await advance(2_000);
        expect(calls.at(-1)).toBe("installUpdate:0.2.5");
        await advance(5_000);
        expect(reload).not.toHaveBeenCalled();
      } finally {
        delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
      }
    });

    it("follows an install already under way and reloads into it", async () => {
      agent = { ...serviceWaiting, status: "installing" };
      state.service = agent;
      render();
      await advance(0);
      expect(label()).toBe("Installing…");
      agent = { ...serviceWaiting, status: "installed", installedVersion: "0.2.5" };
      await advance(2_000);
      expect(label()).toBe("Restarting…");
      await advance(1_500);
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it("shows an install the agent runs on its own, with no hold, and reloads into it", async () => {
      checked = { idle: true, stoppedThreads: 0, blockers: [], held: false };
      agent = {
        ...serviceWaiting,
        status: "installing",
        updatedAt: new Date(Date.now() - 30_000).toISOString(),
      };
      state.service = agent;
      render();
      await advance(0);
      expect(label()).toBe("Installing…");
      expect(lastToast().title).toBe("Installing SpecWithCode 0.2.5 · 0:30");
      // Nothing is asked of the agent or the service: it is only followed.
      expect(calls).toEqual([]);
      agent = { ...serviceWaiting, status: "installed", installedVersion: "0.2.5" };
      await advance(2_000);
      expect(lastToast()).toMatchObject({
        type: "success",
        title: "Updated to SpecWithCode 0.2.5 in 0:32",
      });
      await advance(1_500);
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it("goes away once the hold ends elsewhere", async () => {
      render();
      await advance(0);
      expect(label()).toBe("Update now");
      checked = { ...checked, held: false };
      await advance(12_000);
      expect(state.closeToast).toHaveBeenCalledWith("toast-1");
    });

    it("releases a hold that nothing will install", async () => {
      bridge.getServiceUpdateState.mockImplementation(async () => ({
        ...serviceWaiting,
        status: "up-to-date",
      }));
      render();
      await advance(0);
      expect(mountCalls).toEqual(["prepare:false"]);
      expect(calls).toEqual(["cancelServiceUpdate", "prepare:release"]);
      expect(state.addToast).not.toHaveBeenCalled();
    });

    it("leaves a service that is not held alone, and picks up a hold started later", async () => {
      checked = { idle: true, stoppedThreads: 0, blockers: [], held: false };
      render();
      await advance(0);
      expect(mountCalls).toEqual(["prepare:false"]);
      expect(calls).toEqual([]);
      expect(state.addToast).not.toHaveBeenCalled();
      // Another window starts Update now; this one sees the agent move on.
      checked = { ...checked, held: true };
      agent = { ...serviceWaiting, updatedAt: new Date(Date.now()).toISOString() };
      state.service = agent;
      act(() => {
        renderer?.update(<SidebarRestartToUpdate />);
      });
      await advance(0);
      expect(lastToast()).toMatchObject({
        data: { secondaryActionProps: { children: "Cancel update" } },
      });
    });

    it("looks once while the agent is idle and leaves a service that is not held alone", async () => {
      agent = { ...serviceWaiting, status: "up-to-date" };
      state.service = agent;
      checked = { ...checked, held: false };
      render();
      await advance(0);
      expect(mountCalls).toEqual(["prepare:false"]);
      expect(calls).toEqual([]);
      expect(state.addToast).not.toHaveBeenCalled();
    });

    it("releases a hold an app restart left while the agent is idle", async () => {
      agent = { ...serviceWaiting, status: "up-to-date" };
      state.service = agent;
      render();
      await advance(0);
      expect(mountCalls).toEqual(["prepare:false"]);
      expect(calls).toEqual(["cancelServiceUpdate", "prepare:release"]);
      expect(state.addToast).not.toHaveBeenCalled();
    });

    it("releases a hold while the agent is in error", async () => {
      agent = { ...serviceWaiting, status: "error", message: "Download failed" };
      state.service = agent;
      render();
      await advance(0);
      expect(mountCalls).toEqual(["prepare:false"]);
      expect(calls).toEqual(["cancelServiceUpdate", "prepare:release"]);
    });

    it("releases a hold on a service no agent manages", async () => {
      agent = { ...serviceWaiting, status: "not-managed", identity: null };
      state.service = agent;
      render();
      await advance(0);
      expect(calls).toEqual(["cancelServiceUpdate", "prepare:release"]);
    });

    it.each(["up-to-date", "downloaded"] as const)(
      "leaves a hold taken for an app restart to the service (agent %s)",
      async (status) => {
        // Releasing it would let work start again just before the app quits.
        agent = { ...serviceWaiting, status };
        state.service = agent;
        checked = { ...checked, holdReason: "app-restart" };
        render();
        await advance(0);
        expect(mountCalls).toEqual(["prepare:false"]);
        expect(calls).toEqual([]);
        expect(state.addToast).not.toHaveBeenCalled();
      },
    );

    it("does not ask while the agent may be about to take up a request", async () => {
      state.service = { ...serviceWaiting, status: "available" };
      render();
      await advance(0);
      expect(mountCalls).toEqual([]);
    });
  });
});
