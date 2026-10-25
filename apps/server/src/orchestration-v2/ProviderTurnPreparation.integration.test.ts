import { assert, it, vi } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { fixtureProjectDatabase } from "../project/ProjectWorkspace.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import {
  ProviderAdapterProtocolError,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2Shape,
  type ProviderAdapterV2TurnInput,
} from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { makeProviderFailure } from "./ProviderFailure.ts";
import * as ProviderTurnStartService from "./ProviderTurnStartService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

it.effect.each([
  "owned start",
  "adapter loss",
  "intervening adapter loss",
  "owner ends before requeue, restart disabled",
  "owner ends before requeue, restart enabled",
  "owner ends before requeue, failed owner",
] as const)("recovers %s before offering the next prompt", (scenario) =>
  Effect.scoped(
    Effect.gen(function* () {
      const ownerEndsBeforeRequeue = scenario.startsWith("owner ends before requeue");
      const failedOwner = scenario.endsWith("failed owner");
      const ownedStart = scenario === "owned start" || ownerEndsBeforeRequeue;
      const intervening = scenario === "intervening adapter loss";
      const driver = ProviderDriverKind.make("codex");
      const instanceId = ProviderInstanceId.make("codex");
      const modelSelection = { instanceId, model: "test-model" };
      const projectId = ProjectId.make("project:turn-preparation");
      const databaseLayer = fixtureProjectDatabase([projectId]);
      const cwd = yield* checkpointWorkspace(`turn-preparation-${scenario.replaceAll(" ", "-")}`);
      const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
      const starts: ProviderAdapterV2TurnInput[] = [];
      let liveTurn: ProviderTurnId | null = null;
      let first: ProviderAdapterV2TurnInput | undefined;
      let prepareCount = 0;
      let race = false;
      const nextAccepted = yield* Deferred.make<void>();
      const adapter: ProviderAdapterV2Shape = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
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
                capabilities: CodexProviderCapabilitiesV2,
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
                  nativeThreadRef: { driver, nativeId: "native-preparation", strength: "strong" },
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
              prepareTurn: () =>
                Effect.sync(() => {
                  if (
                    ownedStart ||
                    first === undefined ||
                    (intervening && starts.length < 2) ||
                    (!intervening && prepareCount++ > 0)
                  )
                    return [];
                  return [
                    {
                      type: "subagent.updated" as const,
                      driver,
                      subagent: {
                        id: NodeId.make("lost-native-child"),
                        threadId: first.threadId,
                        runId: first.runId,
                        parentNodeId: first.rootNodeId,
                        createdBy: "agent" as const,
                        model: null,
                        origin: "provider_native" as const,
                        driver,
                        providerInstanceId: instanceId,
                        providerThreadId: first.providerThread.id,
                        nativeTaskRef: {
                          driver,
                          nativeId: "native-child",
                          strength: "strong" as const,
                        },
                        childThreadId: null,
                        status: "interrupted" as const,
                        title: "Lost background research",
                        prompt: "Research",
                        progress: "Stopped when the provider session ended",
                        result: null,
                        startedAt: now,
                        completedAt: now,
                        updatedAt: now,
                      },
                    },
                  ];
                }),
              startTurn: (turn) =>
                Effect.gen(function* () {
                  starts.push(turn);
                  if (ownedStart && liveTurn !== null) {
                    race = true;
                    return yield* new ProviderAdapterProtocolError({
                      driver,
                      detail: `Previous turn is still active.`,
                      payload: { previousTurnActive: { providerTurnId: liveTurn } },
                    });
                  }
                  liveTurn = ProviderTurnId.make(`provider-turn:${turn.attemptId}`);
                  yield* Queue.offer(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: {
                      id: liveTurn,
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
                  if (first === undefined) first = turn;
                  else yield* Deferred.succeed(nextAccepted, undefined);
                }),
              steerTurn: () => Effect.die("unused"),
              interruptTurn: () => Effect.die("must not interrupt the live owner"),
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
        const sink = yield* EventSink.EventSinkV2;
        const startService = yield* ProviderTurnStartService.ProviderTurnStartServiceV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const queueCheck = yield* Deferred.make<void>();
        const originalCanStart = projections.canStartQueuedRun;
        let observeOwnerEnd = false;
        const queueSpy = vi
          .spyOn(projections, "canStartQueuedRun")
          .mockImplementation((id) =>
            originalCanStart(id).pipe(
              Effect.tap(() =>
                observeOwnerEnd ? Deferred.succeed(queueCheck, undefined) : Effect.void,
              ),
            ),
          );
        let deferredTransition:
          | Extract<OrchestrationV2DomainEvent, { type: "run.updated" }>
          | undefined;
        const originalWrite = sink.writeIfRunCurrent;
        const writeSpy = vi.spyOn(sink, "writeIfRunCurrent").mockImplementation((input) =>
          Effect.gen(function* () {
            if (
              ownerEndsBeforeRequeue &&
              race &&
              input.events.some((e) => e.type === "run.updated" && e.payload.status === "queued")
            ) {
              race = false;
              const current = yield* orchestrator
                .getThreadProjection(input.threadId)
                .pipe(Effect.orDie);
              const owner = current.runs.find((r) => r.id === first?.runId)!;
              const ownerTurn = current.providerTurns.find((t) => t.id === liveTurn)!;
              liveTurn = null;
              const now = yield* DateTime.now;
              // Owner completes after the live-ownership read, before requeue persistence.
              observeOwnerEnd = true;
              yield* sink.write({
                events: [
                  ...(failedOwner
                    ? [
                        {
                          id: EventId.make("owner-race-failure"),
                          type: "turn-item.updated" as const,
                          threadId: input.threadId,
                          runId: owner.id,
                          nodeId: owner.rootNodeId!,
                          occurredAt: now,
                          payload: {
                            id: TurnItemId.make("owner-race-failure"),
                            threadId: input.threadId,
                            runId: owner.id,
                            nodeId: owner.rootNodeId,
                            providerThreadId: ownerTurn.providerThreadId,
                            providerTurnId: ownerTurn.id,
                            nativeItemRef: null,
                            parentItemId: null,
                            ordinal: current.turnItems.length + 1,
                            status: "failed" as const,
                            title: "Provider error",
                            startedAt: now,
                            completedAt: now,
                            updatedAt: now,
                            type: "error" as const,
                            failure: makeProviderFailure({
                              class: "provider_error",
                              message: "Synthetic owner failure",
                              retryable: false,
                            }),
                          },
                        },
                      ]
                    : []),
                  {
                    id: EventId.make("owner-race-run"),
                    type: "run.updated",
                    threadId: input.threadId,
                    runId: owner.id,
                    occurredAt: now,
                    payload: {
                      ...owner,
                      status: failedOwner ? "failed" : "completed",
                      completedAt: now,
                    },
                  },
                  {
                    id: EventId.make("owner-race-turn"),
                    type: "provider-turn.updated",
                    threadId: input.threadId,
                    runId: owner.id,
                    occurredAt: now,
                    payload: { ...ownerTurn, status: "completed", completedAt: now },
                  },
                ],
              });
              yield* Deferred.await(queueCheck);
              observeOwnerEnd = false;
            }
            deferredTransition =
              input.events.find(
                (event): event is Extract<OrchestrationV2DomainEvent, { type: "run.updated" }> =>
                  event.type === "run.updated" && event.payload.status === "queued",
              ) ?? deferredTransition;
            return yield* originalWrite(input);
          }),
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            queueSpy.mockRestore();
            writeSpy.mockRestore();
          }),
        );
        const threadId = ThreadId.make(`thread:preparation:${scenario}`);
        const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create-preparation"),
          threadId,
          projectId,
          title: scenario,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        const dispatch = (key: string, mode: "start_immediately" | "queue_after_active") =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(key),
            threadId,
            messageId: MessageId.make(`message:${key}`),
            text: key,
            attachments: [],
            dispatchMode: { type: mode },
            createdBy: "user",
            creationSource: "web",
          });
        yield* dispatch("first", "start_immediately");
        const running = yield* watch(
          (e) => e.type === "provider-turn.updated" && e.payload.status === "running",
        );
        yield* worker.drain();
        yield* Fiber.join(running);
        yield* dispatch("second", "queue_after_active");
        const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.status === "queued",
        )!;
        if (ownedStart) {
          // A start already in flight collides with a confirmed live owner.
          yield* sink.write({
            events: [
              {
                id: EventId.make("race-start"),
                type: "run.updated",
                threadId,
                runId: queued.id,
                occurredAt: yield* DateTime.now,
                payload: { ...queued, status: "starting", queuePosition: null },
              },
            ],
          });
          const promotion = ownerEndsBeforeRequeue
            ? yield* watch(
                (event) =>
                  event.type === "run.updated" &&
                  event.payload.id === queued.id &&
                  (event.payload.status === "starting" ||
                    (failedOwner && event.payload.queueHeld === true)),
              )
            : undefined;
          yield* startService.start({ threadId, runId: queued.id });
          const deferred = deferredTransition!.payload;
          assert.equal(deferred.status, "queued");
          assert.equal(deferred.userMessageId, queued.userMessageId);
          assert.notEqual(deferred.activeAttemptId, queued.activeAttemptId);
          assert.isFalse(deferred.queueHeld === true);
          if (ownerEndsBeforeRequeue) {
            yield* Fiber.join(promotion!);
            yield* worker.drain();
            const after = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
              (run) => run.id === queued.id,
            )!;
            if (failedOwner) {
              assert.equal(after.status, "queued");
              assert.isTrue(after.queueHeld === true);
              assert.lengthOf(starts, 2, "a failed owner cannot admit a replacement prompt");
              return;
            }
            assert.equal(
              after.status,
              "running",
              "a busy-start race wakes independently of restart continuation",
            );
            assert.lengthOf(starts, 3, "one refused start and one replacement prompt");
            assert.equal(starts.at(-1)!.message.messageId, queued.userMessageId);
            return;
          }
        }
        const owner = (yield* orchestrator.getThreadProjection(threadId)).providerTurns.find(
          (turn) => turn.id === liveTurn,
        )!;
        const waiting = yield* watch(
          (e) =>
            e.type === "run.updated" &&
            e.payload.id === first!.runId &&
            e.payload.status === "waiting",
        );
        liveTurn = null;
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...owner, status: "completed", completedAt: yield* DateTime.now },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: owner.providerThreadId,
          providerTurnId: owner.id,
          runOrdinal: first!.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(waiting);
        const nextStarting = yield* watch(
          (e) =>
            e.type === "run.updated" &&
            e.payload.id === queued.id &&
            e.payload.status === "starting",
        );
        yield* worker.drain();
        yield* Fiber.join(nextStarting);
        yield* worker.drain();
        assert.isTrue(
          yield* Deferred.isDone(nextAccepted),
          JSON.stringify(
            (yield* orchestrator.getThreadProjection(threadId)).turnItems.filter(
              (i) => i.type === "error",
            ),
          ),
        );
        yield* Deferred.await(nextAccepted);
        const accepted = starts.at(-1)!;
        assert.equal(accepted.runId, queued.id);
        assert.equal(accepted.message.messageId, queued.userMessageId);
        if (intervening) {
          assert.notInclude(accepted.message.text, "Lost background research");
          // The native child from run 1 survives a normal completed run 2.
          yield* dispatch("third", "queue_after_active");
          const third = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (r) => r.status === "queued",
          )!;
          const secondTurn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns.find(
            (t) => t.runAttemptId === accepted.attemptId,
          )!;
          const secondWaiting = yield* watch(
            (e) =>
              e.type === "run.updated" &&
              e.payload.id === accepted.runId &&
              e.payload.status === "waiting",
          );
          liveTurn = null;
          yield* Queue.offer(events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: { ...secondTurn, status: "completed", completedAt: yield* DateTime.now },
          });
          yield* Queue.offer(events, {
            type: "turn.terminal",
            driver,
            providerThreadId: secondTurn.providerThreadId,
            providerTurnId: secondTurn.id,
            runOrdinal: accepted.runOrdinal,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
          });
          yield* Fiber.join(secondWaiting);
          const thirdRunning = yield* watch(
            (event) =>
              event.type === "provider-turn.updated" &&
              event.payload.runAttemptId === third.activeAttemptId &&
              event.payload.status === "running",
          );
          const thirdStarting = yield* watch(
            (e) =>
              e.type === "run.updated" &&
              e.payload.id === third.id &&
              e.payload.status === "starting",
          );
          yield* worker.drain();
          yield* Fiber.join(thirdStarting);
          yield* worker.drain();
          yield* Fiber.join(thirdRunning);
          const thirdAccepted = starts.at(-1)!;
          assert.equal(thirdAccepted.runId, third.id);
          assert.include(thirdAccepted.message.text, "Lost background research");
          assert.include(thirdAccepted.message.text, "third");
          const recorded = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(
            recorded.runs
              .find((run) => run.id === accepted.runId)
              ?.restartCancelledBackgroundWork?.map((w) => w.label),
            ["Lost background research"],
          );
          yield* dispatch("fourth", "queue_after_active");
          const thirdTurn = recorded.providerTurns.find(
            (turn) => turn.runAttemptId === thirdAccepted.attemptId,
          )!;
          const thirdWaiting = yield* watch(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === third.id &&
              event.payload.status === "waiting",
          );
          liveTurn = null;
          yield* Queue.offer(events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: { ...thirdTurn, status: "completed", completedAt: yield* DateTime.now },
          });
          yield* Queue.offer(events, {
            type: "turn.terminal",
            driver,
            providerThreadId: thirdTurn.providerThreadId,
            providerTurnId: thirdTurn.id,
            runOrdinal: thirdAccepted.runOrdinal,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
          });
          yield* Fiber.join(thirdWaiting);
          const fourthStarting = yield* watch(
            (event) =>
              event.type === "run.updated" &&
              event.payload.ordinal === 4 &&
              event.payload.status === "starting",
          );
          yield* worker.drain();
          yield* Fiber.join(fourthStarting);
          yield* worker.drain();
          assert.lengthOf(starts, 4);
          assert.include(starts[3]!.message.text, "fourth");
          assert.notInclude(starts[3]!.message.text, "Lost background research");
          const notes = (yield* orchestrator.getThreadProjection(threadId)).runs.flatMap(
            (run) => run.restartCancelledBackgroundWork ?? [],
          );
          assert.deepEqual(
            notes.map((work) => work.id),
            ["lost-native-child"],
            "repeated discovery preserves source-work deduplication",
          );
        } else if (scenario === "adapter loss") {
          assert.include(accepted.message.text, "Lost background research");
          assert.include(accepted.message.text, "second");
          const recorded = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(
            recorded.runs
              .find((run) => run.id === first!.runId)
              ?.restartCancelledBackgroundWork?.map((w) => w.label),
            ["Lost background research"],
          );
        } else {
          assert.lengthOf(starts, 3, "one refused start is retried once after its owner ends");
        }
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: `preparation-${scenario}` },
            ProviderAdapterRegistry.layerSingle(adapter),
            {
              runEffectWorker: false,
              databaseLayer,
              continueThreadsAfterServerUpdate: scenario.endsWith("restart enabled"),
            },
          ).pipe(
            Layer.provideMerge(databaseLayer),
            Layer.provideMerge(ProjectionStore.layer.pipe(Layer.provide(databaseLayer))),
          ),
        ),
      );
    }),
  ),
);
