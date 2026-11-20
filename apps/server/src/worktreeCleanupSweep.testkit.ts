/**
 * The shared fixture of the worktree sweep tests: real repositories with a
 * local origin, chats in the shell snapshot and the ownership tables, and a
 * Git driver that records every call the sweep makes.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type ServerSettings,
  type StorageCleanupPlanItem,
  type TerminalSummary,
  type VcsCreateWorktreeInput,
} from "@specweave-studio/contracts";
import * as NodeSqliteClient from "@specweave-studio/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ServerConfig from "./config.ts";
import * as GitManager from "./git/GitManager.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as Settings from "./serverSettings.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import {
  makeWorktreeCleanupSweep,
  WorktreeSweepProcessCwds,
  type WorktreeSweepMode,
} from "./worktreeCleanupSweep.ts";

export const NOW_MS = Date.parse("2026-06-10T12:00:00.000Z");
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
export const PROJECT_ID = ProjectId.make("project-1");
export const OFF_PROJECT_ID = ProjectId.make("project-off");

/** A member's own path from the path it was set aside at for removal. */
export const fromAside = (target: string) =>
  target.replace(/\/\.([^/]+)\.retiring-\d{8}-\d{6}$/, "/$1");

export const at = (offsetMs: number) => DateTime.makeUnsafe(NOW_MS + offsetMs);

export function shell(
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    projectId: PROJECT_ID,
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

const driverLayer = GitVcsDriver.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "studio-sweep-test-" })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

// Worktree sets are made and restored the way chats make them.
const gitWorkflowLayer = GitWorkflowService.layer.pipe(
  Layer.provide(
    VcsDriverRegistry.layer.pipe(
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "studio-sweep-set-" })),
      Layer.provide(VcsProcess.layer),
    ),
  ),
  Layer.provide(
    Layer.effect(
      GitManager.GitManager,
      Effect.map(GitVcsDriver.GitVcsDriver, (git) =>
        GitManager.GitManager.of({
          createWorktree: (input: VcsCreateWorktreeInput) => git.createWorktree(input),
          localStatus: (input: { cwd: string }) =>
            git
              .statusDetailsLocal(input.cwd)
              .pipe(Effect.map((status) => ({ refName: status.branch }))),
        } as unknown as GitManager.GitManager["Service"]),
      ),
    ),
  ),
  Layer.provide(
    Layer.mock(TerminalManager.TerminalManager)({
      subscribeMetadata: (listener) =>
        listener({ type: "snapshot", terminals: [] }).pipe(Effect.as(() => {})),
    }),
  ),
);

export const testLayer = Layer.provideMerge(gitWorkflowLayer, driverLayer);

export type ChatState = "open" | "settled" | "archived";

export const baseSettings: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  storageCleanup: {
    ...DEFAULT_SERVER_SETTINGS.storageCleanup,
    worktreeAfterDays: null,
    worktreeOnMerge: true,
    worktreeOnDelete: false,
    worktreeUnchanged: false,
    removeResolvedWorktrees: true,
  },
};

/**
 * Real repositories with a local origin, chat worktrees under the managed
 * worktrees folder, and chats written to the shell snapshot and to the
 * ownership tables, as the projections keep them. Every Git call the sweep
 * makes is recorded with its folder.
 */
