/**
 * Away mode's sleep trigger on the machine going away (1267 AC-09, D-01, D-02):
 * the trigger decides, the intent goes to the target with the grace and the
 * ids, and waking either cancels it (nothing moved) or asks to bring work back.
 */
import {
  AWAY_INTENT_CANCEL_PATH,
  AWAY_INTENT_PATH,
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
import { AwayPeerError } from "./awayPeerCall.ts";
import { memoryWakeHoldStore } from "./AwayWakeHold.ts";
import {
  makeAwaySleep,
  memorySleepStore,
  sleepIntentIds,
  sleepTriggerFires,
} from "./awaySleepRoute.ts";

const M4 = EnvironmentId.make("m4");
const MS = EnvironmentId.make("ministorm");
const T0 = Date.parse("2026-11-09T22:00:00.000Z");
const MINUTE = 60_000;

const config = (patch: Partial<AwayConfig> = {}): AwayConfig => ({
  target: MS,
  sleepTrigger: "on-battery",
  graceMinutes: 2,
  bringBack: "prompt",
  coordinatorScope: "live",
  ...patch,
});

interface Sent {
  readonly path: string;
  readonly body: unknown;
}

/** The target acted: the cancel came too late and the status names the takeover. */
const movedAnswer = (path: string): Effect.Effect<unknown, AwayPeerError> =>
  Effect.succeed(
    path === AWAY_INTENT_CANCEL_PATH
      ? { cancelled: 0, state: "done", takenOver: ["easychamp"] }
      : path === AWAY_INTENT_STATUS_PATH
        ? {
            intentState: "done",
            projects: [{ projectId: "easychamp", takenOver: true, epoch: 2 }],
            receivedAt: "2026-11-09T22:10:00.000Z",
          }
        : {},
  );

const peer = (answer: (path: string) => Effect.Effect<unknown, AwayPeerError> = movedAnswer) => {
  const sent: Sent[] = [];
  const post: AwayPeerPost = (_target, path, body) =>
    Effect.gen(function* () {
      sent.push({ path, body });
      return { status: 200, json: yield* answer(path) };
    });
  return { sent, post };
};

const setup = (
  patch: Partial<AwayConfig> = {},
  answer?: (path: string) => Effect.Effect<unknown, AwayPeerError>,
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(T0);
    const store = memorySleepStore();
    const hold = memoryWakeHoldStore();
    const remote = peer(answer);
    const gaveWay: string[] = [];
    let current = config(patch);
    const away = yield* makeAwaySleep({
      self: M4,
      store,
      hold,
      config: Effect.sync(() => current),
      ids: () =>
        Effect.succeed({ projectIds: [ProjectId.make("easychamp")], threadIds: ["thread-1"] }),
      post: remote.post,
      giveWay: (input) =>
        Effect.sync(() => {
          gaveWay.push(input.projectId);
          return true;
        }),
    });
    return {
      away,
      store,
      hold,
      remote,
      gaveWay,
      setConfig: (next: AwayConfig) => void (current = next),
    };
  });

describe("sleepTriggerFires (D-01)", () => {
  it("stays off until a target is set, and never targets this machine", () => {
    assert.isFalse(sleepTriggerFires(config({ target: null }), M4, true));
    assert.isFalse(sleepTriggerFires(config({ target: M4 }), M4, true));
  });

  it("on battery fires only on battery; always fires on power too; off never", () => {
    assert.isTrue(sleepTriggerFires(config(), M4, true));
    assert.isFalse(sleepTriggerFires(config(), M4, false));
    assert.isTrue(sleepTriggerFires(config({ sleepTrigger: "always" }), M4, false));
    assert.isFalse(sleepTriggerFires(config({ sleepTrigger: "off" }), M4, true));
  });
});

