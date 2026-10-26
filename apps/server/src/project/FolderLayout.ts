// @effect-diagnostics nodeBuiltinImport:off - Plain promises over one approved folder, like ThreadIncrementProgress.
/**
 * What a project folder holds before it becomes the project root: one Git
 * checkout, an umbrella of checkouts under `repositories/<owner>/<repo>`,
 * checkouts nested under any other names, or none. The walk follows SpecWeave's
 * `discoverNestedRepos` (src/core/session/nested-repos.ts) so the app and the
 * CLI agree: bounded depth and folder budget, dot and dependency folders
 * skipped, a symlink followed only when it stays inside the folder, a `.git`
 * file (worktree or submodule) counts, and a checkout's own subfolders are not
 * searched. It never looks above the folder and runs only when asked.
 *
 * `planningImpact` says what the plan cards would read before and after: the
 * SpecWeave planning root each folder resolves to, how many increments it has,
 * and which manual increment links would point at nothing.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { INCREMENTS_DIR } from "./ThreadReports.ts";
import { incrementRootFor } from "./ThreadIncrementProgress.ts";

export const NESTED_DEPTH = 3;
export const NESTED_DIR_BUDGET = 5_000;
export const LISTED_REPOSITORIES = 50;
const SKIP_DIRS = new Set([
  "node_modules",
  "vendor",
  "dist",
  "build",
  "target",
  "out",
  "coverage",
  "Pods",
  "bower_components",
  "__pycache__",
]);

export type FolderLayoutKind = "single" | "umbrella" | "nested" | "plain";

export interface FolderLayout {
  readonly kind: FolderLayoutKind;
  /** The folder itself is a Git checkout (a `.git` folder or file). */
  readonly rootIsRepository: boolean;
  /** Checkouts below it, POSIX-relative paths, at most LISTED_REPOSITORIES. */
  readonly repositories: ReadonlyArray<string>;
  readonly repositoryCount: number;
  /** The folder budget stopped the walk before it saw everything. */
  readonly truncated: boolean;
}

const isCheckout = (folder: string) =>
  NodeFSP.lstat(NodePath.join(folder, ".git")).then(
    (stat) => stat.isDirectory() || stat.isFile(),
    () => false,
  );

const within = (root: string, candidate: string) => {
  const relative = NodePath.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
};

export async function readFolderLayout(folder: string): Promise<FolderLayout | null> {
  const root = await NodeFSP.realpath(folder).catch(() => null);
  if (root === null) return null;
  const rootIsRepository = await isCheckout(root);
  const found = new Map<string, { readonly path: string; readonly link: boolean }>();
  const queue: Array<{ path: string; depth: number; link: boolean }> = [
    { path: root, depth: 0, link: false },
  ];
  let visited = 0;
  let truncated = false;
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (visited++ >= NESTED_DIR_BUDGET) {
      truncated = true;
      break;
    }
    const entries = await NodeFSP.readdir(next.path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const child = NodePath.join(next.path, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await NodeFSP.realpath(child).catch(() => null);
        const stat = target === null ? null : await NodeFSP.stat(target).catch(() => null);
        if (target === null || !stat?.isDirectory() || !within(root, target)) continue;
      } else if (!entry.isDirectory()) continue;
      // Key by real path: a folder under a symlinked parent is the same checkout as its target.
      const real = await NodeFSP.realpath(child).catch(() => null);
      if (real === null || real === root) continue;
      const link = next.link || entry.isSymbolicLink();
      if (await isCheckout(child)) {
        // A checkout reached directly wins over a symlink to it, as in the CLI.
        const seen = found.get(real);
        if (seen === undefined || (seen.link && !link))
          // Shown and stored, so always POSIX-relative, as in the CLI.
          found.set(real, {
            path: NodePath.relative(root, child).split(NodePath.sep).join("/"),
            link,
          });
        continue;
      }
      if (next.depth + 1 < NESTED_DEPTH) queue.push({ path: child, depth: next.depth + 1, link });
    }
  }
  const repositories = [...found.values()].map((repository) => repository.path).toSorted();
  const kind: FolderLayoutKind =
    repositories.length === 0
      ? rootIsRepository
        ? "single"
        : "plain"
      : repositories.every((repository) => repository.split("/")[0] === "repositories")
        ? "umbrella"
        : "nested";
  return {
    kind,
    rootIsRepository,
    repositories: repositories.slice(0, LISTED_REPOSITORIES),
    repositoryCount: repositories.length,
    truncated,
  };
}

async function incrementIds(root: string): Promise<Set<string>> {
  const entries = await NodeFSP.readdir(NodePath.join(root, INCREMENTS_DIR), {
    withFileTypes: true,
  }).catch(() => []);
  return new Set(
    entries
      .filter((entry) => entry.isDirectory() && /^\d{4,}[A-Za-z]?-/u.test(entry.name))
      .map((entry) => entry.name),
  );
}

export interface PlanningImpact {
  /** The planning root plan cards read now, or null when no SpecWeave increments are in reach. */
  readonly currentRoot: string | null;
  readonly currentIncrements: number;
  readonly targetRoot: string | null;
  readonly targetIncrements: number;
  /** Manual increment links whose increment the new planning root lacks. */
  readonly brokenLinks: ReadonlyArray<string>;
  /** Plan cards would read another planning root (or none), so the user must confirm. */
  readonly changes: boolean;
}

/**
 * Projects with no increments in reach on either side need no confirmation:
 * a plain folder change stays a plain folder change.
 */
export async function planningImpact(
  currentFolder: string,
  targetFolder: string,
  linkedIncrements: ReadonlyArray<string>,
): Promise<PlanningImpact> {
  const resolve = async (folder: string) => {
    const root = await incrementRootFor(folder, null);
    const ids = await incrementIds(root);
    return ids.size === 0
      ? { root: null, count: 0, ids }
      : { root: await NodeFSP.realpath(root).catch(() => root), count: ids.size, ids };
  };
  const [current, target] = await Promise.all([resolve(currentFolder), resolve(targetFolder)]);
  const brokenLinks: string[] = [];
  for (const incrementId of new Set(linkedIncrements)) {
    const there =
      target.root !== null &&
      (await NodeFSP.stat(NodePath.join(target.root, INCREMENTS_DIR, incrementId)).then(
        (stat) => stat.isDirectory(),
        () => false,
      ));
    if (!there) brokenLinks.push(incrementId);
  }
  return {
    currentRoot: current.root,
    currentIncrements: current.count,
    targetRoot: target.root,
    targetIncrements: target.count,
    brokenLinks: brokenLinks.toSorted(),
    // A clone that holds every current increment loses nothing, so it needs no confirmation.
    changes:
      current.root !== target.root &&
      ([...current.ids].some((id) => !target.ids.has(id)) || brokenLinks.length > 0),
  };
}