export const sweepFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const config = yield* ServerConfig.ServerConfig;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "studio-sweep-" }));
  const run = (cwd: string, args: ReadonlyArray<string>) =>
    git.execute({ operation: "test", cwd, args });
  const makeRepo = Effect.fn("test.makeRepo")(function* (name: string) {
    const origin = path.join(root, `${path.basename(name)}-origin.git`);
    const repo = path.join(root, name);
    yield* run(root, ["init", "--bare", "-b", "main", origin]);
    yield* fs.makeDirectory(repo, { recursive: true });
    yield* run(repo, ["init", "-b", "main"]);
    yield* run(repo, ["config", "user.name", "Sweep test"]);
    yield* run(repo, ["config", "user.email", "test@example.invalid"]);
    yield* fs.writeFileString(path.join(repo, "file.txt"), `${name}\n`);
    yield* run(repo, ["add", "."]);
    yield* run(repo, ["commit", "-m", "fixture"]);
    yield* run(repo, ["remote", "add", "origin", origin]);
    yield* run(repo, ["push", "origin", "main"]);
    yield* run(repo, ["remote", "set-head", "origin", "main"]);
    return repo;
  });
  const repo = yield* makeRepo("repo");
  yield* sql`CREATE TABLE projection_projects (workspace_root TEXT, deleted_at TEXT)`;
  yield* sql`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, payload_json TEXT, deleted_at TEXT, archived_at TEXT)`;
  yield* sql`CREATE TABLE orchestration_v2_effect_outbox (thread_id TEXT, status TEXT)`;
  yield* sql`CREATE TABLE orchestration_v2_projection_provider_sessions (payload_json TEXT, status TEXT, thread_id TEXT)`;
  yield* sql`CREATE TABLE orchestration_v2_projection_runs (thread_id TEXT, status TEXT)`;
  yield* sql`INSERT INTO projection_projects VALUES (${repo}, NULL)`;
  const worktreesRoot = yield* fs.realPath(config.worktreesDir);
  const addWorktree = (branch: string) =>
    Effect.gen(function* () {
      const worktree = path.join(worktreesRoot, "repo", branch);
      yield* run(repo, ["worktree", "add", "-b", branch, worktree]);
      return worktree;
    });
  const commit = Effect.fn("test.commit")(function* (worktree: string, file: string) {
    yield* fs.writeFileString(path.join(worktree, file), "work\n");
    yield* run(worktree, ["add", file]);
    yield* run(worktree, ["commit", "-m", file]);
  });

  const threads: Array<OrchestrationV2ThreadShell> = [];
  const addChat = Effect.fn("test.addChat")(function* (input: {
    readonly id: string;
    readonly folder: string;
    readonly branch: string | null;
    readonly state: ChatState;
    readonly parent?: string;
    /** The parent is the chat it was forked from, not the one that started it. */
    readonly fork?: boolean;
    readonly projectId?: ProjectId;
    /** A row in the runs table, as the projection keeps a run in progress. */
    readonly run?: string;
    readonly shell?: Partial<OrchestrationV2ThreadShell>;
  }) {
    const projectId = input.projectId ?? PROJECT_ID;
    const thread = shell({
      id: ThreadId.make(input.id),
      projectId,
      title: input.id,
      branch: input.branch as OrchestrationV2ThreadShell["branch"],
      worktreePath: input.folder,
      lineage: {
        rootThreadId: ThreadId.make(input.parent ?? input.id),
        parentThreadId: input.parent === undefined ? null : ThreadId.make(input.parent),
        relationshipToParent:
          input.parent === undefined ? null : input.fork === true ? "fork" : "subagent",
      },
      ...(input.state === "settled" ? { settledOverride: "settled", settledAt: at(-DAY_MS) } : {}),
      ...(input.state === "archived" ? { archivedAt: at(-DAY_MS) } : {}),
      ...input.shell,
    });
    threads.push(thread);
    const archivedAt = input.state === "archived" ? "2026-06-09T12:00:00.000Z" : null;
    // The row is a fixture of the stored shape; tests write it as plain JSON.
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES (${input.id}, ${JSON.stringify(
      {
        worktreePath: input.folder,
        projectId,
        title: input.id,
        settledOverride: thread.settledOverride,
        archivedAt,
        lineage: {
          parentThreadId: input.parent ?? null,
          relationshipToParent:
            input.parent === undefined ? null : input.fork === true ? "fork" : "subagent",
        },
      },
    )}, NULL, ${archivedAt})`;
    if (input.run !== undefined)
      yield* sql`INSERT INTO orchestration_v2_projection_runs VALUES (${input.id}, ${input.run})`;
  });

  /** Replaces fields of a chat's shell, as a later projection would. */
  const setShell = (id: string, overrides: Partial<OrchestrationV2ThreadShell>) => {
    const index = threads.findIndex((thread) => thread.id === id);
    if (index >= 0) threads[index] = { ...threads[index]!, ...overrides };
  };

  const removed: Array<string> = [];
  /** Every input the sweep passed to `removeWorktree`. */
  const removeCalls: Array<Parameters<GitVcsDriver.GitVcsDriver["Service"]["removeWorktree"]>[0]> =
    [];
  /** The folder of every Git call the sweep made. */
  const touched: Array<string> = [];
  /** The name of every Git driver method the sweep called, in order. */
  const gitCalls: Array<string> = [];
  const hooks = {
    settings: baseSettings,
    /** null is "no pull request"; "error" is a host that gave no answer. */
    pullRequest: (_branch: string): "open" | "closed" | "merged" | "error" | null => "merged",
    /** "system" reads this machine's processes, as the service does. */
    processCwds: [] as ReadonlyArray<string> | null | "system",
    terminals: [] as ReadonlyArray<TerminalSummary>,
    /**
     * Runs on every settings read. The sweep reads settings only when it looks
     * again under the lease and before each member removal, so a test changes
     * the folder at an exact step through it.
     */
    onSettingsRead: (): Effect.Effect<void> => Effect.void,
  };
  const recordingGit = Object.fromEntries(
    Object.entries(git).map(([key, value]) => [
      key,
      typeof value === "function"
        ? (...args: ReadonlyArray<unknown>) => {
            const first = args[0];
            const cwd =
              typeof first === "string"
                ? first
                : typeof first === "object" && first !== null && "cwd" in first
                  ? String(first.cwd)
                  : "";
            touched.push(cwd);
            gitCalls.push(key);
            if (key === "removeWorktree") {
              // Recorded by the member's own path: the sweep removes it from where it was set aside.
              removed.push(fromAside(String((first as { readonly path: string }).path)));
              removeCalls.push(first as (typeof removeCalls)[number]);
            }
            return (value as (...input: ReadonlyArray<unknown>) => unknown)(...args);
          }
        : value,
    ]),
  ) as unknown as GitVcsDriver.GitVcsDriver["Service"];

  const withSweepServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(Settings.ServerSettingsService)({
            getSettings: Effect.suspend(() => hooks.onSettingsRead()).pipe(
              Effect.map(() => hooks.settings),
            ),
            subscribeChanges: Effect.succeed(Stream.never),
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            listShells: () =>
              Effect.succeed([
                { id: PROJECT_ID, workspaceRoot: repo },
                { id: OFF_PROJECT_ID, workspaceRoot: repo },
              ] as never),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getShellSnapshot: (options) =>
              Effect.succeed({
                schemaVersion: 1,
                snapshotSequence: 0,
                // As the store answers: archived chats come under `archivedThreads`.
                threads:
                  options?.location === "archive"
                    ? []
                    : threads.filter((thread) => thread.archivedAt === null),
                archivedThreads: threads.filter((thread) => thread.archivedAt !== null),
              }),
          }),
          Layer.mock(GitManager.GitManager)({
            branchPullRequest: (input) =>
              Effect.suspend(() => {
                const state = hooks.pullRequest(input.branch);
                return state === "error"
                  ? Effect.fail(new Error("The host gave no answer.") as never)
                  : Effect.succeed((state === null ? null : { state }) as never);
              }),
            invalidateStatus: () => Effect.void,
          }),
        ),
      ),
      Effect.provideService(GitVcsDriver.GitVcsDriver, recordingGit),
      (provided) => {
        const cwds = hooks.processCwds;
        return cwds === "system"
          ? provided
          : provided.pipe(Effect.provideService(WorktreeSweepProcessCwds, Effect.succeed(cwds)));
      },
    );
  /** One sweep from a new instance, as each test needs it. */
  const sweep = (mode: WorktreeSweepMode) =>
    withSweepServices(
      Effect.gen(function* () {
        const run = yield* makeWorktreeCleanupSweep({ liveTerminals: () => hooks.terminals });
        return yield* run(mode, hooks.settings, yield* Clock.currentTimeMillis);
      }),
    );
  /** One instance for several sweeps, as the service keeps it. */
  const sweeper = withSweepServices(
    Effect.gen(function* () {
      const run = yield* makeWorktreeCleanupSweep({ liveTerminals: () => hooks.terminals });
      return (mode: WorktreeSweepMode) =>
        Effect.gen(function* () {
          return yield* run(mode, hooks.settings, yield* Clock.currentTimeMillis);
        });
    }),
  );
  const itemOf = (items: ReadonlyArray<StorageCleanupPlanItem>, folder: string) =>
    items.find((item) => item.path === folder);
  const reasons = (items: ReadonlyArray<StorageCleanupPlanItem>, folders: ReadonlyArray<string>) =>
    folders.map((folder) => {
      const item = itemOf(items, folder);
      return item === undefined ? "missing" : `${item.action}:${item.reason}`;
    });
  return {
    fs,
    path,
    sql,
    config,
    root,
    repo,
    run,
    makeRepo,
    worktreesRoot,
    addWorktree,
    commit,
    addChat,
    setShell,
    removed,
    removeCalls,
    touched,
    gitCalls,
    hooks,
    sweep,
    sweeper,
    itemOf,
    reasons,
  };
});

/** Each test gets its own database and folders. */
export const sweepTest = <A, E>(
  name: string,
  test: () => Effect.Effect<A, E, Layer.Success<typeof testLayer> | Scope.Scope>,
) => it.effect(name, () => test().pipe(Effect.provide(testLayer)));
