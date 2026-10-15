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

import {
  readConfirmDialogState,
  registerConfirmDialogHost,
  resetConfirmDialogForTests,
  respondToConfirmDialog,
} from "../../confirmDialog";
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
// What a look (stopWork false) reports, and what stopping reports.
let checked: ServerPrepareServiceUpdateResult = { idle: true, stoppedThreads: 0, blockers: [] };
let prepared: ServerPrepareServiceUpdateResult = { idle: true, stoppedThreads: 0, blockers: [] };
const reload = vi.fn();

function prepareCall(input: ServerPrepareServiceUpdateInput): string {
  if (input.releaseHold) return "prepare:release";
  return `prepare:${input.stopWork}${input.hold ? "+hold" : ""}`;
}

const bridge: {
  getServiceUpdateState: ReturnType<typeof vi.fn<() => Promise<StudioServiceUpdateState>>>;
  installUpdate: ReturnType<typeof vi.fn>;
  installServiceUpdate: ReturnType<
    typeof vi.fn<(options?: StudioServiceInstallOptions) => Promise<StudioServiceUpdateState>>
  >;
  cancelServiceUpdate?: ReturnType<typeof vi.fn<() => Promise<StudioServiceUpdateState>>>;
  getUpdatePreferences: ReturnType<typeof vi.fn>;
} = {
  getServiceUpdateState: vi.fn(async () => agent),
  installUpdate: vi.fn(async (options?: { expectedVersion?: string }) => {
    calls.push(`installUpdate:${options?.expectedVersion ?? ""}`);
    return { ...installResult, state: state.app ?? downloaded };
  }),
  installServiceUpdate: vi.fn(async (options?: StudioServiceInstallOptions) => {
    calls.push(`installServiceUpdate:${options?.force ? "force" : "normal"}`);
    return { ...agent };
  }),
  cancelServiceUpdate: vi.fn(async () => {
    calls.push("cancelServiceUpdate");
    return { ...agent };
  }),
  getUpdatePreferences: vi.fn(async () => ({
    checkAutomatically: true,
    downloadAutomatically: true,
    installAutomatically: true,
  })),
};
const cancelServiceUpdate = bridge.cancelServiceUpdate!;

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
  agent = serviceWaiting;
  checked = { idle: true, stoppedThreads: 0, blockers: [] };
  prepared = { idle: true, stoppedThreads: 0, blockers: [], held: true };
  state.prepare.mockReset();
  state.prepare.mockImplementation(async (value: { input: ServerPrepareServiceUpdateInput }) => {
    calls.push(prepareCall(value.input));
    return { _tag: "Success", value: value.input.stopWork ? prepared : checked };
  });
  reload.mockReset();
  bridge.getServiceUpdateState.mockClear();
  bridge.getServiceUpdateState.mockImplementation(async () => agent);
  bridge.installUpdate.mockClear();
  bridge.installServiceUpdate.mockClear();
  bridge.installServiceUpdate.mockImplementation(async (options?: StudioServiceInstallOptions) => {
    calls.push(`installServiceUpdate:${options?.force ? "force" : "normal"}`);
    return { ...agent };
  });
  bridge.cancelServiceUpdate = cancelServiceUpdate;
  cancelServiceUpdate.mockClear();
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
    expect(calls).toEqual(["prepare:false", "installUpdate:0.2.5"]);
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
      confirmLabel: "Restart anyway",
      cancelLabel: "Install when idle",
    });
    expect(dialog.status === "confirming" && dialog.message).toContain(
      "2 jobs are still running, 1 message is queued in 1 thread",
    );
    await act(async () => {
      respondToConfirmDialog(true);
    });
    expect(calls).toEqual(["prepare:false", "installUpdate:0.2.5"]);
  });

  it("restarts on its own once the work the user let finish is done", async () => {
    checked = { idle: false, stoppedThreads: 0, blockers: [blocker("run", 1, "Fix login")] };
    registerConfirmDialogHost();
    render();
    await click();
    await act(async () => {
      respondToConfirmDialog(false);
    });
    expect(calls).toEqual(["prepare:false"]);
    expect(label()).toBe("Restarts when idle");
    // Still running at the next check: nothing restarts.
    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });
    expect(calls).toEqual(["prepare:false", "prepare:false"]);
    checked = { idle: true, stoppedThreads: 0, blockers: [] };
    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });
    expect(calls).toEqual([
      "prepare:false",
      "prepare:false",
      "prepare:false",
      "installUpdate:0.2.5",
    ]);
    expect(readConfirmDialogState().status).not.toBe("confirming");
    expect(label()).toBe("Restarting…");
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
    expect(calls).toEqual([...STOP_AND_INSTALL, "installUpdate:0.2.5"]);
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
      // The click is answered at once and the button stays put, still clickable.
      expect(state.addToast).toHaveBeenCalledTimes(1);
      expect(label()).toBe("Update now");
      expect(button()?.props.disabled).toBe(false);

      agent = { ...serviceWaiting, status: "installing", message: "Installing Studio 0.2.5" };
      await advance(2_000);
      expect(label()).toBe("Installing…");
      expect(button()?.props.disabled).toBe(true);
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
          title: "Updated to SpecWithCode 0.2.5",
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

    it("offers Update now and Cancel while waiting, before any notice", async () => {
      agent = {
        ...serviceWaiting,
        message: "Waiting for open Studio terminals and agent processes to close",
        updatedAt: new Date(Date.now() + 1_000).toISOString(),
      };
      render();
      await click();
      await advance(2_000);
      const toast = lastToast();
      expect(toast).toMatchObject({
        type: "loading",
        description: "Waiting for open Studio terminals and agent processes to close",
        actionProps: { children: "Update now" },
        data: { secondaryActionProps: { children: "Cancel update" } },
      });
      expect(label()).toBe("Update now");

      calls.length = 0;
      await act(async () => {
        toast.actionProps.onClick?.();
      });
      expect(calls).toEqual(STOP_AND_INSTALL);
      await advance(22_000);
      expect(lastToast()).toMatchObject({
        type: "warning",
        actionProps: { children: "Update now" },
      });
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
        "Still running: 1 running task in “Fix login” (EasyChamp).",
      );
    });

    it("can retry while the agent has not answered, and ignores its old waiting state", async () => {
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
        description: "Asking the update agent to install it…",
        actionProps: { children: "Update now" },
        data: { secondaryActionProps: { children: "Cancel update" } },
      });
      expect(label()).toBe("Update now");
      expect(button()?.props.disabled).toBe(false);

      calls.length = 0;
      await click();
      expect(calls).toEqual(STOP_AND_INSTALL);

      agent = { ...agent, message: "Retrying (attempt 2)", updatedAt: new Date().toISOString() };
      await advance(2_000);
      expect(lastToast().description).toBe("Retrying (attempt 2)");
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

    it("keeps following the agent while an older desktop handles the request", async () => {
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

    it("cancels on an older desktop by releasing the hold", async () => {
      delete bridge.cancelServiceUpdate;
      agent = { ...serviceWaiting, updatedAt: new Date(Date.now() + 1_000).toISOString() };
      render();
      await click();
      await advance(2_000);
      calls.length = 0;
      await act(async () => {
        lastToast().data.secondaryActionProps?.onClick?.();
      });
      expect(calls).toEqual(["prepare:release"]);
      expect(state.closeToast).toHaveBeenCalled();
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
      expect(label()).toBe("Update now");
      calls.length = 0;
      // Another window withdrew the request and released the hold.
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
        message: "Studio 0.2.5 did not install; Studio stayed on 0.2.4.",
      };
      await advance(2_000);
      expect(label()).toBe("Retry update");
      expect(lastToast()).toMatchObject({
        type: "error",
        description: "Studio 0.2.5 did not install; Studio stayed on 0.2.4.",
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
      expect(label()).toBe("Update now");
      expect(lastToast().description).toBe("Asking the update agent to install it…");
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

    it("withdraws a failed attempt and releases the hold when its toast is closed", async () => {
      render();
      await click();
      agent = { ...serviceWaiting, status: "error", message: "Did not install." };
      await advance(2_000);
      calls.length = 0;
      await act(async () => {
        lastToast().data.onClose?.();
      });
      expect(calls).toEqual(["cancelServiceUpdate", "prepare:release"]);
      expect(label()).toBe("Update now");
    });

    it("keeps the hold when a timed-out install is closed, since it may still run", async () => {
      render();
      await click();
      agent = { ...serviceWaiting, status: "installing" };
      await advance(2_000);
      await advance(10 * 60_000);
      expect(lastToast().description).toContain("has not finished after 10 minutes");
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

    it("does not ask while the agent has no update under way", async () => {
      state.service = { ...serviceWaiting, status: "up-to-date" };
      render();
      await advance(0);
      expect(mountCalls).toEqual([]);
    });
  });
});
