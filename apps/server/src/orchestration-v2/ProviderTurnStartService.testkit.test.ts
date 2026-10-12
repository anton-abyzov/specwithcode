import { assert, it } from "@effect/vitest";
import { ProjectId, DEFAULT_PROJECT_WORKSPACE_SETTINGS } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectService from "../project/ProjectService.ts";
import { fixtureProjectDatabase } from "../project/ProjectWorkspace.testkit.ts";
import * as Testkit from "./ProviderTurnStartService.testkit.ts";

const projectId = ProjectId.make("seeded-replay-project");
it.effect("reads real seeded project policy and preserves missing/deleted project behavior", () =>
  Effect.gen(function* () {
    const projects = yield* ProjectService.ProjectService;
    const sql = yield* SqlClient.SqlClient;
    const settings = {
      ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
      kind: "personal" as const,
      environment: { additionalFolders: ["/tmp/approved"], repositories: [] },
    };
    yield* sql`UPDATE projection_projects SET workspace_settings_json=${JSON.stringify(settings)} WHERE project_id=${projectId}`;
    const found = yield* projects.getById(projectId);
    assert.isTrue(Option.isSome(found));
    if (Option.isNone(found)) return;
    assert.equal(found.value.id, projectId);
    assert.equal(found.value.workspaceRoot, `/tmp/${projectId}`);
    assert.deepEqual(found.value.workspaceSettings, settings);
    assert.isTrue(Option.isNone(yield* projects.getById(ProjectId.make("missing"))));
    yield* sql`UPDATE projection_projects SET deleted_at='2026-10-09T16:00:00.000Z' WHERE project_id=${projectId}`;
    assert.isTrue(Option.isNone(yield* projects.getById(projectId)));
    const deleted = yield* projects.getById(projectId, { includeDeleted: true });
    assert.isTrue(Option.isSome(deleted));
    if (Option.isSome(deleted)) assert.equal(deleted.value.deletedAt, "2026-10-09T16:00:00.000Z");
  }).pipe(
    Effect.provide(Testkit.layer.pipe(Layer.provideMerge(fixtureProjectDatabase([projectId])))),
  ),
);
