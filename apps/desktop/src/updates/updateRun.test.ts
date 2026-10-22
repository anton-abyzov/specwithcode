// @effect-diagnostics nodeBuiltinImport:off -- Synthetic updates folders only.
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { nodeRunFiles } from "./studioServiceUpdates.ts";
import { memoryRunFiles } from "./updateRunTestFiles.ts";
import {
  configNamesRun,
  createRun,
  deadlineFor,
  deriveRunView,
  type InstallProgress,
  isoAt,
  parseInstallProgress,
  preparingAbandoned,
  readRun,
  type RunAppRecord,
  type RunFiles,
  RUN_ARCHIVE_KEEP,
  RUN_MAX_DEADLINE_MS,
  RUN_MIN_DEADLINE_MS,
  RUN_PREPARING_LEASE_MS,
  serviceReachedTarget,
  shouldExpire,
  shouldRekick,
  transitionRun,
  type UpdateRunRecord,
} from "./updateRun.ts";

const T0 = Date.parse("2026-10-21T12:00:00.000Z");

const create = (files: RunFiles, runId: string, nowMs = T0, expectedMs: number | null = null) =>
  createRun(files, {
    runId,
    nowMs,
    targetVersion: "1.0.70",
    fromVersion: "1.0.69",
    appTargetVersion: "1.0.70",
    expectedMs,
  });

const end = (files: RunFiles, runId: string, phase: UpdateRunRecord["phase"]) =>
  transitionRun(files, runId, (run) => ({ ...run, phase, endedAt: isoAt(T0) }));

describe("createRun", () => {
  it("makes one run per press: a second press follows the run going on", () => {
    const files = memoryRunFiles();
    const first = create(files, "run-a");
    const second = create(files, "run-b");
    expect(first.created).toBe(true);
    expect(second).toMatchObject({ created: false, run: { runId: "run-a", phase: "preparing" } });
  });

  it("on disk, creation is exclusive: every later press follows the first run", async () => {
    const home = FS.mkdtempSync(Path.join(OS.tmpdir(), "update-run-"));
    try {
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          Promise.resolve().then(() => create(nodeRunFiles(home), `run-${index}`)),
        ),
      );
      expect(results.filter((result) => result.created)).toHaveLength(1);
      const winner = results.find((result) => result.created)!.run.runId;
      expect(results.every((result) => result.run.runId === winner)).toBe(true);
      expect(FS.readdirSync(home)).toEqual(["run.json"]);
    } finally {
      FS.rmSync(home, { recursive: true, force: true });
    }
  });

  it("archives an ended run and starts a new one, keeping the newest few", () => {
    const files = memoryRunFiles();
    for (let index = 0; index < RUN_ARCHIVE_KEEP + 2; index += 1) {
      const made = create(files, `run-${index}`, T0 + index * 60_000);
      expect(made.created).toBe(true);
      expect(end(files, made.run.runId, index % 2 === 0 ? "verified" : "failed")).not.toBeNull();
    }
    expect([...files.list("runs")].sort()).toEqual(
      ["run-1", "run-2", "run-3", "run-4", "run-5"].map((id) => `${id}.json`),
    );
    expect(readRun(files)?.runId).toBe(`run-${RUN_ARCHIVE_KEEP + 1}`);
  });

  it("sets the one deadline from the last install's time, between 10 and 30 minutes", () => {
    expect(deadlineFor(T0, null)).toBe(T0 + RUN_MAX_DEADLINE_MS);
    expect(deadlineFor(T0, 60_000)).toBe(T0 + RUN_MIN_DEADLINE_MS);
    expect(deadlineFor(T0, 5 * 60_000)).toBe(T0 + 15 * 60_000);
    expect(deadlineFor(T0, 60 * 60_000)).toBe(T0 + RUN_MAX_DEADLINE_MS);
    expect(create(memoryRunFiles(), "run-a", T0, 4 * 60_000).run.deadlineAt).toBe(
      isoAt(T0 + 12 * 60_000),
    );
  });
});

