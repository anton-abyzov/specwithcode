// @effect-diagnostics nodeBuiltinImport:off - Folder checks compare native stat identities (dev, exact bigint inode), which Effect's FileSystem does not expose.
import {
  ProjectEnvironmentError,
  ProjectEnvironmentSettings,
  type ProjectId,
  type ProjectRepository,
} from "@specweave-studio/contracts";
import * as NodeFSP from "node:fs/promises";
import * as NodeOs from "node:os";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/** Credential and app-state folders under the home directory that a project folder must never expose. */
export const PROTECTED_HOME_FOLDERS = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".config/gcloud",
  ".config/gh",
  ".netrc",
  ".claude",
  ".codex",
  ".specwithcode",
  ".specweave-studio",
  "Library/Keychains",
] as const;

type PathOps = Pick<Path.Path, "relative" | "isAbsolute" | "join" | "sep" | "parse" | "dirname">;

/**
 * A folder's filesystem identity. Two spellings of one folder share it: another letter case
 * on a case-insensitive volume, or a second mount of the same tree such as macOS's
 * `/System/Volumes/Data/Users`, which is `/Users`. `bigint` keeps large inode numbers exact
 * (`/System/Volumes/Data` has one past 2^53).
 */
const identity = (folder: string): Promise<string> =>
  NodeFSP.stat(folder, { bigint: true }).then(statIdentity);

const statIdentity = (stat: { readonly dev: bigint; readonly ino: bigint }) =>
  `${stat.dev}:${stat.ino}`;

/** Missing folders have no identity; any other failure propagates so the caller refuses. */
const ifPresent = (id: Promise<string>): Promise<string | undefined> =>
  id.catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" || error.code === "ENOTDIR" ? undefined : Promise.reject(error),
  );

const identityIfPresent = (folder: string) => ifPresent(identity(folder));

/** `folder` and each of its ancestors up to the root, nearest first. */
const lineage = (folder: string, path: PathOps): string[] => {
  const chain = [folder];
  for (let parent = path.dirname(folder); parent !== chain.at(-1); parent = path.dirname(parent))
    chain.push(parent);
  return chain;
};

/** Where macOS mounts the data volume a second time; `/Users` is also `/System/Volumes/Data/Users`. */
const DATA_VOLUME = "/System/Volumes/Data";

/**
 * The folders that hold `target` (its real path, existing): its own ancestors and, on macOS,
 * the ancestors of its data-volume alias when that alias is the same folder, so `/System`
 * and `/System/Volumes` count as holders of home.
 *
 * Known limitations: a Linux bind mount of `/` elsewhere (`/mnt/host`) has no fixed alias
 * like this; a mounted snapshot, Time Machine backup or SMB loopback mount of home has a
 * different device, so identity cannot match it; and credential folders relocated by
 * `CODEX_HOME`, `CLAUDE_CONFIG_DIR` or `XDG_CONFIG_HOME` are not guarded.
 */
const holders = async (target: string, path: PathOps): Promise<string[]> => {
  const chain = lineage(target, path);
  if (process.platform !== "darwin") return chain;
  const alias = path.join(DATA_VOLUME, target);
  const [targetId, aliasId] = await Promise.all([identity(target), identityIfPresent(alias)]);
  return aliasId === targetId ? [...chain, ...lineage(alias, path)] : chain;
};

/**
 * Whether approving `folder` would expose a protected location, judged by filesystem
 * identity rather than spelling, with `home` as the home folder. Refuses the filesystem
 * root, the home folder, any folder inside a credential folder, and any folder that holds
 * home or a credential folder. A path whose identity cannot be read is refused, except that a
 * missing home only skips the identity checks against home.
 */
