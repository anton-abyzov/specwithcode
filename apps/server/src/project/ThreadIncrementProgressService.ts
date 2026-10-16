/**
 * `projects.threadIncrementProgressRead`: the SpecWeave increment behind each
 * listed thread of a project. Threads from another project are ignored, so a
 * caller cannot point the reader at a folder the project does not own.
 *
 * `projects.incrementsList` and `projects.threadIncrementLink` back the plan
 * card's "Link increment" picker. A link made by hand lives in Studio's own
 * database (`thread_increment_links`), never in the repository.
 */
import {
  ProjectWorkspaceError,
  type ProjectIncrementsListInput,
  type ProjectIncrementsListResult,
  type ThreadIncrementLinkInput,
  type ThreadIncrementLinkResult,
  type ThreadIncrementLinkTarget,
  type ThreadIncrementProgressInput,
  type ThreadIncrementProgressSnapshot,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import {
  listProjectIncrements,
  readThreadIncrementProgress,
  type ThreadIncrementSource,
} from "./ThreadIncrementProgress.ts";

export class ThreadIncrementProgressService extends Context.Service<
  ThreadIncrementProgressService,
  {
    readonly read: (
      input: ThreadIncrementProgressInput,
    ) => Effect.Effect<ThreadIncrementProgressSnapshot, ProjectWorkspaceError>;
    readonly listIncrements: (
      input: ProjectIncrementsListInput,
    ) => Effect.Effect<ProjectIncrementsListResult, ProjectWorkspaceError>;
    readonly link: (
      input: ThreadIncrementLinkInput,
    ) => Effect.Effect<ThreadIncrementLinkResult, ProjectWorkspaceError>;
  }
>()("specweave-studio/project/ThreadIncrementProgressService") {}

interface LinkRow {
  readonly threadId: string;
  readonly incrementId: string | null;
}

const toTarget = (row: LinkRow | undefined): ThreadIncrementLinkTarget | undefined =>
  row === undefined
    ? undefined
    : row.incrementId === null
      ? { type: "none" }
      : { type: "increment", incrementId: row.incrementId };

export const make = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;

  const projectOf = (projectId: ThreadIncrementProgressInput["projectId"]) =>
    projects
      .get(projectId)
      .pipe(
        Effect.flatMap((project) =>
          Option.isNone(project)
            ? Effect.fail(new ProjectWorkspaceError({ code: "not_found", projectId }))
            : Effect.succeed(project.value),
        ),
      );

  const threadOf = (
    projectId: ThreadIncrementProgressInput["projectId"],
    threadId: ThreadIncrementLinkInput["threadId"],
  ) =>
    projections
      .getThreadShell(threadId)
      .pipe(
        Effect.flatMap((thread) =>
          thread === null || thread.projectId !== projectId
            ? Effect.fail(new ProjectWorkspaceError({ code: "not_found", projectId }))
            : Effect.succeed(thread),
        ),
      );

  const linksFor = (projectId: string, threadIds: ReadonlyArray<string>) =>
    threadIds.length === 0
      ? Effect.succeed(new Map<string, LinkRow>())
      : sql<LinkRow>`SELECT thread_id AS "threadId", increment_id AS "incrementId" FROM thread_increment_links WHERE project_id = ${projectId} AND ${sql.in("thread_id", threadIds)}`.pipe(
          Effect.map((rows) => new Map(rows.map((row) => [row.threadId, row]))),
        );

  const asWorkspaceError =
    (projectId: ThreadIncrementProgressInput["projectId"]) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError((error) =>
          Schema.is(ProjectWorkspaceError)(error)
            ? error
            : new ProjectWorkspaceError({ code: "operation_failed", projectId }),
        ),
      );

  const read = (input: ThreadIncrementProgressInput) =>
    Effect.gen(function* () {
      const project = yield* projectOf(input.projectId);
      const ids = [...new Set(input.threadIds)];
      const links = yield* linksFor(input.projectId, ids);
      const sources: ThreadIncrementSource[] = [];
      for (const threadId of ids) {
        const thread = yield* projections.getThreadShell(threadId);
        if (thread === null || thread.projectId !== input.projectId) continue;
        const link = links.get(threadId);
        sources.push({
          threadId,
          title: thread.title,
          branch: thread.branch,
          worktreePath: thread.worktreePath,
          ...(link === undefined ? {} : { link: { incrementId: link.incrementId } }),
        });
      }
      const threads =
        sources.length === 0
          ? []
          : yield* Effect.promise(() =>
              readThreadIncrementProgress(project.workspaceRoot, sources),
            );
      return { projectId: input.projectId, threads };
    }).pipe(asWorkspaceError(input.projectId));

  const listIncrements = (input: ProjectIncrementsListInput) =>
    Effect.gen(function* () {
      const project = yield* projectOf(input.projectId);
      const thread =
        input.threadId === undefined ? null : yield* threadOf(input.projectId, input.threadId);
      const increments = yield* Effect.promise(() =>
        listProjectIncrements(project.workspaceRoot, thread?.worktreePath ?? null),
      );
      const link =
        input.threadId === undefined
          ? undefined
          : toTarget((yield* linksFor(input.projectId, [input.threadId])).get(input.threadId));
      return {
        projectId: input.projectId,
        increments,
        ...(link === undefined ? {} : { link }),
      };
    }).pipe(asWorkspaceError(input.projectId));

  const link = (input: ThreadIncrementLinkInput) =>
    Effect.gen(function* () {
      const project = yield* projectOf(input.projectId);
      const thread = yield* threadOf(input.projectId, input.threadId);
      if (input.link.type === "auto") {
        yield* sql`DELETE FROM thread_increment_links WHERE thread_id = ${input.threadId}`;
        return input;
      }
      const incrementId = input.link.type === "increment" ? input.link.incrementId : null;
      if (incrementId !== null) {
        const known = yield* Effect.promise(() =>
          listProjectIncrements(project.workspaceRoot, thread.worktreePath),
        );
        if (!known.some((increment) => increment.incrementId === incrementId)) {
          return yield* new ProjectWorkspaceError({
            code: "not_found",
            projectId: input.projectId,
          });
        }
      }
      const linkedAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`INSERT INTO thread_increment_links (thread_id, project_id, increment_id, linked_at) VALUES (${input.threadId}, ${input.projectId}, ${incrementId}, ${linkedAt}) ON CONFLICT(thread_id) DO UPDATE SET project_id = excluded.project_id, increment_id = excluded.increment_id, linked_at = excluded.linked_at`;
      return input;
    }).pipe(asWorkspaceError(input.projectId));

  return ThreadIncrementProgressService.of({ read, listIncrements, link });
});

export const layer = Layer.effect(ThreadIncrementProgressService, make);
