import { describe, expect, it } from "vite-plus/test";

import {
  afterInstall,
  APP_DID_NOT_APPLY,
  APP_INSTALL_APPLY_MS,
  APP_INSTALL_MAX_ATTEMPTS,
  APP_INSTALL_QUICK_RETRY_MS,
  APP_INSTALL_RETRY_BUDGET_MS,
  APP_INSTALL_RETRY_MS,
  beforeInstall,
  decideFollowUp,
  reconcileOnStartup,
  retainedAppVersion,
  retryFollowUp,
} from "./appFollowUp.ts";
import { isoAt, type RunAppRecord, type UpdateRunRecord } from "./updateRun.ts";

const T0 = Date.parse("2026-10-21T12:00:00.000Z");

const run = (values: Partial<UpdateRunRecord> = {}): UpdateRunRecord => ({
  schemaVersion: 1,
  runId: "run-a",
  rev: 6,
  createdAt: isoAt(T0),
  createdBy: "desktop",
  targetVersion: "1.0.70",
  fromVersion: "1.0.69",
  appTargetVersion: "1.0.70",
  requestedAt: isoAt(T0 + 1_000),
  deadlineAt: isoAt(T0 + 30 * 60_000),
  phase: "verified",
  owner: null,
  heartbeatAt: isoAt(T0 + 150_000),
  leaseUntil: isoAt(T0 + 160_000),
  message: null,
  receipt: null,
  endedAt: isoAt(T0 + 160_000),
  ...values,
});

const app = (values: Partial<RunAppRecord> = {}): RunAppRecord => ({
  schemaVersion: 1,
  runId: "run-a",
  appTargetVersion: "1.0.70",
  fromAppVersion: "1.0.69",
  appPhase: "installing",
  attempts: 0,
  message: null,
  updatedAt: isoAt(T0 + 170_000),
  finishedAt: null,
  reportedAt: null,
  ...values,
});

const NOW = T0 + 170_000;

describe("decideFollowUp", () => {
  it("does nothing until the service is verified, or when the run needs no app", () => {
    for (const phase of ["requested", "installing", "failed", "cancelled"] as const) {
      expect(
        decideFollowUp({
          run: run({ phase }),
          app: null,
          appVersion: "1.0.69",
          nowMs: NOW,
          installing: false,
        }),
      ).toEqual({ type: "none" });
    }
    expect(
      decideFollowUp({
        run: run({ appTargetVersion: null }),
        app: null,
        appVersion: "1.0.69",
        nowMs: NOW,
        installing: false,
      }),
    ).toEqual({ type: "none" });
  });

  it("persists the app step and installs once the service is verified", () => {
    expect(
      decideFollowUp({
        run: run(),
        app: null,
        appVersion: "1.0.69",
        nowMs: NOW,
        installing: false,
      }),
    ).toEqual({
      type: "write",
      install: true,
      record: app({ updatedAt: isoAt(NOW) }),
    });
    // Another run's record does not count: this run starts its own.
    expect(
      decideFollowUp({
        run: run(),
        app: app({ runId: "old", appPhase: "done" }),
        appVersion: "1.0.69",
        nowMs: NOW,
        installing: false,
      }),
    ).toMatchObject({ type: "write", install: true, record: { runId: "run-a" } });
  });

  it("finishes at once when the app already runs the target", () => {
    expect(
      decideFollowUp({
        run: run(),
        app: null,
        appVersion: "1.0.70",
        nowMs: NOW,
        installing: false,
      }),
    ).toMatchObject({
      type: "write",
      install: false,
      record: { appPhase: "done", finishedAt: isoAt(NOW) },
    });
  });

  it("waits for an install in flight and asks again only after the retry interval", () => {
    const own = app({ updatedAt: isoAt(NOW) });
    const input = { run: run(), app: own, appVersion: "1.0.69", installing: false };
    expect(decideFollowUp({ ...input, nowMs: NOW + 10_000 })).toEqual({ type: "none" });
    expect(
      decideFollowUp({ ...input, nowMs: NOW + APP_INSTALL_RETRY_MS, installing: true }),
    ).toEqual({ type: "none" });
    expect(decideFollowUp({ ...input, nowMs: NOW + APP_INSTALL_RETRY_MS })).toMatchObject({
      type: "write",
      install: true,
    });
  });

  it("says the app update did not apply when the app still runs 75 seconds after acceptance", () => {
    const relaunching = app({ appPhase: "relaunching", updatedAt: isoAt(NOW) });
    const input = { run: run(), app: relaunching, appVersion: "1.0.69", installing: false };
    expect(decideFollowUp({ ...input, nowMs: NOW + APP_INSTALL_APPLY_MS - 1 })).toEqual({
      type: "none",
    });
    expect(decideFollowUp({ ...input, nowMs: NOW + APP_INSTALL_APPLY_MS })).toMatchObject({
      type: "write",
      install: false,
      record: { appPhase: "failed", message: APP_DID_NOT_APPLY },
    });
  });

  it("never touches a finished app half", () => {
    for (const appPhase of ["done", "failed"] as const) {
      expect(
        decideFollowUp({
          run: run(),
          app: app({ appPhase }),
          appVersion: "1.0.69",
          nowMs: NOW + 60 * 60_000,
          installing: false,
        }),
      ).toEqual({ type: "none" });
    }
  });
});

