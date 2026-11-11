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
      // The next sweep finds nothing left to send; after that the threads are
      // not read again for this change.
      yield* TestClock.adjust("5 seconds");
      yield* running;
      yield* TestClock.adjust("1 minute");
      yield* running;
      yield* TestClock.adjust("1 minute");
      yield* running;
      assert.lengthOf(sent(h.state.commands), 1);
      assert.equal(h.state.snapshotReads, 2);
    }),
  );

  it.effect("a sweep built after a restart sends the same id, which is taken once", () =>
    Effect.gen(function* () {
      const h = yield* afterSwitch([coordinator]);
      // Nothing survives in memory between these two; the id is all that keeps
      // the message to one, through the orchestrator's command receipts.
      yield* h.sweep;
      yield* h.sweep;
      assert.deepEqual(h.state.attempts, [
        `limit-lifted:coordinator:run-9:${HOUR}`,
        `limit-lifted:coordinator:run-9:${HOUR}`,
      ]);
    }),
  );

  it.effect("a message that failed to send is tried again, the others are not sent twice", () =>
    Effect.gen(function* () {
      let busy = true;
      const second = { ...coordinator, id: ThreadId.make("second") };
      const h = yield* afterSwitch([coordinator, second], {
        harness: {
          fails: (command) =>
            busy && command.type === "message.dispatch" && command.threadId === "coordinator",
        },
      });
      const running = yield* h.running;
      yield* running;
      assert.deepEqual(
        sent(h.state.commands).map((command) => command.threadId),
        [ThreadId.make("second")],
      );
      busy = false;
      yield* TestClock.adjust("5 seconds");
      yield* running;
      assert.includeMembers(
        sent(h.state.commands).map((command) => command.commandId),
        [`limit-lifted:coordinator:run-9:${HOUR}`, `limit-lifted:second:run-9:${HOUR}`],
      );
      // One more pass finds nothing left; then the threads are not read again.
      yield* TestClock.adjust("5 seconds");
      yield* running;
      const reads = h.state.snapshotReads;
      yield* TestClock.adjust("5 seconds");
      yield* running;
      assert.equal(h.state.snapshotReads, reads);
      assert.lengthOf(sent(h.state.commands), 2);
    }),
  );

  it.effect("sends one message per sweep, and stops when the new account fills up", () =>
    Effect.gen(function* () {
      const thread = (id: string) => ({ ...coordinator, id: ThreadId.make(id) });
      const h = yield* afterSwitch([thread("first"), thread("second"), thread("third")]);
      const running = yield* h.running;
      yield* running;
      assert.deepEqual(
        sent(h.state.commands).map((command) => command.threadId),
        [ThreadId.make("first")],
      );
      yield* TestClock.adjust("5 seconds");
      yield* running;
      assert.deepEqual(
        sent(h.state.commands).map((command) => command.threadId),
        [ThreadId.make("first"), ThreadId.make("second")],
      );
      // The new subscription is spent too: the third thread keeps waiting.
      yield* TestClock.adjust("5 seconds");
      h.state.snapshot = claudeRead(HOUR + 10_000, { changedAt: HOUR, usedPercent: 100 });
      yield* running;
      assert.lengthOf(sent(h.state.commands), 2);
      // Room again: it gets its message.
      yield* TestClock.adjust("5 seconds");
      h.state.snapshot = claudeRead(HOUR + 15_000, { changedAt: HOUR });
      yield* running;
      assert.deepEqual(
        sent(h.state.commands).map((command) => command.threadId),
        [ThreadId.make("first"), ThreadId.make("second"), ThreadId.make("third")],
      );
    }),
  );

  it.effect("waits while a process of the instance still runs on the old subscription", () =>
    Effect.gen(function* () {
      const h = yield* afterSwitch([coordinator]);
      h.state.replacementPending = true;
      const running = yield* h.running;
      yield* running;
      yield* TestClock.adjust("5 seconds");
      yield* running;
      // A turn started now would run on the previous subscription and hit its limit.
      assert.deepEqual(sent(h.state.commands), []);
      assert.equal(h.state.snapshotReads, 0);
      h.state.replacementPending = false;
      yield* TestClock.adjust("5 seconds");
      yield* running;
      assert.lengthOf(sent(h.state.commands), 1);
    }),
  );

  it.effect("a message that keeps failing is given up after three sweeps", () =>
    Effect.gen(function* () {
      const h = yield* afterSwitch([coordinator], { harness: { fails: () => true } });
      const running = yield* h.running;
      for (let sweep = 0; sweep < 6; sweep += 1) {
        yield* running;
        yield* TestClock.adjust("5 seconds");
      }
      assert.lengthOf(h.state.attempts, 3);
      assert.equal(h.state.snapshotReads, 3);
      assert.deepEqual(sent(h.state.commands), []);
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

  it.effect("an archived project sends nothing", () =>
    Effect.gen(function* () {
      const h = yield* afterSwitch([coordinator]);
      h.state.projectArchived = true;
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

  it.effect("a project paused at the change gets the message once it runs again", () =>
    Effect.gen(function* () {
      const h = yield* afterSwitch([coordinator]);
      h.state.projectPaused = true;
      const running = yield* h.running;
      yield* running;
      yield* TestClock.adjust("5 seconds");
      yield* running;
      assert.deepEqual(sent(h.state.commands), []);
      h.state.projectPaused = false;
      yield* TestClock.adjust("5 seconds");
      yield* running;
      assert.lengthOf(sent(h.state.commands), 1);
    }),
  );

  it.effect("a thread held by a handoff gets the message once the hold ends", () =>
    Effect.gen(function* () {
      const h = yield* afterSwitch([coordinator]);
      h.state.handoffBlocked = true;
      const running = yield* h.running;
      yield* running;
      yield* TestClock.adjust("5 seconds");
      yield* running;
      assert.deepEqual(sent(h.state.commands), []);
      h.state.handoffBlocked = false;
      yield* TestClock.adjust("5 seconds");
      yield* running;
      assert.lengthOf(sent(h.state.commands), 1);
    }),
  );

  it.effect("a blocked thread and a limit stop on one instance leave one at a time", () =>
    Effect.gen(function* () {
      const h = yield* afterSwitch([coordinator], {
        harness: { thread: claudeLimitStop(5 * HOUR), globalAutoResume: true },
      });
      const running = yield* h.running;
      yield* running;
      yield* running;
      // The blocked thread took the instance's turn; the stop's resume waits for the next.
      assert.deepEqual(
        sent(h.state.commands).map((command) => command.threadId),
        [ThreadId.make("coordinator")],
      );
      yield* TestClock.adjust("5 seconds");
      yield* running;
      assert.deepEqual(
        sent(h.state.commands).map((command) => command.threadId),
        [ThreadId.make("coordinator"), ThreadId.make("claude-limited")],
      );
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
