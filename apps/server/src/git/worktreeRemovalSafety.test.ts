import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, vi } from "@effect/vitest";
import {
  ThreadId,
  type TerminalMetadataStreamEvent,
  type TerminalSummary,
} from "@specweave-studio/contracts";
import * as NodeSqliteClient from "@specweave-studio/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { makeWorktreeRemovalGuard } from "./worktreeRemovalSafety.ts";

const testLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "studio-removal-test-" })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "studio-remove-" }));
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "worktree");
  yield* fs.makeDirectory(repo);
  const run = (cwd: string, args: ReadonlyArray<string>) =>
    git.execute({ operation: "test", cwd, args });
  yield* run(repo, ["init", "-b", "main"]);
  yield* run(repo, ["config", "user.name", "Removal test"]);
  yield* run(repo, ["config", "user.email", "test@example.invalid"]);
  yield* fs.writeFileString(path.join(repo, "file.txt"), "committed\n");
  yield* fs.writeFileString(path.join(repo, ".gitignore"), "node_modules/\nprivate-data/\n.env\n");
  yield* run(repo, ["add", "."]);
  yield* run(repo, ["commit", "-m", "fixture"]);
  yield* run(repo, ["worktree", "add", "-b", "feature", worktree]);
  // Minimal persistence adapter fixture retains real SQLite query/filter semantics.
  yield* sql`CREATE TABLE projection_projects (workspace_root TEXT, deleted_at TEXT)`;
  yield* sql`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, payload_json TEXT, deleted_at TEXT, archived_at TEXT)`;
  yield* sql`CREATE TABLE orchestration_v2_effect_outbox (thread_id TEXT, status TEXT)`;
  yield* sql`CREATE TABLE orchestration_v2_projection_provider_sessions (payload_json TEXT, status TEXT, thread_id TEXT)`;
  yield* sql`INSERT INTO projection_projects VALUES (${repo}, NULL)`;
  const retainedTerminals: TerminalSummary[] = [];
  const releases = yield* Queue.unbounded<void>();
  const unsubscribe = vi.fn(() => {
    Queue.offerUnsafe(releases, undefined);
  });
  let terminalListener: ((event: TerminalMetadataStreamEvent) => Effect.Effect<void>) | null = null;
  const terminalService = Layer.mock(TerminalManager.TerminalManager)({
    subscribeMetadata: (listener) =>
      Effect.sync(() => {
        terminalListener = listener;
      }).pipe(
        Effect.andThen(listener({ type: "snapshot", terminals: retainedTerminals })),
        Effect.as(() => {
          terminalListener = null;
          unsubscribe();
        }),
      ),
  });
  const emitTerminal = (event: TerminalMetadataStreamEvent) =>
    Effect.suspend(() =>
      terminalListener === null
        ? Effect.die("Test terminal listener is not subscribed")
        : terminalListener(event),
    );
  const makeGuard = (driver = git) =>
    makeWorktreeRemovalGuard.pipe(
      Effect.provide(terminalService),
      Effect.provideService(GitVcsDriver.GitVcsDriver, driver),
    );
  const remove = yield* makeGuard();
  const input = { cwd: repo, path: worktree, force: true };
  return {
    fs,
    path,
    sql,
    git,
    repo,
    root,
    worktree,
    input,
    remove,
    run,
    makeGuard,
    retainedTerminals,
    emitTerminal,
    unsubscribe,
    releases,
  };
});

