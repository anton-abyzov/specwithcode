import { stringifyJson } from "../json.ts";
import { sha256 } from "../nodeCrypto.ts";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  ProjectEnvironmentError,
  ProjectEnvironmentPrepareInput,
  projectRepositoryIdentity,
  type ProjectEnvironmentReadResult,
  type ProjectId,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectAdmission from "./ProjectAdmission.ts";
import {
  describeProjectEnvironmentProblem,
  exposesProtectedRealPath,
  resolveCanonicalProjectEnvironment,
  resolveProjectEnvironmentForRun,
} from "./ProjectEnvironmentPaths.ts";
import { discoverProjectRepositories } from "./ProjectRepositoryDiscovery.ts";
import { repositoryInspectionEnv } from "./ProjectRepositoryInspection.ts";

export class ProjectEnvironmentService extends Context.Service<
  ProjectEnvironmentService,
  {
    readonly read: (input: {
      projectId: ProjectId;
      discover?: boolean | undefined;
      refresh?: boolean | undefined;
    }) => Effect.Effect<ProjectEnvironmentReadResult, ProjectEnvironmentError>;
    readonly prepare: (
      input: ProjectEnvironmentPrepareInput,
    ) => Effect.Effect<ProjectEnvironmentReadResult, ProjectEnvironmentError>;
  }
