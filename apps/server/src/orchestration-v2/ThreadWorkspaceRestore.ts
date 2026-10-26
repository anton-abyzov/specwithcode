/**
 * ThreadWorkspaceRestore - recreates a thread's deleted worktree folder from
 * its own branch, at the exact path the thread records.
 *
 * A folder removed outside the app (a manual or scripted cleanup) may belong
 * to a repository other than the project's: a thread launched in a nested or
 * sibling checkout keeps its worktree under `<worktrees>/<repo>/<slug>`. The
 * owning repository is found from the folders next to it, then the project
 * folder, then a sibling of the project folder named like the parent folder.
 * The folder is never recreated from another branch.
 *
 * @module ThreadWorkspaceRestore
 */
import {
  GitCommandError,
  type ThreadId,
  type VcsRestoreThreadWorkspaceInput,
  type VcsRestoreThreadWorkspaceResult,
} from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

/** Folders read next to the missing one; a worktrees folder can hold hundreds. */
const MAX_SIBLING_FOLDERS = 200;
const MAX_FAILURE_MESSAGE_LENGTH = 400;

const isGitCommandError = Schema.is(GitCommandError);

/**
 * GitWorkflowService routes each command to a VCS driver first; a folder with
 * no Git repository (a plain folder, or one that is gone) fails that routing
 * as `vcs-route` without a git `reason`.
 */
const isNotARepository = (error: unknown): boolean =>
  isGitCommandError(error) && error.command === "vcs-route";

/**
 * Runs `effect`, recovering from any failure (a missing file, a test double
 * without the method) with `fallback`; an interrupt keeps cancelling.
 */
const attemptOr = <A, B, E, R>(
  effect: () => Effect.Effect<A, E, R>,
  fallback: () => B,
): Effect.Effect<A | B, never, R> =>
  Effect.suspend(effect).pipe(
    Effect.exit,
    Effect.flatMap((exit) =>
      Exit.isSuccess(exit)
        ? Effect.succeed<A | B>(exit.value)
        : Cause.hasInterruptsOnly(exit.cause)
          ? Effect.interrupt
          : Effect.succeed<A | B>(fallback()),
    ),
  );

/**
 * The main repository that owns the checkout at `folder`: the folder itself
 * when its `.git` is a directory, else the common directory its `.git` file
 * points to. Undefined for anything else (a submodule, a plain folder, a
 * repository that is no longer there).
 */
const owningRepository = (folder: string) =>
  attemptOr(
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dotGit = path.join(folder, ".git");
        const info = yield* fileSystem.stat(dotGit);
        if (info.type === "Directory") return folder;
        if (info.type !== "File") return undefined;
        const pointer = /^gitdir:\s*(.+)$/mu
          .exec(yield* fileSystem.readFileString(dotGit))?.[1]
          ?.trim();
        if (!pointer) return undefined;
        const gitDir = path.resolve(folder, pointer);
        // git writes `commondir` into each linked worktree's admin folder.
        const commonPointer = yield* attemptOr(
          () => fileSystem.readFileString(path.join(gitDir, "commondir")),
          () => undefined,
        );
        const commonDir = commonPointer?.trim()
          ? path.resolve(gitDir, commonPointer.trim())
          : path.basename(path.dirname(gitDir)) === "worktrees"
            ? path.dirname(path.dirname(gitDir))
            : undefined;
        // A repository moved or deleted since leaves the pointer dangling.
        if (commonDir === undefined || !(yield* fileSystem.exists(commonDir))) return undefined;
        // A bare repository is its own common directory.
        return path.basename(commonDir) === ".git" ? path.dirname(commonDir) : commonDir;
      }),
    () => undefined,
  );

/**
 * Repositories that may own the missing folder at `worktreePath`, most likely
 * first, deduplicated by real path:
 * 1. the repository of the checkouts next to it, when they all share one;
 * 2. the project folder;
 * 3. the other repositories next to it, most common first (a shared
 *    worktrees folder holds checkouts of many repositories, so none of them
 *    outranks the project there);
 * 4. a folder next to the project folder named like the missing folder's
 *    parent (the `<worktrees>/<repo>/<slug>` layout), when it exists.
 */
