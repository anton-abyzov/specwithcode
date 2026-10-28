/**
 * A project's worktrees around its deletion: what each holds before the
 * person confirms, and the guarded removal they confirmed afterwards.
 *
 * Only folders the project's threads recorded are candidates, and only ones
 * inside the managed worktree folders. Removal goes through the same guard as
 * `vcs.removeWorktree`, so ownership, symlink and linked-worktree checks always
 * apply; the person's confirmation only lifts the uncommitted-files refusal for
 * the paths they named. Branches are never deleted.
 */
import {
  type ProjectId,
  type ProjectWorktree,
  type ProjectWorktrees,
  ProjectWorktreesError,
  type ProjectWorktreesRemoval,
  type ProjectWorktreesRemoveInput,
} from "@specweave-studio/contracts";
import { isHostWindows } from "@specweave-studio/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import {
  listWorktreeBindings,
  type WorktreeBindings,
  worktreeOwnersOf,
} from "../git/worktreeOwnership.ts";
import { onlyDependencyIgnores } from "../orphanWorktrees.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Settings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { isFilesystemRoot, managedWorktreesDirectories } from "../worktreesDirectory.ts";

const decodeThreadWorktree = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      worktreePath: Schema.NullOr(Schema.String),
      branch: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
);

const isProjectWorktreesError = Schema.is(ProjectWorktreesError);

const SIZE_TIMEOUT = "20 seconds";

/** Disk use in bytes from `du -sk`, or null when it is unavailable or too slow. */
export const measureDirectoryBytes = Effect.fn("ProjectWorktreeCleanup.measureDirectoryBytes")(
  function* (runner: ProcessRunner.ProcessRunner["Service"], directory: string) {
    if (yield* isHostWindows) return null;
    const output = yield* runner
      .run({
        command: "du",
        args: ["-sk", directory],
        timeout: SIZE_TIMEOUT,
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: 64 * 1024,
        outputMode: "truncate",
      })
      .pipe(Effect.orElseSucceed(() => null));
    // du exits non-zero for one unreadable file but still prints the total.
    if (output === null || output.timedOut) return null;
    const kib = Number.parseInt(output.stdout.trim().split(/\s+/)[0] ?? "", 10);
    return Number.isSafeInteger(kib) && kib >= 0 ? kib * 1024 : null;
  },
);

interface Candidate {
  /** As the threads recorded it, resolved. */
  readonly path: string;
  readonly branch: string | null;
  readonly threadIds: ReadonlyArray<string>;
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* Settings.ServerSettingsService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const runner = yield* ProcessRunner.make();
  const services = yield* Effect.context<FileSystem.FileSystem | Path.Path | SqlClient.SqlClient>();

  const fail = (message: string) => new ProjectWorktreesError({ message });

  const inside = (root: string, target: string) => {
    const relative = path.relative(root, target);
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  };

  /** The project's own folder, or a folder holding it, is never a worktree to remove. */
  const holdsProjectFolder = (projectRoot: string, target: string) =>
    target === projectRoot || inside(target, projectRoot);

  const realProjectRoot = (workspaceRoot: string) =>
    fs.realPath(workspaceRoot).pipe(Effect.orElseSucceed(() => path.resolve(workspaceRoot)));

  const readProject = Effect.fn("ProjectWorktreeCleanup.readProject")(function* (
    projectId: ProjectId,
  ) {
    const rows = yield* sql<{ workspaceRoot: string; deletedAt: string | null }>`
      SELECT workspace_root AS "workspaceRoot", deleted_at AS "deletedAt"
      FROM projection_projects WHERE project_id = ${projectId}
    `;
    const row = rows[0];
    if (row === undefined) return yield* fail("This project was not found.");
    return row;
  });

  /** Every folder the project's threads recorded, deleted threads included. */
  const readCandidates = Effect.fn("ProjectWorktreeCleanup.readCandidates")(function* (
    projectId: ProjectId,
  ) {
    const rows = yield* sql<{ threadId: string; payload: string }>`
      SELECT thread_id AS "threadId", payload_json AS "payload"
      FROM orchestration_v2_projection_threads WHERE project_id = ${projectId}
    `;
    const groups = new Map<string, { branch: string | null; threadIds: Array<string> }>();
    for (const row of rows) {
      const thread = yield* decodeThreadWorktree(row.payload).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (thread === null || thread.worktreePath === null) continue;
      const key = path.resolve(thread.worktreePath);
      const group = groups.get(key) ?? { branch: thread.branch ?? null, threadIds: [] };
      group.threadIds.push(row.threadId);
      groups.set(key, group);
    }
    return [...groups].map(([key, group]): Candidate => ({
      path: key,
      branch: group.branch,
      threadIds: group.threadIds,
    }));
  });

