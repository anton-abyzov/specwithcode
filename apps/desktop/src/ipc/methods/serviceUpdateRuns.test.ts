import { it } from "@effect/vitest";
import type { StudioServiceUpdateState } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, vi } from "vite-plus/test";

import type {
  ServiceAgentConfigChange,
  ServiceUpdateController,
} from "../../updates/studioServiceUpdates.ts";
import {
  isoAt,
  readRun,
  readRunApp,
  RUN_FILE,
  RUN_PREPARING_LEASE_MS,
  transitionRun,
  type UpdateRunRecord,
} from "../../updates/updateRun.ts";
import { memoryRunFiles } from "../../updates/updateRunTestFiles.ts";
import { makeRunFollowUp } from "../../updates/runFollowUp.ts";

vi.mock("electron", () => ({}));

import {
  makeServiceUpdateRuns,
  RUN_ABANDONED_MESSAGE,
  RUN_EXPIRED_MESSAGE,
  type RunFollowUp,
} from "./serviceUpdateRuns.ts";

const T0 = Date.parse("2026-10-21T12:00:00.000Z");

const serviceState: StudioServiceUpdateState = {
  status: "downloaded",
  identity: "m4",
  installedVersion: "1.0.69",
  availableVersion: "1.0.70",
  downloadedVersion: "1.0.70",
  checkedAt: null,
  quietSince: null,
  message: null,
  lastInstall: null,
};

function setup(
  options: {
    readonly supported?: boolean;
    readonly followUp?: RunFollowUp;
    /** What the desktop's updater knows of the app's release (appTargetForRun). */
    readonly appTarget?: Effect.Effect<string | null>;
    readonly files?: ReturnType<typeof memoryRunFiles>;
    readonly installedVersion?: string;
    /** config.json cannot be written: the change is refused. */
    readonly unwritable?: boolean;
  } = {},
) {
  const files = options.files ?? memoryRunFiles();
  const configs: ServiceAgentConfigChange[] = [];
  // config.json as the desktop writes it: each change merged over the last.
  const writeConfig = (change: ServiceAgentConfigChange) => {
    if (options.unwritable) return false;
    configs.push(change);
    const previous = JSON.parse(files.read("config.json") ?? "{}") as object;
    files.writeAtomic("config.json", JSON.stringify({ ...previous, ...change }));
    return true;
  };
  const kicks: string[] = [];
  let published = 0;
  let next = 0;
  const controller = {
    installation: () => ({ identity: "m4", studioHome: "/synthetic/m4", version: "1.0.69" }),
    readState: () => ({
      ...serviceState,
      installedVersion: options.installedVersion ?? serviceState.installedVersion,
    }),
    runFiles: () => files,
    runSupported: () => options.supported ?? true,
  } as unknown as ServiceUpdateController;
  const runs = makeServiceUpdateRuns({
    controller: Effect.succeed(controller),
    publish: Effect.sync(() => {
      published += 1;
    }),
    kick: (reason) => Effect.sync(() => void kicks.push(reason)),
    writeConfig: (change) => Effect.sync(() => writeConfig(change)),
    ...(options.followUp ? { followUp: options.followUp } : {}),
    ...(options.appTarget ? { appTarget: options.appTarget } : {}),
    newRunId: () => `run-${(next += 1)}`,
  });
  /** The install request of a run, as serviceUpdates writes it: run.json, then config.json. */
  const ask = (runId: string, at: string) =>
    Effect.gen(function* () {
      const change = yield* runs.request(runId, at);
      if (change !== null) writeConfig({ installRequestedAt: at, ...change });
      return change;
    });
  return { files, configs, kicks, runs, ask, writeConfig, published: () => published };
}

const begin = { type: "begin", targetVersion: "1.0.70", appTargetVersion: "1.0.70" } as const;

