import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  CommandId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@specweave-studio/contracts";
import {
  LOCAL_STORAGE_FAILURE_CODE,
  LOCAL_STORAGE_FAILURE_MESSAGE,
  PREVIOUS_TURN_ACTIVE_FAILURE_CODE,
  PREVIOUS_TURN_ACTIVE_FAILURE_MESSAGE,
} from "@specweave-studio/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { PersistenceSqlError } from "../persistence/Errors.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CheckpointService from "./CheckpointService.ts";
import { deliverContextHandoffs, isPromptlessContinuation } from "./ContextHandoffDelivery.ts";
import * as EventSink from "./EventSink.ts";
import { EventStoreAppendEventsError } from "./EventStore.ts";
import * as IdAllocator from "./IdAllocator.ts";
import {
  ProviderAdapterProtocolError,
  ProviderAdapterTurnStartError,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2SessionRuntime,
} from "./ProviderAdapter.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import {
  isLocalStorageFailure,
  isPreviousTurnActiveFailure,
  makeProviderFailure,
  previousActiveProviderTurn,
  providerFailureDiagnostics,
  shouldHoldQueueAfterFailure,
} from "./ProviderFailure.ts";
import { providerTurnOwnedByLiveRun } from "./ProviderTurnStartService.ts";
import { MAX_CONSECUTIVE_INGEST_FAILURES } from "./RunIngestionGuards.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RunLiveness from "./RunLiveness.ts";

const driver = ProviderDriverKind.make("claudeAgent");
const providerInstanceId = ProviderInstanceId.make("claudeAgent");

const ids = (key: string) => ({
  threadId: ThreadId.make(`thread:${key}`),
  runId: RunId.make(`run:${key}`),
  attemptId: RunAttemptId.make(`attempt:${key}`),
  providerThreadId: ProviderThreadId.make(`provider-thread:${key}`),
  providerTurnId: ProviderTurnId.make(`provider-turn:${key}`),
  rootNodeId: NodeId.make(`node:${key}`),
});

/** The October 24, 2026 chain: SQLite could not open its file once the disk filled up. */
const storageFailure = () =>
  new ProviderEventIngestor.ProviderEventPublishError({
    providerSessionId: ProviderSessionId.make("session:disk"),
    eventCount: 1,
    cause: new EventSink.EventSinkWriteError({
      eventCount: 1,
      cause: new EventStoreAppendEventsError({
        eventCount: 1,
        cause: new PersistenceSqlError({
          operation: "OrchestrationEventStore.appendAgentEvents:insert",
          detail: "SQLITE(14) unable to open database file",
          cause: new Error("unable to open database file"),
        }),
      }),
    }),
  });

const busyTurnId = ProviderTurnId.make("provider-turn:busy-earlier-turn");

/** What ClaudeAdapterV2.startTurn raises while an earlier turn is still running. */
const stillActive = (runId: RunId, threadId: ThreadId, providerThreadId: ProviderThreadId) =>
  new ProviderAdapterTurnStartError({
    driver,
    threadId,
    providerThreadId,
    runId,
    cause: new ProviderAdapterProtocolError({
      driver,
      detail: `Claude provider turn ${busyTurnId} is still active.`,
      payload: { previousTurnActive: { providerTurnId: busyTurnId } },
    }),
  });

const itemEvent = (key: string, ordinal: number): ProviderAdapterV2Event =>
  ({
    type: "turn_item.updated",
    driver,
    turnItem: {
      id: TurnItemId.make(`turn-item:${key}:${ordinal}`),
      threadId: ids(key).threadId,
      runId: ids(key).runId,
      providerTurnId: ids(key).providerTurnId,
      ordinal,
      type: "command_execution",
      status: "completed",
    },
  }) as ProviderAdapterV2Event;

const terminalEvent = (key: string): ProviderAdapterV2Event => ({
  type: "turn.terminal",
  driver,
  providerThreadId: ids(key).providerThreadId,
  providerTurnId: ids(key).providerTurnId,
  runOrdinal: 1,
  status: "completed",
  failure: null,
  threadDisposition: "reusable",
});

