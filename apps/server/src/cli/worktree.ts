/**
 * `specweave-studio worktree owners`: which threads use which folders, for
 * scripts that clean up worktrees. It reads the live database through the
 * same read-only connection as `db query`, so scripts never open
 * `userdata/statev2.sqlite` themselves.
 *
 * Live terminals, queued turns and background tasks exist only in the running
 * service, so they are not seen here. A folder bound to an open thread must
 * never be removed.
 *
 * A sub-chat in its parent's folder is open by its own state even when the
 * app's cleanup follows its settled parent: the cleanup also checks the live
 * state this command cannot see, so `--path` never answers "not in use" for a
 * folder the cleanup could still keep. JSON `state` is the state cleanup acts
 * on and `ownState` the thread's own.
 *
 * `--path` exit codes: 0 in use (an open thread, a project or a live agent
 * session), 1 not in use, 2 the check failed. Scripts remove a folder only on 1.
 */
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/cli";

import {
  decodeWorktreeBindings,
  isOpenThreadOwner,
  ownWorktreeThreadState,
  pathSpellings,
  WORKTREE_OWNER_BUSY_SQL,
  WORKTREE_OWNER_PROJECTS_SQL,
  WORKTREE_OWNER_SESSIONS_SQL,
  WORKTREE_OWNER_THREADS_SQL,
  withBusyThreads,
  type WorktreeOwnerRows,
  type WorktreeProjectOwner,
  type WorktreeSessionOwner,
  type WorktreeThreadOwner,
  worktreeOwnersOf,
  worktreeThreadState,
} from "../git/worktreeOwnership.ts";
import { openLiveDatabaseReadOnly } from "../persistence/liveDatabaseSnapshot.ts";
import { baseDirFlag } from "./config.ts";
import { CliDatabaseError, resolveDatabasePath } from "./db.ts";

const failure = (cause: unknown) =>
  new CliDatabaseError({ reason: cause instanceof Error ? cause.message : String(cause) });

const readOwnerRows = (dbPath: string) =>
  Effect.try({
    try: (): WorktreeOwnerRows => {
      const database = openLiveDatabaseReadOnly(dbPath);
      try {
        const all = <Row>(sql: string) => database.prepare(sql).all() as unknown as Array<Row>;
        let busy: ReadonlyArray<{ readonly thread_id: string }> | null = null;
        try {
          busy = all(WORKTREE_OWNER_BUSY_SQL);
        } catch {
          // Without a run reading every sub-chat counts as busy, the safe side.
        }
        return {
          projects: all(WORKTREE_OWNER_PROJECTS_SQL),
          threads: withBusyThreads(all(WORKTREE_OWNER_THREADS_SQL), busy),
          sessions: all(WORKTREE_OWNER_SESSIONS_SQL),
        };
      } finally {
        database.close();
      }
    },
    catch: failure,
  });

/** Open by its own state or by the state cleanup acts on, whichever is open. */
const shownState = (owner: WorktreeThreadOwner) =>
  isOpenThreadOwner(owner) ? "open" : ownWorktreeThreadState(owner);

/** Exit code when the check itself failed. Never read it as "not in use". */
export const WORKTREE_OWNERS_CHECK_FAILED = 2;

const ownerLine = (owner: WorktreeThreadOwner, json: boolean) =>
  json
    ? JSON.stringify({
        kind: "thread",
        path: owner.path,
        worktreePath: owner.worktreePath,
        threadId: owner.threadId,
        title: owner.title,
        state: worktreeThreadState(owner),
        ownState: ownWorktreeThreadState(owner),
        parentThreadId: owner.parentThreadId ?? null,
        projectId: owner.projectId,
      })
    : `${shownState(owner).padEnd(8)} ${owner.path}  ${owner.title ?? ""} (${owner.threadId})`;

const otherOwnerLine = (owner: WorktreeProjectOwner | WorktreeSessionOwner, json: boolean) =>
  owner.kind === "project"
    ? json
      ? JSON.stringify({ kind: "project", path: owner.path, workspaceRoot: owner.workspaceRoot })
      : `${"project".padEnd(8)} ${owner.path}`
    : json
      ? JSON.stringify({
          kind: "session",
          path: owner.path,
          cwd: owner.cwd,
          threadId: owner.threadId,
        })
      : `${"session".padEnd(8)} ${owner.path}  (${owner.threadId ?? "no thread"})`;

const ownersCommand = Command.make("owners", {
  baseDir: baseDirFlag,
  path: Flag.String("path").pipe(
    Flag.withDescription(
      "Check one folder. Exits 0 when an open thread uses it, inside it or around it, or a project or live agent session is inside it. Exits 1 when none does, and 2 when the check failed.",
    ),
    Flag.optional,
  ),
  json: Flag.Boolean("json").pipe(
    Flag.withDescription(
      "Print one JSON line per owner. Thread lines have path, threadId, title, state, ownState, parentThreadId and projectId.",
    ),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "List the folders threads use, and whether each thread is open, settled, archived or deleted. A thread open by its own state shows open. Live terminals, queued turns and background tasks are not seen. Never remove a folder an open thread uses.",
  ),
  Command.withHandler(
    Effect.fn("cli.worktree.owners")(
      function* (flags) {
        const dbPath = yield* resolveDatabasePath(flags.baseDir);
        const bindings = yield* decodeWorktreeBindings(yield* readOwnerRows(dbPath));
        if (Option.isNone(flags.path)) {
          for (const owner of bindings.threads) yield* Console.log(ownerLine(owner, flags.json));
          return;
        }
        const spellings = yield* pathSpellings(flags.path.value);
        // Threads count when their folder overlaps; projects and sessions when
        // removing the folder would delete theirs, as in the app's removal guard.
        const { threads } = yield* worktreeOwnersOf(bindings, spellings, { match: "overlapping" });
        const { projects, sessions } = yield* worktreeOwnersOf(bindings, spellings, {
          match: "within",
        });
        for (const owner of threads) yield* Console.log(ownerLine(owner, flags.json));
        for (const owner of [...projects, ...sessions])
          yield* Console.log(otherOwnerLine(owner, flags.json));
        if (
          !threads.some((owner) => shownState(owner) === "open") &&
          projects.length === 0 &&
          sessions.length === 0
        ) {
          if (!flags.json)
            yield* Console.log(
              `No open thread, project or live agent session uses ${spellings[0]}.`,
            );
          process.exitCode = 1;
        }
      },
      // A failed check must never look like "not in use" to a script.
      Effect.catchCause((cause) => {
        const error = Cause.squash(cause);
        return Console.error(
          `worktree owners: ${error instanceof Error ? error.message : String(error)}`,
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              process.exitCode = WORKTREE_OWNERS_CHECK_FAILED;
            }),
          ),
        );
      }),
    ),
  ),
);

export const worktreeCommand = Command.make("worktree").pipe(
  Command.withDescription(
    "Check which threads use a folder before removing it. Reads the live database safely.",
  ),
  Command.withSubcommands([ownersCommand]),
);
