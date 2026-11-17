// @effect-diagnostics nodeBuiltinImport:off -- plain synchronous file checks, shared by the CLI and an Effect.sync in the storage sweep.
/**
 * Leftover files of Git downloads and repacks that never finished.
 *
 * The checks copy at `<home>/verify/<name>` once held 440 `tmp_pack_*` files
 * of about 198 MB each (79 GiB). Its refs pointed at missing objects, so the
 * `git gc --auto` that every `git fetch` starts failed ("fatal: unable to read
 * <sha>", "fatal: failed to run repack") and left a full-size temporary pack
 * behind on every call. The fetch now passes `--no-auto-gc`; this module
 * removes what earlier runs already left.
 *
 * Only Git's temporary names are touched, and only once they are old enough
 * that no running fetch can still be writing them:
 * - `objects/pack/tmp_pack_*`: a pack being received or written.
 * - `objects/pack/tmp_obj_*` and `objects/xx/tmp_obj_*`: a loose object being written.
 * - `objects/pack/.tmp-<pid>-pack-*`: the files `git repack` asks `pack-objects`
 *   to write under that base name; repack renames them to `pack-<hash>.*` on
 *   success, so one that stays is from a repack that failed or was killed.
 *
 * Real packs and their `.idx`, `.rev`, `.keep`, `.bitmap` and `.mtimes`
 * files, and finished loose objects, never match. Anything that cannot be read
 * stays.
 *
 * @module staleGitPacks
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export interface StaleGitPack {
  readonly path: string;
  readonly bytes: number;
  /** The newer of the file's mtime and ctime. */
  readonly modifiedAtMs: number;
}

/** `checks copy` cleans its own copy before each fetch; an hour is far longer than any fetch of it. */
export const CHECKS_COPY_STALE_PACK_MS = 3_600_000;
/** The storage sweep runs unattended over every copy, so it waits longer. */
export const SWEEP_STALE_PACK_MS = 6 * 3_600_000;

interface AgeOptions {
  readonly olderThanMs: number;
  readonly nowMs: number;
}

const PACK_DIR_NAME = /^(?:tmp_pack_|tmp_obj_|\.tmp-\d+-pack-)/;
const LOOSE_DIR_NAME = /^tmp_obj_/;
const LOOSE_DIR = /^[0-9a-f]{2}$/;

function lstatOrNull(path: string): NodeFS.Stats | null {
  try {
    return NodeFS.lstatSync(path);
  } catch {
    return null;
  }
}

/** A real folder, not a link to one. */
const isRealDirectory = (path: string) => lstatOrNull(path)?.isDirectory() === true;

function readNames(dir: string): ReadonlyArray<string> {
  try {
    return NodeFS.readdirSync(dir);
  } catch {
    return [];
  }
}

/** The leftover's size and age, or null when it is not a regular file or its times cannot be read. */
function leftover(path: string): StaleGitPack | null {
  const stat = lstatOrNull(path);
  if (stat === null || !stat.isFile()) return null;
  const modifiedAtMs = Math.max(stat.mtimeMs, stat.ctimeMs);
  if (!Number.isFinite(modifiedAtMs)) return null;
  return { path, bytes: stat.size, modifiedAtMs };
}

/** A file written to in the last `olderThanMs` may belong to a fetch that is still running. */
const isStale = (pack: StaleGitPack, options: AgeOptions) =>
  options.nowMs - pack.modifiedAtMs >= options.olderThanMs;

/**
 * `<home>/verify/<name>/.git` for each copy whose folder and `.git` are real
 * folders. Links and `.git` files (linked worktrees) are left out, so nothing
 * outside `<home>/verify` is ever returned.
 */
export function verificationCopyGitDirs(home: string): ReadonlyArray<string> {
  const verify = NodePath.join(home, "verify");
  if (!isRealDirectory(verify)) return [];
  return readNames(verify)
    .toSorted()
    .map((name) => NodePath.join(verify, name))
    .filter((copy) => isRealDirectory(copy) && isRealDirectory(NodePath.join(copy, ".git")))
    .map((copy) => NodePath.join(copy, ".git"));
}

/**
 * Git's temporary download files in `gitDir` that are at least
 * `options.olderThanMs` old. A missing or linked `gitDir` or `objects` folder
 * gives an empty list.
 */
export function findStaleGitPacks(
  gitDir: string,
  options: AgeOptions,
): ReadonlyArray<StaleGitPack> {
  const objects = NodePath.join(gitDir, "objects");
  if (!isRealDirectory(gitDir) || !isRealDirectory(objects)) return [];
  const candidates: Array<string> = [];
  for (const name of readNames(objects)) {
    const dir = NodePath.join(objects, name);
    const pattern = name === "pack" ? PACK_DIR_NAME : LOOSE_DIR.test(name) ? LOOSE_DIR_NAME : null;
    if (pattern === null || !isRealDirectory(dir)) continue;
    for (const file of readNames(dir))
      if (pattern.test(file)) candidates.push(NodePath.join(dir, file));
  }
  return candidates
    .toSorted()
    .map(leftover)
    .filter((pack): pack is StaleGitPack => pack !== null && isStale(pack, options));
}

/**
 * Removes what `findStaleGitPacks` returns. Each file's type and age are read
 * again right before it is removed, so one a fetch started writing since the
 * listing stays. Files that could not be removed are listed, never thrown.
 */
export function removeStaleGitPacks(
  gitDir: string,
  options: AgeOptions,
): {
  readonly removed: ReadonlyArray<StaleGitPack>;
  readonly bytes: number;
  readonly failed: ReadonlyArray<string>;
} {
  const removed: Array<StaleGitPack> = [];
  const failed: Array<string> = [];
  for (const listed of findStaleGitPacks(gitDir, options)) {
    const current = leftover(listed.path);
    if (current === null || !isStale(current, options)) continue;
    try {
      NodeFS.unlinkSync(current.path);
      removed.push(current);
    } catch {
      failed.push(current.path);
    }
  }
  return { removed, bytes: removed.reduce((sum, pack) => sum + pack.bytes, 0), failed };
}
