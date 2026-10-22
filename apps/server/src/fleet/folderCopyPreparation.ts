import {
  FolderCopyError,
  MachineHandoffError,
  type FolderCopyReleaseInput,
  type MachineHandoffManifest,
  type MachineHandoffPrepareResult,
  type ProjectCoordinatorBinding,
  type ProjectId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import {
  copiedProjectFolder,
  resolveCopyScope,
  verifyCopiedProjectFolder,
  validProjectRelativePath,
} from "./folderCopyScope.ts";
import { attempt, folderCopyManifestRepositories } from "./FolderCopyHandoff.ts";
import type { DestinationCopies } from "./folderTransfer/destinationService.ts";
import type { SourceTransfers } from "./folderTransfer/sourceService.ts";

const isHandoffError = Schema.is(MachineHandoffError);

export const ACTIVE_COPY_WARNING =
  "Work is still running in this folder. You can copy now, but files may change during the copy and later edits are not included. Transferring coordinator context waits until this work stops.";

export const makeProjectIdleCheck =
  (sql: SqlClient.SqlClient, fs: FileSystem.FileSystem, path: Path.Path) =>
  (id: ProjectId, root: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        projectId: string;
        workspaceRoot: string;
        worktreePath: string | null;
      }>`
      SELECT DISTINCT t.project_id AS "projectId", p.workspace_root AS "workspaceRoot",
        json_extract(t.payload_json, '$.worktreePath') AS "worktreePath"
      FROM orchestration_v2_projection_threads t JOIN projection_projects p ON p.project_id=t.project_id
      WHERE EXISTS (SELECT 1 FROM orchestration_v2_projection_runs r WHERE r.thread_id=t.thread_id AND r.status NOT IN ('completed','interrupted','failed','cancelled','rolled_back'))
      OR EXISTS (SELECT 1 FROM orchestration_v2_projection_runtime_requests r WHERE r.thread_id=t.thread_id AND r.status='pending')
      OR EXISTS (SELECT 1 FROM orchestration_v2_effect_outbox e WHERE e.thread_id=t.thread_id AND (e.status IS NULL OR e.status NOT IN ('succeeded','failed','cancelled')))
      OR EXISTS (SELECT 1 FROM orchestration_v2_projection_provider_sessions s WHERE s.thread_id=t.thread_id AND s.status IN ('running','working','connecting','starting'))
    `;
      const normalized = (value: string) =>
        fs.realPath(value).pipe(Effect.orElseSucceed(() => path.resolve(value)));
      const left = yield* normalized(root);
      const overlaps = (right: string) =>
        left === right ||
        left.startsWith(`${right}${path.sep}`) ||
        right.startsWith(`${left}${path.sep}`);
      for (const row of rows) {
        if (
          row.projectId === id ||
          overlaps(yield* normalized(row.workspaceRoot)) ||
          (row.worktreePath && overlaps(yield* normalized(row.worktreePath)))
        )
          return yield* new MachineHandoffError({ code: "busy" });
      }
    }).pipe(
      Effect.mapError((cause) =>
        isHandoffError(cause) ? cause : new MachineHandoffError({ code: "storage_failed" }),
      ),
    );

