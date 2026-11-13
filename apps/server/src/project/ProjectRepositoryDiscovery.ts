// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Plain promises over one project folder, like FolderLayout.
/**
 * The repositories a project's threads can use, read from the project folder
 * at use and never saved: every clone the bounded walk in FolderLayout finds
 * (a `.git` folder), joined by real path with the saved Environment
 * repositories and the ones the folder's `.specweave/config.json` lists.
 *
 * One walk is shared by the project context, launches and the Environment
 * page: the result is cached per project for 60 seconds, and read again on
 * demand ("Check again"). Git is asked only for a clone's origin and its
 * checked-out and default branch, each call bounded to 5 seconds.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  PROJECT_FOUND_REPOSITORIES_MAX,
  projectRepositoryIdentity,
  type ProjectFoundRepository,
  type ProjectRedundantRepositoryEntry,
} from "@specweave-studio/contracts";

import { readFolderLayoutWithLinks, type FolderLayoutKind } from "./FolderLayout.ts";
import { repositoryInspectionEnv } from "./ProjectRepositoryInspection.ts";

const CACHE_MS = 60_000;
const GIT_MS = 5_000;
const PARALLEL = 6;
const CONFIG_BYTES = 262_144;

export interface SavedRepositoryEntry {
  readonly id: string;
  readonly url: string;
  readonly localPath: string | null;
}

export interface ProjectRepositoryDiscovery {
  /** The project folder's real path. */
  readonly root: string;
  readonly kind: FolderLayoutKind;
  readonly rootIsRepository: boolean;
  /** The folder holds clones of their own, so a worktree of the folder would leave them out. */
  readonly separateClones: boolean;
  readonly found: ReadonlyArray<ProjectFoundRepository>;
  /** Clones in the folder that are not in `found` (the list stops at 50). */
  readonly foundMore: number;
  readonly truncated: boolean;
  readonly skippedLinks: ReadonlyArray<{ readonly path: string; readonly target: string | null }>;
  readonly redundantEntries: ReadonlyArray<ProjectRedundantRepositoryEntry>;
}

const git = (cwd: string, args: ReadonlyArray<string>): Promise<string | null> =>
  new Promise((resolve) => {
    NodeChildProcess.execFile(
      "git",
      ["-C", cwd, ...args],
      {
        cwd,
        timeout: GIT_MS,
        maxBuffer: 8192,
        env: repositoryInspectionEnv(),
        windowsHide: true,
      },
      (error, stdout) => resolve(error ? null : String(stdout).trim() || null),
    );
  });

const realpath = (value: string) => NodeFSP.realpath(value).catch(() => null);

/** "clone" for a `.git` folder, "linked" for a `.git` file, null for no checkout. */
const checkoutKind = (folder: string) =>
  NodeFSP.lstat(NodePath.join(folder, ".git")).then(
    (stat) => (stat.isDirectory() ? "clone" : stat.isFile() ? "linked" : null),
    () => null,
  );

const within = (root: string, candidate: string) => {
  const relative = NodePath.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
};

const posixRelative = (root: string, value: string) =>
  NodePath.relative(root, value).split(NodePath.sep).join("/");

/** A remote as `owner/name`: the repository identity without its host. */
export function originLabel(remoteUrl: string | null): string | null {
  if (remoteUrl === null) return null;
  const identity = projectRepositoryIdentity(remoteUrl);
  return identity === null ? null : identity.slice(identity.indexOf("/") + 1);
}

/**
 * SpecWeave's repository list: `workspace.repos`, else `umbrella.childRepos`.
 * A missing, oversized or unreadable file, or a list in another shape, is an
 * empty list, never an error.
 */