describe("transitionRun", () => {
  it("bumps rev and never rewrites an ended run", () => {
    const files = memoryRunFiles();
    create(files, "run-a");
    const moved = transitionRun(files, "run-a", (run) => ({ ...run, phase: "requested" }));
    expect(moved).toMatchObject({ phase: "requested", rev: 2 });
    expect(end(files, "run-a", "cancelled")).toMatchObject({ rev: 3 });
    expect(transitionRun(files, "run-a", (run) => ({ ...run, phase: "installing" }))).toBeNull();
    expect(transitionRun(files, "other", (run) => run)).toBeNull();
    expect(readRun(files)).toMatchObject({ phase: "cancelled", rev: 3 });
  });
});

const baseRun = (values: Partial<UpdateRunRecord> = {}): UpdateRunRecord => ({
  schemaVersion: 1,
  runId: "run-a",
  rev: 4,
  createdAt: isoAt(T0),
  createdBy: "desktop",
  targetVersion: "1.0.70",
  fromVersion: "1.0.69",
  appTargetVersion: null,
  requestedAt: isoAt(T0 + 2_000),
  deadlineAt: isoAt(T0 + 20 * 60_000),
  phase: "installing",
  owner: { kind: "agent", pid: 42, agentVersion: 1, claimedAt: isoAt(T0 + 3_000) },
  heartbeatAt: isoAt(T0 + 60_000),
  leaseUntil: isoAt(T0 + 150_000),
  message: null,
  receipt: null,
  endedAt: null,
  ...values,
});

const progress = (values: Partial<InstallProgress> = {}): InstallProgress => ({
  version: "1.0.70",
  phase: "checkBeforeRestart",
  step: 7,
  steps: 16,
  phaseStartedAt: isoAt(T0 + 50_000),
  startedAt: isoAt(T0 + 10_000),
  heartbeatAt: isoAt(T0 + 70_000),
  expectedMs: 160_000,
  serviceRestartedAt: null,
  result: null,
  ...values,
});

const app = (values: Partial<RunAppRecord> = {}): RunAppRecord => ({
  schemaVersion: 1,
  runId: "run-a",
  appTargetVersion: "1.0.70",
  fromAppVersion: "1.0.69",
  appPhase: "installing",
  attempts: 1,
  message: null,
  updatedAt: isoAt(T0 + 100_000),
  finishedAt: null,
  reportedAt: null,
  ...values,
});

