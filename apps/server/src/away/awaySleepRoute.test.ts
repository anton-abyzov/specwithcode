/**
 * The sleep notice on the machine going to sleep (1390 AC-36, T-23). A lid
 * close never starts a handoff, whatever a saved setting says. What an
 * earlier release left behind (a session, a hold, an intent on the target)
 * is still drained: waking cancels the intent (nothing moved) or asks to
 * bring work back. The earlier release is `previousRelease.awaySleep.test.fixture.ts`,
 * run on the same stores before this version takes over.
 */
import {
  AWAY_FORCE_LOCAL_AFTER_MS,
  AWAY_INTENT_CANCEL_PATH,
  AWAY_INTENT_PATH,
  AWAY_INTENT_STATUS_PATH,
  type AwayConfig,
  EnvironmentId,
  ProjectId,
  awayConfigOf,
} from "@specweave-studio/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { EMPTY_HANDOFF_DOCUMENT, HandoffDocument } from "../handoff/handoffState.ts";
import type { AwayPeerPost } from "./awayPeerCall.ts";
import { AwayPeerError } from "./awayPeerCall.ts";
import { memoryWakeHoldStore } from "./AwayWakeHold.ts";
import { makeAwaySleep, memorySleepStore } from "./awaySleepRoute.ts";
import * as Previous from "./previousRelease.awaySleep.test.fixture.ts";

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

/**
 * The target acted: the cancel came too late and the status names the
 * takeover, and the held thread as not continued, as every release that
 * answers about intents does.
 */
const movedAnswer = (path: string): Effect.Effect<unknown, AwayPeerError> =>
  Effect.succeed(
    path === AWAY_INTENT_CANCEL_PATH
      ? { cancelled: 0, state: "done", takenOver: ["easychamp"] }
      : path === AWAY_INTENT_STATUS_PATH
        ? {
            intentState: "done",
            projects: [{ projectId: "easychamp", takenOver: true, epoch: 2 }],
            threads: [{ threadId: "thread-1", continuedThreadId: null }],
            threadsSettled: true,
            receivedAt: "2026-11-09T22:10:00.000Z",
          }
        : {},
  );

const noAnswer = Effect.fail(
  new AwayPeerError({ message: "Ministorm did not answer.", refused: false, uncertain: true }),
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

/**
 * One machine, before and after its update: `before` is the previous
 * release, `away` this version, on the same session, hold and network.
 */
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
    const deps = {
      self: M4,
      store,
      hold,
      config: Effect.sync(() => current),
      ids: () =>
        Effect.succeed({ projectIds: [ProjectId.make("easychamp")], threadIds: ["thread-1"] }),
      post: remote.post,
      giveWay: (input: { readonly projectId: ProjectId }) =>
        Effect.sync(() => {
          gaveWay.push(input.projectId);
          return true;
        }),
    };
    const before = yield* Previous.makeAwaySleep(deps);
    const away = yield* makeAwaySleep(deps);
    return {
      before,
      away,
      store,
      hold,
      remote,
      gaveWay,
      setConfig: (next: AwayConfig) => void (current = next),
      intentsSent: () => remote.sent.filter((call) => call.path === AWAY_INTENT_PATH).length,
    };
  });

/** A `handoff-mode.json` an earlier release saved, read back as a restart reads it. */
const savedConfig = (sleepTrigger: "always" | "on-battery"): AwayConfig => {
  const saved = JSON.parse(
    JSON.stringify(
      Schema.encodeSync(HandoffDocument)({
        ...EMPTY_HANDOFF_DOCUMENT,
        config: {
          ...EMPTY_HANDOFF_DOCUMENT.config,
          sleepTarget: MS,
          autoTakeoverMinutes: 15,
          sleepTrigger,
          graceMinutes: 2,
        },
      }),
    ),
  );
  const document = Schema.decodeUnknownSync(HandoffDocument)(saved);
  // The saved values still read: nothing is rewritten, they only start nothing.
  assert.strictEqual(document.config.sleepTrigger, sleepTrigger);
  assert.strictEqual(document.config.autoTakeoverMinutes, 15);
  return awayConfigOf(document.config);
};

