import { assert, it } from "@effect/vitest";
import {
  CommandId,
  NodeId,
  RunId,
  RuntimeRequestId,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { provider } from "../studio/fixtures.ts";
import type * as ProjectionStore from "./ProjectionStore.ts";
import { claudeLimitStop, claudeSweepHarness } from "./UsageLimitRecoveryWorker.testkit.ts";
import {
  LIMIT_CHECK_INTERVAL_MS,
  LIMIT_NEW_WINDOW_MIN_MS,
  LIMIT_STOP_CHAIN_WINDOW_MS,
  derivedLimitResumeAt,
  isLimitRecoveryCandidate,
  limitChainSuffix,
  limitReadShowsRoom,
  limitRecoveryChain,
  nextLimitChainAttempt,
} from "./usageLimitRecovery.ts";

const summary = (kind: "user_input" | "command") => ({
  id: RuntimeRequestId.make("question"),
  kind,
  createdAt: DateTime.makeUnsafe(0),
});

it("blocks recovery only on a request that really holds the thread", () => {
  const stop = claudeLimitStop(60_000);
  const latest = stop.latestRunId;
  const withRequest = (
    pending: ProjectionStore.ProjectionLimitRecoveryCandidate["pendingRuntimeRequest"] & object,
  ) => ({ ...stop, pendingRuntimeRequest: pending });
  assert.isTrue(isLimitRecoveryCandidate(stop));
  // A question the next message answers does not hold the thread.
  assert.isTrue(
    isLimitRecoveryCandidate(
      withRequest({ ...summary("user_input"), responseCapability: { type: "message" } } as never),
    ),
  );
  // Nor does one an earlier run left behind.
  assert.isTrue(
    isLimitRecoveryCandidate(
      withRequest({ ...summary("command"), runId: RunId.make("earlier-run") } as never),
    ),
  );
  // An approval for the latest run, a live question, or a summary without its
  // detail still does.
  assert.isFalse(
    isLimitRecoveryCandidate(withRequest({ ...summary("command"), runId: latest } as never)),
  );
  assert.isFalse(
    isLimitRecoveryCandidate(
      withRequest({
        ...summary("user_input"),
        responseCapability: { type: "live", providerSessionId: "session" },
      } as never),
    ),
  );
  assert.isFalse(isLimitRecoveryCandidate(withRequest(summary("user_input"))));
});

const records = (
  capability: { readonly type: "message" } | { readonly type: "live"; providerSessionId: string },
) =>
  ({
    runtimeRequests: [
      {
        id: RuntimeRequestId.make("question"),
        nodeId: NodeId.make("question-node"),
        kind: "user_input",
        status: "pending",
        responseCapability: capability,
      },
    ],
    nodes: [{ id: NodeId.make("question-node"), runId: RunId.make("failed-run") }],
    runs: [],
  }) as unknown as Pick<OrchestrationV2ThreadProjection, "runtimeRequests" | "nodes" | "runs">;

it.effect.each([
  ["message", true],
  ["live", false],
] as const)(
  "resumes past a pending %s question only when a message answers it",
  ([kind, resumes]) =>
    Effect.gen(function* () {
      const { state, sweep } = claudeSweepHarness({
        thread: claudeLimitStop(60 * 60_000),
        globalAutoResume: true,
        pending: {
          summary: summary("user_input"),
          records: records(
            kind === "message"
              ? { type: "message" }
              : { type: "live", providerSessionId: "session" },
          ),
        },
      });
      yield* sweep;
      yield* TestClock.adjust("61 minutes");
      yield* sweep;
      assert.equal(state.commands.at(-1)?.type === "message.dispatch", resumes);
    }),
);

it.effect("does not resume past an older blocking request behind a message question", () =>
  Effect.gen(function* () {
    const { state, sweep } = claudeSweepHarness({
      thread: claudeLimitStop(60 * 60_000),
      globalAutoResume: true,
      pending: {
        // The shell summarizes the newest pending request only.
        summary: summary("user_input"),
        records: {
          runtimeRequests: [
            {
              id: RuntimeRequestId.make("approval"),
              nodeId: NodeId.make("question-node"),
              kind: "command",
              status: "pending",
            },
            ...records({ type: "message" }).runtimeRequests,
          ],
          nodes: records({ type: "message" }).nodes,
          runs: [],
        } as unknown as Pick<OrchestrationV2ThreadProjection, "runtimeRequests" | "nodes" | "runs">,
      },
    });
    yield* sweep;
    yield* TestClock.adjust("61 minutes");
    yield* sweep;
    assert.deepEqual(state.commands, []);
  }),
);

it("bounds a stop chain by time, not by the reset each stop reports", () => {
  const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
  const stopAfter = (
    previous: { attempt: number; stopMs: number; resetAt: string | null },
    stopMs: number,
    usageLimitResetAt: string | null,
  ): ProjectionStore.ProjectionLimitRecoveryCandidate => ({
    ...claudeLimitStop(0),
    latestRunId: RunId.make("next-run"),
    latestRunCompletedAt: DateTime.makeUnsafe(stopMs),
    updatedAt: DateTime.makeUnsafe(stopMs),
    usageLimitResetAt,
    limitRecovery: {
      runId: RunId.make("failed-run"),
      resetAt: previous.resetAt,
      autoResume: true,
      requestId: CommandId.make(
        `limit-arm:x${limitChainSuffix(previous.attempt, previous.stopMs)}`,
      ),
    },
  });
  const minute = 60_000;
  // Distinct past resets, or none then a stale one: each continues the chain.
  let previous = { attempt: 0, stopMs: 0, resetAt: iso(-minute) as string | null };
  for (const [stopMs, resetAt] of [
    [10 * minute, iso(-2 * minute)],
    [40 * minute, null],
    [130 * minute, iso(129 * minute)],
  ] as const) {
    const attempt = nextLimitChainAttempt(stopAfter(previous, stopMs, resetAt));
    assert.equal(attempt, previous.attempt + 1);
    previous = { attempt, stopMs, resetAt };
  }
  // A near reset (a retry-after) continues it too.
  assert.equal(nextLimitChainAttempt(stopAfter(previous, 135 * minute, iso(136 * minute))), 4);
  // A reset that opens a new window past the last resume starts a new chain.
  const lastResume = 130 * minute + 5 * 60 * minute;
  assert.equal(
    nextLimitChainAttempt(
      stopAfter(previous, 135 * minute, iso(lastResume + LIMIT_NEW_WINDOW_MIN_MS)),
    ),
    0,
  );
  // So does a stop long after the last resume.
  assert.equal(
    nextLimitChainAttempt(stopAfter(previous, lastResume + LIMIT_STOP_CHAIN_WINDOW_MS, null)),
    0,
  );
  // An arm that recorded no chain is resumed at its reset; with none it starts over.
  assert.equal(
    nextLimitChainAttempt({
      ...stopAfter(previous, 10 * minute, iso(60 * minute)),
      limitRecovery: {
        runId: RunId.make("failed-run"),
        resetAt: iso(5 * minute),
        autoResume: true,
        requestId: CommandId.make("user-arm"),
      },
    }),
    1,
  );
  assert.equal(
    nextLimitChainAttempt({
      ...stopAfter(previous, 10 * minute, null),
      limitRecovery: {
        runId: RunId.make("failed-run"),
        resetAt: null,
        autoResume: true,
        requestId: CommandId.make("user-arm"),
      },
    }),
    0,
  );
});

const read = (at: number, patch: Partial<NonNullable<ServerProvider["usageLimits"]>> = {}) => {
  const base = provider("claudeAgent", "claudeAgent", at);
  return {
    ...base,
    usageLimits: {
      checkedAt: DateTime.formatIso(DateTime.makeUnsafe(at)),
      windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 4 }],
      ordinaryUsageAllowed: true,
      ...patch,
    },
  } satisfies ServerProvider;
};