describe("explicit worktree removal with real Git", () => {
  const terminal = (cwd: string, overrides: Partial<TerminalSummary> = {}): TerminalSummary => ({
    threadId: "terminal-owner",
    terminalId: "t1",
    cwd,
    worktreePath: null,
    status: "running",
    pid: 123,
    exitCode: null,
    exitSignal: null,
    hasRunningSubprocess: false,
    label: "Shell",
    updatedAt: "2026-10-09",
    ...overrides,
  });
  it.effect(
    "removes an unowned clean linked checkout, keeps its branch and ignores force=true",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const removeWorktree = vi.fn(f.git.removeWorktree);
        const remove = yield* f.makeGuard({ ...f.git, removeWorktree });
        yield* remove(f.input);
        expect(yield* f.fs.exists(f.worktree)).toBe(false);
        expect((yield* f.run(f.repo, ["rev-parse", "--verify", "feature"])).exitCode).toBe(0);
        expect(removeWorktree).toHaveBeenCalledWith({
          cwd: f.repo,
          path: f.worktree,
          force: false,
        });
        expect(f.unsubscribe).toHaveBeenCalledOnce();
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect.each(["file.txt", "untracked.txt", ".env", "private-data/record.txt"])(
    "keeps local data despite force=true: %s",
    (filename) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const target = f.path.join(f.worktree, filename);
        yield* f.fs.makeDirectory(f.path.dirname(target), { recursive: true });
        yield* f.fs.writeFileString(target, "valuable local data\n");
        const error = yield* f.remove(f.input).pipe(Effect.flip);
        expect(error._tag).toBe("GitCommandError");
        expect(yield* f.fs.readFileString(target)).toBe("valuable local data\n");
        expect(f.unsubscribe).toHaveBeenCalledOnce();
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("allows reproducible ignored dependencies", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const dependency = f.path.join(f.worktree, "node_modules", "package");
      yield* f.fs.makeDirectory(dependency, { recursive: true });
      yield* f.fs.writeFileString(f.path.join(dependency, "index.js"), "export {};\n");
      yield* f.remove(f.input);
      expect(yield* f.fs.exists(f.worktree)).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "treats an already removed checkout as a no-op without pruning other registrations",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const removeWorktree = vi.fn(f.git.removeWorktree);
        const pruneWorktrees = vi.fn(f.git.pruneWorktrees);
        const remove = yield* f.makeGuard({ ...f.git, removeWorktree, pruneWorktrees });
        yield* remove(f.input);
        yield* remove(f.input);
        expect(removeWorktree).toHaveBeenCalledOnce();
        expect(pruneWorktrees).not.toHaveBeenCalled();
        expect((yield* f.run(f.repo, ["rev-parse", "--verify", "feature"])).exitCode).toBe(0);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect.each([false, true])(
    "keeps checkout referenced by a surviving thread (archived=%s)",
    (archived) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.sql`INSERT INTO orchestration_v2_projection_threads VALUES ('other', ${JSON.stringify({ worktreePath: f.worktree })}, NULL, ${archived ? "2026-10-01" : null})`;
        const error = yield* f.remove(f.input).pipe(Effect.flip);
        expect(error.detail).toContain("Another thread");
        expect(yield* f.fs.exists(f.worktree)).toBe(true);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "waits outside the lease for deleted-thread cleanup, then completes the requested removal",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.sql`INSERT INTO orchestration_v2_projection_threads VALUES ('deleted', ${JSON.stringify({ worktreePath: f.worktree })}, '2026-10-01', NULL)`;
        yield* f.sql`INSERT INTO orchestration_v2_effect_outbox VALUES ('deleted', 'running')`;
        yield* f.sql`INSERT INTO orchestration_v2_projection_provider_sessions (payload_json, status, thread_id) VALUES (${JSON.stringify({ cwd: f.worktree })}, 'running', 'deleted')`;
        f.retainedTerminals.push(terminal(f.worktree, { threadId: "deleted" }));
        const removal = yield* f.remove(f.input).pipe(Effect.forkChild);
        // The first pending attempt has released both its subscription and lease.
        yield* Queue.take(f.releases);
        expect(yield* f.fs.exists(f.worktree)).toBe(true);
        yield* f.sql`UPDATE orchestration_v2_effect_outbox SET status = 'succeeded'`;
        yield* f.sql`UPDATE orchestration_v2_projection_provider_sessions SET status = 'stopped'`;
        f.retainedTerminals.length = 0;
        yield* TestClock.adjust("250 millis");
        yield* Fiber.join(removal);
        expect(yield* f.fs.exists(f.worktree)).toBe(false);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "keeps the checkout with a clear error when deleted-thread cleanup does not settle",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.sql`INSERT INTO orchestration_v2_projection_threads VALUES ('deleted', ${JSON.stringify({ worktreePath: f.worktree })}, '2026-10-01', NULL)`;
        yield* f.sql`INSERT INTO orchestration_v2_effect_outbox VALUES ('deleted', 'running')`;
        const removal = yield* f.remove(f.input).pipe(Effect.forkChild);
        for (let attempt = 0; attempt < 20; attempt++) {
          yield* Queue.take(f.releases);
          yield* TestClock.adjust("250 millis");
        }
        const error = yield* Fiber.join(removal).pipe(Effect.flip);
        expect(error.detail).toContain("cleanup is still running");
        expect(yield* f.fs.exists(f.worktree)).toBe(true);
        expect(f.unsubscribe).toHaveBeenCalledTimes(21);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect.each(["failed", "unknown"])(
    "does not retry deleted-thread cleanup with status %s",
    (status) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.sql`INSERT INTO orchestration_v2_projection_threads VALUES ('deleted', ${JSON.stringify({ worktreePath: f.worktree })}, '2026-10-01', NULL)`;
        yield* f.sql`INSERT INTO orchestration_v2_effect_outbox VALUES ('deleted', ${status})`;
        const error = yield* f.remove(f.input).pipe(Effect.flip);
        expect(error.detail).toContain("failed or has an unknown state");
        expect(f.unsubscribe).toHaveBeenCalledOnce();
        expect(yield* f.fs.exists(f.worktree)).toBe(true);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "never retries a live owner just because another deleted thread has pending cleanup",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        for (const id of ["deleted", "live"]) {
          yield* f.sql`INSERT INTO orchestration_v2_projection_threads VALUES (${id}, ${JSON.stringify({ worktreePath: f.worktree })}, ${id === "deleted" ? "2026-10-01" : null}, NULL)`;
        }
        yield* f.sql`INSERT INTO orchestration_v2_effect_outbox VALUES ('deleted', 'running')`;
        const error = yield* f.remove(f.input).pipe(Effect.flip);
        expect(error.detail).toContain("Another thread");
        expect(f.unsubscribe).toHaveBeenCalledOnce();
        expect(yield* f.fs.exists(f.worktree)).toBe(true);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("allows only the verified cancelling setup to release its own thread reference", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.sql`INSERT INTO orchestration_v2_projection_threads VALUES ('cancelled', ${JSON.stringify({ worktreePath: f.worktree })}, NULL, NULL)`;
      const verify = vi.fn(() => Effect.succeed(true));
      yield* f.remove(f.input, {
        cancelledSetup: { threadId: ThreadId.make("cancelled"), verify },
      });
      expect(verify).toHaveBeenCalledTimes(2);
      expect(yield* f.fs.exists(f.worktree)).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect.each(["different-owner", "uncancelled", "replacement", "dirty"] as const)(
    "retains cancelling setup checkout when %s invalidates its removal",
    (obstruction) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.sql`INSERT INTO orchestration_v2_projection_threads VALUES ('cancelled', ${JSON.stringify({ worktreePath: f.worktree })}, NULL, NULL)`;
        if (obstruction === "different-owner")
          yield* f.sql`INSERT INTO orchestration_v2_projection_threads VALUES ('different', ${JSON.stringify({ worktreePath: f.worktree })}, NULL, NULL)`;
        if (obstruction === "dirty")
          yield* f.fs.writeFileString(f.path.join(f.worktree, "file.txt"), "keep local work\n");
        let checks = 0;
        const verify = () =>
          Effect.sync(() => {
            checks++;
            return obstruction !== "uncancelled" && !(obstruction === "replacement" && checks > 1);
          });
        yield* f
          .remove(f.input, { cancelledSetup: { threadId: ThreadId.make("cancelled"), verify } })
          .pipe(Effect.flip);
        expect(yield* f.fs.exists(f.worktree)).toBe(true);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect.each(["running", "idle", "error"])(
    "retains a native session checkout while session is %s",
    (status) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.sql`INSERT INTO orchestration_v2_projection_provider_sessions (payload_json, status) VALUES (${JSON.stringify({ cwd: f.path.join(f.worktree, "nested") })}, ${status})`;
        const error = yield* f.remove(f.input).pipe(Effect.flip);
        expect(error.detail).toContain("retained agent session");
        expect(yield* f.fs.exists(f.worktree)).toBe(true);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("retains a running terminal in a nested directory", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.retainedTerminals.push({
        threadId: "terminal-owner",
        terminalId: "t1",
        cwd: f.path.join(f.worktree, "nested"),
        worktreePath: null,
        status: "running",
        pid: 123,
        exitCode: null,
        exitSignal: null,
        hasRunningSubprocess: false,
        label: "Shell",
        updatedAt: "2026-10-09",
      });
      const error = yield* f.remove(f.input).pipe(Effect.flip);
      expect(error.detail).toContain("A terminal");
      expect(yield* f.fs.exists(f.worktree)).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "cancels removal when a terminal starts during inspection, even after its cwd moves outside",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        let inspections = 0;
        const remove = yield* f.makeGuard({
          ...f.git,
          statusDetailsLocal: (cwd) =>
            f.git.statusDetailsLocal(cwd).pipe(
              Effect.tap(() =>
                ++inspections === 2
                  ? f.emitTerminal({
                      type: "upsert",
                      terminal: terminal(f.repo, {
                        status: "starting",
                        worktreePath: f.worktree,
                      }),
                    })
                  : Effect.void,
              ),
            ),
        });
        const error = yield* remove(f.input).pipe(Effect.flip);
        expect(error.detail).toContain("A terminal");
        expect(yield* f.fs.exists(f.worktree)).toBe(true);
        expect(f.unsubscribe).toHaveBeenCalledOnce();
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "uses terminal removal events instead of retaining a terminal that closed before deletion",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        f.retainedTerminals.push(terminal(f.repo));
        let inspections = 0;
        const remove = yield* f.makeGuard({
          ...f.git,
          statusDetailsLocal: (cwd) =>
            f.git.statusDetailsLocal(cwd).pipe(
              Effect.tap(() =>
                ++inspections === 1
                  ? f.emitTerminal({ type: "upsert", terminal: terminal(f.worktree) })
                  : f.emitTerminal({
                      type: "remove",
                      threadId: "terminal-owner",
                      terminalId: "t1",
                    }),
              ),
            ),
        });
        yield* remove(f.input);
        expect(yield* f.fs.exists(f.worktree)).toBe(false);
        expect(f.unsubscribe).toHaveBeenCalledOnce();
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("ignores owners of sibling paths, stopped sessions and exited terminals", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const sibling = f.worktree + "-other";
      yield* f.sql`INSERT INTO orchestration_v2_projection_threads VALUES ('local', ${JSON.stringify({ worktreePath: null })}, NULL, NULL)`;
      yield* f.sql`INSERT INTO orchestration_v2_projection_threads VALUES ('sibling', ${JSON.stringify({ worktreePath: sibling })}, NULL, NULL)`;
      yield* f.sql`INSERT INTO orchestration_v2_projection_provider_sessions (payload_json, status) VALUES (${JSON.stringify({ cwd: sibling })}, 'running')`;
      yield* f.sql`INSERT INTO orchestration_v2_projection_provider_sessions (payload_json, status) VALUES (${JSON.stringify({ cwd: f.worktree })}, 'stopped')`;
      f.retainedTerminals.push(
        terminal(f.worktree, { status: "exited" }),
        terminal(sibling, { terminalId: "t2", worktreePath: sibling }),
      );
      yield* f.remove(f.input);
      expect(yield* f.fs.exists(f.worktree)).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("protects a registered project nested under the worktree", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.sql`INSERT INTO projection_projects VALUES (${f.path.join(f.worktree, "nested")}, NULL)`;
      const error = yield* f.remove(f.input).pipe(Effect.flip);
      expect(error.detail).toContain("registered project");
      expect(yield* f.fs.exists(f.worktree)).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects the main checkout even when it is not registered as a Studio project", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.sql`DELETE FROM projection_projects`;
      const error = yield* f.remove({ ...f.input, path: f.repo }).pipe(Effect.flip);
      expect(error.detail).toContain("linked worktrees");
      expect(yield* f.fs.exists(f.repo)).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects linked worktrees from a different repository", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const other = f.path.join(f.root, "other");
      yield* f.fs.makeDirectory(other);
      yield* f.run(other, ["init", "-b", "main"]);
      const error = yield* f.remove({ ...f.input, cwd: other }).pipe(Effect.flip);
      expect(error.detail).toContain("requested repository");
      expect(yield* f.fs.exists(f.worktree)).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("fails closed when authoritative ownership cannot be read", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.sql`DROP TABLE orchestration_v2_projection_provider_sessions`;
      const error = yield* f.remove(f.input).pipe(Effect.flip);
      expect(error.detail).toContain("could not be verified");
      expect(yield* f.fs.exists(f.worktree)).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect.each(["{", "{}", '{"worktreePath":7}'])(
    "keeps worktree when a surviving thread ownership payload is malformed: %s",
    (payload) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.sql`INSERT INTO orchestration_v2_projection_threads VALUES ('unknown', ${payload}, NULL, NULL)`;
        const error = yield* f.remove(f.input).pipe(Effect.flip);
        expect(error.detail).toContain("could not be verified");
        expect(yield* f.fs.exists(f.worktree)).toBe(true);
        expect(f.unsubscribe).toHaveBeenCalledOnce();
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps worktree when a retained native session has no verifiable cwd", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.sql`INSERT INTO orchestration_v2_projection_provider_sessions (payload_json, status) VALUES ('{}', 'running')`;
      const error = yield* f.remove(f.input).pipe(Effect.flip);
      expect(error.detail).toContain("could not be verified");
      expect(yield* f.fs.exists(f.worktree)).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps worktree when ignored-file enumeration is truncated", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const remove = yield* f.makeGuard({
        ...f.git,
        execute: (input) =>
          f.git
            .execute(input)
            .pipe(
              Effect.map((result) =>
                input.operation === "WorktreeRemoval.ignoredFiles"
                  ? { ...result, stdoutTruncated: true }
                  : result,
              ),
            ),
      });
      const error = yield* remove(f.input).pipe(Effect.flip);
      expect(error.detail).toContain("ignored local files");
      expect(yield* f.fs.exists(f.worktree)).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("fails closed when terminal metadata has no initial snapshot", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const remove = yield* makeWorktreeRemovalGuard.pipe(
        Effect.provide(
          Layer.mock(TerminalManager.TerminalManager)({
            subscribeMetadata: () => Effect.succeed(() => {}),
          }),
        ),
      );
      const error = yield* remove(f.input).pipe(Effect.flip);
      expect(error.detail).toContain("Terminal ownership");
      expect(yield* f.fs.exists(f.worktree)).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects a symlink to a worktree", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const alias = f.path.join(f.root, "alias");
      yield* f.fs.symlink(f.worktree, alias);
      const error = yield* f.remove({ ...f.input, path: alias }).pipe(Effect.flip);
      expect(error.detail).toContain("symbolic link");
      expect(yield* f.fs.exists(f.worktree)).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps detached commits without a retained branch", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.run(f.worktree, ["switch", "--detach"]);
      const error = yield* f.remove(f.input).pipe(Effect.flip);
      expect(error.detail).toContain("retained branch");
      expect(yield* f.fs.exists(f.worktree)).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rechecks a commit created during inspection", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      let reads = 0;
      const remove = yield* f.makeGuard({
        ...f.git,
        resolveCommit: (input) =>
          f.git
            .resolveCommit(input)
            .pipe(
              Effect.tap(() =>
                ++reads === 1
                  ? f.run(f.worktree, ["commit", "--allow-empty", "-m", "concurrent commit"])
                  : Effect.void,
              ),
            ),
      });
      const error = yield* remove(f.input).pipe(Effect.flip);
      expect(error.detail).toContain("changed during inspection");
      expect(yield* f.fs.exists(f.worktree)).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rechecks ownership acquired while Git inspection was running", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      let inspections = 0;
      const remove = yield* f.makeGuard({
        ...f.git,
        statusDetailsLocal: (cwd) =>
          f.git
            .statusDetailsLocal(cwd)
            .pipe(
              Effect.tap(() =>
                ++inspections === 2
                  ? f.sql`INSERT INTO orchestration_v2_projection_threads VALUES ('new-owner', ${JSON.stringify({ worktreePath: f.worktree })}, NULL, NULL)`.pipe(
                      Effect.asVoid,
                      Effect.orDie,
                    )
                  : Effect.void,
              ),
            ),
      });
      const error = yield* remove(f.input).pipe(Effect.flip);
      expect(error.detail).toContain("Another thread");
      expect(yield* f.fs.exists(f.worktree)).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rechecks ignored files created during inspection", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      let reads = 0;
      const remove = yield* f.makeGuard({
        ...f.git,
        resolveCommit: (input) =>
          f.git
            .resolveCommit(input)
            .pipe(
              Effect.tap(() =>
                ++reads === 1
                  ? f.fs
                      .writeFileString(f.path.join(f.worktree, ".env"), "private\n")
                      .pipe(Effect.orDie)
                  : Effect.void,
              ),
            ),
      });
      yield* remove(f.input).pipe(Effect.flip);
      expect(yield* f.fs.readFileString(f.path.join(f.worktree, ".env"))).toBe("private\n");
    }).pipe(Effect.provide(testLayer)),
  );
});
