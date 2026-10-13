import type { StudioServiceUpdateState } from "@specweave-studio/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  startServiceUpdateNow: vi.fn(async (_state: unknown) => true),
  flow: {
    progress: null as { phase: string } | null,
    waitedLong: false,
    starting: false,
  },
}));

vi.mock("../serviceUpdateFlow", () => ({
  startServiceUpdateNow: mocks.startServiceUpdateNow,
  useServiceUpdateFlow: () => mocks.flow,
}));
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({ control }: { control: ReactNode }) => <div>{control}</div>,
}));
vi.mock("./settingsSearch", () => ({
  searchableSetting: () => ({ id: "app-updates", title: "Check for updates automatically" }),
}));
vi.mock("../ui/switch", () => ({ Switch: () => null }));
vi.mock("../ui/button", () => ({
  Button: ({
    children,
    disabled,
    onClick,
  }: {
    children: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: vi.fn() },
  stackedThreadToast: (toast: unknown) => toast,
}));

import { UpdatePreferencesSection } from "./UpdatePreferencesSection";

const waiting: StudioServiceUpdateState = {
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

const bridge = {
  getUpdatePreferences: vi.fn(async () => ({
    checkAutomatically: true,
    downloadAutomatically: true,
    installAutomatically: false,
  })),
  setUpdatePreferences: vi.fn(),
  getServiceUpdateState: vi.fn(async () => waiting),
  installServiceUpdate: vi.fn(async () => waiting),
  checkServiceUpdate: vi.fn(async () => waiting),
};

let renderer: ReactTestRenderer | null = null;

async function render() {
  await act(async () => {
    renderer = create(<UpdatePreferencesSection />);
  });
}

function installButton() {
  return renderer!.root
    .findAllByType("button")
    .find((node) => node.children.join("") === "Install now");
}

beforeEach(() => {
  mocks.startServiceUpdateNow.mockClear();
  mocks.flow = { progress: null, waitedLong: false, starting: false };
  bridge.installServiceUpdate.mockClear();
  (globalThis as { window?: unknown }).window = globalThis;
  (globalThis as { desktopBridge?: unknown }).desktopBridge = bridge;
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  delete (globalThis as { desktopBridge?: unknown }).desktopBridge;
});

describe("UpdatePreferencesSection", () => {
  it("installs the service through the same Update now flow as the sidebar", async () => {
    await render();
    const button = installButton();
    expect(button).toBeDefined();
    await act(async () => {
      button!.props.onClick();
    });
    expect(mocks.startServiceUpdateNow).toHaveBeenCalledWith(waiting);
    // Never a bare install request that skips stopping the work.
    expect(bridge.installServiceUpdate).not.toHaveBeenCalled();
  });

  it("does not start a second install while one is under way", async () => {
    mocks.flow = { progress: { phase: "installing" }, waitedLong: false, starting: false };
    await render();
    expect(installButton()!.props.disabled).toBe(true);
    act(() => renderer?.unmount());
    mocks.flow = { progress: { phase: "waiting" }, waitedLong: false, starting: false };
    await render();
    expect(installButton()!.props.disabled).toBe(false);
  });
});
