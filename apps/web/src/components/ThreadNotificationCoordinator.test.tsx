import type { ClientSettings } from "@specweave-studio/contracts/settings";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  mode: "off" as ClientSettings["notificationMode"],
  inApp: true,
  inputAlerts: false,
  title: "Fix the login form",
  active: { environmentId: "env-1", threadId: "other-thread" },
  focused: true,
  visible: "visible",
  live: true,
  completedAt: null as string | null,
  archivedAt: null as string | null,
  input: false,
  approval: false,
  sessionError: false,
  turnError: false,
  limited: false,
  subagent: false,
  background: [] as Array<{ taskId: string; kind: "command" | "monitor" }>,
  add: vi.fn(
    (_toast: { title: string; description: string; actionProps: { onClick: () => void } }) =>
      "toast-1",
  ),
  close: vi.fn(),
  navigate: vi.fn(),
  groups: [] as unknown[],
  paneThread: null as string | null,
  sound: vi.fn(),
  notification: vi.fn(function (_title: string, options: NotificationOptions) {
    return Object.assign(new EventTarget(), { tag: options.tag, close: vi.fn() });
  }),
}));

const SHELL_NOW = DateTime.makeUnsafe("2026-09-13T09:00:00.000Z");

function mockThreadShell() {
  return {
    id: "thread-1",
    projectId: "project-1",
    title: state.title,
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: "thread-1",
      parentThreadId: state.subagent ? "parent" : null,
      relationshipToParent: state.subagent ? "subagent" : null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: "run-1",
    activeRunId: null,
    status: state.completedAt
      ? "completed"
      : state.sessionError || state.turnError || state.limited
        ? "failed"
        : "running",
    lastErrorClass: state.limited ? "usage_limit" : null,
    pendingRuntimeRequest: state.input
      ? { id: "request-1", kind: "user_input", createdAt: SHELL_NOW }
      : state.approval
        ? { id: "request-1", kind: "command", createdAt: SHELL_NOW }
        : null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: state.background,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: SHELL_NOW,
    updatedAt: SHELL_NOW,
    latestRunRequestedAt: SHELL_NOW,
    latestRunStartedAt: SHELL_NOW,
    latestRunCompletedAt: state.completedAt ? DateTime.makeUnsafe(state.completedAt) : undefined,
    archivedAt: state.archivedAt ? DateTime.makeUnsafe(state.archivedAt) : null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({
    status: state.live ? "live" : "disconnected",
    snapshot: Option.some({ threads: [mockThreadShell()] }),
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => state.navigate,
  useParams: () => state.active,
  useSearch: (options: { select: (search: Record<string, unknown>) => unknown }) =>
    options.select(state.paneThread === null ? {} : { thread: state.paneThread }),
}));
vi.mock("./settings/useSettingsProjectGroups", () => ({
  useSettingsProjectGroups: () => state.groups,
}));
vi.mock("../state/entities", () => ({ readThreadShell: () => null }));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: (
    select: (
      settings: Pick<
        ClientSettings,
        "notificationMode" | "inAppNotificationsEnabled" | "inputNeededAlertsEnabled"
      >,
    ) => unknown,
  ) =>
    select({
      notificationMode: state.mode,
      inAppNotificationsEnabled: state.inApp,
      inputNeededAlertsEnabled: state.inputAlerts,
    }),
  getClientSettings: () => ({ notificationMode: state.mode }),
}));
vi.mock("../state/environments", () => ({
  useEnvironmentIds: () => ["env-1"],
}));
vi.mock("../state/shell", () => ({
  environmentShell: { stateValueAtom: vi.fn() },
}));
vi.mock("../threadNotifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../threadNotifications")>()),
  playNotificationSound: state.sound,
  setNotificationBadge: vi.fn(),
}));
vi.mock("./ui/toast", () => ({
  toastManager: { add: state.add, close: state.close },
}));

import { __resetNotificationOwnerForTests } from "../threadNotifications";
import { ThreadNotificationCoordinator } from "./ThreadNotificationCoordinator";

let renderer: ReactTestRenderer | undefined;

async function render() {
  await act(() => {
    if (renderer) renderer.update(<ThreadNotificationCoordinator />);
    else renderer = create(<ThreadNotificationCoordinator />);
  });
}

