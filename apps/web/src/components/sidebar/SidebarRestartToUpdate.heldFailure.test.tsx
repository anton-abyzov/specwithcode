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

// M4, November 18, 2026: the agent failed an automatic install and held every
// newer release until a person asked, with the app's own update downloaded.
// Restart to update installed the app alone, main refused it ("installs after
// the service updates") and nothing ever updated the service. The press now
// updates the service first, held, then the app.

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
import { requestRestartToUpdate } from "./restartToUpdateRequests";
import { SidebarRestartToUpdate } from "./SidebarRestartToUpdate";

const HELD = "SpecWithCode 0.2.5 did not install automatically; choose Install now to retry.";
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
 * The agent's pass a minute ago held 0.2.5 after its failed automatic install.
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
    message: HELD,
    lastInstall: { version: "0.2.5", at: iso(Date.now() - 3_600_000), result: "failed" },
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

describe("Restart to update while the agent holds a failed install", () => {
  it("offers Update now for both, not an app restart the app would refuse", () => {
    state.app = appDownloaded;
    render();
    expect(label()).toBe("Update now");
    const description = String(button()?.props["aria-label"]);
    expect(description).toContain("SpecWithCode 0.2.5 did not install automatically.");
    expect(description).not.toContain("Install now");
    expect(description).toContain("The service updates first, then the app restarts on its own.");
  });

  it("holds the service's work and asks its agent to install, never the app alone", async () => {
    state.app = appDownloaded;
    render();
    const pressedAt = Date.now();
    await click();
    expect(calls).toEqual(STOP_AND_INSTALL);
    expect(installOptions).toMatchObject({ force: true, version: "0.2.5" });
    expect(bridge.installUpdate).not.toHaveBeenCalled();
    expect(
      state.addToast.mock.calls.map(([toast]) => (toast as { title?: string }).title),
    ).not.toContain("Could not install update");
    // The agent takes the request although it holds automatic installs.
    agent = agentNow(pressedAt, { status: "installing", message: null });
    await advance(2_000);
    expect(label()).toBe("Installing…");
  });

  it("is the press a toast's Restart to update makes too", async () => {
    state.app = appDownloaded;
    render();
    await act(async () => {
      expect(requestRestartToUpdate()).toBe(true);
    });
    expect(calls).toEqual(STOP_AND_INSTALL);
    expect(bridge.installUpdate).not.toHaveBeenCalled();
  });
});
