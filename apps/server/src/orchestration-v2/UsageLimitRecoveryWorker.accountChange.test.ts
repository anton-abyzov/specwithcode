import { assert, describe, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type ServerProvider,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { provider } from "../studio/fixtures.ts";
import { claudeLimitStop, claudeSweepHarness } from "./UsageLimitRecoveryWorker.testkit.ts";

/**
 * A Claude thread stops on the old account's 5-hour limit (reset at 5 h).
 * An hour later the CLI is signed in to another account. Recovery resumes the
 * thread then, once, only when a complete read of the new account shows room;
 * anything less keeps today's wait for the reported reset.
 */
const HOUR = 60 * 60_000;
const RESET = 5 * HOUR;
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const claudeRead = (
  at: number,
  options: {
    readonly changedAt?: number;
    readonly fullReadAt?: number | null;
    readonly usedPercent?: number;
    readonly denied?: boolean;
    readonly unavailable?: boolean;
  } = {},
): ServerProvider => {
  const base = provider("claudeAgent", "claudeAgent", at);
  const fullReadAt = options.fullReadAt === undefined ? at : options.fullReadAt;
  return {
    ...base,
    usageLimits: {
      checkedAt: iso(at),
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          usedPercent: options.usedPercent ?? 14,
          resetsAt: iso(at + 4 * HOUR),
        },
      ],
      ...(fullReadAt === null ? {} : { nativeAllowanceObservedAt: iso(fullReadAt) }),
      ...(options.changedAt === undefined ? {} : { accountChangedAt: iso(options.changedAt) }),
      ...(options.denied
        ? { ordinaryUsageAllowed: false, nativeDenialObservedAt: iso(at) }
        : { ordinaryUsageAllowed: true }),
      ...(options.unavailable ? { unavailable: { reason: "probeFailed" as const } } : {}),
    },
  } as ServerProvider;
};

const resumes = (commands: ReadonlyArray<OrchestrationV2ServerCommand>) =>
  commands.filter((command) => command.type === "message.dispatch").map((c) => c.commandId);

/** Armed at the stop, then an hour on with `snapshot` in the registry. */
const afterSwitch = (
  snapshot: (at: number) => ServerProvider,
  harness: Partial<Parameters<typeof claudeSweepHarness>[0]> = {},
) =>
  Effect.gen(function* () {
    const h = claudeSweepHarness({
      thread: claudeLimitStop(RESET),
      globalAutoResume: true,
      provider: snapshot,
      ...harness,
    });
    yield* h.sweep;
    assert.equal(h.state.commands[0]?.type, "thread.metadata.update");
    yield* TestClock.adjust("1 hour");
    h.state.snapshot = snapshot(HOUR);
    return h;
  });

/** Auto-continue off for the project and globally, then an hour on with the new account read. */
const unarmedAfterSwitch = (harness: Partial<Parameters<typeof claudeSweepHarness>[0]> = {}) =>
  Effect.gen(function* () {
    const snapshot = (at: number) => claudeRead(at, { changedAt: HOUR });
    const h = claudeSweepHarness({
      thread: claudeLimitStop(RESET),
      provider: snapshot,
      ...harness,
    });
    yield* h.sweep;
    assert.deepEqual(h.state.commands, []);
    yield* TestClock.adjust("1 hour");
    h.state.snapshot = snapshot(HOUR);
    return h;
  });