describe("the sleep notice", () => {
  it.effect("on power with On battery: skipped, nothing sent, no session", () =>
    Effect.gen(function* () {
      const { away, store, remote } = yield* setup();
      const decision = yield* away.sleep({ onBattery: false });
      yield* decision.send;
      assert.deepEqual(decision.answer, { outcome: "skipped" });
      assert.deepEqual(remote.sent, []);
      assert.isNull(store.current());
    }),
  );

  it.effect(
    "on battery: answers left, sends the intent with grace and ids, records the session",
    () =>
      Effect.gen(function* () {
        const { away, store, remote } = yield* setup();
        const decision = yield* away.sleep({ onBattery: true });
        assert.deepEqual(decision.answer, { outcome: "left" });
        // Recorded before the send, so a sleep mid-send still knows it left.
        assert.strictEqual(store.current()?.state, "pending-intent");
        yield* decision.send;
        assert.deepEqual(remote.sent, [
          {
            path: AWAY_INTENT_PATH,
            body: {
              sourceEnvironmentId: M4,
              graceMinutes: 2,
              projectIds: ["easychamp"],
              threadIds: ["thread-1"],
            },
          },
        ]);
        assert.strictEqual(store.current()?.dueAt, "2026-11-09T22:02:00.000Z");
      }),
  );

  it.effect("a refused send leaves the session as send-failed; the next wake clears it", () =>
    Effect.gen(function* () {
      const { away, store, hold, remote } = yield* setup({}, () =>
        Effect.fail(
          new AwayPeerError({
            message: "Ministorm: no work grant",
            refused: true,
            uncertain: false,
            status: 403,
          }),
        ),
      );
      const decision = yield* away.sleep({ onBattery: true });
      assert.isNotNull(hold.current());
      yield* decision.send;
      assert.strictEqual(store.current()?.state, "send-failed");
      // The target never recorded it: the coordinator runs here again at once.
      assert.isNull(hold.current());
      const woke = yield* away.wake({ onBattery: true });
      assert.deepEqual(woke, { outcome: "none" });
      assert.isNull(store.current());
      assert.lengthOf(remote.sent, 1);
    }),
  );

  it.effect(
    "an unanswered send is send-uncertain: the hold stays and the wake asks the target",
    () =>
      Effect.gen(function* () {
        let failIntent = true;
        const { away, store, hold, remote, gaveWay } = yield* setup({}, (path) =>
          path === AWAY_INTENT_PATH && failIntent
            ? Effect.fail(
                new AwayPeerError({
                  message: "Ministorm did not answer.",
                  refused: false,
                  uncertain: true,
                }),
              )
            : movedAnswer(path),
        );
        yield* (yield* away.sleep({ onBattery: true })).send;
        failIntent = false;
        assert.strictEqual(store.current()?.state, "send-uncertain");
        assert.isNotNull(hold.current());
        yield* TestClock.adjust(10 * MINUTE);
        assert.deepEqual(yield* away.wake({ onBattery: true }), { outcome: "prompt" });
        assert.deepEqual(
          remote.sent.map((call) => call.path),
          [AWAY_INTENT_PATH, AWAY_INTENT_CANCEL_PATH, AWAY_INTENT_STATUS_PATH],
        );
        assert.deepEqual(gaveWay, ["easychamp"]);
        assert.isNull(hold.current());
      }),
  );
});

