import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { userFacingDispatchErrorMessage } from "../orchestration-v2/UserFacingErrors.ts";
import { fixtureProjectDatabase } from "../project/ProjectWorkspace.testkit.ts";
import * as Hold from "./ServiceUpdateHold.ts";
import { awaitGateOpen, makeGatedHold } from "./UpdateInstallGate.testkit.ts";

const holdAt = (
  agentStatePath: string,
  options: { pollMs?: number; maxMs?: number; noRequestMs?: number } = {},
) => Hold.makeWithOptions({ agentStatePath, ...options });

const missingStatePath = "/nonexistent/specweave-studio-test/updates/state.json";

/** Polls until `isHeld` is false or about two seconds pass; true when released. */
const awaitSelfRelease = (hold: Hold.ServiceUpdateHoldShape) =>
  Effect.gen(function* () {
    // Up to 5 s: a loaded release host delays real timers by seconds.
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (!(yield* hold.isHeld)) return true;
      yield* Effect.sleep(Duration.millis(10));
    }
    return false;
  });

const writeJson = (path: string, value: Record<string, unknown>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(path, JSON.stringify(value));
  });

const isoIn = (ms: number) =>
  Effect.map(Clock.currentTimeMillis, (now) => DateTime.formatIso(DateTime.makeUnsafe(now + ms)));

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

describe("agentVerdictForHold", () => {
  const startedAtMs = Date.parse("2026-10-12T20:00:00.000Z");
  const requested = iso(startedAtMs + 60_000);
  const holdUntilMs = startedAtMs + 60_000 + Hold.HOLD_TTL_MS;
  const reading = (fields: Partial<Hold.AgentStateReading>): Hold.AgentStateReading => ({
    status: "waiting-for-quiet",
    message: null,
    updatedAtMs: startedAtMs + 90_000,
    handledInstallRequestAt: null,
    installRequestedAt: requested,
    installHoldUntilMs: holdUntilMs,
    ...fields,
  });
  const verdict = (fields: Partial<Hold.AgentStateReading>) =>
    Hold.agentVerdictForHold({ reading: reading(fields), startedAtMs });

  it("settles only once the agent handled this hold's request", () => {
    for (const status of ["installed", "error", "manual-required", "up-to-date", "downloaded"]) {
      expect(verdict({ status, handledInstallRequestAt: requested })).toEqual({
        type: "settled",
        status,
      });
    }
  });

  it("ignores a mid-pass download and outcomes of a pass that predates the request", () => {
    // The pass downloads first and writes `downloaded` before it snapshots.
    expect(verdict({ status: "downloaded" })).toEqual({ type: "none" });
    // A periodic pass that held the lock while the request was written.
    for (const status of ["up-to-date", "available", "downloaded"]) {
      expect(verdict({ status, handledInstallRequestAt: iso(startedAtMs - 3_600_000) })).toEqual({
        type: "none",
      });
    }
  });

  it("settles on a failure written after the request, even one the agent did not mark handled", () => {
    for (const status of ["error", "manual-required"]) {
      expect(verdict({ status })).toEqual({ type: "settled", status });
      // Written before the request: not about it.
      expect(verdict({ status, updatedAtMs: startedAtMs + 30_000 })).toEqual({ type: "none" });
    }
  });

  it("follows an install a cancel came too late for", () => {
    // The cancel cleared the request; the agent had already taken it up.
    const cancelled = { installRequestedAt: null, handledInstallRequestAt: requested };
    expect(verdict({ ...cancelled, status: "installing" })).toEqual({
      type: "busy",
      untilMs: startedAtMs + Hold.HOLD_MAX_MS,
    });
    expect(verdict({ ...cancelled, status: "installed" })).toEqual({
      type: "settled",
      status: "installed",
    });
  });

  it("waits for a request made after the hold began", () => {
    expect(verdict({ installRequestedAt: null })).toEqual({ type: "none" });
    expect(
      verdict({
        installRequestedAt: iso(startedAtMs - 1),
        handledInstallRequestAt: iso(startedAtMs - 1),
        status: "installed",
      }),
    ).toEqual({ type: "none" });
  });

  it("keeps the hold while the agent installs this request, up to the ceiling", () => {
    expect(verdict({ status: "installing", handledInstallRequestAt: requested })).toEqual({
      type: "busy",
      untilMs: startedAtMs + Hold.HOLD_MAX_MS,
    });
    // An install another pass started is not this request's.
    expect(verdict({ status: "installing" })).toEqual({ type: "none" });
  });

  it("keeps the hold while a forced pass retries, until its last snapshot can end", () => {
    const until = { type: "busy", untilMs: holdUntilMs + Hold.AGENT_SNAPSHOT_TIMEOUT_MS };
    expect(verdict({ message: "Waiting for running sessions (attempt 3)" })).toEqual(until);
    expect(verdict({ status: "downloading" })).toEqual(until);
    // A status from before the hold is not about it; one written after the hold
    // began still counts when the window has asked again since (a long snapshot).
    expect(verdict({ updatedAtMs: startedAtMs - 1 })).toEqual({ type: "none" });
    expect(verdict({ updatedAtMs: startedAtMs + 30_000 })).toEqual(until);
    // Its final answer, once no retry fits: only the time limit is left.
    expect(verdict({ updatedAtMs: holdUntilMs - Hold.AGENT_RETRY_MS })).toEqual({ type: "none" });
    // A refused apply snapshots again even past the deadline.
    expect(
      verdict({ updatedAtMs: holdUntilMs + 5_000, message: Hold.AGENT_APPLY_RETRY_MESSAGE }),
    ).toEqual(until);
  });
});

