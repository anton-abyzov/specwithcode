import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { fixtureProjectDatabase } from "../project/ProjectWorkspace.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { limitRecoveryCommand } from "./UsageLimitRecoveryWorker.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

/**
 * The orchestrator's usage-limit guards hold a stopped thread only for a
 * request that really waits on a person (isBlockingRuntimeRequest): an
 * approval does, a question the next message answers does not.
 */
const projectId = ProjectId.make("project:limit-requests");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapterV2Shape;
const layerDatabase = fixtureProjectDatabase([projectId]);
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProviderReplayHarness.layerWithRegistry(
    { name: "limit-requests" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

type Pending = "message-question" | "approval";

/** A thread whose only run stopped on its usage limit, reset a minute out. */
const limitedThread = (name: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const events = yield* EventSink.EventSinkV2;
    const threadId = ThreadId.make(`limit-requests:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`limit-requests:create:${name}`),
      threadId,
      projectId,
      title: "Limited thread",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`limit-requests:start:${name}`),
      threadId,
      messageId: MessageId.make(`limit-requests:start:${name}`),
      text: "Work on this.",
      attachments: [],
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
    const now = yield* DateTime.now;
    const resetAt = DateTime.formatIso(DateTime.add(now, { minutes: 1 }));
    yield* events.write({
      commandId: CommandId.make(`limit-requests:failure:${name}`),
      events: [
        {
          id: EventId.make(`limit-requests:run:${name}`),
          type: "run.updated",
          threadId,
          occurredAt: now,
          payload: { ...run, status: "failed", completedAt: now },
        },
        {
          id: EventId.make(`limit-requests:error:${name}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`limit-requests:error:${name}`),
            type: "error",
            threadId,
            runId: run.id,
            nodeId: run.rootNodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 2,
            status: "failed",
            title: "Usage limit reached",
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            failure: {
              class: "usage_limit",
              message: "Plan limit reached.",
              code: "usageLimitExceeded",
              retryable: null,
              resetAt,
            },
          },
        },
      ],
    });
    // The stopped run's request: an approval, or a question the next message answers.
    const ask = (pending: Pending) =>
      Effect.gen(function* () {
        const at = yield* DateTime.now;
        yield* events.write({
          commandId: CommandId.make(`limit-requests:ask:${name}`),
          events: [
            {
              id: EventId.make(`limit-requests:request:${name}`),
              type: "runtime-request.updated",
              threadId,
              nodeId: run.rootNodeId!,
              occurredAt: at,
              payload: {
                id: RuntimeRequestId.make(`limit-requests:${name}`),
                nodeId: run.rootNodeId!,
                providerTurnId: null,
                nativeRequestRef: null,
                kind: pending === "message-question" ? "user_input" : "command",
                status: "pending",
                responseCapability:
                  pending === "message-question"
                    ? { type: "message" }
                    : { type: "live", providerSessionId: ProviderSessionId.make("session:1") },
                createdAt: at,
                resolvedAt: null,
              },
            },
          ],
        });
      });
    const shell = Effect.map(orchestrator.getShellSnapshot(), (snapshot) =>
      snapshot.threads.find((thread) => thread.id === threadId)!,
    );
    return { threadId, run, ask, shell };
  });

it.layer(layerTest)("usage-limit guards and pending requests", (it) => {
  it.effect.each(["message-question", "approval"] as const)(
    "a person's Continue of a limited run is held only by a request that waits (%s)",
    (pending) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const { threadId, run, ask } = yield* limitedThread(`continue:${pending}`);
        yield* ask(pending);
        const resumed = yield* orchestrator
          .dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`limit-requests:continue:${pending}`),
            threadId,
            messageId: MessageId.make(`limit-requests:continue:${pending}`),
            manualContinuationOfRunId: run.id,
            text: "Continue where you left off.",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          })
          .pipe(Effect.exit);
        const after = yield* orchestrator.getThreadProjection(threadId);
        if (pending === "approval") {
          assert.equal(resumed._tag, "Failure");
          assert.lengthOf(after.runs, 1);
        } else {
          assert.equal(resumed._tag, "Success");
          assert.lengthOf(after.runs, 2);
        }
      }),
  );

  it.effect.each(["message-question", "approval"] as const)(
    "an availability check is recorded only while no request waits (%s)",
    (pending) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const { threadId, run, ask, shell } = yield* limitedThread(`check:${pending}`);
        const now = yield* DateTime.now;
        yield* orchestrator.dispatch(
          limitRecoveryCommand(yield* shell, true, DateTime.toEpochMillis(now))!,
        );
        yield* TestClock.adjust("1 second");
        // Asked after the recovery was armed, before the check comes back.
        yield* ask(pending);
        const armed = yield* shell;
        assert.isDefined(armed.limitRecovery?.requestId);
        const checkedAt = DateTime.formatIso(yield* DateTime.now);
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`limit-requests:checked:${pending}`),
          threadId,
          limitAvailability: {
            runId: run.id,
            requestId: armed.limitRecovery!.requestId,
            expectedUpdatedAt: DateTime.formatIso(armed.updatedAt),
            observation: {
              checkedAt,
              retryAt: DateTime.formatIso(DateTime.add(yield* DateTime.now, { minutes: 5 })),
              status: "allowed",
              threadUpdatedAt: DateTime.formatIso(armed.updatedAt),
              affinity: {
                instanceId,
                continuationKey: "opaque",
                quotaPoolId: `codex:sha256:${"a".repeat(64)}`,
              },
            },
          },
        });
        const availability = (yield* shell).limitRecovery?.availability;
        if (pending === "approval") assert.isUndefined(availability);
        else assert.equal(availability?.status, "allowed");
      }),
  );
});
