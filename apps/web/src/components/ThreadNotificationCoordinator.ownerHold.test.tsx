/**
 * 1436: a thread's alert follows its owner machine while a person is at it.
 * Same harness as ThreadNotificationCoordinator.test.tsx, kept apart so each
 * file stays under the line limit.
 */
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
  environmentIds: ["env-1"],
  primary: null as string | null,
  clientId: "client-self",
  recentInput: false,
  targetReads: [] as string[],
  targetRead: (): Promise<unknown> =>
    Promise.resolve({ status: "unknown", ownerAppConnected: false }),
  // One machine's server read, when a test needs machines to answer differently.
  readsByEnv: {} as Record<string, () => Promise<unknown>>,
  executionState: undefined as "running" | "fenced" | undefined,
  executionMachineId: undefined as string | undefined,
  executionMachineLabel: undefined as string | undefined,
  environmentLabel: undefined as string | undefined,
  ownerMachineId: undefined as string | undefined,
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
    ...(state.executionState === undefined ? {} : { executionState: state.executionState }),
    ...(state.executionMachineId === undefined
      ? {}
      : { executionMachineId: state.executionMachineId }),
    ...(state.ownerMachineId === undefined ? {} : { ownerMachineId: state.ownerMachineId }),
    ...(state.executionMachineLabel === undefined
      ? {}
      : { executionMachineLabel: state.executionMachineLabel }),
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
// Its machine names resolve through the connection runtime, which these tests do not start.
vi.mock("../studio/machineIdentity", () => ({
  useMachineIdentities: () => (environmentId: string, fallbackLabel?: string | null) => ({
    environmentId,
    name: fallbackLabel ?? environmentId,
    color: "teal",
  }),
  machineColorProps: (identity: { color: string } | null | undefined) =>
    identity ? { "data-machine-color": identity.color } : {},
}));
vi.mock("../state/environments", () => ({
  useEnvironmentIds: () => state.environmentIds,
  usePrimaryEnvironmentId: () => state.primary,
  useUnreachableEnvironmentIds: () => new Set<string>(),
  useEnvironment: () =>
    state.environmentLabel === undefined ? null : { label: state.environmentLabel },
}));
vi.mock("../notificationTarget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../notificationTarget")>()),
  readNotificationTarget: (environmentId: string) => {
    state.targetReads.push(environmentId);
    return (state.readsByEnv[environmentId] ?? state.targetRead)();
  },
}));
vi.mock("./CoordinatorStepNotifications", () => ({ CoordinatorStepNotifications: () => null }));
vi.mock("../lib/backgroundActivityReporter", () => ({
  backgroundActivityClientId: () => state.clientId,
  interactedRecentlyHere: () => state.recentInput,
  appClientId: (clientId: string) => clientId.split(":")[0],
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

import { __resetNotificationOwnerForTests, setNotificationBadge } from "../threadNotifications";
import { setNotificationsConnected } from "../notificationConnection";
import { __resetNotificationHistoryForTests } from "../notificationHistory";
import { ThreadNotificationCoordinator } from "./ThreadNotificationCoordinator";
import {
  __setNotificationDeliverySinkForTests,
  type NotificationDeliveryRecord,
} from "../notificationDeliveryRecord";
import { OWNER_HOLD_RECHECK_MS } from "../notificationOwnerHold";
import {
  __resetRemoteWorkerLaunchersForTests,
  publishRemoteWorkerLaunchers,
} from "../studio/remoteWorkerLaunchers";

let renderer: ReactTestRenderer | undefined;

async function render() {
  await act(() => {
    if (renderer) renderer.update(<ThreadNotificationCoordinator />);
    else renderer = create(<ThreadNotificationCoordinator />);
  });
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
    environmentIds: ["env-1"],
    primary: null,
    clientId: "client-self",
    recentInput: false,
    targetReads: [],
    targetRead: () => Promise.resolve({ status: "unknown", ownerAppConnected: false }),
    readsByEnv: {},
    executionState: undefined,
    executionMachineId: undefined,
    executionMachineLabel: undefined,
    environmentLabel: undefined,
    ownerMachineId: undefined,
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

describe("alerts follow the owner machine while it is in use (1436)", () => {
  // env-1 is M5, where the thread runs; env-2 is M4.
  const policy = (clientId: string | null, ownerInUse?: boolean) => (): Promise<unknown> =>
    Promise.resolve({
      status: "known",
      target: clientId === null ? null : { clientId, reason: "foreground" },
      ownerAppConnected: true,
      ...(ownerInUse === undefined ? {} : { ownerInUse }),
    });
  let records: NotificationDeliveryRecord[] = [];

  beforeEach(() => {
    records = [];
    __setNotificationDeliverySinkForTests((record) => records.push(record));
    __resetRemoteWorkerLaunchersForTests();
  });
  afterEach(() => {
    __setNotificationDeliverySinkForTests(null);
    __resetRemoteWorkerLaunchersForTests();
    vi.useRealTimers();
  });

  async function block() {
    state.inputAlerts = true;
    state.mode = "notifications-and-sound";
    await render();
    state.input = true;
    await render();
  }

  it("(a) M5 in use: M4's focused window shows nothing", async () => {
    state.primary = "env-2";
    state.readsByEnv = { "env-1": policy("client-m4", true) };
    await block();
    expect(state.targetReads).toEqual(["env-1"]);
    expect(state.add).not.toHaveBeenCalled();
    expect(state.notification).not.toHaveBeenCalled();
    expect(state.sound).not.toHaveBeenCalled();
    expect(records).toMatchObject([
      {
        machine: "env-2",
        ownerMachine: "env-1",
        focused: true,
        ownerInUse: true,
        outcome: "held-back",
        phase: "first",
      },
    ]);
  });

  it("(a) M5 in use: M5's unfocused app posts and plays its sound though M4 is the target", async () => {
    state.primary = "env-1";
    state.focused = false;
    state.clientId = "client-m5";
    state.readsByEnv = { "env-1": policy("client-m4", true) };
    await block();
    expect(state.notification).toHaveBeenCalledTimes(1);
    expect(state.sound).toHaveBeenCalledTimes(1);
    expect(records).toMatchObject([
      { machine: "env-1", outcome: "system", targetClientId: "client-m4", focused: false },
    ]);
  });

  it("(b) M5 idle or locked: M4 toasts in M5's colour, M5 only badges", async () => {
    state.primary = "env-2";
    state.readsByEnv = { "env-1": policy("client-m4", false) };
    await block();
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.add.mock.calls[0]?.[0]).toMatchObject({ data: { machineColor: "teal" } });
    expect(records).toMatchObject([{ outcome: "toast", holdWhy: "owner-idle" }]);

    await act(() => renderer?.unmount());
    renderer = undefined;
    vi.clearAllMocks();
    __resetNotificationHistoryForTests();
    records = [];
    state.input = false;
    state.requestId = "request-2";
    state.primary = "env-1";
    state.focused = false;
    state.clientId = "client-m5";
    await block();
    expect(state.notification).not.toHaveBeenCalled();
    expect(state.sound).not.toHaveBeenCalled();
    expect(vi.mocked(setNotificationBadge)).toHaveBeenLastCalledWith(1);
    expect(records).toMatchObject([{ outcome: "badge", why: "not-target" }]);
  });

  it("a toast for this window's own machine names none, wears no colour and reads nothing", async () => {
    state.primary = "env-1";
    // In use here, so the sound needs no read either.
    state.recentInput = true;
    await block();
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.add.mock.calls[0]?.[0]).not.toHaveProperty("data.machineColor");
    expect(state.targetReads).toEqual([]);
  });

  it("(c) a linux-mini worker M4's coordinator launched: M5 shows nothing while M4 is in use", async () => {
    // env-1 serves the worker here; env-2 (M4) launched it; this window is M5 (env-3).
    publishRemoteWorkerLaunchers(
      "test",
      new Map([[JSON.stringify(["env-1", "thread-1"]), "env-2"]]),
    );
    state.environmentIds = ["env-1", "env-2"];
    state.executionMachineId = "env-1";
    state.primary = "env-3";
    state.readsByEnv = { "env-1": policy("client-m4"), "env-2": policy("client-m4", true) };
    await block();
    expect(state.targetReads).toContain("env-2");
    expect(state.add).not.toHaveBeenCalled();
    expect(state.notification).not.toHaveBeenCalled();
    expect(records).toMatchObject([{ ownerMachine: "env-2", outcome: "held-back" }]);
  });

  it("(c) and M4's unfocused app shows it, asking its own server", async () => {
    publishRemoteWorkerLaunchers(
      "test",
      new Map([[JSON.stringify(["env-1", "thread-1"]), "env-2"]]),
    );
    state.primary = "env-2";
    state.focused = false;
    state.clientId = "client-m4";
    state.readsByEnv = { "env-1": policy("client-m5"), "env-2": policy("client-m5", true) };
    await block();
    expect(state.targetReads).toEqual(["env-1", "env-2"]);
    expect(state.notification).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "the read fails or times out",
      () => Promise.resolve({ status: "unknown", ownerAppConnected: false }),
    ],
    ["the owner's server is older", policy("client-m4")],
  ])("(d) M4 toasts when %s", async (_name, read) => {
    state.primary = "env-2";
    state.readsByEnv = { "env-1": read };
    await block();
    expect(state.add).toHaveBeenCalledTimes(1);
  });

  it("(e) held back and unanswered, M4 toasts once when M5 goes idle", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    state.primary = "env-2";
    state.readsByEnv = { "env-1": policy("client-m4", true) };
    await block();
    expect(state.add).not.toHaveBeenCalled();
    // Another update of the thread while held does not stack a second hold.
    state.revision = "2026-09-13T09:00:05.000Z";
    await render();
    state.readsByEnv = { "env-1": policy("client-m4", false) };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OWNER_HOLD_RECHECK_MS);
    });
    expect(state.add).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OWNER_HOLD_RECHECK_MS * 2);
    });
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(records.map((record) => [record.phase, record.outcome])).toEqual([
      ["first", "held-back"],
      ["recheck", "toast"],
    ]);
  });

  it("(e) shows nothing after the hold when the question was answered meanwhile", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    state.primary = "env-2";
    state.readsByEnv = { "env-1": policy("client-m4", true) };
    await block();
    state.input = false;
    await render();
    state.readsByEnv = { "env-1": policy("client-m4", false) };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OWNER_HOLD_RECHECK_MS);
    });
    expect(state.add).not.toHaveBeenCalled();
  });

  it("(e) stays held when M5 is still in use at the re-check", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    state.primary = "env-2";
    state.readsByEnv = { "env-1": policy("client-m4", true) };
    await block();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OWNER_HOLD_RECHECK_MS);
    });
    expect(state.add).not.toHaveBeenCalled();
    expect(records.map((record) => record.why)).toEqual(["owner-in-use", "owner-still-in-use"]);
  });
});
