/**
 * Whether a worktree folder is the one its Git registration names, read from
 * files alone before any Git command runs there.
 *
 * A linked worktree's `.git` file names its registration
 * (`<common>/worktrees/<id>`), and the registration's `gitdir` file names the
 * worktree's `.git` back. When a registration is deleted and Git later adds a
 * worktree with the same folder name elsewhere, it reuses the id: the old
 * folder's `.git` then names a registration that points at another chat's
 * folder, and every Git command in the old folder acts on that chat's branch.
 * On one Mac five folders were in that state after an outside script removed
 * their registrations. Nothing in such a folder can be trusted or removed.
 *
 * @module worktreeRegistration
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

import { linkedWorktreeGitDir } from "../orphanWorktrees.ts";

export type WorktreeRegistration =
  | {
      readonly ok: true;
      /** The worktree's own registration folder, real path. */
      readonly gitDir: string;
      /** The repository's shared Git folder, real path. */
      readonly commonDir: string;
      /** The main checkout holding `commonDir`, or `commonDir` itself for a bare repository. */
      readonly repository: string;
      /** `git worktree lock` was run on it; Git refuses to remove it. */
      readonly locked: boolean;
    }
  | { readonly ok: false; readonly problem: string };

/**
 * The round trip folder `.git` -> registration -> `gitdir` -> the same folder.
 * Anything missing, unreadable or pointing elsewhere is not ok, with a plain
 * sentence saying what was found.
 */
export const checkWorktreeRegistration = Effect.fn("WorktreeRegistration.check")(function* (
  folder: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fail = (problem: string): WorktreeRegistration => ({ ok: false, problem });
  const realOf = (target: string) =>
    fs.realPath(target).pipe(Effect.orElseSucceed((): string | null => null));

  const realFolder = yield* realOf(folder);
  if (realFolder === null) return fail("The folder could not be read.");
  const dotGit = path.join(realFolder, ".git");
  const stat = yield* fs.stat(dotGit).pipe(Effect.result);
  if (Result.isFailure(stat))
    return fail(
      stat.failure.reason._tag === "NotFound"
        ? "It has no .git file, so Git does not know it as a worktree."
        : "Its .git file could not be read.",
    );
  if (stat.success.type === "Directory")
    return fail("Its .git is a folder: it is a repository of its own, not a worktree.");
  if (stat.success.type !== "File") return fail("Its .git is not a file.");
  // A .git reached through a link would let another folder's registration pass.
  if ((yield* realOf(dotGit)) !== dotGit) return fail("Its .git is a link to another place.");
  const contents = yield* fs.readFileString(dotGit).pipe(Effect.orElseSucceed(() => null));
  if (contents === null) return fail("Its .git file could not be read.");
  const named = linkedWorktreeGitDir(contents);
  if (named === null) return fail("Its .git file does not name a worktree registration.");
  // Git reads a relative gitdir from the folder holding the .git file.
  const gitDir = yield* realOf(path.resolve(realFolder, named));
  if (gitDir === null) return fail("The registration its .git file names is gone.");
  if (path.basename(path.dirname(gitDir)) !== "worktrees")
    return fail("Its .git file names a folder that is not a worktree registration.");
  const commonDir = path.dirname(path.dirname(gitDir));
  // Git finds the shared folder through `commondir`, relative to the registration.
  const commonFile = yield* fs
    .readFileString(path.join(gitDir, "commondir"))
    .pipe(Effect.orElseSucceed(() => null));
  if (commonFile === null) return fail("Its registration has no commondir file.");
  if ((yield* realOf(path.resolve(gitDir, commonFile.trim()))) !== commonDir)
    return fail("Its registration belongs to another repository.");
  const backFile = yield* fs
    .readFileString(path.join(gitDir, "gitdir"))
    .pipe(Effect.orElseSucceed(() => null));
  if (backFile === null) return fail("Its registration does not say which folder it belongs to.");
  const back = yield* realOf(path.resolve(gitDir, backFile.trim()));
  if (back !== dotGit)
    return fail(
      back === null
        ? "Its registration names a folder that is gone."
        : "Its registration belongs to another folder, so Git commands here would act on that folder's branch.",
    );
  const locked = yield* fs
    .exists(path.join(gitDir, "locked"))
    .pipe(Effect.orElseSucceed(() => true));
  return {
    ok: true,
    gitDir,
    commonDir,
    repository: path.basename(commonDir) === ".git" ? path.dirname(commonDir) : commonDir,
    locked,
  } satisfies WorktreeRegistration;
});
