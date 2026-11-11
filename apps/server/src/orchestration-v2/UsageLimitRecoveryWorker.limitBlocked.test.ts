import { assert, describe, it } from "@effect/vitest";
import {
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type ServerProvider,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { provider } from "../studio/fixtures.ts";
import { claudeLimitStop, claudeSweepHarness } from "./UsageLimitRecoveryWorker.testkit.ts";

/**
 * A coordinator ended its turn with "Blocker: the weekly limit is used up" at
 * 30 minutes. No run of its own failed, so nothing is there to resume. At one
 * hour the Claude CLI on the machine is signed in to another subscription with
 * room: the coordinator gets one message saying so, which ends its Blocked
 * state and starts a turn.
 */
const HOUR = 60 * 60_000;
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const claudeRead = (
  at: number,
  options: { readonly changedAt?: number; readonly usedPercent?: number } = {},
): ServerProvider =>
  ({
    ...provider("claudeAgent", "claudeAgent", at),
    displayName: "Claude",
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
      nativeAllowanceObservedAt: iso(at),
      ...(options.changedAt === undefined ? {} : { accountChangedAt: iso(options.changedAt) }),
      ordinaryUsageAllowed: true,
    },
  }) as ServerProvider;

const coordinator = {
  id: ThreadId.make("coordinator"),
  status: "completed",
  latestRunId: RunId.make("run-9"),
  latestRunCompletedAt: DateTime.makeUnsafe(30 * 60_000),
  activeRunId: null,
  archivedAt: null,
  settledOverride: null,
  snoozedUntil: null,
  pendingRuntimeRequest: null,
  reportedBlocker:
    "the weekly Fable 5.2 limit is used up and resets on November 13, 2026 at 02:00 UTC. Wait, or move to another model?",
  lineage: { relationshipToParent: "root" },
  creationSource: "web",
} as unknown as Partial<OrchestrationV2ThreadShell>;

const sent = (commands: ReadonlyArray<OrchestrationV2ServerCommand>) =>
  commands.flatMap((command) => (command.type === "message.dispatch" ? [command] : []));

/** One hour on, with `snapshot` in the registry and `shells` on the machine. */
const afterSwitch = (
  shells: ReadonlyArray<Partial<OrchestrationV2ThreadShell>>,
  input: {
    readonly snapshot?: (at: number) => ServerProvider;
    readonly harness?: Partial<Parameters<typeof claudeSweepHarness>[0]>;
  } = {},
) =>
  Effect.gen(function* () {
    const snapshot = input.snapshot ?? ((at: number) => claudeRead(at, { changedAt: HOUR }));
    const h = claudeSweepHarness({
      // No thread on the machine is stopped on a limit of its own.
      thread: { ...claudeLimitStop(5 * HOUR), status: "completed", lastErrorClass: null },
      provider: snapshot,
      shells: () => shells,
      ...input.harness,
    });
    yield* TestClock.adjust("1 hour");
    h.state.snapshot = snapshot(HOUR);
    return h;
  });

