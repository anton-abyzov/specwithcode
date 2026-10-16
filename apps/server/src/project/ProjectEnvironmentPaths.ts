import {
  ProjectEnvironmentError,
  ProjectEnvironmentSettings,
  type ProjectId,
  type ProjectRepository,
} from "@specweave-studio/contracts";
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

/**
 * An approved folder may not be the filesystem root, the home directory itself, a credential
 * folder, or any folder that contains one: approval grants every native agent read and write access.
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
  return PROTECTED_HOME_FOLDERS.some((name) => inside(folder, path.join(home, name)));
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
        exposesProtectedLocation(real, NodeOs.homedir(), path)
          ? Effect.fail(invalid())
          : Effect.succeed(real),
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
