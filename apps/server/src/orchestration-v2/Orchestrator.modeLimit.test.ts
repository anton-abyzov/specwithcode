import { fixtureProjectDatabase } from "../project/ProjectWorkspace.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  type RuntimeMode,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { DispatchModeLimit } from "./DispatchModeLimit.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2Shape,
  ProviderAdapterV2TurnInput,
} from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const projectId = ProjectId.make("project:mode-limit");
const supervised = { runtimeMode: "approval-required", interactionMode: "default" } as const;

const steeringAdapter = (
  cwd: string,
  events: Queue.Queue<ProviderAdapterV2Event>,
  started: Array<ProviderAdapterV2TurnInput>,
  steered: Array<string>,
): ProviderAdapterV2Shape => ({
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
                nativeTurnRef: { driver, nativeId: `native:${turn.attemptId}`, strength: "strong" },
                ordinal: turn.providerTurnOrdinal,
                status: "running",
                startedAt: yield* DateTime.now,
                completedAt: null,
              },
            });
          }),
        steerTurn: (turn) =>
          Effect.sync(() => {
            steered.push(turn.message.text);
          }),
        interruptTurn: () => Effect.void,
        respondToRuntimeRequest: () => Effect.void,
        readThreadSnapshot: () => Effect.die("unused"),
        rollbackThread: () => Effect.die("unused"),
        forkThread: () => Effect.die("unused"),
      };
    }),
});

/**
 * Starts a turn on a thread at `startedAt`, sets the thread to `loweredTo`
 * for the next turn, and steers the running turn from a sender limited to
 * Supervised. `forgetTurnModes` rewrites the attempt as one recorded before
 * attempts kept their modes.
 */
const steerFromLimitedSender = (input: {
  readonly name: string;
  readonly startedAt: RuntimeMode;
  readonly loweredTo?: RuntimeMode;
  readonly forgetTurnModes?: boolean;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace(`mode-limit-${input.name}`);
      const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
      const started: Array<ProviderAdapterV2TurnInput> = [];
      const steered: Array<string> = [];
      return yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make(`thread:mode-limit-${input.name}`);
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId,
          title: "Mode limit",
          modelSelection,
          runtimeMode: input.startedAt,
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        const running = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event: OrchestrationV2DomainEvent) =>
              event.type === "provider-turn.updated" && event.payload.status === "running",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
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
        yield* worker.drain();
        yield* Fiber.join(running);
        const runId = started[0]!.runId;
        if (input.forgetTurnModes === true) {
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const { startedModes: _, ...attempt } = projection.attempts.find(
            (candidate) => candidate.runId === runId,
          )!;
          yield* (yield* EventSink.EventSinkV2).write({
            events: [
              {
                id: EventId.make("attempt:before-modes"),
                type: "run-attempt.updated",
                threadId,
                runId,
                occurredAt: yield* DateTime.now,
                payload: attempt,
              },
            ],
          });
        }
        if (input.loweredTo !== undefined) {
          // The person lowers the thread for the next turn; this one keeps running.
          yield* orchestrator.dispatch({
            type: "thread.runtime-mode.set",
            commandId: CommandId.make("lower"),
            threadId,
            runtimeMode: input.loweredTo,
            applyOnNextTurn: true,
          });
        }
        const steer = yield* Effect.exit(
          orchestrator
            .dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("steer"),
              threadId,
              messageId: MessageId.make("message:steer"),
              text: "and delete the backups",
              attachments: [],
              dispatchMode: { type: "steer_active", targetRunId: runId },
              createdBy: "agent",
              creationSource: "mcp",
            })
            .pipe(Effect.provideService(DispatchModeLimit, supervised)),
        );
        yield* worker.drain();
        const projection = yield* orchestrator.getThreadProjection(threadId);
        return {
          steer,
          steered,
          threadMode: projection.thread.runtimeMode,
          turnModes: projection.attempts.find((attempt) => attempt.runId === runId)?.startedModes,
          steerStored: projection.messages.some((message) => message.id === "message:steer"),
        };
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: `mode-limit-${input.name}` },
            ProviderAdapterRegistry.layerSingle(steeringAdapter(cwd, events, started, steered)),
            { runEffectWorker: false, databaseLayer: fixtureProjectDatabase([projectId]) },
          ),
        ),
      );
    }),
  );

it.effect("a limited sender cannot steer a Full access turn after the thread is lowered", () =>
  Effect.gen(function* () {
    const result = yield* steerFromLimitedSender({
      name: "lowered",
      startedAt: "full-access",
      loweredTo: "approval-required",
    });
    assert.equal(result.threadMode, "approval-required");
    assert.equal(result.steer._tag, "Failure");
    if (result.steer._tag === "Failure") {
      assert.include(String(result.steer.cause), "OrchestratorThreadAboveModeLimitError");
    }
    assert.isFalse(result.steerStored);
    assert.deepEqual(result.steered, []);
    assert.deepEqual(result.turnModes, { runtimeMode: "full-access", interactionMode: "default" });
  }),
);

it.effect("a limited sender still steers a turn that started within its limit", () =>
  Effect.gen(function* () {
    const result = yield* steerFromLimitedSender({
      name: "within",
      startedAt: "approval-required",
    });
    assert.equal(result.steer._tag, "Success");
    assert.isTrue(result.steerStored);
    assert.deepEqual(result.turnModes, supervised);
  }),
);

it.effect("a turn recorded without its modes is checked against the thread's modes", () =>
  Effect.gen(function* () {
    const lowered = yield* steerFromLimitedSender({
      name: "unrecorded-lowered",
      startedAt: "full-access",
      loweredTo: "approval-required",
      forgetTurnModes: true,
    });
    assert.isUndefined(lowered.turnModes);
    assert.equal(lowered.steer._tag, "Success");

    const raised = yield* steerFromLimitedSender({
      name: "unrecorded-raised",
      startedAt: "full-access",
      forgetTurnModes: true,
    });
    assert.equal(raised.steer._tag, "Failure");
  }),
);
