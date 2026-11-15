// @effect-diagnostics nodeBuiltinImport:off -- walks folders with lstat so symlinks are never followed.
/**
 * Work in a worktree that `git status` does not show and a plain
 * `git worktree remove` still deletes: edits to tracked files marked
 * assume-unchanged or skip-worktree, and Git repositories inside untracked or
 * ignored folders. Each check returns why the folder must stay, or null.
 * Anything that cannot be read is a reason to stay.
 *
 * @module worktreeHiddenWork
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";

import type * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

type Git = Pick<GitVcsDriver.GitVcsDriver["Service"], "execute">;

const INCOMPLETE = "worktree could not be fully inspected";
const FLAGGED_LIMIT = 10_000;
const WALK_ENTRY_LIMIT = 2_000_000;

// `git ls-files -s -v`: `<tag> <mode> <object> <stage>\t<path>`. `S` is
// skip-worktree; a lowercase tag is assume-unchanged.
const STAGED_ENTRY = /^(\S) (\d+) ([0-9a-f]+) (\d)\t(.*)$/s;
const HIDDEN_TAG = /^(?:S|[a-z])$/;

const errorCode = (cause: unknown) =>
  cause instanceof Error && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;

interface FlaggedEntry {
  readonly mode: string;
  readonly id: string;
  readonly file: string;
}

type OnDisk =
  | { readonly kind: "missing" }
  | { readonly kind: "file" }
  | { readonly kind: "link"; readonly target: string }
  | { readonly kind: "other" }
  | { readonly kind: "unreadable" };

const inspectOnDisk = (file: string) =>
  Effect.promise(async (): Promise<OnDisk> => {
    try {
      const stat = await NodeFSP.lstat(file);
      if (stat.isSymbolicLink()) return { kind: "link", target: await NodeFSP.readlink(file) };
      return stat.isFile() ? { kind: "file" } : { kind: "other" };
    } catch (cause) {
      const code = errorCode(cause);
      // A flagged file that is gone holds no edit: its content is in the index.
      return code === "ENOENT" || code === "ENOTDIR" ? { kind: "missing" } : { kind: "unreadable" };
    }
  });

/**
 * A tracked file marked assume-unchanged or skip-worktree whose content on disk
 * differs from the index. Sparse checkouts flag files outside the cone; those
 * are absent from disk and hold nothing.
 */
export const hiddenTrackedChangeReason = Effect.fn("WorktreeHiddenWork.hiddenTrackedChange")(
  function* (git: Git, cwd: string, limits?: { readonly flaggedFiles?: number }) {
    const flaggedLimit = limits?.flaggedFiles ?? FLAGGED_LIMIT;
    const flagged: Array<FlaggedEntry> = [];
    let overflow = false;
    let unparsed = false;
    yield* git.execute({
      operation: "StorageCleanup.hiddenTrackedChanges",
      cwd,
      args: ["-c", "core.quotePath=false", "ls-files", "-s", "-v"],
      // Only the line callbacks read the listing; the buffered copy may stop at the cap.
      maxOutputBytes: 64 * 1024,
      appendTruncationMarker: true,
      keepLineCallbacksAfterTruncation: true,
      progress: {
        onStdoutLine: (line) =>
          Effect.sync(() => {
            if (line === "") return;
            const match = STAGED_ENTRY.exec(line);
            if (match === null) {
              unparsed = true;
              return;
            }
            // Gitlinks are submodules, which worktree removal refuses on its own.
            if (!HIDDEN_TAG.test(match[1]!) || match[2] === "160000") return;
            if (flagged.length < flaggedLimit)
              flagged.push({ mode: match[2]!, id: match[3]!, file: match[5]! });
            else overflow = true;
          }),
      },
    });
    if (overflow) return "hidden tracked files exceed the inspection limit";
    if (unparsed) return INCOMPLETE;
    const reason = (file: string) => `has uncommitted changes hidden from git status (${file})`;
    // Quoted names (control characters, quotes, backslashes) and names that are
    // not valid UTF-8 decode to text that is not the path on disk.
    const unreadable = flagged.find(({ file }) => file.startsWith('"') || file.includes("�"));
    if (unreadable !== undefined) return reason(unreadable.file);
    const onDisk = yield* Effect.forEach(
      flagged,
      (entry) =>
        inspectOnDisk(NodePath.join(cwd, entry.file)).pipe(Effect.map((disk) => ({ entry, disk }))),
      { concurrency: 16 },
    );
    const hash = (args: ReadonlyArray<string>, stdin: string) =>
      git.execute({
        operation: "StorageCleanup.hiddenTrackedChanges",
        cwd,
        args: ["hash-object", ...args],
        stdin,
        maxOutputBytes: 1024 * 1024,
      });
    const files: Array<FlaggedEntry> = [];
    // Without core.symlinks a tracked link is a regular file holding its target.
    const linkFiles: Array<FlaggedEntry> = [];
    for (const { entry, disk } of onDisk) {
      if (disk.kind === "missing") continue;
      if (disk.kind === "file") (entry.mode === "120000" ? linkFiles : files).push(entry);
      else if (disk.kind !== "link" || entry.mode !== "120000") return reason(entry.file);
      // Hashing a link's path would hash the file it points to.
      else if ((yield* hash(["--stdin"], disk.target)).stdout.trim() !== entry.id)
        return reason(entry.file);
    }
    const hashPaths = (entries: ReadonlyArray<FlaggedEntry>, flags: ReadonlyArray<string>) =>
      entries.length === 0
        ? Effect.succeed<ReadonlyArray<string>>([])
        : hash([...flags, "--stdin-paths"], entries.map(({ file }) => `${file}\n`).join("")).pipe(
            Effect.map((result): ReadonlyArray<string> =>
              result.stdoutTruncated ? [] : result.stdout.split("\n"),
            ),
          );
    const fileIds = yield* hashPaths(files, []);
    const linkIds = yield* hashPaths(linkFiles, ["--no-filters"]);
    const changed =
      files.find(({ id }, index) => fileIds[index] !== id) ??
      linkFiles.find(({ id }, index) => linkIds[index] !== id);
    return changed === undefined ? null : reason(changed.file);
  },
);