export const exposesProtectedFolder = async (
  folder: string,
  home: string,
  path: PathOps,
): Promise<boolean> => {
  try {
    const real = await NodeFSP.realpath(folder);
    // A missing home holds nothing to compare by identity; the textual checks still apply.
    const homeReal = await NodeFSP.realpath(home).catch((error: NodeJS.ErrnoException) =>
      error.code === "ENOENT" ? undefined : Promise.reject(error),
    );
    const homeBase = homeReal ?? home;
    if (
      exposesProtectedLocation(folder, home, path) ||
      exposesProtectedLocation(real, homeBase, path)
    )
      return true;
    const guardedPaths = PROTECTED_HOME_FOLDERS.map((name) => path.join(homeBase, name));
    const [candidate, guarded, chain] = await Promise.all([
      identity(real),
      Promise.all(guardedPaths.map(identityIfPresent)),
      Promise.all(lineage(real, path).map(identity)),
    ]);
    // Inside a credential folder, or the folder itself, under any spelling.
    const guardedIds = new Set(guarded.filter((id): id is string => id !== undefined));
    if (chain.some((id) => guardedIds.has(id))) return true;
    // Holding home or a credential folder: walk up from each and look for the candidate.
    // Every present credential folder is walked, inside home (`~/.config` holds
    // `~/.config/gh`) or linked elsewhere.
    const guardedHolders = await Promise.all(
      guardedPaths.map((guardedPath, index) =>
        guarded[index] === undefined
          ? []
          : NodeFSP.realpath(guardedPath).then((target) => holders(target, path)),
      ),
    );
    const homeHolders = homeReal === undefined ? [] : await holders(homeReal, path);
    const anchors = new Set([...homeHolders, ...guardedHolders.flat()]);
    const anchorIds = await Promise.all([...anchors].map(identity));
    if (anchorIds.includes(candidate)) return true;
    if (homeReal === undefined) return false;
    // A second mount of the tree that holds home: the candidate holds home if home's path
    // below one of its ancestors also leads from the candidate to home itself
    // (`/System/Volumes/Data` + `Users/me` is home). `lstat` keeps a symlink named like
    // that path from counting; a real second mount is no symlink.
    const homeId = await identity(homeReal);
    const tails = lineage(homeReal, path).map((ancestor) => path.relative(ancestor, homeReal));
    const viaCandidate = await Promise.all(
      tails.map((tail) =>
        ifPresent(NodeFSP.lstat(path.join(real, tail), { bigint: true }).then(statIdentity)),
      ),
    );
    return viaCandidate.includes(homeId);
  } catch {
    return true;
  }
};

/**
 * Whether approving `folder` would expose a protected location under the current user's home.
 * See {@link exposesProtectedFolder}; never fails, and refuses what it cannot check.
 */
export const exposesProtectedRealPath = (folder: string, path: PathOps) =>
  Effect.promise(() => exposesProtectedFolder(folder, NodeOs.homedir(), path));

/**
 * The approved folder that already reaches `folder`, by filesystem identity: `same` when it
 * is that folder, otherwise `folder` is inside it. Identity holds across letter case and
 * second mounts without refusing distinct folders on a case-sensitive volume. An approved
 * folder that no longer exists reaches nothing. Rejects when `folder` cannot be read.
 */
export const approvedFolderReaching = async (
  folder: string,
  approved: ReadonlyArray<string>,
  path: PathOps,
): Promise<{ readonly folder: string; readonly same: boolean } | undefined> => {
  const chain = await Promise.all(lineage(folder, path).map(identity));
  const approvedIds = await Promise.all(approved.map(identityIfPresent));
  for (const [index, id] of approvedIds.entries()) {
    if (id === undefined) continue;
    const depth = chain.indexOf(id);
    if (depth !== -1) return { folder: approved[index]!, same: depth === 0 };
  }
  return undefined;
};

/**
 * The textual part of the protected-location check: `folder` is the filesystem root, holds
 * `home`, lies inside a credential folder or holds one (`~/.config` holds `~/.config/gh`,
 * whether or not it exists yet), compared as spelled. Use
 * {@link exposesProtectedFolder} for a real folder: it also catches other spellings and mounts.
 */
