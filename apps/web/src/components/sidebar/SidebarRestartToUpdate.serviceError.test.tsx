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

// "Update now" while the service's agent reports that its last pass failed,
// but already has a newer release on disk: the press installs that release,
// from the sidebar, Settings or the header pill.

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
import { resolveServiceUpdateAction } from "../settings/UpdatePreferencesSection.logic";
import { requestRestartToUpdate } from "./restartToUpdateRequests";
import { SidebarRestartToUpdate } from "./SidebarRestartToUpdate";

const LOG_DELETED =
  "SpecWithCode cannot be updated right now: The SpecWithCode service is using a database log that was deleted from disk. Restart SpecWithCode, then update";
const RECOVERING = "Restarting SpecWithCode to recover its database";
const NOT_AVAILABLE = "SpecWithCode 0.2.5 is not available to the service on this Mac yet.";
const STOP_AND_INSTALL = ["prepare:false", "prepare:true+hold", "installServiceUpdate:force"];
const IDLE: ServerPrepareServiceUpdateResult = { idle: true, stoppedThreads: 0, blockers: [] };

// The app already runs the release the service lacks: it updated on quit.
const appCurrent: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "0.2.5",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
  productionBuild: true,
};

// The app has its own update downloaded too.
const appDownloaded: DesktopUpdateState = {
  ...appCurrent,
  status: "downloaded",
  currentVersion: "0.2.4",
  availableVersion: "0.2.5",
  downloadedVersion: "0.2.5",
  downloadPercent: 100,
  canRetry: true,
};

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The agent's last pass checked its feed, then failed with 0.2.5 on disk, a
 * minute before now.
 */
function failedEarlier(): StudioServiceUpdateState {
  return {
    status: "error",
    identity: "m4",
    installedVersion: "0.2.4",
    availableVersion: "0.2.5",
    downloadedVersion: "0.2.5",
    checkedAt: iso(Date.now() - 61_000),
    quietSince: null,
    message: LOG_DELETED,
    lastInstall: { version: "0.2.4", at: iso(Date.now() - 86_400_000), result: "updated" },
    updatedAt: iso(Date.now() - 60_000),
    pendingInstall: null,
  };
}

/** What the agent writes now, for the request made at `pressedAt`. */
function agentNow(
  pressedAt: number,
  patch: Partial<StudioServiceUpdateState>,
): StudioServiceUpdateState {
  return {
    ...failedEarlier(),
    updatedAt: iso(Date.now() + 500),
    pendingInstall: {
      requestedAt: iso(pressedAt),
      mode: "force",
      version: "0.2.5",
      holdUntil: iso(pressedAt + 15 * 60_000),
      handled: false,
    },
    ...patch,
  };
}

const calls: string[] = [];
let installResult: Omit<DesktopUpdateActionResult, "state">;
let agent: StudioServiceUpdateState = failedEarlier();
let installOptions: StudioServiceInstallOptions | undefined;
const reload = vi.fn();

function prepareCall(input: ServerPrepareServiceUpdateInput): string {
  if (input.releaseHold) return "prepare:release";
  const reason = input.reason === "app-restart" ? ":app-restart" : "";
  return `prepare:${input.stopWork}${input.hold ? `+hold${reason}` : ""}`;
}

