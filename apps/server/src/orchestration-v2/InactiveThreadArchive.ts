import {
  CommandId,
  isProviderNativeSubagentThread,
  ProjectId,
  ThreadId,
  type ServerSettings as Preferences,
} from "@specweave-studio/contracts";
import { isPersonalAssistantProject } from "@specweave-studio/shared/personalAssistant";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerSettings from "../serverSettings.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import {
  isInactiveArchiveCandidate,
  isOverflowArchiveCandidate,
  isValidActiveThreadCap,
  OVERFLOW_IDLE_MS,
} from "./InactiveThreadArchiveGuard.ts";

/** A small keyset page per minute; no transcript snapshots or unbounded scans. */
const PAGE_SIZE = 25;
const INTERVAL_MS = 60_000;
/** Cap archives per minute, and shell reads spent finding them, so a backlog drains gently. */
const OVERFLOW_BATCH = 50;
const OVERFLOW_SCAN_LIMIT = 250;
/** The cap's minimum: smaller projects are never counted further. */
const OVERFLOW_MIN_LIVE = 20;
interface OverflowHold {
  readonly updatedAt: string;
  readonly retryAt: number;
}
export class InactiveThreadArchive extends Context.Service<
  InactiveThreadArchive,
  {
    readonly sweep: Effect.Effect<void>;
  }