/** The manifest a folder-copy handoff carries: repositories and heads from the offered scan. */
export const makeFolderCopyManifest =
  (
    sources: SourceTransfers,
    idle?: (id: ProjectId, root: string) => Effect.Effect<void, MachineHandoffError>,
  ) =>
  (
    operationId: string,
    projectId: ProjectId,
    destinationEnvironmentId: string,
    workspaceRoot: string,
  ) =>
    Effect.gen(function* () {
      const record = yield* Effect.tryPromise({
        try: () => sources.read(operationId),
        catch: () => new MachineHandoffError({ code: "storage_failed" }),
      });
      if (
        !record ||
        record.projectId !== projectId ||
        record.mode !== "copy-and-move" ||
        record.destinationEnvironmentId !== destinationEnvironmentId ||
        record.summary === null ||
        ["failed", "released", "cancelled"].includes(record.state)
      )
        return yield* new MachineHandoffError({ code: "invalid" });
      if (idle) yield* idle(projectId, record.folder);
      const scope = yield* Effect.tryPromise({
        try: () => resolveCopyScope(workspaceRoot, record.folder),
        catch: () => new MachineHandoffError({ code: "source_changed" }),
      });
      if (scope.projectRelativePath !== (record.projectRelativePath ?? "."))
        return yield* new MachineHandoffError({ code: "source_changed" });
      if (record.state === "committed")
        yield* Effect.tryPromise({
          try: () => sources.assertCurrentSnapshot(operationId),
          catch: () => new MachineHandoffError({ code: "source_changed" }),
        });
      return {
        version: 1 as const,
        operationId,
        ...(record.projectRelativePath !== undefined ? { copyScope: scope } : {}),
        repositories: folderCopyManifestRepositories(operationId, record.summary),
      };
    });

/** The destination half proves its copy was applied into this exact project folder. */
export const makeAppliedFolderCopyCheck =
  (
    copies: DestinationCopies,
    fs: FileSystem.FileSystem,
    path: Path.Path,
    idle?: (id: ProjectId, root: string) => Effect.Effect<void, MachineHandoffError>,
  ) =>
  (
    operationId: string,
    projectId: ProjectId,
    sourceEnvironmentId: string,
    workspaceRoot: string,
    manifest: MachineHandoffManifest,
  ) =>
    Effect.gen(function* () {
      const record = yield* Effect.tryPromise({
        try: () => copies.read(operationId),
        catch: () => new MachineHandoffError({ code: "storage_failed" }),
      });
      const real = (value: string) =>
        fs.realPath(value).pipe(Effect.orElseSucceed(() => path.resolve(value)));
      if (
        !record ||
        record.mode !== "copy-and-move" ||
        record.state !== "applied" ||
        !record.committed ||
        record.unstable.length > 0 ||
        record.checks.some((check) => !check.ok) ||
        record.projectId !== projectId ||
        record.sourceEnvironmentId !== sourceEnvironmentId ||
        !validProjectRelativePath(record.projectRelativePath ?? ".") ||
        (record.projectRelativePath ?? ".") !== (manifest.copyScope?.projectRelativePath ?? ".") ||
        (manifest.copyScope !== undefined && record.copyRoot !== manifest.copyScope.copyRoot) ||
        (yield* real(copiedProjectFolder(record.targetFolder, record.projectRelativePath))) !==
          (yield* real(workspaceRoot))
      )
        return yield* new MachineHandoffError({ code: "conflict" });
      if (idle) yield* idle(projectId, record.targetFolder);
      yield* Effect.tryPromise({
        try: () => verifyCopiedProjectFolder(record.targetFolder, record.projectRelativePath),
        catch: () => new MachineHandoffError({ code: "conflict" }),
      });
    });

/** Never roll back ownership once publication might have reached the destination. */
export const abandonCopiedContext = (
  sources: SourceTransfers,
  input: FolderCopyReleaseInput,
  prepared: MachineHandoffPrepareResult | null,
  binding: ProjectCoordinatorBinding | undefined,
) => {
  if (
    prepared?.publication === "published" ||
    (binding?.operationId === input.operationId && binding.state !== "active")
  )
    return Effect.fail(
      new FolderCopyError({
        code: "refused",
        detail:
          "Coordinator transfer has already started. Keep this handoff open and check its destination before changing ownership.",
      }),
    );
  return attempt(() => sources.abandonContextTransfer(input.operationId, input.reason)).pipe(
    Effect.as({ projectId: input.projectId, released: false }),
  );
};

export const makeFolderCopyContextCheck = (sources: SourceTransfers) => (operationId: string) =>
  Effect.tryPromise({
    try: () => sources.assertContextAvailable(operationId),
    catch: () => new MachineHandoffError({ code: "conflict" }),
  });
