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
import * as Deferred from "effect/Deferred";
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
      // Nor in its own millisecond: the agent had not read it yet.
      expect(verdict({ status, updatedAtMs: Date.parse(requested) })).toEqual({ type: "none" });
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

it.effect("counts the holds that end in this process", () =>
  Effect.gen(function* () {
    const hold = yield* holdAt(missingStatePath);
    assert.equal(yield* hold.releaseCount, 0);
    yield* hold.acquire();
    yield* hold.release("cancelled");
    assert.equal(yield* hold.releaseCount, 1);
    // Nothing held: a release that ends nothing does not count.
    assert.isFalse(yield* hold.release("again"));
    assert.equal(yield* hold.releaseCount, 1);
    yield* hold.acquire({ ttlMs: 10_000 });
    yield* TestClock.adjust("10 seconds");
    assert.isFalse(yield* hold.isHeld);
    assert.equal(yield* hold.releaseCount, 2);
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
    // Polls every 10 ms see no request well before it is due: the hold must survive
    // them. 1.5 s leaves a loaded Windows runner, whose 50 ms sleep has taken over
    // 100 ms, a wide margin before the no-request release may happen.
    const hold = yield* holdAt(statePath, { pollMs: 10, noRequestMs: 1_500 });
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
    // The request must be on disk before the no-request release is due. A 50 ms
    // window lost that race on a loaded Windows runner (PR #690, job 121048287859):
    // the config write and the next poll took longer. 1 s keeps the write far
    // ahead of it; each check then waits until several polls past the due time,
    // so the release had every chance to happen.
    const noRequestMs = 1_000;
    const hold = yield* holdAt(statePath, { pollMs: 10, noRequestMs });
    const pastNoRequestDue = (startedAtMs: number) =>
      Effect.gen(function* () {
        const dueAtMs = startedAtMs + noRequestMs + 200;
        yield* Effect.sleep(
          Duration.millis(Math.max(0, dueAtMs - (yield* Clock.currentTimeMillis))),
        );
      });

    // A drain cannot be followed by a request before it ends.
    const drain = yield* hold.acquire({ draining: true });
    yield* pastNoRequestDue(drain.startedAtMs);
    assert.isTrue(yield* hold.isHeld);

    const requested = yield* hold.acquire();
    yield* writeJson(path.join(dir, "config.json"), {
      installRequestedAt: yield* isoIn(1),
      installMode: "force",
    });
    yield* pastNoRequestDue(requested.startedAtMs);
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
    // Each poll extends the hold to four polls ahead, so it lapses only if one poll
    // gap exceeds 4 * pollMs. Loaded Windows runners stalled the poll fiber past
    // 200 ms (50 ms polls), so polls are 250 ms: a 1 s stall is tolerated. The first
    // ttl (1 s) leaves three polls to see `installing`; the check at 1.5 s is past it,
    // so only the extension can keep the hold; the 4 s ceiling is well after the check.
    const pollMs = 250;
    const ttlMs = 1_000;
    const hold = yield* holdAt(statePath, { pollMs, maxMs: 4_000 });
    yield* hold.acquire({ ttlMs });
    yield* Effect.sleep(Duration.millis(5));
    const requested = yield* isoIn(0);
    yield* writeJson(path.join(dir, "config.json"), {
      installRequestedAt: requested,
      installMode: "force",
      installHoldUntil: yield* isoIn(ttlMs),
    });
    // The agent writes `installing` once and nothing more until the install ends.
    yield* writeJson(statePath, {
      status: "installing",
      updatedAt: yield* isoIn(1),
      handledInstallRequestAt: requested,
    });
    yield* Effect.sleep(Duration.millis(1_500));
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
      // The first hold ends unless a poll extends it, and an extension reaches four
      // polls ahead, so the first ttl must sit below 4 * pollMs. 2 s polls and a 7 s
      // ttl leave a poll 5 s to run before the hold lapses (1 s polls and a 3 s ttl
      // left 2 s, close to the stalls a loaded Windows runner shows).
      const hold = yield* holdAt(statePath, { pollMs: 2_000 });
      assert.isFalse(yield* fs.exists(markerPath));

      const first = yield* hold.acquire({ ttlMs: 7_000 });
      const marker = yield* readMarker;
      assert.deepEqual(marker, {
        schemaVersion: 1,
        pid: process.pid,
        holdId: first.holdId,
        startedAt: iso(first.startedAtMs),
        expiresAt: iso(first.expiresAtMs),
      });
      // POSIX permission bits; Windows has no owner-only file mode.
      if (process.platform !== "win32") {
        assert.equal(((yield* fs.stat(markerPath)).mode & 0o777).toString(8), "600");
      }

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
      // Up to 10 s: the first poll after the request is about 2 s away.
      for (
        let attempt = 0;
        attempt < 200 && extended.expiresAt === marker.expiresAt;
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

describe("carriedHoldFor", () => {
  // M4, 2026-10-28: the helper restarted pid 66303, held for this request, at 06:05:01.
  const nowMs = Date.parse("2026-10-28T06:05:30.000Z");
  const request = "2026-10-28T06:04:56.998Z";
  const until = "2026-10-28T06:19:51.000Z";
  const input = (
    marker: Partial<Hold.CarriedHoldInput["marker"]> = {},
    config: Partial<Hold.CarriedHoldInput["config"]> = {},
    rest: Partial<Omit<Hold.CarriedHoldInput, "marker" | "config">> = {},
  ): Hold.CarriedHoldInput => ({
    marker: {
      servicePid: 66303,
      restartedAt: "2026-10-28T06:05:01+00:00",
      request,
      installRunId: "run-1",
      until,
      ...marker,
    },
    config: {
      installMode: "force",
      installRequestedAt: request,
      installHoldUntil: "2026-10-28T06:34:56.998Z",
      installRunId: "run-1",
      ...config,
    },
    handledInstallRequestAt: null,
    pid: 53620,
    nowMs,
    ...rest,
  });

  it("carries the hold for the open forced request it was restarted under, to the old end", () => {
    expect(Hold.carriedHoldFor(input())).toEqual({
      request,
      requestedAtMs: Date.parse(request),
      untilMs: Date.parse(until),
    });
    // A cancel made before the request does not count; neither does a request without a run.
    expect(Hold.carriedHoldFor(input({}, { installCancelledAt: "2026-10-28T06:00:00Z" }))).not.toBe(
      null,
    );
    expect(
      Hold.carriedHoldFor(input({ installRunId: null }, { installRunId: undefined })),
    ).not.toBe(null);
  });

  it("starts normally for anything but that open, uncancelled, unexpired request", () => {
    const cases: Record<string, Hold.CarriedHoldInput> = {
      "no request in the marker": input({ request: undefined }),
      "another request": input({}, { installRequestedAt: "2026-10-28T06:05:10.000Z" }),
      "another run": input({ installRunId: "run-0" }),
      "not forced": input({}, { installMode: "normal" }),
      cancelled: input({}, { installCancelledAt: "2026-10-28T06:05:05Z" }),
      "unreadable cancel": input({}, { installCancelledAt: "later" }),
      "handled by the agent": input({}, {}, { handledInstallRequestAt: request }),
      "hold already ended": input({ until: "2026-10-28T06:05:30.000Z" }),
      "request window over": input({}, { installHoldUntil: "2026-10-28T06:05:00.000Z" }),
      "this very process": input({}, {}, { pid: 66303 }),
      "request after the restart": input({ restartedAt: "2026-10-28T06:04:50+00:00" }),
      "restart in the future": input({ restartedAt: "2026-10-28T06:06:00+00:00" }),
      "no end": input({ until: undefined }),
    };
    for (const [name, value] of Object.entries(cases)) {
      expect(Hold.carriedHoldFor(value), name).toBe(null);
    }
  });
});

const carriedFiles = (dir: string, path: Path.Path, marker: Record<string, unknown> = {}) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const request = iso(now - 30_000);
    yield* writeJson(path.join(dir, "state.json"), {
      status: "waiting-for-quiet",
      updatedAt: iso(now - 20_000),
    });
    yield* writeJson(path.join(dir, "config.json"), {
      installMode: "force",
      installRequestedAt: request,
      installHoldUntil: iso(now + Hold.HOLD_TTL_MS),
      installRunId: "run-1",
    });
    const untilMs = now + 600_000;
    yield* writeJson(path.join(dir, Hold.DATABASE_RESTART_MARKER_FILE), {
      schemaVersion: 1,
      servicePid: process.pid + 1,
      restartedAt: iso(now - 10_000),
      request,
      installRunId: "run-1",
      until: iso(untilMs),
      ...marker,
    });
    return { request, untilMs };
  });

it.live("a service restarted while held starts held for the same request", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "service-update-hold-carried-" });
    const { request, untilMs } = yield* carriedFiles(dir, path);
    const hold = yield* holdAt(path.join(dir, "state.json"), { pollMs: 10, noRequestMs: 50 });
    assert.isTrue(yield* hold.isHeld);
    const current = Option.getOrThrow(yield* hold.current);
    assert.equal(current.request, request);
    assert.equal(current.expiresAtMs, untilMs);
    // The helper's reap reads the request it may accept from hold.json.
    const marker = JSON.parse(yield* fs.readFileString(path.join(dir, Hold.HOLD_MARKER_FILE)));
    assert.equal(marker.pid, process.pid);
    assert.equal(marker.request, request);
    assert.equal(marker.expiresAt, iso(untilMs));
    // The request is there, made before this hold began: polls keep the hold, never past its end.
    yield* Effect.sleep(Duration.millis(150));
    assert.isTrue(yield* hold.isHeld);
    assert.equal(Option.getOrThrow(yield* hold.current).expiresAtMs, untilMs);
    // A new Update now makes it an ordinary hold.
    const again = yield* hold.acquire();
    assert.isUndefined(again.request);
    const rewritten = JSON.parse(yield* fs.readFileString(path.join(dir, Hold.HOLD_MARKER_FILE)));
    assert.isUndefined(rewritten.request);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("a carried hold ends when the agent finishes with its request", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "service-update-hold-carried-end-" });
    const { request } = yield* carriedFiles(dir, path);
    const hold = yield* holdAt(path.join(dir, "state.json"), { pollMs: 10 });
    assert.isTrue(yield* hold.isHeld);
    yield* writeJson(path.join(dir, "state.json"), {
      status: "error",
      updatedAt: yield* isoIn(0),
      handledInstallRequestAt: request,
    });
    assert.isTrue(yield* awaitSelfRelease(hold));
    assert.isFalse(yield* fs.exists(path.join(dir, Hold.HOLD_MARKER_FILE)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("a restart for another request, an expired hold or a cancel starts unheld", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cases: ReadonlyArray<Record<string, unknown>> = [
      { request: "2026-10-28T06:00:00.000Z" },
      { until: yield* isoIn(-1_000) },
      { request: undefined },
      { installRunId: "run-0" },
    ];
    for (const marker of cases) {
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "service-update-hold-not-carried-" });
      yield* carriedFiles(dir, path, marker);
      const hold = yield* holdAt(path.join(dir, "state.json"));
      assert.isFalse(yield* hold.isHeld, JSON.stringify(marker));
      assert.isFalse(yield* fs.exists(path.join(dir, Hold.HOLD_MARKER_FILE)));
    }
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "service-update-hold-cancelled-" });
    const { request } = yield* carriedFiles(dir, path);
    yield* writeJson(path.join(dir, "config.json"), {
      installMode: "force",
      installRequestedAt: request,
      installCancelledAt: yield* isoIn(0),
      installRunId: "run-1",
    });
    assert.isFalse(yield* (yield* holdAt(path.join(dir, "state.json"))).isHeld);
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
  let admissionPause:
    | { entered: Deferred.Deferred<void>; resume: Deferred.Deferred<void> }
    | undefined;
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
    Hold.makeWithOptions({ agentStatePath: missingStatePath }).pipe(
      Effect.map(
        (hold) =>
          ({
            ...hold,
            withAdmission: (action, effect) =>
              hold.withAdmission(
                action,
                Effect.gen(function* () {
                  const pause = action === "message.dispatch" ? admissionPause : undefined;
                  if (pause !== undefined) {
                    admissionPause = undefined;
                    yield* Deferred.succeed(pause.entered, undefined);
                    yield* Deferred.await(pause.resume);
                  }
                  return yield* effect;
                }),
              ),
          }) satisfies Hold.ServiceUpdateHoldShape,
      ),
    ),
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
  it.effect(
    "fences a real dispatch delayed after admission until its starting run is committed",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const hold = yield* Hold.ServiceUpdateHold;
        const threadId = ThreadId.make("thread:late-before-update");
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create-late-update"),
          threadId,
          projectId,
          title: "Late",
          modelSelection: { instanceId, model: "gpt-5.1-codex" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        const entered = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        admissionPause = { entered, resume };
        const message = yield* orchestrator
          .dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("late-update-message"),
            threadId,
            messageId: MessageId.make("late-update-message"),
            text: "Admitted before hold",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        assert.isTrue(Option.isSome(yield* hold.acquireIfUnheld(120_000)));
        const fence = yield* hold.awaitAdmissions.pipe(Effect.forkScoped);
        assert.isUndefined(fence.pollUnsafe());
        assert.equal((yield* orchestrator.getThreadProjection(threadId)).runs.length, 0);
        yield* Deferred.succeed(resume, undefined);
        yield* Fiber.join(message);
        yield* Fiber.join(fence);
        assert.equal(
          (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.status,
          "starting",
        );
        assert.isTrue(yield* hold.isHeld);
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

describe("conditional restart ownership and admission", () => {
  it.effect("grants one lease to concurrent callers and never releases a foreign hold", () =>
    Effect.gen(function* () {
      const hold = yield* holdAt(missingStatePath);
      const attempts = yield* Effect.all(
        [hold.acquireIfUnheld(120_000), hold.acquireIfUnheld(120_000)],
        { concurrency: "unbounded" },
      );
      const leases = attempts.filter(Option.isSome);
      assert.equal(leases.length, 1);
      const token = leases[0]!.value.leaseToken!;
      assert.isFalse(yield* hold.releaseLease("foreign", "busy"));
      assert.isTrue(yield* hold.isHeld);
      assert.isTrue(Option.isSome(yield* hold.confirmLease(token, 120_000)));
      yield* hold.acquire({ reason: "app-restart" });
      assert.isTrue(Option.isNone(yield* hold.confirmLease(token, 120_000)));
      assert.isFalse(yield* hold.releaseLease(token, "aborted"));
      assert.isTrue(yield* hold.isHeld);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses to revive an expired lease", () =>
    Effect.gen(function* () {
      const hold = yield* holdAt(missingStatePath);
      const lease = yield* hold.acquireIfUnheld(10);
      assert.isTrue(Option.isSome(lease));
      if (Option.isNone(lease)) return;
      yield* TestClock.adjust(Duration.millis(11));
      assert.isTrue(Option.isNone(yield* hold.confirmLease(lease.value.leaseToken!, 120_000)));
      assert.isFalse(yield* hold.isHeld);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("waits for admitted persistence and refuses new work while the lease is live", () =>
    Effect.gen(function* () {
      const hold = yield* holdAt(missingStatePath);
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const committed = yield* Deferred.make<void>();
      const command = yield* hold
        .withAdmission(
          "message.dispatch",
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(resume);
            yield* Deferred.succeed(committed, undefined);
          }),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const lease = yield* hold.acquireIfUnheld(120_000);
      assert.isTrue(Option.isSome(lease));
      const fenced = yield* hold.awaitAdmissions.pipe(
        Effect.andThen(Deferred.isDone(committed)),
        Effect.forkScoped,
      );
      assert.isUndefined(fenced.pollUnsafe());
      const refused = yield* Effect.flip(hold.withAdmission("message.dispatch", Effect.void));
      assert.equal(refused._tag, "ServiceUpdateInProgressError");
      yield* Deferred.succeed(resume, undefined);
      yield* Fiber.join(command);
      assert.isTrue(yield* Fiber.join(fenced));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
