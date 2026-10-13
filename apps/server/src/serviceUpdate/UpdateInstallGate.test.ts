import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";

import * as Hold from "./ServiceUpdateHold.ts";
import * as Gate from "./UpdateInstallGate.ts";
import { GATE_POLL_MS, awaitGateOpen, makeGatedHold } from "./UpdateInstallGate.testkit.ts";

const NOW = Date.parse("2026-10-12T20:00:00.000Z");
const alive = () => true;

describe("installGateUntil", () => {
  const until = (
    marker: Gate.InstallGateMarker,
    options: {
      mtimeMs?: number | null;
      nowMs?: number;
      bootMs?: number | null;
      isAlive?: (pid: number) => boolean;
    } = {},
  ) =>
    Gate.installGateUntil({
      marker,
      mtimeMs: options.mtimeMs ?? null,
      nowMs: options.nowMs ?? NOW,
      bootMs: options.bootMs ?? null,
      isAlive: options.isAlive ?? alive,
    });

  it("reads the helper and the time it was written", () => {
    expect(Gate.parseInstallGate('{"helperPid":321,"at":"2026-10-12T20:00:00.000Z"}')).toEqual({
      atMs: NOW,
      helperPid: 321,
    });
    // Half written or broken: still a gate, timed by the file.
    expect(Gate.parseInstallGate('{"helperPid":3')).toEqual({ atMs: null, helperPid: null });
    expect(Gate.parseInstallGate('{"helperPid":1,"at":"soon"}')).toEqual({
      atMs: null,
      helperPid: null,
    });
  });

  it("holds while its helper runs, for at most the gate's time limit", () => {
    const marker = { atMs: NOW, helperPid: 321 };
    expect(until(marker)).toBe(NOW + Gate.INSTALL_GATE_MAX_MS);
    expect(until(marker, { nowMs: NOW + Gate.INSTALL_GATE_MAX_MS - 1 })).toBe(
      NOW + Gate.INSTALL_GATE_MAX_MS,
    );
    expect(until(marker, { nowMs: NOW + Gate.INSTALL_GATE_MAX_MS })).toBeNull();
  });

  it("ends as soon as its helper exits", () => {
    const seen: Array<number> = [];
    const dead = (pid: number) => {
      seen.push(pid);
      return false;
    };
    expect(until({ atMs: NOW, helperPid: 321 }, { isAlive: dead })).toBeNull();
    expect(seen).toEqual([321]);
  });

  it("ignores a gate written before the machine last started, whoever holds its pid", () => {
    const marker = { atMs: NOW - 2 * 60_000, helperPid: 321 };
    expect(until(marker, { bootMs: NOW - 60_000 })).toBeNull();
    expect(
      until({ atMs: null, helperPid: null }, { mtimeMs: NOW - 2_000, bootMs: NOW - 1_000 }),
    ).toBeNull();
    expect(until(marker, { bootMs: NOW - 3 * 60_000 })).toBe(
      NOW - 2 * 60_000 + Gate.INSTALL_GATE_MAX_MS,
    );
  });

  it("counts a helper pid this process may not signal as exited", () => {
    // pid 1 is launchd (init on Linux): it runs, but as root, so signalling it fails with EPERM.
    expect(Gate.isHelperRunning(1)).toBe(false);
    expect(Gate.isHelperRunning(process.pid)).toBe(true);
    expect(Gate.isHelperRunning(2 ** 22 + 12_345)).toBe(false);
  });

  it("times a gate without a readable time by its file, and never one dated ahead", () => {
    expect(until({ atMs: null, helperPid: null }, { mtimeMs: NOW - 1_000 })).toBe(
      NOW - 1_000 + Gate.INSTALL_GATE_MAX_MS,
    );
    expect(until({ atMs: null, helperPid: null })).toBeNull();
    const ahead = NOW + 24 * 60 * 60_000;
    expect(until({ atMs: ahead, helperPid: null }, { mtimeMs: NOW })).toBe(
      NOW + Gate.INSTALL_GATE_MAX_MS,
    );
    expect(until({ atMs: ahead, helperPid: null }, { mtimeMs: ahead })).toBeNull();
  });
});