describe("serviceUpdateRun begin", () => {
  it.effect("makes one run for two windows pressing at once; both follow it", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const { runs, files } = setup();
      const [first, second] = yield* Effect.all([runs.handle(begin), runs.handle(begin)], {
        concurrency: "unbounded",
      });
      expect([first.created, second.created].sort()).toEqual([false, true]);
      expect(first.run?.runId).toBe("run-1");
      expect(second.run?.runId).toBe("run-1");
      expect(first.run).toMatchObject({
        phase: "preparing",
        terminal: false,
        targetVersion: "1.0.70",
      });
      expect(readRun(files)?.deadlineAt).toBe(isoAt(T0 + 30 * 60_000));
    }),
  );

  it.effect("answers unsupported when the agent does not advertise runs, and writes nothing", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const { runs, files, configs } = setup({ supported: false });
      expect(yield* runs.handle(begin)).toEqual({ supported: false, created: false, run: null });
      expect(files.files.size).toBe(0);
      expect(configs).toEqual([]);
    }),
  );

  it.effect("names the desktop's app release when the window named none", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      let asked = 0;
      const appTarget = Effect.sync(() => {
        asked += 1;
        return "1.0.70";
      });
      const { runs, files } = setup({ appTarget });
      const made = yield* runs.handle({ ...begin, appTargetVersion: null });
      expect(made.created).toBe(true);
      expect(readRun(files)?.appTargetVersion).toBe("1.0.70");
      expect(asked).toBe(1);
    }),
  );

  // Newer: the app would wait for a service release the agent does not
  // install. Older: a download an earlier launch left, gone from the feed.
  it.effect.each(["1.0.71", "1.0.69"])(
    "leaves out a desktop app release %s that is not the run's release",
    (desktopRelease) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(T0);
        const { runs, files } = setup({ appTarget: Effect.succeed(desktopRelease) });
        const made = yield* runs.handle({ ...begin, appTargetVersion: null });
        expect(made.created).toBe(true);
        expect(readRun(files)?.targetVersion).toBe("1.0.70");
        expect(readRun(files)?.appTargetVersion).toBeNull();
      }),
  );

  it.effect("keeps the window's app release, and leaves none when the desktop knows none", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      let asked = 0;
      const known = setup({
        appTarget: Effect.sync(() => {
          asked += 1;
          return "1.0.71";
        }),
      });
      yield* known.runs.handle(begin);
      expect(readRun(known.files)?.appTargetVersion).toBe("1.0.70");
      expect(asked).toBe(0);
      const unknown = setup({ appTarget: Effect.succeed(null) });
      yield* unknown.runs.handle({ ...begin, appTargetVersion: null });
      expect(readRun(unknown.files)?.appTargetVersion).toBeNull();
    }),
  );

  it.effect("starts a new run once the previous one ended", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const { runs, files } = setup();
      yield* runs.handle({ ...begin, appTargetVersion: null });
      transitionRun(files, "run-1", (run) => ({ ...run, phase: "failed", endedAt: isoAt(T0) }));
      const again = yield* runs.handle(begin);
      expect(again).toMatchObject({ created: true, run: { runId: "run-2" } });
      expect(files.list("runs")).toEqual(["run-1.json"]);
    }),
  );
});

