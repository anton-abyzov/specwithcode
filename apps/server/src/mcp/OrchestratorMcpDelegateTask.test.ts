// delegate_task against the real orchestrator and MCP service: the harness
// limits (a new child is refused once a parent run holds too many live
// children or the chain is too deep) and the deprecated role field. No effect
// worker runs, so children stay live.
import { fixtureProjectDatabase, projectFixture } from "../project/ProjectWorkspace.testkit.ts";
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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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
import { MAX_DELEGATION_DEPTH, MAX_LIVE_CHILD_TASKS_PER_RUN } from "./delegationLimits.ts";

const projectId = ProjectId.make("project:mcp-delegation-limits");
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
const layerDatabase = fixtureProjectDatabase([projectId]);
// No effect worker: runs stay where the test puts them.
const layerThreads = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry({ name: "mcp-delegation-limits" }, layerAdapters, {
        databaseLayer: layerDatabase,
        runEffectWorker: false,
      }),
    ),
  ),
);
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
const layerTest = OrchestratorMcpService.layer.pipe(
  Layer.provideMerge(layerThreads),
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

const scopeOf = (
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId = instanceId,
): McpInvocationScope & { readonly thread: NonNullable<McpInvocationScope["thread"]> } => ({
  environmentId: EnvironmentId.make("environment:mcp-delegation-limits"),
  requestNamespace: `session:${threadId}:${providerInstanceId}`,
  thread: {
    threadId,
    providerSessionId: `session:${threadId}:${providerInstanceId}`,
    providerInstanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
});

/** The provider session that holds `scope`'s credential is attached in this server. */
const attach = (scope: ReturnType<typeof scopeOf>) =>
  McpProviderSession.setMcpProviderSession({
    environmentId: scope.environmentId,
    threadId: scope.thread.threadId,
    providerSessionId: scope.thread.providerSessionId,
    providerInstanceId: scope.thread.providerInstanceId,
    endpoint: "http://127.0.0.1/mcp",
    authorizationHeader: "Bearer fixture",
    browserToolsAvailable: false,
  });

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
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
  });

/** A coordinator whose one turn ran and ended with `status`. */
const coordinatorAfterTurn = (
  threadId: ThreadId,
  status: "completed" | "interrupted" | "running" = "completed",
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* createThread(threadId);
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}`),
      text: "Plan the release and start the workers.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const now = yield* DateTime.now;
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
    yield* projections.apply({
      id: EventId.make(`event:${threadId}:${status}`),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: {
        ...run,
        status,
        startedAt: now,
        completedAt: status === "running" ? null : now,
      },
    });
    return run;
  });

/** Marks `threadId`'s latest run completed, so the thread can delegate between turns. */
const completeLatestRun = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
    yield* projections.apply({
      id: EventId.make(`event:${threadId}:${run.id}:completed`),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "completed", startedAt: now, completedAt: now },
    });
  });

const delegate = (scope: ReturnType<typeof scopeOf>, key: string) =>
  Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    return yield* service.delegateTask(scope, {
      task: "Check the build.",
      target,
      mode: "async",
      clientRequestId: key,
    });
  });

const attachedThreads: Array<ThreadId> = [];
const attachTracked = (scope: ReturnType<typeof scopeOf>) => {
  attachedThreads.push(scope.thread.threadId);
  attach(scope);
};
const detachAll = Effect.sync(() => {
  for (const threadId of attachedThreads.splice(0))
    McpProviderSession.clearMcpProviderSession(threadId);
});

it.effect("a parent run gets refused one child past the live-children limit", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:delegation-limits-fanout");
    yield* coordinatorAfterTurn(threadId);
    const scope = scopeOf(threadId);
    attachTracked(scope);

    // Just under the limit every delegation goes through.
    for (let index = 0; index < MAX_LIVE_CHILD_TASKS_PER_RUN; index += 1) {
      yield* delegate(scope, `fanout-${index}`);
    }
    const refused = yield* delegate(scope, "fanout-over").pipe(Effect.flip);
    assert.equal(refused.code, "invalid_request");
    assert.include(
      refused.message,
      `${MAX_LIVE_CHILD_TASKS_PER_RUN} live child tasks in this run (max ${MAX_LIVE_CHILD_TASKS_PER_RUN})`,
    );
    assert.include(refused.message, "Finish or cancel a child task, or do this step yourself.");

    // A retry of a round that already created its child is not a new delegation.
    const retried = yield* delegate(scope, "fanout-0");
    assert.isString(retried.taskId);
  }).pipe(Effect.ensuring(detachAll), Effect.provide(layerTest)),
);

it.effect("a chain is refused one level past the depth limit", () =>
  Effect.gen(function* () {
    const rootId = ThreadId.make("thread:delegation-limits-depth");
    yield* coordinatorAfterTurn(rootId);
    let current = rootId;
    // Each level delegates one child, up to the deepest allowed level.
    for (let depth = 1; depth <= MAX_DELEGATION_DEPTH; depth += 1) {
      const scope = scopeOf(current);
      attachTracked(scope);
      const delegated = yield* delegate(scope, `depth-${depth}`);
      current = delegated.childThreadId;
      yield* completeLatestRun(current);
    }
    const deepest = scopeOf(current);
    attachTracked(deepest);
    const refused = yield* delegate(deepest, "depth-over").pipe(Effect.flip);
    assert.equal(refused.code, "invalid_request");
    assert.include(
      refused.message,
      `a new child would sit at depth ${MAX_DELEGATION_DEPTH + 1} (max ${MAX_DELEGATION_DEPTH})`,
    );
  }).pipe(Effect.ensuring(detachAll), Effect.provide(layerTest)),
);

it.effect("role adds no persona line; review only points at the sw-review skill", () =>
  Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:delegate-task-role");
    yield* coordinatorAfterTurn(threadId);
    const scope = scopeOf(threadId);
    attachTracked(scope);
    const promptFor = (role: "review" | "implementation", key: string) =>
      Effect.gen(function* () {
        const delegated = yield* service.delegateTask(scope, {
          task: "Check the build.",
          target,
          role,
          mode: "async",
          clientRequestId: key,
        });
        const parent = yield* orchestrator.getThreadProjection(threadId);
        return parent.subagents.find((task) => task.id === delegated.taskId)?.prompt ?? "";
      });

    const review = yield* promptFor("review", "role-review");
    assert.isTrue(review.startsWith("Load the sw-review skill first"));
    assert.notInclude(review, "Act as the");
    assert.include(review, "Check the build.");
    const implementation = yield* promptFor("implementation", "role-implementation");
    assert.isTrue(implementation.startsWith("Check the build."));
  }).pipe(Effect.ensuring(detachAll), Effect.provide(layerTest)),
);