describe("usage-limit recovery after the account changes", () => {
  it.effect("resumes once before the old reset when the new account has room", () =>
    Effect.gen(function* () {
      const h = yield* afterSwitch((at) => claudeRead(at, { changedAt: HOUR }));
      yield* h.sweep;
      const sent = resumes(h.state.commands);
      assert.lengthOf(sent, 1);
      assert.include(sent[0], `:acct:${HOUR}:`);
      const resume = h.state.commands.find((command) => command.type === "message.dispatch");
      assert.equal(
        resume?.type === "message.dispatch" ? resume.text : undefined,
        "Continue where you left off.",
      );
      // A later sweep, or one built after a restart, sends the same id, which
      // the orchestrator's command receipts take once.
      yield* TestClock.adjust("10 seconds");
      yield* h.sweep;
      assert.deepEqual([...new Set(resumes(h.state.commands))], sent);
    }),
  );

  it.effect.each([
    ["the same account", (at: number) => claudeRead(at)],
    ["a change seen before the stop", (at: number) => claudeRead(at, { changedAt: -1 })],
    [
      "a read without a complete allowance",
      (at: number) => claudeRead(at, { changedAt: HOUR, fullReadAt: null }),
    ],
    [
      "a complete read from before the change",
      (at: number) => claudeRead(at, { changedAt: HOUR, fullReadAt: HOUR - 60_000 }),
    ],
    ["a failed read", (at: number) => claudeRead(at, { changedAt: HOUR, unavailable: true })],
    [
      "a new account that is spent too",
      (at: number) => claudeRead(at, { changedAt: HOUR, usedPercent: 100 }),
    ],
    [
      "a new account that refused a turn",
      (at: number) => claudeRead(at, { changedAt: HOUR, denied: true }),
    ],
  ] as const)("waits for the reset after %s", ([, snapshot]) =>
    Effect.gen(function* () {
      const h = yield* afterSwitch(snapshot);
      yield* h.sweep;
      yield* TestClock.adjust("2 hours");
      yield* h.sweep;
      assert.deepEqual(resumes(h.state.commands), []);
    }),
  );

  it.effect("refreshes a stale read of the new account once before it counts", () =>
    Effect.gen(function* () {
      const h = yield* afterSwitch((at) => claudeRead(at, { changedAt: HOUR }));
      // The registry still holds the read from the switch, 20 minutes old.
      yield* TestClock.adjust("20 minutes");
      yield* h.sweep;
      assert.equal(h.state.refreshes, 1);
      assert.lengthOf(resumes(h.state.commands), 1);
    }),
  );

  it.effect(
    "a stale read that still shows no room is not refreshed again within the interval",
    () =>
      Effect.gen(function* () {
        const h = yield* afterSwitch((at) => claudeRead(at, { changedAt: HOUR, usedPercent: 100 }));
        yield* TestClock.adjust("20 minutes");
        const running = yield* h.running;
        yield* running;
        yield* TestClock.adjust("1 minute");
        yield* running;
        assert.equal(h.state.refreshes, 1);
        assert.deepEqual(resumes(h.state.commands), []);
      }),
  );

  describe("with auto-continue off", () => {
    it.effect("the change arms the stop, then resumes it once", () =>
      Effect.gen(function* () {
        const h = yield* unarmedAfterSwitch();
        yield* h.sweep;
        assert.lengthOf(h.state.commands, 1);
        const arm = h.state.commands[0]!;
        assert.equal(arm.commandId, `limit-arm:claude-limited:failed-run:${RESET}:acct:${HOUR}`);
        assert.deepEqual(arm.type === "thread.metadata.update" ? arm.limitRecovery : null, {
          runId: RunId.make("failed-run"),
          resetAt: iso(RESET),
          autoResume: true,
          snooze: false,
        });
        yield* h.sweep;
        const sent = resumes(h.state.commands);
        assert.lengthOf(sent, 1);
        assert.include(sent[0], `:acct:${HOUR}:`);
        yield* TestClock.adjust("10 seconds");
        yield* h.sweep;
        assert.deepEqual([...new Set(resumes(h.state.commands))], sent);
        assert.lengthOf(
          h.state.commands.filter((command) => command.type === "thread.metadata.update"),
          1,
        );
      }),
    );

    it.effect.each([
      ["the same account", (at: number) => claudeRead(at)],
      [
        "a new account that is spent too",
        (at: number) => claudeRead(at, { changedAt: HOUR, usedPercent: 100 }),
      ],
      [
        "a read without a complete allowance",
        (at: number) => claudeRead(at, { changedAt: HOUR, fullReadAt: null }),
      ],
    ] as const)("%s arms nothing", ([, snapshot]) =>
      Effect.gen(function* () {
        const h = claudeSweepHarness({ thread: claudeLimitStop(RESET), provider: snapshot });
        yield* h.sweep;
        yield* TestClock.adjust("1 hour");
        h.state.snapshot = snapshot(HOUR);
        yield* h.sweep;
        yield* h.sweep;
        assert.deepEqual(h.state.commands, []);
      }),
    );

    it.effect("the arm does not outlive the change: a new account that fills up waits", () =>
      Effect.gen(function* () {
        let spent = false;
        const snapshot = (at: number) =>
          claudeRead(at, { changedAt: HOUR, ...(spent ? { usedPercent: 100 } : {}) });
        const h = yield* unarmedAfterSwitch({ provider: snapshot });
        yield* h.sweep;
        assert.lengthOf(h.state.commands, 1);
        // Armed for the change, but the new subscription is spent before the resume.
        spent = true;
        h.state.snapshot = snapshot(HOUR);
        yield* h.sweep;
        assert.deepEqual(resumes(h.state.commands), []);
        // The old reset passes. Auto-continue is off, so nothing resumes by itself.
        yield* TestClock.adjust("5 hours");
        h.state.snapshot = snapshot(6 * HOUR);
        yield* h.sweep;
        yield* h.sweep;
        yield* h.sweep;
        assert.deepEqual(resumes(h.state.commands), []);
        // The arm is taken back once, so the thread shows no resume that will not come.
        assert.lengthOf(h.state.commands, 2);
        const lapse = h.state.commands[1]!;
        assert.equal(
          lapse.commandId,
          `limit-arm:claude-limited:failed-run:${RESET}:acct:${HOUR}:lapsed`,
        );
        assert.equal(h.state.current.limitRecovery?.autoResume, false);
        assert.equal(h.state.current.limitRecovery?.explicitArm, false);
      }),
    );

    it.effect("the arm stays while the old reset is ahead, for a new account that gets room", () =>
      Effect.gen(function* () {
        let spent = false;
        const snapshot = (at: number) =>
          claudeRead(at, { changedAt: HOUR, ...(spent ? { usedPercent: 100 } : {}) });
        const h = yield* unarmedAfterSwitch({ provider: snapshot });
        yield* h.sweep;
        spent = true;
        h.state.snapshot = snapshot(HOUR);
        yield* h.sweep;
        assert.lengthOf(h.state.commands, 1);
        assert.equal(h.state.current.limitRecovery?.autoResume, true);
        spent = false;
        yield* TestClock.adjust("10 minutes");
        h.state.snapshot = snapshot(HOUR + 10 * 60_000);
        yield* h.sweep;
        assert.lengthOf(resumes(h.state.commands), 1);
      }),
    );

    it.effect("a resume held past the old reset still leaves while the change is proven", () =>
      Effect.gen(function* () {
        const h = yield* unarmedAfterSwitch();
        yield* h.sweep;
        h.state.handoffBlocked = true;
        yield* h.sweep;
        assert.deepEqual(resumes(h.state.commands), []);
        yield* TestClock.adjust("4 hours");
        yield* TestClock.adjust("30 minutes");
        h.state.handoffBlocked = false;
        h.state.snapshot = claudeRead(5 * HOUR + 30 * 60_000, { changedAt: HOUR });
        yield* h.sweep;
        assert.lengthOf(resumes(h.state.commands), 1);
      }),
    );

    it.effect("the reset passing still resumes nothing", () =>
      Effect.gen(function* () {
        const h = claudeSweepHarness({
          thread: claudeLimitStop(RESET),
          provider: (at) => claudeRead(at),
        });
        yield* h.sweep;
        yield* TestClock.adjust("6 hours");
        h.state.snapshot = claudeRead(6 * HOUR);
        yield* h.sweep;
        yield* h.sweep;
        assert.deepEqual(h.state.commands, []);
      }),
    );
  });

  describe("keeps what a person or the thread chose", () => {
    it.effect("with subscription changes left to the person, nothing is armed or resumed", () =>
      Effect.gen(function* () {
        const h = yield* unarmedAfterSwitch({ settings: { autoApproveSubscriptionChange: false } });
        yield* h.sweep;
        yield* h.sweep;
        assert.deepEqual(h.state.commands, []);
      }),
    );

    it.effect("a stop the person turned auto-continue off for stays off", () =>
      Effect.gen(function* () {
        const stop = claudeLimitStop(RESET);
        const h = yield* unarmedAfterSwitch({
          thread: {
            ...stop,
            limitRecovery: {
              runId: stop.latestRunId,
              resetAt: stop.usageLimitResetAt,
              autoResume: false,
              snooze: false,
              checkNow: false,
              explicitArm: false,
              requestId: "web:auto-resume-off",
            } as never,
          },
        });
        yield* h.sweep;
        yield* h.sweep;
        assert.deepEqual(h.state.commands, []);
      }),
    );

    it.effect("a thread moved off the stopped run's instance is not armed", () =>
      Effect.gen(function* () {
        const h = yield* unarmedAfterSwitch({
          runInstance: ProviderInstanceId.make("claudeAgent-work"),
        });
        yield* h.sweep;
        yield* h.sweep;
        assert.deepEqual(h.state.commands, []);
      }),
    );

    it.effect.each(["projectPaused", "projectArchived"] as const)(
      "a project with %s keeps its threads stopped",
      (held) =>
        Effect.gen(function* () {
          const h = yield* unarmedAfterSwitch();
          h.state[held] = true;
          yield* h.sweep;
          yield* h.sweep;
          assert.deepEqual(h.state.commands, []);
        }),
    );

    it.effect("a person's snooze holds the thread", () =>
      Effect.gen(function* () {
        const h = yield* afterSwitch((at) => claudeRead(at, { changedAt: HOUR }), {
          thread: { ...claudeLimitStop(RESET), snoozedUntil: DateTime.makeUnsafe(3 * HOUR) },
        });
        yield* h.sweep;
        assert.deepEqual(resumes(h.state.commands), []);
      }),
    );

    it.effect("a run handed to another machine stays there", () =>
      Effect.gen(function* () {
        const h = yield* afterSwitch((at) => claudeRead(at, { changedAt: HOUR }));
        h.state.handoffBlocked = true;
        yield* h.sweep;
        assert.deepEqual(resumes(h.state.commands), []);
      }),
    );

    it.effect("a thread moved to another instance is not resumed on the new account", () =>
      Effect.gen(function* () {
        const h = yield* afterSwitch((at) => claudeRead(at, { changedAt: HOUR }));
        h.state.current = {
          ...h.state.current,
          providerInstanceId: ProviderInstanceId.make("claudeAgent-work"),
        };
        yield* h.sweep;
        assert.deepEqual(resumes(h.state.commands), []);
      }),
    );
  });

  it.effect("resumes paused threads on one instance one at a time", () =>
    Effect.gen(function* () {
      const h = yield* afterSwitch((at) => claudeRead(at, { changedAt: HOUR }));
      const running = yield* h.running;
      yield* running;
      assert.lengthOf(resumes(h.state.commands), 1);
      // A second thread, stopped on the same old account.
      h.state.current = {
        ...claudeLimitStop(RESET),
        id: ThreadId.make("claude-limited-2"),
        latestRunId: RunId.make("failed-run-2"),
      };
      yield* running; // arms it
      yield* running;
      yield* TestClock.adjust("4 seconds");
      yield* running;
      assert.lengthOf(resumes(h.state.commands), 1);
      yield* TestClock.adjust("2 seconds");
      yield* running;
      const sent = resumes(h.state.commands);
      assert.lengthOf(sent, 2);
      assert.include(sent[1], "claude-limited-2");
    }),
  );

  it.effect("a resume the orchestrator refuses never takes the instance's slot", () =>
    Effect.gen(function* () {
      const h = yield* afterSwitch((at) => claudeRead(at, { changedAt: HOUR }), {
        refusesResume: (command) =>
          command.type === "message.dispatch" && command.threadId === "claude-limited",
      });
      const running = yield* h.running;
      yield* running;
      // The refusal commits like any command but starts no run, and the same
      // id replays that receipt on the next sweep. Neither takes the slot.
      yield* TestClock.adjust("1 second");
      yield* running;
      const refusedIds = h.state.attempts.filter((id) => id.startsWith("limit-resume:"));
      assert.lengthOf(refusedIds, 2);
      assert.equal(refusedIds[0], refusedIds[1]);
      assert.include(refusedIds[0], ":acct:");
      assert.deepEqual(resumes(h.state.commands), []);
      assert.deepEqual(h.state.runs, []);
      h.state.current = {
        ...claudeLimitStop(RESET),
        id: ThreadId.make("claude-limited-2"),
        latestRunId: RunId.make("failed-run-2"),
      };
      yield* running; // arms it
      yield* running;
      // No 5 s wait: the refused thread used no slot.
      const sent = resumes(h.state.commands);
      assert.lengthOf(sent, 1);
      assert.include(sent[0], "claude-limited-2");
    }),
  );
});