it("finds room only in a read taken after the stop", () => {
  const stopMs = 1_000_000;
  const now = stopMs + 10 * 60_000;
  assert.equal(limitReadShowsRoom(read(stopMs + 1), stopMs, now), "room");
  // Taken before the stop, or not at all: read again.
  assert.equal(limitReadShowsRoom(read(stopMs - 1), stopMs, now), "check");
  assert.equal(limitReadShowsRoom(undefined, stopMs, now), "check");
  // After the stop but still out of room.
  assert.equal(
    limitReadShowsRoom(read(stopMs + 1, { ordinaryUsageAllowed: false }), stopMs, now),
    "check",
  );
  const spent = { id: "five_hour", kind: "session", label: "Session", usedPercent: 100 } as const;
  assert.equal(limitReadShowsRoom(read(stopMs + 1, { windows: [spent] }), stopMs, now), "check");
  // A reset the provider still reports ahead: nothing to read before it.
  const ahead = DateTime.formatIso(DateTime.makeUnsafe(now + 60_000));
  assert.equal(
    limitReadShowsRoom(read(stopMs + 1, { windows: [{ ...spent, resetsAt: ahead }] }), stopMs, now),
    "wait",
  );
  assert.equal(
    limitReadShowsRoom(read(stopMs + 1, { nativeDenialResetsAt: ahead }), stopMs, now),
    "wait",
  );
  // A provider that reports no usage proves room by its own status read.
  const plain = { ...provider("copilot", "acpRegistry", stopMs + 1), usageLimits: undefined };
  assert.equal(limitReadShowsRoom(plain, stopMs, now), "room");
  assert.equal(limitReadShowsRoom({ ...plain, status: "error" }, stopMs, now), "check");
});

