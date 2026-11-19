/**
 * The Away session behind a lid close an earlier release left (1267 #4, #5,
 * 1390 AC-36): that release recorded the session and paused routines before
 * it answered (`previousRelease.awaySleep.test.fixture.ts`). This version
 * starts nothing on a lid close; its wake closes the session (nothing moved)
 * or fills it (work moved) before it answers, so auto bring back and the
 * wake card read it.
 */
import {
  AWAY_INTENT_CANCEL_PATH,
  AWAY_INTENT_STATUS_PATH,
  type AwayConfig,
  EnvironmentId,
  ProjectId,
} from "@specweave-studio/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import type { AwayPeerPost } from "./awayPeerCall.ts";
import { makeAwaySleep, memorySleepStore } from "./awaySleepRoute.ts";
import type { SleepSessionPort } from "./awaySleepSession.ts";
import { memoryWakeHoldStore } from "./AwayWakeHold.ts";
import * as Previous from "./previousRelease.awaySleep.test.fixture.ts";

const M4 = EnvironmentId.make("m4");
const MS = EnvironmentId.make("ministorm");
const T0 = Date.parse("2026-11-09T22:00:00.000Z");
const MINUTE = 60_000;

const config = (patch: Partial<AwayConfig> = {}): AwayConfig => ({
  target: MS,
  sleepTrigger: "always",
  graceMinutes: 2,
  bringBack: "prompt",
  coordinatorScope: "live",
  ...patch,
});

const setup = (options: {
  readonly moved: boolean;
  readonly mayStart?: boolean;
  readonly bringBack?: AwayConfig["bringBack"];
}) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(T0);
    const log: string[] = [];
    const port: SleepSessionPort = {
      mayStart: Effect.succeed(options.mayStart ?? true),
      begin: (sleep) => Effect.sync(() => void log.push(`begin:${sleep.threadIds.join(",")}`)),
      nothingMoved: Effect.sync(() => {
        log.push("nothingMoved");
        return true;
      }),
      moved: () =>
        Effect.sync(() => {
          log.push("moved");
          return true;
        }),
    };
    const post: AwayPeerPost = (_target, path) =>
      Effect.sync(() => {
        log.push(`post:${path}`);
        if (path === AWAY_INTENT_CANCEL_PATH)
          return { status: 200, json: { cancelled: options.moved ? 0 : 1 } };
        if (path === AWAY_INTENT_STATUS_PATH)
          return {
            status: 200,
            json: {
              intentState: "done",
              projects: [{ projectId: "easychamp", takenOver: true, epoch: 2 }],
              receivedAt: "2026-11-09T22:10:00.000Z",
            },
          };
        return { status: 200, json: {} };
      });
    const deps: Previous.AwaySleepDeps = {
      self: M4,
      store: memorySleepStore(),
      hold: memoryWakeHoldStore(),
      config: Effect.succeed(config({ bringBack: options.bringBack ?? "prompt" })),
      ids: () =>
        Effect.succeed({ projectIds: [ProjectId.make("easychamp")], threadIds: ["thread-1"] }),
      post,
      away: port,
      giveWay: () => Effect.succeed(true),
    };
    const before = yield* Previous.makeAwaySleep(deps);
    const away = yield* makeAwaySleep(deps);
    return { before, away, log };
  });

describe("the Away session of a lid close an earlier release left", () => {
  it.effect("the earlier release recorded the session; this version records none", () =>
    Effect.gen(function* () {
      const { before, away, log } = yield* setup({ moved: false });
      const left = yield* before.sleep({ onBattery: true });
      assert.deepEqual(left.answer, { outcome: "left" });
      assert.deepEqual(log, ["begin:thread-1"]);
      // The lid closes again after the update: no second session, nothing sent.
      const decision = yield* away.sleep({ onBattery: true });
      yield* decision.send;
      assert.deepEqual(decision.answer, { outcome: "skipped" });
      assert.deepEqual(log, ["begin:thread-1"]);
    }),
  );

  it.effect("a lid close with no session open records none and sends nothing", () =>
    Effect.gen(function* () {
      const { away, log } = yield* setup({ moved: false });
      const decision = yield* away.sleep({ onBattery: true });
      yield* decision.send;
      assert.deepEqual(decision.answer, { outcome: "skipped" });
      assert.deepEqual(log, []);
    }),
  );

  it.effect("a wake before the target acted closes the session, routines on again", () =>
    Effect.gen(function* () {
      const { before, away, log } = yield* setup({ moved: false });
      yield* (yield* before.sleep({ onBattery: true })).send;
      yield* TestClock.adjust(MINUTE);
      assert.deepEqual(yield* away.wake({ onBattery: true }), { outcome: "none" });
      assert.include(log, "nothingMoved");
      assert.notInclude(log, "moved");
    }),
  );

  it.effect("a wake after it acted fills the session before the card or auto bring back", () =>
    Effect.gen(function* () {
      const { before, away, log } = yield* setup({ moved: true, bringBack: "auto-on-power" });
      let brought = 0;
      yield* away.onAutoBringBack(Effect.sync(() => void ((brought += 1), log.push("bringBack"))));
      yield* (yield* before.sleep({ onBattery: false })).send;
      yield* TestClock.adjust(10 * MINUTE);
      assert.deepEqual(yield* away.wake({ onBattery: false }), { outcome: "auto" });
      yield* Effect.yieldNow;
      assert.strictEqual(brought, 1);
      assert.isBelow(log.indexOf("moved"), log.indexOf("bringBack"));
      assert.notInclude(log, "nothingMoved");
    }),
  );
});
