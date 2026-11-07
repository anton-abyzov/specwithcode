import type { WorktreeLocationMode } from "@specweave-studio/contracts";
import { resolveWorktreeLocationMode } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import { resolveWorktreesDirectory } from "./worktreesDirectory.ts";

/** Resolve existing ancestors so a missing custom folder cannot hide a symlink escape. */
function canonicalFuturePath(directory: string, fs: FileSystem.FileSystem, path: Path.Path) {
  return Effect.gen(function* () {
    let ancestor = directory;
    const tail: string[] = [];
    while (!(yield* fs.exists(ancestor))) {
      if (path.dirname(ancestor) === ancestor) break;
      tail.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
    return path.join(yield* fs.realPath(ancestor), ...tail);
  });
}

export function validateWorktreePlacement(
  input: {
    readonly directory: string;
    readonly repository: string;
    readonly mode?: WorktreeLocationMode;
    readonly setting: string;
  },
  fs: FileSystem.FileSystem,
  path: Path.Path,
) {
  return Effect.gen(function* () {
    const directory = yield* canonicalFuturePath(input.directory, fs, path);
    const repository = yield* fs.realPath(input.repository);
    const mode = resolveWorktreeLocationMode({
      worktreesDirectory: input.setting,
      worktreeLocationMode: input.mode,
    });
    if (path.dirname(directory) === directory) return null;
    const relative = path.relative(repository, directory);
    const inside =
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
    // Only the designated private folder may sit within the selected checkout.
    // Project-local symlinks must resolve to the exact designated folder.
    if (mode === "project") {
      if (directory !== path.join(repository, ".specwithcode", "worktrees")) return null;
    } else if (
      inside ||
      (mode === "custom" &&
        !path.relative(directory, repository).startsWith(`..${path.sep}`) &&
        path.relative(directory, repository) !== ".." &&
        !path.isAbsolute(path.relative(directory, repository)))
    )
      return null;
    return input.directory;
  });
}

/** Append one private ignore rule while retaining all existing local exclusions. */
export function ignoreProjectWorktrees(
  excludeFile: string,
  fs: FileSystem.FileSystem,
  path: Path.Path,
) {
  return appendExcludeRule(excludeFile, "/.specwithcode/worktrees/", fs, path);
}

/**
 * The folder a worktree set (worktreeSet.ts) is created in:
 * `<worktrees>/<project folder name>/<branch folder>`, under the same
 * location the project's single worktrees use. Null when that location is
 * not usable on this machine.
 */
export function worktreeSetFolder(input: {
  readonly setting: string;
  readonly mode?: WorktreeLocationMode | undefined;
  /** `<SpecWithCode home>/worktrees`. */
  readonly defaultDir: string;
  readonly projectRoot: string;
  readonly branch: string;
  readonly path: Path.Path;
}): string | null {
  const { path } = input;
  const parent = resolveWorktreesDirectory(
    input.setting,
    input.defaultDir,
    path,
    input.mode,
    input.projectRoot,
  );
  if (parent === null) return null;
  return path.join(parent, path.basename(input.projectRoot), worktreeFolderName(input.branch));
}

/** A branch's folder name, named as single worktrees are: short enough for Windows. */
export function worktreeFolderName(branch: string): string {
  const name = branch.replace(/\//g, "-");
  if (name.length <= 40) return name;
  return `${name.slice(0, 23).replace(/[\uD800-\uDBFF]$/, "")}-${fnv1a64(branch)}`;
}

/** Append one line to a git exclude file unless it is already there. */
export function appendExcludeRule(
  excludeFile: string,
  rule: string,
  fs: FileSystem.FileSystem,
  path: Path.Path,
) {
  return Effect.gen(function* () {
    const contents = (yield* fs.exists(excludeFile)) ? yield* fs.readFileString(excludeFile) : "";
    if (contents.split(/\r?\n/).includes(rule)) return;
    yield* fs.makeDirectory(path.dirname(excludeFile), { recursive: true });
    yield* fs.writeFileString(
      excludeFile,
      `${contents}${contents && !contents.endsWith("\n") ? "\n" : ""}${rule}\n`,
    );
  });
}

/** 16 hex characters of a 64-bit FNV-1a hash: a stable short suffix, not a security digest. */
function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}
