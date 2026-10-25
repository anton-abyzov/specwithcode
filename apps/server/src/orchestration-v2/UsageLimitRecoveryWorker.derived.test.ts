import { assert, it } from "@effect/vitest";
import {
  type OrchestrationV2ServerCommand,
  ProviderInstanceId,
  RunId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { provider } from "../studio/fixtures.ts";
import { claudeLimitStop, claudeSweepHarness } from "./UsageLimitRecoveryWorker.testkit.ts";
import { LIMIT_REARM_MAX } from "./usageLimitRecovery.ts";

/**
 * Stops with no usable reset time resume on a provider read taken after the
 * stop, and a limit that comes back in the same window is re-armed with a
 * longer wait, up to a bound.
 */

/** A Claude snapshot read at `at`; `room` false is a read that still shows the limit. */
const claudeRead = (at: number, room: boolean, resetsAt?: number): ServerProvider => {
  const base = provider("claudeAgent", "claudeAgent", at);
  return {
    ...base,
    usageLimits: {
      checkedAt: DateTime.formatIso(DateTime.makeUnsafe(at)),
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          usedPercent: room ? 3 : 100,
          ...(resetsAt === undefined
            ? {}
            : { resetsAt: DateTime.formatIso(DateTime.makeUnsafe(resetsAt)) }),
        },
      ],
      ordinaryUsageAllowed: room,
    },
  };
};

const resumes = (commands: ReadonlyArray<OrchestrationV2ServerCommand>) =>
  commands.filter((command) => command.type === "message.dispatch");

it.effect(
  "leaves a stop without a reset time for the person when nothing can read the provider",
  () =>
    Effect.gen(function* () {
      const { state, sweep } = claudeSweepHarness({
        thread: { ...claudeLimitStop(0), usageLimitResetAt: null },
        globalAutoResume: true,
      });
      yield* TestClock.adjust("6 hours");
      yield* sweep;
      yield* sweep;
      assert.deepEqual(resumes(state.commands), []);
    }),
);

it.effect("continues a stop without a reset time once a read after it shows room", () =>
  Effect.gen(function* () {
    const harness = claudeSweepHarness({
      thread: { ...claudeLimitStop(0), usageLimitResetAt: null },
      globalAutoResume: true,
      provider: (at) => claudeRead(at, at >= 30 * 60_000),
    });
    const { state } = harness;
    const sweep = yield* harness.running;
    // The read the registry held at the stop: no room, no reset time.
    state.snapshot = claudeRead(0, false);
    yield* sweep;
    assert.lengthOf(state.commands, 1);
    assert.equal(state.commands[0]?.type, "thread.metadata.update");
    assert.isTrue(state.current.limitRecovery?.autoResume);
    yield* sweep;
    // The subscription watch's fresh reads are its own; these count the derived wait's.
    const derivedReads = () => state.refreshes - state.freshRefreshes;
    assert.equal(derivedReads(), 0, "nothing is read before the first wait is over");
    yield* TestClock.adjust("5 minutes");
    yield* sweep;
    yield* sweep;
    assert.equal(derivedReads(), 1, "one read per check interval");
    assert.deepEqual(resumes(state.commands), []);
    yield* TestClock.adjust("5 minutes");
    yield* sweep;
    assert.equal(derivedReads(), 2);
    assert.deepEqual(resumes(state.commands), []);
    yield* TestClock.adjust("20 minutes");
    yield* sweep;
    const [resume] = resumes(state.commands);
    assert.isDefined(resume);
    if (resume?.type !== "message.dispatch") return;
    assert.equal(resume.text, "Continue where you left off.");
    // A usage-limit continuation of the stop, naming the arm it answers, so the
    // orchestrator checks the derived wait and the recovery under the thread lock.
    assert.equal(resume.usageLimitContinuationOfRunId, state.current.latestRunId);
    assert.equal(resume.usageLimitRecoveryRequestId, state.current.limitRecovery?.requestId);
    assert.isDefined(resume.usageLimitRecoveryRequestId);
    assert.isUndefined(resume.manualContinuationOfRunId);
    assert.equal(resume.dispatchMode.type, "start_immediately");
    // A repeated sweep sends the same command id, which the receipt store dedupes.
    yield* sweep;
    assert.equal(resumes(state.commands)[1]?.commandId, resume.commandId);
  }),
);

