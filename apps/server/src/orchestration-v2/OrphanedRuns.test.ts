import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSettings from "../serverSettings.ts";
import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as OrphanedRuns from "./OrphanedRuns.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2SessionRuntime } from "./ProviderAdapter.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RunLiveness from "./RunLiveness.ts";
import * as StaleRunWatchdog from "./StaleRunWatchdog.ts";

const T0 = DateTime.makeUnsafe(0);
const at = (minutes: number) => DateTime.makeUnsafe(minutes * 60_000);

/**
 * The 2026-10-19 orphan: running, its last item a finished dynamic tool, its
 * provider session stopped, and no ingestion left.
 */
const projection = (
  overrides: Partial<Record<keyof OrchestrationV2ThreadProjection, unknown>> = {},
): OrchestrationV2ThreadProjection =>
  ({
    thread: {
      id: "thread-1",
      projectId: "project-1",
      providerInstanceId: "copilot",
      archivedAt: null,
      deletedAt: null,
      updatedAt: T0,
    },
    runs: [
      {
        id: "run-1",
        threadId: "thread-1",
        ordinal: 1,
        status: "running",
        providerInstanceId: "copilot",
        providerThreadId: "provider-thread-1",
        activeAttemptId: "attempt-1",
        rootNodeId: "node-1",
        requestedAt: T0,
        startedAt: T0,
        completedAt: null,
      },
    ],
    attempts: [
      {
        id: "attempt-1",
        runId: "run-1",
        rootNodeId: "node-1",
        providerTurnId: "provider-turn-1",
        status: "running",
        startedAt: T0,
        completedAt: null,
      },
    ],
    nodes: [{ id: "node-1", runId: "run-1", status: "running", completedAt: null }],
    providerTurns: [
      {
        id: "provider-turn-1",
        providerThreadId: "provider-thread-1",
        nodeId: "node-1",
        runAttemptId: "attempt-1",
        ordinal: 1,
        status: "running",
        completedAt: null,
      },
    ],
    providerThreads: [
      {
        id: "provider-thread-1",
        driver: "acp",
        providerInstanceId: "copilot",
        providerSessionId: "session-1",
        status: "active",
      },
    ],
    providerSessions: [{ id: "session-1", status: "stopped" }],
    runtimeRequests: [],
    subagents: [],
    messages: [],
    turnItems: [
      {
        id: "item-1",
        runId: "run-1",
        nodeId: "node-1",
        ordinal: 1000006,
        type: "dynamic_tool",
        status: "completed",
        updatedAt: T0,
      },
    ],
    ...overrides,
  }) as unknown as OrchestrationV2ThreadProjection;

const runOf = (value: OrchestrationV2ThreadProjection) => value.runs[0] as OrchestrationV2Run;
const ended = { ingesting: false, sessionLive: false };

it("finds a run whose session ended, whatever its last item", () => {
  const value = projection();
  assert.equal(OrphanedRuns.orphanedRunKind(value, runOf(value), ended, at(3)), "session_ended");
});

it("waits out the quiet period before calling a run orphaned", () => {
  const value = projection();
  assert.isNull(OrphanedRuns.orphanedRunKind(value, runOf(value), ended, at(1)));
  const recent = projection({
    turnItems: [{ runId: "run-1", type: "assistant_message", status: "running", updatedAt: at(9) }],
  });
  assert.isNull(OrphanedRuns.orphanedRunKind(recent, runOf(recent), ended, at(10)));
});

it("never settles a run this process still reads events for while its session is open", () => {
  const value = projection();
  assert.isNull(
    OrphanedRuns.orphanedRunKind(
      value,
      runOf(value),
      { ingesting: true, sessionLive: true },
      at(600),
    ),
  );
});

