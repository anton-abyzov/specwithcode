import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import * as ProjectAdmission from "./ProjectAdmission.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId, ProviderInstanceId, ThreadId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import * as ProjectService from "./ProjectService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const layerEventPersistence = EventSink.layer.pipe(
  Layer.provideMerge(Layer.merge(EventStore.layer, ProjectionStore.layer)),
);
const layerServices = Layer.mergeAll(
  LegacyV1ThreadImporter.layer.pipe(Layer.provideMerge(layerEventPersistence)),
  ProjectionMaintenance.layer.pipe(Layer.provide(layerEventPersistence)),
  ProjectStore.layer,
  IdAllocator.layer,
  ThreadCommandExecutor.layer,
  ProjectAdmission.layer,
  Layer.succeed(WorkspacePaths.WorkspacePaths, {
    normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    resolveRelativePathWithinRoot: ({ workspaceRoot, relativePath }) =>
      Effect.succeed({ absolutePath: `${workspaceRoot}/${relativePath}`, relativePath }),
  }),
).pipe(
  Layer.provideMerge(
    ProjectEnrichmentService.layer.pipe(
      Layer.provide(
        Layer.merge(
          Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
            resolve: () => Effect.succeed(null),
          }),
          Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
            resolvePath: () => Effect.succeed(null),
          }),
        ),
      ),
    ),
  ),
);
const layerDatabase = SqlitePersistence.layerMemory.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "project-deletion-test-" })),
  Layer.provideMerge(NodeServices.layer),
);
const seedProject = Effect.fn("ProjectDeletionTest.seedProject")(function* (projectId: ProjectId) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, default_model_selection_json,
      scripts_json, created_at, updated_at, deleted_at
    ) VALUES (
      ${projectId}, 'Deletion test', ${`/work/${projectId}`}, NULL,
      '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
    )
  `;
});

import { MessageId, ProviderDriverKind } from "@specweave-studio/contracts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Registry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Harness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
const adapter: ProviderAdapterV2Shape = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("No real providers"),
};
const runtime = Harness.layerWithRegistry(
  { name: "deletion-race-review" },
  Registry.layerFromAdapters([adapter]),
  { databaseLayer: layerDatabase, runEffectWorker: false },
);
it.effect("refuses cascade deletion when ordinary dispatch admits work after idle preflight", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("review:race");
    const threadId = ThreadId.make("review:race-thread");
    yield* seedProject(projectId);
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("review:create"),
      threadId,
      projectId,
      title: "Review",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    let calls = 0;
    const intercepted = {
      ...projections,
      getShellSnapshot: () =>
        Effect.gen(function* () {
          calls++;
          if (calls === 2) {
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("review:send"),
              threadId,
              messageId: MessageId.make("review:message"),
              text: "An actual newly accepted user turn",
              attachments: [],
              dispatchMode: { type: "start_immediately" },
              createdBy: "user",
              creationSource: "web",
            });
            const before = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(before.runs.length, 1);
            assert.include(["starting", "running", "queued", "preparing"], before.runs[0]!.status);
          }
          return yield* projections.getShellSnapshot();
        }),
    };
    const service = yield* ProjectService.make.pipe(
      Effect.provideService(ProjectionStore.ProjectionStoreV2, intercepted),
    );
    const denied = yield* service
      .delete({
        projectId,
        commandId: CommandId.make("review:delete"),
        force: true,
        confirmationTitle: "Deletion test",
      })
      .pipe(Effect.flip);
    assert.instanceOf(denied, ProjectService.ProjectRequestDeniedError);
    if (denied._tag !== "ProjectRequestDeniedError")
      return assert.fail("Expected actionable active-work denial");
    assert.equal(denied.reason, "active_work");
    const after = yield* orchestrator.getThreadProjection(threadId);
    assert.include(
      ["preparing", "queued", "starting", "running", "waiting"],
      after.runs[0]!.status,
    );
    assert.isNull(after.thread.deletedAt);
    const project = yield* (yield* ProjectStore.ProjectStoreV2).get(projectId);
    assert.equal(project._tag, "Some");
    const sql = yield* SqlClient.SqlClient;
    assert.deepEqual(
      yield* sql`SELECT event_type FROM orchestration_events WHERE event_type IN ('project.deleted','thread.deleted')`,
      [],
    );
  }).pipe(Effect.provide(Layer.mergeAll(runtime, layerServices)), Effect.provide(layerDatabase)),
);
