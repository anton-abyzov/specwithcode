import { setNotificationsConnected } from "../notificationConnection";
import { __resetNotificationHistoryForTests } from "../notificationHistory";
import {
  __resetRemoteWorkerLaunchersForTests,
  publishRemoteWorkerLaunchers,
} from "../studio/remoteWorkerLaunchers";
import { EnvironmentId } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  mode: "notifications",
  inApp: false,
  toast: vi.fn(),
  shells: new Map(),
  navigate: vi.fn(),
  sound: vi.fn(),
  badge: vi.fn(),
  environmentIds: ["one", "two"],
  // This app's own machine, and what the serving machine says about the target.
  primary: null as string | null,
  target: { status: "unknown", ownerAppConnected: false } as unknown,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: (id: string) => state.shells.get(id) }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => state.navigate,
  useParams: () => ({}),
  useSearch: () => null,
}));
vi.mock("./settings/useSettingsProjectGroups", () => ({ useSettingsProjectGroups: () => [] }));
vi.mock("../state/entities", () => ({ readThreadShell: () => null, useProjects: () => [] }));
vi.mock("./ui/toast", () => ({ toastManager: { add: state.toast } }));
vi.mock("../state/shell", () => ({ environmentShell: { stateValueAtom: (id: string) => id } }));
vi.mock("../state/environments", () => ({
  useEnvironmentIds: () => state.environmentIds,
  usePrimaryEnvironmentId: () => state.primary,
  useUnreachableEnvironmentIds: () => new Set(),
}));
vi.mock("../notificationTarget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../notificationTarget")>()),
  readNotificationTarget: () => Promise.resolve(state.target),
}));
vi.mock("../lib/backgroundActivityReporter", () => ({
  backgroundActivityClientId: () => "client-self",
  appClientId: (clientId: string) => clientId.split(":")[0],
}));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: (
    select: (settings: { notificationMode: string; inAppNotificationsEnabled: boolean }) => unknown,
  ) => select({ notificationMode: state.mode, inAppNotificationsEnabled: state.inApp }),
  getClientSettings: () => ({ notificationMode: state.mode }),
}));
vi.mock("../threadNotifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../threadNotifications")>()),
  playNotificationSound: state.sound,
  unlockNotificationAudio: vi.fn(),
  setNotificationBadge: state.badge,
}));

import { ThreadNotificationCoordinator } from "./ThreadNotificationCoordinator";

class TestNotification extends EventTarget {
  static permission = "granted";
  static sent: TestNotification[] = [];
  close = vi.fn();
  get tag() {
    return this.options.tag ?? "";
  }
  constructor(
    readonly title: string,
    readonly options: NotificationOptions,
  ) {
    super();
    TestNotification.sent.push(this);
  }
}

const thread = {
  id: "thread",
  title: "Test thread",
  archivedAt: null as string | null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  session: null as { status: string } | null,
  latestTurn: { turnId: "turn", state: "running", completedAt: null as string | null },
};
let renderer: ReactTestRenderer | undefined;
let focused = false;
let visibility = "visible";

const SHELL_NOW = DateTime.makeUnsafe("2026-09-13T07:00:00.000Z");

function toV2ThreadShell(input: typeof thread) {
  const latestTurn = input.latestTurn;
  return {
    id: input.id,
    projectId: "project",
    title: input.title,
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: input.id,
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: latestTurn.turnId,
    activeRunId: null,
    status:
      latestTurn.state === "completed"
        ? "completed"
        : latestTurn.state === "error" || input.session?.status === "error"
          ? "failed"
          : "running",
    pendingRuntimeRequest: input.hasPendingUserInput
      ? { id: "request-1", kind: "user_input", createdAt: SHELL_NOW }
      : input.hasPendingApprovals
        ? { id: "request-1", kind: "command", createdAt: SHELL_NOW }
        : null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: SHELL_NOW,
    updatedAt: SHELL_NOW,
    latestRunRequestedAt: SHELL_NOW,
    latestRunStartedAt: SHELL_NOW,
    latestRunCompletedAt: latestTurn.completedAt
      ? DateTime.makeUnsafe(latestTurn.completedAt)
      : undefined,
    archivedAt: input.archivedAt ? DateTime.makeUnsafe(input.archivedAt) : null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function shell(overrides: Partial<typeof thread> = {}) {
  return {
    status: "live",
    snapshot: Option.some({ threads: [toV2ThreadShell({ ...thread, ...overrides })] }),
  };
}
function complete(environment = "one", completedAt = "2026-09-13T08:00:00Z") {
  state.shells.set(
    environment,
    shell({ latestTurn: { turnId: "turn", state: "completed", completedAt } }),
  );
}
async function render() {
  await act(async () => {
    if (renderer) renderer.update(<ThreadNotificationCoordinator />);
    else renderer = create(<ThreadNotificationCoordinator />);
  });
}

beforeEach(() => {
  __resetNotificationHistoryForTests();
  vi.clearAllMocks();
  state.mode = "notifications";
  state.inApp = false;
  state.environmentIds = ["one", "two"];
  state.primary = null;
  state.target = { status: "unknown", ownerAppConnected: false };
  state.shells.set("one", shell());
  state.shells.set("two", shell());
  focused = false;
  visibility = "visible";
  TestNotification.permission = "granted";
  TestNotification.sent = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Notification", TestNotification);
  vi.stubGlobal("window", Object.assign(new EventTarget(), { focus: vi.fn() }));
  setNotificationsConnected(true);
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), {
      hasFocus: () => focused,
      get visibilityState() {
        return visibility;
      },
    }),
  );
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
  __resetRemoteWorkerLaunchersForTests();
});