/** Runs one root run against a scripted session and records what it did. */
const runRoot = (input: {
  readonly key: string;
  readonly events: (started: Deferred.Deferred<void>) => Stream.Stream<ProviderAdapterV2Event>;
  readonly failingIngests?: ReadonlySet<number>;
  readonly startTurn: (calls: {
    readonly interrupts: number;
    readonly starts: number;
  }) => Effect.Effect<void, ProviderAdapterTurnStartError>;
  readonly previousTurnOwnedByLiveRun?: (
    providerTurnId: ProviderTurnId | null,
  ) => Effect.Effect<boolean | "unknown", never>;
}) =>
  Effect.gen(function* () {
    const key = ids(input.key);
    const written = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);
    const interrupts = yield* Ref.make<ReadonlyArray<ProviderTurnId>>([]);
    const starts = yield* Ref.make(0);
    const started = yield* Deferred.make<void>();
    const closed = yield* Deferred.make<void>();
    const ingestCalls = yield* Ref.make(0);
    const capture = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
      Ref.update(written, (current) => [...current, ...events]);
    const layer = RunExecutionService.layer.pipe(
      Layer.provideMerge(RunLiveness.layer),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(CheckpointService.CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
          Layer.mock(EventSink.EventSinkV2)({
            writeWithEffects: (payload) => capture(payload.events).pipe(Effect.as([])),
            writeIfRunCurrent: (payload) =>
              capture(payload.events).pipe(Effect.as({ committed: true, storedEvents: [] })),
          }),
          IdAllocator.layer,
          Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
            ingestNormalized: () =>
              Effect.gen(function* () {
                const position = yield* Ref.getAndUpdate(ingestCalls, (count) => count + 1);
                if (input.failingIngests?.has(position) === true) {
                  return yield* storageFailure();
                }
                return [];
              }),
          }),
          ServerSettings.layerTest(),
        ),
      ),
    );
    const session = {
      events: Stream.empty,
      subscribeEvents: Effect.succeed({
        events: input.events(started),
        close: Deferred.succeed(closed, undefined),
      }),
      startTurn: () =>
        Effect.gen(function* () {
          const count = yield* Ref.updateAndGet(starts, (current) => current + 1);
          yield* input.startTurn({
            interrupts: (yield* Ref.get(interrupts)).length,
            starts: count,
          });
          yield* Deferred.succeed(started, undefined);
        }),
      interruptTurn: (interrupt: { readonly providerTurnId: ProviderTurnId }) =>
        Ref.update(interrupts, (current) => [...current, interrupt.providerTurnId]),
    } as unknown as ProviderAdapterV2SessionRuntime;
    return yield* Effect.gen(function* () {
      const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
      // The start itself waits on the clock while the provider holds a turn.
      const startFiber = yield* runExecution
        .startRootRun({
          commandId: CommandId.make(`command:${input.key}`),
          appThread: { id: key.threadId } as OrchestrationV2AppThread,
          providerSessionId: ProviderSessionId.make(`session:${input.key}`),
          session,
          run: {
            id: key.runId,
            threadId: key.threadId,
            ordinal: 1,
            providerInstanceId,
          } as OrchestrationV2Run,
          rootNode: {
            id: key.rootNodeId,
            providerTurnId: key.providerTurnId,
          } as OrchestrationV2ExecutionNode,
          checkpointScope: {
            id: CheckpointScopeId.make(`checkpoint-scope:${input.key}`),
          } as OrchestrationV2CheckpointScope,
          providerThread: { id: key.providerThreadId, driver } as OrchestrationV2ProviderThread,
          attempt: {
            id: key.attemptId,
            attemptOrdinal: 1,
            providerTurnId: key.providerTurnId,
          } as OrchestrationV2RunAttempt,
          attemptId: key.attemptId,
          providerTurnOrdinal: 1,
          shouldFinalizeRun: () => Effect.succeed(true),
          ...(input.previousTurnOwnedByLiveRun === undefined
            ? {}
            : { previousTurnOwnedByLiveRun: input.previousTurnOwnedByLiveRun }),
          message: {
            messageId: MessageId.make(`message:${input.key}`),
            text: "hello",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
          modelSelection: { instanceId: providerInstanceId, model: "claude-opus-5-5" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
            approvalPolicy: "never",
            sandboxPolicy: {
              type: "readOnly",
              access: { type: "fullAccess" },
              networkAccess: false,
            },
          },
        })
        .pipe(Effect.forkChild);
      for (let step = 0; step < 40 && !(yield* Deferred.isDone(closed)); step += 1) {
        yield* TestClock.adjust("5 seconds");
      }
      yield* Deferred.await(closed);
      yield* Fiber.join(startFiber);
      yield* Effect.yieldNow;
      const events = yield* Ref.get(written);
      return {
        runStatuses: events.flatMap((event) =>
          event.type === "run.updated" ? [event.payload.status] : [],
        ),
        failure: events.flatMap((event) =>
          event.type === "turn-item.updated" && event.payload.type === "error"
            ? [event.payload.failure]
            : [],
        )[0] as OrchestrationV2ProviderFailure | undefined,
        interrupts: yield* Ref.get(interrupts),
        starts: yield* Ref.get(starts),
      };
    }).pipe(Effect.provide(layer));
  });