>()("specweave-studio/orchestration-v2/InactiveThreadArchive") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  let after = "";
  // Per project, where the oldest-first scan resumes, so protected old threads cannot stall it,
  // and how many threads this pass from the oldest has archived.
  const overflowPass = new Map<
    string,
    {
      readonly cursor: { readonly updatedAt: string; readonly threadId: string };
      readonly archived: number;
    }
  >();
  // A project whose whole pass archived nothing waits until its threads can have gone idle.
  const overflowStalled = new Map<string, { readonly until: number; readonly cap: number }>();
  // Per project, threads the cap skipped or the guard refused, left alone for an idle hour unless
  // they change. It outlives the pass, so a project hovering at its cap does not resend them.
  const overflowHeld = new Map<string, Map<string, OverflowHold>>();
  // The sweep starts after the project it served last, so one project cannot take every read.
  let projectAfter = "";
  let lastSweep = Number.NEGATIVE_INFINITY;
  // Oldest finished threads beyond each project's cap; the guard re-counts before each archive.
  const archiveOverflow = (now: number, preferences: Preferences) =>
    Effect.gen(function* () {
      const crowded = yield* sql<{ readonly projectId: string; readonly live: number }>`
        SELECT project_id AS "projectId", COUNT(*) AS live FROM orchestration_v2_projection_threads
        WHERE archived_at IS NULL AND deleted_at IS NULL
        GROUP BY project_id HAVING COUNT(*) > ${OVERFLOW_MIN_LIVE} ORDER BY project_id
      `;
      // A project that drops out restarts from its oldest thread when it crowds again.
      const present = new Set(crowded.map((row) => row.projectId));
      for (const projectId of overflowPass.keys())
        if (!present.has(projectId)) overflowPass.delete(projectId);
      for (const projectId of overflowStalled.keys())
        if (!present.has(projectId)) overflowStalled.delete(projectId);
      for (const [projectId, held] of overflowHeld) {
        if (!present.has(projectId)) overflowHeld.delete(projectId);
        else for (const [threadId, hold] of held) if (now >= hold.retryAt) held.delete(threadId);
      }
      const eligible: Array<{
        readonly projectId: ProjectId;
        readonly named: string | null | undefined;
        readonly cap: number;
        readonly excess: number;
      }> = [];
      for (const row of [
        ...crowded.filter((row) => row.projectId > projectAfter),
        ...crowded.filter((row) => row.projectId <= projectAfter),
      ]) {
        const projectId = ProjectId.make(row.projectId);
        const project = yield* projects.get(projectId);
        const cap = Option.isNone(project)
          ? null
          : resolveProjectSettings(preferences, projectId, project.value).settings
              .keepActiveThreadsPerProject;
        if (
          Option.isNone(project) ||
          isPersonalAssistantProject(project.value) ||
          project.value.workspaceSettings?.paused ||
          project.value.workspaceSettings?.archived ||
          !isValidActiveThreadCap(cap) ||
          Number(row.live) <= cap
        ) {
          overflowPass.delete(projectId);
          overflowStalled.delete(projectId);
          continue;
        }
        const stalled = overflowStalled.get(projectId);
        if (stalled !== undefined && stalled.cap === cap && now < stalled.until) continue;
        overflowStalled.delete(projectId);
        eligible.push({
          projectId,
          named: project.value.workspaceSettings?.coordinatorThreadId,
          cap,
          excess: Number(row.live) - cap,
        });
      }
      let archives = OVERFLOW_BATCH;
      let reads = OVERFLOW_SCAN_LIMIT;
      for (const [index, project] of eligible.entries()) {
        if (archives <= 0 || reads <= 0) return;
        const { projectId, cap } = project;
        let excess = project.excess;
        projectAfter = projectId;
        const coordinator = `project-coordinator:${projectId}`;
        const named = project.named ?? coordinator;
        const pass = overflowPass.get(projectId);
        const cursor = pass?.cursor ?? { updatedAt: "", threadId: "" };
        let archived = pass?.archived ?? 0;
        const held = overflowHeld.get(projectId) ?? new Map<string, OverflowHold>();
        overflowHeld.set(projectId, held);
        // An even share of what is left; a project that needs less leaves the rest to the next.
        const limit = Math.ceil(reads / (eligible.length - index));
        const oldest = yield* sql<{ readonly threadId: string; readonly updatedAt: string }>`
          SELECT thread_id AS "threadId", updated_at AS "updatedAt"
          FROM orchestration_v2_projection_threads
          WHERE project_id = ${projectId} AND archived_at IS NULL AND deleted_at IS NULL
            AND thread_id <> ${coordinator} AND thread_id <> ${named}
            AND (updated_at > ${cursor.updatedAt}
              OR (updated_at = ${cursor.updatedAt} AND thread_id > ${cursor.threadId}))
          ORDER BY updated_at, thread_id LIMIT ${limit}
        `;
        let last: (typeof oldest)[number] | undefined;
        const hold = (threadId: string, updatedAt: string) =>
          held.set(threadId, { updatedAt, retryAt: now + OVERFLOW_IDLE_MS });
        for (const candidate of oldest) {
          if (excess <= 0 || archives <= 0) break;
          last = candidate;
          if (held.get(candidate.threadId)?.updatedAt === candidate.updatedAt) continue;
          reads--;
          yield* Effect.gen(function* () {
            const thread = yield* projections.getThreadShell(ThreadId.make(candidate.threadId));
            if (thread === null) return;
            // The coordinator's own native subagents stay with it; the guard refuses them too.
            if (
              !isOverflowArchiveCandidate(thread, now) ||
              (isProviderNativeSubagentThread(thread) &&
                (thread.lineage.parentThreadId === coordinator ||
                  thread.lineage.parentThreadId === named))
            ) {
              hold(candidate.threadId, candidate.updatedAt);
              return;
            }
            yield* threads.dispatch({
              type: "thread.archive",
              commandId: CommandId.make(
                `overflow-archive:${thread.id}:${DateTime.toEpochMillis(thread.updatedAt)}:${now}`,
              ),
              threadId: thread.id,
              inactive: { expectedUpdatedAt: thread.updatedAt, reason: "overflow" },
            });
            excess--;
            archives--;
            archived++;
          }).pipe(
            Effect.catch((cause) =>
              Effect.sync(() => hold(candidate.threadId, candidate.updatedAt)).pipe(
                Effect.andThen(
                  Effect.logDebug("Overflow archive skipped protected chat", {
                    threadId: candidate.threadId,
                    cause,
                  }),
                ),
              ),
            ),
          );
          yield* Effect.yieldNow;
        }
        if (excess <= 0) overflowPass.delete(projectId);
        else if (last === oldest.at(-1) && oldest.length < limit) {
          // The pass reached the newest thread: start from the oldest again, or, when the whole
          // pass archived nothing, leave the project until one more idle hour has passed.
          overflowPass.delete(projectId);
          if (archived === 0)
            overflowStalled.set(projectId, { until: now + OVERFLOW_IDLE_MS, cap });
        } else if (last !== undefined) overflowPass.set(projectId, { cursor: last, archived });
      }
    });
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
    yield* archiveOverflow(now, preferences);
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
