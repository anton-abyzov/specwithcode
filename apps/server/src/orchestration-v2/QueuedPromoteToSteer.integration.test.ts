import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EventSink from "./EventSink.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as IdAllocator from "./IdAllocator.ts";
import { fixtureProjectDatabase } from "../project/ProjectWorkspace.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as Recovery from "./ProviderRuntimeRecoveryService.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  ProviderAdapterSteerRunError,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2Shape,
  type ProviderAdapterV2TurnInput,
} from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const projectId = ProjectId.make("project:promote-to-steer");

/**
 * Steer now on a queued message keeps the queued row until the provider takes
 * the message, and leaves it queued when the steer fails, so the message is
 * delivered exactly once either way (1048 AC-09).
 */
it.effect.each([
  "accepted",
  "acceptance receipt write failed",
  "process lost while steer unresolved",
  "refused after the turn ended",
  // 1048 review F-03: the turn ends while the provider still holds the steer.
  // The queue must not deliver the row then, or an accepted steer sends it twice.
  "accepted after the turn was interrupted",
  // F-05: a row the person removed while it was steering stays removed.
  "refused after the person removed it",
] as const)("promote-to-steer keeps the queued row until the steer is %s", (outcome) =>
  Effect.scoped(
    Effect.gen(function* () {
      const databaseLayer = fixtureProjectDatabase([projectId]);
      const cwd = yield* checkpointWorkspace(`promote-to-steer-${outcome.replaceAll(" ", "-")}`);
      const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
      const started: ProviderAdapterV2TurnInput[] = [];
      const steered: string[] = [];
      const steerEntered = yield* Deferred.make<void>();
      const releaseSteer = yield* Deferred.make<void>();
      const capabilities = {
        ...CodexProviderCapabilitiesV2,
        turns: {
          ...CodexProviderCapabilitiesV2.turns,
          supportsActiveSteering: true,
          supportsSteeringByInterruptRestart: false,
        },
      };
      const adapter: ProviderAdapterV2Shape = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(capabilities),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (input) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            return {
              instanceId,
              driver,
              providerSessionId: input.providerSessionId,
              providerSession: {
                id: input.providerSessionId,
                driver,
                providerInstanceId: instanceId,
                status: "ready",
                cwd,
                model: modelSelection.model,
                capabilities,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.fromQueue(events),
              ensureThread: ({ threadId }) =>
                Effect.succeed({
                  id: ProviderThreadId.make(`provider-thread:${threadId}`),
                  driver,
                  providerInstanceId: instanceId,
                  providerSessionId: input.providerSessionId,
                  appThreadId: threadId,
                  ownerNodeId: null,
                  nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
                  nativeConversationHeadRef: null,
                  status: "idle",
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  forkedFrom: null,
                  createdAt: now,
                  updatedAt: now,
                }),
              resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
              startTurn: (turn) =>
                Effect.gen(function* () {
                  started.push(turn);
                  yield* Queue.offer(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: {
                      id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                      providerThreadId: turn.providerThread.id,
                      nodeId: turn.rootNodeId,
                      runAttemptId: turn.attemptId,
                      nativeTurnRef: {
                        driver,
                        nativeId: `native:${turn.attemptId}`,
                        strength: "strong",
                      },
                      ordinal: turn.providerTurnOrdinal,
                      status: "running",
                      startedAt: now,
                      completedAt: null,
                    },
                  });
                }),
              steerTurn: (turn) =>
                Effect.gen(function* () {
                  steered.push(turn.message.messageId);
                  if (
                    outcome === "accepted" ||
                    outcome === "acceptance receipt write failed" ||
                    outcome === "process lost while steer unresolved"
                  )
                    return;
                  yield* Deferred.succeed(steerEntered, undefined);
                  yield* Deferred.await(releaseSteer);
                  if (outcome === "accepted after the turn was interrupted") return;
                  return yield* new ProviderAdapterSteerRunError({
                    driver,
                    providerThreadId: turn.providerThread.id,
                    providerTurnId: turn.providerTurnId,
                    cause: "turn already completed",
                  });
                }),
              interruptTurn: () => Effect.void,
              respondToRuntimeRequest: () => Effect.void,
              readThreadSnapshot: () => Effect.die("unused"),
              rollbackThread: () => Effect.die("unused"),
              forkThread: () => Effect.die("unused"),
            };
          }),
      };
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make(`thread:promote-to-steer-${outcome.replaceAll(" ", "-")}`);
        const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId,
          title: "Promote to steer",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("first"),
          threadId,
          messageId: MessageId.make("message:first"),
          text: "first",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const running = yield* watch(
          (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
        );
        yield* worker.drain();
        yield* Fiber.join(running);
        const first = started[0]!;

        const queuedMessageId = MessageId.make("message:queued");
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("queued"),
          threadId,
          messageId: queuedMessageId,
          text: "report from a worker",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        });
        const queuedRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.status === "queued",
        )!;
        assert.isDefined(queuedRun);

        yield* orchestrator.dispatch({
          type: "queued-message.promote-to-steer",
          commandId: CommandId.make("promote"),
          threadId,
          queuedRunId: queuedRun.id,
          targetRunId: first.runId,
        });
        // Before the provider has the message, the row is still queued.
        const pending = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(pending.runs.find((run) => run.id === queuedRun.id)?.status, "queued");
        assert.equal(
          pending.messages.find((message) => message.id === queuedMessageId)?.runId,
          first.runId,
        );
        // A second Steer now on the same row is refused, not delivered twice.
        const again = yield* orchestrator
          .dispatch({
            type: "queued-message.promote-to-steer",
            commandId: CommandId.make("promote-again"),
            threadId,
            queuedRunId: queuedRun.id,
            targetRunId: first.runId,
          })
          .pipe(Effect.flip);
        assert.include(
          String((again as { readonly cause?: unknown }).cause),
          "already being steered",
        );

        if (outcome === "acceptance receipt write failed") {
          // The provider accepts, but the transaction saving its acknowledgement
          // cannot commit. A retry must persist the outcome without offering again.
          yield* sql.unsafe(`CREATE TRIGGER refuse_steer_receipt BEFORE INSERT ON orchestration_command_receipts
              WHEN NEW.command_type = 'queued-message.steer-settle'
              BEGIN SELECT RAISE(ABORT, 'injected acknowledgement write failure'); END`);
          yield* worker.runOnce;
          assert.deepEqual(steered, [queuedMessageId]);
          const uncertain = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(uncertain.runs.find((run) => run.id === queuedRun.id)?.status, "queued");
          assert.equal(
            uncertain.turnItems.find(
              (item) => item.type === "user_message" && item.messageId === queuedMessageId,
            )?.status,
            "running",
          );
          yield* sql.unsafe("DROP TRIGGER refuse_steer_receipt");
          yield* TestClock.adjust("1 hour");
          yield* worker.drain();
          assert.deepEqual(
            steered,
            [queuedMessageId],
            "persistence retry never offers the steer again",
          );
          const recovered = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(recovered.runs.find((run) => run.id === queuedRun.id)?.status, "cancelled");
          assert.equal(
            recovered.turnItems.find(
              (item) => item.type === "user_message" && item.messageId === queuedMessageId,
            )?.status,
            "completed",
          );
          return;
        }
        if (outcome === "process lost while steer unresolved") {
          yield* sql.unsafe(`CREATE TRIGGER refuse_steer_receipt BEFORE INSERT ON orchestration_command_receipts
              WHEN NEW.command_type = 'queued-message.steer-settle'
              BEGIN SELECT RAISE(ABORT, 'injected acknowledgement write failure'); END`);
          yield* worker.runOnce;
          assert.deepEqual(steered, [queuedMessageId]);
          yield* sql.unsafe("DROP TRIGGER refuse_steer_receipt");
          // Nothing in SteersInFlight has been acquired: a new runtime has only
          // the persisted offer, as after process loss before acknowledgement.
          yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'cancelled'
              WHERE thread_id = ${threadId} AND effect_type = 'provider-turn.steer'`;
          yield* (yield* Recovery.make.pipe(
            Effect.provide(
              Layer.mergeAll(
                ServerSettings.layerTest({ continueThreadsAfterServerUpdate: false }),
                IdAllocator.layer,
                ProjectionStore.layer,
                EffectOutbox.layer,
                EventSink.layer.pipe(
                  Layer.provide(Layer.mergeAll(EventStore.layer, ProjectionStore.layer)),
                ),
              ),
            ),
          )).reconcile("startup");
          const restartProjection = yield* orchestrator.getThreadProjection(threadId);
          const offer = restartProjection.turnItems.find(
            (item) => item.type === "user_message" && item.messageId === queuedMessageId,
          );
          assert.equal(offer?.status, "cancelled");
          yield* orchestrator.dispatch({
            type: "queue.resume",
            commandId: CommandId.make("release-after-restart"),
            threadId,
          });
          yield* orchestrator.resumeQueuedRuns;
          yield* worker.drain();
          yield* orchestrator.resumeQueuedRuns;
          const recovered = yield* orchestrator.getThreadProjection(threadId);
          assert.lengthOf(
            started,
            1,
            "an accepted steer is never redelivered after startup reconciliation",
          );
          return;
        }
        if (outcome === "accepted") {
          yield* worker.drain();
          assert.deepEqual(steered, [queuedMessageId]);
          const accepted = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(accepted.runs.find((run) => run.id === queuedRun.id)?.status, "cancelled");
        }
        const delivery =
          outcome === "accepted" ? undefined : yield* worker.runOnce.pipe(Effect.forkScoped);
        if (outcome === "refused after the person removed it") {
          yield* orchestrator.dispatch({
            type: "queued-run.cancel",
            commandId: CommandId.make("remove-steering-row"),
            threadId,
            runId: queuedRun.id,
          });
        }
        if (
          (outcome === "refused after the turn ended" ||
            outcome === "refused after the person removed it") &&
          delivery !== undefined
        ) {
          yield* Deferred.await(steerEntered);
          // The turn ends before the provider takes the steer.
          const waiting = yield* watch(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === first.runId &&
              event.payload.status === "waiting",
          );
          const turn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
          yield* Queue.offer(events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
          });
          yield* Queue.offer(events, {
            type: "turn.terminal",
            driver,
            providerThreadId: turn.providerThreadId,
            providerTurnId: turn.id,
            runOrdinal: first.runOrdinal,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
          });
          yield* Fiber.join(waiting);
          yield* Deferred.succeed(releaseSteer, undefined);
          yield* Fiber.join(delivery);
        }
        if (outcome === "accepted after the turn was interrupted" && delivery !== undefined) {
          yield* Deferred.await(steerEntered);
          const interrupted = yield* watch(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === first.runId &&
              event.payload.status === "interrupted",
          );
          const turn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
          yield* Queue.offer(events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: { ...turn, status: "interrupted", completedAt: yield* DateTime.now },
          });
          yield* Queue.offer(events, {
            type: "turn.terminal",
            driver,
            providerThreadId: turn.providerThreadId,
            providerTurnId: turn.id,
            runOrdinal: first.runOrdinal,
            status: "interrupted",
            failure: null,
            threadDisposition: "reusable",
          });
          yield* Fiber.join(interrupted);
          // The queue checks again with the steer still unanswered: the row waits.
          yield* orchestrator.resumeQueuedRuns;
          const unanswered = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(unanswered.runs.find((run) => run.id === queuedRun.id)?.status, "queued");
          yield* Deferred.succeed(releaseSteer, undefined);
          yield* Fiber.join(delivery);
        }

        // Let the first turn finish and the queue drain.
        yield* worker.drain();
        if (outcome === "accepted") {
          const turn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
          yield* Queue.offer(events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
          });
          yield* Queue.offer(events, {
            type: "turn.terminal",
            driver,
            providerThreadId: turn.providerThreadId,
            providerTurnId: turn.id,
            runOrdinal: first.runOrdinal,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
          });
        }
        yield* worker.drain();
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();

        const final = yield* orchestrator.getThreadProjection(threadId);
        const deliveries =
          steered.filter((id) => id === queuedMessageId).length -
          (outcome.startsWith("refused") ? 1 : 0) +
          started.filter((turn) => turn.message.messageId === queuedMessageId).length;
        if (outcome === "refused after the person removed it") {
          assert.equal(deliveries, 0, "the removed message is not delivered");
          assert.equal(final.runs.find((run) => run.id === queuedRun.id)?.status, "cancelled");
          assert.lengthOf(started, 1);
          return;
        }
        assert.equal(deliveries, 1, "the queued message is delivered exactly once");
        assert.equal(final.messages.filter((message) => message.id === queuedMessageId).length, 1);
        assert.equal(
          final.turnItems.filter(
            (item) => item.type === "user_message" && item.messageId === queuedMessageId,
          ).length,
          1,
        );
        if (outcome === "accepted after the turn was interrupted") {
          assert.equal(final.runs.find((run) => run.id === queuedRun.id)?.status, "cancelled");
          assert.equal(started.length, 1);
        } else if (outcome !== "accepted") {
          // The same queued row ran it, and the message moved back with it.
          assert.equal(started[1]?.runId, queuedRun.id);
          assert.equal(started[1]?.message.text, "report from a worker");
          assert.equal(
            final.messages.find((message) => message.id === queuedMessageId)?.runId,
            queuedRun.id,
          );
        } else {
          assert.equal(started.length, 1);
        }
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: `promote-to-steer-${outcome.replaceAll(" ", "-")}` },
            ProviderAdapterRegistry.layerSingle(adapter),
            { runEffectWorker: false, databaseLayer },
          ).pipe(Layer.provideMerge(databaseLayer)),
        ),
      );
    }),
  ),
);
