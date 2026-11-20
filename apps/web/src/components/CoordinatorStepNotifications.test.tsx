import type { CoordinatorMessageView } from "@specweave-studio/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  list: [] as unknown[],
  owner: true,
  connected: true,
  delivery: "post" as "post" | "badge" | "skip",
  focused: false,
  settings: {
    notificationMode: "desktop",
    inAppNotificationsEnabled: true,
    inputNeededAlertsEnabled: false,
  } as Record<string, unknown>,
  shown: [] as boolean[],
  toasts: [] as unknown[],
  sounds: 0,
}));

vi.mock("../studio/useCoordinatorMessages", () => ({
  useCoordinatorMessages: () => ({ list: state.list }),
}));
vi.mock("../state/entities", () => ({
  useProjects: () => [
    {
      id: "p-1",
      environmentId: "env-m4",
      title: "Umbrella",
      workspaceSettings: { logicalProject: { id: "lp" }, coordinatorThreadId: "coord-m4" },
    },
  ],
}));
vi.mock("../state/environments", () => ({
  useEnvironmentIds: () => ["env-m4", "env-m5"],
  usePrimaryEnvironmentId: () => "env-m4",
  useUnreachableEnvironmentIds: () => [],
}));
vi.mock("../hooks/useOpenChat", () => ({ useOpenChat: () => vi.fn() }));
vi.mock("../hooks/useSettings", () => ({ getClientSettings: () => state.settings }));
vi.mock("../i18n", () => ({
  useTx: () => (text: string, values: Record<string, string>) =>
    text.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? ""),
}));
vi.mock("../lib/backgroundActivityReporter", () => ({ backgroundActivityClientId: () => "c-1" }));
vi.mock("../notificationConnection", () => ({ notificationsConnected: () => state.connected }));
vi.mock("../notificationHistory", () => ({
  deliverNotificationOnce: async (_key: string, deliver: () => Promise<boolean>) => {
    await deliver();
  },
}));
vi.mock("../notificationTarget", () => ({
  readNotificationTarget: async () => null,
  decideNotificationDelivery: () => state.delivery,
  ownerMachineReachable: () => true,
}));
vi.mock("../studio/machineIdentity", () => ({
  useMachineIdentities: () => (environmentId: string) => ({ name: environmentId.slice(4) }),
}));
vi.mock("../threadNotifications", () => ({
  hasDesktopNotifications: (mode: string) => mode === "desktop",
  hasNotificationSound: () => true,
  isNotificationOwner: () => state.owner,
  playNotificationSound: () => {
    state.sounds += 1;
    return Promise.resolve();
  },
}));
vi.mock("./ui/toast", () => ({
  toastManager: {
    add: (toast: unknown) => {
      state.toasts.push(toast);
      return "toast-1";
    },
    close: () => undefined,
  },
}));

import { CoordinatorStepNotifications } from "./CoordinatorStepNotifications";

function step(over: Partial<CoordinatorMessageView> = {}): CoordinatorMessageView {
  return {
    id: `cm-${"a".repeat(40)}`,
    externalId: "ext-1",
    direction: "incoming",
    peerEnvironmentId: "env-m5",
    kind: "request",
    subject: "Sign in",
    text: "",
    userStep: { text: "sign in to GitHub", environmentId: "env-m5" },
    refs: [],
    count: 1,
    state: "delivered",
    receivedAt: Date.now(),
    updatedAt: Date.now(),
    ...over,
  } as CoordinatorMessageView;
}

let renderer: ReactTestRenderer | undefined;
async function render() {
  await act(async () => {
    renderer = create(<CoordinatorStepNotifications environmentId={"env-m4" as never} />);
  });
}
async function rerender() {
  await act(async () => {
    renderer!.update(<CoordinatorStepNotifications environmentId={"env-m4" as never} />);
  });
}