describe("the install request of a run", () => {
  it.effect("moves preparing to requested once and names the run with its deadline", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const { runs, files } = setup();
      yield* runs.handle(begin);
      const at = isoAt(T0 + 2_000);
      expect(yield* runs.request("run-1", at)).toEqual({
        installRunId: "run-1",
        installHoldUntil: isoAt(T0 + 30 * 60_000),
      });
      expect(readRun(files)).toMatchObject({ phase: "requested", requestedAt: at, rev: 2 });
      // A second request (or one naming another run) is not a run request.
      expect(yield* runs.request("run-1", at)).toBeNull();
      expect(yield* runs.request("run-9", at)).toBeNull();
      expect(yield* runs.request("../x", at)).toBeNull();
    }),
  );

  it.effect("cancels a run nobody claimed, and tells the agent", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const { ask, runs, files, configs } = setup();
      yield* runs.handle(begin);
      yield* ask("run-1", isoAt(T0));
      const result = yield* runs.handle({ type: "cancel", runId: "run-1" });
      expect(result.run).toMatchObject({
        phase: "cancelled",
        terminal: true,
        outcome: "cancelled",
      });
      expect(configs.at(-1)).toMatchObject({ installRequestedAt: null, installRunId: null });
    }),
  );

  it.effect("leaves a claimed run to its agent: only the config cancel is written", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const { ask, runs, files, configs } = setup();
      yield* runs.handle(begin);
      yield* ask("run-1", isoAt(T0));
      transitionRun(files, "run-1", (run) => ({
        ...run,
        phase: "waiting",
        owner: { kind: "agent", pid: 7, agentVersion: 1, claimedAt: isoAt(T0) },
        leaseUntil: isoAt(T0 + 90_000),
      }));
      const result = yield* runs.handle({ type: "cancel", runId: "run-1" });
      expect(result.run).toMatchObject({ phase: "waiting", terminal: false });
      expect(configs.at(-1)).toMatchObject({ installCancelledAt: isoAt(T0) });
    }),
  );
});

describe("the run loop", () => {
  const claimed = (files: ReturnType<typeof memoryRunFiles>, values: Partial<UpdateRunRecord>) =>
    transitionRun(files, "run-1", (run) => ({ ...run, ...values }));

  it.effect("never fails a run on its own clock; re-kicks the agent when the lease lapsed", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const { ask, runs, files, kicks } = setup();
      yield* runs.handle(begin);
      yield* ask("run-1", isoAt(T0));
      claimed(files, { phase: "waiting", owner: null, leaseUntil: isoAt(T0 + 60_000) });
      yield* TestClock.setTime(T0 + 65_000);
      expect(yield* runs.tick).toBe(true);
      expect(kicks).toEqual([]);
      yield* TestClock.setTime(T0 + 75_000);
      expect(yield* runs.tick).toBe(true);
      expect(kicks).toEqual(["update run lease lapsed"]);
      yield* TestClock.setTime(T0 + 90_000);
      yield* runs.tick;
      expect(kicks).toHaveLength(1); // At most every 30 seconds.
      // Long past the deadline, an installing run with a helper alive stays installing.
      claimed(files, { phase: "installing" });
      files.writeAtomic(
        "install-progress.json",
        JSON.stringify({
          schemaVersion: 1,
          version: "1.0.70",
          phase: "readiness",
          step: 13,
          steps: 16,
          heartbeatAt: isoAt(T0 + 40 * 60_000 - 10_000),
        }),
      );
      yield* TestClock.setTime(T0 + 40 * 60_000);
      expect(yield* runs.tick).toBe(true);
      expect(readRun(files)?.phase).toBe("installing");
    }),
  );

  it.effect(
    "expires only an ownerless run past its deadline and grace, and drops its request",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(T0);
        const { ask, runs, files, configs } = setup();
        yield* runs.handle(begin);
        yield* ask("run-1", isoAt(T0));
        yield* TestClock.setTime(T0 + 34 * 60_000);
        expect(yield* runs.tick).toBe(true);
        yield* TestClock.setTime(T0 + 36 * 60_000);
        expect(yield* runs.tick).toBe(false);
        expect(readRun(files)).toMatchObject({ phase: "expired", message: RUN_EXPIRED_MESSAGE });
        expect(configs.at(-1)).toMatchObject({ installRequestedAt: null, installRunId: null });
      }),
  );

  it.effect("hands a verified run with an app half to the follow-up", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const advanced: string[] = [];
      const { runs, files } = setup({
        followUp: {
          advance: (run) => Effect.sync(() => void advanced.push(run.runId)),
          retry: () => Effect.void,
        },
      });
      yield* runs.handle(begin);
      claimed(files, { phase: "verified", endedAt: isoAt(T0) });
      expect(yield* runs.tick).toBe(true); // The app has not installed yet.
      expect(advanced).toEqual(["run-1"]);
      expect(files.read(RUN_FILE)).not.toBeNull();
    }),
  );

  it.effect("installs the app with no window, and Restart now retries it on the same run", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const files = memoryRunFiles();
      const answers = [
        { accepted: true, failed: true, message: "swap failed" },
        { accepted: true, failed: false, message: null },
      ];
      const installs: string[] = [];
      const followUp = makeRunFollowUp({
        files: Effect.succeed(files),
        appVersion: "1.0.69",
        install: (version, beforeApply) =>
          beforeApply.pipe(
            Effect.andThen(Effect.sync(() => (installs.push(version), answers.shift()!))),
          ),
      });
      const { runs } = setup({ files, followUp });
      yield* runs.handle(begin);
      claimed(files, { phase: "verified", endedAt: isoAt(T0) });
      expect(yield* runs.tick).toBe(true);
      for (let i = 0; i < 20; i += 1) yield* Effect.yieldNow;
      // The failed app half ends the run, with its reason.
      expect(yield* runs.tick).toBe(false);
      const failed = yield* runs.handle({ type: "acknowledge", runId: "run-1" });
      expect(failed.run).toMatchObject({
        terminal: true,
        outcome: "failed",
        message: "swap failed",
        app: { phase: "failed" },
      });
      const retried = yield* runs.handle({ type: "retry-app", runId: "run-1" });
      for (let i = 0; i < 20; i += 1) yield* Effect.yieldNow;
      expect(installs).toEqual(["1.0.70", "1.0.70"]);
      expect(retried.run?.terminal).toBe(false);
      expect(readRunApp(files)).toMatchObject({ appPhase: "relaunching", reportedAt: null });
    }),
  );
});

