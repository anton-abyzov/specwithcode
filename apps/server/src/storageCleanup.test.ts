import { describe, expect, it } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as EffectVitest from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@specweave-studio/contracts";
import * as NodeSqliteClient from "@specweave-studio/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "./config.ts";
import * as GitManager from "./git/GitManager.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as Settings from "./serverSettings.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import { storageCleanupActivityAt, storageCleanupThreadIdle } from "./storageCleanup.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

const NOW_MS = Date.parse("2026-06-10T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

function at(offsetMs: number): DateTime.Utc {
  return DateTime.makeUnsafe(NOW_MS + offsetMs);
}

function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: ThreadId.make("thread-1"),
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: at(-30 * DAY_MS),
    updatedAt: at(-10 * DAY_MS),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

describe("V2 storage cleanup eligibility", () => {
  const candidate = () => shell({ branch: "feature", worktreePath: "/worktrees/feature" });

  it("allows an idle worktree and rejects the project checkout", () => {
    expect(storageCleanupThreadIdle(candidate(), NOW_MS)).toBe(true);
    expect(storageCleanupThreadIdle(shell(), NOW_MS)).toBe(false);
  });

  it.each(["running", "starting", "preparing", "waiting", "queued"] as const)(
    "retains a worktree while its thread is %s",
    (status) => {
      expect(storageCleanupThreadIdle(candidateWithStatus(status), NOW_MS)).toBe(false);
    },
  );

  it("retains an active run even if the shell status is idle", () => {
    expect(
      storageCleanupThreadIdle({ ...candidate(), activeRunId: RunId.make("run") }, NOW_MS),
    ).toBe(false);
  });

  it("retains a queued prompt before the new run has been projected", () => {
    expect(
      storageCleanupThreadIdle({ ...candidate(), latestUserMessageAt: at(-1_000) }, NOW_MS),
    ).toBe(false);
  });

  it("uses V2 run activity instead of metadata refreshes for retention", () => {
    const thread = candidate();
    const runTime = at(-3 * DAY_MS);
    expect(
      storageCleanupActivityAt({ ...thread, latestRunCompletedAt: runTime, updatedAt: at(0) }),
    ).toBe(DateTime.toEpochMillis(runTime));
  });

  it("has no activity time when no reading is known, so it is never old", () => {
    const thread = {
      ...candidate(),
      createdAt: undefined,
    } as unknown as OrchestrationV2ThreadShell;
    expect(storageCleanupActivityAt(thread)).toBeNull();
  });

  function candidateWithStatus(status: OrchestrationV2ThreadShell["status"]) {
    return { ...candidate(), status };
  }
});

const cleanupLayer = GitVcsDriver.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "studio-cleanup-test-" })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

const PROJECT_ID = ProjectId.make("project-1");

/**
 * A real repository with a local origin, linked worktrees under the managed
 * worktrees folder, and every PR reported merged. Threads are written to both
 * the shell snapshot and the ownership tables, as the projections keep them.
 */
const cleanupFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const config = yield* ServerConfig.ServerConfig;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "studio-clean-" }));
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  const run = (cwd: string, args: ReadonlyArray<string>) =>
    git.execute({ operation: "test", cwd, args });
  yield* run(root, ["init", "--bare", "-b", "main", origin]);
  yield* fs.makeDirectory(repo);
  yield* run(repo, ["init", "-b", "main"]);
  yield* run(repo, ["config", "user.name", "Cleanup test"]);
  yield* run(repo, ["config", "user.email", "test@example.invalid"]);
  yield* fs.writeFileString(path.join(repo, "file.txt"), "committed\n");
  yield* run(repo, ["add", "."]);
  yield* run(repo, ["commit", "-m", "fixture"]);
  yield* run(repo, ["remote", "add", "origin", origin]);
  yield* run(repo, ["push", "origin", "main"]);
  yield* run(repo, ["remote", "set-head", "origin", "main"]);
  yield* sql`CREATE TABLE projection_projects (workspace_root TEXT, deleted_at TEXT)`;
  yield* sql`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, payload_json TEXT, deleted_at TEXT, archived_at TEXT)`;
  yield* sql`CREATE TABLE orchestration_v2_effect_outbox (thread_id TEXT, status TEXT)`;
  yield* sql`CREATE TABLE orchestration_v2_projection_provider_sessions (payload_json TEXT, status TEXT, thread_id TEXT)`;
  yield* sql`INSERT INTO projection_projects VALUES (${repo}, NULL)`;
  const worktreesRoot = yield* fs.realPath(config.worktreesDir);
  // The managed worktrees folder reached through a symlinked parent, like a
  // linked drive or macOS /var. Threads may record either spelling.
  const linkedRoot = path.join(root, "linked-worktrees");
  yield* fs.symlink(worktreesRoot, linkedRoot);
  const addWorktree = (branch: string, options?: { readonly linked?: boolean }) =>
    Effect.gen(function* () {
      const worktree = path.join(options?.linked ? linkedRoot : worktreesRoot, "repo", branch);
      yield* run(repo, ["worktree", "add", "-b", branch, worktree]);
      return worktree;
    });
  const realSpelling = (worktree: string) =>
    path.join(worktreesRoot, path.relative(linkedRoot, worktree));
  const threads: Array<OrchestrationV2ThreadShell> = [];
  const addThread = (
    id: string,
    branch: string,
    worktreePath: string,
    state: "open" | "settled" | "archived",
  ) =>
    Effect.gen(function* () {
      const thread = shell({
        id: ThreadId.make(id),
        projectId: PROJECT_ID,
        title: id,
        branch,
        worktreePath,
        ...(state === "settled" ? { settledOverride: "settled", settledAt: at(-DAY_MS) } : {}),
        ...(state === "archived" ? { archivedAt: at(-DAY_MS) } : {}),
      });
      threads.push(thread);
      yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES (${id}, ${JSON.stringify({
        worktreePath,
        projectId: PROJECT_ID,
        title: id,
        settledOverride: thread.settledOverride,
        archivedAt: state === "archived" ? "2026-06-09T12:00:00.000Z" : null,
      })}, NULL, ${state === "archived" ? "2026-06-09T12:00:00.000Z" : null})`;
    });
  const removed: Array<string> = [];
  const hooks = { onPullRequest: Effect.void as Effect.Effect<unknown, SqlError> };
  const sweep = StorageCleanup.make.pipe(
    Effect.flatMap((cleanup) => cleanup.runOnce),
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(Settings.ServerSettingsService)({
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            storageCleanup: {
              ...DEFAULT_SERVER_SETTINGS.storageCleanup,
              worktreeAfterDays: null,
              worktreeOnMerge: true,
              worktreeOnDelete: false,
              worktreeUnchanged: false,
            },
          }),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          listShells: () => Effect.succeed([{ id: PROJECT_ID, workspaceRoot: repo }] as never),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.never }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getShellSnapshot: (options) =>
            Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 0,
              threads: threads.filter(
                (thread) => (thread.archivedAt !== null) === (options?.location === "archive"),
              ),
              archivedThreads: [],
            }),
        }),
        Layer.mock(GitManager.GitManager)({
          branchPullRequest: () =>
            Effect.suspend(() => hooks.onPullRequest).pipe(
              Effect.orDie,
              Effect.as({ state: "merged" } as never),
            ),
          invalidateStatus: () => Effect.void,
        }),
        Layer.mock(TerminalManager.TerminalManager)({}),
      ),
    ),
    Effect.provideService(GitVcsDriver.GitVcsDriver, {
      ...git,
      removeWorktree: (input) =>
        Effect.sync(() => removed.push(input.path)).pipe(Effect.andThen(git.removeWorktree(input))),
    }),
  );
  return { fs, path, sql, repo, run, addWorktree, realSpelling, addThread, removed, hooks, sweep };
});

describe("storage cleanup keeps folders of open threads", () => {
  EffectVitest.it.effect(
    "keeps an open thread's merged worktree and removes settled and archived ones",
    () =>
      Effect.gen(function* () {
        const f = yield* cleanupFixture;
        const open = yield* f.addWorktree("open-merged");
        const settled = yield* f.addWorktree("settled-merged");
        const archived = yield* f.addWorktree("archived-merged");
        yield* f.addThread("open", "open-merged", open, "open");
        yield* f.addThread("settled", "settled-merged", settled, "settled");
        yield* f.addThread("archived", "archived-merged", archived, "archived");
        yield* f.sweep;
        expect(yield* f.fs.exists(open)).toBe(true);
        expect(yield* f.fs.exists(settled)).toBe(false);
        expect(yield* f.fs.exists(archived)).toBe(false);
        expect(f.removed.toSorted()).toEqual([archived, settled].toSorted());
        // The branch stays so the checkout can be recreated.
        for (const branch of ["settled-merged", "archived-merged"])
          expect((yield* f.run(f.repo, ["rev-parse", "--verify", branch])).exitCode).toBe(0);
      }).pipe(Effect.provide(cleanupLayer)),
  );

  EffectVitest.it.effect("keeps an open thread's folder reached through a symlinked parent", () =>
    Effect.gen(function* () {
      const f = yield* cleanupFixture;
      const open = yield* f.addWorktree("linked-open", { linked: true });
      const settled = yield* f.addWorktree("linked-settled", { linked: true });
      yield* f.addThread("linked-open", "linked-open", open, "open");
      yield* f.addThread("linked-settled", "linked-settled", settled, "settled");
      yield* f.sweep;
      expect(yield* f.fs.exists(open)).toBe(true);
      expect(yield* f.fs.exists(settled)).toBe(false);
      expect(f.removed).toEqual([settled]);
    }).pipe(Effect.provide(cleanupLayer)),
  );

  EffectVitest.it.effect(
    "keeps a settled thread's folder that an open thread records under another spelling or works inside",
    () =>
      Effect.gen(function* () {
        const f = yield* cleanupFixture;
        // Two spellings of one folder fall into separate groups, so only the
        // open-thread guard keeps it.
        const shared = yield* f.addWorktree("shared", { linked: true });
        const around = yield* f.addWorktree("around");
        yield* f.addThread("shared-settled", "shared", shared, "settled");
        yield* f.addThread("shared-open", "shared", f.realSpelling(shared), "open");
        yield* f.addThread("around-settled", "around", around, "settled");
        // A nested checkout the open thread recorded; it does not exist right now.
        yield* f.addThread("nested-open", "nested", f.path.join(around, "packages", "app"), "open");
        yield* f.sweep;
        expect(yield* f.fs.exists(shared)).toBe(true);
        expect(yield* f.fs.exists(around)).toBe(true);
        expect(f.removed).toEqual([]);
      }).pipe(Effect.provide(cleanupLayer)),
  );

  EffectVitest.it.effect(
    "keeps a settled thread's folder with new files that Git status is set to hide",
    () =>
      Effect.gen(function* () {
        const f = yield* cleanupFixture;
        const hidden = yield* f.addWorktree("hidden-untracked");
        yield* f.run(hidden, ["config", "status.showUntrackedFiles", "no"]);
        yield* f.fs.writeFileString(f.path.join(hidden, "notes.md"), "not committed\n");
        yield* f.addThread("hidden", "hidden-untracked", hidden, "settled");
        yield* f.sweep;
        expect(yield* f.fs.exists(f.path.join(hidden, "notes.md"))).toBe(true);
        expect(f.removed).toEqual([]);
      }).pipe(Effect.provide(cleanupLayer)),
  );

  EffectVitest.it.effect(
    "keeps a settled thread's folder that a running session uses under its real path",
    () =>
      Effect.gen(function* () {
        const f = yield* cleanupFixture;
        const linked = yield* f.addWorktree("session-linked", { linked: true });
        yield* f.addThread("session-settled", "session-linked", linked, "settled");
        yield* f.sql`INSERT INTO orchestration_v2_projection_provider_sessions VALUES (${JSON.stringify(
          { cwd: f.path.join(f.realSpelling(linked), "apps") },
        )}, 'running', 'other-thread')`;
        yield* f.sweep;
        expect(yield* f.fs.exists(linked)).toBe(true);
        expect(f.removed).toEqual([]);
      }).pipe(Effect.provide(cleanupLayer)),
  );

  EffectVitest.it.effect("keeps a folder whose thread was reopened while Git checks ran", () =>
    Effect.gen(function* () {
      const f = yield* cleanupFixture;
      const settled = yield* f.addWorktree("reopened");
      yield* f.addThread("reopened", "reopened", settled, "settled");
      f.hooks.onPullRequest = f.sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.settledOverride', 'active')
      `;
      yield* f.sweep;
      expect(yield* f.fs.exists(settled)).toBe(true);
      expect(f.removed).toEqual([]);
    }).pipe(Effect.provide(cleanupLayer)),
  );
});

