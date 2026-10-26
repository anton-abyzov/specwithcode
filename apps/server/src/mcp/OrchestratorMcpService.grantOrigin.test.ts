// 1050: a thread that another machine's work started here (under that
// machine's grant) and that calls create_threads starts top-level threads.
// They must carry the same grant origin, or they and everything they start
// run as this machine's own work, outside the grant's projects, sign-ins and
// revocation. These run the real orchestrator, MCP service and grant store.
import { fixtureProjectDatabase, projectFixture } from "../project/ProjectWorkspace.testkit.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
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
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as WorkGrants from "../fleet/WorkGrants.ts";
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

const projectId = ProjectId.make("project:mcp-grant-origin");
const instanceId = ProviderInstanceId.make("codex");
const otherInstanceId = ProviderInstanceId.make("claudeAgent");
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
      ProviderReplayHarness.layerWithRegistry({ name: "mcp-grant-origin" }, layerAdapters, {
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
const layerGrants = WorkGrants.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      NodeCrypto.layer,
      ServerConfig.layerTest(process.cwd(), { prefix: "studio-grant-origin-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({
        setPrincipalRevoked: () => Effect.void,
        listSessions: () => Effect.succeed([] as never),
        revokeSession: () => Effect.succeed(true),
      }),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);
const layerTest = OrchestratorMcpService.layer.pipe(
  Layer.provideMerge(layerThreads),
  Layer.provideMerge(layerGrants),
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
  environmentId: EnvironmentId.make("environment:mcp-grant-origin"),
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

const M1 = EnvironmentId.make("env-m1");
const fromM1 = { coordinatorEnvironmentId: M1, path: [M1], hops: 1 };

/** A coordinator here whose work M1MAX started, under M1MAX's grant. */
const grantCoordinator = (threadId: ThreadId) =>
  Effect.gen(function* () {
    yield* coordinatorAfterTurn(threadId);
    const grants = yield* WorkGrants.WorkGrants;
    yield* grants.recordOrigin(threadId, fromM1);
    const scope = scopeOf(threadId);
    attach(scope);
    return { scope, grants };
  });

const launchOne = (
  scope: ReturnType<typeof scopeOf>,
  key: string,
  launchTarget: { providerInstanceId: ProviderInstanceId; model: string } = target,
) =>
  Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    return yield* service.createThreads(scope, {
      threads: [{ title: "Worker", prompt: "Draft the release notes.", target: launchTarget }],
      clientRequestId: key,
    });
  });

it.effect("a thread created under a grant carries the grant's origin", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const coordinatorId = ThreadId.make("thread:grant-origin-coordinator");
    const { scope, grants } = yield* grantCoordinator(coordinatorId);

    const launched = yield* launchOne(scope, "grant-origin-launch");
    const created = (yield* orchestrator.getThreadProjection(launched.threads[0]!.threadId)).thread;
    // A top-level thread: its lineage leads nowhere back to the coordinator.
    assert.equal(created.lineage.parentThreadId, null);
    assert.deepEqual(yield* grants.originOf(created), fromM1);

    // This machine's own coordinator still creates threads with no origin.
    const ownId = ThreadId.make("thread:grant-origin-own");
    yield* coordinatorAfterTurn(ownId);
    const ownScope = scopeOf(ownId);
    attach(ownScope);
    const own = yield* launchOne(ownScope, "grant-origin-own-launch");
    const ownCreated = (yield* orchestrator.getThreadProjection(own.threads[0]!.threadId)).thread;
    assert.isUndefined(yield* grants.originOf(ownCreated));
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        McpProviderSession.clearMcpProviderSession(
          ThreadId.make("thread:grant-origin-coordinator"),
        );
        McpProviderSession.clearMcpProviderSession(ThreadId.make("thread:grant-origin-own"));
      }),
    ),
    Effect.provide(layerTest),
  ),
);

it.effect("create_threads under a grant keeps to its sign-ins and stops once revoked", () =>
  Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const coordinatorId = ThreadId.make("thread:grant-origin-limits");
    const { scope, grants } = yield* grantCoordinator(coordinatorId);

    // M1MAX may use only the other sign-in here: the resolved codex model is refused.
    yield* grants.forCoordinator(M1);
    yield* grants.update({
      coordinatorEnvironmentId: M1,
      accounts: { kind: "listed", instanceIds: [otherInstanceId] },
    });
    const outside = yield* Effect.flip(launchOne(scope, "grant-origin-account"));
    assert.equal(outside.code, "account_not_allowed");

    yield* grants.update({ coordinatorEnvironmentId: M1, accounts: { kind: "all" } });
    yield* grants.revoke(M1);
    const revoked = yield* Effect.flip(launchOne(scope, "grant-origin-revoked"));
    assert.equal(revoked.code, "machine_not_authorized");
    const listed = yield* service.listThreads(scope, {});
    assert.notInclude(
      listed.threads.map((thread) => thread.title),
      "Worker",
      "no thread was created",
    );
  }).pipe(
    Effect.ensuring(
      Effect.sync(() =>
        McpProviderSession.clearMcpProviderSession(ThreadId.make("thread:grant-origin-limits")),
      ),
    ),
    Effect.provide(layerTest),
  ),
);

// Review round 4: an omitted target keeps the caller's own sign-in, which a
// configure call may have moved off the grant, so delegate_task checks the
// resolved one as create_threads does.
it.effect("delegate_task under a grant starts a subagent only on a sign-in it allows", () =>
  Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const coordinatorId = ThreadId.make("thread:grant-origin-delegate");
    yield* coordinatorAfterTurn(coordinatorId, "running");
    const grants = yield* WorkGrants.WorkGrants;
    yield* grants.recordOrigin(coordinatorId, fromM1);
    const scope = scopeOf(coordinatorId);
    attach(scope);
    yield* grants.forCoordinator(M1);
    yield* grants.update({
      coordinatorEnvironmentId: M1,
      accounts: { kind: "listed", instanceIds: [otherInstanceId] },
    });
    const outside = yield* Effect.flip(
      service.delegateTask(scope, {
        title: "Worker",
        task: "Draft the release notes.",
        clientRequestId: "grant-origin-delegate",
      }),
    );
    assert.equal(outside.code, "account_not_allowed");
  }).pipe(
    Effect.ensuring(
      Effect.sync(() =>
        McpProviderSession.clearMcpProviderSession(ThreadId.make("thread:grant-origin-delegate")),
      ),
    ),
    Effect.provide(layerTest),
  ),
);
