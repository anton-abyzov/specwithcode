import type {
  DesktopUpdateActionResult,
  DesktopUpdateState,
  ServerPrepareServiceUpdateInput,
  ServerPrepareServiceUpdateResult,
  StudioServiceInstallOptions,
  StudioServiceUpdateState,
} from "@specweave-studio/contracts";
import type { ReactElement, ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// "Update now" when a read, a stop or a press crosses the request it waits
// on: a lapse or a cancel read just as the window asks again, and a retry or a
// failed read while a failure is abandoned.

const state = vi.hoisted(() => ({
  app: null as DesktopUpdateState | null,
  service: null as StudioServiceUpdateState | null,
  addToast: vi.fn((_toast: unknown) => "toast-1"),
  updateToast: vi.fn(),
  closeToast: vi.fn(),
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
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../state/entities", () => ({ useProjects: () => [] }));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../../state/server", () => ({ serverEnvironment: { prepareServiceUpdate: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.prepare }));
vi.mock("../desktopUpdate.toast", () => ({ showDesktopUpdateDownloadedToast: vi.fn() }));
vi.mock("../ui/spinner", () => ({ Spinner: () => null }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactElement }) => render,
  TooltipPopup: () => null,
}));

import { resetConfirmDialogForTests } from "../../confirmDialog";
import { resetServiceUpdateFlowForTests, SERVICE_REQUEST_EXPIRED } from "../serviceUpdateFlow";
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
  productionBuild: true,
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

const STOP_AND_INSTALL = ["prepare:false", "prepare:true+hold", "installServiceUpdate:force"];

const IDLE: ServerPrepareServiceUpdateResult = { idle: true, stoppedThreads: 0, blockers: [] };

const calls: string[] = [];
let installResult: Omit<DesktopUpdateActionResult, "state">;
let agent: StudioServiceUpdateState = serviceWaiting;
// Whether each stop holds the work, in turn; true once these run out. A
// function answers only when the stop's drain ends.
let stopHolds: Array<boolean | (() => Promise<boolean>)> = [];
const reload = vi.fn();

function prepareCall(input: ServerPrepareServiceUpdateInput): string {
  if (input.releaseHold) return "prepare:release";
  const reason = input.reason === "app-restart" ? ":app-restart" : "";
  return `prepare:${input.stopWork}${input.hold ? `+hold${reason}` : ""}`;
}

const bridge = {
  checkForUpdate: vi.fn(async () => ({ checked: true, state: state.app ?? downloaded })),
  downloadUpdate: vi.fn(async () => ({
    accepted: true,
    completed: true,
    state: state.app ?? downloaded,
  })),
  getUpdateState: vi.fn(async () => state.app ?? downloaded),
  getServiceUpdateState: vi.fn<() => Promise<StudioServiceUpdateState>>(async () => agent),
  installUpdate: vi.fn(async (options?: { expectedVersion?: string }) => {
    calls.push(`installUpdate:${options?.expectedVersion ?? ""}`);
    return { ...installResult, state: state.app ?? downloaded };
  }),
  installServiceUpdate: vi.fn<(options?: StudioServiceInstallOptions) => Promise<unknown>>(),
  cancelServiceUpdate: vi.fn<() => Promise<StudioServiceUpdateState>>(),
  getUpdatePreferences: vi.fn(async () => ({
    checkAutomatically: true,
    downloadAutomatically: true,
    installAutomatically: true,
  })),
  ownsBundledService: vi.fn(async () => true),
};

let renderer: ReactTestRenderer | null = null;

function render() {
  act(() => {
    renderer = create(<SidebarRestartToUpdate />);
  });
  calls.length = 0;
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
  return node ? node.findByType("span").children.join("") : null;
}

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
    description: string;
    data?: { secondaryActionProps?: { children: unknown; onClick?: () => void } };
  };
}

async function pressCancelInToast() {
  const cancel = lastToast().data?.secondaryActionProps;
  expect(cancel?.children).toBe("Cancel update");
  await act(async () => {
    cancel?.onClick?.();
  });
}

const iso = (ms: number) => new Date(ms).toISOString();

/** A forced request the desktop reports as pending, written at `requestedAt`. */
function pendingForce(
  requestedAt: number,
): NonNullable<StudioServiceUpdateState["pendingInstall"]> {
  return {
    requestedAt: iso(requestedAt),
    mode: "force",
    version: "0.2.5",
    holdUntil: iso(requestedAt + 15 * 60_000),
    handled: false,
  };
}

/** The agent's state before the press: up to date, without 0.2.5. */
const lacksRelease = (): StudioServiceUpdateState => ({
  ...serviceWaiting,
  status: "up-to-date",
  availableVersion: null,
  downloadedVersion: null,
  updatedAt: iso(Date.now() - 60_000),
  pendingInstall: null,
});

/**
 * Update now before the agent has 0.2.5: the service refuses to hold the work.
 * The desktop reports the request pending from then on. Returns when it was asked.
 */