describe("deriveRunView", () => {
  it("shows the helper's step i of n with its timings, and the service coming back", () => {
    const view = deriveRunView({
      run: baseRun(),
      app: null,
      progress: progress(),
      nowMs: T0 + 80_000,
    });
    expect(view).toMatchObject({
      terminal: false,
      noProgress: false,
      lastSignAt: isoAt(T0 + 70_000),
      step: { label: "checkBeforeRestart", i: 7, n: 16, expectedMs: 160_000, serviceBack: false },
    });
    expect(
      deriveRunView({
        run: baseRun(),
        app: null,
        progress: progress({ serviceRestartedAt: isoAt(T0 + 75_000) }),
        nowMs: T0 + 80_000,
      }).step?.serviceBack,
    ).toBe(true);
  });

  it("ignores a progress file of another version or from before the run", () => {
    for (const stale of [
      progress({ version: "1.0.69" }),
      progress({ heartbeatAt: isoAt(T0 - 1) }),
    ]) {
      expect(
        deriveRunView({ run: baseRun(), app: null, progress: stale, nowMs: T0 + 80_000 }).step,
      ).toBeNull();
    }
  });

  it("counts the helper's record before it learns the version, for an installing run", () => {
    // update.py sets the version only after the before-read scan (45 to 90 s).
    const early = progress({ version: null, phase: "beforeRead", step: 1 });
    expect(
      deriveRunView({ run: baseRun(), app: null, progress: early, nowMs: T0 + 80_000 }).step,
    ).toMatchObject({ label: "beforeRead", i: 1, n: 16 });
    // Not for a run still waiting: a version-less record there is no install of it.
    expect(
      deriveRunView({
        run: baseRun({ phase: "waiting" }),
        app: null,
        progress: early,
        nowMs: T0 + 80_000,
      }).step,
    ).toBeNull();
  });

  it("dates the helper's start from its phase start less the phases already timed", () => {
    const parsed = parseInstallProgress(
      JSON.stringify({
        schemaVersion: 1,
        version: "1.0.70",
        phase: "checkBeforeRestart",
        step: 7,
        steps: 16,
        phaseStartedAt: isoAt(T0 + 50_000),
        heartbeatAt: isoAt(T0 + 70_000),
        timings: { beforeRead: 30_000, backupSpace: 2_000, verifyAndStage: 8_000, total: 1 },
      }),
    );
    expect(parsed?.startedAt).toBe(isoAt(T0 + 10_000));
    expect(
      deriveRunView({ run: baseRun(), app: null, progress: parsed, nowMs: T0 + 80_000 }).step
        ?.startedAt,
    ).toBe(isoAt(T0 + 10_000));
  });

  it("carries when the app half finished, for the run's total time", () => {
    const verified = baseRun({
      phase: "verified",
      appTargetVersion: "1.0.70",
      endedAt: isoAt(T0 + 90_000),
    });
    expect(
      deriveRunView({
        run: verified,
        app: app({ appPhase: "done", finishedAt: isoAt(T0 + 200_000) }),
        progress: null,
        nowMs: T0 + 210_000,
      }).app,
    ).toMatchObject({ phase: "done", finishedAt: isoAt(T0 + 200_000) });
  });

  it("says no progress after two minutes without a heartbeat, as a fact, not a failure", () => {
    const view = deriveRunView({
      run: baseRun(),
      app: null,
      progress: progress(),
      nowMs: T0 + 70_000 + 121_000,
    });
    expect(view).toMatchObject({
      noProgress: true,
      terminal: false,
      outcome: null,
      phase: "installing",
    });
  });

  it("stays live after the service is verified until the app follow-up ends", () => {
    const verified = baseRun({
      phase: "verified",
      appTargetVersion: "1.0.70",
      endedAt: isoAt(T0 + 90_000),
    });
    expect(deriveRunView({ run: verified, app: null, progress: null, nowMs: T0 }).terminal).toBe(
      false,
    );
    expect(deriveRunView({ run: verified, app: app(), progress: null, nowMs: T0 }).terminal).toBe(
      false,
    );
    expect(
      deriveRunView({ run: verified, app: app({ appPhase: "done" }), progress: null, nowMs: T0 }),
    ).toMatchObject({ terminal: true, outcome: "updated" });
    expect(
      deriveRunView({
        run: verified,
        app: app({ appPhase: "failed", message: "App update did not apply." }),
        progress: null,
        nowMs: T0,
      }),
    ).toMatchObject({ terminal: true, outcome: "failed", message: "App update did not apply." });
    // Another run's app record never counts.
    expect(
      deriveRunView({
        run: verified,
        app: app({ runId: "old", appPhase: "done" }),
        progress: null,
        nowMs: T0,
      }).terminal,
    ).toBe(false);
  });
});

describe("shouldRekick", () => {
  it("kicks a requested run whose lease lapsed, at most every 30 seconds, before its deadline", () => {
    const lapsed = baseRun({ owner: null, leaseUntil: isoAt(T0 + 60_000) });
    expect(shouldRekick({ run: lapsed, nowMs: T0 + 65_000, lastKickMs: null })).toBe(false);
    expect(shouldRekick({ run: lapsed, nowMs: T0 + 71_000, lastKickMs: null })).toBe(true);
    expect(shouldRekick({ run: lapsed, nowMs: T0 + 71_000, lastKickMs: T0 + 50_000 })).toBe(false);
    expect(shouldRekick({ run: lapsed, nowMs: T0 + 81_000, lastKickMs: T0 + 50_000 })).toBe(true);
    expect(shouldRekick({ run: lapsed, nowMs: T0 + 21 * 60_000, lastKickMs: null })).toBe(false);
    expect(shouldRekick({ run: baseRun(), nowMs: T0 + 100_000, lastKickMs: null })).toBe(false);
    expect(
      shouldRekick({
        run: baseRun({ phase: "preparing", requestedAt: null, owner: null }),
        nowMs: T0 + 100_000,
        lastKickMs: null,
      }),
    ).toBe(false);
  });
});

