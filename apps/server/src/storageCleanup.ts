import { OrchestrationV2AppThreadJson } from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type {
  OrchestrationV2ThreadShell,
  ProjectId,
  ServerSettings,
  ServerSettingsError,
  TerminalSummary,
  WorktreeCleanupRules,
} from "@specweave-studio/contracts";
import { resolveWorktreeCleanup } from "@specweave-studio/shared/projectSettings";
import { makeDrainableWorker } from "@specweave-studio/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as ServerConfig from "./config.ts";
import { elapsedMs, newestFinite, olderThan } from "./failClosedAge.ts";
import * as GitManager from "./git/GitManager.ts";
import { worktreeHasNoAdditionalChanges } from "./git/worktreeIntegration.ts";
import {
  isOpenThreadOwner,
  listWorktreeBindings,
  pathSpellings,
  pathWithin,
  type WorktreeBindings,
  worktreeOwnersOf,
} from "./git/worktreeOwnership.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import { threadHasQueuedTurnStart } from "./orchestration-v2/ThreadSettlementService.ts";
import { forkParked } from "./serverActivation.ts";
import * as Settings from "./serverSettings.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import {
  linkedWorktreeGitDir,
  onlyDependencyIgnores,
  ORPHAN_SWEEP_INTERVAL_MS,
  ORPHAN_WORKTREE_IDLE_MS,
  orphanWorktreeRemovable,
} from "./orphanWorktrees.ts";
import {
  isFilesystemRoot,
  legacyStudioPathAlias,
  managedWorktreesDirectories,
  resolveWorktreesDirectory,
} from "./worktreesDirectory.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import { withWorkspaceLease } from "./workspace/workspaceLease.ts";

const decodeCleanupThread = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);

const DAY_MS = 86_400_000;

const worktreeCleanupEnabled = (rules: WorktreeCleanupRules) =>
  rules.worktreeAfterDays !== null ||
  rules.worktreeOnMerge ||
  rules.worktreeOnDelete ||
  rules.worktreeUnchanged;

function anyWorktreePolicy(
  settings: ServerSettings,
  predicate: (rules: WorktreeCleanupRules) => boolean,
): boolean {
  return (
    predicate(resolveWorktreeCleanup(settings, null)) ||
    Object.keys(settings.projectSettingsOverrides).some((projectId) =>
      predicate(resolveWorktreeCleanup(settings, projectId as ProjectId)),
    )
  );
}

function sameProjectWorktreePolicies(left: ServerSettings, right: ServerSettings): boolean {
  return [
    ...new Set([
      ...Object.keys(left.projectSettingsOverrides),
      ...Object.keys(right.projectSettingsOverrides),
    ]),
  ].every((projectId) =>
    Equal.equals(
      left.projectSettingsOverrides[projectId as ProjectId]?.worktreeCleanup,
      right.projectSettingsOverrides[projectId as ProjectId]?.worktreeCleanup,
    ),
  );
}

/** Live sessions keep their cwd even when no turn is currently running. */
export function storageCleanupThreadIdle(thread: OrchestrationV2ThreadShell, now: number): boolean {
  return (
    thread.branch !== null &&
    thread.worktreePath !== null &&
    thread.activeRunId === null &&
    (thread.status === "idle" || thread.status === "failed") &&
    (thread.pendingBackgroundTasks?.length ?? 0) === 0 &&
    thread.pendingRuntimeRequest === null &&
    !threadHasQueuedTurnStart(thread, now)
  );
}

/**
 * PR metadata refreshes must not reset the inactivity clock. Null when no
 * reading is known, which never counts as inactive.
 */
