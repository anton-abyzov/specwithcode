import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Run,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { fixtureProjectDatabase } from "../project/ProjectWorkspace.testkit.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { limitRecoveryCommand } from "./UsageLimitRecoveryWorker.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

/**
 * The API-credit rule moved a limited Claude Max thread to a Claude instance
 * on Anthropic API credits, and the turn there stopped on a short API rate
 * limit. With the project's rule off, the orchestrator refuses recovery's
 * resume on the key, whoever built it; the way back takes the thread home.
 */
const ruleOff = ProjectId.make("project:api-credits-off");
const ruleOn = ProjectId.make("project:api-credits-on");
const claudeMax = ProviderInstanceId.make("claudeAgent");
const claudeApi = ProviderInstanceId.make("claude-api");
const adapter = (instanceId: ProviderInstanceId) =>
  ({
    instanceId,
    driver: ProviderDriverKind.make("claudeAgent"),
    getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () => Effect.die("Runs here never reach a provider"),
  }) as ProviderAdapterV2Shape;
const layerDatabase = fixtureProjectDatabase([ruleOff, ruleOn]);
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProviderReplayHarness.layerWithRegistry(
    { name: "api-credit-detour" },
    ProviderAdapterRegistry.layerFromAdapters([adapter(claudeMax), adapter(claudeApi)]),
    {
      databaseLayer: layerDatabase,
      runEffectWorker: false,
      projectSettingsOverrides: {
        [ruleOff]: { providerLimitUseApiCredits: false },
        [ruleOn]: { providerLimitUseApiCredits: true },
      },
    },
  ),
);

/** Fail `run` on a usage limit that resets two minutes on. */
const stopOnLimit = (threadId: ThreadId, run: OrchestrationV2Run, key: string) =>
  Effect.gen(function* () {
    const events = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    yield* events.write({
      commandId: CommandId.make(`api-detour:failure:${key}`),
      events: [
        {
          id: EventId.make(`api-detour:run:${key}`),
          type: "run.updated",
          threadId,
          occurredAt: now,
          payload: { ...run, status: "failed", completedAt: now },
        },
        {
          id: EventId.make(`api-detour:error:${key}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`api-detour:error:${key}`),
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
              message: "Rate limit reached.",
              code: "usageLimitExceeded",
              retryable: null,
              resetAt: DateTime.formatIso(DateTime.add(now, { minutes: 2 })),
            },
          },
        },
      ],
    });
  });

/**
 * A thread stopped on the API-key instance, armed for its reset. `detour`:
 * the API-credit rule's continuation (`limit-api:<thread>:<stopped run>`)
 * put it there; otherwise a person moved it and sent the turn.
 */
const stoppedOnApi = (name: string, projectId: ProjectId, detour: boolean) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make(`api-detour:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`api-detour:create:${name}`),
      threadId,
      projectId,
      title: "Limited thread",
      modelSelection: { instanceId: claudeMax, model: "claude-opus-5-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const send = (messageId: string) =>
      orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(messageId),
        threadId,
        messageId: MessageId.make(messageId),
        text: "Work on this.",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: detour ? "server" : "web",
      });
    yield* send(`api-detour:start:${name}`);
    const subscriptionRun = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
    yield* stopOnLimit(threadId, subscriptionRun, `${name}:max`);
    yield* orchestrator.dispatch({
      type: "thread.model-selection.set",
      commandId: CommandId.make(`api-detour:move:${name}`),
      threadId,
      modelSelection: { instanceId: claudeApi, model: "claude-opus-5-5" },
    });
    yield* send(
      detour ? `limit-api:${threadId}:${subscriptionRun.id}` : `api-detour:person:${name}`,
    );
    const apiRun = (yield* orchestrator.getThreadProjection(threadId)).runs[1]!;
    assert.equal(apiRun.providerInstanceId, claudeApi);
    yield* stopOnLimit(threadId, apiRun, `${name}:api`);
    const shell = Effect.map(orchestrator.getShellSnapshot(), (snapshot) =>
      snapshot.threads.find((thread) => thread.id === threadId)!,
    );
    // Armed as the wait rule arms a short reset, before this fix too.
    yield* orchestrator.dispatch(
      limitRecoveryCommand(yield* shell, true, DateTime.toEpochMillis(yield* DateTime.now))!,
    );
    yield* TestClock.adjust("3 minutes");
    const resume = limitRecoveryCommand(
      yield* shell,
      true,
      DateTime.toEpochMillis(yield* DateTime.now),
    );
    assert.equal(resume?.type, "message.dispatch");
    yield* orchestrator.dispatch(resume!);
    return (yield* orchestrator.getThreadProjection(threadId)).runs.length;
  });

it.layer(layerTest)("usage-limit recovery on an API-credit detour", (it) => {
  it.effect("refuses the resume on the API key while the project's rule is off", () =>
    Effect.gen(function* () {
      assert.equal(yield* stoppedOnApi("rule-off", ruleOff, true), 2);
    }),
  );

  it.effect("resumes while the rule allows API credits", () =>
    Effect.gen(function* () {
      assert.equal(yield* stoppedOnApi("rule-on", ruleOn, true), 3);
    }),
  );

  it.effect("resumes on an API instance a person chose, rule off or not", () =>
    Effect.gen(function* () {
      assert.equal(yield* stoppedOnApi("person", ruleOff, false), 3);
    }),
  );
});
