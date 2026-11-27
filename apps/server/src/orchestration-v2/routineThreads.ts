import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Threads a routine runs in: its own thread, or an existing thread it posts
 * into. A fallback never gives such a thread a track row's Ultracode, since a
 * routine runs unattended and repeatedly (1441, 1506 D-04). A person's turns
 * in a thread a routine posts into lose it too: the stop does not say which
 * kind of turn it ended, and off is the safe side.
 * Empty without a database or on any read error.
 */
export const routineThreadIds = Effect.gen(function* () {
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  if (Option.isNone(sql)) return new Set<string>();
  return yield* sql.value<{ readonly thread_id: string }>`
    SELECT thread_id FROM scheduled_tasks WHERE thread_id IS NOT NULL
  `.pipe(
    Effect.map((rows) => new Set(rows.map((row) => row.thread_id))),
    Effect.orElseSucceed(() => new Set<string>()),
  );
});

/** True for a thread a fallback must not give a row's Ultracode: a routine's or the coordinator. */
export const skipsRowUltracode = (
  threadId: string,
  routineThreads: ReadonlySet<string>,
  project: {
    readonly workspaceSettings?:
      | { readonly coordinatorThreadId?: string | null | undefined }
      | null
      | undefined;
  },
): boolean =>
  routineThreads.has(threadId) || threadId === project.workspaceSettings?.coordinatorThreadId;