export function storageCleanupActivityAt(thread: OrchestrationV2ThreadShell): number | null {
  return newestFinite(
    [
      thread.createdAt,
      thread.latestUserMessageAt,
      thread.latestRunRequestedAt,
      thread.latestRunStartedAt,
      thread.latestRunCompletedAt,
    ].map((value) => (value == null ? null : DateTime.toEpochMillis(value))),
  );
}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* Settings.ServerSettingsService;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitManager = yield* GitManager.GitManager;
  const terminals = yield* TerminalManager.TerminalManager;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const services = yield* Effect.context<FileSystem.FileSystem | Path.Path | SqlClient.SqlClient>();
  const liveTerminals = new Map<string, Map<string, TerminalSummary>>();
  const noteTerminal = (terminal: TerminalSummary) => {
    const threadTerminals =
      liveTerminals.get(terminal.threadId) ?? new Map<string, TerminalSummary>();
    threadTerminals.set(terminal.terminalId, terminal);
    liveTerminals.set(terminal.threadId, threadTerminals);
  };

  const inside = (root: string, target: string) => {
    const relative = path.relative(root, target);
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  };

  const canonical = (value: string) => {
    const resolved = path.resolve(value);
    return fs.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved));
  };
  const hasTerminal = (worktreePath: string) =>
    [...liveTerminals.values()]
      .flatMap((entries) => [...entries.values()])
      .some((terminal) => {
        if (terminal.status !== "starting" && terminal.status !== "running") return false;
        const cwd = path.resolve(terminal.cwd);
        return (
          (terminal.worktreePath !== null &&
            path.resolve(terminal.worktreePath) === worktreePath) ||
          cwd === worktreePath ||
          inside(worktreePath, cwd)
        );
      });

  const readBindings = listWorktreeBindings.pipe(Effect.provideContext(services));
  /**
   * Open threads (not deleted, archived or resolved) using this folder, inside
   * it or around it. Their folders are never removed automatically: a thread
   * in a nested or sibling repository cannot always get its checkout back.
   */
  const openThreadOwners = (bindings: WorktreeBindings, worktreePath: string) =>
    // Owners hold canonical paths. Match the folder by its real path too, so a
    // symlinked parent (a linked drive, /var on macOS) cannot hide them.
    pathSpellings(worktreePath).pipe(
      Effect.flatMap((spellings) =>
        worktreeOwnersOf(bindings, spellings, { match: "overlapping" }),
      ),
      Effect.map((owners) => owners.threads.filter(isOpenThreadOwner)),
      Effect.provideContext(services),
    );
  const skipOpenThreadFolder = Effect.fn("StorageCleanup.skipOpenThreadFolder")(function* (
    bindings: WorktreeBindings,
    worktreePath: string,
    threadId: string,
  ) {
    const open = yield* openThreadOwners(bindings, worktreePath);
    if (open.length === 0) return false;
    yield* Effect.logDebug("storage cleanup kept worktree of an open thread", {
      threadId,
      worktreePath,
      openThreadIds: open.map((owner) => owner.threadId),
    });
    return true;
  });

  /** Running sessions and terminals in this folder, inside it or around it, by real path. */
  const liveUsers = (bindings: WorktreeBindings, worktreePath: string) =>
    pathSpellings(worktreePath).pipe(
      Effect.flatMap((spellings) =>
        worktreeOwnersOf(bindings, spellings, {
          match: "overlapping",
          terminals: [...liveTerminals.values()].flatMap((entries) => [...entries.values()]),
        }),
      ),
      Effect.map((owners) => owners.sessions.length > 0 || owners.terminals.length > 0),
      Effect.provideContext(services),
    );

  const readThreads = Effect.fn("StorageCleanup.readThreads")(function* () {
    const active = yield* projections.getShellSnapshot();
    const archived = yield* projections.getShellSnapshot({ location: "archive" });
    const projects = yield* projectStore.listShells();
    return { projects, threads: [...active.threads, ...archived.threads] };
  });

  // Local threads under another project need not have a worktreePath of their own.
  const containsProjectRoot = Effect.fn("StorageCleanup.containsProjectRoot")(function* (
    worktreePath: string,
    projects: ReadonlyArray<{ readonly workspaceRoot: string }>,
  ) {
    for (const project of projects) {
      const projectPath = path.resolve(project.workspaceRoot);
      if (projectPath === worktreePath || inside(worktreePath, projectPath)) return true;
      const realPath = yield* fs
        .realPath(projectPath)
        .pipe(Effect.orElseSucceed(() => projectPath));
      if (realPath === worktreePath || inside(worktreePath, realPath)) return true;
    }
    return false;
  });

  const cleanWorktrees = Effect.fn("StorageCleanup.cleanWorktrees")(function* (
    serverSettings: ServerSettings,
    now: number,
  ) {
    if (!anyWorktreePolicy(serverSettings, worktreeCleanupEnabled)) return;
    const roots: Array<string> = [];
    for (const directory of managedWorktreesDirectories(
      serverSettings,
      config.worktreesDir,
      path,
    )) {
      // An unmounted drive only skips its own worktrees.
      const root = yield* fs.exists(directory).pipe(
        Effect.flatMap((exists) => (exists ? fs.realPath(directory) : Effect.succeed(null))),
        Effect.orElseSucceed(() => null),
      );
      if (root !== null && !isFilesystemRoot(root, path)) roots.push(root);
    }
    if (roots.length === 0) return;
    const hasDeleteRule = anyWorktreePolicy(serverSettings, (rules) => rules.worktreeOnDelete);
    const deletedRows = hasDeleteRule
      ? yield* sql<{ payload_json: string; workspaceRoot: string }>`
          SELECT t.payload_json, p.workspace_root AS "workspaceRoot"
          FROM orchestration_v2_projection_threads t
          JOIN projection_projects p ON p.project_id = t.project_id
          WHERE t.deleted_at IS NOT NULL
        `
      : [];
    const deletedThreads = (yield* Effect.forEach(deletedRows, (row) =>
      decodeCleanupThread(row.payload_json).pipe(
        Effect.map((thread) => ({ ...thread, workspaceRoot: row.workspaceRoot })),
      ),
    )).filter(
      (thread) =>
        thread.worktreePath !== null &&
        thread.branch !== null &&
        resolveWorktreeCleanup(serverSettings, thread.projectId).worktreeOnDelete,
    );
    const snapshot = yield* readThreads();
    // Unreadable ownership skips the whole sweep: never remove on a guess.
    const bindings = yield* readBindings;
    const refreshedDefaultRefs = new Map<string, Set<string>>();
    const groups = Map.groupBy(
      snapshot.threads.filter((thread) => thread.worktreePath !== null),
      (thread) => path.resolve(thread.worktreePath!),
    );
    const candidates = [
      ...[...groups.values()].flatMap((group) => (group.length === 1 ? [group[0]!] : [])),
      ...deletedThreads.filter((thread) => !groups.has(path.resolve(thread.worktreePath!))),
    ];
    for (const thread of candidates) {
      const settings = resolveWorktreeCleanup(serverSettings, thread.projectId);
      if (!worktreeCleanupEnabled(settings)) continue;
      const worktreePath = path.resolve(thread.worktreePath!);
      const deleted = "workspaceRoot" in thread;
      const project = deleted
        ? { workspaceRoot: thread.workspaceRoot }
        : snapshot.projects.find((entry) => entry.id === thread.projectId);
      if (
        project === undefined ||
        (!deleted && !storageCleanupThreadIdle(thread, now)) ||
        hasTerminal(worktreePath)
      )
        continue;
      yield* Effect.gen(function* () {
        if (yield* skipOpenThreadFolder(bindings, worktreePath, thread.id)) return;
        if (yield* liveUsers(bindings, worktreePath)) return;
        if (!(yield* fs.exists(worktreePath))) return;
        // Roots are canonical, so compare canonical paths. A symlinked parent
        // (a linked drive) is fine; a symlinked worktree directory is not.
        const realPath = yield* fs.realPath(worktreePath);
        const realParent = yield* fs.realPath(path.dirname(worktreePath));
        if (realPath !== path.join(realParent, path.basename(worktreePath))) return;
        if (!roots.some((root) => inside(root, realPath))) return;
        if (yield* containsProjectRoot(worktreePath, [project, ...snapshot.projects])) return;
        // A linked worktree has a .git file. Never remove a main checkout.
        if ((yield* fs.stat(path.join(worktreePath, ".git"))).type !== "File") return;
        const status = yield* git.statusDetailsLocal(worktreePath);
        if (!status.isRepo || status.branch !== thread.branch || status.hasWorkingTreeChanges)
          return;
        const head = yield* git.resolveCommit({ cwd: worktreePath, revision: "HEAD" });
        const ignored = yield* git.execute({
          operation: "StorageCleanup.ignoredFiles",
          cwd: worktreePath,
          args: ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
          maxOutputBytes: 64 * 1024,
        });
        // Ignored files can contain secrets or local datasets. Dependency installs
        // are reproducible; every other ignored path prevents automatic removal.
        if (
          ignored.stdoutTruncated ||
          ignored.stdout
            .split("\0")
            .some((entry) => entry !== "" && !/(^|\/)node_modules\/$/.test(entry))
        )
          return;
        // status.showUntrackedFiles=no hides new files from the status check.
        if (!(yield* untrackedNone(worktreePath))) return;
        const old =
          !deleted &&
          settings.worktreeAfterDays !== null &&
          olderThan(storageCleanupActivityAt(thread), settings.worktreeAfterDays * DAY_MS, now);
        let eligible = deleted || old;
        if (!eligible && (settings.worktreeUnchanged || settings.worktreeOnMerge)) {
          const repositoryCwd = path.resolve(project.workspaceRoot);
          const remote = yield* git.resolvePrimaryRemoteName(repositoryCwd);
          const branch = yield* git.resolveDefaultBranchName(repositoryCwd, remote);
          if (branch === null) return;
          const defaultRef = `refs/remotes/${remote}/${branch}`;
          const refreshed = refreshedDefaultRefs.get(repositoryCwd) ?? new Set<string>();
          if (!refreshed.has(defaultRef)) {
            yield* git.fetchRemoteTrackingBranch({
              cwd: repositoryCwd,
              remoteName: remote,
              remoteBranch: branch,
            });
            refreshed.add(defaultRef);
            refreshedDefaultRefs.set(repositoryCwd, refreshed);
          }
          const base = yield* git.resolveCommit({
            cwd: worktreePath,
            revision: defaultRef,
          });
          const ancestor = yield* git.execute({
            operation: "StorageCleanup.integratedBranch",
            cwd: worktreePath,
            args: ["merge-base", "--is-ancestor", head.commitSha, base.commitSha],
            allowNonZeroExit: true,
          });
          if (ancestor.exitCode !== 0 && ancestor.exitCode !== 1) return;
          eligible = ancestor.exitCode === 0 && settings.worktreeUnchanged;
          if (!eligible && settings.worktreeOnMerge && thread.branch !== null) {
            const pullRequest = yield* gitManager.branchPullRequest(
              { cwd: worktreePath, branch: thread.branch },
              { refresh: true },
            );
            eligible =
              pullRequest?.state === "merged" &&
              (ancestor.exitCode === 0 ||
                (yield* worktreeHasNoAdditionalChanges(
                  git,
                  worktreePath,
                  head.commitSha,
                  base.commitSha,
                )));
          }
        }
        if (!eligible) return;
        // Re-read after Git/host calls so a queued turn, resumed session or new
        // thread sharing this path cancels the removal.
        const latestSnapshot = yield* readThreads();
        if (yield* containsProjectRoot(worktreePath, [project, ...latestSnapshot.projects])) return;
        const latest = latestSnapshot.threads.filter(
          (entry) =>
            entry.worktreePath !== null && path.resolve(entry.worktreePath) === worktreePath,
        );
        if (hasTerminal(worktreePath)) return;
        if (deleted) {
          if (
            latest.length > 0 ||
            !resolveWorktreeCleanup(yield* settingsService.getSettings, thread.projectId)
              .worktreeOnDelete
          )
            return;
          // V2 deletion queues durable cleanup. Do not remove its checkout until
          // every effect has finished successfully or was explicitly cancelled.
          const pendingCleanup = yield* sql`
            SELECT 1 FROM orchestration_v2_effect_outbox
            WHERE thread_id = ${thread.id} AND status NOT IN ('succeeded', 'cancelled') LIMIT 1
          `;
          if (pendingCleanup.length > 0) return;
        } else if (
          latest.length !== 1 ||
          latest[0]!.id !== thread.id ||
          !storageCleanupThreadIdle(latest[0]!, now) ||
          storageCleanupActivityAt(latest[0]!) !== storageCleanupActivityAt(thread)
        )
          return;
        const finalStatus = yield* git.statusDetailsLocal(worktreePath);
        if (
          !finalStatus.isRepo ||
          finalStatus.branch !== thread.branch ||
          finalStatus.hasWorkingTreeChanges
        )
          return;
        if (
          (yield* git.resolveCommit({ cwd: worktreePath, revision: "HEAD" })).commitSha !==
          head.commitSha
        )
          return;
        const finalIgnored = yield* git.execute({
          operation: "StorageCleanup.ignoredFiles",
          cwd: worktreePath,
          args: ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
          maxOutputBytes: 64 * 1024,
        });
        if (
          finalIgnored.stdoutTruncated ||
          finalIgnored.stdout
            .split("\0")
            .some((entry) => entry !== "" && !/(^|\/)node_modules\/$/.test(entry))
        )
          return;
        if (!(yield* untrackedNone(worktreePath))) return;
        const current = resolveWorktreeCleanup(
          yield* settingsService.getSettings,
          thread.projectId,
        );
        if (
          Object.keys(settings).some(
            (key) =>
              current[key as keyof typeof settings] !== settings[key as keyof typeof settings],
          )
        )
          return;
        // A thread may have been reopened or bound to this folder meanwhile, and
        // sessions can outlive their run and be shared across app threads.
        const latestBindings = yield* readBindings;
        if (yield* skipOpenThreadFolder(latestBindings, worktreePath, thread.id)) return;
        if (yield* liveUsers(latestBindings, worktreePath)) return;
        yield* git.removeWorktree({ cwd: project.workspaceRoot, path: worktreePath, force: false });
        yield* gitManager.invalidateStatus(project.workspaceRoot);
        // Only settled, archived or deleted threads get here. Preserve branch and
        // path: ProviderTurnStartService recreates the checkout on resume.
        yield* Effect.logInfo("storage cleanup removed worktree", { threadId: thread.id });
      }).pipe(
        (effect) => withWorkspaceLease(worktreePath, effect),
        Effect.catch((error) =>
          Effect.logDebug("storage cleanup skipped worktree", { threadId: thread.id, error }),
        ),
      );
    }
  });

  const ignoredOnlyDependencies = (cwd: string) =>
    git
      .execute({
        operation: "StorageCleanup.ignoredFiles",
        cwd,
        args: ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
        maxOutputBytes: 64 * 1024,
      })
      .pipe(
        Effect.map((result) => !result.stdoutTruncated && onlyDependencyIgnores(result.stdout)),
      );

  // A live terminal or provider session in the folder, compared by real path:
  // candidates are canonical, recorded cwds may be a symlinked spelling.
  // Untracked files, whatever status.showUntrackedFiles says: `git status` and
  // `git worktree remove` both honor that setting and would delete them unseen.
  const untrackedNone = (cwd: string) =>
    git
      .execute({
        operation: "StorageCleanup.orphanUntracked",
        cwd,
        args: ["ls-files", "--others", "--exclude-standard", "--directory", "-z"],
        maxOutputBytes: 4096,
      })
      .pipe(Effect.map((result) => !result.stdoutTruncated && result.stdout === ""));

  // Commits the worktree's own HEAD reflog reaches that no remote or local branch
  // holds: removing the worktree deletes that reflog, and with it the only reference.
  const reflogOnlyCommits = Effect.fn("StorageCleanup.reflogOnlyCommits")(function* (cwd: string) {
    const reflog = yield* git.execute({
      operation: "StorageCleanup.orphanReflog",
      cwd,
      args: ["log", "-g", "--format=%H", "HEAD"],
      maxOutputBytes: 4 * 1024 * 1024,
    });
    if (reflog.stdoutTruncated) return Number.POSITIVE_INFINITY;
    const commits = [...new Set(reflog.stdout.split("\n").filter((line) => line !== ""))];
    if (commits.length === 0) return 0;
    const count = yield* git.execute({
      operation: "StorageCleanup.orphanReflogUnreached",
      cwd,
      args: ["rev-list", "--count", ...commits, "--not", "--remotes", "--branches"],
      maxOutputBytes: 1024,
    });
    const value = Number.parseInt(count.stdout.trim(), 10);
    return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
  });

  // Any owner keeps an orphan candidate: a thread in any state, session or live
  // terminal using the folder, inside it or around it, or a project rooted in it.
  const orphanOwned = Effect.fn("StorageCleanup.orphanOwned")(function* (worktreePath: string) {
    const bindings = yield* readBindings;
    // Every stored thread, deleted ones included even after their cleanup
    // settled: worktreeOnDelete decides those folders, never this sweep. Read
    // without decoding, so a payload of another shape still keeps its folder.
    const recorded = yield* sql<{ worktreePath: unknown }>`
      SELECT json_extract(payload_json, '$.worktreePath') AS "worktreePath"
      FROM orchestration_v2_projection_threads
      WHERE json_extract(payload_json, '$.worktreePath') IS NOT NULL
    `;
    return yield* Effect.gen(function* () {
      const spellings = yield* pathSpellings(worktreePath);
      for (const row of recorded) {
        if (typeof row.worktreePath !== "string") continue;
        for (const spelling of yield* pathSpellings(row.worktreePath))
          if (
            spellings.some(
              (target) => pathWithin(path, target, spelling) || pathWithin(path, spelling, target),
            )
          )
            return true;
      }
      const users = yield* worktreeOwnersOf(bindings, spellings, {
        match: "overlapping",
        terminals: [...liveTerminals.values()].flatMap((entries) => [...entries.values()]),
      });
      // Projects only from inside: worktree roots may sit within a project folder.
      const projects = yield* worktreeOwnersOf(bindings, spellings, { match: "within" });
      return (
        users.threads.length > 0 ||
        users.sessions.length > 0 ||
        users.terminals.length > 0 ||
        projects.projects.length > 0
      );
    }).pipe(Effect.provideContext(services));
  });

  // Newest of the folder, its top-level entries (dependencies aside) and its
  // HEAD and reflog: a checkout, commit or new file all count as activity.
  // Null when the folder or its HEAD can't be read, so an unreadable folder is
  // never idle. A missing reflog or top-level entry has no reading: stat follows
  // symlinks, so a dangling `.env -> ../shared/.env` reads as NotFound.
  const lastActivityAt = Effect.fn("StorageCleanup.lastActivityAt")(function* (
    worktreePath: string,
    gitDir: string,
  ) {
    const names = yield* fs.readDirectory(worktreePath).pipe(Effect.option);
    if (Option.isNone(names)) return null;
    const head = path.join(gitDir, "HEAD");
    const reflog = path.join(gitDir, "logs", "HEAD");
    const targets = [
      worktreePath,
      head,
      reflog,
      ...names.value
        .filter((name) => name !== "node_modules" && name !== ".git")
        .map((name) => path.join(worktreePath, name)),
    ];
    let newest: number | null = null;
    for (const target of targets) {
      const stat = yield* fs.stat(target).pipe(Effect.result);
      if (Result.isFailure(stat)) {
        const required = target === worktreePath || target === head;
        if (!required && stat.failure.reason._tag === "NotFound") continue;
        return null;
      }
      const modified = Option.getOrNull(stat.success.mtime)?.getTime() ?? null;
      if (modified === null || !Number.isFinite(modified)) return null;
      newest = newest === null ? modified : Math.max(newest, modified);
    }
    return newest;
  });

  // Worktrees agents made without a thread, under the managed worktree folders
  // and Scratch: direct children, or one level down in a per-project folder.
  const orphanWorktreeCandidates = Effect.fn("StorageCleanup.orphanWorktreeCandidates")(function* (
    roots: ReadonlyArray<string>,
  ) {
    const found: Array<{ readonly worktreePath: string; readonly gitDir: string }> = [];
    const visit = Effect.fn("StorageCleanup.visitOrphanWorktrees")(function* (
      directory: string,
      depth: number,
    ): Effect.fn.Return<void, PlatformError> {
      for (const name of yield* fs.readDirectory(directory)) {
        const target = path.join(directory, name);
        const stat = yield* fs.stat(target).pipe(Effect.option);
        if (Option.isNone(stat) || stat.value.type !== "Directory") continue;
        // Roots are canonical; a symlinked folder is never followed.
        if ((yield* fs.realPath(target).pipe(Effect.orElseSucceed(() => null))) !== target)
          continue;
        const dotGit = path.join(target, ".git");
        const dotGitStat = yield* fs.stat(dotGit).pipe(Effect.option);
        if (Option.isSome(dotGitStat)) {
          // A linked worktree has a .git file. Never touch a main checkout.
          if (dotGitStat.value.type !== "File") continue;
          const gitDir = linkedWorktreeGitDir(
            yield* fs.readFileString(dotGit).pipe(Effect.orElseSucceed(() => "")),
          );
          if (gitDir !== null)
            found.push({ worktreePath: target, gitDir: path.resolve(target, gitDir) });
        } else if (depth === 0) {
          yield* visit(target, 1).pipe(Effect.orElseSucceed(() => undefined));
        }
      }
    });
    for (const root of roots) yield* visit(root, 0).pipe(Effect.orElseSucceed(() => undefined));
    return found;
  });

  let lastOrphanSweepAt = Number.NEGATIVE_INFINITY;
  const cleanOrphanWorktrees = Effect.fn("StorageCleanup.cleanOrphanWorktrees")(function* (
    serverSettings: ServerSettings,
    now: number,
  ) {
    if (!anyWorktreePolicy(serverSettings, (rules) => rules.worktreeOnMerge)) return;
    // Hourly at most: each candidate can cost a pull request lookup.
    if (now - lastOrphanSweepAt < ORPHAN_SWEEP_INTERVAL_MS) return;
    lastOrphanSweepAt = now;
    // Another instance on this base dir (a dev server) shares its worktree and
    // Scratch folders but records its threads in its own database, so their
    // folders would look unowned here: sweep only when this is the only one.
    for (const name of yield* fs
      .readDirectory(config.baseDir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))) {
      if (path.join(config.baseDir, name) === path.resolve(config.stateDir)) continue;
      const database = path.join(config.baseDir, name, "statev2.sqlite");
      const found = yield* fs.stat(database).pipe(
        Effect.map(() => true),
        Effect.orElseSucceed(() => false),
      );
      if (found) {
        yield* Effect.logInfo("storage cleanup skipped orphan worktrees: another instance", {
          database,
        });
        return;
      }
    }
    // The current folders only: earlier worktree settings may name a general code
    // folder that holds worktrees made by hand or by other tools.
    const current = resolveWorktreesDirectory(
      serverSettings.worktreesDirectory,
      config.worktreesDir,
      path,
    );
    const roots: Array<string> = [];
    for (const directory of [
      config.worktreesDir,
      legacyStudioPathAlias(config.worktreesDir, path),
      current,
      path.resolve(config.baseDir, "scratch"),
    ]) {
      if (directory === null) continue;
      const root = yield* fs.exists(directory).pipe(
        Effect.flatMap((exists) => (exists ? fs.realPath(directory) : Effect.succeed(null))),
        Effect.orElseSucceed(() => null),
      );
      if (root !== null && !isFilesystemRoot(root, path) && !roots.includes(root)) roots.push(root);
    }
    if (roots.length === 0) return;
    const candidates = yield* orphanWorktreeCandidates(roots);
    if (candidates.length === 0) return;
    const { projects } = yield* readThreads();
    const refreshedDefaultRefs = new Set<string>();
    for (const { worktreePath, gitDir } of candidates) {
      yield* Effect.gen(function* () {
        if (yield* orphanOwned(worktreePath)) return;
        if (!olderThan(yield* lastActivityAt(worktreePath, gitDir), ORPHAN_WORKTREE_IDLE_MS, now))
          return;
        const status = yield* git.statusDetailsLocal(worktreePath);
        if (!status.isRepo || status.hasWorkingTreeChanges) return;
        if (!(yield* untrackedNone(worktreePath))) return;
        if (!(yield* ignoredOnlyDependencies(worktreePath))) return;
        if ((yield* reflogOnlyCommits(worktreePath)) > 0) return;
        const commonDir = yield* git.execute({
          operation: "StorageCleanup.orphanCommonDir",
          cwd: worktreePath,
          args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          maxOutputBytes: 4096,
        });
        const common = path.resolve(commonDir.stdout.trim());
        if (path.basename(common) !== ".git") return;
        const mainCheckout = path.dirname(common);
        const mainReal = yield* fs
          .realPath(mainCheckout)
          .pipe(Effect.orElseSucceed(() => mainCheckout));
        // Every project on this repo, on a folder inside it, or holding it (an
        // umbrella) must allow it; with none, the global rule decides.
        const projectIds: Array<ProjectId> = [];
        for (const project of projects) {
          const projectReal = yield* canonical(project.workspaceRoot);
          if (
            projectReal === mainReal ||
            inside(projectReal, mainReal) ||
            inside(mainReal, projectReal)
          )
            projectIds.push(project.id);
        }
        const allowed = (settings: ServerSettings) =>
          projectIds.length === 0
            ? resolveWorktreeCleanup(settings, null).worktreeOnMerge
            : projectIds.every((id) => resolveWorktreeCleanup(settings, id).worktreeOnMerge);
        if (!allowed(serverSettings)) return;
        const head = yield* git.resolveCommit({ cwd: worktreePath, revision: "HEAD" });
        const unpushed = yield* git.execute({
          operation: "StorageCleanup.orphanUnpushed",
          cwd: worktreePath,
          args: ["rev-list", "--count", "HEAD", "--not", "--remotes"],
          maxOutputBytes: 1024,
        });
        const unpushedCommits = Number.parseInt(unpushed.stdout.trim(), 10);
        if (!Number.isFinite(unpushedCommits)) return;
        const pullRequest =
          status.branch === null
            ? null
            : yield* gitManager.branchPullRequest({ cwd: worktreePath, branch: status.branch });
        let integratedInDefault = false;
        if (pullRequest?.state === "merged" && unpushedCommits > 0) {
          const remote = yield* git.resolvePrimaryRemoteName(mainCheckout);
          const branch = yield* git.resolveDefaultBranchName(mainCheckout, remote);
          if (branch === null) return;
          const defaultRef = `refs/remotes/${remote}/${branch}`;
          if (!refreshedDefaultRefs.has(`${mainReal}\0${defaultRef}`)) {
            yield* git.fetchRemoteTrackingBranch({
              cwd: mainCheckout,
              remoteName: remote,
              remoteBranch: branch,
            });
            refreshedDefaultRefs.add(`${mainReal}\0${defaultRef}`);
          }
          const base = yield* git.resolveCommit({ cwd: worktreePath, revision: defaultRef });
          const ancestor = yield* git.execute({
            operation: "StorageCleanup.integratedBranch",
            cwd: worktreePath,
            args: ["merge-base", "--is-ancestor", head.commitSha, base.commitSha],
            allowNonZeroExit: true,
          });
          if (ancestor.exitCode !== 0 && ancestor.exitCode !== 1) return;
          integratedInDefault =
            ancestor.exitCode === 0 ||
            (yield* worktreeHasNoAdditionalChanges(
              git,
              worktreePath,
              head.commitSha,
              base.commitSha,
            ));
        }
        const idleMs = elapsedMs(yield* lastActivityAt(worktreePath, gitDir), now);
        if (idleMs === null) return;
        if (
          !orphanWorktreeRemovable({
            branch: status.branch,
            hasWorkingTreeChanges: status.hasWorkingTreeChanges,
            onlyDependencyIgnores: true,
            unpushedCommits,
            pullRequestState: pullRequest?.state ?? null,
            integratedInDefault,
            idleMs,
          })
        )
          return;
        // Re-check after Git/host calls: any new change or commit cancels the removal.
        const finalStatus = yield* git.statusDetailsLocal(worktreePath);
        if (
          !finalStatus.isRepo ||
          finalStatus.hasWorkingTreeChanges ||
          finalStatus.branch !== status.branch
        )
          return;
        if (
          (yield* git.resolveCommit({ cwd: worktreePath, revision: "HEAD" })).commitSha !==
          head.commitSha
        )
          return;
        if (!(yield* untrackedNone(worktreePath))) return;
        if (!(yield* ignoredOnlyDependencies(worktreePath))) return;
        if ((yield* reflogOnlyCommits(worktreePath)) > 0) return;
        if (!allowed(yield* settingsService.getSettings)) return;
        // Owners last, right before removal: a thread, project, terminal or session
        // that moved in meanwhile keeps the folder.
        if (yield* orphanOwned(worktreePath)) return;
        yield* git.removeWorktree({ cwd: mainCheckout, path: worktreePath, force: false });
        yield* gitManager.invalidateStatus(mainCheckout);
        // The branch ref stays, so the work can be checked out again.
        yield* Effect.logInfo("storage cleanup removed orphan worktree", {
          worktreePath,
          branch: status.branch,
          pullRequest: pullRequest?.state ?? null,
        });
      }).pipe(
        (effect) => withWorkspaceLease(worktreePath, effect),
        Effect.catch((error) =>
          Effect.logDebug("storage cleanup skipped orphan worktree", { worktreePath, error }),
        ),
      );
    }
  });

  const cleanFiles = Effect.fn("StorageCleanup.cleanFiles")(function* (
    root: string,
    days: number | null,
    now: number,
    rotatedLogs: boolean,
  ) {
    if (days === null || !(yield* fs.exists(root))) return;
    const realRoot = yield* fs.realPath(root);
    if (realRoot !== path.resolve(root)) return;
    const visit = Effect.fn("StorageCleanup.visitFiles")(function* (
      directory: string,
    ): Effect.fn.Return<void, PlatformError | ServerSettingsError> {
      for (const name of yield* fs.readDirectory(directory)) {
        const target = path.join(directory, name);
        if ((yield* fs.realPath(target)) !== target || !inside(realRoot, target)) continue;
        const stat = yield* fs.stat(target);
        if (stat.type === "Directory" && rotatedLogs) {
          yield* visit(target);
        } else if (stat.type === "File" && (!rotatedLogs || /\.(?:log|ndjson)\.\d+$/.test(name))) {
          const modified = Option.getOrNull(stat.mtime);
          if (modified !== null && modified.getTime() < now - days * DAY_MS) {
            const current = (yield* settingsService.getSettings).storageCleanup;
            if ((rotatedLogs ? current.logsAfterDays : current.browserArtifactsAfterDays) !== days)
              return;
            yield* fs.remove(target);
          }
        }
      }
    });
    yield* visit(realRoot);
  });

  const sweep = Effect.fn("StorageCleanup.sweep")(function* () {
    const serverSettings = yield* settingsService.getSettings;
    const settings = serverSettings.storageCleanup;
    const now = yield* Clock.currentTimeMillis;
    yield* cleanWorktrees(serverSettings, now).pipe(
      Effect.catch((error) => Effect.logWarning("worktree cleanup failed", { error })),
    );
    yield* cleanOrphanWorktrees(serverSettings, now).pipe(
      Effect.catch((error) => Effect.logWarning("orphan worktree cleanup failed", { error })),
    );
    yield* cleanFiles(
      config.browserArtifactsDir,
      settings.browserArtifactsAfterDays,
      now,
      false,
    ).pipe(
      Effect.catch((error) => Effect.logWarning("browser artifact cleanup failed", { error })),
    );
    yield* cleanFiles(config.logsDir, settings.logsAfterDays, now, true).pipe(
      Effect.catch((error) => Effect.logWarning("rotated log cleanup failed", { error })),
    );
  });
  const worker = yield* makeDrainableWorker(() =>
    sweep().pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) => Effect.logWarning("storage cleanup failed", { cause }),
      ),
    ),
  );

  const start = Effect.fn("StorageCleanup.start")(function* () {
    const unsubscribe = yield* terminals.subscribeMetadata((event) =>
      Effect.sync(() => {
        if (event.type === "snapshot") {
          liveTerminals.clear();
          for (const terminal of event.terminals) noteTerminal(terminal);
        } else if (event.type === "upsert") {
          noteTerminal(event.terminal);
        } else {
          const threadTerminals = liveTerminals.get(event.threadId);
          threadTerminals?.delete(event.terminalId);
          if (threadTerminals?.size === 0) liveTerminals.delete(event.threadId);
        }
      }),
    );
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
    const changes = yield* settingsService.subscribeChanges;
    const events = engine.streamDomainEvents;
    let lastSettings = yield* settingsService.getSettings.pipe(Effect.orDie);
    yield* forkParked(
      worker
        .enqueue(undefined)
        .pipe(
          Effect.andThen(worker.drain),
          Effect.repeat(Schedule.spaced("1 hour")),
          Effect.asVoid,
        ),
    );
    yield* forkParked(
      Stream.runForEach(changes, (settings) => {
        if (
          Equal.equals(settings.storageCleanup, lastSettings.storageCleanup) &&
          Equal.equals(settings.worktreeCleanup, lastSettings.worktreeCleanup) &&
          sameProjectWorktreePolicies(settings, lastSettings)
        )
          return Effect.void;
        lastSettings = settings;
        return worker.enqueue(undefined);
      }),
    );
    yield* forkParked(
      Stream.runForEach(events, (event) =>
        (event.type === "thread.deleted" || event.type === "provider-session.updated") &&
        anyWorktreePolicy(lastSettings, (rules) => rules.worktreeOnDelete)
          ? worker.enqueue(undefined)
          : Effect.void,
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Storage cleanup event stream failed", { cause }),
        ),
      ),
    );
  });
  return {
    start,
    drain: worker.drain,
    /** Runs one sweep now and waits for it to finish. */
    runOnce: worker.enqueue(undefined).pipe(Effect.andThen(worker.drain)),
  };
});
