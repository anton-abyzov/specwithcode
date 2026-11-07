/**
 * Git operations on a worktree set (../worktreeSet.ts): resolving the
 * repositories a launch names, creating every member on one branch, and
 * removing or recreating the members as one unit.
 *
 * @module worktreeSetGit
 */
import type { WorktreeSubmodules } from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  planWorktreeSet,
  removeWorktreeSetManifest,
  worktreeSetManifestPath,
  worktreeSetMemberPath,
  writeWorktreeSet,
  type WorktreeSetMember,
} from "../worktreeSet.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import type { WorktreeRemovalContext } from "./worktreeRemovalSafety.ts";

/** A project environment repository's checkout (ThreadLaunchService.projectRepositoryCheckouts). */
export interface SetRepositoryCheckout {
  readonly id: string;
  readonly path: string;
}

/**
 * Each named repository as a set member. An entry is an environment
 * repository id, else a path relative to the project root that must stay
 * inside it, and must be a repository's own checkout (a `.git` there), never a
 * folder inside one. Fails with a sentence naming the bad entry.
 */
export const resolveWorktreeSetRepositories = Effect.fn("worktreeSet.resolveRepositories")(
  function* (
    projectRoot: string,
    checkouts: ReadonlyArray<SetRepositoryCheckout>,
    entries: ReadonlyArray<string>,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const git = yield* GitWorkflowService.GitWorkflowService;
    const root = path.resolve(projectRoot);
    const resolved: Array<{ path: string; id?: string }> = [];
    for (const entry of entries) {
      const byId = checkouts.find((checkout) => checkout.id === entry);
      let repository: string;
      let id: string | undefined;
      if (byId !== undefined) {
        repository = path.resolve(byId.path);
        id = byId.id;
      } else {
        if (path.isAbsolute(entry))
          return yield* Effect.fail(
            `Repository "${entry}" must be an environment repository id or a path relative to the project root.`,
          );
        repository = path.resolve(root, entry);
        const relative = path.relative(root, repository);
        if (relative.startsWith("..") || path.isAbsolute(relative))
          return yield* Effect.fail(
            `Repository "${entry}" is outside the project folder; add it to the project's environment repositories and name it by id.`,
          );
        id = checkouts.find((checkout) => path.resolve(checkout.path) === repository)?.id;
      }
      const hasOwnGit = yield* fs
        .exists(path.join(repository, ".git"))
        .pipe(Effect.orElseSucceed(() => false));
      const isRepository =
        hasOwnGit && (yield* git.isRepository(repository).pipe(Effect.orElseSucceed(() => false)));
      if (!isRepository)
        return yield* Effect.fail(`Repository "${entry}" has no git checkout at ${repository}.`);
      resolved.push({ path: repository, ...(id === undefined ? {} : { id }) });
    }
    const rootEntries = yield* fs
      .readDirectory(root)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    return planWorktreeSet(root, resolved, path, rootEntries);
  },
);

/** The branch to start a member from: the launch's base for the project root, else its own. */
const memberBase = Effect.fn("worktreeSet.memberBase")(function* (
  member: WorktreeSetMember,
  projectRoot: string,
  rootBaseRef: string,
) {
  const path = yield* Path.Path;
  const git = yield* GitWorkflowService.GitWorkflowService;
  if (path.resolve(member.repository) === path.resolve(projectRoot)) return rootBaseRef;
  const current = yield* git.localStatus({ cwd: member.repository }).pipe(
    Effect.map((status) => status.refName),
    Effect.orElseSucceed(() => null),
  );
  return current ?? "HEAD";
});

/** Start from origin's copy of the base branch when asked and it is there; else the local one. */
const memberStart = Effect.fn("worktreeSet.memberStart")(function* (
  cwd: string,
  base: string,
  startFromOrigin: boolean,
) {
  const git = yield* GitWorkflowService.GitWorkflowService;
  if (!startFromOrigin || base === "HEAD") return base;
  const hasOrigin = yield* git
    .remoteExists({ cwd, remoteName: "origin" })
    .pipe(Effect.orElseSucceed(() => false));
  if (!hasOrigin) return base;
  yield* git
    .fetchRemote({ cwd, remoteName: "origin", refName: base })
    .pipe(Effect.orElseSucceed(() => undefined));
  const remote = yield* git
    .remoteBranchExists({ cwd, remoteName: "origin", refName: base })
    .pipe(Effect.orElseSucceed(() => false));
  if (!remote) return base;
  return yield* git
    .resolveRemoteTrackingCommit({ cwd, refName: base, fallbackRemoteName: "origin" })
    .pipe(
      Effect.map((resolved) => resolved.commitSha),
      Effect.orElseSucceed(() => base),
    );
});