  const readManagedRoots = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings;
    const roots: Array<string> = [];
    for (const directory of managedWorktreesDirectories(settings, config.worktreesDir, path)) {
      const root = yield* fs.realPath(directory).pipe(Effect.orElseSucceed(() => null));
      if (root !== null && !isFilesystemRoot(root, path)) roots.push(root);
    }
    return roots;
  });

  const gitLines = (cwd: string, operation: string, args: ReadonlyArray<string>) =>
    git.execute({ operation, cwd, args: [...args], maxOutputBytes: 64 * 1024 });

  const inspect = Effect.fn("ProjectWorktreeCleanup.inspect")(function* (
    candidate: Candidate,
    roots: ReadonlyArray<string>,
    bindings: WorktreeBindings,
    projectRoot: string,
  ) {
    const base = {
      path: candidate.path,
      branch: candidate.branch,
      threadCount: candidate.threadIds.length,
      sizeBytes: null,
      localCommits: null,
    };
    const keep = (status: "in_use" | "not_removable", detail: string): ProjectWorktree => ({
      ...base,
      status,
      detail,
    });

    const realPath = yield* fs.realPath(candidate.path);
    const realParent = yield* fs.realPath(path.dirname(candidate.path));
    if (realPath !== path.join(realParent, path.basename(candidate.path)))
      return keep("not_removable", "The folder is a symbolic link, so it is kept.");
    if (holdsProjectFolder(projectRoot, realPath))
      return keep("not_removable", "It holds the project folder, so it is kept.");
    if (!roots.some((root) => inside(root, realPath)))
      return keep(
        "not_removable",
        "It is outside the worktrees folder, so it is kept. Remove it yourself if you no longer need it.",
      );
    if ((yield* fs.stat(path.join(realPath, ".git"))).type !== "File")
      return keep("not_removable", "It is a main checkout, not a worktree, so it is kept.");

    const own = new Set(candidate.threadIds);
    const owners = yield* worktreeOwnersOf(bindings, realPath, { match: "within" }).pipe(
      Effect.provideContext(services),
    );
    if (owners.projects.length > 0)
      return keep("in_use", "Another project's folder is inside it, so it is kept.");
    const otherThread = owners.threads.find(
      (thread) => !thread.deleted && !own.has(thread.threadId),
    );
    if (otherThread !== undefined)
      return keep(
        "in_use",
        `The thread "${otherThread.title ?? otherThread.threadId}" in another project uses it, so it is kept.`,
      );
    if (owners.sessions.some((session) => session.threadId === null || !own.has(session.threadId)))
      return keep("in_use", "An agent session outside this project uses it, so it is kept.");

    const status = yield* git.statusDetailsLocal(realPath);
    if (!status.isRepo || status.branch === null)
      return keep(
        "not_removable",
        "No branch is checked out, so removing it could lose commits. It is kept.",
      );
    const ignored = yield* gitLines(realPath, "ProjectWorktreeCleanup.ignoredFiles", [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "-z",
    ]);
    const untracked = yield* gitLines(realPath, "ProjectWorktreeCleanup.untrackedFiles", [
      "ls-files",
      "--others",
      "--exclude-standard",
      "--directory",
      "-z",
    ]);
    const hasLocalChanges =
      status.hasWorkingTreeChanges ||
      untracked.stdoutTruncated ||
      untracked.stdout !== "" ||
      ignored.stdoutTruncated ||
      !onlyDependencyIgnores(ignored.stdout);
    const ahead = yield* git
      .execute({
        operation: "ProjectWorktreeCleanup.localCommits",
        cwd: realPath,
        args: ["rev-list", "--count", "HEAD", "--not", "--remotes"],
        allowNonZeroExit: true,
        maxOutputBytes: 1024,
      })
      .pipe(Effect.orElseSucceed(() => null));
    const localCommits =
      ahead === null || ahead.exitCode !== 0 ? null : Number.parseInt(ahead.stdout.trim(), 10) || 0;
    const sizeBytes = yield* measureDirectoryBytes(runner, realPath);
    return {
      ...base,
      branch: status.branch,
      sizeBytes,
      localCommits,
      status: hasLocalChanges ? "local_changes" : "removable",
      detail: hasLocalChanges
        ? "It has uncommitted, untracked or ignored files. Removing it deletes them."
        : null,
    } satisfies ProjectWorktree;
  });

  const read = Effect.fn("ProjectWorktreeCleanup.read")(function* (input: {
    readonly projectId: ProjectId;
  }) {
    const project = yield* readProject(input.projectId);
    const candidates = yield* readCandidates(input.projectId);
    const existing = yield* Effect.filter(candidates, (candidate) =>
      fs.exists(candidate.path).pipe(Effect.orElseSucceed(() => false)),
    );
    if (existing.length === 0) return { projectId: input.projectId, worktrees: [] };
    const roots = yield* readManagedRoots;
    const bindings = yield* listWorktreeBindings.pipe(Effect.provideContext(services));
    const projectRoot = yield* realProjectRoot(project.workspaceRoot);
    const worktrees = yield* Effect.forEach(
      existing,
      (candidate) =>
        inspect(candidate, roots, bindings, projectRoot).pipe(
          Effect.catch((error) =>
            Effect.logDebug("project worktree inspection failed", {
              path: candidate.path,
              error,
            }).pipe(
              Effect.as({
                path: candidate.path,
                branch: candidate.branch,
                threadCount: candidate.threadIds.length,
                sizeBytes: null,
                localCommits: null,
                status: "not_removable",
                detail: "It could not be inspected, so it is kept.",
              } satisfies ProjectWorktree),
            ),
          ),
        ),
      { concurrency: 4 },
    );
    return {
      projectId: input.projectId,
      worktrees: [...worktrees].sort(
        (left, right) => (right.sizeBytes ?? 0) - (left.sizeBytes ?? 0),
      ),
    } satisfies ProjectWorktrees;
  });

  const remove = Effect.fn("ProjectWorktreeCleanup.remove")(function* (
    input: ProjectWorktreesRemoveInput,
  ) {
    const project = yield* readProject(input.projectId);
    // Live threads may still be bound; only a deleted project's folders are released.
    if (project.deletedAt === null)
      return yield* fail("Delete the project before removing its worktrees.");
    const candidates = new Map(
      (yield* readCandidates(input.projectId)).map((candidate) => [candidate.path, candidate]),
    );
    const discard = new Set(input.discardLocalChanges.map((entry) => path.resolve(entry)));
    const roots = yield* readManagedRoots;
    const projectRoot = yield* realProjectRoot(project.workspaceRoot);
    const removed: Array<string> = [];
    const kept: Array<{ path: string; reason: string }> = [];
    // One at a time: Git serializes worktree changes per repository anyway.
    for (const requested of new Set(input.paths.map((entry) => path.resolve(entry)))) {
      if (!candidates.has(requested)) {
        kept.push({ path: requested, reason: "It is not a worktree of this project." });
        continue;
      }
      if (!(yield* fs.exists(requested).pipe(Effect.orElseSucceed(() => true)))) {
        removed.push(requested);
        continue;
      }
      const realPath = yield* fs.realPath(requested).pipe(Effect.orElseSucceed(() => null));
      if (realPath === null || !roots.some((root) => inside(root, realPath))) {
        kept.push({ path: requested, reason: "It is outside the worktrees folder." });
        continue;
      }
      if (holdsProjectFolder(projectRoot, realPath)) {
        kept.push({ path: requested, reason: "It holds the project folder." });
        continue;
      }
      const outcome = yield* gitWorkflow
        .removeWorktree(
          { cwd: project.workspaceRoot, path: requested },
          { projectDeletion: { discardLocalChanges: discard.has(requested) } },
        )
        .pipe(
          Effect.as(null),
          Effect.catch((error) =>
            Effect.succeed(
              "detail" in error && typeof error.detail === "string"
                ? error.detail
                : "It could not be removed.",
            ),
          ),
        );
      if (outcome === null) removed.push(requested);
      else kept.push({ path: requested, reason: outcome });
    }
    yield* Effect.logInfo("project worktrees removed", {
      projectId: input.projectId,
      removed: removed.length,
      kept: kept.length,
      discardedLocalChanges: removed.filter((entry) => discard.has(entry)).length,
    });
    return { projectId: input.projectId, removed, kept } satisfies ProjectWorktreesRemoval;
  });

  // Storage, settings and filesystem failures reach the client as one readable error.
  const readable =
    (message: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isProjectWorktreesError(cause) ? cause : new ProjectWorktreesError({ message }),
        ),
      );

  return {
    read: (input: { readonly projectId: ProjectId }) =>
      read(input).pipe(readable("The project's worktrees could not be read.")),
    remove: (input: ProjectWorktreesRemoveInput) =>
      remove(input).pipe(readable("The project's worktrees could not be removed.")),
  };
});