it.effect("waits for a reset the provider still reports before reading it again", () =>
  Effect.gen(function* () {
    const resetMs = 2 * 60 * 60_000;
    const { state, sweep } = claudeSweepHarness({
      thread: { ...claudeLimitStop(0), usageLimitResetAt: null },
      globalAutoResume: true,
      provider: (at) => claudeRead(at, at >= resetMs),
    });
    state.snapshot = claudeRead(0, false, resetMs);
    yield* sweep;
    yield* TestClock.adjust("119 minutes");
    yield* sweep;
    // The subscription watch reads the instance (once per 2 minutes), but
    // the same account's reset still decides: nothing resumes before it.
    assert.equal(state.refreshes - state.freshRefreshes, 0);
    assert.isAtMost(state.freshRefreshes, 2);
    assert.deepEqual(resumes(state.commands), []);
    yield* TestClock.adjust("2 minutes");
    yield* sweep;
    assert.isAtMost(state.refreshes - state.freshRefreshes, 1);
    assert.lengthOf(resumes(state.commands), 1);
  }),
);

const stale = (stoppedAt: number, before: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(stoppedAt - before));

it.effect.each([
  ["no reset", (_attempt: number, _stoppedAt: number): string | null => null],
  // Each stop reports a different reset at or before itself.
  [
    "distinct past resets",
    (attempt: number, stoppedAt: number) => stale(stoppedAt, (attempt + 1) * 60_000),
  ],
  [
    "alternating no reset and stale resets",
    (attempt: number, stoppedAt: number) => (attempt % 2 === 0 ? null : stale(stoppedAt, 1_000)),
  ],
] as const)(
  "re-arms a limit that comes back in the same window, backing off, then stops (%s)",
  ([, resetFor]) =>
    Effect.gen(function* () {
      const { state, sweep } = claudeSweepHarness({
        thread: { ...claudeLimitStop(0), usageLimitResetAt: resetFor(0, 0) },
        globalAutoResume: true,
        provider: (at) => claudeRead(at, true),
      });
      state.snapshot = claudeRead(0, false);
      const waits: number[] = [];
      let stoppedAt = 0;
      for (let attempt = 0; attempt <= LIMIT_REARM_MAX + 1; attempt++) {
        yield* sweep; // arm
        const armed = state.current.limitRecovery?.runId === state.current.latestRunId;
        if (!armed) break;
        let waited = 0;
        while (resumes(state.commands).length === attempt && waited < 6 * 60) {
          yield* TestClock.adjust("1 minute");
          waited += 1;
          yield* sweep;
        }
        assert.lengthOf(resumes(state.commands), attempt + 1, `attempt ${attempt} resumes`);
        waits.push(waited);
        // The resumed run stops on the limit again.
        stoppedAt = yield* Clock.currentTimeMillis;
        state.snapshot = claudeRead(stoppedAt, false);
        state.current = {
          ...state.current,
          latestRunId: RunId.make(`failed-run-${attempt + 1}`),
          latestRunCompletedAt: DateTime.makeUnsafe(stoppedAt),
          updatedAt: DateTime.makeUnsafe(stoppedAt),
          usageLimitResetAt: resetFor(attempt + 1, stoppedAt),
        };
      }
      assert.deepEqual(waits, [5, 20, 80, 300]);
      // The fifth stop of the chain is left for the person: no arm, no resume.
      const before = state.commands.length;
      yield* TestClock.adjust("6 hours");
      yield* sweep;
      yield* sweep;
      assert.equal(state.commands.length, before);
      assert.notEqual(state.current.limitRecovery?.runId, state.current.latestRunId);
    }),
);