export const worktreeRepositoryCandidates = Effect.fn(
  "ThreadWorkspaceRestore.worktreeRepositoryCandidates",
)(function* (input: { readonly worktreePath: string; readonly workspaceRoot: string }) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const parent = path.dirname(input.worktreePath);
  const ownName = path.basename(input.worktreePath);

  const siblingNames = yield* attemptOr(
    () => fileSystem.readDirectory(parent),
    (): ReadonlyArray<string> => [],
  );
  const counts = new Map<string, number>();
  for (const name of siblingNames.toSorted().slice(0, MAX_SIBLING_FOLDERS)) {
    if (name === ownName || name.startsWith(".")) continue;
    const repository = yield* owningRepository(path.join(parent, name));
    if (repository !== undefined) counts.set(repository, (counts.get(repository) ?? 0) + 1);
  }
  const siblingRepositories = [...counts.entries()]
    .toSorted((left, right) => right[1] - left[1])
    .map(([repository]) => repository);

  const namedSibling = path.join(path.dirname(input.workspaceRoot), path.basename(parent));
  const namedSiblingExists =
    namedSibling !== input.workspaceRoot &&
    (yield* attemptOr(
      () => fileSystem.exists(namedSibling),
      () => false,
    ));

  const ordered = [
    ...(siblingRepositories.length === 1 ? siblingRepositories : []),
    input.workspaceRoot,
    ...(siblingRepositories.length > 1 ? siblingRepositories : []),
    ...(namedSiblingExists ? [namedSibling] : []),
  ];
  const seen = new Set<string>();
  const candidates: Array<string> = [];
  for (const repository of ordered) {
    const realPath = yield* attemptOr(
      () => fileSystem.realPath(repository),
      () => repository,
    );
    if (seen.has(realPath)) continue;
    seen.add(realPath);
    candidates.push(repository);
  }
  return candidates as ReadonlyArray<string>;
});

export type MissingWorktreeRestore =
  | { readonly _tag: "Restored"; readonly repository: string }
  | {
      /** No candidate repository has the branch. */
      readonly _tag: "BranchMissing";
      /** Repositories that answered that the branch does not exist. */
      readonly checkedRepositories: ReadonlyArray<string>;
      /**
       * The folder is `<worktrees>/<repo>/<branch slug>` for one of those
       * repositories, so its branch really was deleted there.
       */
      readonly ownedFolder: boolean;
    }
  | { readonly _tag: "Failed"; readonly repository: string; readonly error: unknown };

/**
 * Prunes stale worktree entries and adds the worktree for `branch` at
 * `worktreePath`, trying each candidate repository in turn. A repository
 * without the branch (or one that is not a repository) moves on to the next;
 * any other failure ends the attempt, so a transient one (a git lock) keeps
 * the caller's retries.
 */
