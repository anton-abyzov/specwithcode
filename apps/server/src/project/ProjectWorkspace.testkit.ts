import type { Project, ProjectId } from "@specweave-studio/contracts";
export function projectFixture(id: ProjectId, patch: Partial<Project> = {}): Project {
  return {
    id,
    title: "Fixture",
    workspaceRoot: "/tmp/project-fixture",
    repositoryIdentity: null,
    defaultModelSelection: null,
    defaultThreadEnvMode: null,
    autoPull: false,
    projectIcon: null,
    faviconPath: null,
    scripts: [],
    createdAt: "2026-10-09T00:00:00Z",
    updatedAt: "2026-10-09T00:00:00Z",
    deletedAt: null,
    ...patch,
  };
}

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type { MigrationError } from "effect/sql/Migrator";
import type { SqlError } from "effect/sql/SqlError";
import type { PlatformError } from "effect/PlatformError";
import * as Persistence from "../persistence/Sqlite.ts";
/** Register explicit fixture projects before raw thread commands. For restart tests,
 * seed the fresh file-backed database once, then reopen its original layer. */
export const fixtureProjectDatabase = (
  ids: ReadonlyArray<ProjectId>,
  databaseLayer: Layer.Layer<
    SqlClient.SqlClient,
    MigrationError | SqlError | PlatformError
  > = Persistence.layerMemory,
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const id of ids)
        yield* sql`INSERT INTO projection_projects
    (project_id,title,workspace_root,default_model_selection_json,scripts_json,created_at,updated_at,deleted_at)
    VALUES (${id},'Fixture',${`/tmp/${id}`},NULL,'[]','2026-10-09T00:00:00.000Z','2026-10-09T00:00:00.000Z',NULL)`;
    }),
  ).pipe(Layer.provideMerge(databaseLayer));