it("gives an unobserved run on a live session longer", () => {
  const value = projection();
  const unobserved = { ingesting: false, sessionLive: true };
  assert.isNull(OrphanedRuns.orphanedRunKind(value, runOf(value), unobserved, at(5)));
  assert.equal(OrphanedRuns.orphanedRunKind(value, runOf(value), unobserved, at(11)), "unobserved");
});

it("measures quiet from the run's own activity, not messages queued behind it", () => {
  // Child reports keep arriving (thread.updatedAt at 59 min); the run itself
  // has said nothing since it started.
  const value = projection({
    thread: {
      id: "thread-1",
      projectId: "project-1",
      providerInstanceId: "copilot",
      archivedAt: null,
      deletedAt: null,
      updatedAt: at(59),
    },
  });
  assert.equal(OrphanedRuns.orphanedRunKind(value, runOf(value), ended, at(60)), "session_ended");
});

const liveRead = { ingesting: true, sessionLive: true, sessionConfirmed: true };

it("finds a live, read run silent for 45 minutes with nothing open", () => {
  const value = projection();
  assert.isNull(OrphanedRuns.orphanedRunKind(value, runOf(value), liveRead, at(44)));
  assert.equal(OrphanedRuns.orphanedRunKind(value, runOf(value), liveRead, at(46)), "live_silent");
});

it.each([
  [
    "an open tool",
    {
      turnItems: [{ runId: "run-1", type: "command_execution", status: "running", updatedAt: T0 }],
    },
  ],
  [
    "a thread wait",
    {
      turnItems: [
        {
          runId: "run-1",
          type: "dynamic_tool",
          toolName: "mcp__studio-code__studio_thread_wait",
          status: "running",
          updatedAt: T0,
        },
      ],
    },
  ],
  ["a subagent", { subagents: [{ runId: "run-1", status: "running", updatedAt: T0 }] }],
  ["a pending request", { runtimeRequests: [{ status: "pending" }] }],
])("never calls a live run silent while it waits on %s", (_, overrides) => {
  const value = projection(overrides as never);
  assert.isNull(OrphanedRuns.orphanedRunKind(value, runOf(value), liveRead, at(600)));
});

// 1048 review F-02: native subagents outlive the run that launched them, in
// the same provider process. Interrupting a silent later run closes that
// process, so live work an earlier run left there keeps the run alive.
const earlierRunSubagent = {
  runs: [
    {
      id: "run-0",
      threadId: "thread-1",
      ordinal: 0,
      status: "completed",
      providerInstanceId: "copilot",
      providerThreadId: "provider-thread-1",
      requestedAt: T0,
      startedAt: T0,
      completedAt: T0,
    },
    runOf(projection()),
  ],
  subagents: [
    {
      id: "subagent-0",
      runId: "run-0",
      origin: "provider_native",
      providerThreadId: null,
      status: "running",
      updatedAt: T0,
    },
  ],
};

it("never calls a live run silent while its process runs an earlier run's subagents", () => {
  const value = projection(earlierRunSubagent as never);
  const run = value.runs[1] as OrchestrationV2Run;
  assert.isNull(
    OrphanedRuns.orphanedRunKind(value, run, { ...liveRead, backgroundWorkLive: true }, at(600)),
  );
  // An adapter that cannot tell: an open native subagent there counts as live.
  assert.isNull(OrphanedRuns.orphanedRunKind(value, run, liveRead, at(600)));
  // The process says that work is gone: the run is silent after all.
  assert.equal(
    OrphanedRuns.orphanedRunKind(value, run, { ...liveRead, backgroundWorkLive: false }, at(46)),
    "live_silent",
  );
});

it("ignores another provider thread's subagents when calling a live run silent", () => {
  const value = projection({
    ...earlierRunSubagent,
    subagents: [{ ...earlierRunSubagent.subagents[0], providerThreadId: "provider-thread-2" }],
  } as never);
  assert.equal(
    OrphanedRuns.orphanedRunKind(value, value.runs[1] as OrchestrationV2Run, liveRead, at(46)),
    "live_silent",
  );
});