it("derives the resume time from the stop chain", () => {
  const armed = (
    usageLimitResetAt: string | null,
    requestId: string,
  ): ProjectionStore.ProjectionLimitRecoveryCandidate => ({
    ...claudeLimitStop(0),
    usageLimitResetAt,
    limitRecovery: {
      runId: RunId.make("failed-run"),
      resetAt: usageLimitResetAt,
      autoResume: true,
      requestId: CommandId.make(requestId),
    },
  });
  assert.deepEqual(limitRecoveryChain("limit-arm:t:r:NaN:chain:2:-5"), { attempt: 2, stopMs: -5 });
  assert.deepEqual(limitRecoveryChain("user-arm"), { attempt: 0, stopMs: null });
  assert.deepEqual(limitRecoveryChain(undefined), { attempt: 0, stopMs: null });
  // A reported reset after the stop decides by itself.
  const reset = DateTime.formatIso(DateTime.makeUnsafe(60 * 60_000));
  assert.isNull(derivedLimitResumeAt(armed(reset, "user-arm")));
  // No reset: the first wait.
  assert.equal(derivedLimitResumeAt(armed(null, "user-arm")), LIMIT_CHECK_INTERVAL_MS);
  // A repeat waits longer, and never before the reset it reports.
  assert.equal(
    derivedLimitResumeAt(armed(null, `limit-arm:x${limitChainSuffix(1, 0)}`)),
    4 * LIMIT_CHECK_INTERVAL_MS,
  );
  assert.equal(
    derivedLimitResumeAt(armed(reset, `limit-arm:x${limitChainSuffix(1, 0)}`)),
    60 * 60_000,
  );
  // Nothing is derived for a stop that is not armed to resume.
  assert.isNull(
    derivedLimitResumeAt({
      ...armed(null, "user-arm"),
      limitRecovery: { ...armed(null, "user-arm").limitRecovery!, autoResume: false },
    }),
  );
});