describe("shouldExpire", () => {
  const ownerless = baseRun({ owner: null, leaseUntil: isoAt(T0 + 60_000) });
  const late = T0 + 26 * 60_000;
  it("expires only an ownerless run past deadline plus grace with no helper alive", () => {
    expect(
      shouldExpire({ run: ownerless, progress: null, markerPresent: false, nowMs: late }),
    ).toBe(true);
    expect(
      shouldExpire({
        run: ownerless,
        progress: null,
        markerPresent: false,
        nowMs: T0 + 24 * 60_000,
      }),
    ).toBe(false);
    expect(shouldExpire({ run: ownerless, progress: null, markerPresent: true, nowMs: late })).toBe(
      false,
    );
    expect(
      shouldExpire({
        run: ownerless,
        progress: progress({ heartbeatAt: isoAt(late - 30_000) }),
        markerPresent: false,
        nowMs: late,
      }),
    ).toBe(false);
    expect(
      shouldExpire({
        run: baseRun({ leaseUntil: isoAt(late + 60_000) }),
        progress: null,
        markerPresent: false,
        nowMs: late,
      }),
    ).toBe(false);
  });
});

describe("preparingAbandoned", () => {
  const preparing = baseRun({
    phase: "preparing",
    requestedAt: null,
    owner: null,
    leaseUntil: null,
  });
  it("ends a preparing run past its lease, or one older than this process", () => {
    const at = (nowMs: number, madeHere: boolean, processStartedMs: number | null = T0) =>
      preparingAbandoned({ run: preparing, nowMs, madeHere, processStartedMs });
    expect(at(T0 + 60_000, true)).toBe(false);
    expect(at(T0 + RUN_PREPARING_LEASE_MS + 1, true)).toBe(true);
    // Made before this process started: its window went with the old process.
    expect(at(T0 + 5_000, false, T0 + 1_000)).toBe(true);
    expect(at(T0 + 5_000, false, T0 - 1_000)).toBe(false);
    // A requested or claimed run is never one.
    expect(
      preparingAbandoned({
        run: baseRun({ phase: "requested", owner: null }),
        nowMs: T0 + 10 * 60_000,
        madeHere: true,
        processStartedMs: T0,
      }),
    ).toBe(false);
  });
});

describe("serviceReachedTarget", () => {
  const ownerless = baseRun({ owner: null, leaseUntil: isoAt(T0 + 60_000) });
  const input = (values: Partial<Parameters<typeof serviceReachedTarget>[0]> = {}) =>
    serviceReachedTarget({
      run: ownerless,
      installedVersion: "1.0.69",
      progress: null,
      markerPresent: false,
      nowMs: T0 + 120_000,
      ...values,
    });
  it("sees the target installed, by state.json or the helper's verified result", () => {
    expect(input()).toBe(false);
    expect(input({ installedVersion: "1.0.70" })).toBe(true);
    expect(input({ installedVersion: "1.0.71" })).toBe(true);
    expect(input({ progress: progress({ result: "verified" }) })).toBe(true);
    expect(input({ progress: progress({ result: "rolled-back" }) })).toBe(false);
    // Never while the helper still runs, or while an agent holds a fresh lease.
    expect(input({ installedVersion: "1.0.70", markerPresent: true })).toBe(false);
    expect(input({ run: baseRun(), installedVersion: "1.0.70", nowMs: T0 + 100_000 })).toBe(false);
  });
});

describe("configNamesRun", () => {
  it("is true only while config.json asks for this run's own request", () => {
    const files = memoryRunFiles();
    const run = baseRun();
    expect(configNamesRun(files, run)).toBe(false);
    files.writeAtomic(
      "config.json",
      JSON.stringify({ installRunId: "run-a", installRequestedAt: run.requestedAt }),
    );
    expect(configNamesRun(files, run)).toBe(true);
    // The fleet's request (update_request.write_request) clears installRunId.
    files.writeAtomic(
      "config.json",
      JSON.stringify({ installRunId: null, installRequestedAt: isoAt(T0 + 9_000) }),
    );
    expect(configNamesRun(files, run)).toBe(false);
  });
});