it("counts notifying threads across environments, replaces repeat alerts, and clears on focus", async () => {
  await render();
  complete();
  await render();
  expect(state.badge).toHaveBeenLastCalledWith(1);
  complete("one", "2026-09-13T08:01:00Z");
  complete("two");
  await render();
  expect(state.badge).toHaveBeenLastCalledWith(2);
  expect(TestNotification.sent[0]!.close).toHaveBeenCalledOnce();
  focused = true;
  window.dispatchEvent(new Event("focus"));
  expect(state.badge).toHaveBeenLastCalledWith(0);
  expect(
    TestNotification.sent.every((notification) => notification.close.mock.calls.length > 0),
  ).toBe(true);
  focused = false;
  complete("two", "2026-09-13T08:02:00Z");
  await render();
  expect(state.badge).toHaveBeenLastCalledWith(1);
});

it("does not badge old completions on first load or reconnect", async () => {
  complete();
  await render();
  state.shells.set("one", { status: "connecting", snapshot: Option.none() });
  await render();
  complete();
  await render();
  expect(TestNotification.sent).toHaveLength(0);
  expect(state.badge.mock.calls.every(([count]) => count === 0)).toBe(true);
});

it("removes alerts only from environments that leave the client", async () => {
  await render();
  complete("one");
  complete("two");
  await render();
  expect(state.badge).toHaveBeenLastCalledWith(2);
  const [removed, retained] = TestNotification.sent;
  state.environmentIds = ["two"];
  await render();
  expect(state.badge).toHaveBeenLastCalledWith(1);
  expect(removed!.close).toHaveBeenCalledOnce();
  expect(retained!.close).not.toHaveBeenCalled();
  await render();
  expect(removed!.close).toHaveBeenCalledOnce();
  state.environmentIds = [];
  await render();
  expect(state.badge).toHaveBeenLastCalledWith(0);
  expect(retained!.close).toHaveBeenCalledOnce();
});

it("starts a fresh count after another native app window gains focus", async () => {
  let clear: (() => void) | undefined;
  const unsubscribe = vi.fn();
  Object.assign(window, {
    desktopBridge: {
      onNotificationBadgeClear: (listener: () => void) => {
        clear = listener;
        return unsubscribe;
      },
    },
  });
  await render();
  complete();
  await render();
  clear!();
  expect(state.badge).toHaveBeenLastCalledWith(0);
  complete("two");
  await render();
  expect(state.badge).toHaveBeenLastCalledWith(1);
  await act(async () => renderer!.unmount());
  renderer = undefined;
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(state.badge).toHaveBeenLastCalledWith(0);
});

it.each(["off", "sound", "focused", "denied", "archived"])(
  "does not show visual alerts when %s",
  async (condition) => {
    if (condition === "off" || condition === "sound") state.mode = condition;
    if (condition === "focused") focused = true;
    if (condition === "denied") TestNotification.permission = "denied";
    await render();
    complete();
    if (condition === "archived")
      state.shells.set(
        "one",
        shell({
          archivedAt: "2026-09-13T08:00:00Z",
          hasPendingApprovals: true,
        }),
      );
    await render();
    expect(TestNotification.sent).toHaveLength(0);
    expect(state.badge.mock.calls.every(([count]) => count === 0)).toBe(true);
  },
);