it("needs a session this process holds open to call a run live but silent", () => {
  const value = projection();
  assert.isNull(
    OrphanedRuns.orphanedRunKind(
      value,
      runOf(value),
      { ingesting: true, sessionLive: true },
      at(600),
    ),
  );
});

it("finds a run stuck saving its checkpoint past the deadline", () => {
  const waiting = projection({
    runs: [{ ...runOf(projection()), status: "waiting" }],
    providerTurns: [
      {
        id: "provider-turn-1",
        providerThreadId: "provider-thread-1",
        nodeId: "node-1",
        runAttemptId: "attempt-1",
        ordinal: 1,
        status: "completed",
        completedAt: at(1),
      },
    ],
  });
  assert.isNull(OrphanedRuns.stuckWaitingRun(waiting, at(10)));
  assert.deepEqual(
    (({ run, status }) => [run.id, status])(OrphanedRuns.stuckWaitingRun(waiting, at(12))!),
    ["run-1", "completed"],
  );
  // A provider turn still running is not a checkpoint stall.
  const stillRunning = projection({ runs: [{ ...runOf(projection()), status: "waiting" }] });
  assert.isNull(OrphanedRuns.stuckWaitingRun(stillRunning, at(600)));
});

it("closes a held run on an ended session only once it waits on nothing", () => {
  const held = { ingesting: true, sessionLive: false };
  const open = projection({
    turnItems: [{ runId: "run-1", type: "command_execution", status: "running", updatedAt: T0 }],
  });
  assert.isNull(OrphanedRuns.orphanedRunKind(open, runOf(open), held, at(60)));
  const idle = projection();
  assert.isNull(OrphanedRuns.orphanedRunKind(idle, runOf(idle), held, at(4)));
  assert.equal(OrphanedRuns.orphanedRunKind(idle, runOf(idle), held, at(6)), "session_ended");
});

it("leaves the old finished-answer rule unable to close this orphan", () => {
  assert.isNull(StaleRunWatchdog.staleFinishedRun(projection(), at(240)));
});

interface Captured {
  readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  readonly effects: ReadonlyArray<PendingOrchestrationEffectV2>;
}

const harness = (input: {
  readonly value: OrchestrationV2ThreadProjection;
  readonly continueThreads?: boolean;
  readonly committed?: boolean;
  readonly liveSession?: boolean;
  readonly interrupted?: Ref.Ref<number>;
  readonly liveBackgroundWork?: boolean;
}) =>
  Effect.gen(function* () {
    const captured = yield* Ref.make<ReadonlyArray<Captured>>([]);
    const dispatched = yield* Ref.make(0);
    const interrupted = input.interrupted ?? (yield* Ref.make(0));
    const runtime = {
      interruptTurn: () => Ref.update(interrupted, (count) => count + 1),
      ...(input.liveBackgroundWork === undefined
        ? {}
        : { liveBackgroundWork: () => Effect.succeed(input.liveBackgroundWork) }),
    } as unknown as ProviderAdapterV2SessionRuntime;
    const layer = Layer.mergeAll(
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getRecoveryThreadIds: () => Effect.succeed([input.value.thread.id]),
        getThreadRecords: () => Effect.succeed(input.value),
        getRuntimeRecoveryProjection: () => Effect.succeed(input.value),
      }),
      Layer.mock(EventSink.EventSinkV2)({
        writeIfRunCurrent: (payload) =>
          Ref.update(captured, (current) => [
            ...current,
            { events: payload.events, effects: payload.effects ?? [] },
          ]).pipe(Effect.as({ committed: input.committed ?? true, storedEvents: [] })),
      }),
      Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
        get: () =>
          Effect.succeed(input.liveSession === true ? Option.some(runtime) : Option.none()),
      }),
      Layer.mock(Orchestrator.OrchestratorV2)({
        dispatch: () => Ref.update(dispatched, (count) => count + 1).pipe(Effect.as({} as never)),
      }),
      IdAllocator.layer,
      ServerSettings.layerTest({
        continueThreadsAfterServerUpdate: input.continueThreads === true,
      }),
      RunLiveness.layer,
      NodeCrypto.layer,
    );
    return { layer, captured, dispatched, interrupted };
  });

