/**
 * The sleep trigger with the Away session behind it (1267 #4, #5): a lid
 * close records the session and pauses routines before it answers; a wake
 * closes it (nothing moved) or fills it (work moved) before it answers, so
 * auto bring back and the wake card read it; a lid close with work still away
 * leaves nothing new; handoff-off threads never go into the intent.
 */
import {
  AWAY_INTENT_CANCEL_PATH,
  AWAY_INTENT_STATUS_PATH,
  type AwayConfig,
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  type Project,
  ProjectId,
} from "@specweave-studio/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import type { AwayPeerPost } from "./awayPeerCall.ts";
import { makeAwaySleep, memorySleepStore, sleepIntentIds } from "./awaySleepRoute.ts";
import type { SleepSessionPort } from "./awaySleepSession.ts";
import { memoryWakeHoldStore } from "./AwayWakeHold.ts";

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
      nothingMoved: Effect.sync(() => void log.push("nothingMoved")),
      moved: Effect.sync(() => void log.push("moved")),
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
    const away = yield* makeAwaySleep({
      self: M4,
      store: memorySleepStore(),
      hold: memoryWakeHoldStore(),
      config: Effect.succeed(config({ bringBack: options.bringBack ?? "prompt" })),
      ids: () =>
        Effect.succeed({ projectIds: [ProjectId.make("easychamp")], threadIds: ["thread-1"] }),
      post,
      away: port,
      giveWay: () => Effect.succeed(true),
    });
    return { away, log };
  });

describe("the lid close records the Away session", () => {
  it.effect("before the answer, the session is recorded and its routines paused", () =>
    Effect.gen(function* () {
      const { away, log } = yield* setup({ moved: false });
      const decision = yield* away.sleep({ onBattery: true });
      assert.deepEqual(decision.answer, { outcome: "left" });
      // begin ran inside the sleep call; the intent is sent after.
      assert.deepEqual(log, ["begin:thread-1"]);
    }),
  );

  it.effect("work still away: this sleep leaves nothing new", () =>
    Effect.gen(function* () {
      const { away, log } = yield* setup({ moved: false, mayStart: false });
      const decision = yield* away.sleep({ onBattery: true });
      yield* decision.send;
      assert.deepEqual(decision.answer, { outcome: "skipped" });
      assert.deepEqual(log, []);
    }),
  );

  it.effect("a wake before the target acted closes the session, routines on again", () =>
    Effect.gen(function* () {
      const { away, log } = yield* setup({ moved: false });
      yield* (yield* away.sleep({ onBattery: true })).send;
      yield* TestClock.adjust(MINUTE);
      assert.deepEqual(yield* away.wake({ onBattery: true }), { outcome: "none" });
      assert.include(log, "nothingMoved");
      assert.notInclude(log, "moved");
    }),
  );

  it.effect("a wake after it acted fills the session before the card or auto bring back", () =>
    Effect.gen(function* () {
      const { away, log } = yield* setup({ moved: true, bringBack: "auto-on-power" });
      let brought = 0;
      yield* away.onAutoBringBack(Effect.sync(() => void ((brought += 1), log.push("bringBack"))));
      yield* (yield* away.sleep({ onBattery: false })).send;
      yield* TestClock.adjust(10 * MINUTE);
      assert.deepEqual(yield* away.wake({ onBattery: false }), { outcome: "auto" });
      yield* Effect.yieldNow;
      assert.strictEqual(brought, 1);
      assert.isBelow(log.indexOf("moved"), log.indexOf("bringBack"));
      assert.notInclude(log, "nothingMoved");
    }),
  );
});

describe("sleepIntentIds with handoff mode off (#13)", () => {
  it("leaves a thread with handoff mode off out of the intent", () => {
    const project = {
      id: ProjectId.make("p1"),
      deletedAt: null,
      workspaceSettings: {
        coordinatorBinding: null,
        logicalProject: { members: [{ environmentId: MS }] },
      },
    } as unknown as Project;
    const shell = (id: string) =>
      ({
        id,
        projectId: project.id,
        status: "running",
        activityRunStatus: "running",
        activeRunId: "run",
        archivedAt: null,
        deletedAt: null,
        lineage: { relationshipToParent: null },
        heldQueuedCount: 0,
        executionMachineId: null,
      }) as unknown as OrchestrationV2ThreadShell;
    const ids = sleepIntentIds({
      self: M4,
      target: MS,
      coordinatorScope: "live",
      projects: [project],
      shells: [shell("on"), shell("off")],
      tasks: [],
      handoffOff: (entry) => entry.id === "off",
    });
    assert.deepEqual(ids.threadIds, ["on"]);
  });
});