/** A `.git` entry, or the HEAD, objects and refs of a bare repository. */
function holdsRepository(names: ReadonlyArray<string>): boolean {
  const markers = new Set(names.map((name) => name.toLowerCase()));
  return (
    markers.has(".git") || (markers.has("head") && markers.has("objects") && markers.has("refs"))
  );
}

async function findNestedRepository(
  root: string,
  entries: ReadonlyArray<string>,
  signal: AbortSignal,
): Promise<string | null> {
  const pending: Array<string> = [];
  for (const entry of entries) {
    const target = NodePath.resolve(root, entry);
    const relative = NodePath.relative(root, target);
    if (relative === "" || relative.startsWith("..") || NodePath.isAbsolute(relative))
      return INCOMPLETE;
    if (NodePath.basename(target).toLowerCase() === ".git")
      return `contains a nested Git repository (${relative})`;
    pending.push(target);
  }
  let seen = 0;
  while (pending.length > 0) {
    if (signal.aborted) return INCOMPLETE;
    const target = pending.pop()!;
    const stat = await NodeFSP.lstat(target);
    if (!stat.isDirectory()) continue;
    const dirents = await NodeFSP.readdir(target, { withFileTypes: true });
    seen += dirents.length;
    if (seen > WALK_ENTRY_LIMIT) return INCOMPLETE;
    if (holdsRepository(dirents.map((dirent) => dirent.name)))
      return `contains a nested Git repository (${NodePath.relative(root, target)})`;
    for (const dirent of dirents)
      if (dirent.isDirectory()) pending.push(NodePath.join(target, dirent.name));
  }
  return null;
}

/**
 * A Git repository inside the worktree's untracked or ignored folders. Git
 * status lists a nested repository as one untracked folder, or not at all when
 * it is ignored (inside `node_modules/`), and removal deletes it. Registered
 * submodules are in the index, never listed here, and Git refuses to remove a
 * worktree that has them.
 */
export const nestedRepositoryReason = Effect.fn("WorktreeHiddenWork.nestedRepository")(function* (
  git: Git,
  cwd: string,
) {
  // No exclude rules: every untracked path, ignored ones included, with
  // untracked folders collapsed to one entry.
  const listing = yield* git.execute({
    operation: "StorageCleanup.nestedRepositories",
    cwd,
    args: ["ls-files", "--others", "--directory", "-z"],
    maxOutputBytes: 1024 * 1024,
  });
  if (listing.stdoutTruncated) return INCOMPLETE;
  const entries = listing.stdout.split("\0").filter((entry) => entry !== "");
  if (entries.length === 0) return null;
  return yield* Effect.tryPromise({
    try: (signal) => findNestedRepository(cwd, entries, signal),
    catch: () => INCOMPLETE,
  }).pipe(
    Effect.timeout("30 seconds"),
    Effect.orElseSucceed(() => INCOMPLETE),
  );
});