describe("waking (D-02)", () => {
  it.effect("back before the grace: cancels on the target, nothing moved, no prompt", () =>
    Effect.gen(function* () {
      const { away, store, remote } = yield* setup({}, (path) =>
        Effect.succeed(path === AWAY_INTENT_CANCEL_PATH ? { cancelled: 1 } : {}),
      );
      yield* (yield* away.sleep({ onBattery: true })).send;
      yield* TestClock.adjust(MINUTE);
      assert.deepEqual(yield* away.wake({ onBattery: true }), { outcome: "none" });
      assert.strictEqual(remote.sent[1]?.path, AWAY_INTENT_CANCEL_PATH);
      assert.deepEqual(remote.sent[1]?.body, { sourceEnvironmentId: M4 });
      assert.isNull(store.current());
    }),
  );

  it.effect("back after the grace with the work moved: prompts once, then stays quiet", () =>
    Effect.gen(function* () {
      const { away, store } = yield* setup();
      yield* (yield* away.sleep({ onBattery: true })).send;
      yield* TestClock.adjust(10 * MINUTE);
      assert.deepEqual(yield* away.wake({ onBattery: true }), { outcome: "prompt" });
      assert.strictEqual(store.current()?.state, "wake-prompt");
      // The unlock right after the resume does not show the card again.
      assert.deepEqual(yield* away.wake({ onBattery: true }), { outcome: "none" });
      yield* away.clear;
      assert.isNull(yield* away.session);
    }),
  );

  it.effect("after the grace, the target still waiting: the cancel wins and nothing moved", () =>
    Effect.gen(function* () {
      const { away, store } = yield* setup({}, (path) =>
        Effect.succeed(path === AWAY_INTENT_CANCEL_PATH ? { cancelled: 1 } : {}),
      );
      yield* (yield* away.sleep({ onBattery: true })).send;
      yield* TestClock.adjust(10 * MINUTE);
      assert.deepEqual(yield* away.wake({ onBattery: true }), { outcome: "none" });
      assert.isNull(store.current());
    }),
  );

  it.effect("Bring back automatically on power runs the registered bring back, on power only", () =>
    Effect.gen(function* () {
      const { away } = yield* setup({ bringBack: "auto-on-power", sleepTrigger: "always" });
      let brought = 0;
      yield* away.onAutoBringBack(Effect.sync(() => void brought++));
      yield* (yield* away.sleep({ onBattery: false })).send;
      yield* TestClock.adjust(10 * MINUTE);
      assert.deepEqual(yield* away.wake({ onBattery: false }), { outcome: "auto" });
      yield* Effect.yieldNow;
      assert.strictEqual(brought, 1);
    }),
  );

  it.effect("Bring back automatically on battery prompts instead; Do nothing stays quiet", () =>
    Effect.gen(function* () {
      const auto = yield* setup({ bringBack: "auto-on-power" });
      yield* auto.away.onAutoBringBack(Effect.void);
      yield* (yield* auto.away.sleep({ onBattery: true })).send;
      yield* TestClock.adjust(10 * MINUTE);
      assert.deepEqual(yield* auto.away.wake({ onBattery: true }), { outcome: "prompt" });

      const manual = yield* setup({ bringBack: "manual" });
      yield* (yield* manual.away.sleep({ onBattery: true })).send;
      yield* TestClock.adjust(10 * MINUTE);
      assert.deepEqual(yield* manual.away.wake({ onBattery: true }), { outcome: "none" });
      // The session still waits for Bring back from the menu.
      assert.strictEqual(manual.store.current()?.state, "wake-prompt");
    }),
  );

  it.effect("a wake with no session does nothing and calls no one", () =>
    Effect.gen(function* () {
      const { away, remote } = yield* setup();
      assert.deepEqual(yield* away.wake({ onBattery: false }), { outcome: "none" });
      assert.deepEqual(remote.sent, []);
    }),
  );
});

describe("sleepIntentIds", () => {
  const project = (
    id: string,
    patch: { coordinated?: boolean; linked?: boolean; personal?: boolean } = {},
  ): Project =>
    ({
      id: ProjectId.make(id),
      title: id,
      deletedAt: null,
      workspaceSettings: {
        ...(patch.personal ? { personalAssistant: true } : {}),
        coordinatorBinding: {
          epoch: 1,
          state: patch.coordinated === false ? "transferred" : "active",
        },
        logicalProject: {
          id: `lp-${id}`,
          title: id,
          members: [
            { environmentId: M4, projectId: id },
            ...(patch.linked === false ? [] : [{ environmentId: MS, projectId: `${id}-ms` }]),
          ],
        },
      },
    }) as unknown as Project;

  const running = (id: string, projectId: string) =>
    ({
      id,
      projectId: ProjectId.make(projectId),
      status: "running",
      activityRunStatus: "running",
      activeRunId: "run-1",
      archivedAt: null,
      deletedAt: null,
      lineage: { relationshipToParent: null },
      heldQueuedCount: 0,
      executionMachineId: null,
    }) as unknown as OrchestrationV2ThreadShell;

  it("live scope: coordinated, linked projects with work or a routine; their live threads", () => {
    const ids = sleepIntentIds({
      self: M4,
      target: MS,
      coordinatorScope: "live",
      projects: [
        project("busy"),
        project("routine"),
        project("idle"),
        project("unlinked", { linked: false }),
        project("elsewhere", { coordinated: false }),
      ],
      shells: [running("t-busy", "busy"), running("t-unlinked", "unlinked")],
      tasks: [{ projectId: ProjectId.make("routine"), enabled: true }],
    });
    assert.deepEqual(
      ids.projectIds,
      ["busy", "routine"].map((id) => ProjectId.make(id)),
    );
    assert.deepEqual(ids.threadIds, ["t-busy", "t-unlinked"]);
  });

  it("all scope adds idle coordinated projects", () => {
    const ids = sleepIntentIds({
      self: M4,
      target: MS,
      coordinatorScope: "all",
      projects: [project("busy"), project("idle")],
      shells: [],
      tasks: [],
    });
    assert.deepEqual(
      ids.projectIds,
      ["busy", "idle"].map((id) => ProjectId.make(id)),
    );
  });
});