describe("installRequestOpen", () => {
  const nowMs = Date.parse("2026-10-21T10:00:00.000Z");
  const reading = (fields: Partial<Hold.AgentStateReading>): Hold.AgentStateReading => ({
    status: "waiting-for-quiet",
    message: null,
    updatedAtMs: null,
    handledInstallRequestAt: null,
    installRequestedAt: "2026-10-21T09:58:00.000Z",
    installHoldUntilMs: nowMs + 60_000,
    ...fields,
  });

  it("is true while a request the agent has not finished with is within its time", () => {
    expect(Hold.installRequestOpen(reading({}), nowMs)).toBe(true);
    // Handled (installed, rolled back or given up), cancelled, or out of time: over.
    expect(
      Hold.installRequestOpen(
        reading({ handledInstallRequestAt: "2026-10-21T09:58:00.000Z" }),
        nowMs,
      ),
    ).toBe(false);
    expect(Hold.installRequestOpen(reading({ installRequestedAt: undefined }), nowMs)).toBe(false);
    expect(Hold.installRequestOpen(reading({ installHoldUntilMs: nowMs - 1 }), nowMs)).toBe(false);
    // A request without a hold time counts for the hold's own time limit.
    expect(Hold.installRequestOpen(reading({ installHoldUntilMs: null }), nowMs)).toBe(true);
    expect(
      Hold.installRequestOpen(
        reading({ installHoldUntilMs: null }),
        Date.parse("2026-10-21T09:58:00.000Z") + Hold.HOLD_TTL_MS,
      ),
    ).toBe(false);
  });
});

describe("updatePendingFor", () => {
  const reading = (fields: Partial<Hold.AgentStateReading>): Hold.AgentStateReading => ({
    status: "up-to-date",
    message: null,
    updatedAtMs: null,
    handledInstallRequestAt: null,
    installRequestedAt: null,
    installHoldUntilMs: null,
    installedVersion: "1.2.3",
    ...fields,
  });

  it("counts a failed or manual pass that still offers a newer release", () => {
    // "Try again" after a failed Update now: the agent wrote `error` but kept the release.
    for (const status of ["error", "manual-required"]) {
      expect(Hold.updatePendingFor(reading({ status, availableVersion: "1.2.4" }))).toBe(true);
      expect(Hold.updatePendingFor(reading({ status, downloadedVersion: "1.10.0" }))).toBe(true);
      expect(Hold.updatePendingFor(reading({ status, availableVersion: null }))).toBe(false);
    }
    for (const status of Hold.UPDATE_PENDING_STATUSES) {
      expect(Hold.updatePendingFor(reading({ status }))).toBe(true);
    }
  });

  it("ignores an offer that is not newer, or not a version the agent writes", () => {
    for (const offered of ["1.2.3", "1.2.2", "0.9.9", "v1.3.0", "1.3", 13, null]) {
      expect(Hold.updatePendingFor(reading({ status: "error", availableVersion: offered }))).toBe(
        false,
      );
    }
    expect(
      Hold.updatePendingFor(
        reading({ status: "error", installedVersion: null, availableVersion: "9.0.0" }),
      ),
    ).toBe(false);
    // The verified download wins over a later listing.
    expect(
      Hold.updatePendingFor(
        reading({ status: "error", downloadedVersion: "1.2.3", availableVersion: "1.2.4" }),
      ),
    ).toBe(false);
  });
});

