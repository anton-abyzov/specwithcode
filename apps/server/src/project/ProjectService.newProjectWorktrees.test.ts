import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ProjectId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
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
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "new-project-worktrees-test-" })),
  Layer.provide(NodeServices.layer),
);

const createCode = (service: ProjectService.ProjectService["Service"], name: string) =>
  service.create({
    commandId: CommandId.make(`code:${name}`),
    projectId: ProjectId.make(`project:${name}`),
    title: name,
    workspaceRoot: `/fixtures/example-studio/${name}`,
  });

it.effect("gives new projects Use worktrees from Settings, never changing existing ones", () =>
  Effect.gen(function* () {
    const service = yield* ProjectService.ProjectService;
    const settings = yield* ServerSettings.ServerSettingsService;
    const switchOf = (name: string) =>
      settings.getSettings.pipe(
        Effect.map(
          (current) =>
            current.projectSettingsOverrides[ProjectId.make(`project:${name}`)]
              ?.defaultThreadEnvMode,
        ),
      );

    // Off by default: a new project gets no switch of its own.
    assert.equal((yield* settings.getSettings).newProjectThreadEnvMode, "local");
    yield* createCode(service, "before");
    assert.isUndefined(yield* switchOf("before"));

    // On: a new project starts with its own switch on; the earlier one is untouched.
    yield* settings.updateSettings({ newProjectThreadEnvMode: "worktree" });
    yield* createCode(service, "after");
    assert.equal(yield* switchOf("after"), "worktree");
    assert.isUndefined(yield* switchOf("before"));

    // A project whose switch was already chosen keeps it.
    yield* settings.updateSettings({
      projectSettingsOverrideChanges: {
        [ProjectId.make("project:chosen")]: { set: { defaultThreadEnvMode: "local" } },
      },
    });
    yield* createCode(service, "chosen");
    assert.equal(yield* switchOf("chosen"), "local");

    // A copy of an existing project arriving from another machine keeps that project's switch.
    yield* service.create({
      commandId: CommandId.make("code:arriving"),
      projectId: ProjectId.make("project:arriving"),
      title: "arriving",
      workspaceRoot: "/fixtures/example-studio/arriving",
      initialLogicalProject: {
        id: "logical:arriving",
        title: "arriving",
        coordinatorId: "coordinator:logical:arriving",
        members: [],
      },
    });
    assert.isUndefined(yield* switchOf("arriving"));

    // The personal assistant is not a code project.
    yield* service.create({
      commandId: CommandId.make("assistant:aide"),
      projectId: ProjectId.make("project:aide"),
      title: "Percy",
      kind: "personal",
      workspaceRoot: "/fixtures/example-household/aide",
    });
    assert.isUndefined(yield* switchOf("aide"));

    // Turned off again, projects keep their own switches.
    yield* settings.updateSettings({ newProjectThreadEnvMode: "local" });
    assert.equal(yield* switchOf("after"), "worktree");
  }).pipe(Effect.provide(Layer.merge(layerTest, ServerSettings.layerTest()))),
);