it.each(["hasPendingApprovals", "hasPendingUserInput"] as const)(
  "badges %s and clears when notifications are disabled",
  async (flag) => {
    await render();
    state.shells.set("one", shell({ [flag]: true }));
    await render();
    expect(state.badge).toHaveBeenLastCalledWith(1);
    const notification = TestNotification.sent[0]!;
    notification.dispatchEvent(new Event("click"));
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: EnvironmentId.make("one"), threadId: "thread" },
    });
    state.mode = "sound";
    await render();
    expect(state.badge).toHaveBeenLastCalledWith(0);
    expect(notification.close).toHaveBeenCalled();
  },
);

it("shows in-app alerts without adding a badge while focused", async () => {
  state.inApp = true;
  focused = true;
  await render();
  complete();
  await render();
  expect(state.toast).toHaveBeenCalledOnce();
  expect(TestNotification.sent).toHaveLength(0);
  expect(state.badge.mock.calls.every(([count]) => count === 0)).toBe(true);
});

it("badges background failures with in-app notifications enabled", async () => {
  state.inApp = true;
  await render();
  state.shells.set("one", shell({ latestTurn: { ...thread.latestTurn, state: "error" } }));
  await render();
  expect(TestNotification.sent[0]?.title).toBe("Test thread");
  expect(TestNotification.sent[0]?.options.body).toBe("Stopped with an error");
  expect(state.badge).toHaveBeenLastCalledWith(1);
  expect(state.toast).not.toHaveBeenCalled();
});

describe("a remote worker thread belongs to the coordinator machine that launched it", () => {
  const elected = (clientId: string) => ({
    status: "known",
    target: { clientId, reason: "foreground" },
    ownerAppConnected: true,
  });
  const launchedBy = (coordinator: string) =>
    new Map([[JSON.stringify(["env-2", "thread"]), coordinator]]);

  beforeEach(() => {
    state.mode = "notifications-and-sound";
    state.environmentIds = ["env-1", "env-2"];
    state.target = elected("client-other");
    // The thread is served by env-2 only.
    state.shells.set("env-1", { status: "live", snapshot: Option.some({ threads: [] }) });
    state.shells.set("env-2", shell());
  });

  async function completeOn(environment: string) {
    await render();
    complete(environment);
    await render();
  }

  it("badges on the launching coordinator's app, without popup or sound", async () => {
    publishRemoteWorkerLaunchers("sidebar", launchedBy("env-1"));
    state.primary = "env-1";
    await completeOn("env-2");
    expect(TestNotification.sent).toHaveLength(0);
    expect(state.sound).not.toHaveBeenCalled();
    expect(state.badge).toHaveBeenLastCalledWith(1);
  });

  it("stays quiet on the worker machine's app", async () => {
    publishRemoteWorkerLaunchers("sidebar", launchedBy("env-1"));
    state.primary = "env-2";
    await completeOn("env-2");
    expect(TestNotification.sent).toHaveLength(0);
    expect(state.sound).not.toHaveBeenCalled();
    expect(state.badge).not.toHaveBeenCalledWith(1);
  });

  it.each([
    ["badges on its own machine's app", "env-1", true],
    ["stays quiet on another machine's app", "env-2", false],
  ])("leaves a thread on its own machine unchanged: %s", async (_name, primary, badged) => {
    // A launcher entry for a worker elsewhere does not touch a thread on env-1.
    publishRemoteWorkerLaunchers("sidebar", launchedBy("env-2"));
    state.shells.set("env-1", shell());
    state.shells.set("env-2", { status: "live", snapshot: Option.some({ threads: [] }) });
    state.primary = primary;
    await completeOn("env-1");
    expect(TestNotification.sent).toHaveLength(0);
    if (badged) expect(state.badge).toHaveBeenLastCalledWith(1);
    else expect(state.badge).not.toHaveBeenCalledWith(1);
  });

  it.each([
    ["the coordinator machine's app stays quiet", "env-1", false],
    ["the worker machine's app badges", "env-2", true],
  ])(
    "with nothing published the owner is the thread's own machine: %s",
    async (_name, primary, badged) => {
      state.primary = primary;
      await completeOn("env-2");
      expect(TestNotification.sent).toHaveLength(0);
      expect(state.sound).not.toHaveBeenCalled();
      if (badged) expect(state.badge).toHaveBeenLastCalledWith(1);
      else expect(state.badge).not.toHaveBeenCalledWith(1);
    },
  );

  it("pops up and plays the sound on the elected app with nothing published", async () => {
    state.target = elected("client-self");
    state.primary = "env-1";
    await completeOn("env-2");
    expect(TestNotification.sent).toHaveLength(1);
    expect(state.sound).toHaveBeenCalledTimes(1);
  });
});
