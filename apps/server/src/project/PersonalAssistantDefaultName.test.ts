import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, DEFAULT_PERSONAL_ASSISTANT_NAME, ProjectId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as DefaultName from "./PersonalAssistantDefaultName.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import * as ProjectService from "./ProjectService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const layerTest = RuntimeLayer.layerProjectService.pipe(
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
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "assistant-default-name-" })),
  Layer.provide(NodeServices.layer),
);

// A fictional household machine: no real person, account or folder.
const createProject = (id: string, title: string, kind: "personal" | "code" = "personal") =>
  Effect.gen(function* () {
    const service = yield* ProjectService.ProjectService;
    return yield* service.create({
      commandId: CommandId.make(`create:${id}`),
      projectId: ProjectId.make(`project:${id}`),
      title,
      ...(kind === "personal" ? { kind } : {}),
      workspaceRoot: `/fixtures/example-household/${id}`,
    });
  });

const titleOf = (id: string) =>
  Effect.gen(function* () {
    const service = yield* ProjectService.ProjectService;
    const project = yield* service.getById(ProjectId.make(`project:${id}`));
    return Option.getOrThrow(project).title;
  });

it.effect("renames a personal assistant still called by the old default", () =>
  Effect.gen(function* () {
    yield* createProject("assistant", "Aide");
    const summary = yield* DefaultName.renameLegacyDefaultAssistants();
    assert.deepEqual(summary, { renamed: 1, failed: 0, waiting: 0 });
    assert.equal(yield* titleOf("assistant"), DEFAULT_PERSONAL_ASSISTANT_NAME);
    assert.equal(DEFAULT_PERSONAL_ASSISTANT_NAME, "Percy");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("leaves a name the person chose for their assistant", () =>
  Effect.gen(function* () {
    yield* createProject("assistant", "Home helper");
    assert.deepEqual(yield* DefaultName.renameLegacyDefaultAssistants(), {
      renamed: 0,
      failed: 0,
      waiting: 0,
    });
    assert.equal(yield* titleOf("assistant"), "Home helper");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("never renames a code project that happens to be called Aide", () =>
  Effect.gen(function* () {
    yield* createProject("code", "Aide", "code");
    assert.deepEqual(yield* DefaultName.renameLegacyDefaultAssistants(), {
      renamed: 0,
      failed: 0,
      waiting: 0,
    });
    assert.equal(yield* titleOf("code"), "Aide");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("is safe to run again and keeps the old name once the person picks it", () =>
  Effect.gen(function* () {
    const service = yield* ProjectService.ProjectService;
    yield* createProject("assistant", "Aide");
    assert.deepEqual(yield* DefaultName.renameLegacyDefaultAssistants(), {
      renamed: 1,
      failed: 0,
      waiting: 0,
    });
    assert.deepEqual(yield* DefaultName.renameLegacyDefaultAssistants(), {
      renamed: 0,
      failed: 0,
      waiting: 0,
    });
    assert.equal(yield* titleOf("assistant"), "Percy");

    // Renamed back by the person: a later start replays its receipt and keeps it.
    yield* service.update({
      commandId: CommandId.make("person:rename"),
      projectId: ProjectId.make("project:assistant"),
      title: "Aide",
    });
    assert.deepEqual(yield* DefaultName.renameLegacyDefaultAssistants(), {
      renamed: 0,
      failed: 0,
      waiting: 0,
    });
    assert.equal(yield* titleOf("assistant"), "Aide");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("does nothing on a machine without an assistant", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* DefaultName.renameLegacyDefaultAssistants(), {
      renamed: 0,
      failed: 0,
      waiting: 0,
    });
  }).pipe(Effect.provide(layerTest)),
);

it("matches only personal projects titled exactly an old default", () => {
  const personal = { kind: "personal" };
  assert.isTrue(DefaultName.hasLegacyDefaultName({ title: "Aide", workspaceSettings: personal }));
  assert.isFalse(DefaultName.hasLegacyDefaultName({ title: "aide", workspaceSettings: personal }));
  assert.isFalse(
    DefaultName.hasLegacyDefaultName({ title: "My Aide", workspaceSettings: personal }),
  );
  assert.isFalse(DefaultName.hasLegacyDefaultName({ title: "Aide", workspaceSettings: null }));
  assert.isFalse(
    DefaultName.hasLegacyDefaultName({ title: "Aide", workspaceSettings: { kind: "code" } }),
  );
});

it.effect("waits while another project has the new name, then renames", () =>
  Effect.gen(function* () {
    yield* createProject("assistant", "Aide");
    yield* createProject("other", "percy", "code");
    assert.deepEqual(yield* DefaultName.renameLegacyDefaultAssistants(), {
      renamed: 0,
      failed: 0,
      waiting: 1,
    });
    assert.equal(yield* titleOf("assistant"), "Aide");
    const service = yield* ProjectService.ProjectService;
    yield* service.update({
      projectId: ProjectId.make("project:other"),
      commandId: CommandId.make("rename:other"),
      title: "Parrot",
    });
    assert.deepEqual(yield* DefaultName.renameLegacyDefaultAssistants(), {
      renamed: 1,
      failed: 0,
      waiting: 0,
    });
    assert.equal(yield* titleOf("assistant"), DEFAULT_PERSONAL_ASSISTANT_NAME);
  }).pipe(Effect.provide(layerTest)),
);