it.live("reads a pending update from an agent state left by a failed pass", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "service-update-hold-" });
    const statePath = path.join(dir, "state.json");
    const hold = yield* holdAt(statePath);
    assert.isFalse(yield* hold.updatePending);
    yield* writeJson(statePath, {
      status: "error",
      installedVersion: "0.4.0",
      availableVersion: "0.5.0",
      downloadedVersion: "0.5.0",
    });
    assert.isTrue(yield* hold.updatePending);
    yield* writeJson(statePath, { status: "error", installedVersion: "0.5.0" });
    assert.isFalse(yield* hold.updatePending);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("ends a hold nobody releases when its time runs out", () =>
  Effect.gen(function* () {
    const hold = yield* holdAt(missingStatePath);
    assert.isFalse(yield* hold.isHeld);
    const first = yield* hold.acquire({ ttlMs: 60_000 });
    assert.isTrue(yield* hold.isHeld);
    yield* TestClock.adjust("30 seconds");
    // Asking again extends the same hold.
    const second = yield* hold.acquire({ ttlMs: 60_000 });
    assert.equal(second.holdId, first.holdId);
    assert.isAbove(second.expiresAtMs, first.expiresAtMs);
    yield* TestClock.adjust("45 seconds");
    assert.isTrue(yield* hold.isHeld);
    yield* TestClock.adjust("16 seconds");
    assert.isFalse(yield* hold.isHeld);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("defaults to a fifteen minute hold", () =>
  Effect.gen(function* () {
    const hold = yield* holdAt(missingStatePath);
    yield* hold.acquire();
    yield* TestClock.adjust(Duration.millis(Hold.HOLD_TTL_MS - 1));
    assert.isTrue(yield* hold.isHeld);
    yield* TestClock.adjust("1 millis");
    assert.isFalse(yield* hold.isHeld);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("wakes waiters on release and on expiry", () =>
  Effect.gen(function* () {
    const hold = yield* holdAt(missingStatePath);
    // Not held: returns at once.
    yield* hold.awaitReleased;

    yield* hold.acquire();
    const released = yield* Effect.forkChild(hold.awaitReleased);
    yield* Effect.yieldNow;
    assert.isTrue(yield* hold.release("cancelled"));
    yield* Fiber.join(released);
    assert.isFalse(yield* hold.release("again"));

    yield* hold.acquire({ ttlMs: 10_000 });
    const expired = yield* Effect.forkChild(hold.awaitReleased);
    yield* Effect.yieldNow;
    yield* TestClock.adjust("10 seconds");
    yield* Fiber.join(expired);
    assert.isFalse(yield* hold.isHeld);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("releases itself once the update agent handled this request", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "service-update-hold-" });
    const statePath = path.join(dir, "state.json");
    const configPath = path.join(dir, "config.json");
    const hold = yield* holdAt(statePath, { pollMs: 10 });
    yield* writeJson(statePath, { status: "up-to-date", updatedAt: yield* isoIn(-60_000) });
    yield* hold.acquire();

    // No request yet: an outcome the agent writes now is not about this hold.
    yield* writeJson(statePath, { status: "up-to-date", updatedAt: yield* isoIn(0) });
    yield* Effect.sleep(Duration.millis(60));
    assert.isTrue(yield* hold.isHeld);

    yield* Effect.sleep(Duration.millis(5));
    const requested = yield* isoIn(0);
    yield* writeJson(configPath, { installRequestedAt: requested, installMode: "force" });
    // Mid-pass `downloaded`, before the snapshot: held.
    yield* writeJson(statePath, { status: "downloaded", updatedAt: yield* isoIn(1) });
    yield* Effect.sleep(Duration.millis(60));
    assert.isTrue(yield* hold.isHeld);

    yield* writeJson(statePath, {
      status: "installed",
      updatedAt: yield* isoIn(2),
      handledInstallRequestAt: requested,
    });
    assert.isTrue(yield* awaitSelfRelease(hold));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// 0988: an agent with runs adds `runSupport` to state.json and the desktop
// names the run in config.json (`installRunId`); this service still reads both.
it.live("reads the state of an agent with update runs as before", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "service-update-hold-run-" });
    const statePath = path.join(dir, "state.json");
    const configPath = path.join(dir, "config.json");
    const hold = yield* holdAt(statePath, { pollMs: 10 });
    yield* writeJson(statePath, {
      status: "downloaded",
      updatedAt: yield* isoIn(-60_000),
      runSupport: 1,
    });
    yield* hold.acquire();
    const requested = yield* isoIn(0);
    yield* writeJson(configPath, {
      installRequestedAt: requested,
      installMode: "force",
      installRunId: "0f0e7b0e-5f3a-4c43-9d1e-1c2b3a4d5e6f",
    });
    yield* writeJson(statePath, {
      status: "installing",
      updatedAt: yield* isoIn(1),
      runSupport: 1,
    });
    yield* Effect.sleep(Duration.millis(60));
    assert.isTrue(yield* hold.isHeld);
    assert.isTrue(yield* hold.updatePending);
    yield* writeJson(statePath, {
      status: "installed",
      updatedAt: yield* isoIn(2),
      handledInstallRequestAt: requested,
      runSupport: 1,
    });
    assert.isTrue(yield* awaitSelfRelease(hold));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("ends a hold no install request follows while the agent is idle", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "service-update-hold-no-request-" });
    const statePath = path.join(dir, "state.json");
    // The 2026-10-16 case: an app restart drained a service it did not take
    // down, and the agent never heard of an install.
    yield* writeJson(statePath, { status: "up-to-date", updatedAt: yield* isoIn(-60_000) });
    yield* writeJson(path.join(dir, "config.json"), { installRequestedAt: yield* isoIn(-30_000) });
    const hold = yield* holdAt(statePath, { pollMs: 10, noRequestMs: 100 });
    yield* hold.acquire({ reason: "app-restart" });
    yield* Effect.sleep(Duration.millis(50));
    assert.isTrue(yield* hold.isHeld);
    assert.isTrue(yield* awaitSelfRelease(hold));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("keeps a hold whose request came, and one whose drain is still running", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "service-update-hold-requested-" });
    const statePath = path.join(dir, "state.json");
    yield* writeJson(statePath, { status: "downloaded", updatedAt: yield* isoIn(-60_000) });
    const hold = yield* holdAt(statePath, { pollMs: 10, noRequestMs: 50 });

    // A drain cannot be followed by a request before it ends.
    yield* hold.acquire({ draining: true });
    yield* Effect.sleep(Duration.millis(150));
    assert.isTrue(yield* hold.isHeld);

    yield* hold.acquire();
    yield* writeJson(path.join(dir, "config.json"), {
      installRequestedAt: yield* isoIn(1),
      installMode: "force",
    });
    yield* Effect.sleep(Duration.millis(150));
    assert.isTrue(yield* hold.isHeld);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("keeps a hold without a request while the agent is busy", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "service-update-hold-busy-agent-" });
    const statePath = path.join(dir, "state.json");
    yield* writeJson(statePath, { status: "installing", updatedAt: yield* isoIn(-60_000) });
    const hold = yield* holdAt(statePath, { pollMs: 10, noRequestMs: 50 });
    yield* hold.acquire();
    yield* Effect.sleep(Duration.millis(150));
    assert.isTrue(yield* hold.isHeld);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("an app restart's drain leaves an install hold as it is", () =>
  Effect.gen(function* () {
    const hold = yield* holdAt(missingStatePath);
    const install = yield* hold.acquire({ reason: "install" });
    yield* Effect.sleep(Duration.millis(5));
    const restart = yield* hold.acquire({
      reason: "app-restart",
      ttlMs: Hold.APP_RESTART_HOLD_TTL_MS,
    });
    // Neither shortened nor started over, so the install request still counts.
    assert.deepEqual(restart, { ...install, reason: "install" });
    // An install after an app restart's drain takes the hold over.
    const restartHold = yield* holdAt(missingStatePath);
    yield* restartHold.acquire({ reason: "app-restart", ttlMs: Hold.APP_RESTART_HOLD_TTL_MS });
    const taken = yield* restartHold.acquire({ reason: "install" });
    assert.equal(taken.reason, "install");
    assert.equal(taken.expiresAtMs - taken.startedAtMs, Hold.HOLD_TTL_MS);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("outlasts its time limit while the agent installs, up to the ceiling", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "service-update-hold-busy-" });
    const statePath = path.join(dir, "state.json");
    // The ceiling sits well past the 250 ms check so a loaded host cannot reach it first.
    const hold = yield* holdAt(statePath, { pollMs: 10, maxMs: 2_000 });
    yield* hold.acquire({ ttlMs: 100 });
    yield* Effect.sleep(Duration.millis(5));
    const requested = yield* isoIn(0);
    yield* writeJson(path.join(dir, "config.json"), {
      installRequestedAt: requested,
      installMode: "force",
      installHoldUntil: yield* isoIn(100),
    });
    // The agent writes `installing` once and nothing more until the install ends.
    yield* writeJson(statePath, {
      status: "installing",
      updatedAt: yield* isoIn(1),
      handledInstallRequestAt: requested,
    });
    yield* Effect.sleep(Duration.millis(250));
    assert.isTrue(yield* hold.isHeld);
    // An agent that never finishes does not hold the service past the ceiling.
    assert.isTrue(yield* awaitSelfRelease(hold));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("keeps only the time limit when the agent state is missing or unreadable", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "service-update-hold-missing-" });
    const statePath = path.join(dir, "state.json");
    const hold = yield* holdAt(statePath, { pollMs: 10 });
    yield* hold.acquire();
    yield* writeJson(path.join(dir, "config.json"), { installRequestedAt: yield* isoIn(1) });
    yield* Effect.sleep(Duration.millis(60));
    assert.isTrue(yield* hold.isHeld);
    yield* fs.writeFileString(statePath, "{not json");
    yield* Effect.sleep(Duration.millis(60));
    assert.isTrue(yield* hold.isHeld);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live(
  "records the held process for the update helper and removes the record when the hold ends",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "service-update-hold-marker-" });
      const statePath = path.join(dir, "state.json");
      const markerPath = path.join(dir, Hold.HOLD_MARKER_FILE);
      const readMarker = Effect.map(fs.readFileString(markerPath), (text) => JSON.parse(text));
      // Slow polls and a long first hold, so a loaded machine cannot end the hold early.
      const hold = yield* holdAt(statePath, { pollMs: 1_000 });
      assert.isFalse(yield* fs.exists(markerPath));

      const first = yield* hold.acquire({ ttlMs: 3_000 });
      const marker = yield* readMarker;
      assert.deepEqual(marker, {
        schemaVersion: 1,
        pid: process.pid,
        holdId: first.holdId,
        startedAt: iso(first.startedAtMs),
        expiresAt: iso(first.expiresAtMs),
      });
      assert.equal(((yield* fs.stat(markerPath)).mode & 0o777).toString(8), "600");

      // While the agent works on this hold's request, the extended end is recorded too.
      yield* Effect.sleep(Duration.millis(5));
      const requested = yield* isoIn(0);
      yield* writeJson(path.join(dir, "config.json"), {
        installRequestedAt: requested,
        installMode: "force",
        installHoldUntil: yield* isoIn(30 * 60_000),
      });
      yield* writeJson(statePath, { status: "waiting-for-quiet", updatedAt: yield* isoIn(1) });
      let extended = marker;
      for (
        let attempt = 0;
        attempt < 100 && extended.expiresAt === marker.expiresAt;
        attempt += 1
      ) {
        yield* Effect.sleep(Duration.millis(50));
        extended = yield* readMarker;
      }
      assert.isTrue(yield* hold.isHeld);
      assert.equal(extended.holdId, first.holdId);
      assert.equal(extended.startedAt, marker.startedAt);
      assert.isAbove(Date.parse(extended.expiresAt), first.expiresAtMs);

      assert.isTrue(yield* hold.release("cancelled"));
      assert.isFalse(yield* fs.exists(markerPath));

      // A hold that runs out removes its record when it is next read.
      yield* writeJson(statePath, { status: "up-to-date" });
      yield* hold.acquire({ ttlMs: 20 });
      assert.isTrue(yield* fs.exists(markerPath));
      yield* Effect.sleep(Duration.millis(30));
      assert.isFalse(yield* hold.isHeld);
      assert.isFalse(yield* fs.exists(markerPath));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("removes the record when the service shuts down while held", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "service-update-hold-shutdown-" });
    const markerPath = path.join(dir, Hold.HOLD_MARKER_FILE);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const hold = yield* holdAt(path.join(dir, "state.json"));
        yield* hold.acquire();
        assert.isTrue(yield* fs.exists(markerPath));
      }),
    );
    assert.isFalse(yield* fs.exists(markerPath));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

