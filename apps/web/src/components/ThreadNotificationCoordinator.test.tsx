import { __resetNotificationEpisodesForTests } from "../notificationEpisodes";
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
  runId: "run-1",
  requestId: "request-1",
  requestTime: "2026-09-13T09:00:00.000Z",
  revision: "2026-09-13T09:00:00.000Z",
  signin: false,
  plan: false,
  held: 0,
  idle: false,
  settled: false,
  deleted: false,
  present: true,

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
  level: undefined as string | undefined,
  creationSource: "web" as "web" | "provider" | "mcp",
  createdBy: "user" as "user" | "agent",
  background: [] as Array<{ taskId: string; kind: "command" | "monitor" }>,
  add: vi.fn(
    (_toast: { title: string; description: string; actionProps: { onClick: () => void } }) =>
      "toast-1",
  ),
  close: vi.fn(),
  navigate: vi.fn(),
  groups: [] as unknown[],
  paneThread: null as string | null,
  paneEnvironment: null as string | null,
  checkout: null as string | null,
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
    createdBy: state.createdBy,
    creationSource: state.creationSource,
    latestRunId: state.runId,
    activeRunId: null,
    status: state.idle
      ? "idle"
      : state.completedAt
        ? "completed"
        : state.sessionError || state.turnError || state.limited
          ? "failed"
          : "running",
    lastErrorClass: state.limited ? "usage_limit" : null,
    pendingRuntimeRequest: state.input
      ? {
          id: state.requestId,
          kind: "user_input",
          createdAt: DateTime.makeUnsafe(state.requestTime),
        }
      : state.approval
        ? {
            id: state.requestId,
            kind: "command",
            createdAt: DateTime.makeUnsafe(state.requestTime),
          }
        : state.signin
          ? {
              id: state.requestId,
              kind: "auth_refresh",
              createdAt: DateTime.makeUnsafe(state.requestTime),
            }
          : null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: state.plan,
    heldQueuedCount: state.held,
    pendingBackgroundTasks: state.background,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: SHELL_NOW,
    updatedAt: DateTime.makeUnsafe(state.revision),
    latestRunRequestedAt: SHELL_NOW,
    latestRunStartedAt: SHELL_NOW,
    latestRunCompletedAt: state.completedAt ? DateTime.makeUnsafe(state.completedAt) : undefined,
    archivedAt: state.archivedAt ? DateTime.makeUnsafe(state.archivedAt) : null,
    settledOverride: state.settled ? "settled" : null,
    settledAt: state.settled ? SHELL_NOW : null,
    lastVisitedAt: null,
    deletedAt: state.deleted ? SHELL_NOW : null,
  };
}

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({
    status: state.live ? "live" : "disconnected",
    snapshot: Option.some({ threads: state.present ? [mockThreadShell()] : [] }),
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => state.navigate,
  useParams: () => state.active,
  useSearch: (options: { select: (search: Record<string, unknown>) => unknown }) =>
    options.select({
      thread: state.paneThread,
      threadEnvironment: state.paneEnvironment,
      checkout: state.checkout,
    }),
}));
vi.mock("./settings/useSettingsProjectGroups", () => ({
  useSettingsProjectGroups: () => state.groups,
}));
vi.mock("../state/entities", () => ({
  useProjects: () => [
    {
      environmentId: "env-1",
      id: "project-1",
      workspaceSettings: state.level === undefined ? undefined : { notifications: state.level },
    },
  ],
  readThreadShell: ({ environmentId, threadId }: { environmentId: string; threadId: string }) =>
    environmentId === "env-1" && threadId === "thread-1"
      ? { ...mockThreadShell(), environmentId }
      : null,
}));
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
import { setNotificationsConnected } from "../notificationConnection";
import { __resetNotificationHistoryForTests } from "../notificationHistory";
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
  __resetNotificationHistoryForTests();
  __resetNotificationEpisodesForTests();
  Object.assign(state, {
    paneThread: null,
    paneEnvironment: null,
    checkout: null,
    groups: [],
    mode: "off",
    inApp: true,
    inputAlerts: false,
    title: "Fix the login form",
    runId: "run-1",
    requestId: "request-1",
    requestTime: "2026-09-13T09:00:00.000Z",
    revision: "2026-09-13T09:00:00.000Z",
    signin: false,
    plan: false,
    held: 0,
    idle: false,
    settled: false,
    deleted: false,
    present: true,
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
    level: undefined,
    creationSource: "web",
    createdBy: "user",
    background: [],
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", new EventTarget());
  setNotificationsConnected(true);
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
  it.each([true, false])(
    "keeps provider-native subagents silent with focus=%s",
    async (focused) => {
      state.subagent = true;
      state.creationSource = "provider";
      state.focused = focused;
      state.mode = "notifications-and-sound";
      await render();
      await complete();
      state.input = true;
      await render();
      expect(state.sound).not.toHaveBeenCalled();
      expect(state.add).not.toHaveBeenCalled();
      expect(state.notification).not.toHaveBeenCalled();
    },
  );

  it("notifies when a delegated worker finishes in a project set to all new messages", async () => {
    state.subagent = true;
    state.creationSource = "mcp";
    state.mode = "notifications-and-sound";
    state.level = "all";
    await render();
    await complete();
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.add.mock.calls[0]?.[0]?.title).toBe("Thread completed");
    expect(state.add.mock.calls[0]?.[0]?.description).toBe("Fix the login form");
  });

  it("by default keeps a delegated worker's news quiet but alerts when it needs the person", async () => {
    state.subagent = true;
    state.creationSource = "mcp";
    state.mode = "notifications-and-sound";
    await render();
    await complete();
    expect(state.sound).not.toHaveBeenCalled();
    expect(state.add).not.toHaveBeenCalled();
    state.approval = true;
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.add.mock.calls[0]?.[0]?.title).toBe("Approval needed");
  });

  it("alerts on a main thread's completion only from the coordinator level up", async () => {
    for (const [level, alerts] of [
      ["coordinator", 1],
      ["requests", 0],
      ["none", 0],
    ] as const) {
      vi.clearAllMocks();
      __resetNotificationHistoryForTests();
      state.level = level;
      state.completedAt = null;
      state.runId = `run-${level}`;
      await render();
      await complete();
      expect(state.add, level).toHaveBeenCalledTimes(alerts);
    }
  });

  it("silences even requests in a project set to nothing, and alerts again once changed", async () => {
    state.level = "none";
    state.mode = "notifications-and-sound";
    await render();
    state.input = true;
    await render();
    expect(state.sound).not.toHaveBeenCalled();
    expect(state.add).not.toHaveBeenCalled();
    state.level = "requests";
    state.requestId = "request-2";
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.add.mock.calls[0]?.[0]?.title).toBe("Input needed");
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

  it.each(["agent", "user"] as const)(
    "opens a completed %s thread in its owned surface",
    async (createdBy) => {
      state.createdBy = createdBy;
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
        expect(state.navigate).toHaveBeenCalledWith(
          createdBy === "agent"
            ? {
                to: "/projects/$projectKey",
                params: { projectKey: "atlas" },
                search: { thread: "thread-1", checkout: "env-1:project-1" },
              }
            : {
                to: "/$environmentId/$threadId",
                params: { environmentId: "env-1", threadId: "thread-1" },
              },
        );
      } finally {
        state.groups = [];
      }
    },
  );

  it.each([
    ["explicit same environment", "env-1", null, false],
    ["explicit other environment", "env-other", null, true],
    ["same checkout", null, "env-1:project-1", false],
    ["other checkout", null, "env-other:project-other", true],
    ["explicit environment wins over checkout", "env-other", "env-1:project-1", true],
    ["unknown scope", null, null, true],
  ] as const)("scopes input alerts to %s", async (_name, environment, checkout, expected) => {
    state.active = { projectKey: "atlas" } as unknown as typeof state.active;
    state.paneThread = "thread-1";
    state.paneEnvironment = environment;
    state.checkout = checkout;
    state.groups = [
      {
        projectKey: "atlas",
        memberProjects: [
          { environmentId: "env-1", id: "project-1" },
          { environmentId: "env-other", id: "project-other" },
        ],
      },
    ];
    state.input = true;
    await render();
    expect(state.add).toHaveBeenCalledTimes(expected ? 1 : 0);
  });

  it("does not suppress a checkout belonging to another project", async () => {
    state.active = { projectKey: "different" } as unknown as typeof state.active;
    state.paneThread = "thread-1";
    state.checkout = "env-1:project-1";
    state.groups = [
      { projectKey: "atlas", memberProjects: [{ environmentId: "env-1", id: "project-1" }] },
    ];
    state.input = true;
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
  });

  it.each(["env-1", "env-other"])("scopes full-page input alerts to %s", async (environmentId) => {
    state.active = { environmentId, threadId: "thread-1" };
    state.input = true;
    await render();
    expect(state.add).toHaveBeenCalledTimes(environmentId === "env-1" ? 0 : 1);
  });

  it("stays quiet in the app about the thread open in a project's right panel", async () => {
    state.paneThread = "thread-1";
    state.paneEnvironment = "env-1";
    state.active = { projectKey: "atlas" } as unknown as typeof state.active;
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
      state.runId = "run-2";
      state.requestId = "request-2";
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

describe("a quiet run waiting on the person", () => {
  const minutes = (count: number) => count * 60_000;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(DateTime.toEpochMillis(SHELL_NOW) + minutes(1));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function passTime(ms: number) {
    await act(async () => {
      vi.advanceTimersByTime(ms);
    });
  }

  const titles = () => state.add.mock.calls.map((call) => call[0]?.title);

  it("asks for the approval once and never calls the held run inactive", async () => {
    await render();
    state.approval = true;
    await render();
    await passTime(minutes(15 * 60));
    expect(titles()).toEqual(["Approval needed"]);
  });

  it("still flags the same quiet run once nothing is asked of the person", async () => {
    await render();
    await passTime(minutes(3 * 60));
    expect(titles()).toEqual(["No activity in thread"]);
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
        target: { environmentId: "env-1", threadId: "thread-1", projectId: "project-1" },
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

describe("notification connection lifecycle", () => {
  it("surfaces a pending request on first connection, without replay on remount", async () => {
    state.inputAlerts = true;
    state.input = true;
    state.focused = false;
    await render();
    expect(state.notification).toHaveBeenCalledTimes(1);
    await act(() => renderer?.unmount());
    renderer = undefined;
    await render();
    expect(state.notification).toHaveBeenCalledTimes(1);
  });
  it("delivers a request received during disconnection once on reconnect", async () => {
    state.inputAlerts = true;
    state.focused = false;
    await render();
    state.live = false;
    await render();
    state.input = true;
    state.live = true;
    await render();
    state.live = false;
    await render();
    state.live = true;
    await render();
    expect(state.notification).toHaveBeenCalledTimes(1);
  });
  it("disconnect overrides input alerts and closes outstanding system notifications", async () => {
    state.inputAlerts = true;
    state.focused = false;
    await render();
    state.input = true;
    await render();
    const posted = state.notification.mock.results[0]?.value;
    await act(() => setNotificationsConnected(false));
    expect(posted.close).toHaveBeenCalled();
    state.requestId = "request-2";
    await render();
    expect(state.notification).toHaveBeenCalledTimes(1);
  });
  it("a new request in the same run alerts again", async () => {
    state.inputAlerts = true;
    state.focused = false;
    await render();
    state.input = true;
    await render();
    state.requestId = "request-2";
    await render();
    expect(state.notification).toHaveBeenCalledTimes(2);
  });
  it("connect surfaces an already waiting request", async () => {
    state.inputAlerts = true;
    state.input = true;
    state.focused = false;
    setNotificationsConnected(false);
    await render();
    expect(state.notification).not.toHaveBeenCalled();
    await act(() => setNotificationsConnected(true));
    expect(state.notification).toHaveBeenCalledTimes(1);
  });
});

it.each(["env-1", "env-other"])(
  "uses committed destination after queued navigation to %s",
  async (destination) => {
    const callbacks: Array<() => Promise<void>> = [];
    vi.stubGlobal("navigator", {
      locks: {
        request: (_name: string, callback: () => Promise<void>) => {
          if (_name === "specwithcode:notification-episodes") return Promise.resolve(callback());
          callbacks.push(callback);
          return Promise.resolve();
        },
      },
    });
    state.active = {
      environmentId: destination === "env-1" ? "env-other" : "env-1",
      threadId: "thread-1",
    };
    state.input = true;
    await render();
    state.active = { environmentId: destination, threadId: "thread-1" };
    await render();
    await act(async () => {
      for (const callback of callbacks) await callback();
    });
    expect(state.add).toHaveBeenCalledTimes(destination === "env-1" ? 0 : 1);
  },
);

describe("queued notification eligibility", () => {
  it.each(["opt-out", "resolved", "offline", "unmounted"] as const)(
    "does not post a queued request after %s",
    async (change) => {
      const callbacks: Array<() => Promise<void>> = [];
      vi.stubGlobal("navigator", {
        locks: {
          request: (_name: string, callback: () => Promise<void>) => {
            if (_name === "specwithcode:notification-episodes") return Promise.resolve(callback());
            callbacks.push(callback);
            return Promise.resolve();
          },
        },
      });
      state.mode = "notifications";
      state.inApp = false;
      state.focused = false;
      await render();
      state.input = true;
      await render();
      if (change === "opt-out") state.mode = "off";
      if (change === "resolved") state.input = false;
      if (change === "offline") state.live = false;
      if (change === "unmounted") {
        await act(() => renderer?.unmount());
        renderer = undefined;
      } else await render();
      await act(async () => {
        for (const callback of callbacks) await callback();
      });
      expect(state.notification).not.toHaveBeenCalled();
    },
  );
});

it("retries a queued unresolved request after reconnect", async () => {
  const callbacks: Array<() => Promise<void>> = [];
  vi.stubGlobal("navigator", {
    locks: {
      request: (_name: string, callback: () => Promise<void>) => {
        if (_name === "specwithcode:notification-episodes") return Promise.resolve(callback());
        callbacks.push(callback);
        return Promise.resolve();
      },
    },
  });
  state.inputAlerts = true;
  state.focused = false;
  await render();
  state.input = true;
  await render();
  state.live = false;
  await render();
  await act(async () => {
    for (const callback of callbacks.splice(0)) await callback();
  });
  expect(state.notification).not.toHaveBeenCalled();
  state.live = true;
  await render();
  await act(async () => {
    for (const callback of callbacks.splice(0)) await callback();
  });
  expect(state.notification).toHaveBeenCalledTimes(1);
});

it("backs off native refusal while keeping explicit tests and new requests independent", async () => {
  const showThreadNotification = vi.fn().mockResolvedValue(false);
  Object.assign(window, { desktopBridge: { showThreadNotification } });
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  try {
    state.inputAlerts = true;
    state.focused = false;
    await render();
    state.input = true;
    await render();
    await render();
    await render();
    expect(showThreadNotification).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(1_030_001);
    await render();
    expect(showThreadNotification).toHaveBeenCalledTimes(2);
    state.requestId = "request-2";
    await render();
    expect(showThreadNotification).toHaveBeenCalledTimes(3);
  } finally {
    clock.mockRestore();
  }
});

describe("1040 action delivery contract", () => {
  it("delivers sign-in as a user action even with the ordinary mode off", async () => {
    state.signin = true;
    state.inputAlerts = true;
    state.focused = false;
    await render();
    expect(state.notification).toHaveBeenCalledWith(
      state.title,
      expect.objectContaining({ body: "Sign in to continue" }),
    );
  });

  it.each([
    "answer",
    "dismiss",
    "generation",
    "replace",
    "settled",
    "archive",
    "delete",
    "removed",
    "offline",
  ])("rejects the original queued action after %s", async (change) => {
    const callbacks: Array<() => Promise<void>> = [];
    vi.stubGlobal("navigator", {
      locks: {
        request: (_key: string, callback: () => Promise<void>) => {
          if (_key === "specwithcode:notification-episodes") return Promise.resolve(callback());
          callbacks.push(callback);
          return Promise.resolve();
        },
      },
    });
    state.input = true;
    await render();
    const original = callbacks.shift()!;
    if (change === "answer" || change === "dismiss") state.input = false;
    if (change === "generation") state.runId = "run-2";
    if (change === "replace") state.requestId = "request-2";
    if (change === "settled") state.settled = true;
    if (change === "archive") state.archivedAt = state.revision;
    if (change === "delete") state.deleted = true;
    if (change === "removed") state.present = false;
    if (change === "offline") state.live = false;
    await render();
    await act(async () => {
      await original();
    });
    expect(state.add).not.toHaveBeenCalled();
    expect(state.notification).not.toHaveBeenCalled();
  });

  it("only a newer timestamped request reopens a settled conversation", async () => {
    state.input = true;
    state.settled = true;
    await render();
    expect(state.add).not.toHaveBeenCalled();
    state.requestId = "request-new";
    state.requestTime = "2026-09-13T09:00:01.000Z";
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
  });

  it.each(["plan", "held"] as const)(
    "delivers %s only on a witnessed transition, not unrelated revisions",
    async (reason) => {
      state.idle = true;
      if (reason === "plan") state.plan = true;
      else state.held = 1;
      await render();
      expect(state.add).not.toHaveBeenCalled();
      state.revision = "2026-09-13T09:01:00.000Z";
      await render();
      expect(state.add).not.toHaveBeenCalled();
      state.plan = false;
      state.held = 0;
      await render();
      if (reason === "plan") state.plan = true;
      else state.held = 1;
      await render();
      expect(state.add).toHaveBeenCalledTimes(1);
      state.revision = "2026-09-13T09:02:00.000Z";
      await render();
      expect(state.add).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["resume", "discard", "active", "revision"])(
    "revalidates a held action before delivery after %s",
    async (change) => {
      state.idle = true;
      await render();
      const callbacks: Array<() => Promise<void>> = [];
      vi.stubGlobal("navigator", {
        locks: {
          request: (_key: string, callback: () => unknown) =>
            _key === "specwithcode:notification-episodes"
              ? Promise.resolve(callback())
              : new Promise((resolve) => {
                  callbacks.push(async () => {
                    resolve(await callback());
                  });
                }),
        },
      });
      state.held = 1;
      await render();
      const original = callbacks.shift()!;
      if (change === "resume" || change === "discard") state.held = 0;
      if (change === "active") state.idle = false;
      if (change === "revision") state.revision = "2026-09-13T09:03:00.000Z";
      await render();
      await act(async () => {
        await original();
      });
      expect(state.add).not.toHaveBeenCalled();
      if (change === "revision") {
        await act(async () => {
          for (const callback of callbacks) await callback();
        });
        expect(state.add).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("does not grant failures or usage limits the user-action override", async () => {
    state.inputAlerts = true;
    state.focused = false;
    state.inApp = false;
    await render();
    state.sessionError = true;
    await render();
    state.sessionError = false;
    state.limited = true;
    await render();
    expect(state.notification).not.toHaveBeenCalled();
  });

  it("delivers simultaneous actions independently", async () => {
    state.idle = true;
    await render();
    state.input = true;
    state.plan = true;
    await render();
    expect(state.add).toHaveBeenCalledTimes(2);
  });
});

it("deduplicates a witnessed plan transition across two notification clients", async () => {
  state.idle = true;
  await render();
  let second: ReactTestRenderer;
  await act(async () => {
    second = create(<ThreadNotificationCoordinator />);
  });
  try {
    state.plan = true;
    await act(async () => {
      renderer!.update(<ThreadNotificationCoordinator />);
      second!.update(<ThreadNotificationCoordinator />);
    });
    expect(state.add).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => second!.unmount());
  }
});

it("resolving input does not withdraw the still-current plan notification", async () => {
  state.idle = true;
  state.mode = "notifications";
  state.focused = false;
  await render();
  state.input = true;
  state.plan = true;
  await render();
  expect(state.notification).toHaveBeenCalledTimes(2);
  const shown = state.notification.mock.results.map((result) => result.value);
  const plan = shown.find(
    (_, index) => state.notification.mock.calls[index]?.[1]?.body === "Review the proposed plan",
  );
  expect(plan).toBeDefined();
  state.input = false;
  await render();
  expect(plan.close).not.toHaveBeenCalled();
  state.plan = false;
  await render();
  expect(plan.close).toHaveBeenCalledTimes(1);
});

it("preserves the native plan banner when a simultaneous input action resolves", async () => {
  const showThreadNotification = vi.fn().mockResolvedValue(true);
  const closeThreadNotification = vi.fn().mockResolvedValue(undefined);
  Object.assign(window, { desktopBridge: { showThreadNotification, closeThreadNotification } });
  state.idle = true;
  state.mode = "notifications";
  state.focused = false;
  await render();
  state.input = true;
  state.plan = true;
  await render();
  expect(showThreadNotification).toHaveBeenCalledTimes(2);
  const replacedCount = closeThreadNotification.mock.calls.length;
  state.input = false;
  await render();
  expect(closeThreadNotification).toHaveBeenCalledTimes(replacedCount);
  state.plan = false;
  await render();
  expect(closeThreadNotification).toHaveBeenCalledTimes(replacedCount + 1);
});

it.each(["plan", "held"] as const)(
  "ends persisted %s episodes from an inactive restart baseline",
  async (reason) => {
    state.idle = true;
    await render();
    if (reason === "plan") state.plan = true;
    else state.held = 1;
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
    await act(async () => renderer!.unmount());
    renderer = undefined;
    state.plan = false;
    state.held = 0;
    state.revision = "2026-09-13T09:05:00.000Z";
    await render();
    if (reason === "plan") state.plan = true;
    else state.held = 1;
    state.revision = "2026-09-13T09:06:00.000Z";
    await render();
    expect(state.add).toHaveBeenCalledTimes(2);
  },
);