// AC-05

it.effect("stops the provider turn before failing a run whose events cannot be stored", () =>
  Effect.gen(function* () {
    const key = "recovery:disk-full";
    const result = yield* runRoot({
      key,
      // The turn keeps producing output after SQLite stopped accepting it.
      events: (started) =>
        Stream.unwrap(
          Deferred.await(started).pipe(
            Effect.as(
              Stream.fromIterable([
                itemEvent(key, 1),
                itemEvent(key, 2),
                itemEvent(key, 3),
                itemEvent(key, 4),
              ]),
            ),
          ),
        ).pipe(Stream.concat(Stream.never)),
      failingIngests: new Set(
        Array.from({ length: MAX_CONSECUTIVE_INGEST_FAILURES }, (_, index) => index),
      ),
      startTurn: () => Effect.void,
    });
    assert.deepEqual(result.interrupts, [ids(key).providerTurnId]);
    assert.deepEqual(result.runStatuses, ["failed"]);
    assert.equal(result.failure?.class, "unknown");
    assert.equal(result.failure?.code, LOCAL_STORAGE_FAILURE_CODE);
    assert.equal(result.failure?.message, LOCAL_STORAGE_FAILURE_MESSAGE);
  }),
);

// AC-06

it.effect("stops a busy turn no live run owns, then starts once the provider lets go", () =>
  Effect.gen(function* () {
    const key = "recovery:orphaned-busy-turn";
    const owners: Array<ProviderTurnId | null> = [];
    const result = yield* runRoot({
      key,
      events: (started) =>
        Stream.unwrap(Deferred.await(started).pipe(Effect.as(Stream.make(terminalEvent(key))))),
      // The provider holds the turn until it is interrupted, and one poll after.
      startTurn: ({ interrupts, starts }) =>
        interrupts === 0 || starts < 3
          ? Effect.fail(stillActive(ids(key).runId, ids(key).threadId, ids(key).providerThreadId))
          : Effect.void,
      previousTurnOwnedByLiveRun: (providerTurnId) =>
        Effect.sync(() => {
          owners.push(providerTurnId);
          return false;
        }),
    });
    assert.deepEqual(owners, [busyTurnId]);
    assert.deepEqual(result.interrupts, [busyTurnId]);
    assert.equal(result.starts, 3);
    assert.deepEqual(result.runStatuses, ["waiting"]);
    assert.isUndefined(result.failure);
  }),
);

it.effect("queues a busy start behind its live owner without interrupting it", () =>
  Effect.gen(function* () {
    const key = "recovery:owned-busy-turn";
    const result = yield* runRoot({
      key,
      events: () => Stream.never,
      startTurn: () =>
        Effect.fail(stillActive(ids(key).runId, ids(key).threadId, ids(key).providerThreadId)),
      previousTurnOwnedByLiveRun: () => Effect.succeed(true),
    });
    assert.deepEqual(result.interrupts, []);
    assert.equal(result.starts, 1);
    assert.deepEqual(result.runStatuses, ["queued"]);
    assert.isUndefined(result.failure);
  }),
);

it.effect("keeps unknown busy-turn ownership conservative", () =>
  Effect.gen(function* () {
    const key = "recovery:unknown-busy-turn";
    const result = yield* runRoot({
      key,
      events: () => Stream.never,
      startTurn: () =>
        Effect.fail(stillActive(ids(key).runId, ids(key).threadId, ids(key).providerThreadId)),
      previousTurnOwnedByLiveRun: () => Effect.succeed("unknown" as const),
    });
    assert.deepEqual(result.interrupts, []);
    assert.equal(result.starts, 1);
    assert.deepEqual(result.runStatuses, ["failed"]);
    assert.equal(result.failure?.code, PREVIOUS_TURN_ACTIVE_FAILURE_CODE);
  }),
);