async function complete() {
  state.completedAt = "2026-09-13T10:00:00.000Z";
  await render();
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetNotificationOwnerForTests();
  Object.assign(state, {
    mode: "off",
    inApp: true,
    inputAlerts: false,
    title: "Fix the login form",
    active: { environmentId: "env-1", threadId: "other-thread" },
    focused: true,
    visible: "visible",
    live: true,
    completedAt: null,
    archivedAt: null,
    input: false,
    approval: false,
    sessionError: false,
    turnError: false,
    limited: false,
    subagent: false,
    background: [],
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", {
    get visibilityState() {
      return state.visible;
    },
    hasFocus: () => state.focused,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("Notification", Object.assign(state.notification, { permission: "granted" }));
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("thread notifications", () => {
  it.each([true, false])("keeps subagents silent with focus=%s", async (focused) => {
    state.subagent = true;
    state.focused = focused;
    state.mode = "notifications-and-sound";
    await render();
    await complete();
    state.input = true;
    await render();
    expect(state.sound).not.toHaveBeenCalled();
    expect(state.add).not.toHaveBeenCalled();
    expect(state.notification).not.toHaveBeenCalled();
  });

  it("alerts once with system alerts off and opens the completed thread", async () => {
    await render();
    await complete();
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
    const toast = state.add.mock.calls[0]?.[0];
    expect(toast?.title).toBe("Thread completed");
    expect(toast?.description).toBe("Fix the login form");
    toast?.actionProps.onClick();
    expect(state.close).toHaveBeenCalledWith("toast-1");
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "env-1", threadId: "thread-1" },
    });
    expect(state.notification).not.toHaveBeenCalled();
  });

  it("opens a project workspace's thread in that project's right panel", async () => {
    state.groups = [
      {
        projectKey: "atlas",
        memberProjects: [
          {
            environmentId: "env-1",
            id: "project-1",
            workspaceSettings: { coordinatorThreadId: "project-coordinator:project-1" },
          },
        ],
      },
    ];
    try {
      await render();
      await complete();
      await render();
      state.add.mock.calls[0]?.[0]?.actionProps.onClick();
      expect(state.navigate).toHaveBeenCalledWith({
        to: "/projects/$projectKey",
        params: { projectKey: "atlas" },
        search: { thread: "thread-1" },
      });
    } finally {
      state.groups = [];
    }
  });

  it("stays quiet in the app about the thread open in a project's right panel", async () => {
    state.paneThread = "thread-1";
    try {
      await render();
      await complete();
      await render();
      expect(state.add).not.toHaveBeenCalled();
    } finally {
      state.paneThread = null;
    }
  });

  it.each(["active", "blurred", "hidden", "archived", "disabled"])(
    "does not show a completion toast for %s threads",
    async (condition) => {
      await render();
      if (condition === "active") state.active.threadId = "thread-1";
      if (condition === "blurred") state.focused = false;
      if (condition === "hidden") state.visible = "hidden";
      if (condition === "archived") state.archivedAt = "2026-09-13T09:00:00.000Z";
      if (condition === "disabled") state.inApp = false;
      await complete();
      expect(state.add).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["input", "Input needed", "Waiting for your answer"],
    ["approval", "Approval needed", "Waiting for your approval"],
    ["sessionError", "Thread failed", "Stopped with an error"],
    ["turnError", "Thread failed", "Stopped with an error"],
    ["limited", "Usage limit reached", "Usage limit reached"],
  ] as const)(
    "uses the same %s event for in-app and desktop alerts",
    async (event, title, body) => {
      state.mode = "notifications-and-sound";
      await render();
      state[event] = true;
      await render();
      await render();
      expect(state.add).toHaveBeenCalledTimes(1);
      expect(state.add).toHaveBeenLastCalledWith(expect.objectContaining({ title }));
      expect(state.sound).toHaveBeenCalledWith("input", expect.any(Function));
      expect(state.notification).not.toHaveBeenCalled();

      state[event] = false;
      await render();
      state.focused = false;
      state[event] = true;
      await render();
      await render();
      expect(state.add).toHaveBeenCalledTimes(1);
      expect(state.notification).toHaveBeenCalledTimes(1);
      expect(state.notification).toHaveBeenCalledWith("Fix the login form", {
        body,
        tag: "env-1:thread-1",
        silent: true,
      });
    },
  );

  it("alerts when only a dev server is left running, not while a monitor can wake the agent", async () => {
    await render();
    state.background = [{ taskId: "watch", kind: "monitor" }];
    await complete();
    expect(state.add).not.toHaveBeenCalled();
    state.background = [{ taskId: "dev", kind: "command" }];
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.add).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Thread completed" }),
    );
  });

  it("keeps background desktop alerts when in-app notifications are disabled", async () => {
    state.focused = false;
    state.inApp = false;
    state.mode = "notifications";
    await render();
    await complete();
    expect(state.add).not.toHaveBeenCalled();
    expect(state.notification).toHaveBeenCalledTimes(1);
    state.inApp = true;
    await render();
    expect(state.add).not.toHaveBeenCalled();
  });

  it("does not replay a completion when opting in from all alerts off", async () => {
    state.inApp = false;
    await render();
    await complete();
    state.inApp = true;
    await render();
    expect(state.add).not.toHaveBeenCalled();
  });

  it("compares the environment as well as the thread", async () => {
    state.active = { environmentId: "env-2", threadId: "thread-1" };
    await render();
    await complete();
    expect(state.add).toHaveBeenCalledTimes(1);
  });

  it("does not replay completed threads on first load or reconnect", async () => {
    await complete();
    state.live = false;
    await render();
    state.live = true;
    await render();
    expect(state.add).not.toHaveBeenCalled();
  });

  it("keeps sound but replaces the system popup when showing a toast", async () => {
    state.mode = "notifications-and-sound";
    await render();
    await complete();
    expect(state.sound).toHaveBeenCalledWith("completion", expect.any(Function));
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.notification).not.toHaveBeenCalled();
  });

  it("keeps system alerts when the app is in the background", async () => {
    state.mode = "notifications";
    state.focused = false;
    await render();
    await complete();
    expect(state.add).not.toHaveBeenCalled();
    expect(state.notification).toHaveBeenCalledWith("Fix the login form", {
      body: "Finished",
      tag: "env-1:thread-1",
      silent: true,
    });
  });
});