describe("a run nobody will ever own", () => {
  it.effect("ends a preparing run whose window went away, and a new press starts afresh", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const { runs, files } = setup();
      yield* runs.handle(begin);
      // The window reloads while it stops work: the install is never requested.
      yield* TestClock.setTime(T0 + 60_000);
      expect(yield* runs.tick).toBe(true);
      expect(readRun(files)?.phase).toBe("preparing");
      yield* TestClock.setTime(T0 + RUN_PREPARING_LEASE_MS + 1_000);
      expect(yield* runs.tick).toBe(false);
      const ended = (yield* runs.handle({ type: "acknowledge", runId: "run-1" })).run;
      expect(ended).toMatchObject({
        terminal: true,
        outcome: "expired",
        message: RUN_ABANDONED_MESSAGE,
      });
      expect(yield* runs.handle(begin)).toMatchObject({ created: true, run: { runId: "run-2" } });
    }),
  );

  it.effect("a press after a reload takes over a stale preparing run instead of following it", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const { runs } = setup();
      yield* runs.handle(begin);
      yield* TestClock.setTime(T0 + RUN_PREPARING_LEASE_MS + 1_000);
      expect(yield* runs.handle(begin)).toMatchObject({ created: true, run: { runId: "run-2" } });
    }),
  );

  it.effect("a relaunched app ends a preparing run the old process left at once", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const files = memoryRunFiles();
      yield* setup({ files }).runs.handle(begin);
      // The app quits during stop work and starts again 20 seconds later.
      yield* TestClock.setTime(T0 + 20_000);
      const relaunched = setup({ files });
      expect(yield* relaunched.runs.tick).toBe(false);
      expect(readRun(files)).toMatchObject({ phase: "expired", message: RUN_ABANDONED_MESSAGE });
    }),
  );

  it.effect("fails a run at once when its request was not written, with the reason", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const { runs, files, configs } = setup({ unwritable: true });
      yield* runs.handle(begin);
      yield* runs.request("run-1", isoAt(T0));
      const ended = yield* runs.failRequest("run-1", "The install request could not be saved.");
      expect(ended).toMatchObject({
        phase: "failed",
        message: "The install request could not be saved.",
        endedAt: isoAt(T0),
      });
      expect(configs).toEqual([]);
      expect(yield* runs.tick).toBe(false);
      expect(readRun(files)?.phase).toBe("failed");
    }),
  );

  it.effect("fails a requested run whose agent could not start, and withdraws its request", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const { ask, runs, files } = setup();
      yield* runs.handle(begin);
      yield* ask("run-1", isoAt(T0));
      yield* runs.failRequest("run-1", "The update agent is turned off.");
      expect(readRun(files)).toMatchObject({ phase: "failed" });
      expect(JSON.parse(files.read("config.json")!)).toMatchObject({
        installRequestedAt: null,
        installRunId: null,
        installCancelledAt: isoAt(T0),
      });
    }),
  );

  it.effect("a failed install request ends the run as failed, not as cancelled", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const { runs } = setup();
      yield* runs.handle(begin);
      const result = yield* runs.handle({
        type: "cancel",
        runId: "run-1",
        reason: "The install request failed: disk full",
      });
      expect(result.run).toMatchObject({
        outcome: "failed",
        message: "The install request failed: disk full",
      });
    }),
  );
});