describe("a lid close never starts a handoff (AC-36)", () => {
  it.effect("with both saved sleep settings and no window open: zero new handoffs", () =>
    Effect.gen(function* () {
      for (const [sleepTrigger, onBattery] of [
        ["always", false],
        ["always", true],
        ["on-battery", true],
      ] as const) {
        const { away, store, hold, remote, setConfig } = yield* setup();
        setConfig(savedConfig(sleepTrigger));
        // Only the main process's notice reaches the server; no window is involved.
        const decision = yield* away.sleep({ onBattery });
        yield* decision.send;
        assert.deepEqual(decision.answer, { outcome: "skipped" }, sleepTrigger);
        assert.deepEqual(remote.sent, [], sleepTrigger);
        assert.isNull(store.current(), sleepTrigger);
        assert.isNull(hold.current(), sleepTrigger);
      }
    }),
  );

  it.effect("a move authorized before the lid close stays recoverable", () =>
    Effect.gen(function* () {
      const { before, away, store, hold, gaveWay, setConfig, intentsSent } = yield* setup();
      setConfig(savedConfig("always"));
      // The earlier release left for the target: its intent is there, the work is held here.
      yield* (yield* before.sleep({ onBattery: true })).send;
      const left = store.current();
      assert.strictEqual(left?.state, "pending-intent");
      assert.isNotNull(hold.current());
      // Updated, then the lid closes again: nothing new starts, and nothing is let go.
      const decision = yield* away.sleep({ onBattery: true });
      yield* decision.send;
      assert.deepEqual(decision.answer, { outcome: "skipped" });
      assert.strictEqual(intentsSent(), 1);
      assert.deepEqual(store.current(), left);
      assert.isNotNull(hold.current());
      // The target acted on the earlier intent: this machine gives way and offers Bring back.
      yield* TestClock.adjust(10 * MINUTE);
      assert.deepEqual(yield* away.wake({ onBattery: true }), { outcome: "prompt" });
      assert.deepEqual(gaveWay, ["easychamp"]);
      assert.isNull(hold.current());
    }),
  );

  it.effect(
    "a target that acted before its answer was lost is asked, never told nothing moved",
    () =>
      Effect.gen(function* () {
        let lost = true;
        const { before, away, store, hold, remote, gaveWay, setConfig, intentsSent } = yield* setup(
          {},
          (path) => (path === AWAY_INTENT_PATH && lost ? noAnswer : movedAnswer(path)),
        );
        setConfig(savedConfig("on-battery"));
        yield* (yield* before.sleep({ onBattery: true })).send;
        lost = false;
        assert.strictEqual(store.current()?.state, "send-uncertain");
        assert.isNotNull(hold.current());
        // Updated: the lid closes again and sends nothing new.
        yield* (yield* away.sleep({ onBattery: true })).send;
        assert.strictEqual(intentsSent(), 1);
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

  it.effect(
    "a target armed earlier and offline through the update and the lid close: the hold waits",
    () =>
      Effect.gen(function* () {
        let offline = false;
        const { before, away, store, hold, gaveWay, setConfig, intentsSent } = yield* setup(
          {},
          (path) => (offline ? noAnswer : movedAnswer(path)),
        );
        setConfig(savedConfig("always"));
        yield* (yield* before.sleep({ onBattery: true })).send;
        assert.strictEqual(store.current()?.state, "pending-intent");
        // The target goes offline; this machine updates and starts again.
        offline = true;
        assert.deepEqual(yield* away.boot, { outcome: "none" });
        // No answer is no proof: the work stays held and the session says since when.
        assert.isNotNull(hold.current());
        assert.isDefined(store.current()?.unreachableSince);
        // The lid closes: no new intent, and the hold is not released on a guess.
        yield* (yield* away.sleep({ onBattery: true })).send;
        assert.strictEqual(intentsSent(), 1);
        assert.isNotNull(hold.current());
        assert.strictEqual(yield* away.retry, "unresolved");
        assert.deepEqual(gaveWay, []);
        // The target is back and says it took the project over: this machine gives way.
        offline = false;
        yield* TestClock.adjust(10 * MINUTE);
        assert.deepEqual(yield* away.wake({ onBattery: true }), { outcome: "prompt" });
        assert.deepEqual(gaveWay, ["easychamp"]);
        assert.isNull(hold.current());
        assert.strictEqual(store.current()?.state, "wake-prompt");
      }),
  );

  it.effect("a send the earlier release saw refused: the next wake clears it", () =>
    Effect.gen(function* () {
      const { before, away, store, hold, remote } = yield* setup({}, () =>
        Effect.fail(
          new AwayPeerError({
            message: "Ministorm: no work grant",
            refused: true,
            uncertain: false,
            status: 403,
          }),
        ),
      );
      yield* (yield* before.sleep({ onBattery: true })).send;
      assert.strictEqual(store.current()?.state, "send-failed");
      // The target never recorded it: the coordinator runs here again at once.
      assert.isNull(hold.current());
      assert.deepEqual(yield* away.wake({ onBattery: true }), { outcome: "none" });
      assert.isNull(store.current());
      assert.lengthOf(remote.sent, 1);
    }),
  );
});

describe("waking after an earlier release left (D-02)", () => {
  it.effect("back before the grace: cancels on the target, nothing moved, no prompt", () =>
    Effect.gen(function* () {
      const { before, away, store, remote } = yield* setup({}, (path) =>
        Effect.succeed(path === AWAY_INTENT_CANCEL_PATH ? { cancelled: 1 } : {}),
      );
      yield* (yield* before.sleep({ onBattery: true })).send;
      yield* TestClock.adjust(MINUTE);
      assert.deepEqual(yield* away.wake({ onBattery: true }), { outcome: "none" });
      assert.strictEqual(remote.sent[1]?.path, AWAY_INTENT_CANCEL_PATH);
      assert.deepEqual(remote.sent[1]?.body, { sourceEnvironmentId: M4 });
      assert.isNull(store.current());
    }),
  );

  it.effect("back after the grace with the work moved: prompts once, then stays quiet", () =>
    Effect.gen(function* () {
      const { before, away, store } = yield* setup();
      yield* (yield* before.sleep({ onBattery: true })).send;
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
      const { before, away, store } = yield* setup({}, (path) =>
        Effect.succeed(path === AWAY_INTENT_CANCEL_PATH ? { cancelled: 1 } : {}),
      );
      yield* (yield* before.sleep({ onBattery: true })).send;
      yield* TestClock.adjust(10 * MINUTE);
      assert.deepEqual(yield* away.wake({ onBattery: true }), { outcome: "none" });
      assert.isNull(store.current());
    }),
  );

  it.effect("Bring back automatically on power runs the registered bring back, on power only", () =>
    Effect.gen(function* () {
      const { before, away } = yield* setup({ bringBack: "auto-on-power", sleepTrigger: "always" });
      let brought = 0;
      yield* away.onAutoBringBack(Effect.sync(() => void brought++));
      yield* (yield* before.sleep({ onBattery: false })).send;
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
      yield* (yield* auto.before.sleep({ onBattery: true })).send;
      yield* TestClock.adjust(10 * MINUTE);
      assert.deepEqual(yield* auto.away.wake({ onBattery: true }), { outcome: "prompt" });

      const manual = yield* setup({ bringBack: "manual" });
      yield* (yield* manual.before.sleep({ onBattery: true })).send;
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

describe("a wake check lets go only of what the target answered for", () => {
  it.effect("a held thread the status says nothing of stays held, and Run here anyway opens", () =>
    Effect.gen(function* () {
      const status = {
        value: {
          intentState: "done",
          projects: [{ projectId: "easychamp", takenOver: true, epoch: 2 }],
          receivedAt: "2026-11-09T22:10:00.000Z",
        } as Record<string, unknown>,
      };
      const { before, away, store, hold, gaveWay } = yield* setup({}, (path) =>
        path === AWAY_INTENT_STATUS_PATH ? Effect.succeed(status.value) : movedAnswer(path),
      );
      yield* (yield* before.sleep({ onBattery: true })).send;
      yield* TestClock.adjust(10 * MINUTE);
      // No word on threads at all: it gives way for the project, and the thread waits.
      assert.deepEqual(yield* away.wake({ onBattery: true }), { outcome: "none" });
      assert.deepEqual(gaveWay, ["easychamp"]);
      assert.deepEqual(hold.current()?.threads, ["thread-1"]);
      assert.isDefined(store.current()?.unreachableSince);
      // Cancelled there, but the thread left out of the answer: still no word on it.
      status.value = {
        ...status.value,
        intentState: "cancelled",
        threads: [],
        threadsSettled: true,
      };
      yield* TestClock.adjust(MINUTE);
      assert.strictEqual(yield* away.retry, "unresolved");
      assert.deepEqual(hold.current()?.threads, ["thread-1"]);
      // Named as not continued, and nothing more continues there: it runs here again.
      status.value = {
        ...status.value,
        intentState: "done",
        threads: [{ threadId: "thread-1", continuedThreadId: null }],
      };
      assert.strictEqual(yield* away.retry, "moved");
      assert.isNull(hold.current());
    }),
  );

  it.effect("a cancel holds only this lid close's work, not a hold an earlier one left", () =>
    Effect.gen(function* () {
      const status = { answered: false };
      const { before, away, store, hold, gaveWay } = yield* setup({}, (path) =>
        path === AWAY_INTENT_CANCEL_PATH
          ? Effect.succeed({ cancelled: 1 })
          : path === AWAY_INTENT_STATUS_PATH
            ? status.answered
              ? Effect.succeed({
                  intentState: "cancelled",
                  projects: [{ projectId: "easychamp", takenOver: false }],
                  threads: [
                    { threadId: "thread-earlier", continuedThreadId: "thread-earlier-ms" },
                    { threadId: "thread-1", continuedThreadId: null },
                  ],
                  threadsSettled: true,
                  receivedAt: "2026-11-09T22:10:00.000Z",
                })
              : noAnswer
            : movedAnswer(path),
      );
      // An earlier lid close left its thread held, unresolved; the next one adds to the hold.
      yield* hold.write({
        version: 1,
        targetEnvironmentId: MS,
        since: "2026-11-09T21:00:00.000Z",
        projects: [],
        threads: ["thread-earlier"],
      });
      yield* (yield* before.sleep({ onBattery: true })).send;
      assert.deepEqual(hold.current()?.threads, ["thread-earlier", "thread-1"]);
      yield* TestClock.adjust(MINUTE);
      // The latest intent was cancelled, but the earlier one may have acted: the status decides.
      assert.deepEqual(yield* away.wake({ onBattery: true }), { outcome: "none" });
      assert.deepEqual(hold.current()?.threads, ["thread-earlier", "thread-1"]);
      assert.isNotNull(store.current());
      status.answered = true;
      assert.strictEqual(yield* away.retry, "moved");
      assert.deepEqual(gaveWay, []);
      assert.isNull(hold.current());
    }),
  );

  it.effect("a lid close the target refused lets go of nothing an earlier one left held", () =>
    Effect.gen(function* () {
      const { away, store, hold } = yield* setup();
      yield* hold.write({
        version: 1,
        targetEnvironmentId: MS,
        since: "2026-11-09T21:00:00.000Z",
        projects: [],
        threads: ["thread-earlier"],
      });
      yield* store.write({
        state: "send-failed",
        targetEnvironmentId: MS,
        graceMinutes: 2,
        projectIds: [],
        threadIds: [],
        sentAt: "2026-11-09T22:00:00.000Z",
        dueAt: "2026-11-09T22:02:00.000Z",
      });
      yield* TestClock.adjust(MINUTE);
      // The refusal proves this intent moved nothing; the status says nothing of the earlier
      // thread, so it stays held, and Run here anyway is offered after a while.
      assert.deepEqual(yield* away.wake({ onBattery: true }), { outcome: "none" });
      assert.deepEqual(hold.current()?.threads, ["thread-earlier"]);
      assert.strictEqual(store.current()?.state, "send-failed");
      assert.isDefined(store.current()?.unreachableSince);
    }),
  );

  it.effect("a held project the status leaves out stays held, and Run here anyway opens", () =>
    Effect.gen(function* () {
      const { before, away, store, hold, gaveWay } = yield* setup({}, (path) =>
        path === AWAY_INTENT_STATUS_PATH
          ? Effect.succeed({
              intentState: "done",
              projects: [],
              threads: [{ threadId: "thread-1", continuedThreadId: null }],
              threadsSettled: true,
              receivedAt: "2026-11-09T22:10:00.000Z",
            })
          : movedAnswer(path),
      );
      yield* (yield* before.sleep({ onBattery: true })).send;
      yield* TestClock.adjust(10 * MINUTE);
      // The target may have taken it over and handed it on: no word on it, so it waits.
      assert.deepEqual(yield* away.wake({ onBattery: true }), { outcome: "none" });
      const held = hold.current();
      assert.deepEqual(
        held?.projects.map((project) => project.projectId),
        ["easychamp"],
      );
      assert.isUndefined(held?.threads);
      assert.deepEqual(gaveWay, []);
      assert.isDefined(store.current()?.unreachableSince);
      // A person can still run it here once the wait ran out.
      yield* TestClock.adjust(AWAY_FORCE_LOCAL_AFTER_MS);
      assert.deepEqual(yield* away.forceLocal, {
        ok: true,
        projectIds: ["easychamp"],
        threadIds: [],
      });
      assert.isNull(hold.current());
    }),
  );
});
