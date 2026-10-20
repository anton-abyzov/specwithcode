// @effect-diagnostics nodeBuiltinImport:off - FileSystem has no lstat or directory entry types, and the scan must see links without following them
import type { Dirent } from "node:fs";
import { readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  ProjectLinkError,
  type RepositoryFingerprint,
  type RepositoryFingerprintEntry,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import { canonicalOrigin } from "../fleet/handoffGitTypes.ts";

// Caches and build output never hold a project's repositories. Unlike a handoff
// scan, every limit stops the scan and marks it truncated instead of failing:
// a fingerprint only ranks suggestions and checks a link's root.
const SKIPPED = new Set([
  ".git",
  "node_modules",
  ".next",
  ".turbo",
  ".cache",
  "DerivedData",
  "Pods",
  ".gradle",
  "dist",
  "coverage",
]);
const MAX_DIRECTORIES = 20_000;
const MAX_ENTRIES = 200_000;
const MAX_DEPTH = 12;
const MAX_REPOSITORIES = 1024;

/** The `url` of `[remote "origin"]` in a Git config file, if any. */
export function originUrlFromConfig(config: string): string | null {
  let inOrigin = false;
  for (const raw of config.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inOrigin = /^\[remote\s+"origin"\]$/u.test(line);
      continue;
    }
    if (!inOrigin) continue;
    const match = /^url\s*=\s*(.+)$/u.exec(line);
    if (match) return match[1]!.trim().replace(/^"(.*)"$/u, "$1");
  }
  return null;
}

interface GitLocation {
  /** The repository's own Git directory, shared by all its worktrees. */
  readonly commonDir: string;
  readonly linkedWorktree: boolean;
}

const readText = (file: string) => readFile(file, "utf8").catch(() => null);

/** Resolves `<folder>/.git`, a directory or a `gitdir:` file of a worktree or submodule. */
async function gitLocation(folder: string, entry: Dirent): Promise<GitLocation | null> {
  const dotGit = join(folder, ".git");
  if (entry.isDirectory())
    return { commonDir: await realpath(dotGit).catch(() => dotGit), linkedWorktree: false };
  if (!entry.isFile()) return null;
  const pointer = /^gitdir:\s*(.+)\s*$/mu.exec((await readText(dotGit)) ?? "")?.[1];
  if (!pointer) return null;
  const gitDir = resolve(folder, pointer);
  const common = (await readText(join(gitDir, "commondir")))?.trim();
  if (!common)
    return { commonDir: await realpath(gitDir).catch(() => gitDir), linkedWorktree: false };
  const commonDir = resolve(gitDir, common);
  return { commonDir: await realpath(commonDir).catch(() => commonDir), linkedWorktree: true };
}

/**
 * What `root` holds: a repository at the root or a plain umbrella folder, its nested
 * repositories with their origins, and linked worktrees counted under their main
 * repository instead of as more repositories. Directory links are skipped, never
 * followed. Read-only; never runs Git.
 */
export async function scanRepositoryFingerprint(root: string): Promise<RepositoryFingerprint> {
  const top = await realpath(root);
  const repositories = new Map<string, { entry: RepositoryFingerprintEntry; main: boolean }>();
  const pending: Array<{ absolute: string; depth: number }> = [{ absolute: top, depth: 0 }];
  let directories = 0;
  let entries = 0;
  let skippedLinks = 0;
  let truncated = false;
  let rootIsRepository = false;
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (++directories > MAX_DIRECTORIES || repositories.size >= MAX_REPOSITORIES) {
      truncated = true;
      break;
    }
    const children = await readdir(current.absolute, { withFileTypes: true }).catch(() => null);
    if (children === null) continue;
    entries += children.length;
    if (entries > MAX_ENTRIES) {
      truncated = true;
      break;
    }
    const dotGit = children.find((child) => child.name === ".git");
    const location = dotGit ? await gitLocation(current.absolute, dotGit) : null;
    if (location) {
      const path = relative(top, current.absolute).split(sep).join("/");
      if (path === "") rootIsRepository = true;
      const existing = repositories.get(location.commonDir);
      if (existing) {
        // A worktree, or the main checkout found after one of its worktrees.
        if (location.linkedWorktree || existing.main)
          existing.entry = { ...existing.entry, worktrees: existing.entry.worktrees + 1 };
        else
          repositories.set(location.commonDir, {
            main: true,
            entry: { ...existing.entry, path, worktrees: existing.entry.worktrees + 1 },
          });
      } else {
        const config = await readText(join(location.commonDir, "config"));
        const url = config === null ? null : originUrlFromConfig(config);
        repositories.set(location.commonDir, {
          main: !location.linkedWorktree,
          entry: { path, originKey: url === null ? null : canonicalOrigin(url), worktrees: 0 },
        });
      }
    }
    if (current.depth >= MAX_DEPTH) {
      if (children.some((child) => child.isDirectory() && !SKIPPED.has(child.name)))
        truncated = true;
      continue;
    }
    for (const child of children) {
      if (SKIPPED.has(child.name)) continue;
      if (child.isSymbolicLink()) {
        const target = await realpath(join(current.absolute, child.name)).catch(() => null);
        if (
          target !== null &&
          (await readdir(target)
            .then(() => true)
            .catch(() => false))
        )
          skippedLinks++;
        continue;
      }
      if (child.isDirectory())
        pending.push({ absolute: join(current.absolute, child.name), depth: current.depth + 1 });
    }
  }
  const sorted = [...repositories.values()]
    .map(({ entry }) => entry)
    .sort((a, b) => (a.path === "" ? -1 : b.path === "" ? 1 : a.path.localeCompare(b.path)));
  return {
    root: rootIsRepository ? "repository" : "folder",
    repositories: sorted,
    skippedLinks,
    truncated,
  };
}

/** The scan as an Effect for an absolute, existing folder. */
export const fingerprintFolder = (folder: string) =>
  isAbsolute(folder)
    ? Effect.tryPromise({
        try: () => scanRepositoryFingerprint(folder),
        catch: () =>
          new ProjectLinkError({
            code: "not_found",
            detail: `The folder ${folder} cannot be read.`,
          }),
      })
    : Effect.fail(
        new ProjectLinkError({ code: "invalid", detail: "Use an absolute folder path." }),
      );
