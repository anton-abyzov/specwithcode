// @effect-diagnostics nodeBuiltinImport:off - pure path arithmetic over a finished scan.
import * as NodePath from "node:path";

import {
  isSkippedWorktreesNotice,
  type ClassTotals,
  type FolderScan,
  type RepositoryInfo,
} from "./manifest.ts";
import { PORTABLE_GIT_NOTICE } from "./portableGit.ts";
import type { SecretHint, SecretLocations } from "./secretLocations.ts";
import { sha256Hex } from "./wire.ts";

/** Skipped worktree paths kept per list; the counts stay true. */
const MAX_SKIPPED_WORKTREES = 200;

export interface SourceSummary {
  readonly totals: ClassTotals;
  readonly repositories: ReadonlyArray<{
    readonly path: string;
    readonly kind: RepositoryInfo["kind"];
    readonly head: string | null;
    readonly branch: string | null;
    readonly branchCount: number;
    readonly stashCount: number;
    readonly changedFiles: number;
  }>;
  /** Secret files in the folder, then `~/` files in the home folder. */
  readonly secretFiles: ReadonlyArray<{ readonly path: string; readonly size: number }>;
  /** Secrets a vault or keychain holds: never copied, listed so none is missed. */
  readonly secretHints?: ReadonlyArray<SecretHint>;
  readonly linksOutside: number;
  readonly warnings: ReadonlyArray<string>;
  /** What measuring left out: rebuildable folders not opened, worktrees inside the folder not copied. */
  readonly skipped?: {
    readonly rebuildableFolders: number;
    readonly worktrees: ReadonlyArray<string>;
    /** Skipped worktrees with uncommitted changes, which stay on this machine. */
    readonly dirtyWorktrees?: ReadonlyArray<string>;
    /** Skipped worktrees whose check failed or timed out; they may hold changes. */
    readonly uncheckedWorktrees?: ReadonlyArray<string>;
    /** Skipped worktrees with commits on no branch (detached or mid-rebase/merge). */
    readonly strandedWorktrees?: ReadonlyArray<string>;
    /** True totals; the lists above are capped. */
    readonly worktreeCount?: number;
    readonly dirtyCount?: number;
  };
}

/**
 * Whether a link's target resolves outside the scanned folder. An absolute link
 * into the folder itself, such as a worktree's node_modules pointing at its main
 * checkout, still arrives whole; a relative link that climbs out with `..` does not.
 */
function linkLeavesRoot(root: string, path: string, target: string): boolean {
  const resolved = NodePath.resolve(root, NodePath.dirname(path), target);
  return resolved !== root && !resolved.startsWith(`${root}${NodePath.sep}`);
}

export function inventoryFingerprint(scan: FolderScan): string {
  return sha256Hex(
    Buffer.from(
      JSON.stringify({
        entries: scan.entries
          .filter((entry) => entry.class !== "repository")
          .map(({ path, type, size, mtimeMs, mode, target, class: fileClass }) => ({
            path,
            type,
            ...(type !== "directory" ? { size, mtimeMs } : {}),
            mode,
            target,
            fileClass,
          })),
        repositories: scan.repositories,
        skipped: scan.skipped,
        warnings: scan.warnings,
      }),
    ),
  );
}

export function summarize(
  scan: FolderScan,
  warnings: ReadonlyArray<string> = [],
  locations?: SecretLocations,
): SourceSummary {
  return {
    totals: scan.totals,
    repositories: scan.repositories.map((repo) => ({
      path: repo.path,
      kind: repo.kind,
      head: repo.head,
      branch: repo.branch,
      branchCount: Object.keys(repo.branches).length,
      stashCount: repo.stashCount,
      changedFiles: repo.status.length,
    })),
    // Home files lead, so a folder full of secrets never pushes them out. A folder
    // path starting with `~/` would read as one, so such a folder's files are left here.
    secretFiles: [
      ...(locations?.homeFiles ?? []),
      ...scan.entries
        .filter(
          (entry) =>
            entry.class === "secret" && entry.type === "file" && !entry.path.startsWith("~/"),
        )
        .map((entry) => ({ path: entry.path, size: entry.size })),
    ].slice(0, 500),
    ...(locations && locations.hints.length > 0 ? { secretHints: locations.hints } : {}),
    linksOutside: scan.entries.filter(
      (entry) =>
        entry.type === "symlink" &&
        typeof entry.target === "string" &&
        linkLeavesRoot(scan.root, entry.path, entry.target),
    ).length,
    // The skipped-worktree notice leads, so the cap can never drop it.
    warnings: [
      ...new Set([
        ...(scan.notices ?? []).filter(isSkippedWorktreesNotice),
        ...warnings,
        ...scan.warnings,
        ...(scan.notices ?? []),
      ]),
    ].slice(0, 50),
    ...(scan.skipped
      ? {
          skipped: {
            rebuildableFolders: scan.skipped.rebuildableFolders,
            worktrees: scan.skipped.worktrees.slice(0, MAX_SKIPPED_WORKTREES),
            ...(scan.skipped.dirtyWorktrees
              ? { dirtyWorktrees: scan.skipped.dirtyWorktrees.slice(0, MAX_SKIPPED_WORKTREES) }
              : {}),
            ...(scan.skipped.uncheckedWorktrees
              ? {
                  uncheckedWorktrees: scan.skipped.uncheckedWorktrees.slice(
                    0,
                    MAX_SKIPPED_WORKTREES,
                  ),
                }
              : {}),
            ...(scan.skipped.strandedWorktrees
              ? {
                  strandedWorktrees: scan.skipped.strandedWorktrees.slice(0, MAX_SKIPPED_WORKTREES),
                }
              : {}),
            ...(scan.skipped.worktrees.length > 0
              ? { worktreeCount: scan.skipped.worktrees.length }
              : {}),
            ...(scan.skipped.dirtyWorktrees
              ? { dirtyCount: scan.skipped.dirtyWorktrees.length }
              : {}),
          },
        }
      : {}),
  };
}

/** Measuring no longer snapshots Git, so the measured summary says when it happens. */
export function withGitNotice(scan: FolderScan): FolderScan {
  return scan.repositories.length > 0
    ? { ...scan, notices: [...(scan.notices ?? []), PORTABLE_GIT_NOTICE] }
    : scan;
}