async function pressBeforeAgentHasRelease(): Promise<number> {
  stopHolds.unshift(false);
  agent = lacksRelease();
  state.service = agent;
  render();
  const pressedAt = Date.now();
  await click();
  expect(calls).toEqual(STOP_AND_INSTALL);
  agent = { ...agent, pendingInstall: pendingForce(pressedAt) };
  return pressedAt;
}

/** The agent fetched 0.2.5 for the request at `pressedAt`. */
const agentHasRelease = (pressedAt: number): StudioServiceUpdateState => ({
  ...serviceWaiting,
  status: "downloaded",
  updatedAt: iso(pressedAt + 1_000),
  pendingInstall: pendingForce(pressedAt),
});

const asksAgain = () =>
  calls.filter(
    (call) => call.startsWith("prepare:true") || call.startsWith("installServiceUpdate"),
  );

beforeEach(() => {
  vi.useFakeTimers();
  calls.length = 0;
  installResult = { accepted: true, completed: false, failed: false };
  state.app = downloaded;
  state.service = null;
  state.addToast.mockClear();
  state.updateToast.mockReset();
  state.closeToast.mockReset();
  agent = serviceWaiting;
  stopHolds = [];
  state.prepare.mockReset();
  state.prepare.mockImplementation(async (value: { input: ServerPrepareServiceUpdateInput }) => {
    calls.push(prepareCall(value.input));
    if (!value.input.stopWork) return { _tag: "Success", value: IDLE };
    const next = stopHolds.shift() ?? true;
    const held = typeof next === "function" ? await next() : next;
    return { _tag: "Success", value: { ...IDLE, held } };
  });
  reload.mockReset();
  bridge.getServiceUpdateState.mockReset();
  bridge.getServiceUpdateState.mockImplementation(async () => agent);
  bridge.installUpdate.mockClear();
  bridge.installServiceUpdate.mockReset();
  bridge.installServiceUpdate.mockImplementation(async (options?: StudioServiceInstallOptions) => {
    calls.push(`installServiceUpdate:${options?.force ? "force" : "normal"}`);
    return { ...agent };
  });
  bridge.cancelServiceUpdate.mockReset();
  bridge.cancelServiceUpdate.mockImplementation(async () => {
    calls.push("cancelServiceUpdate");
    // The desktop withdraws the request: none is pending any more.
    agent = { ...agent, pendingInstall: null };
    return { ...agent };
  });
  bridge.ownsBundledService.mockClear();
  resetServiceUpdateFlowForTests();
  resetConfirmDialogForTests();
  Object.assign(globalThis, {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    document: { hasFocus: () => true },
  });
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

/** Update now; the desktop reports the request pending and the agent waits. */
async function pressAndWait(): Promise<number> {
  state.service = serviceWaiting;
  render();
  const pressedAt = Date.now();
  await click();
  expect(calls).toEqual(STOP_AND_INSTALL);
  agent = {
    ...serviceWaiting,
    message: "Waiting for a quiet moment",
    updatedAt: iso(pressedAt + 500),
    pendingInstall: pendingForce(pressedAt),
  };
  await advance(2_000);
  calls.length = 0;
  return pressedAt;
}

/** The agent's pass failed: the request it took is over. */
const failedPass = (): StudioServiceUpdateState => ({
  ...serviceWaiting,
  status: "error",
  message: "The install failed",
  updatedAt: iso(Date.now() + 500),
  pendingInstall: null,
});

/** The agent let the request lapse a moment ago. */
const lapsed = (): StudioServiceUpdateState => ({
  ...serviceWaiting,
  status: "error",
  message: SERVICE_REQUEST_EXPIRED,
  updatedAt: iso(Date.now()),
  pendingInstall: null,
});

describe("Update now when requests, reads and presses cross", () => {
  describe("asking the agent again", () => {
    it("renews a request the agent let lapse just as the window asks again", async () => {
      await pressAndWait();
      await advance(33_000);
      calls.length = 0;
      // The next look (the agent silent for 30 s) asks again; the agent writes the lapse just then.
      const answerLook = state.prepare.getMockImplementation()!;
      let lapsedOnLook = false;
      state.prepare.mockImplementation(
        async (value: { input: ServerPrepareServiceUpdateInput }) => {
          if (lapsedOnLook || value.input.stopWork || value.input.releaseHold)
            return answerLook(value);
          lapsedOnLook = true;
          const answer = await answerLook(value);
          agent = lapsed();
          return answer;
        },
      );
      await advance(12_000);
      expect(lapsedOnLook).toBe(true);
      expect(asksAgain()).toEqual(["prepare:true+hold", "installServiceUpdate:force"]);
      expect(label()).toBe("Updating…");
    });

    it("renews a request whose lapse the read before asking again finds, without asking for it first", async () => {
      const pressedAt = await pressBeforeAgentHasRelease();
      const has = agentHasRelease(pressedAt);
      agent = has;
      bridge.getServiceUpdateState
        .mockImplementationOnce(async () => has)
        .mockImplementationOnce(async () => {
          agent = {
            ...lapsed(),
            updatedAt: iso(Date.now() + 1_500),
          };
          return agent;
        });
      calls.length = 0;
      await advance(2_000);
      expect(calls).toEqual(["prepare:true+hold"]);
      await advance(4_000);
      expect(asksAgain()).toEqual([
        "prepare:true+hold",
        "prepare:true+hold",
        "installServiceUpdate:force",
      ]);
      expect(state.closeToast).not.toHaveBeenCalled();
      expect(label()).toBe("Updating…");
    });

    it("renews nothing when the Cancel's answer carries the lapse", async () => {
      await pressAndWait();
      // The agent let the request lapse a moment ago; the window has not read it yet.
      agent = lapsed();
      await pressCancelInToast();
      await advance(10_000);
      expect(asksAgain()).toEqual([]);
      expect(label()).toBe("Update now");
    });

    it("writes nothing when the read before asking again answers while Cancel still withdraws", async () => {
      const pressedAt = await pressBeforeAgentHasRelease();
      const has = agentHasRelease(pressedAt);
      agent = has;
      let answer: (value: StudioServiceUpdateState) => void = () => undefined;
      bridge.getServiceUpdateState
        .mockImplementationOnce(async () => has)
        .mockImplementationOnce(
          () => new Promise<StudioServiceUpdateState>((resolve) => (answer = resolve)),
        );
      await advance(2_000);
      expect(calls).toEqual([...STOP_AND_INSTALL, "prepare:true+hold"]);
      calls.length = 0;
      let withdraw: () => void = () => undefined;
      bridge.cancelServiceUpdate.mockImplementationOnce(
        () =>
          new Promise<StudioServiceUpdateState>((resolve) => {
            withdraw = () => {
              calls.push("cancelServiceUpdate");
              agent = { ...agent, pendingInstall: null };
              resolve({ ...agent });
            };
          }),
      );
      await pressCancelInToast();
      await advance(0);
      await act(async () => answer(has));
      await advance(0);
      expect(asksAgain()).toEqual([]);
      await act(async () => withdraw());
      await advance(4_000);
      expect(asksAgain()).toEqual([]);
      expect(calls).toEqual(["cancelServiceUpdate", "prepare:release"]);
    });
  });

  describe("abandoning a failed attempt", () => {
    it("withdraws the request and lets the work go when the agent cannot be read", async () => {
      await pressAndWait();
      const failed = failedPass();
      agent = failed;
      bridge.getServiceUpdateState
        .mockImplementationOnce(async () => failed)
        .mockImplementationOnce(async () => {
          throw new Error("The desktop did not answer.");
        });
      await advance(4_000);
      expect(lastToast().type).toBe("error");
      expect(calls).toEqual(["cancelServiceUpdate", "prepare:release"]);
    });

    it("leaves a retry pressed while it still reads the agent", async () => {
      await pressAndWait();
      const failed = failedPass();
      agent = failed;
      let answer: (value: StudioServiceUpdateState) => void = () => undefined;
      bridge.getServiceUpdateState
        .mockImplementationOnce(async () => failed)
        .mockImplementationOnce(
          () => new Promise<StudioServiceUpdateState>((resolve) => (answer = resolve)),
        );
      await advance(2_000);
      expect(label()).toBe("Retry update");
      await click();
      await advance(2_000);
      expect(asksAgain()).toEqual(["prepare:true+hold", "installServiceUpdate:force"]);
      agent = {
        ...serviceWaiting,
        updatedAt: iso(Date.now()),
        pendingInstall: pendingForce(Date.now() - 1_000),
      };
      calls.length = 0;
      await act(async () => answer(failed));
      await advance(2_000);
      expect(calls).not.toContain("cancelServiceUpdate");
      expect(calls).not.toContain("prepare:release");
      expect(label()).toBe("Updating…");
    });

    it("withdraws a request asked again under its own hold, though the desktop stamped it later", async () => {
      const pressedAt = await pressBeforeAgentHasRelease();
      agent = agentHasRelease(pressedAt);
      await advance(2_000);
      expect(asksAgain()).toEqual([
        "prepare:true+hold",
        "installServiceUpdate:force",
        "prepare:true+hold",
        "installServiceUpdate:force",
      ]);
      // The desktop stamps the request asked again; it keeps its hold.
      agent = {
        ...agent,
        pendingInstall: { ...pendingForce(pressedAt), requestedAt: iso(Date.now()) },
      };
      await advance(2_000);
      calls.length = 0;
      // The agent's next pass fails before it takes the request: it stays pending.
      agent = {
        ...agent,
        status: "error",
        message: "Checking for updates failed",
        checkedAt: null,
        updatedAt: iso(Date.now() + 500),
      };
      await advance(4_000);
      expect(lastToast().type).toBe("error");
      expect(calls).toEqual(["cancelServiceUpdate", "prepare:release"]);
    });
  });
});