/** The root repository's exclude file, or null when it has no `.git` folder of its own. */
const rootExcludeFile = Effect.fn("worktreeSet.rootExclude")(function* (
  members: ReadonlyArray<WorktreeSetMember>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const rootMember = members.find((member) => member.relativePath === "");
  if (rootMember === undefined) return null;
  const gitDir = path.join(rootMember.repository, ".git");
  const isDirectory = yield* fs.stat(gitDir).pipe(
    Effect.map((info) => info.type === "Directory"),
    Effect.orElseSucceed(() => false),
  );
  return isDirectory ? path.join(gitDir, "info", "exclude") : null;
});

const excludeTag = (folder: string) => `# SpecWithCode worktree set ${folder}`;

/**
 * Keeps nested members out of the root member's status: they sit inside its
 * worktree, so its repository ignores them locally (`info/exclude`, shared by
 * its checkouts). Each rule follows a comment naming the set, so removing the
 * set removes exactly its own rules. Best effort.
 */
const excludeNestedMembers = Effect.fn("worktreeSet.excludeNested")(function* (
  folder: string,
  members: ReadonlyArray<WorktreeSetMember>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exclude = yield* rootExcludeFile(members);
  if (exclude === null) return;
  yield* Effect.gen(function* () {
    const contents = (yield* fs.exists(exclude)) ? yield* fs.readFileString(exclude) : "";
    const lines = members
      .filter((member) => member.relativePath !== "")
      .map((member) => `${excludeTag(folder)}\n/${member.relativePath.split(path.sep).join("/")}/`)
      .filter((pair) => !`\n${contents}`.includes(`\n${pair}\n`));
    if (lines.length === 0) return;
    yield* fs.makeDirectory(path.dirname(exclude), { recursive: true });
    const prefix = contents === "" || contents.endsWith("\n") ? contents : `${contents}\n`;
    yield* fs.writeFileString(exclude, `${prefix}${lines.join("\n")}\n`);
  }).pipe(Effect.ignore);
});

/** Removes the rules `excludeNestedMembers` wrote for `folder`. Best effort. */
const removeNestedExcludes = Effect.fn("worktreeSet.removeExcludes")(function* (
  folder: string,
  members: ReadonlyArray<WorktreeSetMember>,
) {
  const fs = yield* FileSystem.FileSystem;
  const exclude = yield* rootExcludeFile(members);
  if (exclude === null) return;
  yield* Effect.gen(function* () {
    if (!(yield* fs.exists(exclude))) return;
    const lines = (yield* fs.readFileString(exclude)).split("\n");
    const tag = excludeTag(folder);
    const kept: Array<string> = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index] === tag) {
        index += 1;
        continue;
      }
      kept.push(lines[index]!);
    }
    if (kept.length !== lines.length) yield* fs.writeFileString(exclude, kept.join("\n"));
  }).pipe(Effect.ignore);
});

/**
 * Creates every member of a set in `folder` on `branch`, the root member
 * first. The manifest is written before the first member so a half-made set
 * can still be found and cleaned up. On failure the members made so far are
 * removed (never with local changes) and the error is returned.
 */