it.effect("starts a new chain for a stop long after the last one", () =>
  Effect.gen(function* () {
    const { state, sweep } = claudeSweepHarness({
      thread: { ...claudeLimitStop(0), usageLimitResetAt: null },
      globalAutoResume: true,
    });
    yield* sweep;
    yield* TestClock.adjust("6 hours");
    const stoppedAt = yield* Clock.currentTimeMillis;
    state.current = {
      ...state.current,
      latestRunId: RunId.make("much-later"),
      latestRunCompletedAt: DateTime.makeUnsafe(stoppedAt),
      updatedAt: DateTime.makeUnsafe(stoppedAt),
    };
    yield* sweep;
    assert.equal(
      state.commands.at(-1)?.commandId,
      `limit-arm:claude-limited:much-later:NaN:chain:0:${stoppedAt}`,
    );
  }),
);

/** A stop with no reset that a read after it shows room for, five minutes on. */
const roomyStop = (input: Omit<Parameters<typeof claudeSweepHarness>[0], "thread">) => {
  const harness = claudeSweepHarness({
    thread: { ...claudeLimitStop(0), usageLimitResetAt: null },
    globalAutoResume: true,
    provider: (at) => claudeRead(at, true),
    ...input,
  });
  harness.state.snapshot = claudeRead(0, false);
  return harness;
};

it.effect("arms a stop only while the thread is on the instance the run stopped on", () =>
  Effect.gen(function* () {
    const harness = roomyStop({ runInstance: ProviderInstanceId.make("copilot") });
    const { state } = harness;
    const sweep = yield* harness.running;
    yield* sweep;
    yield* sweep;
    assert.deepEqual(state.attempts, [], "the orchestrator would refuse this arm for good");
    // The thread is back on the instance the run used.
    state.current = { ...state.current, providerInstanceId: ProviderInstanceId.make("copilot") };
    yield* sweep;
    assert.lengthOf(state.commands, 1);
    assert.equal(state.current.limitRecovery?.runId, state.current.latestRunId);
  }),
);

it.effect("sends a refused command at most once more, then leaves it", () =>
  Effect.gen(function* () {
    const harness = roomyStop({
      refuses: (command) => command.type === "thread.metadata.update",
    });
    const { state } = harness;
    const sweep = yield* harness.running;
    for (let tick = 0; tick < 5; tick++) yield* sweep;
    // The first refusal, then the replay the receipt refuses again.
    assert.lengthOf(state.attempts, 2);
    assert.equal(state.attempts[0], state.attempts[1]);
    assert.deepEqual(state.commands, []);
  }),
);

// A cancel, Settle or switch committed after the worker read the thread is
// refused by the orchestrator under the thread lock, from the recovery fields
// the resume carries (runtimeLayer.test.ts, "takes a derived usage-limit
// continuation only for its own arm"), so the worker sends without re-reading.
it.effect("sends a derived resume as it was built, for the orchestrator to check", () =>
  Effect.gen(function* () {
    let changed = false;
    const { state, sweep } = roomyStop({
      beforeSend: (shared) => {
        if (changed) return;
        changed = true;
        shared.current = {
          ...shared.current,
          limitRecovery: { ...shared.current.limitRecovery!, autoResume: false },
        };
      },
    });
    yield* sweep; // arm
    const armedBy = state.current.limitRecovery?.requestId;
    yield* TestClock.adjust("5 minutes");
    yield* sweep;
    assert.isTrue(changed, "a resume was built");
    const [resume] = resumes(state.commands);
    if (resume?.type !== "message.dispatch") return assert.fail("no resume was sent");
    assert.equal(resume.usageLimitContinuationOfRunId, state.current.latestRunId);
    assert.equal(resume.usageLimitRecoveryRequestId, armedBy);
    assert.isUndefined(resume.manualContinuationOfRunId);
  }),
);