describe("a thread blocked on a usage-limit report, after the account changes", () => {
  it.effect("gets one message that says so and starts a turn", () =>
    Effect.gen(function* () {
      const h = yield* afterSwitch([coordinator]);
      const running = yield* h.running;
      yield* running;
      const messages = sent(h.state.commands);
      assert.lengthOf(messages, 1);
      const message = messages[0]!;
      assert.equal(message.commandId, `limit-lifted:coordinator:run-9:${HOUR}`);
      assert.equal(message.threadId, "coordinator");
      assert.equal(message.createdBy, "user");
      assert.equal(message.creationSource, "server");
      assert.deepEqual(message.dispatchMode, { type: "start_immediately" });
      assert.include(message.text, "Claude on this machine is now signed in to a different");
      // Later sweeps send nothing and do not read every thread again.
      yield* TestClock.adjust("5 seconds");
      yield* running;
      yield* TestClock.adjust("1 minute");
      yield* running;
      assert.lengthOf(sent(h.state.commands), 1);
      assert.equal(h.state.snapshotReads, 1);
    }),
  );

  it.effect("a sweep built after a restart sends the same message id", () =>
    Effect.gen(function* () {
      const h = yield* afterSwitch([coordinator]);
      yield* h.sweep;
      yield* h.sweep;
      assert.deepEqual(
        [...new Set(sent(h.state.commands).map((command) => command.commandId))],
        [`limit-lifted:coordinator:run-9:${HOUR}`],
      );
    }),
  );

  it.effect("a second change sends a second message", () =>
    Effect.gen(function* () {
      const h = yield* afterSwitch([coordinator]);
      const running = yield* h.running;
      yield* running;
      yield* TestClock.adjust("30 minutes");
      h.state.snapshot = claudeRead(HOUR + 30 * 60_000, { changedAt: HOUR + 30 * 60_000 });
      yield* running;
      assert.deepEqual(
        sent(h.state.commands).map((command) => command.commandId),
        [
          `limit-lifted:coordinator:run-9:${HOUR}`,
          `limit-lifted:coordinator:run-9:${HOUR + 30 * 60_000}`,
        ],
      );
    }),
  );

  it.effect("only the threads blocked on a limit get it", () =>
    Effect.gen(function* () {
      const other = (id: string, patch: Record<string, unknown>) =>
        ({
          ...coordinator,
          id: ThreadId.make(id),
          ...patch,
        }) as Partial<OrchestrationV2ThreadShell>;
      const h = yield* afterSwitch([
        other("question", { reportedBlocker: "Pair Chrome, or skip the check?" }),
        other("no-blocker", { reportedBlocker: null }),
        other("running", { activeRunId: RunId.make("run-10") }),
        other("settled", { settledOverride: "settled" }),
        other("archived", { archivedAt: DateTime.makeUnsafe(40 * 60_000) }),
        other("snoozed", { snoozedUntil: DateTime.makeUnsafe(3 * HOUR) }),
        other("pending", { pendingRuntimeRequest: { id: "request" } }),
        other("reported-later", { latestRunCompletedAt: DateTime.makeUnsafe(HOUR + 1) }),
        coordinator,
      ]);
      yield* h.sweep;
      assert.deepEqual(
        sent(h.state.commands).map((command) => command.threadId),
        [ThreadId.make("coordinator")],
      );
    }),
  );

  it.effect.each([
    ["the same account", (at: number) => claudeRead(at)],
    [
      "a new account that is spent too",
      (at: number) => claudeRead(at, { changedAt: HOUR, usedPercent: 100 }),
    ],
  ] as const)("%s sends nothing", ([, snapshot]) =>
    Effect.gen(function* () {
      const h = yield* afterSwitch([coordinator], { snapshot });
      yield* h.sweep;
      assert.deepEqual(sent(h.state.commands), []);
      assert.equal(h.state.snapshotReads, 0);
    }),
  );

  it.effect("a change from more than five hours ago sends nothing", () =>
    Effect.gen(function* () {
      const h = yield* afterSwitch([coordinator]);
      yield* TestClock.adjust("6 hours");
      h.state.snapshot = claudeRead(7 * HOUR, { changedAt: HOUR });
      yield* h.sweep;
      assert.deepEqual(sent(h.state.commands), []);
    }),
  );

  it.effect("a project that leaves subscription changes to the person sends nothing", () =>
    Effect.gen(function* () {
      const h = yield* afterSwitch([coordinator], {
        harness: { settings: { autoApproveSubscriptionChange: false } },
      });
      yield* h.sweep;
      assert.deepEqual(sent(h.state.commands), []);
    }),
  );

  it.effect("a paused project sends nothing", () =>
    Effect.gen(function* () {
      const h = yield* afterSwitch([coordinator]);
      h.state.projectPaused = true;
      yield* h.sweep;
      assert.deepEqual(sent(h.state.commands), []);
    }),
  );

  it.effect("a thread handed to another machine is left to it", () =>
    Effect.gen(function* () {
      const h = yield* afterSwitch([coordinator]);
      h.state.handoffBlocked = true;
      yield* h.sweep;
      assert.deepEqual(sent(h.state.commands), []);
    }),
  );

  it.effect("a reply that lands after the snapshot was read wins", () =>
    Effect.gen(function* () {
      let reads = 0;
      const h = yield* afterSwitch([], {
        harness: {
          // The snapshot still lists the blocker; read again, the thread has moved on.
          shells: () =>
            reads++ === 0 ? [coordinator] : [{ ...coordinator, reportedBlocker: null }],
        },
      });
      yield* h.sweep;
      assert.isAbove(reads, 1);
      assert.deepEqual(sent(h.state.commands), []);
    }),
  );
});