export async function readSpecweaveRepositories(
  root: string,
): Promise<ReadonlyArray<{ readonly path: string; readonly origin: string | null }>> {
  try {
    const file = NodePath.join(root, ".specweave", "config.json");
    const stat = await NodeFSP.stat(file);
    if (!stat.isFile() || stat.size > CONFIG_BYTES) return [];
    const config = JSON.parse(await NodeFSP.readFile(file, "utf8")) as {
      workspace?: { repos?: unknown };
      umbrella?: { childRepos?: unknown };
    } | null;
    const list = Array.isArray(config?.workspace?.repos)
      ? config.workspace.repos
      : Array.isArray(config?.umbrella?.childRepos)
        ? config.umbrella.childRepos
        : [];
    const entries: Array<{ path: string; origin: string | null }> = [];
    for (const entry of list.slice(0, 256)) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const path = record.path;
      if (typeof path !== "string" || path.length === 0 || path.length > 4096) continue;
      const github = (record.sync as { github?: { owner?: unknown; repo?: unknown } } | undefined)
        ?.github;
      const origin =
        typeof github?.owner === "string" && typeof github.repo === "string"
          ? `${github.owner}/${github.repo}`
          : typeof record.githubUrl === "string"
            ? originLabel(record.githubUrl)
            : null;
      entries.push({ path, origin });
    }
    return entries;
  } catch {
    return [];
  }
}

async function inParallel<A, B>(
  items: ReadonlyArray<A>,
  run: (item: A) => Promise<B>,
): Promise<Array<B>> {
  const results: Array<B> = Array.from({ length: items.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await run(items[index]!);
      }
    }),
  );
  return results;
}

async function inspectClone(folder: string) {
  const [remote, branch, originHead, worktrees] = await Promise.all([
    git(folder, ["config", "--local", "--get", "remote.origin.url"]),
    git(folder, ["symbolic-ref", "--short", "-q", "HEAD"]),
    git(folder, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]),
    // One folder per linked worktree; stale ones are pruned by Git and by removal.
    NodeFSP.readdir(NodePath.join(folder, ".git", "worktrees")).then(
      (entries) => entries.length,
      () => 0,
    ),
  ]);
  return {
    remote,
    branch,
    defaultBranch: originHead === null ? null : originHead.replace(/^origin\//u, ""),
    threadWorktrees: worktrees,
  };
}