>()("specweave-studio/project/ProjectEnvironmentService") {}
/** Paths the read result can carry: a real path with control characters is only named. */
// oxlint-disable-next-line no-control-regex -- refusing control characters is the point.
const isSafePath = (value: string) => value.length <= 4096 && /^[^\x00-\x1f\x7f]+$/u.test(value);
export const make = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const admission = yield* ProjectAdmission.ProjectAdmission;
  const fail = (projectId: ProjectId, code: ProjectEnvironmentError["code"]) =>
    new ProjectEnvironmentError({ projectId, code });
  const load = Effect.fn(function* (projectId: ProjectId) {
    const found = yield* projects
      .get(projectId)
      .pipe(Effect.mapError(() => fail(projectId, "not_found")));
    if (Option.isNone(found)) return yield* fail(projectId, "not_found");
    const settings = found.value.workspaceSettings ?? DEFAULT_PROJECT_WORKSPACE_SETTINGS;
    // A canonical approval must not silently follow a newly installed symlink.
    const resolved = yield* resolveCanonicalProjectEnvironment(
      projectId,
      found.value.workspaceRoot,
      settings.environment,
    ).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    return { ...resolved, revision: settings.revision };
  });
  const git = Effect.fn(function* (projectId: ProjectId, cwd: string, args: readonly string[]) {
    const output = yield* runner
      .run({
        command: "git",
        args,
        cwd,
        env:
          args[0] === "clone"
            ? { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" }
            : repositoryInspectionEnv(),
        timeout: "120 seconds",
        maxOutputBytes: 65536,
      })
      .pipe(Effect.mapError(() => fail(projectId, "preparation_failed")));
    if (output.code !== 0 || output.timedOut || output.stdoutTruncated || output.stdoutInvalidUtf8)
      return yield* fail(projectId, "preparation_failed");
    return output.stdout.trim();
  });
  /**
   * Whether the saved path is a checkout of the entry's repository. A checkout
   * whose own origin is another valid credential-free URL reports that origin,
   * so Settings can offer to update the entry after a repository rename.
   */
  const inspectCheckout = Effect.fn(function* (
    projectId: ProjectId,
    repo: { url: string; localPath: string },
  ) {
    if (
      !(yield* fs
        .exists(repo.localPath)
        .pipe(Effect.mapError(() => fail(projectId, "path_not_approved"))))
    )
      return { status: "missing" as const };
    return yield* Effect.gen(function* () {
      // Git prints C:/ paths on Windows; resolve both sides to the native form.
      const top = yield* fs.realPath(
        yield* git(projectId, repo.localPath, ["rev-parse", "--show-toplevel"]),
      );
      const canonical = yield* fs.realPath(repo.localPath);
      if (top !== canonical) return { status: "mismatch" as const };
      const remote = yield* git(projectId, repo.localPath, [
        "config",
        "--local",
        "--get",
        "remote.origin.url",
      ]);
      const identity = projectRepositoryIdentity(remote);
      if (identity !== null && identity === projectRepositoryIdentity(repo.url))
        return { status: "ready" as const };
      // Only a URL that would itself be accepted as an entry leaves the server.
      return identity === null
        ? { status: "mismatch" as const }
        : { status: "mismatch" as const, origin: remote };
    }).pipe(Effect.orElseSucceed(() => ({ status: "mismatch" as const })));
  });
  const status = (projectId: ProjectId, repo: { url: string; localPath: string }) =>
    inspectCheckout(projectId, repo).pipe(Effect.map((checkout) => checkout.status));
  const inside = (root: string, value: string) => {
    const relative = path.relative(root, value);
    return (
      relative === "" ||
      (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
    );
  };
  /**
   * Settings lists every entry: unusable ones come back as problems instead of failing the
   * whole read, so the page can name them and offer a fix. A moved entry is offered an
   * update only when its new real path is a checkout of the same saved repository.
   */
  const read: ProjectEnvironmentService["Service"]["read"] = Effect.fn(function* ({
    projectId,
    discover,
    refresh,
  }) {
    const found = yield* projects
      .get(projectId)
      .pipe(Effect.mapError(() => fail(projectId, "not_found")));
    if (Option.isNone(found)) return yield* fail(projectId, "not_found");
    const settings = found.value.workspaceSettings ?? DEFAULT_PROJECT_WORKSPACE_SETTINGS;
    const environment = settings.environment;
    const resolved = yield* resolveProjectEnvironmentForRun(
      projectId,
      found.value.workspaceRoot,
      environment,
    ).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    if (
      (environment.additionalFolders.length > 0 || environment.repositories.length > 0) &&
      resolved.workspaceRoot !== found.value.workspaceRoot
    )
      return yield* new ProjectEnvironmentError({
        projectId,
        code: "folder_changed",
        detail: `The project folder ${found.value.workspaceRoot} now leads to ${resolved.workspaceRoot}. Move the project to its new folder before using approved folders.`,
      });
    const sameCheckout = (localPath: string, url: string) =>
      status(projectId, { url, localPath }).pipe(
        Effect.map((value) => value === "ready"),
        Effect.orElseSucceed(() => false),
      );
    const usable = [resolved.workspaceRoot, ...resolved.additionalFolders];
    const folderUpdates = new Map<string, string>();
    const problems = yield* Effect.forEach(resolved.problems, (problem) =>
      Effect.gen(function* () {
        const target = problem.resolvedPath;
        let updatePath: string | undefined;
        if (problem.kind === "folder" && problem.reason === "moved" && target !== undefined) {
          // The folder's identity is the repository saved inside it; an unrelated folder
          // is never re-pointed by a click.
          const tied = environment.repositories.filter(
            (repo) => repo.localPath !== null && inside(problem.path, repo.localPath),
          );
          // The checkout must really be inside the new folder, not linked into it from elsewhere.
          const matches = yield* Effect.forEach(tied, (repo) =>
            Effect.gen(function* () {
              const probe = path.join(target, path.relative(problem.path, repo.localPath!));
              const real = yield* fs.realPath(probe).pipe(Effect.option);
              return (
                Option.isSome(real) &&
                real.value === probe &&
                (yield* sameCheckout(probe, repo.url))
              );
            }),
          );
          if (
            matches.some(Boolean) &&
            isSafePath(target) &&
            !usable.includes(target) &&
            ![...folderUpdates.values()].includes(target) &&
            !(yield* exposesProtectedRealPath(target, path))
          ) {
            updatePath = target;
            folderUpdates.set(problem.path, target);
          }
        }
        return { problem, updatePath };
      }),
    );
    // Read from the folder at use and never saved, so a folder that gains a clone needs no migration.
    const discovery =
      discover === true
        ? yield* Effect.promise(() =>
            discoverProjectRepositories({
              projectId,
              workspaceRoot: resolved.workspaceRoot,
              saved: environment.repositories,
              refresh,
            }),
          )
        : null;
    return {
      ...(discovery === null
        ? {}
        : {
            found: discovery.found.filter((repository) => isSafePath(repository.path)),
            foundMore: discovery.foundMore,
            foundTruncated: discovery.truncated,
            rootIsRepository: discovery.rootIsRepository,
            separateClones: discovery.separateClones,
            skippedLinks: discovery.skippedLinks,
            redundantEntries: discovery.redundantEntries,
          }),
      revision: settings.revision,
      workspaceRoot: resolved.workspaceRoot,
      additionalFolders: resolved.additionalFolders,
      repositories: yield* Effect.forEach(resolved.repositories, (repo) =>
        inspectCheckout(projectId, repo).pipe(Effect.map((checkout) => ({ ...repo, ...checkout }))),
      ),
      problems: yield* Effect.forEach(problems, ({ problem, updatePath }) =>
        Effect.gen(function* () {
          let update = updatePath;
          const repo = environment.repositories.find((value) => value.id === problem.repositoryId);
          const target = problem.resolvedPath;
          // A checkout that moved with its folder lands inside a usable or updatable root.
          if (
            problem.kind === "repository" &&
            problem.reason === "outside" &&
            repo !== undefined &&
            target !== undefined &&
            isSafePath(target) &&
            [...usable, ...folderUpdates.values()].some((root) => inside(root, target)) &&
            (yield* sameCheckout(target, repo.url))
          )
            update = target;
          return {
            kind: problem.kind,
            path: problem.path,
            reason: problem.reason,
            message: describeProjectEnvironmentProblem(problem),
            ...(problem.resolvedPath === undefined ? {} : { resolvedPath: problem.resolvedPath }),
            ...(problem.repositoryId === undefined ? {} : { repositoryId: problem.repositoryId }),
            ...(update === undefined ? {} : { updatePath: update }),
          };
        }),
      ),
    };
  });
  const prepare: ProjectEnvironmentService["Service"]["prepare"] = (input) =>
    admission
      .withLock(
        input.projectId,
        Effect.gen(function* () {
          const { projectId } = input;
          if (!Schema.is(ProjectEnvironmentPrepareInput)(input))
            return yield* fail(projectId, "invalid");
          const active = yield* projects.get(projectId);
          if (Option.isNone(active)) return yield* fail(projectId, "not_found");
          if (active.value.workspaceSettings?.paused || active.value.workspaceSettings?.archived)
            return yield* fail(projectId, "inactive");
          const resolved = yield* load(projectId);
          if (resolved.revision !== input.expectedRevision)
            return yield* fail(projectId, "conflict");
          const repo = resolved.repositories.find((value) => value.id === input.repositoryId);
          if (!repo) return yield* fail(projectId, "not_found");
          const fingerprint = sha256(
            [
              stringifyJson([
                input.projectId,
                input.repositoryId,
                input.expectedRevision,
                input.commandId,
                input.mode,
                repo.url,
                repo.localPath,
              ]),
            ],
            "hex",
          );
          const prior = yield* sql<{
            fingerprint: string;
            status: string;
          }>`SELECT fingerprint,status FROM project_environment_preparations WHERE project_id=${projectId} AND command_id=${input.commandId}`;
          if (prior[0]) {
            if (prior[0].fingerprint !== fingerprint) return yield* fail(projectId, "conflict");
            if (prior[0].status !== "succeeded") return yield* fail(projectId, "outcome_unknown");
            return yield* read({ projectId });
          }
          yield* sql`INSERT INTO project_environment_preparations(project_id,command_id,fingerprint,destination,status,created_at,updated_at)
      VALUES (${projectId},${input.commandId},${fingerprint},${repo.localPath},'pending',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`;
          yield* Effect.gen(function* () {
            if (input.mode === "clone") {
              if (yield* fs.exists(repo.localPath))
                return yield* fail(projectId, "destination_exists");
              yield* fs.makeDirectory(path.dirname(repo.localPath), { recursive: true });
              const checked = yield* load(projectId);
              if (
                checked.repositories.find((value) => value.id === repo.id)?.localPath !==
                repo.localPath
              )
                return yield* fail(projectId, "path_not_approved");
              // Exclusive reservation: even an empty pre-existing destination is never overwritten.
              yield* fs.makeDirectory(repo.localPath);
              if ((yield* fs.realPath(repo.localPath)) !== repo.localPath)
                return yield* fail(projectId, "path_not_approved");
              yield* git(projectId, repo.localPath, [
                "-c",
                "core.hooksPath=/dev/null",
                "clone",
                "--",
                repo.url,
                ".",
              ]);
            }
            if ((yield* status(projectId, repo)) !== "ready")
              return yield* fail(projectId, "repository_mismatch");
            yield* sql`UPDATE project_environment_preparations SET status='succeeded',updated_at=CURRENT_TIMESTAMP WHERE project_id=${projectId} AND command_id=${input.commandId}`;
          }).pipe(
            Effect.catch((cause) =>
              Effect.gen(function* () {
                yield* sql`UPDATE project_environment_preparations SET status='failed',updated_at=CURRENT_TIMESTAMP WHERE project_id=${projectId} AND command_id=${input.commandId}`;
                return yield* Schema.is(ProjectEnvironmentError)(cause)
                  ? cause
                  : fail(projectId, "preparation_failed");
              }),
            ),
          );
          return yield* read({ projectId });
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          Schema.is(ProjectEnvironmentError)(cause)
            ? cause
            : fail(input.projectId, "preparation_failed"),
        ),
      );
  return ProjectEnvironmentService.of({ read, prepare });
});
export const layer = Layer.effect(ProjectEnvironmentService, make).pipe(
  Layer.provide(ProjectAdmission.layer),
);
