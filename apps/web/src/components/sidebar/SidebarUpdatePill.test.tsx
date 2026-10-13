import type { DesktopUpdateState } from "@specweave-studio/contracts";
import type { ReactElement, ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  app: null as DesktopUpdateState | null,
  addToast: vi.fn(),
  announceDownload: vi.fn(),
  confirm: vi.fn(async () => true),
}));

vi.mock("../../env", () => ({ isElectron: true }));
vi.mock("../../state/desktopUpdate", () => ({ useDesktopUpdateState: () => state.app }));
vi.mock("../../hooks/useMediaQuery", () => ({ useMediaQuery: () => true }));
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ dialogs: { confirm: state.confirm } }),
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: state.addToast },
  stackedThreadToast: (toast: unknown) => toast,
}));
vi.mock("../desktopUpdate.toast", () => ({
  showDesktopUpdateDownloadedToast: state.announceDownload,
}));
vi.mock("../ui/sidebar", () => ({
  SidebarMenuItem: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactElement }) => render,
  TooltipPopup: () => null,
}));
vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverCreateHandle: () => ({ close: vi.fn(), open: vi.fn() }),
  PopoverTrigger: ({ render }: { render: ReactElement }) => render,
  PopoverPopup: () => null,
}));

import {
  handleSidebarUpdateReleaseNotesPopoverOpenChange,
  openSidebarUpdateReleaseNotesPopoverOnForwardTab,
  SidebarUpdatePill,
  shouldUseSidebarUpdateReleaseNotesPopover,
} from "./SidebarUpdatePill";

