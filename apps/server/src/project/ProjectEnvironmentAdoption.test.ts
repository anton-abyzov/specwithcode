import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Runtime from "../orchestration-v2/runtimeLayer.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as Projects from "./ProjectService.ts";
import * as Plans from "./ProjectPlanService.ts";
import * as Environment from "./ProjectEnvironmentService.ts";
import * as Enrichment from "./ProjectEnrichmentService.ts";
import * as Favicon from "./ProjectFaviconResolver.ts";
import * as Identity from "./RepositoryIdentityResolver.ts";
import { applyWorkspaceImport } from "./ProjectEnvironmentAdoption.ts";

const layer = Layer.mergeAll(Runtime.layerProjectService, Plans.layer, Environment.layer).pipe(
  Layer.provideMerge(ProjectStore.layer),
  Layer.provideMerge(Projections.layer),
  Layer.provideMerge(Enrichment.layer),
  Layer.provideMerge(
    Layer.succeed(Identity.RepositoryIdentityResolver, { resolve: () => Effect.succeed(null) }),
  ),
  Layer.provideMerge(
    Layer.succeed(Favicon.ProjectFaviconResolver, { resolvePath: () => Effect.succeed(null) }),
  ),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("env-local")),
    }),
  ),
  Layer.provideMerge(ProcessRunner.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "workspace-adoption-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(layer, { excludeTestServices: true })("existing workspace adoption", (it) => {
  it.effect(
    "applies once through normal project events, preserves ID/settings/native plan and rejects stale previews",
    () =>
      Effect.gen(function* () {
        const projects = yield* Projects.ProjectService;
        const environment = yield* Environment.ProjectEnvironmentService;
        const plans = yield* Plans.ProjectPlanService;
        const fs = yield* FileSystem.FileSystem;
        const runner = yield* ProcessRunner.ProcessRunner;
        const root = yield* fs
          .makeTempDirectoryScoped({ prefix: "adopt-integration-" })
          .pipe(Effect.flatMap((p) => fs.realPath(p)));
        yield* fs.makeDirectory(`${root}/.specweave`);
        yield* fs.makeDirectory(`${root}/repo`);
        yield* fs.makeDirectory(`${root}/local-only`);
        assert.equal(
          (yield* runner.run({ command: "git", args: ["init"], cwd: `${root}/local-only` })).code,
          0,
        );
        for (const args of [
          ["init"],
          ["remote", "add", "origin", "https://github.com/example/repo"],
        ]) {
          const result = yield* runner.run({ command: "git", args, cwd: `${root}/repo` });
          assert.equal(result.code, 0);
        }
        yield* fs.writeFileString(`${root}/repo/dirty.txt`, "do not touch");
        yield* fs.writeFileString(
          `${root}/.specweave/config.json`,
          JSON.stringify({
            workspace: {
              repos: [
                { id: "example-repo", path: "repo" },
                { id: "local-only", path: "local-only" },
              ],
            },
          }),
        );
        const projectId = ProjectId.make("retained-project-id");
        yield* projects.create({
          projectId,
          commandId: CommandId.make("create"),
          workspaceRoot: root,
          title: "Existing product",
        });
        yield* projects.update({
          projectId,
          commandId: CommandId.make("goal"),
          workspaceSettings: { expectedRevision: 0, goal: "Keep the product goal" },
        });
        const native = yield* plans.replace({
          projectId,
          expectedRevision: 0,
          actor: { kind: "user" },
          definition: { spec: "Keep this native plan", criteria: [], tasks: [] },
        });
        const preview = yield* environment.previewImport({ projectId, root });
        assert.equal(preview.repositories[1]!.status, "blocked");
        assert.include(preview.repositories[1]!.reason, "local-only");
        const input = {
          projectId,
          root,
          expectedRevision: preview.revision,
          fingerprint: preview.fingerprint,
          commandId: CommandId.make("apply"),
        };
        const saved = yield* applyWorkspaceImport(environment, projects, input);
        assert.equal(saved.repositories[0]!.status, "ready");
        assert.equal(saved.repositories.length, 1);
        assert.deepEqual(saved.additionalFolders, []);
        const project = Option.getOrThrow(yield* projects.getById(projectId));
        assert.equal(project.id, projectId);
        assert.equal(project.title, "Existing product");
        assert.equal(project.workspaceSettings!.goal, "Keep the product goal");
        assert.deepEqual(yield* plans.read({ projectId }), native);
        assert.equal(yield* fs.readFileString(`${root}/repo/dirty.txt`), "do not touch");
        assert.isFalse(yield* fs.exists(`${root}/repo/.specweave`));
        const repeat = yield* environment.previewImport({ projectId, root });
        assert.equal(repeat.repositories[0]!.status, "existing");
        const unchanged = yield* applyWorkspaceImport(environment, projects, {
          ...input,
          expectedRevision: repeat.revision,
          fingerprint: repeat.fingerprint,
          commandId: CommandId.make("repeat"),
        });
        assert.equal(unchanged.revision, saved.revision);
        assert.equal(
          (yield* applyWorkspaceImport(environment, projects, {
            ...input,
            expectedRevision: repeat.revision,
            fingerprint: "0".repeat(64),
          }).pipe(Effect.flip)).code,
          "import_changed",
        );
        assert.equal(
          (yield* applyWorkspaceImport(environment, projects, input).pipe(Effect.flip)).code,
          "import_changed",
        );
        yield* projects.update({
          projectId,
          commandId: CommandId.make("pause"),
          workspaceSettings: { expectedRevision: saved.revision, paused: true },
        });
        assert.equal(
          (yield* applyWorkspaceImport(environment, projects, input).pipe(Effect.flip)).code,
          "inactive",
        );
        assert.equal(
          (yield* applyWorkspaceImport(environment, projects, {
            ...input,
            projectId: ProjectId.make("missing"),
          }).pipe(Effect.flip)).code,
          "not_found",
        );
      }),
  );
  it.effect(
    "refuses blocked-only inventory and a checkout replaced between inspection and save",
    () =>
      Effect.gen(function* () {
        const projects = yield* Projects.ProjectService;
        const environment = yield* Environment.ProjectEnvironmentService;
        const fs = yield* FileSystem.FileSystem;
        const runner = yield* ProcessRunner.ProcessRunner;
        const root = yield* fs
          .makeTempDirectoryScoped({ prefix: "adopt-race-" })
          .pipe(Effect.flatMap((p) => fs.realPath(p)));
        yield* fs.makeDirectory(`${root}/.specweave`);
        yield* fs.makeDirectory(`${root}/repo`);
        yield* runner.run({ command: "git", args: ["init"], cwd: `${root}/repo` });
        yield* fs.writeFileString(
          `${root}/.specweave/config.json`,
          JSON.stringify({ workspace: { repos: [{ id: "repo", path: "repo" }] } }),
        );
        const projectId = ProjectId.make("adoption-race");
        yield* projects.create({
          projectId,
          commandId: CommandId.make("race-create"),
          workspaceRoot: root,
          title: "Preserved",
        });
        const blocked = yield* environment.previewImport({ projectId, root });
        const input = {
          projectId,
          root,
          expectedRevision: blocked.revision,
          fingerprint: blocked.fingerprint,
          commandId: CommandId.make("race-import"),
        };
        assert.equal(
          (yield* applyWorkspaceImport(environment, projects, input).pipe(Effect.flip)).code,
          "import_blocked",
        );
        yield* runner.run({
          command: "git",
          args: ["remote", "add", "origin", "https://github.com/example/repo"],
          cwd: `${root}/repo`,
        });
        const preview = yield* environment.previewImport({ projectId, root });
        const race = {
          getById: projects.getById,
          update: (patch: Parameters<typeof projects.update>[0]) =>
            Effect.gen(function* () {
              yield* fs.rename(`${root}/repo`, `${root}/moved`).pipe(Effect.orDie);
              yield* fs.symlink(`${root}/moved`, `${root}/repo`).pipe(Effect.orDie);
              return yield* projects.update(patch);
            }),
        };
        assert.equal(
          (yield* applyWorkspaceImport(environment, race, {
            ...input,
            fingerprint: preview.fingerprint,
          }).pipe(Effect.flip)).code,
          "import_changed",
        );
        const retained = Option.getOrThrow(yield* projects.getById(projectId));
        assert.deepEqual(retained.workspaceSettings?.environment, {
          additionalFolders: [],
          repositories: [],
        });
        assert.equal(retained.workspaceSettings?.revision, 0);
      }),
  );
});
