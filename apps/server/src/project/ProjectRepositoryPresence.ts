// @effect-diagnostics nodeBuiltinImport:off - lstat/realpath over one project folder, like FolderLayout.
/**
 * The checkouts a project folder holds besides its own root, and whether a
 * copy of the project on this machine holds the same ones.
 *
 * The list is read from the folder itself every time, never stored: whatever
 * checkout is in the folder now, in any layout (an umbrella's
 * `repositories/<owner>/<name>`, `apps/api`, anything FolderLayout finds), is
 * part of the project, and one added later is picked up the next time. Each
 * checkout is named by where it sits in the folder and by its remote, so a
 * copy elsewhere is checked by repository, never by folder name.
 *
 * Code only ever moves through Git: a missing checkout is cloned from its
 * remote with this machine's own credentials, into the copy's own folder. A
 * path that leaves the folder, or holds something else, is reported and left
 * alone.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  isProjectRelativePath,
  PROJECT_NESTED_REPOSITORY_LIMIT,
  type ProjectNestedRepository,
  type ProjectRepositoriesCheckInput,
  type ProjectRepositoriesCheckResult,
  type ProjectRepositoriesReadResult,
  ProjectRepositoriesError,
  projectRepositoryIdentity,
  type ProjectRepositoryPresence,
  type Project,
  type ProjectId,
  type RepositoryIdentity,
  repositoryGroupingDisplayNameOf,
  repositoryGroupingKeyOf,
} from "@specweave-studio/contracts";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import { readFolderLayout } from "./FolderLayout.ts";
import { withRepositoryNote } from "./ProjectRepositoryNote.ts";
import * as ProjectService from "./ProjectService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

/** A large repository over a slow link takes minutes. */
const CLONE_TIMEOUT = Duration.minutes(10);

const failure = (message: string) => new ProjectRepositoriesError({ message });

/** A remote URL with any user name, password or token taken out, for showing and sending on. */
export function credentialFreeRemoteUrl(remoteUrl: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(remoteUrl)) return remoteUrl;
  try {
    const url = new URL(remoteUrl);
    const keepUser = url.protocol === "ssh:" || url.protocol === "git+ssh:";
    if (!keepUser) url.username = "";
    url.password = "";
    url.search = "";
    return url.toString();
  } catch {
    return remoteUrl;
  }
}

/** "clone" for a `.git` folder, "linked" for a `.git` file (a worktree or submodule), else null. */
const checkoutKind = (folder: string) =>
  NodeFSP.lstat(NodePath.join(folder, ".git")).then(
    (stat) => (stat.isDirectory() ? "clone" : stat.isFile() ? "linked" : null),
    () => null,
  );

const within = (root: string, candidate: string) => {
  const relative = NodePath.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
};

/** What a repository is called in the list: "owner/name", else its folder's name. */
const nameOf = (identity: RepositoryIdentity, path: string) =>
  repositoryGroupingDisplayNameOf(identity) ?? path.split("/").at(-1) ?? path;

/** The URL another machine clones: a fork's own remote, else the repository's. */
const cloneUrlOf = (identity: RepositoryIdentity) =>
  credentialFreeRemoteUrl(identity.origin?.remoteUrl ?? identity.locator.remoteUrl);

/**
 * Whether `identity` is the repository `entry` names. A fork and the
 * repository it forked are different: workers push to the checkout's own remote.
 */
export const sameRepository = (identity: RepositoryIdentity, entry: ProjectNestedRepository) =>
  repositoryGroupingKeyOf(identity) === entry.key;

/**
 * Destinations this server is cloning now. A second launch never clones into
 * one, and never mistakes the half-done clone there for a finished checkout.
 */
const cloning = new Set<string>();

const readProject = (projectId: ProjectId) =>
  Effect.gen(function* () {
    const projects = yield* ProjectService.ProjectService;
    const project = yield* projects.getById(projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.mapError(() => failure("The project could not be read.")),
    );
    if (project === undefined || project.deletedAt !== null)
      return yield* failure("The project was not found.");
    return project;
  });

/**
 * The separate clones inside a project's folder (a `.git` folder, so not a
 * worktree or submodule, which come with their own repository), each with
 * the remote another machine would clone. A clone with no remote is listed
 * apart: nothing elsewhere can get it.
 */
