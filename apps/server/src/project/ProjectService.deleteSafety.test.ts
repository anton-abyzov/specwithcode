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
import * as Logger from "effect/Logger";
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
import * as ProjectAdmission from "./ProjectAdmission.ts";
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
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "project-delete-safety-" })),
  Layer.provideMerge(NodeServices.layer),
);

const seedProject = Effect.fn("ProjectDeleteSafetyTest.seedProject")(function* (
  projectId: ProjectId,
  title: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, default_model_selection_json,
      scripts_json, created_at, updated_at, deleted_at
    ) VALUES (
      ${projectId}, ${title}, ${`/work/${projectId}`}, NULL,
      '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
    )
  `;
});

function threadCreated(projectId: ProjectId, threadId: ThreadId) {
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
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
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

const run = <A, E>(
  body: Effect.Effect<
    A,
    E,
    Layer.Success<typeof layerServices> | Layer.Success<typeof layerDatabase>
  >,
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-10-17T03:00:00.000Z"));
    return yield* body;
  }).pipe(Effect.provide(layerServices.pipe(Layer.provideMerge(layerDatabase))));

it.effect("lets a client delete a project with no threads without naming it", () =>
  run(
    Effect.gen(function* () {
      // Removing a clone that never landed sends only the project id, from
      // released web and phone builds too.
      const projectId = ProjectId.make("project:empty");
      yield* seedProject(projectId, "Empty project");
      const service = yield* ProjectService.make;
      const deleted = yield* service.delete({
        commandId: CommandId.make("delete:empty"),
        projectId,
      });
      assert.isNotNull(deleted.deletedAt);
    }),
  ),
);

it.effect("still asks the server's own forced deletes to name the project", () =>
  run(
    Effect.gen(function* () {
      const projectId = ProjectId.make("project:server-forced");
      yield* seedProject(projectId, "Forced");
      const service = yield* ProjectService.make;
      const denied = yield* service
        .delete({
          commandId: CommandId.make("server:forced"),
          projectId,
          force: true,
          initiator: "server",
        })
        .pipe(Effect.flip);
      assert.instanceOf(denied, ProjectService.ProjectRequestDeniedError);
    }),
  ),
);

it.effect("refuses a sixth client delete within a minute and accepts again after it", () =>
  run(
    Effect.gen(function* () {
      const service = yield* ProjectService.make;
      const ids = Array.from({ length: 8 }, (_, index) => ProjectId.make(`project:burst-${index}`));
      for (const [index, projectId] of ids.entries())
        yield* seedProject(projectId, `Burst ${index}`);
      const clientDelete = (index: number) =>
        service.delete({
          commandId: CommandId.make(`delete:burst:${index}`),
          projectId: ids[index]!,
          confirmationTitle: `Burst ${index}`,
        });

      // The 2026-10-17 client sent its deletes all at once.
      const accepted = yield* Effect.forEach([0, 1, 2, 3, 4], clientDelete, {
        concurrency: "unbounded",
      });
      assert.lengthOf(accepted, ProjectService.PROJECT_DELETE_BURST_LIMIT);

      yield* TestClock.adjust("59 seconds");
      const refused = yield* clientDelete(5).pipe(Effect.flip);
      assert.instanceOf(refused, ProjectService.ProjectRequestDeniedError);
      assert.equal(refused.reason, "too_many_deletes");
      assert.equal(
        refused.message,
        "Too many projects were deleted in the last minute. Wait a minute, then delete the rest.",
      );
      assert.equal(ProjectService.projectMutationErrorMessage(refused), refused.message);
      assert.isTrue(Option.isSome(yield* service.getById(ids[5]!)));

      // The app's own cleanup is not a client burst.
      const swept = yield* service.delete({
        commandId: CommandId.make("server:burst:sweep"),
        projectId: ids[6]!,
        initiator: "server",
      });
      assert.isNotNull(swept.deletedAt);

      yield* TestClock.adjust("1 second");
      const later = yield* clientDelete(5);
      assert.isNotNull(later.deletedAt);
    }),
  ),
);

it.effect("does not count a client delete that failed toward the limit", () =>
  run(
    Effect.gen(function* () {
      const service = yield* ProjectService.make;
      const eventSink = yield* EventSink.EventSinkV2;
      const busyId = ProjectId.make("project:has-threads");
      yield* seedProject(busyId, "Has threads");
      yield* eventSink.write({
        events: [threadCreated(busyId, ThreadId.make("thread:kept"))],
      });
      // Not forced: the project still has a thread, so each attempt fails after
      // taking its slot and must give it back.
      for (let attempt = 0; attempt < ProjectService.PROJECT_DELETE_BURST_LIMIT + 2; attempt++) {
        const failure = yield* service
          .delete({
            commandId: CommandId.make(`delete:has-threads:${attempt}`),
            projectId: busyId,
            confirmationTitle: "Has threads",
          })
          .pipe(Effect.flip);
        assert.equal(failure._tag, "ProjectNotEmptyError");
      }
      const emptyId = ProjectId.make("project:after-failures");
      yield* seedProject(emptyId, "After failures");
      const deleted = yield* service.delete({
        commandId: CommandId.make("delete:after-failures"),
        projectId: emptyId,
        confirmationTitle: "After failures",
      });
      assert.isNotNull(deleted.deletedAt);
    }),
  ),
);

it.effect("logs who deleted which project, with its folder and thread count", () =>
  run(
    Effect.gen(function* () {
      const service = yield* ProjectService.make;
      const eventSink = yield* EventSink.EventSinkV2;
      const projectId = ProjectId.make("project:audited");
      yield* seedProject(projectId, "Audited");
      yield* eventSink.write({
        events: [
          threadCreated(projectId, ThreadId.make("thread:audited-a")),
          threadCreated(projectId, ThreadId.make("thread:audited-b")),
        ],
      });
      const entries: Array<ReadonlyArray<unknown>> = [];
      const logger = Logger.make(({ message }) => {
        entries.push(Array.isArray(message) ? message : [message]);
      });
      const commandId = CommandId.make("delete:audited");
      yield* service
        .delete({ commandId, projectId, force: true, confirmationTitle: "Audited" })
        .pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));

      const audit = entries.filter((entry) => entry[0] === "project.deleted");
      assert.lengthOf(audit, 1);
      assert.deepEqual(audit[0]![1], {
        projectId,
        title: "Audited",
        workspaceRoot: `/work/${projectId}`,
        threadCount: 2,
        commandId,
        initiator: "client",
        force: true,
      });

      // A retried command replays its receipt; nothing is deleted again, so no new line.
      entries.length = 0;
      yield* service
        .delete({ commandId, projectId, force: true, confirmationTitle: "Audited" })
        .pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
      assert.lengthOf(
        entries.filter((entry) => entry[0] === "project.deleted"),
        0,
      );
    }),
  ),
);