describe("storage cleanup removes finished worktrees no thread records", () => {
  /**
   * Backdates the folder, its entries, its HEAD files and the times inside its
   * reflog past the idle day, and sets the test clock to the file system's
   * time, which idle checks compare.
   */
  const age = Effect.fn("test.age")(function* (
    f: Effect.Success<typeof cleanupFixture>,
    worktrees: ReadonlyArray<string>,
  ) {
    const marker = f.path.join(f.repo, ".git", "clock");
    yield* f.fs.writeFileString(marker, "");
    const now = Option.getOrThrow((yield* f.fs.stat(marker)).mtime).getTime();
    for (const worktree of worktrees) {
      const gitDir = (yield* f.run(worktree, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
      const targets = [
        worktree,
        f.path.join(gitDir, "HEAD"),
        f.path.join(gitDir, "logs", "HEAD"),
        ...(yield* f.fs.readDirectory(worktree)).map((name) => f.path.join(worktree, name)),
      ];
      // Numbers are seconds here, as in Node's fs.utimes.
      const old = (now - 2 * DAY_MS) / 1000;
      const reflog = f.path.join(gitDir, "logs", "HEAD");
      if (yield* f.fs.exists(reflog)) {
        const entries = yield* f.fs.readFileString(reflog);
        yield* f.fs.writeFileString(
          reflog,
          entries.replace(/ \d+ ([+-]\d{4})\t/g, ` ${Math.floor(old)} $1\t`),
        );
      }
      for (const target of targets) yield* f.fs.utimes(target, old, old);
    }
    yield* TestClock.setTime(now);
  });

  EffectVitest.it.effect(
    "removes a clean, pushed, idle agent worktree and keeps unpushed or busy ones",
    () =>
      Effect.gen(function* () {
        const f = yield* cleanupFixture;
        const finished = yield* f.addWorktree("agent-finished");
        const unpushed = yield* f.addWorktree("agent-unpushed");
        yield* f.fs.writeFileString(f.path.join(unpushed, "file.txt"), "local only\n");
        yield* f.run(unpushed, ["commit", "-am", "local"]);
        const busy = yield* f.addWorktree("agent-busy");
        yield* f.sql`INSERT INTO orchestration_v2_projection_provider_sessions VALUES (${JSON.stringify(
          { cwd: f.path.join(busy, "apps") },
        )}, 'running', 'busy-thread')`;
        const fresh = yield* f.addWorktree("agent-fresh");
        yield* age(f, [finished, unpushed, busy]);
        yield* f.sweep;
        expect(f.removed).toEqual([finished]);
        expect(yield* f.fs.exists(finished)).toBe(false);
        for (const kept of [unpushed, busy, fresh]) expect(yield* f.fs.exists(kept)).toBe(true);
        // The branch stays so the work can be checked out again.
        expect((yield* f.run(f.repo, ["rev-parse", "--verify", "agent-finished"])).exitCode).toBe(
          0,
        );
      }).pipe(Effect.provide(cleanupLayer)),
  );

  EffectVitest.it.effect(
    "removes an idle worktree touched by Finder and git gc, keeping hidden build data",
    () =>
      Effect.gen(function* () {
        const f = yield* cleanupFixture;
        yield* f.fs.writeFileString(
          f.path.join(f.repo, ".git", "info", "exclude"),
          ".DS_Store\n*.tsbuildinfo\nbuild/\n.env\n",
        );
        const touched = yield* f.addWorktree("agent-touched");
        const secret = yield* f.addWorktree("agent-secret");
        const hiddenSecret = yield* f.addWorktree("agent-hidden-secret");
        yield* age(f, [touched, secret, hiddenSecret]);
        const gitDir = (yield* f.run(touched, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
        // Fresh Finder and gc mtimes do not constitute work. Build info is safe
        // ignored content, but its file mtime must still satisfy the idle gate.
        yield* f.fs.writeFileString(f.path.join(touched, ".DS_Store"), "finder");
        const now = (yield* Clock.currentTimeMillis) / 1000;
        yield* f.fs.utimes(f.path.join(gitDir, "logs", "HEAD"), now, now);
        yield* f.fs.writeFileString(f.path.join(touched, "app.tsbuildinfo"), "built");
        const oldBuild = now - (2 * DAY_MS) / 1000;
        yield* f.fs.utimes(f.path.join(touched, "app.tsbuildinfo"), oldBuild, oldBuild);
        // An ignored file outside the allowlist still keeps the folder.
        yield* f.fs.writeFileString(f.path.join(secret, ".env"), "TOKEN=x\n");
        // Git collapses this entire ignored folder to build/, hiding the secret.
        yield* f.fs.makeDirectory(f.path.join(hiddenSecret, "build"));
        const hiddenFile = f.path.join(hiddenSecret, "build", ".env.prod");
        yield* f.fs.writeFileString(hiddenFile, "TOKEN=keep\n");
        expect(
          (yield* f.run(hiddenSecret, [
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
            "-z",
          ])).stdout,
        ).toBe("build/\0");
        yield* f.sweep;
        expect(f.removed).toEqual([touched]);
        expect(yield* f.fs.exists(secret)).toBe(true);
        expect(yield* f.fs.readFileString(hiddenFile)).toBe("TOKEN=keep\n");
      }).pipe(Effect.provide(cleanupLayer)),
  );

  EffectVitest.it.effect(
    "reads idle time past a dangling symlink or missing reflog, and keeps an unreadable folder",
    () =>
      Effect.gen(function* () {
        const f = yield* cleanupFixture;
        // A tracked link to a file outside the checkout, like a shared config.
        yield* f.fs.symlink("../shared/config.json", f.path.join(f.repo, "config.json"));
        yield* f.run(f.repo, ["add", "config.json"]);
        yield* f.run(f.repo, ["commit", "-m", "shared config"]);
        yield* f.run(f.repo, ["push", "origin", "main"]);
        const dangling = yield* f.addWorktree("agent-dangling");
        const noReflog = yield* f.addWorktree("agent-no-reflog");
        const unreadable = yield* f.addWorktree("agent-unreadable");
        // utimes follows symlinks, so the links are put back after aging.
        const worktrees = [dangling, noReflog, unreadable];
        for (const worktree of worktrees) yield* f.fs.remove(f.path.join(worktree, "config.json"));
        yield* age(f, worktrees);
        const old = ((yield* Clock.currentTimeMillis) - 2 * DAY_MS) / 1000;
        for (const worktree of worktrees) {
          yield* f.fs.symlink("../shared/config.json", f.path.join(worktree, "config.json"));
          yield* f.fs.utimes(worktree, old, old);
        }
        const noReflogGitDir = (yield* f.run(noReflog, [
          "rev-parse",
          "--absolute-git-dir",
        ])).stdout.trim();
        yield* f.fs.remove(f.path.join(noReflogGitDir, "logs", "HEAD"));
        yield* f.fs.chmod(unreadable, 0o000);
        yield* f.sweep.pipe(Effect.ensuring(f.fs.chmod(unreadable, 0o755).pipe(Effect.ignore)));
        // Windows ignores these mode bits, so the folder there is readable and idle.
        const expected =
          process.platform === "win32" ? [dangling, noReflog, unreadable] : [dangling, noReflog];
        expect([...f.removed].sort()).toEqual(expected.sort());
        if (process.platform !== "win32") expect(yield* f.fs.exists(unreadable)).toBe(true);
      }).pipe(Effect.provide(cleanupLayer)),
  );

  EffectVitest.it.effect(
    "keeps worktrees that any stored thread or project records, deleted threads included",
    () =>
      Effect.gen(function* () {
        const f = yield* cleanupFixture;
        const unowned = yield* f.addWorktree("agent-unowned");
        // Rows only: the shell snapshot never lists these threads, so only the
        // orphan sweep's owner check can keep their folders.
        const owned: Array<string> = [];
        for (const [id, deletedAt, outbox] of [
          ["owned-open", null, null],
          ["owned-deleted-pending", "2026-06-09T12:00:00.000Z", "pending"],
          ["owned-deleted-settled", "2026-06-09T12:00:00.000Z", "succeeded"],
          ["owned-deleted-plain", "2026-06-09T12:00:00.000Z", null],
        ] as const) {
          const worktree = yield* f.addWorktree(id);
          owned.push(worktree);
          yield* f.sql`INSERT INTO orchestration_v2_projection_threads VALUES (${id}, ${JSON.stringify(
            { worktreePath: worktree, projectId: PROJECT_ID, title: id },
          )}, ${deletedAt}, NULL)`;
          if (outbox !== null)
            yield* f.sql`INSERT INTO orchestration_v2_effect_outbox VALUES (${id}, ${outbox})`;
        }
        const project = yield* f.addWorktree("owned-project");
        owned.push(project);
        yield* f.sql`INSERT INTO projection_projects VALUES (${f.path.join(project, "apps")}, NULL)`;
        yield* age(f, [unowned, ...owned]);
        yield* f.sweep;
        expect(f.removed).toEqual([unowned]);
        for (const kept of owned) expect(yield* f.fs.exists(kept)).toBe(true);
      }).pipe(Effect.provide(cleanupLayer)),
  );
});
