import { MachineHandoffError, type ProjectId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import type * as SqlClient from "effect/sql/SqlClient";

import type * as ProjectAdmission from "../project/ProjectAdmission.ts";
import type * as ProjectService from "../project/ProjectService.ts";
import type * as HandoffGit from "./handoffGit.ts";
import type { HandoffGitManifest } from "./handoffGitTypes.ts";

/** The set is read again once the locks are held; a project that joined meanwhile retries. */
const ATTEMPTS = 3;

/**
 * Runs a move's receive holding the admission lock of every project that can start work in
 * the folders it touches (1326): the project itself, every project whose folder overlaps its
 * folder, and, for a Git move into an existing copy, every project rooted at, or with a
 * thread in, a repository of the copy or a linked worktree of one. Each path that starts
 * work admits through its own project's lock, so nothing starts there between the last
 * in-use check and the merge. Locks are taken in one order, so two moves cannot deadlock.
 */
export const makeExistingCopyLocks =
  (services: {
    readonly admission: ProjectAdmission.ProjectAdmission["Service"];
    readonly projects: Pick<ProjectService.ProjectService["Service"], "getById" | "snapshot">;
    readonly git: Pick<HandoffGit.HandoffGit["Service"], "existingCopyFolders">;
    readonly sql: SqlClient.SqlClient;
    readonly fs: FileSystem.FileSystem;
    readonly path: Path.Path;
  }) =>
  <A, E, R>(
    projectId: ProjectId,
    /** The manifest of a Git move into an existing copy; null for any other move. */
    manifest: HandoffGitManifest | null,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | MachineHandoffError, R> => {
    const { admission, fs, git, path, projects, sql } = services;
    const storage = <B, E2, R2>(read: Effect.Effect<B, E2, R2>) =>
      read.pipe(Effect.mapError(() => new MachineHandoffError({ code: "storage_failed" })));
    const real = (folder: string) =>
      fs.realPath(folder).pipe(Effect.orElseSucceed(() => path.resolve(folder)));
    const participants = Effect.gen(function* () {
      const ids = new Set([projectId]);
      const found = yield* storage(projects.getById(projectId));
      if (Option.isNone(found)) return ids;
      const root = found.value.workspaceRoot;
      const folders = yield* Effect.forEach(
        manifest === null
          ? [root]
          : yield* git.existingCopyFolders({ workspaceRoot: root, manifest }),
        real,
      );
      const overlaps = (other: string) =>
        folders.some(
          (own) =>
            own === other ||
            own.startsWith(`${other}${path.sep}`) ||
            other.startsWith(`${own}${path.sep}`),
        );
      for (const other of (yield* storage(projects.snapshot)).projects)
        if (overlaps(yield* real(other.workspaceRoot))) ids.add(other.id);
      if (manifest === null) return ids;
      // A thread's worktree may sit outside its project's folder.
      const rows = yield* storage(
        sql<{ projectId: ProjectId | null; worktreePath: string | null }>`
          SELECT DISTINCT t.project_id AS "projectId",
            json_extract(t.payload_json, '$.worktreePath') AS "worktreePath"
          FROM orchestration_v2_projection_threads t
          WHERE json_extract(t.payload_json, '$.worktreePath') IS NOT NULL
        `,
      );
      const resolved = new Map<string, string>();
      for (const row of rows) {
        if (!row.projectId || !row.worktreePath || ids.has(row.projectId)) continue;
        const folder = resolved.get(row.worktreePath) ?? (yield* real(row.worktreePath));
        resolved.set(row.worktreePath, folder);
        if (overlaps(folder)) ids.add(row.projectId);
      }
      return ids;
    });
    const attempt = (left: number): Effect.Effect<A, E | MachineHandoffError, R> =>
      Effect.gen(function* () {
        const ids = yield* participants;
        const held = yield* [...ids]
          .sort()
          .reduceRight<Effect.Effect<Option.Option<A>, E | MachineHandoffError, R>>(
            (inner, id) => admission.withLock(id, inner),
            Effect.gen(function* () {
              const now = yield* participants;
              if ([...now].some((id) => !ids.has(id))) return Option.none();
              return Option.some(yield* effect);
            }),
          );
        if (Option.isSome(held)) return held.value;
        if (left <= 1) return yield* new MachineHandoffError({ code: "busy" });
        return yield* attempt(left - 1);
      });
    return attempt(ATTEMPTS);
  };