describe("install answers", () => {
  it("records relaunching before the call and after an accepted install", () => {
    expect(beforeInstall(app(), NOW)).toMatchObject({
      appPhase: "relaunching",
      updatedAt: isoAt(NOW),
    });
    expect(
      afterInstall(app(), { accepted: true, failed: false, message: null }, NOW + 1_000),
    ).toMatchObject({ appPhase: "relaunching", attempts: 1, updatedAt: isoAt(NOW + 1_000) });
  });

  it("keeps a refused install waiting, and fails it after too many refusals or a failure", () => {
    const refused = { accepted: false, failed: false, message: "The app updater is busy." };
    expect(afterInstall(app(), refused, NOW)).toMatchObject({
      appPhase: "installing",
      attempts: 1,
      message: "The app updater is busy.",
    });
    expect(
      afterInstall(app({ attempts: APP_INSTALL_MAX_ATTEMPTS - 1 }), refused, NOW),
    ).toMatchObject({
      appPhase: "failed",
      message: "The app updater is busy.",
      finishedAt: isoAt(NOW),
    });
    expect(afterInstall(app(), { accepted: true, failed: true, message: null }, NOW)).toMatchObject(
      { appPhase: "failed", message: APP_DID_NOT_APPLY },
    );
  });
});

describe("quick retries", () => {
  const busy = {
    accepted: false,
    failed: false,
    message: "The app updater is busy.",
    reason: "busy",
  };
  const behind = {
    accepted: false,
    failed: false,
    message: "The app update waits for the service on this Mac.",
    reason: "service-behind",
  };
  const input = (own: RunAppRecord, nowMs: number) => ({
    run: run(),
    app: own,
    appVersion: "1.0.69",
    nowMs,
    installing: false,
  });

  it("asks a busy or behind refusal again after 1, 2, then every 5 seconds", () => {
    let own = app();
    let at = NOW;
    const waits: number[] = [];
    for (const answer of [behind, busy, behind, busy, behind]) {
      own = afterInstall(own, answer, at);
      expect(own.appPhase).toBe("installing");
      const delay = own.retryDelayMs!;
      waits.push(delay);
      // Not before the wait, and due right at its end.
      expect(decideFollowUp(input(own, at + delay - 1))).toEqual({ type: "none" });
      expect(decideFollowUp(input(own, at + delay))).toMatchObject({
        type: "write",
        install: true,
      });
      at += delay;
    }
    expect(waits).toEqual([1_000, 2_000, 5_000, 5_000, 5_000]);
    expect(APP_INSTALL_QUICK_RETRY_MS).toEqual([1_000, 2_000, 5_000]);
  });

  it("keeps the regular interval for other refusals, and starts quick again after one", () => {
    const missing = { accepted: false, failed: false, message: "Not downloaded.", reason: null };
    const slow = afterInstall(app(), missing, NOW);
    expect(slow.retryDelayMs).toBe(APP_INSTALL_RETRY_MS);
    expect(afterInstall(slow, behind, NOW).retryDelayMs).toBe(1_000);
    // An answer that names no reason (an older main) waits the regular interval.
    const { reason: _reason, ...unnamed } = busy;
    expect(afterInstall(app(), unnamed, NOW).retryDelayMs).toBe(APP_INSTALL_RETRY_MS);
  });

  it("gives up within the same budget as ten refusals 30 seconds apart", () => {
    expect(APP_INSTALL_RETRY_BUDGET_MS).toBe((APP_INSTALL_MAX_ATTEMPTS - 1) * APP_INSTALL_RETRY_MS);
    let own = app();
    let waited = 0;
    let attempts = 0;
    while (own.appPhase === "installing") {
      own = afterInstall(own, behind, NOW + waited);
      attempts += 1;
      if (own.appPhase === "installing") waited = own.retryWaitMs!;
    }
    expect(own).toMatchObject({ appPhase: "failed", message: behind.message });
    // 1 + 2 + 5 * 53 = 268 seconds of waits, then the next 5 would pass 270.
    expect(waited).toBe(268_000);
    expect(waited).toBeLessThanOrEqual(APP_INSTALL_RETRY_BUDGET_MS);
    expect(attempts).toBe(56);
  });

  it("Restart now after a failure starts a fresh budget", () => {
    const spent = app({ appPhase: "failed", retryDelayMs: 5_000, retryWaitMs: 263_000 });
    const next = retryFollowUp(run(), spent, NOW)!;
    expect(next.retryDelayMs).toBeUndefined();
    expect(next.retryWaitMs).toBeUndefined();
    expect(afterInstall(next, behind, NOW)).toMatchObject({
      appPhase: "installing",
      retryDelayMs: 1_000,
      retryWaitMs: 1_000,
    });
  });
});