export const listNestedRepositories = Effect.fn("ProjectRepositoryPresence.list")(function* (
  project: Pick<Project, "id" | "workspaceRoot">,
) {
  const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const layout = yield* Effect.promise(() => readFolderLayout(project.workspaceRoot));
  if (layout === null) return yield* failure("The project folder is not on this machine.");
  const root = yield* Effect.promise(() =>
    NodeFSP.realpath(project.workspaceRoot).catch(() => project.workspaceRoot),
  );
  const repositories: ProjectNestedRepository[] = [];
  const withoutRemote: string[] = [];
  for (const path of layout.repositories) {
    if (!isProjectRelativePath(path)) continue;
    const folder = NodePath.join(root, ...path.split("/"));
    if ((yield* Effect.promise(() => checkoutKind(folder))) !== "clone") continue;
    const identity = yield* identities.resolve(folder);
    // Only a network remote can be cloned on another machine.
    if (identity === null || projectRepositoryIdentity(cloneUrlOf(identity)) === null) {
      withoutRemote.push(path);
      continue;
    }
    if (repositories.length >= PROJECT_NESTED_REPOSITORY_LIMIT) continue;
    repositories.push({
      path,
      remoteUrl: cloneUrlOf(identity),
      key: repositoryGroupingKeyOf(identity),
      name: nameOf(identity, path),
    });
  }
  return {
    projectId: project.id,
    repositories,
    withoutRemote: withoutRemote.slice(0, PROJECT_NESTED_REPOSITORY_LIMIT),
    truncated:
      layout.truncated ||
      layout.repositoryCount > layout.repositories.length ||
      repositories.length + withoutRemote.length > PROJECT_NESTED_REPOSITORY_LIMIT,
  } satisfies ProjectRepositoriesReadResult;
});

/**
 * The project's repositories: the clones in its folder here, with the ones
 * its `repositories.md` note names that this folder lacks, and the note
 * brought up to date so every linked copy has the list.
 */
export const listProjectRepositories = Effect.fn("ProjectRepositoryPresence.listProject")(
  function* (project: Pick<Project, "id" | "workspaceRoot">) {
    const listed = yield* listNestedRepositories(project);
    const repositories = yield* withRepositoryNote(project.id, listed.repositories);
    return { ...listed, repositories } satisfies ProjectRepositoriesReadResult;
  },
);

/** `projects.repositoriesRead`: the repositories of a project on this machine. */
export const readProjectRepositories = Effect.fn("ProjectRepositoryPresence.read")(function* (
  projectId: ProjectId,
) {
  return yield* listProjectRepositories(yield* readProject(projectId));
});

/** Each repository the copy at `root` holds, by key, at the first place it is found. */
const clonesIn = (root: string) =>
  Effect.gen(function* () {
    const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
    const found = new Map<string, string>();
    const layout = yield* Effect.promise(() => readFolderLayout(root));
    for (const path of layout?.repositories ?? []) {
      if (!isProjectRelativePath(path)) continue;
      const folder = NodePath.join(root, ...path.split("/"));
      if ((yield* Effect.promise(() => checkoutKind(folder))) === null) continue;
      const identity = yield* identities.resolve(folder, { refresh: true });
      if (identity === null) continue;
      const key = repositoryGroupingKeyOf(identity);
      if (!found.has(key)) found.set(key, path);
    }
    return found;
  });

/**
 * Where `path` would be inside `root`, or null when an existing part of it is
 * a link that leads out of the folder.
 */
const placeInside = async (root: string, path: string): Promise<string | null> => {
  const target = NodePath.join(root, ...path.split("/"));
  // The deepest part that exists decides where the rest would land.
  let existing = target;
  while (existing !== root && within(root, existing)) {
    const real = await NodeFSP.realpath(existing).catch(() => null);
    if (real !== null) return within(root, real) ? target : null;
    existing = NodePath.dirname(existing);
  }
  return target;
};

const presence = (
  path: string,
  status: ProjectRepositoryPresence["status"],
  detail: string | null = null,
): ProjectRepositoryPresence => ({ path, status, detail });

/**
 * Whether this machine's copy of the project holds each checkout, by
 * repository, at the same place. With `clone`, a missing one is cloned from
 * its remote with this machine's own Git credentials; a failed clone is
 * reported and the rest go on. Nothing that is there is changed.
 */
