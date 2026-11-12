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
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectAdmission from "./ProjectAdmission.ts";
import * as Environment from "./ProjectEnvironmentService.ts";
import { projectMutationErrorEntry } from "./ProjectService.ts";
import {
  describeProjectEnvironmentProblem,
  normalizeProjectEnvironment,
  resolveProjectEnvironment,
  resolveProjectEnvironmentForRun,
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
  // Native separators: approvals are compared with the canonical folders.
  const path = yield* Path.Path;
  const home = path.join(root, "home");
  const main = path.join(root, "main");
  const external = path.join(root, "external");
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
  it.effect("lists the repositories found in the project folder only when asked", () =>
    Effect.gen(function* () {
      const x = yield* setup;
      const path = yield* Path.Path;
      const nested = path.join(x.main, "repositories", "synthetic", "nested");
      yield* x.fs.makeDirectory(nested, { recursive: true });
      yield* x.fixture(["init", "-b", "trunk"], nested);
      yield* x.fixture(["remote", "add", "origin", url], nested);
      yield* x.seed({
        additionalFolders: [],
        repositories: [{ id: "saved", url, localPath: nested }],
      });
      // An older client never asks, and gets what it always got.
      assert.isUndefined((yield* x.service.read({ projectId: x.projectId })).found);
      const read = yield* x.service.read({ projectId: x.projectId, discover: true, refresh: true });
      assert.deepEqual(read.found, [
        {
          relativePath: "repositories/synthetic/nested",
          path: nested,
          name: "nested",
          origin: "synthetic/project",
          branch: "trunk",
          defaultBranch: null,
          inSpecweave: false,
          state: "available",
          noRemote: false,
          threadWorktrees: 0,
          repositoryId: "saved",
        },
      ]);
      assert.isTrue(read.rootIsRepository);
      assert.equal(read.foundMore, 0);
      assert.deepEqual(read.skippedLinks, []);
      // Its folder is a found clone, so the saved entry is no longer needed; it is still saved.
      assert.deepEqual(read.redundantEntries, [{ repositoryId: "saved", reason: "found_clone" }]);
      assert.equal(read.repositories[0]?.id, "saved");
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
  it.effect("a run skips each unusable entry by name and keeps the healthy ones", () =>
    Effect.gen(function* () {
      const x = yield* setup;
      const gone = `${x.external}-gone`;
      const linked = `${x.main}-link`;
      yield* x.fs.symlink(x.external, linked);
      const environment = {
        additionalFolders: [x.external, gone, linked],
        repositories: [{ id: "far", url, localPath: `${x.root}/far` }],
      };
      const resolved = yield* resolveProjectEnvironmentForRun(x.projectId, x.main, environment);
      assert.equal(resolved.workspaceRoot, x.main);
      assert.deepEqual(resolved.additionalFolders, [x.external]);
      assert.deepEqual(resolved.repositories, []);
      assert.deepEqual(
        resolved.problems.map((problem) => [problem.path, problem.reason]),
        [
          [gone, "missing"],
          [linked, "moved"],
          [`${x.root}/far`, "outside"],
        ],
      );
      assert.include(
        describeProjectEnvironmentProblem(resolved.problems[1]!),
        `${linked} now leads to ${x.external}`,
      );
      // One line per entry: control characters in a folder name cannot fake more lines.
      assert.equal(
        describeProjectEnvironmentProblem({ kind: "folder", path: "/a\nb", reason: "missing" }),
        "Approved folder /a\\u000ab is missing or is not a folder. Update or remove it in the project's Environment settings.",
      );
      // A save still refuses the first bad entry, and says which one and what to do.
      const refused = yield* resolveProjectEnvironment(x.projectId, x.main, {
        additionalFolders: [x.external, gone],
        repositories: [],
      }).pipe(Effect.flip);
      assert.equal(refused.code, "path_not_approved");
      assert.include(refused.message, gone);
      assert.include(refused.message, "Environment settings");
      const missingRoot = yield* resolveProjectEnvironmentForRun(
        x.projectId,
        `${x.main}-missing`,
        environment,
      ).pipe(Effect.flip);
      assert.equal(missingRoot.code, "path_not_approved");
    }),
  );
  it.effect("offers Update path only for a moved folder that is still the same checkout", () =>
    Effect.gen(function* () {
      const x = yield* setup;
      const path = yield* Path.Path;
      // The shared checkout was renamed and a link left at the old, approved path.
      // Update path is the resolved folder, so it carries native separators.
      const renamed = path.join(x.root, "renamed");
      const old = `${x.root}/old`;
      yield* x.fixture(["clone", `${x.root}/remote.git`, renamed], x.root);
      yield* x.fixture(["remote", "set-url", "origin", url], renamed);
      yield* x.fs.symlink(renamed, old);
      // An unrelated folder that also became a link is named but never re-pointed by a click.
      const other = `${x.root}/other`;
      yield* x.fs.symlink(x.external, other);
      yield* x.seed({
        additionalFolders: [old, other],
        repositories: [{ id: "code", url, localPath: old }],
      });
      const read = yield* x.service.read({ projectId: x.projectId });
      assert.deepEqual(read.additionalFolders, []);
      assert.deepEqual(read.repositories, []);
      assert.deepEqual(
        read.problems?.map(({ kind, path, reason, updatePath }) => ({
          kind,
          path,
          reason,
          updatePath,
        })),
        [
          { kind: "folder", path: old, reason: "moved", updatePath: renamed },
          { kind: "folder", path: other, reason: "moved", updatePath: undefined },
          { kind: "repository", path: old, reason: "outside", updatePath: renamed },
        ],
      );
      assert.include(read.problems?.[0]?.message, `${old} now leads to ${renamed}`);
      // Applying the update is an ordinary save, checked as strictly as any other.
      const saved = yield* normalizeProjectEnvironment(x.projectId, x.main, {
        additionalFolders: [renamed],
        repositories: [{ id: "code", url, localPath: renamed }],
      });
      assert.deepEqual(saved.additionalFolders, [renamed]);
      // A checkout linked into an unrelated folder does not make that folder the same checkout.
      const unrelated = `${x.root}/unrelated`;
      yield* x.fs.makeDirectory(unrelated);
      yield* x.fs.symlink(renamed, `${unrelated}/code`);
      yield* x.fs.remove(other);
      yield* x.fs.symlink(unrelated, other);
      yield* x.seed({
        additionalFolders: [other],
        repositories: [{ id: "code", url, localPath: `${other}/code` }],
      });
      const linked = yield* x.service.read({ projectId: x.projectId });
      assert.deepEqual(
        linked.problems?.map(({ path, updatePath }) => [path, updatePath]),
        [
          [other, undefined],
          [`${other}/code`, undefined],
        ],
      );
      yield* x.seed({
        additionalFolders: [old, other],
        repositories: [{ id: "code", url, localPath: old }],
      });
      // A different repository at the new path is not the same checkout.
      yield* x.fixture(
        ["remote", "set-url", "origin", "https://github.com/synthetic/other"],
        renamed,
      );
      const mismatch = yield* x.service.read({ projectId: x.projectId });
      assert.isUndefined(mismatch.problems?.[0]?.updatePath);
      assert.isUndefined(mismatch.problems?.[2]?.updatePath);
    }),
  );
  it.effect("reads an environment-free project whose folder is reached through a link", () =>
    Effect.gen(function* () {
      const x = yield* setup;
      const linkedRoot = `${x.root}/linked-main`;
      yield* x.fs.symlink(x.main, linkedRoot);
      yield* x.projects.apply({
        sequence: counter,
        eventId: EventId.make(`linked-root-${counter}`),
        aggregateKind: "project",
        aggregateId: x.projectId,
        occurredAt: "2026-10-09T00:00:00.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.created",
        payload: {
          projectId: x.projectId,
          title: "Linked",
          workspaceRoot: linkedRoot,
          defaultModelSelection: null,
          scripts: [],
          workspaceSettings: DEFAULT_PROJECT_WORKSPACE_SETTINGS,
          createdAt: "2026-10-09T00:00:00.000Z",
          updatedAt: "2026-10-09T00:00:00.000Z",
        },
      });
      const read = yield* x.service.read({ projectId: x.projectId });
      assert.deepEqual(read.problems, []);
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
      const moved = yield* x.service.read({ projectId: x.projectId }).pipe(Effect.flip);
      assert.equal(moved.code, "folder_changed");
      // The resolver names which folder moved; the generic wording would not.
      assert.notInclude(moved.message, "did not start");
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
  it.effect("reports a renamed repository's origin so Settings can update the URL", () =>
    Effect.gen(function* () {
      const x = yield* setup;
      yield* x.seed({
        additionalFolders: [],
        repositories: [
          { id: "main", url: "https://github.com/synthetic/old-name.git", localPath: x.main },
        ],
      });
      const renamed = yield* x.service.read({ projectId: x.projectId });
      assert.equal(renamed.repositories[0]?.status, "mismatch");
      assert.equal(renamed.repositories[0]?.origin, url);
      // An origin carrying credentials never leaves the server.
      yield* x.fixture([
        "remote",
        "set-url",
        "origin",
        "https://user:secret@github.com/synthetic/project.git",
      ]);
      const credentialed = yield* x.service.read({ projectId: x.projectId });
      assert.equal(credentialed.repositories[0]?.status, "mismatch");
      assert.isUndefined(credentialed.repositories[0]?.origin);
      // A matching checkout reports no origin at all.
      yield* x.fixture([
        "remote",
        "set-url",
        "origin",
        "https://github.com/synthetic/old-name.git",
      ]);
      const ready = yield* x.service.read({ projectId: x.projectId });
      assert.equal(ready.repositories[0]?.status, "ready");
      assert.isUndefined(ready.repositories[0]?.origin);
    }),
  );
  it.effect("a URL saved as a checkout path names its entry and says it is not a folder", () =>
    Effect.gen(function* () {
      const x = yield* setup;
      const error = yield* normalizeProjectEnvironment(x.projectId, x.main, {
        additionalFolders: [],
        repositories: [
          { id: "code", url, localPath: "https://github.com/synthetic/project-renamed.git" },
        ],
      }).pipe(Effect.flip);
      assert.equal(error.code, "path_not_approved");
      assert.deepEqual(error.entry, {
        kind: "repository",
        path: "https://github.com/synthetic/project-renamed.git",
        repositoryId: "code",
      });
      assert.include(error.message, "is a repository URL, not a folder");
      // A rejected save carries the entry to the client, not only the sentence.
      assert.deepEqual(projectMutationErrorEntry(error), { entry: error.entry! });
      const relative = yield* normalizeProjectEnvironment(x.projectId, x.main, {
        additionalFolders: [],
        repositories: [{ id: "code", url, localPath: "checkouts/code" }],
      }).pipe(Effect.flip);
      assert.include(relative.message, "is not an absolute folder path");
    }),
  );
});