describe("alerts when a thread needs you", () => {
  let openListener: ((target: { environmentId: string; threadId: string }) => void) | undefined;
  const showThreadNotification = vi.fn(async (_input: unknown) => true);
  const closeThreadNotification = vi.fn(async (_tag: string) => undefined);

  function useDesktopShell() {
    openListener = undefined;
    Object.assign(window, {
      desktopBridge: {
        showThreadNotification,
        closeThreadNotification,
        onThreadNotificationOpen: (
          listener: (target: { environmentId: string; threadId: string }) => void,
        ) => {
          openListener = listener;
          return () => {
            openListener = undefined;
          };
        },
      },
    });
  }

  beforeEach(() => {
    state.inputAlerts = true;
    state.inApp = false;
    state.mode = "off";
  });

  it.each([
    ["input", "Waiting for your answer"],
    ["approval", "Waiting for your approval"],
  ] as const)(
    "posts a native %s notification in the background with thread notifications off",
    async (event, body) => {
      useDesktopShell();
      state.focused = false;
      await render();
      state[event] = true;
      await render();
      expect(showThreadNotification).toHaveBeenCalledTimes(1);
      expect(showThreadNotification).toHaveBeenCalledWith({
        tag: "env-1:thread-1",
        title: "Fix the login form",
        body,
        target: { environmentId: "env-1", threadId: "thread-1" },
      });
      expect(state.notification).not.toHaveBeenCalled();
      expect(state.sound).not.toHaveBeenCalled();
      expect(state.add).not.toHaveBeenCalled();
    },
  );

  it("opens the clicked notification's thread", async () => {
    useDesktopShell();
    await render();
    expect(openListener).toBeDefined();
    openListener?.({ environmentId: "env-1", threadId: "thread-1" });
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "env-1", threadId: "thread-1" },
    });
  });

  it("withdraws the native notification once the user is back in the app", async () => {
    useDesktopShell();
    state.focused = false;
    await render();
    state.input = true;
    await render();
    window.dispatchEvent(new Event("focus"));
    expect(closeThreadNotification).toHaveBeenCalledWith("env-1:thread-1");
  });

  it("shows a toast for another thread while the app has focus", async () => {
    useDesktopShell();
    state.inApp = true;
    await render();
    state.input = true;
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.add).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Input needed" }));
    expect(showThreadNotification).not.toHaveBeenCalled();
  });

  it("leaves the app quiet while focused when in-app notifications are off", async () => {
    useDesktopShell();
    await render();
    state.input = true;
    await render();
    expect(state.add).not.toHaveBeenCalled();
    expect(showThreadNotification).not.toHaveBeenCalled();
  });

  it("shortens a long thread name to fit the system notification", async () => {
    useDesktopShell();
    state.focused = false;
    state.title = "x".repeat(400);
    await render();
    state.input = true;
    await render();
    const posted = showThreadNotification.mock.calls[0]?.[0] as { title: string } | undefined;
    const title = posted?.title ?? "";
    expect(title).toHaveLength(256);
    expect(title.endsWith("…")).toBe(true);
  });

  it.each(["completion", "failure", "turned off"])(
    "stays quiet for %s with thread notifications off",
    async (condition) => {
      useDesktopShell();
      state.focused = false;
      if (condition === "turned off") state.inputAlerts = false;
      await render();
      if (condition === "completion") await complete();
      else if (condition === "failure") state.sessionError = true;
      else state.input = true;
      await render();
      expect(showThreadNotification).not.toHaveBeenCalled();
      expect(state.add).not.toHaveBeenCalled();
    },
  );

  it("uses the browser notification when there is no desktop shell", async () => {
    state.focused = false;
    await render();
    state.approval = true;
    await render();
    expect(state.notification).toHaveBeenCalledWith("Fix the login form", {
      body: "Waiting for your approval",
      tag: "env-1:thread-1",
      silent: true,
    });
  });
});

