import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  CommandId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSettings from "../serverSettings.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import type { ProviderAdapterV2Event, ProviderAdapterV2SessionRuntime } from "./ProviderAdapter.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import { MAX_CONSECUTIVE_INGEST_FAILURES } from "./RunIngestionGuards.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RunLiveness from "./RunLiveness.ts";

const driver = ProviderDriverKind.make("codex");
const providerInstanceId = ProviderInstanceId.make("codex");

const ids = (key: string) => ({
  threadId: ThreadId.make(`thread:${key}`),
  runId: RunId.make(`run:${key}`),
  attemptId: RunAttemptId.make(`attempt:${key}`),
  providerThreadId: ProviderThreadId.make(`provider-thread:${key}`),
  providerTurnId: ProviderTurnId.make(`provider-turn:${key}`),
  rootNodeId: NodeId.make(`node:${key}`),
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

/**
 * Starts one root run over `events` with an ingestor that fails for the
 * listed event positions and a final write that fails `failedWrites` times.
 */
const runIngestion = (input: {
  readonly key: string;
  readonly events: ReadonlyArray<ProviderAdapterV2Event>;
  readonly failingIngests: ReadonlySet<number>;
  readonly failedWrites?: number;
  readonly endStream?: Stream.Stream<ProviderAdapterV2Event>;
}) =>
  Effect.gen(function* () {
    const key = ids(input.key);
    const ingested = yield* Ref.make<ReadonlyArray<string>>([]);
    const runStatuses = yield* Ref.make<ReadonlyArray<string>>([]);
    const writeAttempts = yield* Ref.make(0);
    const closed = yield* Deferred.make<void>();
    const calls = yield* Ref.make(0);
    const capture = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
      Ref.update(runStatuses, (current) => [
        ...current,
        ...events.flatMap((event) => (event.type === "run.updated" ? [event.payload.status] : [])),
      ]);
    const layer = RunExecutionService.layer.pipe(
      Layer.provideMerge(RunLiveness.layer),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(CheckpointService.CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
          Layer.mock(EventSink.EventSinkV2)({
            writeWithEffects: (payload) => capture(payload.events).pipe(Effect.as([])),
            writeIfRunCurrent: (payload) =>
              Effect.gen(function* () {
                const attempt = yield* Ref.updateAndGet(writeAttempts, (count) => count + 1);
                if (attempt <= (input.failedWrites ?? 0)) {
                  return yield* Effect.die("database is locked");
                }
                yield* capture(payload.events);
                return { committed: true, storedEvents: [] };
              }),
          }),
          IdAllocator.layer,
          Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
            ingestNormalized: (ingest) =>
              Effect.gen(function* () {
                const position = yield* Ref.getAndUpdate(calls, (count) => count + 1);
                if (input.failingIngests.has(position)) {
                  return yield* Effect.die(`could not store event ${position}`);
                }
                yield* Ref.update(ingested, (current) => [...current, ingest.event.type]);
                return [];
              }),
          }),
          ServerSettings.layerTest(),
        ),
      ),
    );
    return yield* Effect.gen(function* () {
      const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
      const liveness = yield* RunLiveness.RunLiveness;
      yield* runExecution.startRootRun({
        commandId: CommandId.make(`command:${input.key}`),
        appThread: { id: key.threadId } as OrchestrationV2AppThread,
        providerSessionId: ProviderSessionId.make(`session:${input.key}`),
        session: {
          events: Stream.empty,
          subscribeEvents: Effect.succeed({
            events: Stream.concat(
              Stream.fromIterable(input.events),
              input.endStream ?? Stream.empty,
            ),
            close: Deferred.succeed(closed, undefined),
          }),
          startTurn: () => Effect.void,
        } as unknown as ProviderAdapterV2SessionRuntime,
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
          providerTurnId: key.providerTurnId,
        } as OrchestrationV2RunAttempt,
        attemptId: key.attemptId,
        providerTurnOrdinal: 1,
        shouldFinalizeRun: () => Effect.succeed(true),
        message: {
          messageId: MessageId.make(`message:${input.key}`),
          text: "hello",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false },
        },
      });
      // Retries wait on the clock; move it until the stream has closed.
      for (let step = 0; step < 20 && !(yield* Deferred.isDone(closed)); step += 1) {
        yield* TestClock.adjust("30 seconds");
      }
      yield* Deferred.await(closed);
      // The release runs right after the close.
      yield* Effect.yieldNow;
      return {
        ingested: yield* Ref.get(ingested),
        runStatuses: yield* Ref.get(runStatuses),
        writeAttempts: yield* Ref.get(writeAttempts),
        liveAfter: yield* liveness.isLive(key.runId),
      };
    }).pipe(Effect.provide(layer));
  });

it.effect("keeps ingesting after one provider event cannot be stored", () =>
  Effect.gen(function* () {
    const key = "ingestion:one-bad-event";
    const result = yield* runIngestion({
      key,
      events: [itemEvent(key, 1), itemEvent(key, 2), itemEvent(key, 3), terminalEvent(key)],
      failingIngests: new Set([1]),
    });
    // The events after the failed one, and the turn's end, still land.
    assert.deepEqual(result.ingested, ["turn_item.updated", "turn_item.updated", "turn.terminal"]);
    assert.deepEqual(result.runStatuses, ["waiting"]);
    assert.isFalse(result.liveAfter);
  }),
);

it.effect("fails the run once too many events in a row cannot be stored, retrying the write", () =>
  Effect.gen(function* () {
    const key = "ingestion:many-bad-events";
    const events = [itemEvent(key, 1), itemEvent(key, 2), itemEvent(key, 3), terminalEvent(key)];
    const result = yield* runIngestion({
      key,
      events,
      failingIngests: new Set(
        Array.from({ length: MAX_CONSECUTIVE_INGEST_FAILURES }, (_, index) => index),
      ),
      failedWrites: 2,
    });
    assert.deepEqual(result.ingested, []);
    // Two writes fail like the ingestion did; the third settles the run.
    assert.equal(result.writeAttempts, 3);
    assert.deepEqual(result.runStatuses, ["failed"]);
    assert.isFalse(result.liveAfter);
  }),
);

it.effect("keeps the run live while its events are read", () =>
  Effect.gen(function* () {
    const key = "ingestion:live";
    const gate = yield* Deferred.make<void>();
    const observed = yield* Ref.make<boolean | null>(null);
    const result = yield* runIngestion({
      key,
      events: [itemEvent(key, 1)],
      failingIngests: new Set(),
      endStream: Stream.unwrap(
        Effect.gen(function* () {
          const liveness = yield* RunLiveness.RunLiveness;
          yield* Ref.set(observed, yield* liveness.isLive(ids(key).runId));
          yield* Deferred.succeed(gate, undefined);
          return Stream.make(terminalEvent(key));
        }),
      ),
    });
    yield* Deferred.await(gate);
    assert.isTrue(yield* Ref.get(observed));
    assert.isFalse(result.liveAfter);
  }),
);
