// delegate_task in wait mode against the real orchestrator and MCP service:
// a wait with no timeoutMs returns its task handle before an MCP client over
// Node fetch drops the silent call (300 s idle), and a wait that ends without
// the child's result, including a cancelled tools/call, hands delivery to the
// wake so the result still reaches the parent. No effect worker runs, so the
// child stays live.
import { fixtureProjectDatabase, projectFixture } from "../project/ProjectWorkspace.testkit.ts";
import { launchedOrThrow } from "./toolkits/orchestrator/requestSpecweaveSetup.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as McpProviderSession from "./McpProviderSession.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const projectId = ProjectId.make("project:mcp-delegate-wait");
const instanceId = ProviderInstanceId.make("codex");
const model = "gpt-5.1-codex";
const modelSelection = { instanceId, model };
const target = { providerInstanceId: instanceId, model };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapterV2Shape;
const layerAdapters = ProviderAdapterRegistry.layerFromAdapters([adapter]);
const codexProvider: ServerProvider = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-16T00:00:00.000Z",
  models: [{ slug: model, name: model, isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
};

/** The service under test, with `subscribed` completed once the task wait watches for events. */
const layerFor = (subscribed: Deferred.Deferred<void>) => {
  const layerDatabase = fixtureProjectDatabase([projectId]);
  // No effect worker: runs stay where the test puts them.
  const layerThreads = ThreadManagementService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        layerDatabase,
        ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
        ProviderReplayHarness.layerWithRegistry({ name: "mcp-delegate-wait" }, layerAdapters, {
          databaseLayer: layerDatabase,
          runEffectWorker: false,
        }),
      ),
    ),
  );
  const layerWatchedThreads = Layer.effect(
    ThreadManagementService.ThreadManagementService,
    Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      return {
        ...threads,
        streamStoredEventsFrom: (input) =>
          Stream.unwrap(
            Deferred.succeed(subscribed, undefined).pipe(
              Effect.as(threads.streamStoredEventsFrom(input)),
            ),
          ),
      } satisfies ThreadManagementService.ThreadManagementService["Service"];
    }),
  ).pipe(Layer.provideMerge(layerThreads));
  return OrchestratorMcpService.layer.pipe(
    Layer.provideMerge(layerWatchedThreads),
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        layerAdapters,
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([codexProvider]),
          refreshInstance: () => Effect.succeed([codexProvider]),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) => Effect.succeedSome(projectFixture(id)),
        }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      ),
    ),
  );
};

const scopeOf = (
  threadId: ThreadId,
): McpInvocationScope & { readonly thread: NonNullable<McpInvocationScope["thread"]> } => ({
  environmentId: EnvironmentId.make("environment:mcp-delegate-wait"),
  requestNamespace: `session:${threadId}:${instanceId}`,
  thread: {
    threadId,
    providerSessionId: `session:${threadId}:${instanceId}`,
    providerInstanceId: instanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
});

/** A parent thread whose turn is still running, with its provider session attached here. */
const parentWithLiveTurn = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId,
      title: threadId,
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
      commandId: CommandId.make(`send:${threadId}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}`),
      text: "Delegate a review and wait for it.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const now = yield* DateTime.now;
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
    yield* projections.apply({
      id: EventId.make(`event:${threadId}:running`),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "running", startedAt: now, completedAt: null },
    });
    const scope = scopeOf(threadId);
    McpProviderSession.setMcpProviderSession({
      environmentId: scope.environmentId,
      threadId,
      providerSessionId: scope.thread.providerSessionId,
      providerInstanceId: scope.thread.providerInstanceId,
      endpoint: "http://127.0.0.1/mcp",
      authorizationHeader: "Bearer fixture",
      browserToolsAvailable: false,
    });
    return scope;
  }).pipe(
    Effect.tap(() =>
      Effect.addFinalizer(() =>
        Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)),
      ),
    ),
  );

it.effect("a wait with no timeoutMs returns its task handle before 300 s of silence", () =>
  Effect.gen(function* () {
    const subscribed = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const scope = yield* parentWithLiveTurn(ThreadId.make("thread:delegate-wait-default"));
      const waiting = yield* service
        .delegateTask(scope, {
          task: "Review the change.",
          target,
          mode: "wait",
          clientRequestId: "delegate-wait-default",
        })
        .pipe(Effect.map(launchedOrThrow), Effect.timed, Effect.forkChild);
      yield* Deferred.await(subscribed);
      // Nothing is written to the call while it blocks; step the clock past
      // any default the wait could use and measure when it returned.
      const ticking = yield* Effect.forEach(
        Array.from({ length: 700 }),
        () => TestClock.adjust(Duration.seconds(1)),
        { discard: true },
      ).pipe(Effect.forkChild);
      const [elapsed, result] = yield* Fiber.join(waiting);
      yield* Fiber.interrupt(ticking);
      assert.isBelow(
        Duration.toMillis(elapsed),
        300_000,
        `a wait without timeoutMs stayed silent for ${Duration.toMillis(elapsed) / 1_000} s, so a Node MCP client drops the call before it learns the taskId`,
      );
      assert.isString(result.taskId);
      assert.equal(result.status, "running");
      assert.isTrue(result.waitTimedOut);
    }).pipe(Effect.scoped, Effect.provide(layerFor(subscribed)));
  }),
);

it.effect("a cancelled wait hands the child's result to the parent's wake", () =>
  Effect.gen(function* () {
    const subscribed = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:delegate-wait-cancelled");
      const scope = yield* parentWithLiveTurn(threadId);
      const call = yield* service
        .delegateTask(scope, {
          task: "Review the change.",
          target,
          mode: "wait",
          timeoutMs: 30 * 60 * 1_000,
          clientRequestId: "delegate-wait-cancelled",
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(subscribed);
      // A steer or interrupt of the parent cancels the tools/call, which interrupts this fiber.
      yield* Fiber.interrupt(call);
      const parent = yield* orchestrator.getThreadProjection(threadId);
      const task = parent.subagents.find((subagent) => subagent.origin === "app_owned");
      assert.equal(task?.status, "running");
      assert.equal(
        task?.completionWake,
        "always",
        "a cancelled wait left the task settled_only, so its result never reaches the still-live parent run",
      );
    }).pipe(Effect.scoped, Effect.provide(layerFor(subscribed)));
  }),
);