const nightlyState: DesktopUpdateState = {
  enabled: true,
  status: "available",
  channel: "nightly",
  currentVersion: "0.0.35",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: "0.0.36-nightly.3",
  downloadedVersion: null,
  releaseNotes: [{ version: "0.0.36-nightly.3", items: ["Newest change"], totalItems: 1 }],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

describe("sidebar update release notes popover", () => {
  it("uses the popover only for visible nightly release notes", () => {
    expect(shouldUseSidebarUpdateReleaseNotesPopover(true, nightlyState)).toBe(true);
    expect(shouldUseSidebarUpdateReleaseNotesPopover(false, nightlyState)).toBe(false);
    expect(
      shouldUseSidebarUpdateReleaseNotesPopover(true, {
        ...nightlyState,
        channel: "latest",
      }),
    ).toBe(false);
    expect(
      shouldUseSidebarUpdateReleaseNotesPopover(true, {
        ...nightlyState,
        releaseNotes: [],
      }),
    ).toBe(false);
  });

  it("cancels trigger presses without canceling other open reasons", () => {
    const cancelTriggerPress = vi.fn();
    const cancelHover = vi.fn();

    handleSidebarUpdateReleaseNotesPopoverOpenChange(true, {
      reason: "trigger-press",
      cancel: cancelTriggerPress,
    });
    handleSidebarUpdateReleaseNotesPopoverOpenChange(true, {
      reason: "trigger-hover",
      cancel: cancelHover,
    });

    expect(cancelTriggerPress).toHaveBeenCalledOnce();
    expect(cancelHover).not.toHaveBeenCalled();
  });

  it("promotes forward Tab without preventing native navigation", () => {
    const open = vi.fn();
    const preventDefault = vi.fn();
    const event = { key: "Tab", shiftKey: false, preventDefault };

    openSidebarUpdateReleaseNotesPopoverOnForwardTab(event, { open }, "nightly-release-notes");

    expect(open).toHaveBeenCalledWith("nightly-release-notes");
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("does not promote backward Tab", () => {
    const open = vi.fn();

    openSidebarUpdateReleaseNotesPopoverOnForwardTab(
      { key: "Tab", shiftKey: true },
      { open },
      "nightly-release-notes",
    );

    expect(open).not.toHaveBeenCalled();
  });
});

describe("manual sidebar update checks", () => {
  const current: DesktopUpdateState = {
    ...nightlyState,
    status: "up-to-date",
    channel: "latest",
    currentVersion: "1.0.10",
    availableVersion: null,
    releaseNotes: [],
    checkedAt: "2026-10-13T19:24:59.000Z",
  };
  const bridge = {
    checkForUpdate: vi.fn(),
    downloadUpdate: vi.fn(),
    installUpdate: vi.fn(),
  };
  let renderer: ReactTestRenderer | null = null;

  function render() {
    act(() => {
      renderer = create(<SidebarUpdatePill />);
    });
  }

  async function click() {
    await act(async () => {
      renderer!.root.findByType("button").props.onClick();
    });
  }

  function update(app: DesktopUpdateState) {
    state.app = app;
    act(() => renderer!.update(<SidebarUpdatePill />));
  }

  beforeEach(() => {
    state.app = current;
    state.addToast.mockReset();
    state.announceDownload.mockReset();
    state.confirm.mockClear();
    bridge.checkForUpdate.mockReset();
    bridge.downloadUpdate.mockReset();
    bridge.installUpdate.mockReset();
    vi.stubGlobal("window", { desktopBridge: bridge });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = null;
    vi.unstubAllGlobals();
  });

  it("reports the installed version when no newer release is available", async () => {
    bridge.checkForUpdate.mockResolvedValue({ checked: true, state: current });
    render();

    await click();

    expect(bridge.checkForUpdate).toHaveBeenCalledOnce();
    expect(state.addToast).toHaveBeenCalledExactlyOnceWith({
      type: "success",
      title: "No newer update available",
      description: "SpecWithCode 1.0.10 is installed.",
    });
  });

  it("reports a handled check failure even when checked is true", async () => {
    bridge.checkForUpdate.mockResolvedValue({
      checked: true,
      state: { ...current, status: "error", message: "The release feed is unavailable." },
    });
    render();

    await click();

    expect(state.addToast).toHaveBeenCalledExactlyOnceWith({
      type: "error",
      title: "Could not check for updates",
      description: "The release feed is unavailable.",
    });
  });

  it("keeps rejected checks and bridge failures visible", async () => {
    bridge.checkForUpdate.mockResolvedValue({
      checked: false,
      state: { ...current, message: "Updates are disabled in this build." },
    });
    render();
    await click();
    expect(state.addToast).toHaveBeenLastCalledWith({
      type: "error",
      title: "Could not check for updates",
      description: "Updates are disabled in this build.",
    });

    bridge.checkForUpdate.mockRejectedValue(new Error("The update service disconnected."));
    await click();
    expect(state.addToast).toHaveBeenLastCalledWith({
      type: "error",
      title: "Could not check for updates",
      description: "The update service disconnected.",
    });
  });

  it("waits for the matching state event when the RPC finishes before the check event", async () => {
    const checkedAt = "2026-10-13T19:25:00.000Z";
    bridge.checkForUpdate.mockResolvedValue({
      checked: true,
      state: { ...current, status: "checking", checkedAt },
    });
    render();
    await click();
    expect(state.addToast).not.toHaveBeenCalled();

    update({ ...current, checkedAt: "2026-10-13T19:25:00.432Z" });
    expect(state.addToast).toHaveBeenCalledExactlyOnceWith({
      type: "success",
      title: "No newer update available",
      description: "SpecWithCode 1.0.10 is installed.",
    });
    expect(renderer!.root.findByType("button").props["aria-disabled"]).toBeUndefined();
  });

  it("reports a delayed failure and allows another manual check", async () => {
    bridge.checkForUpdate.mockResolvedValue({
      checked: true,
      state: { ...current, status: "checking", checkedAt: "2026-10-13T19:25:00.000Z" },
    });
    render();
    await click();

    update({
      ...current,
      status: "error",
      errorContext: "check",
      checkedAt: "2026-10-13T19:25:00.432Z",
      message: "The release feed is unavailable.",
    });

    expect(state.addToast).toHaveBeenCalledExactlyOnceWith({
      type: "error",
      title: "Could not check for updates",
      description: "The release feed is unavailable.",
    });
    expect(renderer!.root.findByType("button").props["aria-disabled"]).toBeUndefined();
  });

  it("keeps background checks quiet", () => {
    render();
    update({ ...current, status: "checking" });
    update(current);
    update({ ...current, status: "error", message: "Background check failed." });

    expect(state.addToast).not.toHaveBeenCalled();
    expect(bridge.checkForUpdate).not.toHaveBeenCalled();
  });

  it("preserves the download action after a newer release is offered", async () => {
    const available: DesktopUpdateState = {
      ...current,
      status: "available",
      availableVersion: "1.0.11",
    };
    bridge.checkForUpdate.mockResolvedValue({ checked: true, state: available });
    bridge.downloadUpdate.mockResolvedValue({
      accepted: true,
      completed: true,
      failed: false,
      state: { ...available, status: "downloaded", downloadedVersion: "1.0.11" },
    });
    render();
    await click();
    expect(state.addToast).not.toHaveBeenCalled();

    update(available);
    expect(renderer!.root.findByType("button").props["aria-label"]).toBe(
      "Update 1.0.11 ready to download",
    );
    await click();
    expect(bridge.checkForUpdate).toHaveBeenCalledOnce();
    expect(bridge.downloadUpdate).toHaveBeenCalledOnce();
    expect(state.announceDownload).toHaveBeenCalledOnce();
  });

  it("preserves the confirmed restart action for a downloaded update", async () => {
    state.app = {
      ...current,
      status: "downloaded",
      availableVersion: "1.0.11",
      downloadedVersion: "1.0.11",
    };
    bridge.installUpdate.mockResolvedValue({
      accepted: true,
      completed: true,
      failed: false,
      state: state.app,
    });
    render();

    await click();

    expect(state.confirm).toHaveBeenCalledWith(expect.stringContaining("Install update 1.0.11"));
    expect(bridge.installUpdate).toHaveBeenCalledOnce();
    expect(bridge.checkForUpdate).not.toHaveBeenCalled();
    expect(state.addToast).not.toHaveBeenCalled();
  });

  it("does not report an automatic download failure as a failed release check", async () => {
    const failedDownload: DesktopUpdateState = {
      ...current,
      status: "error",
      errorContext: "download",
      availableVersion: "1.0.11",
      message: "The download was interrupted.",
    };
    bridge.checkForUpdate.mockResolvedValue({ checked: true, state: failedDownload });
    render();
    await click();
    update(failedDownload);

    expect(state.addToast).not.toHaveBeenCalled();
    expect(renderer!.root.findByType("button").props["aria-label"]).toBe(
      "Download failed for 1.0.11. Click to retry.",
    );
  });
});