const bridge = {
  checkForUpdate: vi.fn(async () => ({ checked: true, state: state.app ?? appCurrent })),
  downloadUpdate: vi.fn(async () => ({
    accepted: true,
    completed: true,
    state: state.app ?? appCurrent,
  })),
  getUpdateState: vi.fn(async () => state.app ?? appCurrent),
  getServiceUpdateState: vi.fn<() => Promise<StudioServiceUpdateState>>(async () => agent),
  installUpdate: vi.fn(async (options?: { expectedVersion?: string }) => {
    calls.push(`installUpdate:${options?.expectedVersion ?? ""}`);
    return { ...installResult, state: state.app ?? appCurrent };
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
  ) as { type: string; title: string; description: string };
}

/** The service runs 0.2.5: the agent installed it for the request at `pressedAt`. */
function installed(pressedAt: number): StudioServiceUpdateState {
  const doneAt = iso(Date.now() + 1_000);
  return agentNow(pressedAt, {
    status: "installed",
    installedVersion: "0.2.5",
    availableVersion: null,
    downloadedVersion: null,
    message: null,
    updatedAt: doneAt,
    lastInstall: { version: "0.2.5", at: doneAt, result: "updated" },
    pendingInstall: null,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  calls.length = 0;
  installResult = { accepted: true, completed: false, failed: false };
  installOptions = undefined;
  state.app = appCurrent;
  state.addToast.mockClear();
  state.updateToast.mockReset();
  state.closeToast.mockReset();
  agent = failedEarlier();
  state.service = agent;
  state.prepare.mockReset();
  state.prepare.mockImplementation(async (value: { input: ServerPrepareServiceUpdateInput }) => {
    calls.push(prepareCall(value.input));
    return { _tag: "Success", value: value.input.stopWork ? { ...IDLE, held: true } : IDLE };
  });
  reload.mockReset();
  bridge.getServiceUpdateState.mockReset();
  bridge.getServiceUpdateState.mockImplementation(async () => agent);
  bridge.installUpdate.mockClear();
  bridge.installServiceUpdate.mockReset();
  bridge.installServiceUpdate.mockImplementation(async (options?: StudioServiceInstallOptions) => {
    calls.push(`installServiceUpdate:${options?.force ? "force" : "normal"}`);
    installOptions = options;
    return { ...agent };
  });
  bridge.cancelServiceUpdate.mockReset();
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
});

describe("Update now beside a failed service update pass", () => {
  it("is offered with the failure in its description", () => {
    render();
    expect(label()).toBe("Update now");
    const description = String(button()?.props["aria-label"]);
    expect(description).toContain(`${LOG_DELETED}.`);
    expect(description).toContain(
      "The SpecWithCode service on this Mac still runs 0.2.4; this installs 0.2.5.",
    );
  });

  it("installs the release the agent has, never taking its old failure as the answer", async () => {
    render();
    const pressedAt = Date.now();
    await click();
    expect(calls).toEqual(STOP_AND_INSTALL);
    expect(installOptions).toMatchObject({ force: true, version: "0.2.5" });
    // The agent has not run for the request yet: its failure was written before it.
    await advance(3 * 60_000);
    expect(lastToast().type).toBe("loading");
    expect(lastToast().title).toMatch(/^Updating to SpecWithCode 0\.2\.5/);
    expect(label()).toBe("Updating…");
    // It restarts the service for its database, then installs.
    agent = agentNow(pressedAt, { status: "waiting-for-quiet", message: RECOVERING });
    await advance(2_000);
    expect(lastToast().description).toContain(RECOVERING);
    agent = agentNow(pressedAt, { status: "installing", message: null });
    await advance(2_000);
    expect(label()).toBe("Installing…");
    agent = installed(pressedAt);
    await advance(2_000);
    expect(lastToast().type).toBe("success");
    await advance(2_000);
    expect(reload).toHaveBeenCalled();
  });

  it("ends for good when the agent answers the request with a failure", async () => {
    render();
    const pressedAt = Date.now();
    await click();
    expect(calls).toEqual(STOP_AND_INSTALL);
    // It tried to install for the request, and ended it with its retry's refusal.
    agent = agentNow(pressedAt, {
      pendingInstall: null,
      lastInstall: { version: "0.2.5", at: iso(Date.now()), result: "failed" },
    });
    await advance(2_000);
    expect(lastToast()).toMatchObject({ type: "error", description: LOG_DELETED });
    expect(label()).toBe("Retry update");
    // A later state of the agent does not take the failed attempt up again.
    calls.length = 0;
    agent = agentNow(pressedAt, { status: "waiting-for-quiet", message: RECOVERING });
    await advance(30_000);
    expect(label()).toBe("Retry update");
    expect(calls.filter((call) => call !== "prepare:release" && call !== "prepare:false")).toEqual(
      [],
    );
  });

  it("keeps saying the release is missing while the agent's later states still lack it", async () => {
    render();
    const pressedAt = Date.now();
    await click();
    expect(calls).toEqual(STOP_AND_INSTALL);
    // The agent ran for the request and found nothing to install.
    const lacking = agentNow(pressedAt, {
      status: "up-to-date",
      availableVersion: null,
      downloadedVersion: null,
      message: null,
      pendingInstall: null,
    });
    agent = lacking;
    await advance(2_000);
    expect(lastToast()).toMatchObject({ type: "error", description: NOT_AVAILABLE });
    state.closeToast.mockClear();
    // Its next pass still lacks 0.2.5.
    agent = { ...lacking, updatedAt: iso(Date.now() + 60_000) };
    state.service = agent;
    act(() => {
      renderer?.update(<SidebarRestartToUpdate />);
    });
    await advance(0);
    expect(state.closeToast).not.toHaveBeenCalled();
    expect(lastToast()).toMatchObject({
      type: "error",
      description: NOT_AVAILABLE,
      actionProps: { children: "Try again" },
    });
  });

  it("starts the same update from Settings", async () => {
    render();
    let handled = false;
    await act(async () => {
      handled = requestRestartToUpdate({ requireService: true });
    });
    expect(handled).toBe(true);
    expect(calls).toEqual(STOP_AND_INSTALL);
    expect(installOptions).toMatchObject({ force: true, version: "0.2.5" });
  });

  it("updates the service first, then the app, from the header pill", async () => {
    state.app = appDownloaded;
    render();
    expect(label()).toBe("Update now");
    const pressedAt = Date.now();
    await act(async () => {
      requestRestartToUpdate();
    });
    await advance(0);
    expect(calls).toEqual(STOP_AND_INSTALL);
    agent = agentNow(pressedAt, { status: "installing", message: null });
    await advance(2_000);
    agent = installed(pressedAt);
    await advance(4_000);
    expect(calls.at(-1)).toBe("installUpdate:0.2.5");
  });

  it("restarts only the app beside a failure a forced request cannot get past", async () => {
    const failures: StudioServiceUpdateState[] = [
      // The pass failed its check: every pass checks again and fails first.
      { ...failedEarlier(), checkedAt: null, message: "GitHub release lookup failed (HTTP 403)" },
      // The agent rejected its download: until its next check every pass, a
      // forced one too, fails at once without fetching it again.
      {
        ...failedEarlier(),
        downloadedVersion: null,
        message: "Runtime archive checksum does not match the release",
      },
      {
        ...failedEarlier(),
        downloadedVersion: null,
        message: "GitHub download was interrupted (TimeoutError)",
      },
      // The desktop could not start the agent at all, and flags it.
      {
        ...failedEarlier(),
        agentStartFailed: true,
        message:
          "Update agent is turned off in launchd. Choose Repair in Settings to turn it back on.",
      },
      {
        ...failedEarlier(),
        agentStartFailed: true,
        message: "The update agent could not be installed: python3 exited with 1",
      },
    ];
    for (const failure of failures) {
      resetServiceUpdateFlowForTests();
      agent = failure;
      state.service = failure;
      state.app = appCurrent;
      render();
      expect(button()).toBeNull();
      expect(resolveServiceUpdateAction(failure)).toBe("check");
      state.app = appDownloaded;
      act(() => {
        renderer?.update(<SidebarRestartToUpdate />);
      });
      expect(label()).toBe("Restart to update");
      await click();
      await advance(0);
      expect(calls).toEqual([
        "prepare:false",
        "prepare:true+hold:app-restart",
        "installUpdate:0.2.5",
      ]);
      act(() => renderer?.unmount());
      renderer = null;
    }
  });

  it("offers only a check of its own when the agent has nothing newer", async () => {
    agent = { ...failedEarlier(), availableVersion: null, downloadedVersion: null };
    state.service = agent;
    render();
    expect(button()).toBeNull();
    // The app's own update restarts the app alone.
    state.app = appDownloaded;
    act(() => {
      renderer?.update(<SidebarRestartToUpdate />);
    });
    expect(label()).toBe("Restart to update");
    await click();
    await advance(0);
    expect(calls).not.toContain("installServiceUpdate:force");
    expect(calls.at(-1)).toBe("installUpdate:0.2.5");
  });
});
