/**
 * Who uses a folder: projects, threads, live agent sessions and live
 * terminals. One reading of the persisted owners feeds the explicit removal
 * guard, the storage cleanup sweep and `specweave-studio worktree owners`, so
 * every path that may delete a checkout agrees on what "bound" means.
 *
 * The queries read only columns the oldest V2 tables have (migration 055 made
 * `orchestration_v2_projection_runs` with `thread_id` and `status`). The CLI
 * runs the same SQL over its read-only live connection, so it never opens the
 * database any other way. Runs are read by a query of their own: a database
 * or test fixture without that table still reads every owner, and every
 * sub-chat then counts as busy.
 *
 * Sub-chats copy their parent's folder. A sub-chat in its parent's folder with
 * no run in progress takes its parent's state, so a worker with thirty finished
 * reviews is as finished as the worker itself; one with a run in progress is
 * open whatever its own state says.
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
/** Threads with a run that has not reached a final status. */
export const WORKTREE_OWNER_BUSY_SQL = `
  SELECT DISTINCT thread_id FROM orchestration_v2_projection_runs
  WHERE status IN ('preparing', 'queued', 'starting', 'running', 'waiting')
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
    /** A run in a non-final status. Rows built without it count as busy. */
    readonly busy?: number | bigint;
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
      lineage: Schema.optional(
        Schema.Struct({ parentThreadId: Schema.optional(Schema.NullOr(Schema.String)) }),
      ),
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
  /** The chat that started this one, when it is a sub-chat. */
  readonly parentThreadId?: string | null;
  /** A run of it is preparing, queued, starting, running or waiting. Unknown counts as busy. */
  readonly busy?: boolean;
  /**
   * The state cleanup acts on (`worktreeThreadState`). Absent means its own
   * state; `decodeWorktreeBindings` always sets it.
   */
  readonly effectiveState?: WorktreeThreadState;
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

/** The thread's own state, from its own record alone. */
export function ownWorktreeThreadState(owner: WorktreeThreadOwner): WorktreeThreadState {
  if (owner.deleted) return "deleted";
  if (owner.archived) return "archived";
  return owner.settled ? "settled" : "open";
}

/**
 * The state every remover acts on: a sub-chat in its parent's folder follows
 * its parent unless it is busy (see `decodeWorktreeBindings`).
 */
export function worktreeThreadState(owner: WorktreeThreadOwner): WorktreeThreadState {
  return owner.effectiveState ?? ownWorktreeThreadState(owner);
}

/** Open by its effective state: its folder is never removed for being finished. */
export const isOpenThreadOwner = (owner: WorktreeThreadOwner): boolean =>
  worktreeThreadState(owner) === "open";

/**
 * Each thread's effective state. A thread whose parent is listed, is not
 * deleted and shares one of its folder spellings follows that parent along the
 * chain; a busy one is open. A deleted thread stays deleted, a chat whose
 * parent is deleted or elsewhere keeps its own state, and a cycle stops at the
 * thread it would revisit.
 */
function withEffectiveStates(
  threads: ReadonlyArray<WorktreeThreadOwner>,
): ReadonlyArray<WorktreeThreadOwner> {
  const byId = new Map(threads.map((owner) => [owner.threadId, owner]));
  const resolved = new Map<string, WorktreeThreadState>();
  const resolve = (owner: WorktreeThreadOwner, visiting: Set<string>): WorktreeThreadState => {
    const known = resolved.get(owner.threadId);
    if (known !== undefined) return known;
    const own = ownWorktreeThreadState(owner);
    const parent = owner.parentThreadId == null ? undefined : byId.get(owner.parentThreadId);
    let state = own;
    if (
      !owner.deleted &&
      parent !== undefined &&
      parent !== owner &&
      !parent.deleted &&
      owner.paths.some((spelling) => parent.paths.includes(spelling))
    ) {
      if (owner.busy !== false) state = "open";
      else if (!visiting.has(parent.threadId)) {
        visiting.add(owner.threadId);
        state = resolve(parent, visiting);
      }
    }
    resolved.set(owner.threadId, state);
    return state;
  };
  return threads.map((owner) => ({ ...owner, effectiveState: resolve(owner, new Set()) }));
}

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

/**
 * Marks each thread row busy or not from `WORKTREE_OWNER_BUSY_SQL`. With no
 * reading (null), rows stay unmarked, and an unmarked row counts as busy.
 */
export function withBusyThreads(
  threads: WorktreeOwnerRows["threads"],
  busy: ReadonlyArray<{ readonly thread_id: string }> | null,
): WorktreeOwnerRows["threads"] {
  if (busy === null) return threads;
  const ids = new Set(busy.map((row) => row.thread_id));
  return threads.map((row) => ({ ...row, busy: ids.has(row.thread_id) ? 1 : 0 }));
}

export const readWorktreeOwnerRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* sql.unsafe<WorktreeOwnerRows["threads"][number]>(
    WORKTREE_OWNER_THREADS_SQL,
  );
  const busy = yield* sql
    .unsafe<{ readonly thread_id: string }>(WORKTREE_OWNER_BUSY_SQL)
    .pipe(Effect.orElseSucceed(() => null));
  return {
    projects: yield* sql.unsafe<WorktreeOwnerRows["projects"][number]>(WORKTREE_OWNER_PROJECTS_SQL),
    threads: withBusyThreads(threads, busy),
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
      parentThreadId: thread.lineage?.parentThreadId ?? null,
      busy: row.busy === undefined || Number(row.busy) !== 0,
    });
  }
  const sessions: Array<WorktreeSessionOwner> = [];
  for (const row of rows.sessions) {
    const cwd = (yield* decodeSession(row.payload_json)).cwd;
    const paths = yield* pathSpellings(cwd);
    sessions.push({ kind: "session", threadId: row.thread_id, cwd, path: paths[0]!, paths });
  }
  return { projects, threads: withEffectiveStates(threads), sessions } satisfies WorktreeBindings;
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