it.effect("fails as previous_turn_active when the busy turn outlasts the wait", () =>
  Effect.gen(function* () {
    const key = "recovery:busy-turn-never-clears";
    const result = yield* runRoot({
      key,
      events: () => Stream.never,
      startTurn: () =>
        Effect.fail(stillActive(ids(key).runId, ids(key).threadId, ids(key).providerThreadId)),
      previousTurnOwnedByLiveRun: () => Effect.succeed(false),
    });
    assert.deepEqual(result.interrupts, [busyTurnId]);
    // The first start, then one per second for the bounded wait.
    assert.equal(result.starts, 32);
    assert.deepEqual(result.runStatuses, ["failed"]);
    assert.equal(result.failure?.code, PREVIOUS_TURN_ACTIVE_FAILURE_CODE);
  }),
);

it("finds the owner of the busy turn from the projection", () => {
  const runId = RunId.make("run:current");
  const attemptId = RunAttemptId.make("attempt:current");
  const failedRun = {
    id: RunId.make("run:29"),
    status: "failed" as const,
    activeAttemptId: RunAttemptId.make("attempt:29"),
  };
  const attempts = [
    { id: failedRun.activeAttemptId, runId: failedRun.id, providerTurnId: busyTurnId },
  ];
  const providerTurns = [{ id: busyTurnId, runAttemptId: failedRun.activeAttemptId }];
  const owned = (runs: ReadonlyArray<typeof failedRun | Record<string, unknown>>) =>
    providerTurnOwnedByLiveRun({
      providerTurnId: busyTurnId,
      runId,
      attemptId,
      runs: runs as never,
      attempts,
      providerTurns,
    });
  // Run 29 failed while its provider turn went on: nobody owns it.
  assert.isFalse(owned([failedRun]));
  assert.isTrue(owned([{ ...failedRun, status: "running" }]));
  assert.isTrue(owned([{ ...failedRun, status: "waiting" }]));
  // A turn this thread does not know may belong to another thread.
  assert.equal(
    providerTurnOwnedByLiveRun({
      providerTurnId: ProviderTurnId.make("provider-turn:elsewhere"),
      runId,
      attemptId,
      runs: [failedRun],
      attempts,
      providerTurns,
    }),
    "unknown",
  );
});

// Classification (ProviderFailure)

it("classifies storage and busy-turn failures with stable codes and messages", () => {
  const storage = makeProviderFailure({
    cause: new RunExecutionService.RunExecutionIngestError({
      runId: "run:disk",
      cause: storageFailure(),
    }),
    class: "unknown",
  });
  // The class stays in the closed set older peers decode.
  assert.equal(storage.class, "unknown");
  assert.equal(storage.code, LOCAL_STORAGE_FAILURE_CODE);
  assert.equal(storage.message, LOCAL_STORAGE_FAILURE_MESSAGE);
  assert.isTrue(isLocalStorageFailure({ code: "ENOSPC", message: "no space left on device" }));
  assert.isFalse(isLocalStorageFailure(new Error("socket hang up")));

  const busy = makeProviderFailure({
    cause: stillActive(
      RunId.make("run:busy"),
      ThreadId.make("thread:busy"),
      ProviderThreadId.make("provider-thread:busy"),
    ),
    class: "provider_error",
  });
  assert.equal(busy.code, PREVIOUS_TURN_ACTIVE_FAILURE_CODE);
  assert.equal(busy.message, PREVIOUS_TURN_ACTIVE_FAILURE_MESSAGE);
  // The log keeps the code and no internal id.
  const diagnostics = providerFailureDiagnostics(
    stillActive(
      RunId.make("run:busy"),
      ThreadId.make("thread:busy"),
      ProviderThreadId.make("provider-thread:busy"),
    ),
  );
  assert.equal(diagnostics.errorCode, PREVIOUS_TURN_ACTIVE_FAILURE_CODE);
  assert.notInclude(JSON.stringify(diagnostics), "provider-turn:");

  // Cursor and ACP name the turn only in their detail text.
  assert.equal(
    previousActiveProviderTurn(
      new ProviderAdapterProtocolError({
        driver: ProviderDriverKind.make("cursor"),
        detail: "Cursor provider turn provider-turn:cursor-1 is still active.",
      }),
    ),
    "provider-turn:cursor-1",
  );
  assert.isUndefined(
    previousActiveProviderTurn(
      new ProviderAdapterProtocolError({
        driver,
        detail: "Claude provider thread has no live query.",
      }),
    ),
  );
  // Both still hold the queue until a person continues.
  assert.isTrue(
    shouldHoldQueueAfterFailure({
      failure: storage,
      failedProviderInstanceId: "claudeAgent",
      queuedProviderInstanceId: "claudeAgent",
    }),
  );
});