describe("the hold across an install's restart", () => {
  it.effect("a process started during an install begins gated and refuses new work", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const { hold } = yield* makeGatedHold();
      // Gated from construction, before any poll ran.
      assert.isTrue(yield* hold.installGated);
      assert.isTrue(yield* hold.isHeld);
      // Not "Update now"'s own hold: the drain and its status do not see one.
      assert.isTrue(Option.isNone(yield* hold.current));

      const view = yield* Hold.optional.pipe(Effect.provideService(Hold.ServiceUpdateHold, hold));
      const refused = yield* Effect.exit(view.refuse("message.dispatch"));
      assert.isTrue(Exit.isFailure(refused));
      if (Exit.isFailure(refused)) {
        expect(String(refused.cause)).toContain(Hold.SERVICE_UPDATE_VERIFYING_MESSAGE);
      }
      assert.deepEqual(yield* Hold.skipWhileHeld(view)(Effect.succeed(1)), Option.none());
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("opens once the helper clears its gate, and wakes waiters", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const { hold, clear } = yield* makeGatedHold();
      const waiting = yield* Effect.forkChild(hold.awaitReleased);
      yield* TestClock.adjust(Duration.millis(GATE_POLL_MS * 5));
      assert.isUndefined(waiting.pollUnsafe());
      assert.isTrue(yield* hold.isHeld);

      yield* clear;
      assert.isTrue(yield* awaitGateOpen(hold));
      // A waiter looks again on its next poll.
      yield* TestClock.adjust(Duration.millis(GATE_POLL_MS));
      yield* Fiber.join(waiting);
      assert.isFalse(yield* hold.isHeld);
      const view = yield* Hold.optional.pipe(Effect.provideService(Hold.ServiceUpdateHold, hold));
      yield* view.refuse("message.dispatch");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("opens when the helper exits without clearing its gate", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      let helperAlive = true;
      const { hold } = yield* makeGatedHold({ helperAlive: () => helperAlive });
      assert.isTrue(yield* hold.isHeld);
      helperAlive = false;
      assert.isTrue(yield* awaitGateOpen(hold));
      assert.isFalse(yield* hold.isHeld);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("never holds past the gate's time limit, even while its helper runs", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      // A slow poll keeps twenty test minutes to a few file reads.
      const { hold } = yield* makeGatedHold({ pollMs: 60_000 });
      yield* TestClock.adjust(Duration.millis(Gate.INSTALL_GATE_MAX_MS - 1));
      assert.isTrue(yield* hold.isHeld);
      yield* TestClock.adjust(Duration.millis(1));
      assert.isFalse(yield* hold.isHeld);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("ignores a gate the helper left behind long ago", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "update-install-gate-stale-" });
      yield* TestClock.setTime(NOW);
      const at = DateTime.formatIso(
        DateTime.makeUnsafe((yield* Clock.currentTimeMillis) - Gate.INSTALL_GATE_MAX_MS),
      );
      yield* fs.writeFileString(
        path.join(dir, Gate.INSTALL_GATE_FILE),
        JSON.stringify({ helperPid: 4242, at }),
      );
      const hold = yield* Hold.makeWithOptions({
        agentStatePath: path.join(dir, "state.json"),
        isAlive: alive,
      });
      assert.isFalse(yield* hold.isHeld);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("a gate seen ended stays ended when its helper's pid is reused, and is removed", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const fs = yield* FileSystem.FileSystem;
      let pidInUse = true;
      const { hold, gatePath } = yield* makeGatedHold({ helperAlive: () => pidInUse });
      assert.isTrue(yield* hold.isHeld);
      // The helper is killed: nothing clears its gate.
      pidInUse = false;
      assert.isTrue(yield* awaitGateOpen(hold));
      assert.isFalse(yield* fs.exists(gatePath));
      // Another process takes the pid; the old gate must not come back, even if the file does.
      pidInUse = true;
      const left = JSON.stringify({
        helperPid: 4242,
        at: DateTime.formatIso(DateTime.makeUnsafe(NOW)),
      });
      yield* fs.writeFileString(gatePath, left);
      const reader = yield* Gate.makeInstallGateReader({
        gatePath,
        bootMs: null,
        isAlive: () => pidInUse,
      });
      // A fresh reader judges it live again, which is why the first one removed it.
      assert.isNotNull(yield* reader.read);
      for (let poll = 0; poll < 5; poll += 1) {
        yield* TestClock.adjust(Duration.millis(GATE_POLL_MS));
        yield* TestClock.withLive(Effect.sleep(Duration.millis(5)));
      }
      assert.isFalse(yield* hold.isHeld);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("a gate from before the machine started does not hold a restarted service", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      // A reboot mid-install: a root daemon may now hold the helper's pid.
      const { hold, gatePath } = yield* makeGatedHold({ bootMs: NOW + 1 });
      assert.isFalse(yield* hold.isHeld);
      assert.isFalse(yield* (yield* FileSystem.FileSystem).exists(gatePath));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("a new install's gate closes again after an earlier one ended", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      let helperAlive = false;
      const { hold, gatePath } = yield* makeGatedHold({ helperAlive: () => helperAlive });
      assert.isFalse(yield* hold.isHeld);
      helperAlive = true;
      yield* TestClock.adjust(Duration.millis(1_000));
      const at = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
      yield* (yield* FileSystem.FileSystem).writeFileString(
        gatePath,
        JSON.stringify({ helperPid: 4343, at }),
      );
      for (let poll = 0; poll < 200 && !(yield* hold.isHeld); poll += 1) {
        yield* TestClock.adjust(Duration.millis(GATE_POLL_MS));
        yield* TestClock.withLive(Effect.sleep(Duration.millis(5)));
      }
      assert.isTrue(yield* hold.isHeld);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps Update now's hold and the gate apart: releasing one leaves the other", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const { hold, clear } = yield* makeGatedHold();
      yield* hold.acquire();
      const view = yield* Hold.optional.pipe(Effect.provideService(Hold.ServiceUpdateHold, hold));
      const beforeRestart = yield* Effect.flip(view.refuse("message.dispatch"));
      assert.equal(beforeRestart.message, Hold.SERVICE_UPDATE_IN_PROGRESS_MESSAGE);
      yield* hold.release("agent-installed");
      assert.isTrue(yield* hold.isHeld);
      yield* clear;
      assert.isTrue(yield* awaitGateOpen(hold));
      assert.isFalse(yield* hold.isHeld);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