describe("one alert owner across desktop windows", () => {
  let changeOwner: (owner: boolean) => void = () => undefined;

  function openWindow(owner: boolean) {
    Object.assign(window, {
      desktopBridge: {
        getNotificationOwner: () => owner,
        onNotificationOwnerChange: (listener: (owner: boolean) => void) => {
          changeOwner = listener;
          return () => undefined;
        },
      },
    });
  }

  function expectSilence() {
    expect(state.sound).not.toHaveBeenCalled();
    expect(state.add).not.toHaveBeenCalled();
    expect(state.notification).not.toHaveBeenCalled();
  }

  it.each([true, false])(
    "raises nothing in a window that is not the owner (focus=%s)",
    async (focused) => {
      openWindow(false);
      state.mode = "notifications-and-sound";
      state.focused = focused;
      await render();
      await complete();
      state.input = true;
      await render();
      expectSilence();
    },
  );

  it("does not replay earlier events when the window becomes the owner", async () => {
    openWindow(false);
    state.mode = "notifications-and-sound";
    await render();
    await complete();
    changeOwner(true);
    await render();
    await render();
    expectSilence();
  });

  it("announces new events once it is the owner and stops when another window takes over", async () => {
    openWindow(false);
    state.mode = "notifications-and-sound";
    await render();
    changeOwner(true);
    state.input = true;
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.add).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Input needed" }));
    expect(state.sound).toHaveBeenCalledTimes(1);

    changeOwner(false);
    state.input = false;
    await render();
    await complete();
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.sound).toHaveBeenCalledTimes(1);
    expect(state.notification).not.toHaveBeenCalled();
  });

  it("asks the shell for alerts only once it knows what is new", async () => {
    const asked = vi.fn(() => true);
    Object.assign(window, {
      desktopBridge: {
        getNotificationOwner: asked,
        onNotificationOwnerChange: () => () => undefined,
      },
    });
    // No live host yet: a window in this state would miss events, so it
    // must not take alerts away from one that is ready.
    state.live = false;
    await render();
    expect(asked).not.toHaveBeenCalled();

    state.live = true;
    await render();
    expect(asked).toHaveBeenCalledTimes(1);
    await complete();
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it("keeps announcing in the window the shell names as owner", async () => {
    openWindow(true);
    await render();
    await complete();
    expect(state.add).toHaveBeenCalledTimes(1);
  });
});