describe("reconcileOnStartup", () => {
  it("finishes a run whose relaunch came back on the target", () => {
    expect(
      reconcileOnStartup({
        run: run(),
        app: app({ appPhase: "relaunching" }),
        appVersion: "1.0.70",
        nowMs: NOW,
      }),
    ).toMatchObject({ appPhase: "done", finishedAt: isoAt(NOW) });
  });

  it("reports a relaunch that came back on the old release", () => {
    expect(
      reconcileOnStartup({
        run: run(),
        app: app({ appPhase: "relaunching" }),
        appVersion: "1.0.69",
        nowMs: NOW,
      }),
    ).toMatchObject({ appPhase: "failed", message: APP_DID_NOT_APPLY });
  });

  it("leaves an install that was never accepted, and settled or foreign records, alone", () => {
    expect(
      reconcileOnStartup({ run: run(), app: app(), appVersion: "1.0.69", nowMs: NOW }),
    ).toBeNull();
    expect(
      reconcileOnStartup({
        run: run(),
        app: app({ appPhase: "done" }),
        appVersion: "1.0.70",
        nowMs: NOW,
      }),
    ).toBeNull();
    expect(
      reconcileOnStartup({
        run: run({ runId: "run-b" }),
        app: app({ appPhase: "relaunching" }),
        appVersion: "1.0.69",
        nowMs: NOW,
      }),
    ).toBeNull();
  });
});

describe("retryFollowUp", () => {
  it("moves a failed app half back to installing, due at once", () => {
    const next = retryFollowUp(run(), app({ appPhase: "failed", message: "x", attempts: 3 }), NOW);
    expect(next).toMatchObject({ appPhase: "installing", attempts: 0, message: null });
    expect(
      decideFollowUp({
        run: run(),
        app: next,
        appVersion: "1.0.69",
        nowMs: NOW,
        installing: false,
      }),
    ).toMatchObject({ type: "write", install: true });
    expect(retryFollowUp(run(), app(), NOW)).toBeNull();
  });
});

describe("retainedAppVersion", () => {
  it("names the release a run is installing until the app runs it", () => {
    expect(retainedAppVersion(app(), "1.0.69")).toBe("1.0.70");
    expect(retainedAppVersion(app({ appPhase: "relaunching" }), "1.0.69")).toBe("1.0.70");
    expect(retainedAppVersion(app(), "1.0.70")).toBeNull();
    expect(retainedAppVersion(app({ appPhase: "failed" }), "1.0.69")).toBeNull();
    expect(retainedAppVersion(null, "1.0.69")).toBeNull();
  });
});