const payloads = (captured: ReadonlyArray<Captured>) =>
  captured.flatMap((write) => write.events.map((event) => event));

it.effect("fails an orphaned run visibly so the person can continue", () =>
  Effect.gen(function* () {
    const { layer, captured } = yield* harness({ value: projection() });
    const settled = yield* Effect.gen(function* () {
      const settler = yield* OrphanedRuns.makeSettler;
      return yield* settler.settle({
        threadId: "thread-1",
        runId: "run-1",
        kind: "session_ended",
      } as never);
    }).pipe(Effect.provide(layer));
    assert.isTrue(settled);
    const events = payloads(yield* Ref.get(captured));
    const run = events.find((event) => event.type === "run.updated");
    assert.equal(run?.type === "run.updated" ? run.payload.status : null, "failed");
    const error = events.find(
      (event) => event.type === "turn-item.updated" && event.payload.type === "error",
    );
    assert.isTrue(
      error?.type === "turn-item.updated" &&
        error.payload.type === "error" &&
        error.payload.failure.retryable === true &&
        error.payload.failure.class === "provider_error",
    );
    const statuses = events.flatMap((event) =>
      event.type === "provider-turn.updated" || event.type === "run-attempt.updated"
        ? [event.payload.status]
        : event.type === "provider-thread.updated"
          ? [event.payload.status]
          : [],
    );
    assert.deepEqual(statuses, ["failed", "failed", "idle"]);
    assert.deepEqual(
      (yield* Ref.get(captured)).flatMap((write) => write.effects),
      [],
    );
  }),
);

it.effect("cancels an orphaned run and queues a continuation when the project continues", () =>
  Effect.gen(function* () {
    const { layer, captured } = yield* harness({ value: projection(), continueThreads: true });
    yield* Effect.gen(function* () {
      const settler = yield* OrphanedRuns.makeSettler;
      yield* settler.settle({
        threadId: "thread-1",
        runId: "run-1",
        kind: "session_ended",
      } as never);
    }).pipe(Effect.provide(layer));
    const writes = yield* Ref.get(captured);
    const run = payloads(writes).find((event) => event.type === "run.updated");
    assert.equal(run?.type === "run.updated" ? run.payload.status : null, "cancelled");
    assert.deepEqual(
      writes.flatMap((write) => write.effects.map((effect) => effect.request)),
      [{ type: "provider-runtime.continue", sourceRunId: "run-1" }] as never,
    );
  }),
);

it.effect("stops the provider turn of an unobserved run it settled", () =>
  Effect.gen(function* () {
    const live = projection({ providerSessions: [{ id: "session-1", status: "ready" }] });
    const { layer, interrupted } = yield* harness({ value: live, liveSession: true });
    yield* Effect.gen(function* () {
      const settler = yield* OrphanedRuns.makeSettler;
      yield* settler.settle({ threadId: "thread-1", runId: "run-1", kind: "unobserved" } as never);
    }).pipe(Effect.provide(layer));
    assert.equal(yield* Ref.get(interrupted), 1);
  }),
);

it.effect("leaves a run that ended on its own meanwhile", () =>
  Effect.gen(function* () {
    const { layer, interrupted } = yield* harness({
      value: projection(),
      committed: false,
      liveSession: true,
    });
    const settled = yield* Effect.gen(function* () {
      const settler = yield* OrphanedRuns.makeSettler;
      return yield* settler.settle({
        threadId: "thread-1",
        runId: "run-1",
        kind: "unobserved",
      } as never);
    }).pipe(Effect.provide(layer));
    assert.isFalse(settled);
    assert.equal(yield* Ref.get(interrupted), 0);
  }),
);

