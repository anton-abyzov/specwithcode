import { assert, describe, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  type OrchestrationV2ServerCommand,
  type ServerProvider,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { provider } from "../studio/fixtures.ts";
import { claudeLimitStop, claudeSweepHarness } from "./UsageLimitRecoveryWorker.testkit.ts";

/**
 * October 25, 2026: a thread stops on one subscription's 5-hour limit, and the
 * person signs the same CLI in to another subscription. The server learns of
 * it only by reading the instance (no login-file event here), which the sweep
 * does at most every 2 minutes while the thread waits.
 */
const HOUR = 60 * 60_000;
const RESET = 5 * HOUR;
const SIGN_IN = 30 * 60_000;
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/** The registry's read at `at`: the old subscription before `SIGN_IN`, the new one after. */
const read =
  (options: { readonly driver?: "claudeAgent" | "codex"; readonly newRoom?: boolean } = {}) =>
  (at: number): ServerProvider => {
    const driver = options.driver ?? "claudeAgent";
    const base = provider(driver, driver, at);
    const switched = at >= SIGN_IN;
    return {
      ...base,
      usageLimits: {
        checkedAt: iso(at),
        windows: [
          {
            id: "five_hour",
            kind: "session",
            label: "Session",
            usedPercent: switched && options.newRoom !== false ? 1 : 100,
            resetsAt: iso(switched ? at + 5 * HOUR : RESET),
          },
        ],
        nativeAllowanceObservedAt: iso(at),
        ordinaryUsageAllowed: switched && options.newRoom !== false,
        ...(switched ? { accountChangedAt: iso(SIGN_IN) } : {}),
      },
    } as ServerProvider;
  };

const resumes = (commands: ReadonlyArray<OrchestrationV2ServerCommand>) =>
  commands.filter((command) => command.type === "message.dispatch").map((c) => c.commandId);

describe("usage-limit recovery after a same-CLI subscription change", () => {
  it.effect("notices the new subscription by reading the held instance and resumes once", () =>
    Effect.gen(function* () {
      const h = claudeSweepHarness({
        thread: claudeLimitStop(RESET),
        globalAutoResume: true,
        provider: read(),
      });
      h.state.snapshot = read()(0);
      const sweep = yield* h.running;
      yield* sweep; // arm
      yield* TestClock.adjust(SIGN_IN + 60_000);
      yield* sweep;
      const sent = resumes(h.state.commands);
      assert.lengthOf(sent, 1);
      assert.include(sent[0], `:acct:${SIGN_IN}:`);
      // Later sweeps and a restarted sweep send the same id, never a second run.
      yield* TestClock.adjust("10 seconds");
      yield* sweep;
      yield* h.sweep;
      assert.deepEqual([...new Set(resumes(h.state.commands))], sent);
    }),
  );

  it.effect("reads a held instance at most once every 2 minutes", () =>
    Effect.gen(function* () {
      const h = claudeSweepHarness({
        thread: claudeLimitStop(RESET),
        globalAutoResume: true,
        // Still the spent subscription: nothing to resume, only reads.
        provider: (at) => read({ newRoom: false })(Math.min(at, SIGN_IN - 1)),
      });
      h.state.snapshot = read()(0);
      const sweep = yield* h.running;
      yield* sweep;
      for (let tick = 0; tick < 24; tick++) {
        yield* TestClock.adjust("5 seconds");
        yield* sweep;
      }
      // 2 minutes of 5-second ticks: the first read at most, then the next.
      assert.isAtMost(h.state.refreshes, 1);
      yield* TestClock.adjust("2 minutes");
      yield* sweep;
      assert.isAtMost(h.state.refreshes, 2);
      assert.deepEqual(resumes(h.state.commands), []);
    }),
  );

  it.effect("bypasses the cached probe and keeps reading while turns move the snapshot", () =>
    Effect.gen(function* () {
      const h = claudeSweepHarness({
        thread: claudeLimitStop(RESET),
        globalAutoResume: true,
        provider: (at) => read({ newRoom: false })(Math.min(at, SIGN_IN - 1)),
      });
      const sweep = yield* h.running;
      for (let tick = 0; tick < 27; tick++) {
        // Another thread's turn on the instance reports usage every tick.
        h.state.snapshot = read({ newRoom: false })(Math.min(tick * 5_000, SIGN_IN - 1));
        h.state.snapshot = {
          ...h.state.snapshot,
          usageLimits: {
            ...h.state.snapshot.usageLimits!,
            checkedAt: iso(tick * 5_000),
          },
        };
        yield* sweep;
        yield* TestClock.adjust("5 seconds");
      }
      // 130 seconds of ticks with a snapshot never older than 5 seconds: one
      // read after the arm, the next 2 minutes later.
      assert.strictEqual(h.state.refreshes, 2);
      assert.strictEqual(h.state.freshRefreshes, h.state.refreshes);
    }),
  );

  it.effect("still reads while the thread waits for the person to confirm", () =>
    Effect.gen(function* () {
      const h = claudeSweepHarness({
        thread: claudeLimitStop(RESET),
        globalAutoResume: false,
        provider: read(),
      });
      h.state.snapshot = read()(0);
      const sweep = yield* h.running;
      yield* sweep; // arm, auto-continue off
      yield* TestClock.adjust(SIGN_IN + 60_000);
      yield* sweep;
      assert.isAtLeast(h.state.refreshes, 1);
      assert.strictEqual(h.state.snapshot?.usageLimits?.accountChangedAt, iso(SIGN_IN));
      assert.deepEqual(resumes(h.state.commands), []);
    }),
  );

  it.effect("stops reading for a stop whose old limit no longer holds it", () =>
    Effect.gen(function* () {
      const h = claudeSweepHarness({
        thread: claudeLimitStop(RESET),
        globalAutoResume: false,
        provider: read({ newRoom: false }),
      });
      h.state.snapshot = read({ newRoom: false })(0);
      yield* TestClock.adjust(RESET + 60_000);
      const sweep = yield* h.running;
      for (let tick = 0; tick < 5; tick++) {
        yield* sweep;
        yield* TestClock.adjust("3 minutes");
      }
      assert.strictEqual(h.state.refreshes, 0);
    }),
  );

  it.effect("stops reading an armed stop long past its reset", () =>
    Effect.gen(function* () {
      const h = claudeSweepHarness({
        thread: { ...claudeLimitStop(RESET), providerInstanceId: ProviderInstanceId.make("codex") },
        globalAutoResume: true,
        provider: read({ driver: "codex", newRoom: false }),
        availability: { codex: true, mayResume: false, observation: null },
      });
      h.state.snapshot = read({ driver: "codex", newRoom: false })(0);
      yield* h.sweep; // arm
      yield* TestClock.adjust(RESET + 5 * HOUR);
      const before = h.state.refreshes;
      for (let tick = 0; tick < 5; tick++) {
        yield* h.sweep;
        yield* TestClock.adjust("3 minutes");
      }
      assert.strictEqual(h.state.refreshes, before);
    }),
  );

  it.effect("asks first when the project does not approve subscription changes", () =>
    Effect.gen(function* () {
      const h = claudeSweepHarness({
        thread: claudeLimitStop(RESET),
        globalAutoResume: true,
        provider: read(),
        settings: { autoApproveSubscriptionChange: false },
      });
      h.state.snapshot = read()(0);
      yield* h.sweep;
      yield* TestClock.adjust(SIGN_IN + 60_000);
      h.state.snapshot = read()(SIGN_IN + 60_000);
      yield* h.sweep;
      assert.deepEqual(resumes(h.state.commands), []);
      // The old subscription's reset still resumes it, as before.
      yield* TestClock.adjust(RESET);
      yield* h.sweep;
      assert.lengthOf(resumes(h.state.commands), 1);
      assert.notInclude(resumes(h.state.commands)[0], ":acct:");
    }),
  );

  it.effect("back on the spent subscription (A to B to A) waits for its reset", () =>
    Effect.gen(function* () {
      const h = claudeSweepHarness({
        thread: claudeLimitStop(RESET),
        globalAutoResume: true,
        provider: read({ newRoom: false }),
      });
      h.state.snapshot = read()(0);
      yield* h.sweep;
      yield* TestClock.adjust(SIGN_IN + 60_000);
      h.state.snapshot = read({ newRoom: false })(SIGN_IN + 60_000);
      yield* h.sweep;
      assert.deepEqual(resumes(h.state.commands), []);
    }),
  );

  it.effect("a person's snooze and a move to another instance keep the thread held", () =>
    Effect.gen(function* () {
      const snoozed = claudeSweepHarness({
        thread: { ...claudeLimitStop(RESET), snoozedUntil: DateTime.makeUnsafe(3 * HOUR) },
        globalAutoResume: true,
        provider: read(),
      });
      snoozed.state.snapshot = read()(0);
      yield* snoozed.sweep;
      yield* TestClock.adjust(SIGN_IN + 60_000);
      snoozed.state.snapshot = read()(SIGN_IN + 60_000);
      yield* snoozed.sweep;
      assert.deepEqual(resumes(snoozed.state.commands), []);

      const moved = claudeSweepHarness({
        thread: claudeLimitStop(RESET),
        globalAutoResume: true,
        provider: read(),
      });
      moved.state.snapshot = read()(SIGN_IN + 60_000);
      yield* moved.sweep;
      moved.state.current = {
        ...moved.state.current,
        providerInstanceId: ProviderInstanceId.make("claudeAgent-work"),
      };
      yield* moved.sweep;
      assert.deepEqual(resumes(moved.state.commands), []);
    }),
  );

  it.effect("resumes a Codex stop whose availability check saw the old pool change", () =>
    Effect.gen(function* () {
      const h = claudeSweepHarness({
        thread: { ...claudeLimitStop(RESET), providerInstanceId: ProviderInstanceId.make("codex") },
        globalAutoResume: true,
        provider: read({ driver: "codex" }),
        availability: { codex: true, mayResume: false, observation: null },
      });
      h.state.snapshot = read({ driver: "codex" })(0);
      yield* h.sweep;
      yield* TestClock.adjust(SIGN_IN + 60_000);
      h.state.snapshot = read({ driver: "codex" })(SIGN_IN + 60_000);
      yield* h.sweep;
      const sent = resumes(h.state.commands);
      assert.lengthOf(sent, 1);
      assert.include(sent[0], `:acct:${SIGN_IN}:`);
    }),
  );

  it.effect("holds a Codex resume while a busy process still holds the old subscription", () =>
    Effect.gen(function* () {
      const h = claudeSweepHarness({
        thread: { ...claudeLimitStop(RESET), providerInstanceId: ProviderInstanceId.make("codex") },
        globalAutoResume: true,
        provider: read({ driver: "codex" }),
        availability: { codex: true, mayResume: false, observation: null },
      });
      h.state.snapshot = read({ driver: "codex" })(0);
      yield* h.sweep;
      yield* TestClock.adjust(SIGN_IN + 60_000);
      h.state.snapshot = read({ driver: "codex" })(SIGN_IN + 60_000);
      h.state.replacementPending = true;
      yield* h.sweep;
      assert.deepEqual(resumes(h.state.commands), []);
      h.state.replacementPending = false;
      yield* TestClock.adjust("5 seconds");
      h.state.snapshot = read({ driver: "codex" })(SIGN_IN + 65_000);
      yield* h.sweep;
      assert.lengthOf(resumes(h.state.commands), 1);
    }),
  );

  it.effect("keeps a Codex stop held when the project asks first", () =>
    Effect.gen(function* () {
      const h = claudeSweepHarness({
        thread: { ...claudeLimitStop(RESET), providerInstanceId: ProviderInstanceId.make("codex") },
        globalAutoResume: true,
        provider: read({ driver: "codex" }),
        availability: { codex: true, mayResume: false, observation: null },
        settings: { autoApproveSubscriptionChange: false },
      });
      h.state.snapshot = read({ driver: "codex" })(0);
      yield* h.sweep;
      yield* TestClock.adjust(SIGN_IN + 60_000);
      h.state.snapshot = read({ driver: "codex" })(SIGN_IN + 60_000);
      yield* h.sweep;
      assert.deepEqual(resumes(h.state.commands), []);
    }),
  );
});
