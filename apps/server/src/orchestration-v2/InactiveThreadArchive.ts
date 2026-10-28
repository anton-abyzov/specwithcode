import { CommandId, ThreadId } from "@specweave-studio/contracts";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerSettings from "../serverSettings.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { isInactiveArchiveCandidate } from "./InactiveThreadArchiveGuard.ts";

/** A small keyset page per minute; no transcript snapshots or unbounded scans. */
const PAGE_SIZE = 25;
const INTERVAL_MS = 60_000;
export class InactiveThreadArchive extends Context.Service<
  InactiveThreadArchive,
  {
    readonly sweep: Effect.Effect<void>;
  }
>()("specweave-studio/orchestration-v2/InactiveThreadArchive") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  let after = "";
  let lastSweep = Number.NEGATIVE_INFINITY;
  const sweep = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (now - lastSweep < INTERVAL_MS) return;
    lastSweep = now;
    const preferences = yield* settings.getSettings;
    // Keep advancing when some projects override Never, without loading a full shell snapshot.
    const rows = yield* sql<{ threadId: string }>`
      SELECT thread_id AS "threadId" FROM orchestration_v2_projection_threads
      WHERE archived_at IS NULL AND deleted_at IS NULL AND thread_id > ${after}
      ORDER BY thread_id LIMIT ${PAGE_SIZE}
    `;
    after = rows.length < PAGE_SIZE ? "" : rows.at(-1)!.threadId;
    for (const row of rows) {
      yield* Effect.gen(function* () {
        const thread = yield* projections.getThreadShell(ThreadId.make(row.threadId));
        if (thread === null) return;
        const days = resolveProjectSettings(preferences, thread.projectId).settings
          .archiveInactiveThreadsAfterDays;
        if (!isInactiveArchiveCandidate(thread, now, days)) return;
        yield* threads.dispatch({
          type: "thread.archive",
          commandId: CommandId.make(
            `inactive-archive:${thread.id}:${DateTime.toEpochMillis(thread.updatedAt)}:${now}`,
          ),
          threadId: thread.id,
          inactive: { expectedUpdatedAt: thread.updatedAt },
        });
      }).pipe(
        Effect.catch((cause) =>
          Effect.logDebug("Inactive archive skipped protected chat", {
            threadId: row.threadId,
            cause,
          }),
        ),
      );
      yield* Effect.yieldNow;
    }
  }).pipe(Effect.catch((cause) => Effect.logWarning("Inactive archive sweep failed", { cause })));
  return InactiveThreadArchive.of({ sweep });
});
export const layer = Layer.effect(InactiveThreadArchive, make);
export const layerStart = Layer.effectDiscard(
  Effect.gen(function* () {
    const archive = yield* InactiveThreadArchive;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("inactive-thread-archive", archive.sweep);
  }),
).pipe(Layer.provide(layer));