export const checkProjectRepositories = Effect.fn("ProjectRepositoryPresence.check")(function* (
  input: ProjectRepositoriesCheckInput,
) {
  const project = yield* readProject(input.projectId);
  const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const repositories = yield* SourceControlRepositoryService.SourceControlRepositoryService;
  const platform = yield* HostProcessPlatform;
  const root = yield* Effect.promise(() =>
    NodeFSP.realpath(project.workspaceRoot).catch(() => null),
  );
  if (root === null) return yield* failure("The project folder is not on this machine.");

  const inspect = (entry: ProjectNestedRepository, folder: string) =>
    Effect.gen(function* () {
      const stat = yield* Effect.promise(() => NodeFSP.lstat(folder).catch(() => null));
      if (stat === null) return presence(entry.path, "missing");
      if (!stat.isDirectory()) return presence(entry.path, "different", "It is not a folder.");
      // An empty folder is where a clone can still go.
      const entries = yield* Effect.promise(() => NodeFSP.readdir(folder).catch(() => null));
      if (entries !== null && entries.length === 0) return presence(entry.path, "missing");
      if ((yield* Effect.promise(() => checkoutKind(folder))) === null)
        return presence(entry.path, "different", "The folder is not a Git checkout.");
      const identity = yield* identities.resolve(folder, { refresh: true });
      if (identity === null)
        return presence(entry.path, "different", "The checkout there has no remote.");
      return sameRepository(identity, entry)
        ? presence(entry.path, "present")
        : presence(
            entry.path,
            "different",
            `The checkout there is ${repositoryGroupingDisplayNameOf(identity) ?? repositoryGroupingKeyOf(identity)}.`,
          );
    });

  // A copy may keep its clones in any layout: one anywhere in it counts.
  const held = yield* clonesIn(root);
  const results: ProjectRepositoryPresence[] = [];
  const seen = new Set<string>();
  for (const entry of input.repositories) {
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    const heldAt = held.get(entry.key);
    if (heldAt !== undefined) {
      results.push(
        heldAt === entry.path
          ? presence(entry.path, "present")
          : { ...presence(entry.path, "present"), foundAt: heldAt },
      );
      continue;
    }
    const folder = yield* Effect.promise(() => placeInside(root, entry.path));
    if (folder === null) {
      results.push(presence(entry.path, "different", "That path leads out of the project folder."));
      continue;
    }
    // A local path or file URL would copy another folder of this machine in.
    if (projectRepositoryIdentity(entry.remoteUrl) === null) {
      results.push(
        presence(entry.path, "failed", "Only an HTTPS or SSH remote is cloned on another machine."),
      );
      continue;
    }
    if (cloning.has(folder)) {
      results.push(presence(entry.path, "failed", "Another clone of it is still running here."));
      continue;
    }
    if (input.clone) cloning.add(folder);
    let staging: string | undefined;
    const result = yield* Effect.gen(function* () {
      const found = yield* inspect(entry, folder);
      if (found.status !== "missing" || !input.clone) return found;

      const clone = yield* Effect.gen(function* () {
        const parent = yield* Effect.tryPromise(async () => {
          const directory = NodePath.dirname(folder);
          if ((await placeInside(root, entry.path)) === null) {
            throw new Error("That path leads out of the project folder.");
          }
          await NodeFSP.mkdir(directory, { recursive: true });
          const real = await NodeFSP.realpath(directory);
          if (!within(root, real)) throw new Error("That path leads out of the project folder.");
          return real;
        });
        const stagingPath = yield* Effect.tryPromise(async () => {
          staging = await NodeFSP.mkdtemp(NodePath.join(parent, ".swc-clone-"));
          return staging;
        }).pipe(Effect.uninterruptible);
        const checkout = NodePath.join(stagingPath, "checkout");
        yield* repositories.cloneRepository(
          { remoteUrl: entry.remoteUrl, destinationPath: checkout },
          { timeoutMs: Duration.toMillis(CLONE_TIMEOUT) },
        );
        yield* Effect.tryPromise(async () => {
          if ((await NodeFSP.realpath(NodePath.dirname(folder))) !== parent) {
            throw new Error("The clone destination moved.");
          }
          const target = NodePath.join(parent, NodePath.basename(folder));
          // Windows cannot replace even an empty directory with rename.
          // rmdir refuses a checkout or a folder that has gained any files.
          try {
            const existing = await NodeFSP.lstat(target);
            if (!existing.isDirectory())
              throw new Error("The clone destination is no longer a folder.");
            if (platform !== "win32") await NodeFSP.chmod(checkout, existing.mode & 0o777);
            await NodeFSP.rmdir(target);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          await NodeFSP.rename(checkout, target);
        }).pipe(Effect.uninterruptible);
      }).pipe(Effect.result);
      if (clone._tag === "Success") return presence(entry.path, "cloned");
      const error = clone.failure;
      const detail =
        "detail" in error
          ? error.detail
          : error.cause instanceof Error
            ? error.cause.message
            : null;
      return presence(entry.path, "failed", detail || "The clone failed.");
    }).pipe(
      Effect.ensuring(
        Effect.promise(async () => {
          try {
            if (staging !== undefined)
              await NodeFSP.rm(staging, { recursive: true, force: true }).catch(() => undefined);
          } finally {
            if (input.clone) cloning.delete(folder);
          }
        }),
      ),
    );
    results.push(result);
  }
  return {
    projectId: project.id,
    workspaceRoot: root,
    results,
  } satisfies ProjectRepositoriesCheckResult;
});
