import { stringifyJson } from "../json.ts";
import { sha256 } from "../nodeCrypto.ts";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  ProjectEnvironmentError,
  ProjectEnvironmentPrepareInput,
  ProjectEnvironmentImportPreviewInput,
  type ProjectEnvironmentImportPreview,
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
import { resolveProjectEnvironment } from "./ProjectEnvironmentPaths.ts";
import { previewWorkspaceImport } from "./ProjectEnvironmentImport.ts";
import { repositoryInspectionEnv } from "./ProjectRepositoryInspection.ts";

export class ProjectEnvironmentService extends Context.Service<
  ProjectEnvironmentService,
  {
    readonly previewImport: (
      input: ProjectEnvironmentImportPreviewInput,
    ) => Effect.Effect<ProjectEnvironmentImportPreview, ProjectEnvironmentError>;
    readonly read: (input: {
      projectId: ProjectId;
    }) => Effect.Effect<ProjectEnvironmentReadResult, ProjectEnvironmentError>;
    readonly prepare: (
      input: ProjectEnvironmentPrepareInput,
    ) => Effect.Effect<ProjectEnvironmentReadResult, ProjectEnvironmentError>;
  }
>()("specweave-studio/project/ProjectEnvironmentService") {}
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
    const resolved = yield* resolveProjectEnvironment(
      projectId,
      found.value.workspaceRoot,
      settings.environment,
    ).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    // A canonical approval must not silently follow a newly installed symlink.
    if (
      ((settings.environment.additionalFolders.length > 0 ||
        settings.environment.repositories.length > 0) &&
        resolved.workspaceRoot !== found.value.workspaceRoot) ||
      resolved.additionalFolders.some(
        (folder, index) => folder !== settings.environment.additionalFolders[index],
      )
    )
      return yield* fail(projectId, "path_not_approved");
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
  const status = Effect.fn(function* (
    projectId: ProjectId,
    repo: { url: string; localPath: string },
  ) {
    if (
      !(yield* fs
        .exists(repo.localPath)
        .pipe(Effect.mapError(() => fail(projectId, "path_not_approved"))))
    )
      return "missing" as const;
    const match = yield* Effect.gen(function* () {
      const top = yield* git(projectId, repo.localPath, ["rev-parse", "--show-toplevel"]);
      const canonical = yield* fs.realPath(repo.localPath);
      if (top !== canonical) return false;
      const remote = yield* git(projectId, repo.localPath, [
        "config",
        "--local",
        "--get",
        "remote.origin.url",
      ]);
      return projectRepositoryIdentity(remote) === projectRepositoryIdentity(repo.url);
    }).pipe(Effect.catch(() => Effect.succeed(false)));
    return match ? ("ready" as const) : ("mismatch" as const);
  });
  const read: ProjectEnvironmentService["Service"]["read"] = Effect.fn(function* ({ projectId }) {
    const resolved = yield* load(projectId);
    return {
      ...resolved,
      repositories: yield* Effect.forEach(resolved.repositories, (repo) =>
        status(projectId, repo).pipe(Effect.map((value) => ({ ...repo, status: value }))),
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
            "hex");
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
  const previewImport: ProjectEnvironmentService["Service"]["previewImport"] = (input) =>
    admission
      .withLock(
        input.projectId,
        Effect.gen(function* () {
          const { projectId } = input;
          if (!Schema.is(ProjectEnvironmentImportPreviewInput)(input))
            return yield* fail(projectId, "invalid");
          const found = yield* projects.get(input.projectId);
          if (Option.isNone(found)) return yield* fail(input.projectId, "not_found");
          const settings = found.value.workspaceSettings ?? DEFAULT_PROJECT_WORKSPACE_SETTINGS;
          return yield* previewWorkspaceImport({
            ...input,
            workspaceRoot: found.value.workspaceRoot,
            revision: settings.revision,
            environment: settings.environment,
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.provideService(ProcessRunner.ProcessRunner, runner),
          );
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          error instanceof ProjectEnvironmentError ? error : fail(input.projectId, "invalid"),
        ),
      );
  return ProjectEnvironmentService.of({ read, prepare, previewImport });
});
export const layer = Layer.effect(ProjectEnvironmentService, make).pipe(
  Layer.provide(ProjectAdmission.layer),
);