// AC-07

const now = DateTime.makeUnsafe("2026-10-24T05:31:41Z");
const providerThread: OrchestrationV2ProviderThread = {
  id: ProviderThreadId.make("provider-thread:handoff"),
  driver,
  providerInstanceId,
  providerSessionId: null,
  appThreadId: ThreadId.make("thread:handoff"),
  ownerNodeId: null,
  nativeThreadRef: { driver, strength: "strong", nativeId: "native:1b346101" },
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: null,
  lastRunOrdinal: null,
  handoffIds: [],
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
};
const handoff = {
  id: "context-handoff:retry",
  threadId: ThreadId.make("thread:handoff"),
  targetRunId: RunId.make("run:31"),
  transferId: null,
  fromProviderThreadIds: [providerThread.id],
  toProviderThreadId: providerThread.id,
  fromProviderInstanceId: providerInstanceId,
  toProviderInstanceId: providerInstanceId,
  coveredRunOrdinals: { from: 30, to: 30 },
  strategy: "delta_since_target_last_seen",
  status: "ready",
  summaryText: "Earlier: run the completion sweep.",
  createdAt: now,
  updatedAt: now,
} as unknown as OrchestrationV2ContextHandoff;

it.effect("rolls pending handoff markers back when the start fails before the prompt", () =>
  Effect.gen(function* () {
    const stored = new Map<string, OrchestrationV2ContextHandoff>();
    const delivery = yield* deliverContextHandoffs({
      handoffs: [handoff],
      providerThread,
      budget: 16_000,
      alreadyDeliveredItemIds: new Set(),
      persist: (value) => Effect.sync(() => void stored.set(value.id, value)),
    });
    assert.include(delivery.context, "Earlier: run the completion sweep.");
    assert.equal(stored.get(handoff.id)?.delivery?.status, "pending");
    // The provider refused the start (previous turn still active).
    yield* delivery.rollback;
    assert.isUndefined(stored.get(handoff.id)?.delivery);
    // A later delivery on the same native session is no longer uncertain.
    const next = yield* deliverContextHandoffs({
      handoffs: [stored.get(handoff.id)!],
      providerThread,
      budget: 16_000,
      alreadyDeliveredItemIds: new Set(),
      inject: () => Effect.succeed(true),
      persist: (value) => Effect.sync(() => void stored.set(value.id, value)),
    });
    assert.equal(next.context, "");
    assert.equal(stored.get(handoff.id)?.delivery?.status, "injected");
  }),
);

it.effect("marks no handoff delivered on a continuation that sends no prompt", () =>
  Effect.gen(function* () {
    const persisted: Array<OrchestrationV2ContextHandoff> = [];
    const continuation = { createdBy: "agent", creationSource: "provider" } as const;
    assert.isTrue(isPromptlessContinuation(continuation));
    assert.isFalse(isPromptlessContinuation({ createdBy: "agent", creationSource: "server" }));
    assert.isFalse(isPromptlessContinuation({ createdBy: "user", creationSource: "web" }));
    const delivery = yield* deliverContextHandoffs({
      handoffs: [handoff],
      providerThread,
      budget: 16_000,
      promptless: isPromptlessContinuation(continuation),
      alreadyDeliveredItemIds: new Set(),
      persist: (value) => Effect.sync(() => void persisted.push(value)),
    });
    yield* delivery.delivered;
    assert.equal(delivery.context, "");
    assert.deepEqual(persisted, []);
  }),
);

// AC-07: a delta handoff to a returning native session arrives once.

const codexThreadId = ProviderThreadId.make("provider-thread:codex-fallback");
const deltaMessage = (id: string, role: "user" | "assistant", text: string) =>
  ({
    itemId: TurnItemId.make(id),
    role,
    text,
    threadId: ThreadId.make("thread:handoff"),
    runId: RunId.make("run:codex-31"),
    providerThreadId: codexThreadId,
    status: "completed",
    kind: role === "user" ? "user_message" : "assistant_message",
  }) as const;
