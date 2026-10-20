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
  type ThreadIncrementProgress,
  type ThreadIncrementProgressInput,
  type ThreadIncrementProgressSnapshot,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
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

/**
 * Every open plan card polls the same threads, so identical reads share one
 * pass over the SpecWeave folders while it runs and for this long after.
 */
const PROGRESS_READ_TTL_MS = 5_000;

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

  const summariesOf = (
    projectId: ThreadIncrementProgressInput["projectId"],
    threadIds: ThreadIncrementProgressInput["threadIds"],
  ) =>
    projections.getThreadSummaries !== undefined
      ? projections.getThreadSummaries(projectId, threadIds)
      : Effect.forEach(threadIds, (threadId) => projections.getThreadShell(threadId)).pipe(
          Effect.map((shells) =>
            shells.flatMap((thread) =>
              thread === null || thread.projectId !== projectId ? [] : [thread],
            ),
          ),
        );

  // Everything the folder read depends on, so a new title, branch or link is never served stale.
  const progressReadKey = (
    workspaceRoot: string,
    sources: ReadonlyArray<ThreadIncrementSource>,
  ): string =>
    [
      workspaceRoot,
      ...sources.map((source) =>
        [
          source.threadId,
          source.title ?? "",
          source.branch ?? "",
          source.worktreePath ?? "",
          source.link === undefined ? "auto" : `link:${source.link.incrementId ?? ""}`,
          source.home ?? "",
        ].join("\u0001"),
      ),
    ].join("\u0000");
  // Keyed by everything the read depends on, so a new link or branch reads again.
  // A pending read is always shared; the TTL counts from when it settled, so a
  // slow pass is not started again by every poll that arrives while it runs.
  const progressReads = new Map<
    string,
    { settledAt: number | undefined; readonly result: Promise<ThreadIncrementProgress[]> }
  >();
  const readProgress = (workspaceRoot: string, sources: ReadonlyArray<ThreadIncrementSource>) =>
    Effect.gen(function* () {
      const clock = yield* Clock.clockWith(Effect.succeed);
      const now = clock.currentTimeMillisUnsafe();
      for (const [key, entry] of progressReads) {
        if (entry.settledAt !== undefined && now - entry.settledAt >= PROGRESS_READ_TTL_MS) {
          progressReads.delete(key);
        }
      }
      const key = progressReadKey(workspaceRoot, sources);
      const shared = progressReads.get(key);
      if (shared !== undefined) return yield* Effect.promise(() => shared.result);
      const result = readThreadIncrementProgress(workspaceRoot, sources);
      const entry: { settledAt: number | undefined; readonly result: typeof result } = {
        settledAt: undefined,
        result,
      };
      progressReads.set(key, entry);
      result.then(
        () => {
          entry.settledAt = clock.currentTimeMillisUnsafe();
        },
        () => {
          if (progressReads.get(key) === entry) progressReads.delete(key);
        },
      );
      return yield* Effect.promise(() => result);
    });

  const read = (input: ThreadIncrementProgressInput) =>
    Effect.gen(function* () {
      const project = yield* projectOf(input.projectId);
      const ids = [...new Set(input.threadIds)].toSorted();
      const links = yield* linksFor(input.projectId, ids);
      const threads = new Map(
        (yield* summariesOf(input.projectId, ids)).map((thread) => [thread.id, thread]),
      );
      const sources: ThreadIncrementSource[] = [];
      for (const threadId of ids) {
        const thread = threads.get(threadId);
        if (thread === undefined) continue;
        const link = links.get(threadId);
        sources.push({
          threadId,
          title: thread.title,
          branch: thread.branch,
          worktreePath: thread.worktreePath,
          ...(link === undefined ? {} : { link: { incrementId: link.incrementId } }),
        });
      }
      return {
        projectId: input.projectId,
        threads: sources.length === 0 ? [] : yield* readProgress(project.workspaceRoot, sources),
      };
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
