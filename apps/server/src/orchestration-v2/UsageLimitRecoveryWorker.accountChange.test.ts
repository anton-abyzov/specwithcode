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

  describe("keeps what a person or the thread chose", () => {
    it.effect("auto-continue off arms nothing and resumes nothing", () =>
      Effect.gen(function* () {
        const h = claudeSweepHarness({
          thread: claudeLimitStop(RESET),
          provider: (at) => claudeRead(at, { changedAt: HOUR }),
        });
        yield* h.sweep;
        yield* TestClock.adjust("1 hour");
        h.state.snapshot = claudeRead(HOUR, { changedAt: HOUR });
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
