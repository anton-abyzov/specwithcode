import * as ProjectAdmission from "./ProjectAdmission.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { TestClock } from "effect/testing";
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
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "project-threads-deletion-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const seedProject = Effect.fn("ProjectThreadsDeletionTest.seedProject")(function* (
  projectId: ProjectId,
) {
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

function nativeThreadCreated(
  projectId: ProjectId,
  threadId: ThreadId,
  subagentOf: ThreadId | null = null,
) {
  const createdAt = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
  const providerInstanceId = ProviderInstanceId.make("codex");
  const payload: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: threadId,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage:
      subagentOf === null
        ? { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId }
        : {
            parentThreadId: subagentOf,
            relationshipToParent: "subagent",
            rootThreadId: subagentOf,
          },
    forkedFrom: null,
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  return {
    id: EventId.make(`created:${threadId}`),
    type: "thread.created" as const,
    threadId,
    providerInstanceId,
    occurredAt: createdAt,
    payload,
  };
}

it.effect("deletes every thread but the coordinator and keeps the project and its memory", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make("project:threads-deletion");
    // Without a saved binding the coordinator has its fallback id.
    const coordinator = ThreadId.make(`project-coordinator:${projectId}`);
    const workers = [ThreadId.make("thread:worker-a"), ThreadId.make("thread:worker-b")] as const;
    // A subagent running inside the coordinator stays with it.
    const helper = ThreadId.make("thread:coordinator-helper");
    const commandId = CommandId.make("command:delete-threads");
    yield* seedProject(projectId);
    yield* sql`
      INSERT INTO project_memory (project_id, name, content, revision, updated_at, byte_length)
      VALUES (${projectId}, 'MEMORY.md', 'Keep this.', 1, '2026-01-01T00:00:00.000Z', 10)
    `;
    yield* TestClock.setTime(Date.parse("2026-10-28T12:00:00.000Z"));

    yield* Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* eventSink.write({
        events: [
          ...[coordinator, ...workers].map((threadId) => nativeThreadCreated(projectId, threadId)),
          nativeThreadCreated(projectId, helper, coordinator),
        ],
      });
      const service = yield* ProjectService.make;

      const denied = yield* service
        .deleteThreads({ commandId, projectId, confirmationTitle: "Wrong title" })
        .pipe(Effect.flip);
      assert.instanceOf(denied, ProjectService.ProjectRequestDeniedError);
      for (const threadId of workers) {
        assert.isNull((yield* projections.getThreadProjection(threadId)).thread.deletedAt);
      }

      const preview = yield* service.deleteThreads({
        commandId,
        projectId,
        confirmationTitle: "",
        dryRun: true,
      });
      assert.sameMembers([...preview], [...workers]);
      assert.isNull((yield* projections.getThreadProjection(workers[0])).thread.deletedAt);

      const input = { commandId, projectId, confirmationTitle: "Deletion test" };
      const deleted = yield* service.deleteThreads(input);
      assert.sameMembers([...deleted], [...workers]);
      for (const threadId of workers) {
        assert.isNotNull((yield* projections.getThreadProjection(threadId)).thread.deletedAt);
      }
      assert.isNull((yield* projections.getThreadProjection(coordinator)).thread.deletedAt);
      assert.isNull((yield* projections.getThreadProjection(helper)).thread.deletedAt);
      assert.isTrue(Option.isSome(yield* service.getById(projectId)));
      const memory = yield* sql<{ readonly content: string }>`
        SELECT content FROM project_memory WHERE project_id = ${projectId}
      `;
      assert.deepEqual(
        memory.map((row) => row.content),
        ["Keep this."],
      );
      // Soft deletion keeps the creation events, so an imported old thread is not re-imported.
      const created = yield* sql<{ readonly stream_id: string }>`
        SELECT stream_id FROM orchestration_events WHERE event_type = 'thread.created'
      `;
      assert.lengthOf(created, 4);

      assert.deepEqual(yield* service.deleteThreads(input), []);
    }).pipe(Effect.provide(layerServices));
  }).pipe(Effect.provide(layerDatabase)),
);
