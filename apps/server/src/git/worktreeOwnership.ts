/**
 * Who uses a folder: projects, threads, live agent sessions and live
 * terminals. One reading of the persisted owners feeds the explicit removal
 * guard, the storage cleanup sweep and `specweave-studio worktree owners`, so
 * every path that may delete a checkout agrees on what "bound" means.
 *
 * The queries read only columns the oldest V2 tables have. The CLI runs the
 * same SQL over its read-only live connection, so it never opens the database
 * any other way.
 */
import type { TerminalSummary } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export const WORKTREE_OWNER_PROJECTS_SQL = `
  SELECT workspace_root FROM projection_projects WHERE deleted_at IS NULL
`;
// No archived filter: archived and idle threads still own their checkout.
// Deleted threads retain it until their durable cleanup effects have settled.
export const WORKTREE_OWNER_THREADS_SQL = `
  SELECT t.thread_id, t.payload_json, t.deleted_at, t.archived_at, EXISTS (
    SELECT 1 FROM orchestration_v2_effect_outbox failed
    WHERE failed.thread_id = t.thread_id
      AND failed.status NOT IN ('pending', 'running', 'succeeded', 'cancelled')
  ) AS cleanup_failed FROM orchestration_v2_projection_threads t
  WHERE t.deleted_at IS NULL OR EXISTS (
    SELECT 1 FROM orchestration_v2_effect_outbox e
    WHERE e.thread_id = t.thread_id AND e.status NOT IN ('succeeded', 'cancelled')
  )
`;
export const WORKTREE_OWNER_SESSIONS_SQL = `
  SELECT thread_id, payload_json FROM orchestration_v2_projection_provider_sessions
  WHERE status != 'stopped'
`;

export interface WorktreeOwnerRows {
  readonly projects: ReadonlyArray<{ readonly workspace_root: string }>;
  readonly threads: ReadonlyArray<{
    readonly thread_id: string;
    readonly payload_json: string;
    readonly deleted_at: string | null;
    readonly archived_at: string | null;
    readonly cleanup_failed: number | bigint;
  }>;
  readonly sessions: ReadonlyArray<{
    readonly thread_id: string | null;
    readonly payload_json: string;
  }>;
}

const decodeThread = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      worktreePath: Schema.NullOr(Schema.String),
      projectId: Schema.optional(Schema.String),
      title: Schema.optional(Schema.String),
      archivedAt: Schema.optional(Schema.NullOr(Schema.String)),
      settledOverride: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
);
const decodeSession = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ cwd: Schema.String })),
);

export interface WorktreeThreadOwner {
  readonly kind: "thread";
  readonly threadId: string;
  readonly projectId: string | null;
  readonly title: string | null;
  /** As the thread recorded it. */
  readonly worktreePath: string;
  /** Real path when the folder exists, else the real path of its nearest existing parent. */
  readonly path: string;
  /** Every spelling that is matched: `path` and the resolved recorded path. */
  readonly paths: ReadonlyArray<string>;
  readonly archived: boolean;
  /** Resolved by a person or an agent (`settledOverride === "settled"`). */
  readonly settled: boolean;
  readonly deleted: boolean;
  /** Deleted, and its cleanup effects have not all finished. */
  readonly cleanupPending: boolean;
  /** Deleted, and a cleanup effect failed or has an unknown status. */
  readonly cleanupFailed: boolean;
}
export interface WorktreeProjectOwner {
  readonly kind: "project";
  readonly workspaceRoot: string;
  readonly path: string;
  readonly paths: ReadonlyArray<string>;
}
export interface WorktreeSessionOwner {
  readonly kind: "session";
  readonly threadId: string | null;
  readonly cwd: string;
  readonly path: string;
  readonly paths: ReadonlyArray<string>;
}
export interface WorktreeTerminalOwner {
  readonly kind: "terminal";
  readonly threadId: string;
  readonly terminalId: string;
  readonly paths: ReadonlyArray<string>;
}

/** Every persisted owner with canonical paths, in query order. */
export interface WorktreeBindings {
  readonly projects: ReadonlyArray<WorktreeProjectOwner>;
  readonly threads: ReadonlyArray<WorktreeThreadOwner>;
  readonly sessions: ReadonlyArray<WorktreeSessionOwner>;
}

export interface WorktreeOwners extends WorktreeBindings {
  readonly terminals: ReadonlyArray<WorktreeTerminalOwner>;
}

export type WorktreeThreadState = "open" | "settled" | "archived" | "deleted";

export function worktreeThreadState(owner: WorktreeThreadOwner): WorktreeThreadState {
  if (owner.deleted) return "deleted";
  if (owner.archived) return "archived";
  return owner.settled ? "settled" : "open";
}

/** Not deleted, not archived and not resolved: its folder is never removed automatically. */
export const isOpenThreadOwner = (owner: WorktreeThreadOwner): boolean =>
  worktreeThreadState(owner) === "open";

/** The real path of an existing folder, else the resolved spelling. */
export const canonicalPath = Effect.fn("WorktreeOwnership.canonicalPath")(function* (
  value: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolved = path.resolve(value);
  // A missing folder (a deleted checkout) keeps the real path of its nearest
  // existing parent, so it still matches folders reached through a symlink.
  let existing = resolved;
  while (!(yield* fs.exists(existing))) {
    const parent = path.dirname(existing);
    if (parent === existing) return resolved;
    existing = parent;
  }
  const real = yield* fs.realPath(existing);
  return existing === resolved ? real : path.join(real, path.relative(existing, resolved));
});

