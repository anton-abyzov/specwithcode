import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../Sqlite.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as Layer from "effect/Layer";
import { EventId, ProjectId } from "@specweave-studio/contracts";
const layer = ProjectStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
it.layer(layer)("project environment migration", (it) => {
  it.effect(
    "constrains status and project-command uniqueness and purges only removed project receipts",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const projects = yield* ProjectStore.ProjectStoreV2;
        for (const id of ["a", "b"]) {
          const projectId = ProjectId.make(id);
          yield* projects.apply({
            sequence: 1,
            eventId: EventId.make(id),
            aggregateKind: "project",
            aggregateId: projectId,
            occurredAt: "2026-10-09T00:00:00.000Z",
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "project.created",
            payload: {
              projectId,
              title: id,
              workspaceRoot: `/synthetic/${id}`,
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-10-09T00:00:00.000Z",
              updatedAt: "2026-10-09T00:00:00.000Z",
            },
          });
          yield* sql`INSERT INTO project_environment_preparations VALUES (${id},'c','hash','/synthetic','pending',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`;
        }
        assert.isTrue(
          (yield* sql`INSERT INTO project_environment_preparations VALUES ('a','c','other','/other','pending',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`.pipe(
            Effect.result,
          ))._tag === "Failure",
        );
        assert.isTrue(
          (yield* sql`UPDATE project_environment_preparations SET status='arbitrary' WHERE project_id='a'`.pipe(
            Effect.result,
          ))._tag === "Failure",
        );
        yield* sql`DELETE FROM projection_projects WHERE project_id='a'`;
        assert.deepEqual(
          (yield* sql<{
            project_id: string;
          }>`SELECT project_id FROM project_environment_preparations`).map((row) => row.project_id),
          ["b"],
        );
      }),
  );
});