describe("hold views", () => {
  it.effect("refuses work while held and nothing without a hold", () =>
    Effect.gen(function* () {
      const absent = yield* Hold.optional;
      assert.isFalse(yield* absent.isHeld);
      yield* absent.refuse("message.dispatch");

      const hold = yield* holdAt(missingStatePath);
      const view = yield* Hold.optional.pipe(Effect.provideService(Hold.ServiceUpdateHold, hold));
      yield* view.refuse("message.dispatch");
      assert.deepEqual(yield* Hold.skipWhileHeld(view)(Effect.succeed(1)), Option.some(1));

      yield* hold.acquire();
      const refused = yield* Effect.exit(view.refuse("message.dispatch"));
      assert.isTrue(Exit.isFailure(refused));
      if (Exit.isFailure(refused)) {
        expect(String(refused.cause)).toContain(Hold.SERVICE_UPDATE_IN_PROGRESS_MESSAGE);
      }
      assert.deepEqual(yield* Hold.skipWhileHeld(view)(Effect.succeed(1)), Option.none());
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("holds commands that start work and lets the drain's own commands through", () => {
    for (const type of [
      "message.dispatch",
      "prepared-run.release",
      "queue.resume",
      "delegated_task.request",
      "thread.create",
      "runtime-request.respond",
    ] as const) {
      expect(Hold.isHeldCommand({ type })).toBe(true);
    }
    for (const type of [
      "run.interrupt",
      "queued-run.cancel",
      "thread.stop",
      "thread.background-work.settle",
      "thread.user-input.dismiss",
    ] as const) {
      expect(Hold.isHeldCommand({ type })).toBe(false);
    }
  });
});

describe("orchestrator admission while held", () => {
  const instanceId = ProviderInstanceId.make("codex");
  const adapter = {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () => Effect.die("No provider process needed while held"),
  } as ProviderAdapterV2Shape;
  const projectId = ProjectId.make("project:update-hold");
  const layerDatabase = fixtureProjectDatabase([projectId]);
  const layerHold = Layer.effect(
    Hold.ServiceUpdateHold,
    Hold.makeWithOptions({ agentStatePath: missingStatePath }),
  ).pipe(Layer.provide(NodeServices.layer));
  const layerTest = Layer.mergeAll(
    layerDatabase,
    ProviderReplayHarness.layerWithRegistry(
      { name: "update-hold" },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      { databaseLayer: layerDatabase, runEffectWorker: false },
    ),
  ).pipe(Layer.provideMerge(layerHold));

  it.effect("refuses a new message while held and accepts Stop", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const hold = yield* Hold.ServiceUpdateHold;
      const threadId = ThreadId.make("thread:update-hold");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-update-hold"),
        threadId,
        projectId,
        title: "Held",
        modelSelection: { instanceId, model: "gpt-5.1-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const message = (id: string) => ({
        type: "message.dispatch" as const,
        commandId: CommandId.make(`dispatch-${id}`),
        threadId,
        messageId: MessageId.make(`message-${id}`),
        text: "Continue",
        attachments: [],
        dispatchMode: { type: "defer_start" as const },
        createdBy: "user" as const,
        creationSource: "web" as const,
      });

      yield* hold.acquire();
      const refused = yield* Effect.flip(orchestrator.dispatch(message("held")));
      assert.equal(
        userFacingDispatchErrorMessage(refused),
        Hold.SERVICE_UPDATE_IN_PROGRESS_MESSAGE,
      );
      // A pull request watch that was mid-sweep cannot queue its wake either.
      const wake = yield* Effect.flip(
        orchestrator.dispatch({
          type: "thread.pull-request-watch.sync",
          commandId: CommandId.make("watch-wake-held"),
          threadId,
          host: "github.com",
          repository: "owner/repo",
          number: 7,
          startedAt: "2026-10-12T20:00:00.000Z",
          watch: null,
          wake: {
            messageId: MessageId.make("watch-wake-held"),
            text: "Checks finished",
            notification: { source: { kind: "monitor" }, outcome: "updated", summary: "#7" },
          },
        }),
      );
      assert.equal(userFacingDispatchErrorMessage(wake), Hold.SERVICE_UPDATE_IN_PROGRESS_MESSAGE);
      // The drain's own commands still pass.
      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("stop-while-held"),
        threadId,
      });

      yield* hold.release("cancelled");
      yield* orchestrator.dispatch(message("released"));
    }).pipe(Effect.provide(layerTest)),
  );
});

