/**
 * `projects.threadIncrementProgressRead`: the SpecWeave increment behind each
 * listed thread of a project. Threads from another project are ignored, so a
 * caller cannot point the reader at a folder the project does not own.
 *
 * `projects.incrementsList` and `projects.threadIncrementLink` back the plan
 * card's "Link increment" picker. A link made by hand lives in Studio's own
 * database (`thread_increment_links`), never in the repository.
 *
 * In a SpecWeave project the read also lists the unplanned threads: those
 * whose turns changed files while they have no increment, no hand-made link
 * (a "none" link is "No increment needed") and no declared `specweave
 * small-fix`. Provider-native subagents are left out; their parent owns them,
 * so a child's edits count for its parent unless the run that spawned it was
 * rolled back. Threads that changed only reports, specifications or other
 * documents are listed apart, as documentation, rather than as code.
 */
import {
  ProjectWorkspaceError,
  ThreadId,
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
  isSpecweaveProject,
  linkedIncrementRoot,
  queryProjectIncrements,
  readThreadIncrementProgress,
  threadDeclaredSmallFix,
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

/** Run states after which a thread's file changes no longer grow until its next run. */
const SETTLED_RUN = new Set(["completed", "interrupted", "failed", "cancelled", "rolled_back"]);

/** What a thread's completed file changes touched: code, only documents, or nothing. */
type ChangeKind = "code" | "documentation" | null;

/**
 * Documents: a change to one is not a code change wherever it lives. Plain
 * `.txt` is not one, since `requirements.txt` and `CMakeLists.txt` are code.
 */
const DOCUMENT_EXTENSIONS = new Set(["md", "mdx", "markdown", "rst", "adoc"]);
/** What report and evidence folders hold besides documents: pages, data and captures. */
const REPORT_EXTENSIONS = new Set([
  ...DOCUMENT_EXTENSIONS,
  "txt",
  "html",
  "htm",
  "json",
  "jsonl",
  "csv",
  "log",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "pdf",
  "webm",
  "mp4",
  "b64",
]);
const REPORT_FOLDERS = new Set(["reports", "evidence"]);

/** File changes read per page while looking for the first code change. */
const FILE_CHANGE_PAGE = 25;

interface FileChangeRow {
  readonly ordinal: number;
  readonly itemId: string;
  readonly fileName: string | null;
  readonly paths: string | null;
}

/**
 * Whether a changed file is a report, specification or other document rather
 * than code: anything under `.specweave/`, a Markdown or similar document, or
 * a page, data file, text file or capture inside a `reports` or `evidence`
 * folder. A name that is not a path (no extension) counts as code. Pass a
 * path relative to the thread's checkout (see fileChangeKind), so a checkout
 * that itself lives under a folder named `reports` is not all documentation.
 */
export function isDocumentationPath(path: string): boolean {
  const segments = path.replaceAll("\\", "/").split("/").filter(Boolean);
  const folders = segments.slice(0, -1).map((segment) => segment.toLowerCase());
  const name = segments.at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return (
    folders.includes(".specweave") ||
    DOCUMENT_EXTENSIONS.has(extension) ||
    (REPORT_EXTENSIONS.has(extension) && folders.some((folder) => REPORT_FOLDERS.has(folder)))
  );
}

/** `path` relative to the longest of `roots` that holds it; unchanged outside them. */
function withinCheckout(path: string, roots: ReadonlyArray<string>): string {
  const normalized = path.replaceAll("\\", "/");
  for (const root of roots.toSorted((a, b) => b.length - a.length)) {
    const prefix = `${root.replaceAll("\\", "/").replace(/\/+$/u, "")}/`;
    if (normalized.startsWith(prefix)) return normalized.slice(prefix.length);
  }
  return normalized;
}

/**
 * One completed file_change item's kind from its `fileName` and the
 * `[path, oldPath]` pairs of its structured changes: documentation only when
 * every path it names is a document, judged relative to the thread's checkout
 * roots.
 */
export function fileChangeKind(
  fileName: string | null,
  paths: string | null,
  roots: ReadonlyArray<string> = [],
): Exclude<ChangeKind, null> {
  const named: string[] = fileName === null ? [] : [fileName];
  try {
    const pairs: unknown = paths === null ? [] : JSON.parse(paths);
    if (Array.isArray(pairs)) {
      for (const pair of pairs) {
        if (!Array.isArray(pair)) continue;
        for (const value of pair) if (typeof value === "string") named.push(value);
      }
    }
  } catch {
    return "code";
  }
  return named.length > 0 && named.every((path) => isDocumentationPath(withinCheckout(path, roots)))
    ? "documentation"
    : "code";
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

  // What a thread's file changes touched, keyed by its newest run (its last
  // turn) and that run's status, so a rollback reads again. "Code" is kept: a
  // later edit cannot undo it. "Documentation" and "nothing" are kept only once
  // that run settled and the thread has no provider-native subagent, whose
  // edits are stored under the child's own thread id and can outlive the
  // parent's run; until then a code change may still follow.
  const fileChanges = new Map<string, { readonly runKey: string; readonly kind: ChangeKind }>();

  /** One thread's own non-rolled-back file changes, newest first, until the first code change. */
  const changeKindOf = (threadId: string, roots: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      let kind: ChangeKind = null;
      let before: { readonly ordinal: number; readonly itemId: string } | null = null;
      for (;;) {
        const page: ReadonlyArray<FileChangeRow> = yield* sql<FileChangeRow>`
          SELECT item.ordinal AS ordinal, item.turn_item_id AS "itemId",
            json_extract(item.payload_json, '$.fileName') AS "fileName",
            (
              SELECT json_group_array(json_array(
                json_extract(change.value, '$.path'),
                json_extract(change.value, '$.oldPath')
              ))
              FROM json_each(item.payload_json, '$.changes') change
            ) AS paths
          FROM orchestration_v2_projection_turn_items item
          LEFT JOIN orchestration_v2_projection_runs run ON run.run_id = item.run_id
          WHERE item.thread_id = ${threadId}
            AND item.type = 'file_change' AND item.status = 'completed'
            AND (run.status IS NULL OR run.status <> 'rolled_back')
            AND (
              item.ordinal < ${before?.ordinal ?? Number.MAX_SAFE_INTEGER}
              OR (item.ordinal = ${before?.ordinal ?? Number.MAX_SAFE_INTEGER}
                AND item.turn_item_id < ${before?.itemId ?? ""})
            )
          ORDER BY item.ordinal DESC, item.turn_item_id DESC
          LIMIT ${FILE_CHANGE_PAGE}
        `;
        for (const item of page) {
          if (fileChangeKind(item.fileName, item.paths, roots) === "code") return "code" as const;
          kind = "documentation";
        }
        const last: FileChangeRow | undefined = page.at(-1);
        if (last === undefined || page.length < FILE_CHANGE_PAGE) return kind;
        before = { ordinal: last.ordinal, itemId: last.itemId };
      }
    });

  /** `rootsOf` maps each thread to the checkout folders its paths are judged against. */
  const threadsThatChangedFiles = (rootsOf: ReadonlyMap<string, ReadonlyArray<string>>) =>
    Effect.gen(function* () {
      const threadIds = [...rootsOf.keys()];
      const kinds = new Map<string, Exclude<ChangeKind, null>>();
      if (threadIds.length === 0) return kinds;
      const nativeChildren = new Set(
        (yield* sql<{ readonly threadId: string }>`
          SELECT thread_id AS "threadId" FROM orchestration_v2_projection_threads
          WHERE ${sql.in("thread_id", threadIds)}
            AND json_extract(payload_json, '$.lineage.relationshipToParent') = 'subagent'
            AND json_extract(payload_json, '$.creationSource') = 'provider'
        `).map((row) => row.threadId),
      );
      const owned = threadIds.filter((threadId) => !nativeChildren.has(threadId));
      if (owned.length === 0) return kinds;
      const lastRuns = new Map(
        (yield* sql<{
          readonly threadId: string;
          readonly runId: string;
          readonly status: string;
        }>`
          SELECT run.thread_id AS "threadId", run.run_id AS "runId", run.status AS status
          FROM orchestration_v2_projection_runs run
          WHERE run.thread_id IN ${sql.in(owned)}
            AND run.ordinal = (
              SELECT MAX(latest.ordinal) FROM orchestration_v2_projection_runs latest
              WHERE latest.thread_id = run.thread_id
            )
        `).map((row) => [row.threadId, row]),
      );
      const runKeyOf = (run: { readonly runId: string; readonly status: string }) =>
        `${run.runId}\u0000${run.status}`;
      const unknown: string[] = [];
      for (const threadId of owned) {
        const run = lastRuns.get(threadId);
        // No run yet, no turn: nothing changed.
        if (run === undefined) continue;
        const cached = fileChanges.get(threadId);
        if (cached?.runKey !== runKeyOf(run)) unknown.push(threadId);
        else if (cached.kind !== null) kinds.set(threadId, cached.kind);
      }
      if (unknown.length === 0) return kinds;
      // A native subagent's edits belong to the parent run that spawned it, so
      // they are undone once every run that spawned it was rolled back.
      const children = yield* sql<{
        readonly childThreadId: string;
        readonly parentThreadId: string;
        readonly undone: number;
      }>`
        SELECT child.thread_id AS "childThreadId",
          json_extract(child.payload_json, '$.lineage.parentThreadId') AS "parentThreadId",
          (
            EXISTS (
              SELECT 1 FROM orchestration_v2_projection_subagents spawn
              WHERE spawn.child_thread_id = child.thread_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM orchestration_v2_projection_subagents spawn
              LEFT JOIN orchestration_v2_projection_runs spawned ON spawned.run_id = spawn.run_id
              WHERE spawn.child_thread_id = child.thread_id
                AND (spawned.status IS NULL OR spawned.status <> 'rolled_back')
            )
          ) AS undone
        FROM orchestration_v2_projection_threads child
        WHERE json_extract(child.payload_json, '$.lineage.relationshipToParent') = 'subagent'
          AND json_extract(child.payload_json, '$.creationSource') = 'provider'
          AND json_extract(child.payload_json, '$.lineage.parentThreadId') IN ${sql.in(unknown)}
      `;
      const sourcesOf = new Map<string, string[]>(
        unknown.map((threadId) => [threadId, [threadId]]),
      );
      const withChildren = new Set<string>();
      for (const child of children) {
        withChildren.add(child.parentThreadId);
        if (!child.undone) sourcesOf.get(child.parentThreadId)?.push(child.childThreadId);
      }
      // Which of them changed anything at all, from the index alone. Edits of a
      // rolled-back run were reverted; runless items have no run to undo.
      const changed = new Set(
        (yield* sql<{ readonly threadId: string }>`
          SELECT DISTINCT item.thread_id AS "threadId"
          FROM orchestration_v2_projection_turn_items item
          LEFT JOIN orchestration_v2_projection_runs run ON run.run_id = item.run_id
          WHERE item.type = 'file_change' AND item.status = 'completed'
            AND (run.status IS NULL OR run.status <> 'rolled_back')
            AND item.thread_id IN ${sql.in([...sourcesOf.values()].flat())}
        `).map((row) => row.threadId),
      );
      for (const threadId of unknown) {
        const run = lastRuns.get(threadId)!;
        let kind: ChangeKind = null;
        for (const source of sourcesOf.get(threadId)!) {
          if (!changed.has(source)) continue;
          const own = yield* changeKindOf(source, rootsOf.get(threadId) ?? []);
          if (own !== null) kind = own;
          if (kind === "code") break;
        }
        if (kind !== null) kinds.set(threadId, kind);
        if (kind === "code" || (SETTLED_RUN.has(run.status) && !withChildren.has(threadId))) {
          fileChanges.set(threadId, { runKey: runKeyOf(run), kind });
        } else {
          fileChanges.delete(threadId);
        }
      }
      return kinds;
    });

  /**
   * The threads among `candidates` (no increment, no hand-made link) that
   * changed files without declaring a small fix: those that changed code, and
   * those whose changes were only documents. Best effort: a failed read lists
   * none rather than failing the progress read.
   */
  const unplannedOf = (candidates: ReadonlyMap<string, ReadonlyArray<string>>) =>
    Effect.gen(function* () {
      const kinds = yield* threadsThatChangedFiles(candidates);
      const undeclared = yield* Effect.promise(() =>
        Promise.all(
          [...kinds].map(async ([threadId, kind]) =>
            (await threadDeclaredSmallFix(threadId)) ? null : { threadId, kind },
          ),
        ),
      );
      const listed = (kind: Exclude<ChangeKind, null>) =>
        undeclared
          .flatMap((entry) => (entry !== null && entry.kind === kind ? [entry.threadId] : []))
          .toSorted()
          .map((threadId) => ThreadId.make(threadId));
      return { unplanned: listed("code"), documentation: listed("documentation") };
    }).pipe(Effect.orElseSucceed(() => ({ unplanned: [] as ThreadId[], documentation: [] })));

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
      const threadsRead =
        sources.length === 0 ? [] : yield* readProgress(project.workspaceRoot, sources);
      const specweave = yield* Effect.promise(() => isSpecweaveProject(project.workspaceRoot));
      if (!specweave) return { projectId: input.projectId, threads: threadsRead, specweave };
      const bound = new Set<string>(threadsRead.map((entry) => entry.threadId));
      const { unplanned, documentation } = yield* unplannedOf(
        new Map(
          sources
            .filter((source) => source.link === undefined && !bound.has(source.threadId))
            .map((source) => [
              source.threadId,
              [
                ...(source.worktreePath === null ? [] : [source.worktreePath]),
                project.workspaceRoot,
              ],
            ]),
        ),
      );
      return {
        projectId: input.projectId,
        threads: threadsRead,
        specweave,
        unplanned,
        ...(documentation.length === 0 ? {} : { documentation }),
      };
    }).pipe(asWorkspaceError(input.projectId));

  const listIncrements = (input: ProjectIncrementsListInput) =>
    Effect.gen(function* () {
      const project = yield* projectOf(input.projectId);
      const thread =
        input.threadId === undefined ? null : yield* threadOf(input.projectId, input.threadId);
      const page = yield* Effect.promise(() =>
        queryProjectIncrements(project.workspaceRoot, thread?.worktreePath ?? null, {
          ...(input.query === undefined ? {} : { query: input.query }),
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.offset === undefined ? {} : { offset: input.offset }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        }),
      );
      const link =
        input.threadId === undefined
          ? undefined
          : toTarget((yield* linksFor(input.projectId, [input.threadId])).get(input.threadId));
      return {
        projectId: input.projectId,
        ...page,
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
        // The thread's checkout, or another checkout Git registered for its repository.
        const known = yield* Effect.promise(() =>
          linkedIncrementRoot(project.workspaceRoot, thread.worktreePath, incrementId),
        );
        if (known === null) {
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
