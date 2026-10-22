import type {
  ServerPrepareServiceUpdateInput,
  StudioServiceInstallOptions,
  StudioServiceUpdateRun,
  StudioServiceUpdateRunAction,
  StudioServiceUpdateRunResult,
} from "@specweave-studio/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const toasts = vi.hoisted(() => ({
  add: vi.fn((_toast: unknown) => "toast-1"),
  update: vi.fn(),
  close: vi.fn(),
}));
vi.mock("./ui/toast", () => ({
  toastManager: toasts,
  stackedThreadToast: (toast: unknown) => toast,
  hiddenToastActionProps: { children: null },
}));

import { registerPrepare } from "./serviceUpdateCalls";
import {
  resetServiceUpdateRunFlowForTests,
  shouldReportRun,
  startServiceUpdateRun,
  syncServiceUpdateRunToast,
} from "./serviceUpdateRunFlow";

const T0 = Date.parse("2026-10-21T12:00:00.000Z");

const run = (values: Partial<StudioServiceUpdateRun> = {}): StudioServiceUpdateRun => ({
  runId: "run-1",
  phase: "preparing",
  terminal: false,
  targetVersion: "1.0.70",
  appTargetVersion: "1.0.70",
  startedAt: new Date(T0).toISOString(),
  deadlineAt: new Date(T0 + 30 * 60_000).toISOString(),
  lastSignAt: new Date(T0).toISOString(),
  noProgress: false,
  step: null,
  app: null,
  message: null,
  outcome: null,
  endedAt: null,
  ...values,
});

const calls: string[] = [];
let begun: StudioServiceUpdateRunResult = { supported: true, created: true, run: run() };
let installFails = false;
const storage = new Map<string, string>();
let unregister: () => void = () => undefined;

const bridge = {
  serviceUpdateRun: vi.fn(async (action: StudioServiceUpdateRunAction) => {
    calls.push(`run:${action.type}`);
    return action.type === "begin" ? begun : { supported: true, created: false, run: null };
  }),
  installServiceUpdate: vi.fn(async (options?: StudioServiceInstallOptions) => {
    calls.push(`install:${options?.runId}:${options?.version}:${options?.holdUntil}`);
    if (installFails) throw new Error("The desktop refused the request.");
    return null;
  }),
};

beforeEach(() => {
  calls.length = 0;
  begun = { supported: true, created: true, run: run() };
  installFails = false;
  storage.clear();
  toasts.add.mockClear();
  toasts.update.mockClear();
  toasts.close.mockClear();
  resetServiceUpdateRunFlowForTests();
  Object.assign(globalThis, {
    window: globalThis,
    desktopBridge: bridge,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
    },
  });
  unregister = registerPrepare(async (input: ServerPrepareServiceUpdateInput) => {
    calls.push(
      input.releaseHold
        ? "prepare:releaseHold"
        : `prepare:${input.stopWork}${input.hold ? "+hold" : ""}`,
    );
    return { idle: true, stoppedThreads: 0, blockers: [], held: true };
  });
});

afterEach(() => {
  unregister();
  delete (globalThis as { desktopBridge?: unknown }).desktopBridge;
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("startServiceUpdateRun", () => {
  it("begins one run, holds the work and names the run in the install request", async () => {
    expect(
      await startServiceUpdateRun({ targetVersion: "1.0.70", appTargetVersion: "1.0.70" }),
    ).toBe("started");
    expect(calls).toEqual([
      "run:begin",
      "prepare:true+hold",
      `install:run-1:1.0.70:${new Date(T0 + 30 * 60_000).toISOString()}`,
    ]);
  });

  it("follows a run another window began, asking nothing more", async () => {
    begun = { supported: true, created: false, run: run({ phase: "installing" }) };
    expect(await startServiceUpdateRun({ targetVersion: "1.0.70", appTargetVersion: null })).toBe(
      "following",
    );
    expect(calls).toEqual(["run:begin"]);
  });

  it("answers legacy for an agent without runs, or a desktop without the call", async () => {
    begun = { supported: false, created: false, run: null };
    expect(await startServiceUpdateRun({ targetVersion: "1.0.70", appTargetVersion: null })).toBe(
      "legacy",
    );
    (globalThis as { desktopBridge?: unknown }).desktopBridge = {
      installServiceUpdate: bridge.installServiceUpdate,
    };
    expect(await startServiceUpdateRun({ targetVersion: "1.0.70", appTargetVersion: null })).toBe(
      "legacy",
    );
    expect(calls).toEqual(["run:begin"]);
  });

  it("ends the run nobody claimed as failed, with why, when the request failed", async () => {
    installFails = true;
    await expect(
      startServiceUpdateRun({ targetVersion: "1.0.70", appTargetVersion: null }),
    ).rejects.toThrow("The desktop refused the request.");
    // The work held for it is let go at once, not at the hold's expiry.
    expect(calls.slice(-2)).toEqual(["run:cancel", "prepare:releaseHold"]);
    // A failure, not a cancel by the person: every window then offers Try again.
    expect(bridge.serviceUpdateRun).toHaveBeenLastCalledWith({
      type: "cancel",
      runId: "run-1",
      reason: "The install request could not be made: The desktop refused the request.",
    });
  });
});

describe("reporting a run", () => {
  const ended = run({
    phase: "verified",
    terminal: true,
    outcome: "updated",
    endedAt: new Date(T0 + 60_000).toISOString(),
  });

  it("reports a recent outcome once on this computer", () => {
    expect(shouldReportRun(ended, false, T0 + 2 * 60_000)).toBe(true);
    expect(shouldReportRun(ended, false, T0 + 60 * 60_000)).toBe(false);
    expect(shouldReportRun(ended, true, T0 + 60 * 60_000)).toBe(true);
    syncServiceUpdateRunToast(ended, [], { retry: vi.fn(), restartApp: vi.fn() }, T0 + 2 * 60_000);
    expect(toasts.add).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["run:acknowledge"]);
    expect(shouldReportRun(ended, true, T0 + 2 * 60_000)).toBe(false);
  });

  it("keeps one toast for a live run and never offers a button while it lasts", () => {
    const actions = { retry: vi.fn(), restartApp: vi.fn() };
    syncServiceUpdateRunToast(run({ phase: "installing" }), [], actions, T0 + 1_000);
    syncServiceUpdateRunToast(
      run({ phase: "installing", noProgress: true }),
      [],
      actions,
      T0 + 2_000,
    );
    expect(toasts.add).toHaveBeenCalledTimes(1);
    expect(toasts.update).toHaveBeenCalledTimes(1);
    const options = toasts.update.mock.calls[0]![1] as {
      type: string;
      actionProps: { children: unknown };
    };
    expect(options).toMatchObject({ type: "warning", actionProps: { children: null } });
    // The run ends: the one toast turns into its outcome.
    syncServiceUpdateRunToast(
      {
        ...run(),
        ...{
          terminal: true,
          phase: "failed",
          outcome: "failed",
          endedAt: new Date(T0 + 3_000).toISOString(),
          message: "x",
        },
      },
      [],
      actions,
      T0 + 4_000,
    );
    expect(toasts.update.mock.calls.at(-1)?.[1]).toMatchObject({
      type: "error",
      actionProps: { children: "Try again" },
    });
  });
});