describe("orchestrator admission while an install's gate is live", () => {
  const instanceId = ProviderInstanceId.make("codex");
  const adapter = {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () => Effect.die("No provider process needed while gated"),
  } as ProviderAdapterV2Shape;
  const projectId = ProjectId.make("project:update-gate");
  const layerDatabase = fixtureProjectDatabase([projectId]);
  // The gate's file is removed through this, as the helper does after verifying.
  let clearGate: Effect.Effect<void, import("effect/PlatformError").PlatformError> = Effect.void;
  const layerGate = Layer.effect(
    Hold.ServiceUpdateHold,
    Effect.map(makeGatedHold(), (gated) => {
      clearGate = gated.clear;
      return gated.hold;
    }),
  ).pipe(Layer.provide(NodeServices.layer));
  const layerTest = Layer.mergeAll(
    layerDatabase,
    ProviderReplayHarness.layerWithRegistry(
      { name: "update-gate" },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      { databaseLayer: layerDatabase, runEffectWorker: false },
    ),
  ).pipe(Layer.provideMerge(layerGate));

  it.effect("refuses remote messages and watch wakes until the helper clears the gate", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const hold = yield* Hold.ServiceUpdateHold;
      const threadId = ThreadId.make("thread:update-gate");
      const message = (id: string) => ({
        type: "message.dispatch" as const,
        commandId: CommandId.make(`dispatch-${id}`),
        threadId,
        messageId: MessageId.make(`message-${id}`),
        text: "Continue",
        attachments: [],
        dispatchMode: { type: "defer_start" as const },
        createdBy: "user" as const,
        creationSource: "server" as const,
      });
      // Creating the thread starts work too, so the gate refuses it.
      const create = {
        type: "thread.create" as const,
        commandId: CommandId.make("create-update-gate"),
        threadId,
        projectId,
        title: "Gated",
        modelSelection: { instanceId, model: "gpt-5.1-codex" },
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        createdBy: "user" as const,
        creationSource: "web" as const,
      };
      assert.equal(
        userFacingDispatchErrorMessage(yield* Effect.flip(orchestrator.dispatch(create))),
        Hold.SERVICE_UPDATE_VERIFYING_MESSAGE,
      );
      assert.equal(
        userFacingDispatchErrorMessage(yield* Effect.flip(orchestrator.dispatch(message("gated")))),
        Hold.SERVICE_UPDATE_VERIFYING_MESSAGE,
      );
      const wake = yield* Effect.flip(
        orchestrator.dispatch({
          type: "thread.pull-request-watch.sync",
          commandId: CommandId.make("watch-wake-gated"),
          threadId,
          host: "github.com",
          repository: "owner/repo",
          number: 7,
          startedAt: "2026-10-12T20:00:00.000Z",
          watch: null,
          wake: {
            messageId: MessageId.make("watch-wake-gated"),
            text: "Checks finished",
            notification: { source: { kind: "monitor" }, outcome: "updated", summary: "#7" },
          },
        }),
      );
      assert.equal(userFacingDispatchErrorMessage(wake), Hold.SERVICE_UPDATE_VERIFYING_MESSAGE);

      yield* clearGate;
      assert.isTrue(yield* awaitGateOpen(hold));
      yield* orchestrator.dispatch(create);
      yield* orchestrator.dispatch(message("after-gate"));
    }).pipe(Effect.provide(layerTest)),
  );
});

describe("automaticInstallUnderway", () => {
  it("is true only while an install waits for quiet or installs", () => {
    expect(Hold.automaticInstallUnderway({ status: "waiting-for-quiet" })).toBe(true);
    expect(Hold.automaticInstallUnderway({ status: "installing" })).toBe(true);
    // Installed, failed, refused, or nothing on its way: what its sweep closed is asked again.
    for (const status of ["up-to-date", "error", "manual-required", "available", undefined])
      expect(Hold.automaticInstallUnderway({ status })).toBe(false);
  });
});