/**
 * The canonical spelling first, then the resolved one when it differs. An
 * owner matches through either: the canonical one sees through symlinked
 * parents, and the resolved one keeps a missing folder behind a symlink inside
 * the target bound to that target.
 */
export const pathSpellings = Effect.fn("WorktreeOwnership.pathSpellings")(function* (
  value: string,
) {
  const path = yield* Path.Path;
  const canonical = yield* canonicalPath(value);
  const resolved = path.resolve(value);
  return canonical === resolved ? [canonical] : [canonical, resolved];
});

/** `candidate` is `root` or inside it. Both paths are canonical. */
export function pathWithin(path: Path.Path, root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

export const readWorktreeOwnerRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    projects: yield* sql.unsafe<WorktreeOwnerRows["projects"][number]>(WORKTREE_OWNER_PROJECTS_SQL),
    threads: yield* sql.unsafe<WorktreeOwnerRows["threads"][number]>(WORKTREE_OWNER_THREADS_SQL),
    sessions: yield* sql.unsafe<WorktreeOwnerRows["sessions"][number]>(WORKTREE_OWNER_SESSIONS_SQL),
  } satisfies WorktreeOwnerRows;
});

/** Decodes owner rows and canonicalizes their paths. Any unreadable row fails the whole read. */
export const decodeWorktreeBindings = Effect.fn("WorktreeOwnership.decodeBindings")(function* (
  rows: WorktreeOwnerRows,
) {
  const projects: Array<WorktreeProjectOwner> = [];
  for (const row of rows.projects) {
    const paths = yield* pathSpellings(row.workspace_root);
    projects.push({ kind: "project", workspaceRoot: row.workspace_root, path: paths[0]!, paths });
  }
  const threads: Array<WorktreeThreadOwner> = [];
  for (const row of rows.threads) {
    const thread = yield* decodeThread(row.payload_json);
    if (thread.worktreePath === null) continue;
    const deleted = row.deleted_at !== null;
    const paths = yield* pathSpellings(thread.worktreePath);
    threads.push({
      kind: "thread",
      threadId: row.thread_id,
      projectId: thread.projectId ?? null,
      title: thread.title ?? null,
      worktreePath: thread.worktreePath,
      path: paths[0]!,
      paths,
      archived: row.archived_at !== null || (thread.archivedAt ?? null) !== null,
      settled: thread.settledOverride === "settled",
      deleted,
      // The query keeps a deleted thread only while its cleanup is unfinished.
      cleanupPending: deleted,
      cleanupFailed: deleted && Number(row.cleanup_failed) !== 0,
    });
  }
  const sessions: Array<WorktreeSessionOwner> = [];
  for (const row of rows.sessions) {
    const cwd = (yield* decodeSession(row.payload_json)).cwd;
    const paths = yield* pathSpellings(cwd);
    sessions.push({ kind: "session", threadId: row.thread_id, cwd, path: paths[0]!, paths });
  }
  return { projects, threads, sessions } satisfies WorktreeBindings;
});

export const listWorktreeBindings = readWorktreeOwnerRows.pipe(
  Effect.flatMap(decodeWorktreeBindings),
);

/**
 * `within`: owners whose folder is `target` or inside it, which removing
 * `target` would delete. `overlapping` also counts owners whose folder
 * contains `target`, which removing `target` would damage.
 */
export type WorktreeOwnerMatch = "within" | "overlapping";

/**
 * The owners of one folder, in query order. `target` is its canonical path, or
 * every spelling of it from `pathSpellings`. Live terminals are passed in by
 * callers that track them.
 */
export const worktreeOwnersOf = Effect.fn("WorktreeOwnership.ownersOf")(function* (
  bindings: WorktreeBindings,
  target: string | ReadonlyArray<string>,
  options: {
    readonly match: WorktreeOwnerMatch;
    readonly terminals?: Iterable<TerminalSummary>;
  },
) {
  const path = yield* Path.Path;
  const targets = typeof target === "string" ? [target] : target;
  const bound = (owned: string) =>
    targets.some(
      (spelling) =>
        pathWithin(path, spelling, owned) ||
        (options.match === "overlapping" && pathWithin(path, owned, spelling)),
    );
  const ownsTarget = (owner: { readonly paths: ReadonlyArray<string> }) => owner.paths.some(bound);
  const terminals: Array<WorktreeTerminalOwner> = [];
  for (const terminal of options.terminals ?? []) {
    if (terminal.status !== "starting" && terminal.status !== "running") continue;
    const paths = [...(yield* pathSpellings(terminal.cwd))];
    if (terminal.worktreePath !== null)
      paths.push(...(yield* pathSpellings(terminal.worktreePath)));
    if (paths.some(bound))
      terminals.push({
        kind: "terminal",
        threadId: terminal.threadId,
        terminalId: terminal.terminalId,
        paths,
      });
  }
  return {
    projects: bindings.projects.filter(ownsTarget),
    threads: bindings.threads.filter(ownsTarget),
    sessions: bindings.sessions.filter(ownsTarget),
    terminals,
  } satisfies WorktreeOwners;
});