it.effect("settles an orphaned run on the second sweep that finds it", () =>
  Effect.gen(function* () {
    const { layer, captured, dispatched } = yield* harness({ value: projection() });
    yield* Effect.gen(function* () {
      const watchdog = yield* StaleRunWatchdog.make;
      yield* TestClock.adjust("3 minutes");
      assert.equal(yield* watchdog.sweep(), 0);
      assert.equal(yield* watchdog.sweep(), 1);
    }).pipe(Effect.provide(layer));
    assert.equal((yield* Ref.get(captured)).length, 1);
    assert.equal(yield* Ref.get(dispatched), 0);
  }),
);

it.effect("leaves a run alone while this process reads its events and a tool is open", () =>
  Effect.gen(function* () {
    const { layer, captured } = yield* harness({
      value: projection({
        turnItems: [
          { runId: "run-1", type: "command_execution", status: "running", updatedAt: T0 },
        ],
      }),
      liveSession: true,
    });
    yield* Effect.gen(function* () {
      const watchdog = yield* StaleRunWatchdog.make;
      const liveness = yield* RunLiveness.RunLiveness;
      const release = yield* liveness.acquire("run-1" as never);
      yield* TestClock.adjust("3 hours");
      assert.equal(yield* watchdog.sweep(), 0);
      assert.equal(yield* watchdog.sweep(), 0);
      yield* release;
    }).pipe(Effect.provide(layer));
    assert.equal((yield* Ref.get(captured)).length, 0);
  }),
);

it.effect("interrupts a live run silent for 45 minutes on the second sweep", () =>
  Effect.gen(function* () {
    const live = projection({ providerSessions: [{ id: "session-1", status: "ready" }] });
    const { layer, captured, dispatched } = yield* harness({ value: live, liveSession: true });
    yield* Effect.gen(function* () {
      const watchdog = yield* StaleRunWatchdog.make;
      const liveness = yield* RunLiveness.RunLiveness;
      const release = yield* liveness.acquire("run-1" as never);
      yield* TestClock.adjust("44 minutes");
      assert.equal(yield* watchdog.sweep(), 0);
      assert.equal(yield* watchdog.sweep(), 0);
      yield* TestClock.adjust("2 minutes");
      assert.equal(yield* watchdog.sweep(), 0);
      assert.equal(yield* Ref.get(dispatched), 0);
      assert.equal(yield* watchdog.sweep(), 1);
      yield* release;
    }).pipe(Effect.provide(layer));
    assert.equal(yield* Ref.get(dispatched), 1);
    // Interrupted through its session, never settled behind its back.
    assert.equal((yield* Ref.get(captured)).length, 0);
  }),
);

it.effect.each([
  [true, 0],
  [false, 1],
] as const)(
  "asks the live process before interrupting a silent run (background work live: %s)",
  ([liveBackgroundWork, interrupts]) =>
    Effect.gen(function* () {
      const live = projection({
        ...earlierRunSubagent,
        providerSessions: [{ id: "session-1", status: "ready" }],
      } as never);
      const { layer, dispatched } = yield* harness({
        value: live,
        liveSession: true,
        liveBackgroundWork,
      });
      yield* Effect.gen(function* () {
        const watchdog = yield* StaleRunWatchdog.make;
        const liveness = yield* RunLiveness.RunLiveness;
        const release = yield* liveness.acquire("run-1" as never);
        yield* TestClock.adjust("46 minutes");
        yield* watchdog.sweep();
        yield* watchdog.sweep();
        yield* release;
      }).pipe(Effect.provide(layer));
      assert.equal(yield* Ref.get(dispatched), interrupts);
    }),
);