export const restoreMissingWorktree = Effect.fn("ThreadWorkspaceRestore.restoreMissingWorktree")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly worktreePath: string;
    readonly branch: string;
    readonly workspaceRoot: string;
  }): Effect.fn.Return<
    MissingWorktreeRestore,
    never,
    FileSystem.FileSystem | Path.Path | GitWorkflowService.GitWorkflowService
  > {
    const git = yield* GitWorkflowService.GitWorkflowService;
    const path = yield* Path.Path;
    const candidates = yield* worktreeRepositoryCandidates(input);
    const checkedRepositories: Array<string> = [];
    for (const repository of candidates) {
      const exit = yield* git.pruneWorktrees({ cwd: repository }).pipe(
        Effect.andThen(
          git.createWorktree({
            cwd: repository,
            refName: input.branch,
            path: input.worktreePath,
          }),
        ),
        Effect.exit,
      );
      if (Exit.isSuccess(exit)) {
        yield* Effect.logInfo("recreated missing worktree", {
          threadId: input.threadId,
          worktreePath: input.worktreePath,
          branch: input.branch,
          repository,
        });
        return { _tag: "Restored", repository };
      }
      if (Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.interrupt;
      yield* Effect.logWarning("failed to recreate missing worktree", {
        threadId: input.threadId,
        worktreePath: input.worktreePath,
        repository,
        cause: Cause.pretty(exit.cause),
      });
      const error = Cause.squash(exit.cause);
      const reason = isGitCommandError(error) ? error.reason : undefined;
      if (reason === "invalid_reference") {
        checkedRepositories.push(repository);
        continue;
      }
      if (reason === "not_a_repository" || isNotARepository(error)) continue;
      return { _tag: "Failed", repository, error };
    }
    const parentName = path.basename(path.dirname(input.worktreePath));
    const ownedFolder =
      path.basename(input.worktreePath) === input.branch.replace(/\//g, "-") &&
      checkedRepositories.some((repository) => path.basename(repository) === parentName);
    return { _tag: "BranchMissing", checkedRepositories, ownedFolder };
  },
);

function failureMessage(error: unknown): string {
  const detail =
    isGitCommandError(error) && error.detail.trim().length > 0
      ? error.detail.trim()
      : error instanceof Error
        ? error.message
        : "Git refused.";
  const clipped =
    detail.length > MAX_FAILURE_MESSAGE_LENGTH
      ? `${detail.slice(0, MAX_FAILURE_MESSAGE_LENGTH)}...`
      : detail;
  return `Could not recreate the folder. ${clipped}`;
}

export class ThreadWorkspaceRestore extends Context.Service<
  ThreadWorkspaceRestore,
  {
    /**
     * Recreates the thread's missing worktree folder from its branch. Never
     * fails: every outcome is a status with a sentence for the user.
     */
    readonly restore: (
      input: VcsRestoreThreadWorkspaceInput,
    ) => Effect.Effect<VcsRestoreThreadWorkspaceResult>;
  }
>()("specweave-studio/orchestration-v2/ThreadWorkspaceRestore") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectService.ProjectService;
  const context = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | GitWorkflowService.GitWorkflowService
  >();

  const restore: ThreadWorkspaceRestore["Service"]["restore"] = Effect.fn(
    "ThreadWorkspaceRestore.restore",
  )(function* (input) {
    yield* Effect.annotateCurrentSpan("threadId", input.threadId);
    const thread = yield* attemptOr(
      () => projections.getThread(input.threadId),
      () => undefined,
    );
    if (thread === undefined || thread.deletedAt !== null) {
      return { status: "not-restorable", message: "This thread was not found." } as const;
    }
    const { worktreePath, branch } = thread;
    if (worktreePath === null) {
      return {
        status: "not-restorable",
        message: "This thread runs in the project folder, so there is no folder to recreate.",
      } as const;
    }
    if (branch === null) {
      return {
        status: "not-restorable",
        message: "This thread has no branch to recreate its folder from.",
      } as const;
    }
    const alreadyPresent = {
      status: "already-present",
      worktreePath,
      message: "The thread folder is already there.",
    } as const;
    // A file at the path also counts as a missing folder; git can't add over it.
    const pathType = yield* attemptOr(
      () => fileSystem.stat(worktreePath).pipe(Effect.map((info) => info.type)),
      () => undefined,
    );
    if (pathType === "Directory") return alreadyPresent;
    if (pathType !== undefined) {
      return {
        status: "not-restorable",
        worktreePath,
        message: "Something else is at the thread folder's path. Move it, then try again.",
      } as const;
    }
    const project = yield* attemptOr(
      () => projects.getById(thread.projectId).pipe(Effect.map(Option.getOrUndefined)),
      () => undefined,
    );
    if (project === undefined) {
      return {
        status: "not-restorable",
        message: "This thread's project was not found.",
      } as const;
    }
    const outcome = yield* restoreMissingWorktree({
      threadId: thread.id,
      worktreePath,
      branch,
      workspaceRoot: project.workspaceRoot,
    }).pipe(Effect.provide(context));
    switch (outcome._tag) {
      case "Restored":
        return {
          status: "restored",
          repository: outcome.repository,
          worktreePath,
          message: `Folder restored from ${branch}.`,
        } as const;
      case "BranchMissing":
        return outcome.checkedRepositories.length > 0
          ? ({
              status: "branch-missing",
              worktreePath,
              message: `Branch ${branch} no longer exists, so the folder can't be recreated. Use the project folder or resolve the thread.`,
            } as const)
          : ({
              status: "failed",
              worktreePath,
              message: "No repository was found to recreate the folder from.",
            } as const);
      case "Failed": {
        // Another restore (a second click, another client, a turn start) may
        // have added the folder while this one ran; git then refuses here.
        const restoredMeanwhile = yield* attemptOr(
          () => fileSystem.stat(worktreePath).pipe(Effect.map((info) => info.type === "Directory")),
          () => false,
        );
        if (restoredMeanwhile) return alreadyPresent;
        return {
          status: "failed",
          repository: outcome.repository,
          worktreePath,
          message: failureMessage(outcome.error),
        } as const;
      }
    }
  });

  return ThreadWorkspaceRestore.of({ restore });
});

export const layer = Layer.effect(ThreadWorkspaceRestore, make);
