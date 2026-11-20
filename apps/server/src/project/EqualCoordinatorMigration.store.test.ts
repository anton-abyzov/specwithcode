/**
 * The migration against the real project service, event sink and receipt
 * store: every project of a machine gets its own command, so one project's
 * receipt never answers for another.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  type ProjectCoordinatorBinding,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { migrate } from "./EqualCoordinatorMigration.ts";
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
        resolve: (workspaceRoot) =>
          Effect.succeed({
            canonicalKey: `github.com/studiotools/${workspaceRoot.split("/").at(-1)}`,
            locator: {
              source: "git-remote" as const,
              remoteName: "origin",
              remoteUrl: `git@github.com:studiotools/${workspaceRoot.split("/").at(-1)}.git`,
            },
            rootPath: workspaceRoot,
          }),
      }),
      Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
        resolvePath: (workspaceRoot) => Effect.succeed(`${workspaceRoot}/favicon.svg`),
      }),
    ),
  ),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "equal-coordinators-store-" })),
  Layer.provide(NodeServices.layer),
);

const member = (environmentId: string, projectId: string) => ({
  environmentId: EnvironmentId.make(environmentId),
  projectId: ProjectId.make(projectId),
  coordinatorThreadId: ThreadId.make(`project-coordinator:${projectId}`),
});

it.layer(layerTest)("equal coordinators: the migration on the real receipt store", (it) => {
  it.effect("migrates two projects that sit at the same epoch and settings revision", () =>
    Effect.gen(function* () {
      const service = yield* ProjectService.ProjectService;
      // Two projects of this machine, each following its own coordinator on another machine.
      const followed = (name: string): ProjectCoordinatorBinding => ({
        epoch: 0,
        state: "transferred",
        operationId: `link-${name}`,
        successor: member("other-machine", `kept-${name}`),
      });
      for (const name of ["one", "two"]) {
        const projectId = ProjectId.make(`project:${name}`);
        yield* service.create({
          commandId: CommandId.make(`create:${name}`),
          projectId,
          title: name,
          workspaceRoot: `/work/${name}`,
          initialLogicalProject: {
            id: `logical:${name}`,
            title: name,
            coordinatorId: `coordinator:${name}`,
            members: [member("other-machine", `kept-${name}`), member("this-machine", projectId)],
          },
          initialCoordinatorBinding: followed(name),
        });
      }
      const before = (yield* service.snapshot).projects;
      assert.deepEqual(
        before.map((project) => [
          project.workspaceSettings?.coordinatorBinding?.state,
          project.workspaceSettings?.coordinatorBinding?.epoch,
          project.workspaceSettings?.revision ?? 0,
        ]),
        [
          ["transferred", 0, before[0]?.workspaceSettings?.revision ?? 0],
          ["transferred", 0, before[0]?.workspaceSettings?.revision ?? 0],
        ],
      );

      const report = yield* migrate(before);
      assert.deepEqual(report.failed, []);
      assert.deepEqual(report.migrated.map((entry) => entry.projectId).sort(), [
        "project:one",
        "project:two",
      ]);
      const after = (yield* service.snapshot).projects;
      assert.deepEqual(
        after.map((project) => project.workspaceSettings?.coordinatorBinding?.state),
        ["active", "active"],
      );
      // A second start finds nothing left to do and breaks nothing.
      const again = yield* migrate(after);
      assert.deepEqual([again.migrated, again.failed], [[], []]);
    }),
  );
});