export const createWorktreeSet = Effect.fn("worktreeSet.create")(function* (input: {
  readonly folder: string;
  readonly members: ReadonlyArray<WorktreeSetMember>;
  readonly branch: string;
  readonly projectRoot: string;
  readonly baseRef: string;
  readonly startFromOrigin: boolean;
  readonly submodules: WorktreeSubmodules | null;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitWorkflowService.GitWorkflowService;
  if (yield* fs.exists(input.folder).pipe(Effect.orElseSucceed(() => false)))
    return yield* Effect.fail(`The thread folder ${input.folder} already exists.`);
  // Another thread's set whose folder is waiting to be restored.
  if (
    yield* fs
      .exists(worktreeSetManifestPath(input.folder, path))
      .pipe(Effect.orElseSucceed(() => true))
  )
    return yield* Effect.fail(`The thread folder ${input.folder} belongs to another worktree set.`);
  yield* writeWorktreeSet(input.folder, input.members).pipe(
    Effect.mapError((cause) => `Could not record the worktree set: ${String(cause)}`),
  );
  const created: Array<WorktreeSetMember> = [];
  const exit = yield* Effect.gen(function* () {
    for (const member of input.members) {
      const base = yield* memberBase(member, input.projectRoot, input.baseRef);
      const start = yield* memberStart(member.repository, base, input.startFromOrigin);
      const exists = yield* git
        .hasCommit({ cwd: member.repository, refName: start })
        .pipe(Effect.orElseSucceed(() => false));
      if (!exists)
        return yield* Effect.fail(
          `Base ref "${base}" was not found in repository ${member.repository}.`,
        );
      yield* git
        .createWorktree(
          {
            cwd: member.repository,
            refName: start,
            newRefName: input.branch,
            ...(base === "HEAD" ? {} : { baseRefName: base }),
            path: worktreeSetMemberPath(input.folder, member, path),
          },
          { submodules: input.submodules },
        )
        .pipe(
          Effect.mapError(
            (error) =>
              `Could not create the worktree of ${member.repository}: ${"detail" in error ? error.detail : String(error)}`,
          ),
        );
      created.push(member);
    }
    yield* excludeNestedMembers(input.folder, input.members);
  }).pipe(Effect.exit);
  if (Exit.isSuccess(exit)) return;
  const kept = yield* removeWorktreeSetMembers({ folder: input.folder, members: created }).pipe(
    Effect.orElseSucceed(() => created.map((member) => ({ member, reason: "removal failed" }))),
  );
  if (kept.length > 0)
    yield* Effect.logWarning("worktree set left members after a failed creation", {
      folder: input.folder,
      kept: kept.map((entry) => `${entry.member.repository}: ${entry.reason}`),
    });
  return yield* exit;
});

/**
 * Removes the members of a set, deepest first so a nested worktree never
 * blocks the one holding it, then the manifest once every member is gone.
 * Each removal goes through the removal guard. Returns the members kept, with
 * why.
 */
export const removeWorktreeSetMembers = Effect.fn("worktreeSet.remove")(function* (input: {
  readonly folder: string;
  readonly members: ReadonlyArray<WorktreeSetMember>;
  readonly context?: WorktreeRemovalContext | undefined;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitWorkflowService.GitWorkflowService;
  const kept: Array<{ readonly member: WorktreeSetMember; readonly reason: string }> = [];
  const deepestFirst = input.members.toReversed();
  for (const member of deepestFirst) {
    const memberPath = worktreeSetMemberPath(input.folder, member, path);
    // Removing a folder removes everything in it, including a member kept above.
    const holdsKept = kept.find((entry) =>
      worktreeSetMemberPath(input.folder, entry.member, path).startsWith(
        `${memberPath}${path.sep}`,
      ),
    );
    if (holdsKept !== undefined) {
      kept.push({ member, reason: `It holds ${holdsKept.member.repository}, which stays.` });
      continue;
    }
    const outcome = yield* git
      .removeWorktree({ cwd: member.repository, path: memberPath, force: false }, input.context)
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
    if (outcome !== null) kept.push({ member, reason: outcome });
  }
  if (kept.length === 0) {
    yield* removeNestedExcludes(input.folder, input.members);
    yield* removeWorktreeSetManifest(input.folder).pipe(Effect.ignore);
    // The folder of an umbrella set is plain; remove it once it is empty.
    const remaining = yield* fs
      .readDirectory(input.folder)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => ["?"]));
    if (remaining.length === 0) yield* fs.remove(input.folder).pipe(Effect.ignore);
  }
  return kept;
});

export type WorktreeSetRestore =
  | { readonly _tag: "Restored"; readonly recreated: ReadonlyArray<WorktreeSetMember> }
  | { readonly _tag: "BranchMissing"; readonly member: WorktreeSetMember }
  | { readonly _tag: "Failed"; readonly member: WorktreeSetMember; readonly error: unknown };

/** Recreates the members whose folders are missing, from `branch`, shallowest first. */
export const restoreWorktreeSet = Effect.fn("worktreeSet.restore")(function* (input: {
  readonly folder: string;
  readonly members: ReadonlyArray<WorktreeSetMember>;
  readonly branch: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitWorkflowService.GitWorkflowService;
  const recreated: Array<WorktreeSetMember> = [];
  for (const member of input.members) {
    const memberPath = worktreeSetMemberPath(input.folder, member, path);
    // A folder without `.git` (left by a submodule path, say) is not the member.
    if (yield* hasGit(memberPath)) continue;
    const hasBranch = yield* git
      .hasCommit({ cwd: member.repository, refName: `refs/heads/${input.branch}` })
      .pipe(Effect.orElseSucceed(() => false));
    if (!hasBranch) return { _tag: "BranchMissing", member } as WorktreeSetRestore;
    const exit = yield* git
      .pruneWorktrees({ cwd: member.repository })
      .pipe(
        Effect.andThen(
          git.createWorktree({ cwd: member.repository, refName: input.branch, path: memberPath }),
        ),
        Effect.exit,
      );
    if (Exit.isFailure(exit))
      return { _tag: "Failed", member, error: Cause.squash(exit.cause) } as WorktreeSetRestore;
    recreated.push(member);
  }
  yield* excludeNestedMembers(input.folder, input.members);
  return { _tag: "Restored", recreated } as WorktreeSetRestore;
});

const hasGit = (folder: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.exists(path.join(folder, ".git")).pipe(Effect.orElseSucceed(() => false));
  });
