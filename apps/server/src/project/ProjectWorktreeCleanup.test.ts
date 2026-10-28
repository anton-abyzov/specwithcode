import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProjectId, type ServerSettings } from "@specweave-studio/contracts";
import * as NodeSqliteClient from "@specweave-studio/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import { makeWorktreeRemovalGuard } from "../git/worktreeRemovalSafety.ts";
import * as Settings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProjectWorktreeCleanup from "./ProjectWorktreeCleanup.ts";

const project = ProjectId.make("project-atlas");
const otherProject = ProjectId.make("project-other");

const baseLayer = GitVcsDriver.layer.pipe(
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "studio-project-worktrees-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

const terminals = Layer.mock(TerminalManager.TerminalManager)({
  subscribeMetadata: (listener) =>
    listener({ type: "snapshot", terminals: [] }).pipe(Effect.as(() => undefined)),
});

const settings = Layer.mock(Settings.ServerSettingsService)({
  getSettings: Effect.succeed({
    worktreesDirectory: "",
    previousWorktreesDirectories: [],
  } as unknown as ServerSettings),
});

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const config = yield* ServerConfig.ServerConfig;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "studio-pwt-" }));
  const managed = yield* fs.realPath(config.worktreesDir);
  const repo = path.join(root, "repo");
  yield* fs.makeDirectory(repo);
  const run = (cwd: string, args: ReadonlyArray<string>) =>
    git.execute({ operation: "test", cwd, args });
  yield* run(repo, ["init", "-b", "main"]);
  yield* run(repo, ["config", "user.name", "Project worktree test"]);
  yield* run(repo, ["config", "user.email", "test@example.invalid"]);
  yield* fs.writeFileString(path.join(repo, "file.txt"), "committed\n");
  yield* fs.writeFileString(path.join(repo, ".gitignore"), "node_modules/\n");
  yield* run(repo, ["add", "."]);
  yield* run(repo, ["commit", "-m", "fixture"]);
  const addWorktree = Effect.fn("test.addWorktree")(function* (parent: string, branch: string) {
    const worktree = path.join(parent, branch);
    yield* run(repo, ["worktree", "add", "-b", branch, worktree]);
    return worktree;
  });
  const clean = yield* addWorktree(managed, "clean");
  yield* fs.makeDirectory(path.join(clean, "node_modules"));
  yield* fs.writeFileString(path.join(clean, "node_modules", "dep.js"), "x".repeat(8192));
  yield* fs.writeFileString(path.join(clean, "feature.txt"), "local commit\n");
  yield* run(clean, ["add", "."]);
  yield* run(clean, ["commit", "-m", "local only"]);
  const dirty = yield* addWorktree(managed, "dirty");
  yield* fs.writeFileString(path.join(dirty, "notes.txt"), "uncommitted\n");
  const shared = yield* addWorktree(managed, "shared");
  const outside = yield* addWorktree(root, "outside");

  yield* sql`CREATE TABLE projection_projects (project_id TEXT, workspace_root TEXT, deleted_at TEXT, workspace_settings_json TEXT)`;
  yield* sql`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, project_id TEXT, payload_json TEXT, deleted_at TEXT, archived_at TEXT)`;
  yield* sql`CREATE TABLE orchestration_v2_effect_outbox (thread_id TEXT, status TEXT)`;
  yield* sql`CREATE TABLE orchestration_v2_projection_provider_sessions (payload_json TEXT, status TEXT, thread_id TEXT)`;
  yield* sql`INSERT INTO projection_projects VALUES (${project}, ${repo}, NULL, ${JSON.stringify({ coordinatorThreadId: "t-coordinator" })}), (${otherProject}, ${path.join(root, "other")}, NULL, NULL)`;
  const thread = (
    id: string,
    projectId: string,
    worktreePath: string,
    branch: string,
    parentThreadId: string | null = null,
  ) =>
    sql`INSERT INTO orchestration_v2_projection_threads VALUES (${id}, ${projectId}, ${JSON.stringify({ worktreePath, branch, projectId, title: id, lineage: { parentThreadId, relationshipToParent: parentThreadId === null ? null : "subagent", rootThreadId: parentThreadId ?? id } })}, NULL, NULL)`;
  yield* thread("t-clean", project, clean, "clean");
  yield* thread("t-clean-2", project, clean, "clean");
  yield* thread("t-dirty", project, dirty, "dirty");
  yield* thread("t-shared", project, shared, "shared");
  yield* thread("t-foreign", otherProject, shared, "shared");
  yield* thread("t-outside", project, outside, "outside");
  yield* thread("t-gone", project, path.join(managed, "gone"), "gone");
  const coordinated = yield* addWorktree(managed, "coordinated");
  yield* thread("t-coordinator", project, coordinated, "coordinated");
  yield* thread("t-coordinated", project, coordinated, "coordinated");
  // A subagent inside the coordinator stays with it.
  const helper = yield* addWorktree(managed, "helper");
  yield* thread("t-helper", project, helper, "helper", "t-coordinator");

  const guard = yield* makeWorktreeRemovalGuard.pipe(Effect.provide(terminals));
  const cleanup = yield* ProjectWorktreeCleanup.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        settings,
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          removeWorktree: (input, context) => guard(input, context),
        }),
      ),
    ),
  );
  const deleteProject = Effect.gen(function* () {
    yield* sql`UPDATE projection_projects SET deleted_at = '2026-10-28T00:00:00Z' WHERE project_id = ${project}`;
    yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = '2026-10-28T00:00:00Z' WHERE project_id = ${project}`;
  });
  // Deleting all threads keeps the project and its coordinator.
  const deleteThreads = sql`UPDATE orchestration_v2_projection_threads SET deleted_at = '2026-10-28T00:00:00Z' WHERE project_id = ${project} AND thread_id NOT IN ('t-coordinator', 't-helper')`;
  const useAsProjectFolder = (folder: string) =>
    sql`UPDATE projection_projects SET workspace_root = ${folder} WHERE project_id = ${project}`;
  return {
    fs,
    path,
    run,
    repo,
    clean,
    dirty,
    shared,
    outside,
    cleanup,
    coordinated,
    helper,
    deleteProject,
    deleteThreads,
    useAsProjectFolder,
  };
});

describe("project worktree cleanup with real Git", () => {
  it.effect("lists each recorded worktree once with its size, local commits and risk", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const { worktrees } = yield* f.cleanup.read({ projectId: project });
      const byPath = new Map(worktrees.map((entry) => [entry.path, entry]));
      expect(worktrees).toHaveLength(6);
      expect(byPath.get(f.clean)).toMatchObject({
        status: "removable",
        branch: "clean",
        threadCount: 2,
        // No remote: the fixture commit and the worktree's own commit.
        localCommits: 2,
        detail: null,
      });
      if (process.platform === "win32") {
        expect(byPath.get(f.clean)?.sizeBytes).toBeNull();
      } else {
        expect(byPath.get(f.clean)?.sizeBytes).toBeGreaterThan(0);
      }
      expect(byPath.get(f.dirty)).toMatchObject({ status: "local_changes", localCommits: 1 });
      expect(byPath.get(f.shared)).toMatchObject({ status: "in_use" });
      expect(byPath.get(f.outside)).toMatchObject({ status: "not_removable" });
      // Deleting the project takes the coordinator too.
      expect(byPath.get(f.coordinated)).toMatchObject({ status: "removable", threadCount: 2 });
    }).pipe(Effect.provide(baseLayer)),
  );

  it.effect("leaves the coordinator and its subagents out when only the threads go", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const { worktrees } = yield* f.cleanup.read({ projectId: project, threadsOnly: true });
      const byPath = new Map(worktrees.map((entry) => [entry.path, entry]));
      expect(byPath.get(f.coordinated)).toMatchObject({ status: "in_use", threadCount: 1 });
      expect(byPath.has(f.helper)).toBe(false);
      expect(byPath.get(f.clean)).toMatchObject({ status: "removable" });
    }).pipe(Effect.provide(baseLayer)),
  );

  it.effect("keeps worktrees that a live thread of a live project still records", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const result = yield* f.cleanup.remove({
        projectId: project,
        paths: [f.clean],
        discardLocalChanges: [],
      });
      expect(result.removed).toEqual([]);
      expect(result.kept[0]!.reason).toContain("Delete its threads first");
      expect(yield* f.fs.exists(f.clean)).toBe(true);
    }).pipe(Effect.provide(baseLayer)),
  );

  it.effect("removes deleted threads' worktrees of a live project, never the coordinator's", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.deleteThreads;
      const result = yield* f.cleanup.remove({
        projectId: project,
        paths: [f.clean, f.coordinated, f.helper],
        discardLocalChanges: [],
        threadsOnly: true,
      });
      expect(result.removed).toEqual([f.clean]);
      expect(result.kept.map((entry) => entry.path)).toEqual([f.coordinated, f.helper]);
      expect(yield* f.fs.exists(f.clean)).toBe(false);
      expect(yield* f.fs.exists(f.coordinated)).toBe(true);
      expect(yield* f.fs.exists(f.helper)).toBe(true);
      expect((yield* f.run(f.repo, ["rev-parse", "--verify", "clean"])).exitCode).toBe(0);
    }).pipe(Effect.provide(baseLayer)),
  );

  it.effect(
    "removes confirmed worktrees after deletion and keeps branches and unconfirmed changes",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.deleteProject;
        const first = yield* f.cleanup.remove({
          projectId: project,
          paths: [f.clean, f.dirty, f.shared, f.outside, f.path.resolve("/not/this/project")],
          discardLocalChanges: [],
        });
        expect(first.removed).toEqual([f.clean]);
        expect(first.kept.map((entry) => entry.path)).toEqual([
          f.dirty,
          f.shared,
          f.outside,
          f.path.resolve("/not/this/project"),
        ]);
        expect(first.kept[0]!.reason).toContain("local changes");
        expect(yield* f.fs.exists(f.clean)).toBe(false);
        expect(yield* f.fs.exists(f.dirty)).toBe(true);
        expect(yield* f.fs.exists(f.shared)).toBe(true);
        // The local-only commit is still reachable from its branch.
        expect((yield* f.run(f.repo, ["rev-parse", "--verify", "clean"])).exitCode).toBe(0);

        const second = yield* f.cleanup.remove({
          projectId: project,
          paths: [f.dirty],
          discardLocalChanges: [f.dirty],
        });
        expect(second).toMatchObject({ removed: [f.dirty], kept: [] });
        expect(yield* f.fs.exists(f.dirty)).toBe(false);
        expect((yield* f.run(f.repo, ["rev-parse", "--verify", "dirty"])).exitCode).toBe(0);
      }).pipe(Effect.provide(baseLayer)),
  );

  it.effect("keeps a worktree that is the project's own folder", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.useAsProjectFolder(f.clean);
      const { worktrees } = yield* f.cleanup.read({ projectId: project });
      expect(worktrees.find((entry) => entry.path === f.clean)).toMatchObject({
        status: "not_removable",
      });
      yield* f.deleteProject;
      const result = yield* f.cleanup.remove({
        projectId: project,
        paths: [f.clean],
        discardLocalChanges: [],
      });
      expect(result.removed).toEqual([]);
      expect(result.kept[0]!.reason).toContain("project folder");
      expect(yield* f.fs.exists(f.clean)).toBe(true);
    }).pipe(Effect.provide(baseLayer)),
  );
});