const deltaHandoff = (scenario: {
  readonly fromProviderThreadId: ProviderThreadId;
  readonly fromProviderInstanceId: ProviderInstanceId;
}): OrchestrationV2ContextHandoff =>
  ({
    ...handoff,
    id: `context-handoff:delta:${scenario.fromProviderInstanceId}`,
    targetRunId: RunId.make("run:32"),
    fromProviderThreadIds: [scenario.fromProviderThreadId],
    fromProviderInstanceId: scenario.fromProviderInstanceId,
    coveredRunOrdinals: { from: 31, to: 31 },
    strategy: "delta_since_target_last_seen",
    summaryText: "",
    history: {
      messages: [
        deltaMessage("item:delta-user", "user", "DELTA-USER: fix the flaky queue test."),
        deltaMessage(
          "item:delta-assistant",
          "assistant",
          "DELTA-WORK: queue test fixed in 3 files.",
        ),
      ],
      coverage: "Work done on the fallback provider since this session last ran.",
      omittedItems: 0,
    },
  }) as unknown as OrchestrationV2ContextHandoff;

it.effect.each([
  {
    label: "a fallback Claude to Codex and back to the same Claude session",
    fromProviderThreadId: codexThreadId,
    fromProviderInstanceId: ProviderInstanceId.make("codex"),
  },
  {
    label: "an account switch on the same Claude provider",
    fromProviderThreadId: providerThread.id,
    fromProviderInstanceId: ProviderInstanceId.make("claudeAgent-work-account"),
  },
])("delivers the delta once after $label, across failed starts and a continuation", (scenario) =>
  Effect.gen(function* () {
    const records = new Map<string, OrchestrationV2ContextHandoff>();
    const delta = deltaHandoff(scenario);
    records.set(delta.id, delta);
    const sentPrompts: Array<string> = [];
    const persist = (value: OrchestrationV2ContextHandoff) =>
      Effect.sync(() => void records.set(value.id, value));
    // The same steps ProviderTurnStartService takes for a text-only adapter.
    const startTurn = (turn: {
      readonly message: { readonly createdBy: string; readonly creationSource: string };
      readonly providerRefuses: boolean;
    }) =>
      Effect.gen(function* () {
        const current = records.get(delta.id)!;
        // A pending marker on this session would replace it with a fresh one.
        assert.isFalse(
          current.delivery?.nativeThreadId === providerThread.nativeThreadRef?.nativeId &&
            current.delivery?.status === "pending",
          "the returning native session must not look uncertain",
        );
        const delivery = yield* deliverContextHandoffs({
          handoffs: [current],
          providerThread,
          budget: 16_000,
          promptless: isPromptlessContinuation(turn.message),
          alreadyDeliveredItemIds: new Set(),
          persist,
        });
        const offer: Effect.Effect<void, ProviderAdapterTurnStartError> = turn.providerRefuses
          ? Effect.fail(
              stillActive(RunId.make("run:32"), providerThread.appThreadId!, providerThread.id),
            )
          : Effect.sync(() => {
              // A continuation attaches to wake output: its text is never sent.
              if (!isPromptlessContinuation(turn.message)) sentPrompts.push(delivery.context);
            });
        const started = yield* offer.pipe(
          Effect.tapError((error) =>
            isPreviousTurnActiveFailure(error) ? delivery.rollback : Effect.void,
          ),
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false)),
        );
        if (started) yield* delivery.delivered;
      });
    const person = { createdBy: "user", creationSource: "web" } as const;
    const wake = { createdBy: "agent", creationSource: "provider" } as const;
    // Runs 30 and 31: the provider still runs an earlier turn.
    yield* startTurn({ message: person, providerRefuses: true });
    yield* startTurn({ message: person, providerRefuses: true });
    assert.isUndefined(records.get(delta.id)?.delivery);
    // Run 33: a continuation sends no prompt, so it carries nothing.
    yield* startTurn({ message: wake, providerRefuses: false });
    assert.isUndefined(records.get(delta.id)?.delivery);
    // Run 34 delivers the delta; run 35 does not repeat it.
    yield* startTurn({ message: person, providerRefuses: false });
    yield* startTurn({ message: person, providerRefuses: false });
    const everything = sentPrompts.join("\n");
    for (const marker of ["DELTA-USER", "DELTA-WORK"]) {
      assert.equal(everything.split(marker).length - 1, 1, `${marker} delivered exactly once`);
    }
    assert.include(sentPrompts[0], "DELTA-WORK");
    assert.equal(sentPrompts[1], "");
    assert.deepEqual(records.get(delta.id)?.delivery, {
      nativeThreadId: "native:1b346101",
      status: "inline",
      omittedItemIds: [],
      itemIds: [TurnItemId.make("item:delta-user"), TurnItemId.make("item:delta-assistant")],
    });
  }),
);