it.effect("settles a run stuck in waiting on the second sweep past its deadline", () =>
  Effect.gen(function* () {
    const waiting = projection({
      runs: [{ ...runOf(projection()), status: "waiting" }],
      nodes: [{ id: "node-1", runId: "run-1", status: "running", completedAt: null }],
      providerTurns: [
        {
          id: "provider-turn-1",
          providerThreadId: "provider-thread-1",
          nodeId: "node-1",
          runAttemptId: "attempt-1",
          ordinal: 1,
          status: "completed",
          completedAt: T0,
        },
      ],
    });
    const { layer, captured } = yield* harness({ value: waiting });
    yield* Effect.gen(function* () {
      const watchdog = yield* StaleRunWatchdog.make;
      yield* TestClock.adjust("9 minutes");
      assert.equal(yield* watchdog.sweep(), 0);
      assert.equal(yield* watchdog.sweep(), 0);
      yield* TestClock.adjust("2 minutes");
      assert.equal(yield* watchdog.sweep(), 0);
      assert.equal(yield* watchdog.sweep(), 1);
    }).pipe(Effect.provide(layer));
    const events = payloads(yield* Ref.get(captured));
    const run = events.find((event) => event.type === "run.updated");
    assert.equal(run?.type === "run.updated" ? run.payload.status : null, "completed");
    const node = events.find((event) => event.type === "node.updated");
    assert.equal(node?.type === "node.updated" ? node.payload.status : null, "completed");
  }),
);

it.effect("settles an orphan even while messages queued behind it bump the thread", () =>
  Effect.gen(function* () {
    const value = projection();
    const { layer, captured } = yield* harness({ value });
    yield* Effect.gen(function* () {
      const watchdog = yield* StaleRunWatchdog.make;
      yield* TestClock.adjust("3 minutes");
      // A child report queued just now.
      (value.thread as { updatedAt: DateTime.Utc }).updatedAt = at(3);
      assert.equal(yield* watchdog.sweep(), 0);
      assert.equal(yield* watchdog.sweep(), 1);
    }).pipe(Effect.provide(layer));
    assert.equal((yield* Ref.get(captured)).length, 1);
  }),
);

it.effect("leaves a driven run alone when its provider thread names no session", () =>
  Effect.gen(function* () {
    const value = projection({
      providerThreads: [
        {
          id: "provider-thread-1",
          driver: "acp",
          providerInstanceId: "copilot",
          providerSessionId: null,
          status: "active",
        },
      ],
    });
    const { layer, captured } = yield* harness({ value });
    yield* Effect.gen(function* () {
      const watchdog = yield* StaleRunWatchdog.make;
      const liveness = yield* RunLiveness.RunLiveness;
      const release = yield* liveness.acquire("run-1" as never);
      yield* TestClock.adjust("1 hour");
      assert.equal(yield* watchdog.sweep(), 0);
      assert.equal(yield* watchdog.sweep(), 0);
      yield* release;
    }).pipe(Effect.provide(layer));
    assert.equal((yield* Ref.get(captured)).length, 0);
  }),
);

it.effect("settles the runs a released session left behind at once", () =>
  Effect.gen(function* () {
    const { layer, captured } = yield* harness({ value: projection() });
    yield* Effect.gen(function* () {
      const watchdog = yield* StaleRunWatchdog.make;
      const liveness = yield* RunLiveness.RunLiveness;
      const released = {
        providerSessionId: "session-1",
        threadIds: ["thread-1"],
        reason: "idle_timeout",
      } as unknown as RunLiveness.ReleasedProviderSession;
      const release = yield* liveness.acquire("run-1" as never);
      // Still driven (its ingestion is settling it): left to that fiber.
      assert.equal(yield* watchdog.settleAfterRelease(released), 0);
      yield* release;
      assert.equal(yield* watchdog.settleAfterRelease(released), 1);
    }).pipe(Effect.provide(layer));
    assert.equal((yield* Ref.get(captured)).length, 1);
  }),
);