async function discover(
  workspaceRoot: string,
  saved: ReadonlyArray<SavedRepositoryEntry>,
): Promise<ProjectRepositoryDiscovery | null> {
  const read = await readFolderLayoutWithLinks(workspaceRoot);
  if (read === null) return null;
  const { layout } = read;
  const root = (await realpath(workspaceRoot)) ?? workspaceRoot;
  const candidates = layout.repositories.map((relativePath) => ({
    relativePath,
    path: NodePath.join(root, ...relativePath.split("/")),
  }));
  // Only a clone of its own (a `.git` folder) can give a thread a worktree.
  const clones = (
    await inParallel(candidates, async (candidate) =>
      (await checkoutKind(candidate.path)) === "clone" ? candidate : null,
    )
  ).filter((candidate) => candidate !== null);
  const specweave = await readSpecweaveRepositories(root);
  const specweaveByPath = new Map<string, { path: string; origin: string | null }>();
  for (const entry of specweave) {
    if (NodePath.isAbsolute(entry.path)) continue;
    const resolved = NodePath.resolve(root, entry.path);
    if (!within(root, resolved) || resolved === root) continue;
    specweaveByPath.set((await realpath(resolved)) ?? resolved, {
      path: posixRelative(root, resolved),
      origin: entry.origin,
    });
  }
  const savedCheckouts = await inParallel(saved, async (entry) => {
    const folder = entry.localPath ?? NodePath.join(root, ".studio-repositories", entry.id);
    return { entry, folder, real: await realpath(folder) };
  });
  const found: Array<ProjectFoundRepository> = [];
  const redundant: Array<ProjectRedundantRepositoryEntry> = [];
  const listed = new Set<string>();
  const identities = new Set<string>();
  const rows = await inParallel(clones, async (clone) => ({
    clone,
    real: (await realpath(clone.path)) ?? clone.path,
    ...(await inspectClone(clone.path)),
  }));
  for (const row of rows) {
    listed.add(row.real);
    const identity = row.remote === null ? null : projectRepositoryIdentity(row.remote);
    if (identity !== null) identities.add(identity);
    const savedEntry = savedCheckouts.find((entry) => entry.real === row.real)?.entry;
    if (savedEntry !== undefined)
      redundant.push({ repositoryId: savedEntry.id, reason: "found_clone" });
    found.push({
      relativePath: row.clone.relativePath,
      path: row.clone.path,
      name: NodePath.basename(row.clone.path),
      origin: originLabel(row.remote),
      branch: row.branch,
      defaultBranch: row.defaultBranch,
      inSpecweave: specweaveByPath.has(row.real),
      state: "available",
      noRemote: row.remote === null,
      threadWorktrees: row.threadWorktrees,
      ...(savedEntry === undefined ? {} : { repositoryId: savedEntry.id }),
    });
  }
  for (const { entry, folder, real } of savedCheckouts) {
    if (real !== null && listed.has(real)) continue;
    // The project folder's own repository needs no entry: a launch names it ".".
    if (real === root && layout.rootIsRepository) {
      redundant.push({ repositoryId: entry.id, reason: "found_clone" });
      continue;
    }
    const inside = within(root, folder);
    const relativePath = inside ? posixRelative(root, folder) : folder;
    const base = {
      relativePath,
      path: folder,
      name: entry.localPath === null ? entry.id : NodePath.basename(folder),
      inSpecweave: real !== null && specweaveByPath.has(real),
      repositoryId: entry.id,
    };
    if (real !== null && (await checkoutKind(real)) !== null) {
      listed.add(real);
      const inspected = await inspectClone(real);
      found.push({
        ...base,
        origin: originLabel(inspected.remote),
        branch: inspected.branch,
        defaultBranch: inspected.defaultBranch,
        state: "available",
        noRemote: inspected.remote === null,
        threadWorktrees: inspected.threadWorktrees,
      });
      continue;
    }
    const identity = projectRepositoryIdentity(entry.url);
    // Never cloned, and a clone of the same repository is already in the folder.
    if (entry.localPath === null && identity !== null && identities.has(identity)) {
      redundant.push({ repositoryId: entry.id, reason: "no_folder" });
      continue;
    }
    listed.add(real ?? folder);
    found.push({
      ...base,
      origin: originLabel(entry.url),
      branch: null,
      defaultBranch: null,
      state: entry.localPath === null ? "absent" : "missing",
      noRemote: false,
      threadWorktrees: 0,
    });
  }
  for (const [real, entry] of specweaveByPath) {
    if (listed.has(real)) continue;
    const folder = NodePath.join(root, ...entry.path.split("/"));
    // A folder that is there but is no clone is not a repository to offer.
    if ((await NodeFSP.lstat(folder).catch(() => null)) !== null) continue;
    found.push({
      relativePath: entry.path,
      path: folder,
      name: NodePath.basename(folder),
      origin: entry.origin,
      branch: null,
      defaultBranch: null,
      inSpecweave: true,
      state: "absent",
      noRemote: entry.origin === null,
      threadWorktrees: 0,
    });
  }
  return {
    root,
    kind: layout.kind,
    rootIsRepository: layout.rootIsRepository,
    separateClones: layout.separateClones,
    found: found.slice(0, PROJECT_FOUND_REPOSITORIES_MAX),
    foundMore:
      Math.max(0, layout.repositoryCount - layout.repositories.length) +
      Math.max(0, found.length - PROJECT_FOUND_REPOSITORIES_MAX),
    truncated: layout.truncated,
    skippedLinks: read.skippedLinks,
    redundantEntries: redundant,
  };
}

