// @vitest-environment jsdom
import {
  EnvironmentId,
  ThreadId,
  type DeviceServiceState,
  type DeviceSummary,
} from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { RunOnDeviceCard } from "./RunOnDeviceCard";
import type { RunOnDeviceCardModel } from "./runOnDeviceCard.logic";

type CommandResult =
  | { _tag: "Success"; value: { hostId: string; deviceId: string } }
  | { _tag: "Failure"; cause: unknown };
const mocks = vi.hoisted(() => ({
  open: vi.fn<(request: unknown) => Promise<CommandResult>>(),
  openDevice: vi.fn(),
  openPanel: vi.fn(),
}));

const threadRef = {
  environmentId: EnvironmentId.make("environment-a"),
  threadId: ThreadId.make("thread-1"),
};
const iphone: DeviceSummary = {
  hostId: "local",
  id: "IPHONE-UDID",
  platform: "ios",
  name: "iPhone 17 Pro",
  version: "iOS 26.0",
  booted: false,
  physical: false,
};
const pixel: DeviceSummary = {
  hostId: "local",
  id: "emulator-5554",
  platform: "android",
  name: "Pixel 9",
  version: "Android 15.0",
  booted: true,
  physical: false,
};
const readyState: DeviceServiceState = {
  hosts: [],
  hostStatus: "ready",
  hostStatuses: { local: { status: "ready" } },
  devices: [iphone, pixel],
  sessions: [],
  onboardingCompleted: true,
  agentAccessEnabled: true,
  hubBasePath: "/api/device-hub",
  revision: 1,
};
let currentState = readyState;
let currentLoaded = true;

vi.mock("~/state/device", () => ({
  deviceEnvironment: { open: "open" },
  useDeviceState: () => ({ state: currentState, loaded: currentLoaded }),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.open }));
vi.mock("~/state/query", () => ({ formatEnvironmentQueryError: () => "Device failed to boot." }));
vi.mock("~/state/entities", () => ({ useThreadVisibleTurnItems: () => [] }));
vi.mock("~/state/queries", () => ({ useTurnItemDetail: () => ({ data: null }) }));
vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: {
    getState: () => ({ openDevice: mocks.openDevice, open: mocks.openPanel }),
  },
}));

const model = (devices: ReadonlyArray<DeviceSummary>, hint: string | null = null) =>
  ({
    devices: devices.map((device) => ({ device, hostLabel: "Studio Mac" })),
    openKeys: [],
    hint,
  }) satisfies RunOnDeviceCardModel;

let root: Root;
let container: HTMLDivElement;
const show = (card: RunOnDeviceCardModel) =>
  act(async () => root.render(<RunOnDeviceCard threadRef={threadRef} model={card} />));
const button = (name: string) =>
  container.querySelector<HTMLButtonElement>(`li button[aria-label$=" ${name}"]`);
const click = (target: HTMLButtonElement | null) =>
  act(async () => {
    target!.click();
  });
const deferred = () => {
  let settle!: (result: CommandResult) => void;
  const promise = new Promise<CommandResult>((resolve) => (settle = resolve));
  return { promise, settle };
};

beforeEach(() => {
  vi.resetAllMocks();
  currentState = readyState;
  currentLoaded = true;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("RunOnDeviceCard", () => {
  it("opens a device with the Device panel's call and shows it in the panel", async () => {
    const pick = deferred();
    mocks.open.mockReturnValue(pick.promise);
    await show(model([iphone, pixel]));
    expect(container.textContent).toContain("Run on device");
    expect(container.textContent).toContain("Simulator · iOS 26.0 · Studio Mac");
    expect(button("iPhone 17 Pro")?.getAttribute("aria-label")).toBe("Start iPhone 17 Pro");
    expect(button("iPhone 17 Pro")?.textContent).toBe("Start");
    expect(button("Pixel 9")?.getAttribute("aria-label")).toBe("Show Pixel 9");
    expect(button("Pixel 9")?.textContent).toBe("Show");

    await click(button("iPhone 17 Pro"));
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        hostId: "local",
        deviceId: "IPHONE-UDID",
        platform: "ios",
      },
    });
    expect(button("iPhone 17 Pro")?.getAttribute("aria-busy")).toBe("true");
    expect(button("iPhone 17 Pro")?.getAttribute("aria-label")).toBe("Opening iPhone 17 Pro");
    expect(button("iPhone 17 Pro")?.textContent).toContain("Opening…");
    expect(button("Pixel 9")?.disabled).toBe(true);
    expect(mocks.openDevice).not.toHaveBeenCalled();

    await act(async () =>
      pick.settle({ _tag: "Success", value: { hostId: "local", deviceId: "IPHONE-UDID" } }),
    );
    expect(mocks.openDevice).toHaveBeenCalledExactlyOnceWith(threadRef, {
      hostId: "local",
      deviceId: "IPHONE-UDID",
      platform: "ios",
      name: "iPhone 17 Pro",
    });
    expect(button("iPhone 17 Pro")?.disabled).toBe(false);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("shows a plain error when opening fails and keeps the panel closed", async () => {
    mocks.open.mockResolvedValue({ _tag: "Failure", cause: new Error("boom") });
    await show(model([iphone]));
    await click(button("iPhone 17 Pro"));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Device failed to boot.");
    expect(mocks.openDevice).not.toHaveBeenCalled();
    expect(button("iPhone 17 Pro")?.disabled).toBe(false);
  });

  it("focuses a device that is already open in this thread without opening it again", async () => {
    currentState = {
      ...readyState,
      sessions: [
        {
          threadId: threadRef.threadId,
          hostId: "local",
          deviceId: "emulator-5554",
          platform: "android",
          openedAt: "2026-11-12T10:00:00.000Z",
        },
      ],
    };
    await show(model([pixel]));
    expect(button("Pixel 9")?.textContent).toBe("Open");
    expect(button("Pixel 9")?.getAttribute("aria-label")).toBe("Open Pixel 9");
    await click(button("Pixel 9"));
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.openDevice).toHaveBeenCalledExactlyOnceWith(threadRef, {
      hostId: "local",
      deviceId: "emulator-5554",
      platform: "android",
      name: "Pixel 9",
    });
  });

  it("opens the Device panel's setup while device support is off", async () => {
    currentState = { ...readyState, hostStatus: "disabled" };
    await show(model([iphone]));
    await click(button("iPhone 17 Pro"));
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.openPanel).toHaveBeenCalledExactlyOnceWith(threadRef, "device");
  });

  it("opens the Device panel instead of the device while the device state is still loading", async () => {
    currentLoaded = false;
    await show(model([iphone]));
    await click(button("iPhone 17 Pro"));
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.openDevice).not.toHaveBeenCalled();
    expect(mocks.openPanel).toHaveBeenCalledExactlyOnceWith(threadRef, "device");
  });

  it("lists six devices and points to the Device panel for the rest", async () => {
    const many = Array.from({ length: 8 }, (_, index) => ({
      ...iphone,
      id: `SIM-${index}`,
      name: `iPhone ${index}`,
    }));
    await show(model(many));
    expect(container.querySelectorAll("li button")).toHaveLength(6);
    expect(container.textContent).toContain("and 2 more in the Device panel");
  });

  it("shows the hint that only another Mac can run iOS Simulators", async () => {
    await show(
      model([], "This machine cannot run iOS Simulators. Connected Mac that can: Studio Mac."),
    );
    expect(container.textContent).toContain("Connected Mac that can: Studio Mac.");
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });
});
