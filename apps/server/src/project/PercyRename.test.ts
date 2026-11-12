import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ProjectId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import PercyRenamePending from "../persistence/Migrations/075_PercyRenamePending.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as PercyRename from "./PercyRename.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import * as ProjectService from "./ProjectService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const layerTest = RuntimeLayer.layerProjectService.pipe(
  Layer.provideMerge(ProjectStore.layer),
  Layer.provideMerge(ProjectEnrichmentService.layer),
  Layer.provideMerge(
    Layer.succeed(WorkspacePaths.WorkspacePaths, {
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot.replace(/\/$/, "")),
      resolveRelativePathWithinRoot: ({ workspaceRoot, relativePath }) =>
        Effect.succeed({ absolutePath: `${workspaceRoot}/${relativePath}`, relativePath }),
    }),
  ),
  Layer.provideMerge(
    Layer.merge(
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: () => Effect.succeed(null),
      }),
      Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
        resolvePath: () => Effect.succeed(null),
      }),
    ),
  ),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "percy-rename-test-" })),
  Layer.provide(NodeServices.layer),
);

// A fictional household machine: no real person, account or folder.
const createProject = (
  service: ProjectService.ProjectService["Service"],
  id: string,
  title: string,
  kind: "personal" | "code",
) =>
  service.create({
    commandId: CommandId.make(`create:${id}`),
    projectId: ProjectId.make(`project:${id}`),
    title,
    ...(kind === "personal" ? { kind } : {}),
    workspaceRoot: `/fixtures/example-household/${id}`,
  });

const titleOf = (service: ProjectService.ProjectService["Service"], id: string) =>
  service
    .getById(ProjectId.make(`project:${id}`))
    .pipe(Effect.map((p) => Option.getOrThrow(p).title));

const pendingCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM percy_rename_pending
  `;
  return rows[0]!.count;
});

it.effect("renames the assistant still called Aide to Percy, once", () =>
  Effect.gen(function* () {
    const service = yield* ProjectService.ProjectService;
    yield* createProject(service, "assistant", " Aide ", "personal");
    // Upgrading lists the assistant once.
    yield* PercyRenamePending;
    assert.equal(yield* pendingCount, 1);

    const outcomes = yield* PercyRename.runPending;
    assert.equal(outcomes.get("project:assistant"), "renamed");
    assert.equal(yield* titleOf(service, "assistant"), "Percy");
    assert.equal(yield* pendingCount, 0);

    // Renamed back by the person, it stays "Aide" on every later start.
    yield* service.update({
      commandId: CommandId.make("rename-back"),
      projectId: ProjectId.make("project:assistant"),
      title: "Aide",
    });
    assert.equal((yield* PercyRename.runPending).size, 0);
    assert.equal(yield* titleOf(service, "assistant"), "Aide");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("leaves a custom assistant name alone", () =>
  Effect.gen(function* () {
    const service = yield* ProjectService.ProjectService;
    yield* createProject(service, "assistant", "Jarvis", "personal");
    yield* PercyRenamePending;
    assert.equal(yield* pendingCount, 0);
    assert.equal((yield* PercyRename.runPending).size, 0);
    assert.equal(yield* titleOf(service, "assistant"), "Jarvis");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("never renames a code project called Aide", () =>
  Effect.gen(function* () {
    const service = yield* ProjectService.ProjectService;
    yield* createProject(service, "tool", "Aide", "code");
    yield* PercyRenamePending;
    assert.equal(yield* pendingCount, 0);
    assert.equal(yield* titleOf(service, "tool"), "Aide");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("skips and logs when another project is already called Percy", () =>
  Effect.gen(function* () {
    const service = yield* ProjectService.ProjectService;
    yield* createProject(service, "assistant", "Aide", "personal");
    yield* createProject(service, "percy", "percy", "code");
    yield* PercyRenamePending;

    const outcomes = yield* PercyRename.runPending;
    assert.equal(outcomes.get("project:assistant"), "skipped");
    assert.equal(yield* titleOf(service, "assistant"), "Aide");
    // Never tried again.
    assert.equal(yield* pendingCount, 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("skips an assistant renamed before the server got to it", () =>
  Effect.gen(function* () {
    const service = yield* ProjectService.ProjectService;
    yield* createProject(service, "assistant", "Aide", "personal");
    yield* PercyRenamePending;
    yield* service.update({
      commandId: CommandId.make("rename-first"),
      projectId: ProjectId.make("project:assistant"),
      title: "Alfred",
    });
    const outcomes = yield* PercyRename.runPending;
    assert.equal(outcomes.get("project:assistant"), "skipped");
    assert.equal(yield* titleOf(service, "assistant"), "Alfred");
  }).pipe(Effect.provide(layerTest)),
);
