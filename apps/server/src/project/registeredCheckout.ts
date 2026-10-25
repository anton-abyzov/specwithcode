// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - Plain promises over Git's own files, like ThreadIncrementProgress.
/**
 * Which folders are checkouts of the same Git repository, proven offline from
 * the files Git writes, without running Git.
 *
 * A thread's SpecWeave claim may name a root outside its project folder and
 * its registered worktree: a linked worktree of the project's repository made
 * with `git worktree add` somewhere else. Such a root is accepted only when
 * Git itself registered it, both ways:
 *
 *   - the candidate's `.git` is a file whose `gitdir:` names an admin folder
 *     `<common>/worktrees/<name>` (a submodule's `.git/modules/<name>` never
 *     qualifies), its `commondir`, when present, leads to the same `<common>`;
 *   - that admin folder's `gitdir` file names the candidate's `.git` back.
 *
 * A main checkout's `.git` is the common directory itself. Two folders are the
 * same repository when their common directories resolve to the same folder.
 * Everything is compared after resolving links, so a symlinked path cannot
 * stand in for another folder. A forged `.git` file alone proves nothing: the
 * back-link lives inside the repository's own `.git`.
 */
import * as NodeFSP from "node:fs/promises";

import { nodePath as NodePath } from "../nodePath.ts";

/** Git's pointer files are one short line; anything bigger is not one. */
const POINTER_BYTES = 4_096;
/** Linked worktrees read per repository; a larger list is cut, never guessed. */
const WORKTREES_LISTED = 256;
const CACHED_REPOSITORIES = 64;
/** How long one folder's check may take: a sleeping network volume answers "no" instead of stalling. */
const CHECK_MS = 2_000;
/** A listing is reused this long while its `worktrees` folder is unchanged, so a moved worktree shows up. */
const LISTING_TTL_MS = 5_000;

/**
 * How long a folder that timed out is skipped. A timed-out check keeps one of
 * Node's few file-system threads busy, so a hung mount is not asked again.
 */
const SLOW_SKIP_MS = 5 * 60_000;
const SLOW_REMEMBERED = 256;
const slowFolders = new Map<string, number>();

/**
 * `work()` for the folder `key`, or `fallback` once CHECK_MS pass first. A
 * folder that timed out answers `fallback` at once for SLOW_SKIP_MS.
 */
export function withinCheckTime<T>(key: string, work: () => Promise<T>, fallback: T): Promise<T> {
  const skipUntil = slowFolders.get(key);
  if (skipUntil !== undefined) {
    if (Date.now() < skipUntil) return Promise.resolve(fallback);
    slowFolders.delete(key);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      slowFolders.set(key, Date.now() + SLOW_SKIP_MS);
      if (slowFolders.size > SLOW_REMEMBERED) slowFolders.delete(slowFolders.keys().next().value!);
      resolve(fallback);
    }, CHECK_MS);
    timer.unref?.();
  });
  return Promise.race([work().catch(() => fallback), late]).finally(() => clearTimeout(timer));
}

async function realpath(path: string): Promise<string | null> {
  return NodeFSP.realpath(path).catch(() => null);
}

/** The first line of a small regular file, trimmed; null when it is not one. */
async function pointerLine(file: string): Promise<string | null> {
  try {
    const stat = await NodeFSP.lstat(file);
    if (!stat.isFile() || stat.size > POINTER_BYTES) return null;
    const line = (await NodeFSP.readFile(file, "utf8")).split(/\r?\n/u, 1)[0]?.trim() ?? "";
    return line === "" ? null : line;
  } catch {
    return null;
  }
}

/**
 * The Git common directory of the checkout whose top is `folder`, after
 * resolving links: its `.git` folder for a main checkout, or the repository's
 * for a linked worktree that Git registered both ways. Null for anything else:
 * no `.git`, a symlinked `.git`, a submodule, a forged or stale pointer.
 */
