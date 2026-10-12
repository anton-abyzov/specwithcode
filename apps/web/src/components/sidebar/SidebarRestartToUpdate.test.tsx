import type {
  DesktopUpdateActionResult,
  DesktopUpdateState,
  ServerPrepareServiceUpdateResult,
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
vi.mock("../../state/server", () => ({ serverEnvironment: { prepareServiceUpdate: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.prepare }));
vi.mock("../desktopUpdate.toast", () => ({ showDesktopUpdateDownloadedToast: state.announce }));
vi.mock("../ui/spinner", () => ({ Spinner: () => null }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactElement }) => render,
  TooltipPopup: () => null,
}));

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
let prepared: ServerPrepareServiceUpdateResult = { idle: true, stoppedThreads: 0, blockers: [] };
const reload = vi.fn();
const bridge = {
  getServiceUpdateState: vi.fn(async () => agent),
  installUpdate: vi.fn(async (options?: { expectedVersion?: string }) => {
    calls.push(`installUpdate:${options?.expectedVersion ?? ""}`);
    return { ...installResult, state: state.app ?? downloaded };
  }),
  installServiceUpdate: vi.fn(async () => {
    calls.push("installServiceUpdate");
    return { ...agent };
  }),
  getUpdatePreferences: vi.fn(async () => ({
    checkAutomatically: true,
    downloadAutomatically: true,
    installAutomatically: true,
  })),
};

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

