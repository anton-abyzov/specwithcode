import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  EventId,
  ProjectId,
  type ProjectEnvironmentSettings,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectAdmission from "./ProjectAdmission.ts";
import * as Environment from "./ProjectEnvironmentService.ts";
import {
  normalizeProjectEnvironment,
  resolveProjectEnvironment,
} from "./ProjectEnvironmentPaths.ts";

const storage = ProjectStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
const layer = Layer.mergeAll(storage, ProcessRunner.layer, ProjectAdmission.layer).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const url = "https://github.com/synthetic/project.git";
let counter = 0;
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const native = yield* ProcessRunner.ProcessRunner;
  const root = yield* fs
    .makeTempDirectoryScoped({ prefix: "studio-environment-" })
    .pipe(Effect.flatMap((folder) => fs.realPath(folder)));
  const home = `${root}/home`;
  const main = `${root}/main`;
  const external = `${root}/external`;
  yield* fs.makeDirectory(home);
  yield* fs.makeDirectory(main);
  yield* fs.makeDirectory(external);
  const projectId = ProjectId.make(`environment-${++counter}`);
  const calls: ProcessRunner.ProcessRunInput[] = [];
  const run = (input: ProcessRunner.ProcessRunInput) =>
    native.run({
      ...input,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
  const fixture = (args: readonly string[], cwd = main) =>
    run({ command: "git", args, cwd }).pipe(
      Effect.tap((output) => Effect.sync(() => assert.equal(output.code, 0))),
    );
  yield* fixture(["init", "--bare", `${root}/remote.git`]);
  yield* fixture(["init"]);
  yield* fs.writeFileString(`${main}/README.md`, "synthetic retained file\n");
  yield* fixture(["add", "README.md"]);
  yield* fixture([
    "-c",
    "user.name=Synthetic",
    "-c",
    "user.email=synthetic@example.invalid",
    "commit",
    "-m",
    "fixture",
  ]);
  yield* fixture(["remote", "add", "origin", `${root}/remote.git`]);
  yield* fixture(["push", "origin", "HEAD"]);
  yield* fixture(["remote", "set-url", "origin", url]);
  // Only replace transport at the external process boundary. All clone/match filesystem operations are real Git.
  const runner: ProcessRunner.ProcessRunner["Service"] = {
    run: (input) =>
      Effect.gen(function* () {
        calls.push(input);
        if (input.args.includes("clone")) {
          const output = yield* run({
            ...input,
            args: input.args.map((arg) => (arg === url ? `${root}/remote.git` : arg)),
          });
          if (output.code === 0) yield* fixture(["remote", "set-url", "origin", url], input.cwd);
          return output;
        }
        return yield* run(input);
      }),
  };
  const service = yield* Environment.make.pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
  );
  const projects = yield* ProjectStore.ProjectStoreV2;
  const seed = (environment: ProjectEnvironmentSettings) =>
    projects.apply({
      sequence: counter,
      eventId: EventId.make(`seed-${counter}`),
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
        title: "Synthetic",
        workspaceRoot: main,
        defaultModelSelection: null,
        scripts: [],
        workspaceSettings: { ...DEFAULT_PROJECT_WORKSPACE_SETTINGS, environment },
        createdAt: "2026-10-09T00:00:00.000Z",
        updatedAt: "2026-10-09T00:00:00.000Z",
      },
    });
  return { fs, root, main, external, projectId, service, seed, calls, fixture, projects };
});
it.layer(layer, { excludeTestServices: true })("project environment real Git", (it) => {
  it.effect(
    "clones once into an unused managed folder and matches both main and nested checkouts",
    () =>
      Effect.gen(function* () {
        const x = yield* setup;
        yield* x.seed({
          additionalFolders: [],
          repositories: [{ id: "main", url, localPath: x.main }],
        });
        const input = {
          projectId: x.projectId,
          repositoryId: "main",
          expectedRevision: 0,
          commandId: CommandId.make("match"),
          mode: "match" as const,
        };
        assert.equal((yield* x.service.prepare(input)).repositories[0]?.status, "ready");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE projection_projects SET workspace_settings_json=${JSON.stringify({ ...DEFAULT_PROJECT_WORKSPACE_SETTINGS, revision: 1, environment: { additionalFolders: [], repositories: [{ id: "nested", url, localPath: null }] } })} WHERE project_id=${x.projectId}`;
        const clone = {
          ...input,
          repositoryId: "nested",
          expectedRevision: 1,
          commandId: CommandId.make("clone"),
          mode: "clone" as const,
        };
        const result = yield* x.service.prepare(clone);
        assert.equal(result.repositories[0]?.status, "ready");
        assert.equal(
          yield* x.fs.readFileString(`${x.main}/.studio-repositories/nested/README.md`),
          "synthetic retained file\n",
        );
        yield* x.service.prepare({
          mode: clone.mode,
          commandId: clone.commandId,
          expectedRevision: clone.expectedRevision,
          repositoryId: clone.repositoryId,
          projectId: clone.projectId,
        });
        assert.equal(x.calls.filter((call) => call.args.includes("clone")).length, 1);
        assert.equal(
          (yield* x.service.prepare({ ...clone, mode: "match" }).pipe(Effect.flip)).code,
          "conflict",
        );
        assert.equal(
          (yield* x.service
            .prepare({ ...clone, expectedRevision: 0, commandId: CommandId.make("stale") })
            .pipe(Effect.flip)).code,
          "conflict",
        );
      }),
  );
  it.effect(
    "never overwrites an existing folder, retries failed commands, or matches the wrong origin",
    () =>
      Effect.gen(function* () {
        const x = yield* setup;
        yield* x.seed({
          additionalFolders: [],
          repositories: [
            { id: "main", url: "https://github.com/synthetic/wrong", localPath: x.main },
          ],
        });
        const input = {
          projectId: x.projectId,
          repositoryId: "main",
          expectedRevision: 0,
          commandId: CommandId.make("overwrite"),
          mode: "clone" as const,
        };
        assert.equal(
          (yield* x.service.prepare(input).pipe(Effect.flip)).code,
          "destination_exists",
        );
        assert.equal((yield* x.service.prepare(input).pipe(Effect.flip)).code, "outcome_unknown");
        assert.equal(
          (yield* x.service
            .prepare({ ...input, commandId: CommandId.make("wrong"), mode: "match" })
            .pipe(Effect.flip)).code,
          "repository_mismatch",
        );
        assert.equal(x.calls.filter((call) => call.args.includes("clone")).length, 0);
        assert.equal(
          yield* x.fs.readFileString(`${x.main}/README.md`),
          "synthetic retained file\n",
        );
      }),
  );
  for (const blockAllWrites of [false, true]) {
    it.effect(
      `does not clone again after ${blockAllWrites ? "all" : "success"} receipt writes fail`,
      () =>
        Effect.gen(function* () {
          const x = yield* setup;
          yield* x.seed({
            additionalFolders: [],
            repositories: [{ id: "nested", url, localPath: null }],
          });
          const sql = yield* SqlClient.SqlClient;
          yield* sql.unsafe(`CREATE TEMP TRIGGER reject_environment_receipt_update BEFORE UPDATE ON project_environment_preparations
          ${blockAllWrites ? "" : "WHEN NEW.status = 'succeeded'"}
          BEGIN SELECT RAISE(ABORT, 'synthetic receipt write failure'); END`);
          const input = {
            projectId: x.projectId,
            repositoryId: "nested",
            expectedRevision: 0,
            commandId: CommandId.make("receipt-write-failure"),
            mode: "clone" as const,
          };
          yield* Effect.gen(function* () {
            assert.equal(
              (yield* x.service.prepare(input).pipe(Effect.flip)).code,
              "preparation_failed",
            );
            assert.equal(x.calls.filter((call) => call.args.includes("clone")).length, 1);
            assert.equal(
              yield* x.fs.readFileString(`${x.main}/.studio-repositories/nested/README.md`),
              "synthetic retained file\n",
            );
            const receipts = yield* sql<{
              status: string;
            }>`SELECT status FROM project_environment_preparations WHERE project_id=${x.projectId}`;
            assert.deepEqual(
              receipts.map((receipt) => receipt.status),
              [blockAllWrites ? "pending" : "failed"],
            );
            assert.equal(
              (yield* x.service.prepare(input).pipe(Effect.flip)).code,
              "outcome_unknown",
            );
            assert.equal(x.calls.filter((call) => call.args.includes("clone")).length, 1);
          }).pipe(
            Effect.ensuring(sql`DROP TRIGGER reject_environment_receipt_update`.pipe(Effect.orDie)),
          );
        }),
    );
  }
  it.effect(
    "requires approval for external repositories and rejects symlink escapes and duplicate paths",
    () =>
      Effect.gen(function* () {
        const x = yield* setup;
        const repo = { id: "external", url, localPath: `${x.external}/repo` };
        assert.equal(
          (yield* resolveProjectEnvironment(x.projectId, x.main, {
            additionalFolders: [],
            repositories: [repo],
          }).pipe(Effect.flip)).code,
          "path_not_approved",
        );
        const environment = yield* normalizeProjectEnvironment(x.projectId, x.main, {
          additionalFolders: [x.external],
          repositories: [repo],
        });
        yield* x.seed(environment);
        assert.equal(
          (yield* x.service.prepare({
            projectId: x.projectId,
            repositoryId: "external",
            expectedRevision: 0,
            commandId: CommandId.make("external"),
            mode: "clone",
          })).repositories[0]?.status,
          "ready",
        );
        yield* x.fs.symlink(x.external, `${x.main}/escape`);
        assert.equal(
          (yield* resolveProjectEnvironment(x.projectId, x.main, {
            additionalFolders: [],
            repositories: [{ ...repo, localPath: `${x.main}/escape/repo` }],
          }).pipe(Effect.flip)).code,
          "path_not_approved",
        );
        assert.equal(
          (yield* resolveProjectEnvironment(x.projectId, x.main, {
            additionalFolders: [],
            repositories: [
              { ...repo, localPath: x.main },
              { id: "other", url: "https://github.com/synthetic/other", localPath: x.main },
            ],
          }).pipe(Effect.flip)).code,
          "path_not_approved",
        );
      }),
  );
  it.effect("rejects concurrent preparation replay and purges receipts on project deletion", () =>
    Effect.gen(function* () {
      const x = yield* setup;
      yield* x.seed({
        additionalFolders: [],
        repositories: [{ id: "nested", url, localPath: null }],
      });
      const input = {
        projectId: x.projectId,
        repositoryId: "nested",
        expectedRevision: 0,
        commandId: CommandId.make("same"),
        mode: "clone" as const,
      };
      yield* Effect.all([x.service.prepare(input), x.service.prepare(input)], { concurrency: 2 });
      assert.equal(x.calls.filter((call) => call.args.includes("clone")).length, 1);
      const sql = yield* SqlClient.SqlClient;
      assert.equal(
        (yield* sql`SELECT * FROM project_environment_preparations WHERE project_id=${x.projectId}`)
          .length,
        1,
      );
      yield* sql`UPDATE projection_projects SET deleted_at='2026-10-09T00:00:00.000Z' WHERE project_id=${x.projectId}`;
      assert.equal(
        (yield* sql`SELECT * FROM project_environment_preparations WHERE project_id=${x.projectId}`)
          .length,
        0,
      );
      assert.equal(
        (yield* x.service.read({ projectId: x.projectId }).pipe(Effect.flip)).code,
        "not_found",
      );
    }),
  );
  it.effect("an interrupted preparation leaves a durable pending receipt and is not retried", () =>
    Effect.gen(function* () {
      const x = yield* setup;
      yield* x.seed({
        additionalFolders: [],
        repositories: [{ id: "nested", url, localPath: null }],
      });
      const entered = yield* Deferred.make<void>();
      const interruptedService = yield* Environment.make.pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        }),
      );
      const input = {
        projectId: x.projectId,
        repositoryId: "nested",
        expectedRevision: 0,
        commandId: CommandId.make("reserved"),
        mode: "clone" as const,
      };
      const fiber = yield* interruptedService.prepare(input).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(fiber);
      const sql = yield* SqlClient.SqlClient;
      assert.equal(
        (yield* sql<{
          status: string;
        }>`SELECT status FROM project_environment_preparations WHERE project_id=${x.projectId}`)[0]
          ?.status,
        "pending",
      );
      assert.equal((yield* x.service.prepare(input).pipe(Effect.flip)).code, "outcome_unknown");
      assert.equal(x.calls.length, 0);
      assert.isTrue(yield* x.fs.exists(`${x.main}/.studio-repositories/nested`));
    }),
  );
  it.effect("paused and archived projects may read but cannot admit preparation", () =>
    Effect.gen(function* () {
      const x = yield* setup;
      yield* x.seed({
        additionalFolders: [],
        repositories: [{ id: "nested", url, localPath: null }],
      });
      const sql = yield* SqlClient.SqlClient;
      for (const state of [
        { paused: true, archived: false },
        { paused: false, archived: true },
      ]) {
        yield* sql`UPDATE projection_projects SET workspace_settings_json=${JSON.stringify({ ...DEFAULT_PROJECT_WORKSPACE_SETTINGS, ...state, environment: { additionalFolders: [], repositories: [{ id: "nested", url, localPath: null }] } })} WHERE project_id=${x.projectId}`;
        yield* x.service.read({ projectId: x.projectId });
        assert.equal(
          (yield* x.service
            .prepare({
              projectId: x.projectId,
              repositoryId: "nested",
              commandId: CommandId.make(`blocked-${state.paused}`),
              expectedRevision: 0,
              mode: "clone",
            })
            .pipe(Effect.flip)).code,
          "inactive",
        );
      }
      assert.equal(x.calls.length, 0);
      assert.deepEqual(
        yield* sql`SELECT * FROM project_environment_preparations WHERE project_id=${x.projectId}`,
        [],
      );
      assert.isFalse(yield* x.fs.exists(`${x.main}/.studio-repositories`));
    }),
  );
  it.effect("a replaced primary folder cannot move clone destinations outside approval", () =>
    Effect.gen(function* () {
      const x = yield* setup;
      yield* x.seed({
        additionalFolders: [],
        repositories: [{ id: "nested", url, localPath: null }],
      });
      yield* x.fs.rename(x.main, `${x.root}/retained-main`);
      yield* x.fs.symlink(x.external, x.main);
      assert.equal(
        (yield* x.service.read({ projectId: x.projectId }).pipe(Effect.flip)).code,
        "path_not_approved",
      );
      assert.equal(
        (yield* x.service
          .prepare({
            projectId: x.projectId,
            repositoryId: "nested",
            commandId: CommandId.make("escaped-main"),
            expectedRevision: 0,
            mode: "clone",
          })
          .pipe(Effect.flip)).code,
        "path_not_approved",
      );
      assert.equal(x.calls.length, 0);
      const sql = yield* SqlClient.SqlClient;
      assert.deepEqual(
        yield* sql`SELECT * FROM project_environment_preparations WHERE project_id=${x.projectId}`,
        [],
      );
      assert.isFalse(yield* x.fs.exists(`${x.external}/.studio-repositories`));
      assert.equal(
        yield* x.fs.readFileString(`${x.root}/retained-main/README.md`),
        "synthetic retained file\n",
      );
    }),
  );
});