beforeEach(() => {
  Object.assign(state, {
    list: [],
    owner: true,
    connected: true,
    delivery: "post",
    focused: false,
    shown: [],
    toasts: [],
    sounds: 0,
  });
  state.settings = {
    notificationMode: "desktop",
    inAppNotificationsEnabled: true,
    inputNeededAlertsEnabled: false,
  };
  vi.stubGlobal("document", {
    visibilityState: "visible",
    hasFocus: () => state.focused,
  });
  vi.stubGlobal("window", {
    focus: () => undefined,
    desktopBridge: {
      showThreadNotification: async () => {
        const result = state.shown.shift() ?? true;
        return result;
      },
    },
  });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("CoordinatorStepNotifications (1427 AC-19)", () => {
  it("retries a step whose delivery failed on the next read, then raises it once", async () => {
    const bridge = vi.fn(async () => false);
    (globalThis.window as { desktopBridge: unknown }).desktopBridge = {
      showThreadNotification: bridge,
    };
    state.list = [step()];
    await render();
    expect(bridge).toHaveBeenCalledTimes(1);
    bridge.mockResolvedValue(true);
    state.list = [step()];
    await rerender();
    expect(bridge).toHaveBeenCalledTimes(2);
    state.list = [step()];
    await rerender();
    expect(bridge).toHaveBeenCalledTimes(2);
  });

  it("retries a step held back while the window was not the notification owner", async () => {
    const bridge = vi.fn(async () => true);
    (globalThis.window as { desktopBridge: unknown }).desktopBridge = {
      showThreadNotification: bridge,
    };
    state.owner = false;
    state.list = [step()];
    await render();
    expect(bridge).not.toHaveBeenCalled();
    state.owner = true;
    state.list = [step()];
    await rerender();
    expect(bridge).toHaveBeenCalledTimes(1);
  });

  it("shows a toast naming the machine in a focused window", async () => {
    state.focused = true;
    state.list = [step()];
    await render();
    expect(state.toasts).toHaveLength(1);
    expect(JSON.stringify(state.toasts[0])).toContain("m5");
    expect(state.sounds).toBe(1);
  });

  it("toasts without a sound in a focused window the serving machine did not pick", async () => {
    state.focused = true;
    state.delivery = "skip";
    state.list = [step()];
    await render();
    expect(state.toasts).toHaveLength(1);
    expect(state.sounds).toBe(0);
  });

  it("toasts in a focused window under default settings", async () => {
    state.focused = true;
    state.settings = {
      notificationMode: "off",
      inAppNotificationsEnabled: false,
      inputNeededAlertsEnabled: true,
    };
    state.list = [step()];
    await render();
    expect(state.toasts).toHaveLength(1);
  });

  it("treats toasts turned off in a focused window as handled, never retried", async () => {
    const bridge = vi.fn(async () => true);
    (globalThis.window as { desktopBridge: unknown }).desktopBridge = {
      showThreadNotification: bridge,
    };
    state.focused = true;
    state.settings = {
      notificationMode: "sound",
      inAppNotificationsEnabled: false,
      inputNeededAlertsEnabled: false,
    };
    state.list = [step()];
    await render();
    expect(state.sounds).toBe(1);
    state.focused = false;
    state.list = [step()];
    await rerender();
    expect(state.toasts).toHaveLength(0);
    expect(bridge).not.toHaveBeenCalled();
  });

  it("lets 'Alert when input is needed' raise a step when desktop alerts are off", async () => {
    const bridge = vi.fn(async () => true);
    (globalThis.window as { desktopBridge: unknown }).desktopBridge = {
      showThreadNotification: bridge,
    };
    state.settings = { notificationMode: "sound", inputNeededAlertsEnabled: true };
    state.list = [step()];
    await render();
    expect(bridge).toHaveBeenCalledTimes(1);
  });

  it("raises nothing for a message without a step", async () => {
    const bridge = vi.fn(async () => true);
    (globalThis.window as { desktopBridge: unknown }).desktopBridge = {
      showThreadNotification: bridge,
    };
    state.list = [step({ userStep: undefined })];
    await render();
    expect(bridge).not.toHaveBeenCalled();
    expect(state.toasts).toHaveLength(0);
  });
});
