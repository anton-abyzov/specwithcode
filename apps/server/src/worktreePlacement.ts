import type { WorktreeLocationMode } from "@specweave-studio/contracts";
import { resolveWorktreeLocationMode } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

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
  return Effect.gen(function* () {
    const contents = (yield* fs.exists(excludeFile)) ? yield* fs.readFileString(excludeFile) : "";
    const rule = "/.specwithcode/worktrees/";
    if (contents.split(/\r?\n/).includes(rule)) return;
    yield* fs.makeDirectory(path.dirname(excludeFile), { recursive: true });
    yield* fs.writeFileString(
      excludeFile,
      `${contents}${contents && !contents.endsWith("\n") ? "\n" : ""}${rule}\n`,
    );
  });
}
