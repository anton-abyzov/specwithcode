/**
 * The repositories a thread holds: reading them for the thread's header, and
 * adding one while the thread runs. The agent (`studio_worktree_add_repository`)
 * and the person (the thread's "Add repository") go through the same add, so
 * its limits hold for both: at most 8 repositories, never on a low disk, no
 * dependency install and no setup script.
 *
 * @module ThreadRepositories
 */
import {
  formatStorageFreeSpace,
  THREAD_REPOSITORIES_MAX,
  type StorageStatus,
  type WorktreeSubmodules,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import { addThreadRepository, type SetRepositoryCheckout } from "../git/worktreeSetGit.ts";
import { readWorktreeSet, worktreeSetMemberPath, type WorktreeSetMember } from "../worktreeSet.ts";

/** What an agent is told about dependencies after an add. */
export const DEPENDENCIES_NOT_INSTALLED_NOTE =
  "Dependencies not installed. Run this repository's normal install in its worktree only when you build or test there; never link another checkout's node_modules.";

/** Folders whose presence means the worktree has its dependencies. */
const DEPENDENCY_FOLDERS = ["node_modules", ".venv", "venv", "vendor"];

export type ThreadRepositoryRefusal = {
  readonly code: "not_in_worktree" | "invalid_request" | "operation_failed";
  readonly message: string;
};

const refuse = (code: ThreadRepositoryRefusal["code"], message: string) =>
  Effect.fail({ code, message } satisfies ThreadRepositoryRefusal);

export const dependencyState = Effect.fn("ThreadRepositories.dependencies")(function* (
  worktree: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const folder of DEPENDENCY_FOLDERS)
    if (yield* fs.exists(path.join(worktree, folder)).pipe(Effect.orElseSucceed(() => false)))
      return "installed" as const;
  return "not_installed" as const;
});

/** The add is refused while the disk is under the app's low-space threshold. */
export function lowDiskRefusal(status: StorageStatus | null): string | null {
  if (status === null || status.level === "ok") return null;
  return `Only ${formatStorageFreeSpace(status.freeBytes)} is free on this machine's disk, under the app's low-space limit, so no worktree was added. Free space (Settings > Storage, or remove finished thread worktrees), then add the repository again.`;
}

/**
 * Adds `repository` to the thread's folder on the thread's branch. Returns the
 * member, where it sits, what it was cut from and its dependency state.
 */
export const addRepositoryToThread = Effect.fn("ThreadRepositories.add")(function* (input: {
  readonly threadId: string;
  readonly worktreePath: string | null;
  readonly branch: string | null;
  readonly usesWorktrees: boolean;
  readonly projectRoot: string;
  readonly checkouts: ReadonlyArray<SetRepositoryCheckout>;
  readonly repository: string;
  readonly startFromOrigin: boolean;
  readonly submodules: WorktreeSubmodules | null;
  readonly storage: StorageStatus | null;
  readonly addedBy: "agent" | "user";
}) {
  const path = yield* Path.Path;
  const { worktreePath, branch } = input;
  if (!input.usesWorktrees)
    return yield* refuse(
      worktreePath === null ? "not_in_worktree" : "invalid_request",
      "Use worktrees is off for this project, so a thread cannot add worktrees and works in the project folder. The user can turn on Use worktrees in the project's settings (in SpecWithCode, with the one-click button the thread shows).",
    );
  if (worktreePath === null || branch === null)
    return yield* refuse(
      "not_in_worktree",
      `Thread '${input.threadId}' works in the project folder, not in a folder of its own, so there is nothing to add a repository to. Move it into its own worktree with studio_worktree_handoff first, then add the repository.`,
    );
  const existing = yield* readWorktreeSet(worktreePath);
  const held = existing?.members ?? [];
  const low = lowDiskRefusal(input.storage);
  const added = yield* addThreadRepository({
    folder: worktreePath,
    existing: held,
    plain: existing === null,
    entry: input.repository,
    checkouts: input.checkouts,
    projectRoot: input.projectRoot,
    branch,
    startFromOrigin: input.startFromOrigin,
    submodules: input.submodules,
    limit: THREAD_REPOSITORIES_MAX,
    addedBy: input.addedBy,
    addedAt: DateTime.formatIso(yield* DateTime.now),
    // Checked after the repository is known to be new, so a repeat add still answers.
    refuseNew: low,
  }).pipe(
    // A cancel waits, so the manifest never lists a member that was not made.
    Effect.uninterruptible,
    Effect.catch((message) =>
      // "Could not ..." is git or the manifest failing, not a bad argument.
      refuse(message.startsWith("Could not") ? "operation_failed" : "invalid_request", message),
    ),
  );
  const repositoryPath = worktreeSetMemberPath(worktreePath, added.member, path);
  const dependencies = yield* dependencyState(repositoryPath);
  return {
    worktreePath,
    repositoryPath,
    branch,
    members: added.members.map((member) => ({
      repository: member.repository,
      path: worktreeSetMemberPath(worktreePath, member, path),
    })),
    ...(added.baseRef === null ? {} : { baseRef: added.baseRef }),
    dependencies,
    alreadyMember: added.alreadyMember,
    note: added.alreadyMember
      ? `This thread already has ${added.member.repository} at ${repositoryPath}; nothing was added.`
      : `Worktree at ${repositoryPath} on ${branch}${added.baseRef === null ? "" : `, cut from ${added.baseRef}`}. ${DEPENDENCIES_NOT_INSTALLED_NOTE}`,
  };
});

export interface ThreadRepositoryRow {
  readonly relativePath: string;
  readonly name: string;
  readonly path: string;
  readonly repository: string;
  readonly baseRef: string | null;
  readonly addedBy: "agent" | "user" | null;
  readonly addedAt: string | null;
  readonly dependencies: "installed" | "not_installed";
  readonly changed: boolean;
}

/**
 * What the thread's header shows: null for a thread in the project folder or in
 * a plain worktree, else its folder's repositories (none for a thread that
 * started in its own empty folder).
 */
export const readThreadRepositories = Effect.fn("ThreadRepositories.read")(function* (
  worktreePath: string | null,
) {
  if (worktreePath === null) return null;
  const path = yield* Path.Path;
  const git = yield* GitWorkflowService.GitWorkflowService;
  const set = yield* readWorktreeSet(worktreePath);
  if (set === null) return null;
  return yield* Effect.forEach(
    set.members as ReadonlyArray<WorktreeSetMember>,
    (member) =>
      Effect.gen(function* () {
        const worktree = worktreeSetMemberPath(worktreePath, member, path);
        const status = yield* git
          .localStatus({ cwd: worktree })
          .pipe(Effect.orElseSucceed(() => null));
        const branchChanges = status?.branchChanges;
        return {
          relativePath: member.relativePath.split(path.sep).join("/"),
          name: path.basename(member.repository),
          path: worktree,
          repository: member.repository,
          baseRef: member.baseRef ?? null,
          addedBy: member.addedBy ?? null,
          addedAt: member.addedAt ?? null,
          dependencies: yield* dependencyState(worktree),
          changed:
            status?.hasWorkingTreeChanges === true ||
            (branchChanges !== undefined && branchChanges.insertions + branchChanges.deletions > 0),
        } satisfies ThreadRepositoryRow;
      }),
    { concurrency: 4 },
  );
});