const cache = new Map<
  string,
  {
    readonly key: string;
    readonly at: number;
    readonly value: Promise<ProjectRepositoryDiscovery | null>;
  }
>();

/** Forget a project's cached list, or every list. */
export function forgetProjectRepositories(projectId?: string): void {
  if (projectId === undefined) cache.clear();
  else cache.delete(projectId);
}

/**
 * The project's repositories, from the cache when it is under 60 seconds old
 * and the folder and saved entries are the same. Null when the project folder
 * is not on this machine.
 */
export function discoverProjectRepositories(input: {
  readonly projectId: string;
  readonly workspaceRoot: string;
  readonly saved?: ReadonlyArray<SavedRepositoryEntry> | undefined;
  readonly refresh?: boolean | undefined;
  readonly now?: number | undefined;
}): Promise<ProjectRepositoryDiscovery | null> {
  const saved = input.saved ?? [];
  const key = JSON.stringify([input.workspaceRoot, saved.map((e) => [e.id, e.url, e.localPath])]);
  const now = input.now ?? Date.now();
  const cached = cache.get(input.projectId);
  if (input.refresh !== true && cached?.key === key && now - cached.at < CACHE_MS)
    return cached.value;
  const value = discover(input.workspaceRoot, saved).catch(() => null);
  cache.set(input.projectId, { key, at: now, value });
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  return value;
}

/** Whether a clone has a commit a worktree can start from; a fresh `git init` has none. */
export const cloneHasCommit = (folder: string): Promise<boolean> =>
  git(folder, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]).then((sha) => sha !== null);

/** The clones a thread can get a worktree of now. */
export const availableRepositories = (discovery: ProjectRepositoryDiscovery | null) =>
  (discovery?.found ?? []).filter((repository) => repository.state === "available");

/**
 * The found repositories as lines for an agent: name, relative path, origin
 * and checked-out branch, then "and N more".
 */
export function foundRepositoryLines(discovery: ProjectRepositoryDiscovery | null): string {
  const available = availableRepositories(discovery);
  if (available.length === 0) return "";
  const lines = available.map(
    (repository) =>
      `- ${repository.name}: ${repository.relativePath} (${repository.origin ?? "no remote"}, ${
        repository.branch === null ? "no branch checked out" : `on ${repository.branch}`
      })`,
  );
  const more = discovery?.foundMore ?? 0;
  return more > 0 ? `${lines.join("\n")}\nand ${more} more` : lines.join("\n");
}

/**
 * A repository named by its path relative to the project folder: `.` is the
 * folder's own repository, anything else must be a checkout's own root inside
 * the folder (a `.git` there), never a folder inside one. A link resolves to
 * the clone it leads to. Null for any other name.
 */
export async function resolveFolderRepository(
  workspaceRoot: string,
  requested: string,
): Promise<{ readonly path: string; readonly relativePath: string } | null> {
  if (
    requested.length === 0 ||
    NodePath.isAbsolute(requested) ||
    /^[A-Za-z]:[\\/]/u.test(requested)
  )
    return null;
  const root = await realpath(workspaceRoot);
  if (root === null) return null;
  const real = await realpath(NodePath.resolve(root, requested));
  if (real === null || !within(root, real) || (await checkoutKind(real)) === null) return null;
  return { path: real, relativePath: real === root ? "." : posixRelative(root, real) };
}

/** The sentence listing the names a launch can use when it named one that is not a repository. */
export function validRepositoryNames(discovery: ProjectRepositoryDiscovery | null): string {
  const names = availableRepositories(discovery).map((repository) => repository.relativePath);
  if (discovery?.rootIsRepository) names.unshift(".");
  if (names.length === 0) return "";
  const more = discovery?.foundMore ?? 0;
  return ` Repositories in the project folder, by path: ${names.join(", ")}${more > 0 ? ` and ${more} more` : ""}.`;
}