export function exposesProtectedLocation(
  folder: string,
  home: string,
  path: Pick<Path.Path, "relative" | "isAbsolute" | "join" | "sep" | "parse">,
): boolean {
  const inside = (child: string, parent: string) => {
    const relative = path.relative(parent, child);
    return (
      relative === "" ||
      (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
    );
  };
  if (folder === path.parse(folder).root) return true;
  if (inside(home, folder)) return true;
  return PROTECTED_HOME_FOLDERS.some((name) => {
    const guarded = path.join(home, name);
    return inside(folder, guarded) || inside(guarded, folder);
  });
}

/** Resolve existing ancestors as well as the final component; lexical containment alone is unsafe. */
export const resolveProjectEnvironment = Effect.fn("resolveProjectEnvironment")(function* (
  projectId: ProjectId,
  workspaceRoot: string,
  environment: ProjectEnvironmentSettings,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const invalid = () => new ProjectEnvironmentError({ projectId, code: "path_not_approved" });
  if (!Schema.is(ProjectEnvironmentSettings)(environment))
    return yield* new ProjectEnvironmentError({ projectId, code: "invalid" });
  const directory = (folder: string) =>
    Effect.gen(function* () {
      if (!path.isAbsolute(folder)) return yield* invalid();
      const real = yield* fs.realPath(folder).pipe(Effect.mapError(invalid));
      const stat = yield* fs.stat(real).pipe(Effect.mapError(invalid));
      if (stat.type !== "Directory") return yield* invalid();
      return real;
    });
  const main = yield* directory(workspaceRoot);
  const additionalFolders = yield* Effect.forEach(environment.additionalFolders, (folder) =>
    directory(folder).pipe(
      Effect.flatMap((real) =>
        exposesProtectedRealPath(real, path).pipe(
          Effect.flatMap((exposed) => (exposed ? Effect.fail(invalid()) : Effect.succeed(real))),
        ),
      ),
    ),
  );
  if (new Set([main, ...additionalFolders]).size !== additionalFolders.length + 1)
    return yield* invalid();
  const roots = [main, ...additionalFolders];
  const within = (value: string) =>
    roots.some((root) => {
      const relative = path.relative(root, value);
      return (
        relative === "" ||
        (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
      );
    });
  const resolveDestination = (repo: ProjectRepository) =>
    Effect.gen(function* () {
      const requested = repo.localPath ?? path.join(main, ".studio-repositories", repo.id);
      if (!path.isAbsolute(requested)) return yield* invalid();
      let cursor = path.normalize(requested);
      const remaining: string[] = [];
      while (!(yield* fs.exists(cursor).pipe(Effect.mapError(invalid)))) {
        const parent = path.dirname(cursor);
        if (parent === cursor) return yield* invalid();
        remaining.unshift(path.basename(cursor));
        cursor = parent;
      }
      const ancestor = yield* fs.realPath(cursor).pipe(Effect.mapError(invalid));
      const localPath = path.join(ancestor, ...remaining);
      if (!within(localPath)) return yield* invalid();
      return { ...repo, localPath };
    });
  const repositories = yield* Effect.forEach(environment.repositories, resolveDestination);
  if (new Set(repositories.map((repo) => repo.localPath)).size !== repositories.length)
    return yield* invalid();
  return { workspaceRoot: main, additionalFolders, repositories };
});

/** Settings store canonical explicit approvals. Recheck at each native turn to reject moved symlinks. */
export const normalizeProjectEnvironment = Effect.fn("normalizeProjectEnvironment")(function* (
  projectId: ProjectId,
  workspaceRoot: string,
  environment: ProjectEnvironmentSettings,
) {
  const resolved = yield* resolveProjectEnvironment(projectId, workspaceRoot, environment);
  return {
    additionalFolders: resolved.additionalFolders,
    repositories: resolved.repositories.map((repo, index) => ({
      ...repo,
      localPath: environment.repositories[index]!.localPath === null ? null : repo.localPath,
    })),
  };
});