describe("a request that is no longer the run's", () => {
  const fleetRequest = (writeConfig: (change: ServiceAgentConfigChange) => boolean) =>
    // update_request.write_request: a forced request with no run id.
    writeConfig({
      installRequestedAt: isoAt(T0 + 5_000),
      installMode: "force",
      installRunId: null,
    });

  it.effect("expiry and cancel leave a newer request from the fleet in config.json", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const { ask, runs, files, configs, writeConfig } = setup();
      yield* runs.handle(begin);
      yield* ask("run-1", isoAt(T0));
      fleetRequest(writeConfig);
      const written = configs.length;
      yield* TestClock.setTime(T0 + 36 * 60_000);
      expect(yield* runs.tick).toBe(false);
      expect(readRun(files)?.phase).toBe("expired");
      expect(configs).toHaveLength(written);
      expect(JSON.parse(files.read("config.json")!)).toMatchObject({
        installRequestedAt: isoAt(T0 + 5_000),
        installMode: "force",
      });
    }),
  );

  it.effect("a run whose target the service already runs ends verified, not expired", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const files = memoryRunFiles();
      const first = setup({ files });
      yield* first.runs.handle(begin);
      yield* first.ask("run-1", isoAt(T0));
      fleetRequest(first.writeConfig);
      // The fleet's request installed 1.0.70; nobody holds the run.
      const { runs, configs } = setup({ files, installedVersion: "1.0.70" });
      yield* TestClock.setTime(T0 + 5 * 60_000);
      yield* runs.tick;
      expect(readRun(files)).toMatchObject({
        phase: "verified",
        message: "The service runs SpecWithCode 1.0.70.",
      });
      expect(configs).toEqual([]);
    }),
  );

  it.effect("an install that outlived its agent pass and finished is verified", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const { ask, runs, files } = setup();
      yield* runs.handle({ ...begin, appTargetVersion: null });
      yield* ask("run-1", isoAt(T0));
      transitionRun(files, "run-1", (run) => ({
        ...run,
        phase: "installing",
        owner: null,
        leaseUntil: isoAt(T0 + 25 * 60_000),
      }));
      files.writeAtomic(
        "install-progress.json",
        JSON.stringify({
          schemaVersion: 1,
          version: "1.0.70",
          phase: "cleanup",
          step: 16,
          steps: 16,
          heartbeatAt: isoAt(T0 + 33 * 60_000),
          result: "verified",
        }),
      );
      yield* TestClock.setTime(T0 + 33 * 60_000 + 5_000);
      expect(yield* runs.tick).toBe(false);
      expect(readRun(files)?.phase).toBe("verified");
    }),
  );
});