export async function checkoutCommonDir(folder: string): Promise<string | null> {
  const top = await realpath(folder);
  if (top === null) return null;
  const dotGit = NodePath.join(top, ".git");
  const stat = await NodeFSP.lstat(dotGit).catch(() => null);
  if (stat === null || stat.isSymbolicLink()) return null;
  if (stat.isDirectory()) {
    const head = await NodeFSP.lstat(NodePath.join(dotGit, "HEAD")).catch(() => null);
    return head?.isFile() ? dotGit : null;
  }
  if (!stat.isFile()) return null;
  const pointer = /^gitdir:\s*(.+)$/u.exec((await pointerLine(dotGit)) ?? "")?.[1];
  if (pointer === undefined) return null;
  const admin = await realpath(NodePath.resolve(top, pointer));
  if (admin === null || NodePath.basename(NodePath.dirname(admin)) !== "worktrees") return null;
  const common = await realpath(NodePath.dirname(NodePath.dirname(admin)));
  if (common === null) return null;
  const commondir = await pointerLine(NodePath.join(admin, "commondir"));
  if (commondir !== null && (await realpath(NodePath.resolve(admin, commondir))) !== common) {
    return null;
  }
  const back = await pointerLine(NodePath.join(admin, "gitdir"));
  if (back === null || (await realpath(NodePath.resolve(admin, back))) !== dotGit) return null;
  return common;
}

/**
 * Whether `candidate` is the top of a checkout of the same repository as the
 * top of one of `roots`. A folder inside a checkout, or a root that is not a
 * checkout's top, matches nothing.
 */
export async function sameRepositoryCheckout(
  candidate: string,
  roots: ReadonlyArray<string>,
): Promise<boolean> {
  const common = await withinCheckTime(candidate, () => checkoutCommonDir(candidate), null);
  if (common === null) return false;
  for (const root of roots) {
    if ((await checkoutCommonDir(root)) === common) return true;
  }
  return false;
}

/** Listed checkouts by common directory, valid briefly while its `worktrees` folder is unchanged. */
const listed = new Map<
  string,
  { readonly stamp: string; readonly at: number; readonly tops: ReadonlyArray<string> }
>();

/** The tops of one repository's checkouts: its main checkout, then its linked worktrees by path. */
async function checkoutsOf(common: string): Promise<ReadonlyArray<string>> {
  const worktrees = NodePath.join(common, "worktrees");
  const stat = await NodeFSP.stat(worktrees).catch(() => null);
  const stamp = stat === null ? "none" : `${stat.mtimeMs}:${stat.ino}`;
  const cached = listed.get(common);
  if (cached?.stamp === stamp && Date.now() - cached.at < LISTING_TTL_MS) return cached.tops;
  const tops: string[] = [];
  const main = NodePath.dirname(common);
  if (NodePath.basename(common) === ".git" && (await checkoutCommonDir(main)) === common) {
    tops.push(main);
  }
  const entries = (await NodeFSP.readdir(worktrees, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted()
    .slice(0, WORKTREES_LISTED);
  const linked = await Promise.all(
    entries.map((name) =>
      withinCheckTime(
        NodePath.join(worktrees, name),
        async () => {
          const back = await pointerLine(NodePath.join(worktrees, name, "gitdir"));
          if (back === null) return null;
          const top = NodePath.dirname(NodePath.resolve(worktrees, name, back));
          const real = await realpath(top);
          return real !== null && (await checkoutCommonDir(real)) === common ? real : null;
        },
        null,
      ),
    ),
  );
  for (const top of linked.filter((entry): entry is string => entry !== null).toSorted()) {
    if (!tops.includes(top)) tops.push(top);
  }
  listed.delete(common);
  listed.set(common, { stamp, at: Date.now(), tops });
  if (listed.size > CACHED_REPOSITORIES) listed.delete(listed.keys().next().value!);
  return tops;
}

/**
 * Every checkout Git registered for the repositories whose checkout tops are
 * `roots`: each main checkout and its linked worktrees, verified both ways,
 * in a stable order (per root, the main checkout first, then by path).
 */
export async function registeredCheckouts(roots: ReadonlyArray<string>): Promise<string[]> {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const common = await checkoutCommonDir(root);
    if (common === null || seen.has(common)) continue;
    seen.add(common);
    for (const top of await checkoutsOf(common)) if (!result.includes(top)) result.push(top);
  }
  return result;
}
