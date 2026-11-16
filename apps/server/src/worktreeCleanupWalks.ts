// @effect-diagnostics nodeBuiltinImport:off -- bounded lstat walks (folder sizes, ignored folders, nested repositories) that never follow symlinks.
/**
 * The bounded file walks of the chat worktree sweep (worktreeCleanupSweep.ts).
 * None follows a symbolic link, and each stops at an entry limit and reports
 * that it did, so a huge folder is kept instead of half read.
 *
 * @module worktreeCleanupWalks
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { isMediaFile } from "./finishedWorktrees.ts";
import { onlyDependencyIgnores } from "./orphanWorktrees.ts";

/** Ignored media to copy to evidence before its folder goes. */
export interface MediaFile {
  /** Relative to its member's folder. */
  readonly relative: string;
  readonly bytes: number;
}

/** The plan's size walk stops here and reports no size. */
const SIZE_WALK_MAX_ENTRIES = 200_000;
export const SIZE_WALK_TIMEOUT = "5 seconds";
/** Ignored folders are walked for media; one this large keeps the folder instead. */
export const IGNORED_WALK_MAX_ENTRIES = 20_000;
const NESTED_WALK_MAX_ENTRIES = 2_000_000;
export const NESTED_WALK_TIMEOUT = "30 seconds";

/**
 * Untracked or ignored entries of a member (Git's `--directory` listing),
 * without the members nested in it: a folder on the way to one is opened and
 * its other entries listed instead. Directories keep their trailing slash.
 */
export async function entriesOutsideMembers(
  root: string,
  entries: ReadonlyArray<string>,
  inside: ReadonlyArray<string>,
): Promise<ReadonlyArray<string>> {
  const kept: Array<string> = [];
  const pending = [...entries];
  while (pending.length > 0) {
    const entry = pending.pop()!;
    const relative = entry.replace(/\/$/, "");
    if (relative === "") continue;
    if (inside.some((member) => relative === member || relative.startsWith(`${member}/`))) continue;
    if (!inside.some((member) => member.startsWith(`${relative}/`))) {
      kept.push(entry);
      continue;
    }
    for (const dirent of await NodeFSP.readdir(NodePath.join(root, relative), {
      withFileTypes: true,
    }))
      pending.push(`${relative}/${dirent.name}${dirent.isDirectory() ? "/" : ""}`);
  }
  return kept.toSorted();
}

/**
 * Ignored entries that are neither rebuildable nor media, by name, and the
 * media to copy. An ignored folder is opened (without following links) so a
 * screenshot folder can go once its media is copied; a folder too large to
 * list counts as data.
 */
export async function classifyIgnored(
  root: string,
  entries: ReadonlyArray<string>,
): Promise<{ readonly other: ReadonlyArray<string>; readonly media: ReadonlyArray<MediaFile> }> {
  const other: Array<string> = [];
  const media: Array<MediaFile> = [];
  let seen = 0;
  const file = async (relative: string) => {
    if (onlyDependencyIgnores(relative)) return;
    const target = NodePath.join(root, relative);
    const stat = await NodeFSP.lstat(target);
    if (stat.isFile() && isMediaFile(NodePath.basename(target)))
      media.push({ relative: NodePath.normalize(relative), bytes: stat.size });
    else other.push(NodePath.basename(target));
  };
  for (const entry of entries) {
    if (onlyDependencyIgnores(entry)) continue;
    if (!entry.endsWith("/")) {
      await file(entry);
      continue;
    }
    const pending = [entry.replace(/\/$/, "")];
    while (pending.length > 0) {
      const folder = pending.pop()!;
      const dirents = await NodeFSP.readdir(NodePath.join(root, folder), { withFileTypes: true });
      seen += dirents.length;
      if (seen > IGNORED_WALK_MAX_ENTRIES) {
        other.push(NodePath.basename(entry.replace(/\/$/, "")));
        return { other, media };
      }
      for (const dirent of dirents) {
        const relative = `${folder}/${dirent.name}`;
        if (dirent.isDirectory()) {
          if (dirent.name !== "node_modules") pending.push(relative);
        } else await file(relative);
      }
    }
  }
  return { other, media };
}

/** A `.git` entry, or the HEAD, objects and refs of a bare repository. */
function holdsRepository(names: ReadonlyArray<string>): boolean {
  const markers = new Set(names.map((name) => name.toLowerCase()));
  return (
    markers.has(".git") || (markers.has("head") && markers.has("objects") && markers.has("refs"))
  );
}

/** A repository in the given untracked or ignored entries; null when the walk ran out. */
export async function findRepository(
  root: string,
  entries: ReadonlyArray<string>,
  signal: AbortSignal,
): Promise<boolean | null> {
  const pending: Array<string> = [];
  for (const entry of entries) {
    const relative = entry.replace(/\/$/, "");
    if (NodePath.basename(relative).toLowerCase() === ".git") return true;
    pending.push(NodePath.join(root, relative));
  }
  let seen = 0;
  while (pending.length > 0) {
    if (signal.aborted) return null;
    const target = pending.pop()!;
    const stat = await NodeFSP.lstat(target);
    if (!stat.isDirectory()) continue;
    const dirents = await NodeFSP.readdir(target, { withFileTypes: true });
    seen += dirents.length;
    if (seen > NESTED_WALK_MAX_ENTRIES) return null;
    if (holdsRepository(dirents.map((dirent) => dirent.name))) return true;
    for (const dirent of dirents)
      if (dirent.isDirectory()) pending.push(NodePath.join(target, dirent.name));
  }
  return false;
}

/**
 * Bytes on disk outside dependency installs, without following links; null
 * when the walk passes its entry limit or is aborted.
 */
export async function folderBytes(root: string, signal: AbortSignal): Promise<number | null> {
  const pending = [root];
  let bytes = 0;
  let seen = 0;
  while (pending.length > 0) {
    if (signal.aborted) return null;
    const folder = pending.pop()!;
    const dirents = await NodeFSP.readdir(folder, { withFileTypes: true });
    for (const dirent of dirents) {
      seen += 1;
      if (seen > SIZE_WALK_MAX_ENTRIES) return null;
      const target = NodePath.join(folder, dirent.name);
      if (dirent.isDirectory()) {
        if (dirent.name !== "node_modules") pending.push(target);
        continue;
      }
      const stat = await NodeFSP.lstat(target).catch(() => null);
      if (stat === null) continue;
      bytes += stat.blocks > 0 ? stat.blocks * 512 : stat.size;
    }
  }
  return bytes;
}