function render() {
  act(() => {
    renderer = create(<SidebarRestartToUpdate />);
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
  agent = serviceWaiting;
  prepared = { idle: true, stoppedThreads: 0, blockers: [] };
  state.prepare.mockReset();
  state.prepare.mockImplementation(async (value: { input: { stopWork: boolean } }) => {
    calls.push(`prepare:${value.input.stopWork}`);
    return { _tag: "Success", value: prepared };
  });
  reload.mockReset();
  bridge.installUpdate.mockClear();
  bridge.installServiceUpdate.mockClear();
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
  };
}

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
    expect(calls).toEqual(["installUpdate:0.2.5"]);
    expect(label()).toBe("Restarting…");
    expect(state.addToast).not.toHaveBeenCalled();
  });

  it("says so when the app is still open a minute after an accepted install", async () => {
    render();
    await click();
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(label()).toBe("Restart to update");
    expect(state.addToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Studio did not restart" }),
    );
  });

  it("installs the service before restarting the app", async () => {
    state.service = serviceWaiting;
    render();
    await click();
    expect(calls).toEqual(["prepare:true", "installServiceUpdate", "installUpdate:0.2.5"]);
  });

  it("shows why a refused install did not happen and re-enables the button", async () => {
    installResult = { accepted: false, completed: false, reason: "no-download" };
    render();
    await click();
    expect(label()).toBe("Restart to update");
    expect(state.addToast).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining("newer release") }),
    );
  });

  it("keeps the button during a background check", () => {
    state.app = { ...downloaded, status: "checking" };
    render();
    expect(label()).toBe("Restart to update");
  });

  it("announces a background download once it is ready", () => {
    render();
    expect(state.announce).toHaveBeenCalledWith(bridge, downloaded);
  });

  it("waits to announce until a background window is focused", () => {
    focused = false;
    render();
    expect(state.announce).not.toHaveBeenCalled();
    act(() => {
      for (const listener of [...focusListeners]) listener();
    });
    expect(state.announce).toHaveBeenCalledWith(bridge, downloaded);
  });

  describe("service only", () => {
    beforeEach(() => {
      state.app = null;
      agent = { ...serviceWaiting, status: "downloaded" };
      state.service = agent;
    });

    it("stops work, installs, follows the agent and reloads into the new version", async () => {
      render();
      expect(label()).toBe("Restart to update");
      await click();
      expect(calls).toEqual(["prepare:true", "installServiceUpdate"]);
      // The click is answered at once and the button stays put.
      expect(state.addToast).toHaveBeenCalledTimes(1);
      expect(label()).toBe("Starting update…");

      agent = { ...serviceWaiting, status: "installing", message: "Installing Studio 0.2.5" };
      await advance(2_000);
      expect(label()).toBe("Installing…");
      expect(lastToast().title).toBe("Installing SpecWithCode 0.2.5");

      agent = { ...serviceWaiting, status: "installed", installedVersion: "0.2.5" };
      await advance(2_000);
      expect(label()).toBe("Restarting…");
      expect(lastToast()).toMatchObject({
        type: "success",
        title: "Updated to SpecWithCode 0.2.5",
      });
      await advance(1_500);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(state.addToast).toHaveBeenCalledTimes(1);
    });

    it("names what still runs and stops it on request", async () => {
      agent = {
        ...serviceWaiting,
        message: "Waiting for running tasks, queued messages and open questions to finish",
      };
      prepared = {
        idle: false,
        stoppedThreads: 1,
        blockers: [
          {
            kind: "run",
            count: 1,
            threadId: "thread-1",
            threadTitle: "Fix login",
            projectId: "project-1",
            projectTitle: "EasyChamp",
          },
        ],
      } as unknown as ServerPrepareServiceUpdateResult;
      render();
      await click();
      expect(label()).toBe("Stop and update");
      await advance(22_000);
      const toast = lastToast();
      expect(toast.type).toBe("warning");
      expect(toast.description).toBe("Still running: 1 running task in “Fix login” (EasyChamp).");
      expect(toast.actionProps.children).toBe("Stop them and update");
      // Re-checks only look; it never asks the agent again while work remains.
      expect(calls.filter((call) => call === "prepare:false").length).toBeGreaterThan(0);
      expect(calls.filter((call) => call === "installServiceUpdate")).toHaveLength(1);

      calls.length = 0;
      await act(async () => {
        toast.actionProps.onClick?.();
      });
      expect(calls).toEqual(["prepare:true", "installServiceUpdate"]);
    });

    it("asks the agent again once nothing runs any more", async () => {
      agent = serviceWaiting;
      render();
      await click();
      expect(label()).toBe("Waiting to update…");
      calls.length = 0;
      await advance(32_000);
      expect(calls).toContain("prepare:false");
      expect(calls).toContain("installServiceUpdate");
    });

    it("shows the agent's words when nothing the server knows of is running", async () => {
      agent = {
        ...serviceWaiting,
        message: "Waiting for open Studio terminals and agent processes to close",
      };
      render();
      await click();
      await advance(22_000);
      expect(lastToast()).toMatchObject({
        type: "warning",
        description: "Waiting for open Studio terminals and agent processes to close",
        actionProps: { children: "Try again" },
      });
    });

    it("says why the install failed and offers a retry", async () => {
      render();
      await click();
      agent = {
        ...serviceWaiting,
        status: "error",
        message: "Studio 0.2.5 did not install; Studio stayed on 0.2.4.",
      };
      await advance(2_000);
      expect(label()).toBe("Retry update");
      expect(lastToast()).toMatchObject({
        type: "error",
        description: "Studio 0.2.5 did not install; Studio stayed on 0.2.4.",
      });
      expect(button()?.props.disabled).toBe(false);
    });

    it("still installs when the service cannot say what runs", async () => {
      state.prepare.mockImplementation(async () => {
        calls.push("prepare:failed");
        return { _tag: "Failure" };
      });
      render();
      await click();
      expect(calls).toEqual(["prepare:failed", "installServiceUpdate"]);
    });

    it("retries after a failure and follows the new attempt, not the old error", async () => {
      render();
      await click();
      agent = { ...serviceWaiting, status: "error", message: "Did not install." };
      await advance(2_000);
      expect(label()).toBe("Retry update");
      calls.length = 0;
      await click();
      expect(calls).toEqual(["prepare:true", "installServiceUpdate"]);
      // The agent has not run yet and still reports the old error.
      await advance(4_000);
      expect(label()).toBe("Starting update…");
      agent = { ...serviceWaiting, status: "installed", installedVersion: "0.2.5" };
      await advance(2_000);
      expect(label()).toBe("Restarting…");
    });
  });
});
