/**
 * Brings the service to the idle state its update helper insists on before it
 * installs a release.
 *
 * `scripts/studio-fleet/update.py` snapshots the database only when every run
 * is terminal and no runtime request, outbox effect or provider session is
 * still pending, and only when no agent process runs under the service. While
 * anything is left the update agent waits for a quiet moment that may never
 * come. "Restart to update" promises that running tasks are interrupted, so
 * before the install request is written this service cancels queued messages,
 * interrupts every running turn, ends turns whose provider never
 * answers the interrupt, closes idle agent processes, and reports by thread
 * whatever is still left. The predicates below mirror `_read_state` in
 * update.py; the helper's own check stays the authority.
 *
 * @module ServiceUpdatePreparation
 */
import {
  CommandId,
  ProjectId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ServerPrepareServiceUpdateError,
  ThreadId,
  type ServerPrepareServiceUpdateInput,
  type ServerPrepareServiceUpdateResult,
  type ServiceUpdateBlocker,
  type ServiceUpdateBlockerKind,
} from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

/** Run statuses update.py accepts; every other status keeps the service busy. */
export const TERMINAL_RUN_STATUSES = [
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
] as const;
/** Effect outbox statuses update.py accepts (EffectOutbox writes `succeeded`). */
export const TERMINAL_EFFECT_STATUSES = ["succeeded", "failed", "cancelled"] as const;
/** Provider session statuses update.py counts as working. */
export const WORKING_SESSION_STATUSES = ["running", "working", "connecting", "starting"] as const;

export const STOP_REASON = "Stopped to install the SpecWithCode update";
const RELEASE_DETAIL = "Closed to install the SpecWithCode update.";
/** Passes over new work an interrupted worker can start on its coordinator. */
const STOP_ROUNDS = 3;

export interface ServiceUpdatePreparationTimings {
  /** How long Stop gets before a turn that is still running is ended locally. */
  readonly interruptGraceMs: number;
  /** How long the forced end and the outbox get to settle afterwards. */
  readonly settleMs: number;
  readonly pollMs: number;
}

export const DEFAULT_TIMINGS: ServiceUpdatePreparationTimings = {
  // Longer than the Claude adapter's 10 s interrupt acknowledgement, so a slow
  // provider is ended by its own adapter before it is forced here.
  interruptGraceMs: 21_000,
  settleMs: 10_000,
  pollMs: 400,
};

export interface BlockerRow {
  readonly kind: ServiceUpdateBlockerKind;
  readonly threadId: string | null;
  readonly threadTitle: string | null;
  readonly projectId: string | null;
  readonly projectTitle: string | null;
  /** Set for `run` and `queued` rows. */
  readonly runId?: string | null;
}

const KIND_ORDER: Record<ServiceUpdateBlockerKind, number> = {
  run: 0,
  request: 1,
  queued: 2,
  session: 3,
  effect: 4,
};

/** One entry per thread and kind, running work first, then by project and thread. */
export function summarizeBlockers(rows: ReadonlyArray<BlockerRow>): Array<ServiceUpdateBlocker> {
  const grouped = new Map<string, ServiceUpdateBlocker>();
  for (const row of rows) {
    const key = `${row.kind}\u0000${row.threadId ?? ""}`;
    const existing = grouped.get(key);
    if (existing) {
      grouped.set(key, { ...existing, count: existing.count + 1 });
      continue;
    }
    grouped.set(key, {
      kind: row.kind,
      count: 1,
      threadId: row.threadId === null ? null : ThreadId.make(row.threadId),
      threadTitle: row.threadTitle,
      projectId: row.projectId === null ? null : ProjectId.make(row.projectId),
      projectTitle: row.projectTitle,
    });
  }
  return [...grouped.values()].toSorted(
    (left, right) =>
      KIND_ORDER[left.kind] - KIND_ORDER[right.kind] ||
      (left.projectTitle ?? "").localeCompare(right.projectTitle ?? "") ||
      (left.threadTitle ?? "").localeCompare(right.threadTitle ?? ""),
  );
}

interface ActiveRun {
  readonly runId: string;
  readonly threadId: string;
  readonly providerThreadId: string | null;
  readonly providerSessionId: string | null;
  readonly providerTurnId: string | null;
}

export class ServiceUpdatePreparation extends Context.Service<
  ServiceUpdatePreparation,
  {
    readonly prepare: (
      input: ServerPrepareServiceUpdateInput,
    ) => Effect.Effect<ServerPrepareServiceUpdateResult, ServerPrepareServiceUpdateError>;
  }
>()("specweave-studio/serviceUpdate/ServiceUpdatePreparation") {}

const quoted = (values: ReadonlyArray<string>) => values.map((value) => `'${value}'`).join(", ");
const TERMINAL_RUNS_SQL = quoted(TERMINAL_RUN_STATUSES);
const TERMINAL_EFFECTS_SQL = quoted(TERMINAL_EFFECT_STATUSES);
const WORKING_SESSIONS_SQL = quoted(WORKING_SESSION_STATUSES);

export const makeWithTimings = (timings: ServiceUpdatePreparationTimings) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;

    const readBlockerRows = Effect.gen(function* () {
      const rows = yield* sql.unsafe<{
        readonly kind: ServiceUpdateBlockerKind;
        readonly thread_id: string | null;
        readonly run_id: string | null;
      }>(`
        SELECT CASE WHEN status = 'queued' THEN 'queued' ELSE 'run' END AS kind,
               thread_id, run_id
          FROM orchestration_v2_projection_runs
         WHERE status NOT IN (${TERMINAL_RUNS_SQL})
        UNION ALL
        SELECT 'request', thread_id, NULL FROM orchestration_v2_projection_runtime_requests
         WHERE status = 'pending'
        UNION ALL
        SELECT 'effect', thread_id, NULL FROM orchestration_v2_effect_outbox
         WHERE status IS NULL OR status NOT IN (${TERMINAL_EFFECTS_SQL})
        UNION ALL
        SELECT 'session', thread_id, NULL FROM orchestration_v2_projection_provider_sessions
         WHERE status IN (${WORKING_SESSIONS_SQL})
      `);
      const threadIds = [
        ...new Set(rows.flatMap((row) => (row.thread_id === null ? [] : [row.thread_id]))),
      ];
      const names = new Map<
        string,
        { title: string; projectId: string | null; projectTitle: string | null }
      >();
      for (const threadId of threadIds) {
        const found = yield* sql<{
          readonly title: string;
          readonly project_id: string | null;
          readonly project_title: string | null;
        }>`
          SELECT t.title AS title, t.project_id AS project_id, p.title AS project_title
            FROM orchestration_v2_projection_threads t
            LEFT JOIN projection_projects p ON p.project_id = t.project_id
           WHERE t.thread_id = ${threadId}
        `;
        const row = found[0];
        if (row)
          names.set(threadId, {
            title: row.title,
            projectId: row.project_id,
            projectTitle: row.project_title,
          });
      }
      return rows.map((row): BlockerRow => ({
        kind: row.kind,
        threadId: row.thread_id,
        threadTitle: row.thread_id === null ? null : (names.get(row.thread_id)?.title ?? null),
        projectId: row.thread_id === null ? null : (names.get(row.thread_id)?.projectId ?? null),
        projectTitle:
          row.thread_id === null ? null : (names.get(row.thread_id)?.projectTitle ?? null),
        runId: row.run_id,
      }));
    });

    const readActiveRuns = sql<{
      readonly run_id: string;
      readonly thread_id: string;
      readonly provider_thread_id: string | null;
      readonly provider_session_id: string | null;
      readonly provider_turn_id: string | null;
    }>`
      SELECT r.run_id, r.thread_id, r.provider_thread_id, pt.provider_session_id,
             (SELECT t.provider_turn_id FROM orchestration_v2_projection_provider_turns t
               WHERE t.provider_thread_id = r.provider_thread_id
               ORDER BY t.ordinal DESC LIMIT 1) AS provider_turn_id
        FROM orchestration_v2_projection_runs r
        LEFT JOIN orchestration_v2_projection_provider_threads pt
          ON pt.provider_thread_id = r.provider_thread_id
       WHERE r.status IN ('preparing', 'starting', 'running', 'waiting')
    `.pipe(
      Effect.map((rows) =>
        rows.map((row): ActiveRun => ({
          runId: row.run_id,
          threadId: row.thread_id,
          providerThreadId: row.provider_thread_id,
          providerSessionId: row.provider_session_id,
          providerTurnId: row.provider_turn_id,
        })),
      ),
    );

    const logged =
      (label: string, detail: Record<string, unknown>) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.asVoid,
          Effect.catchCause((cause) =>
            Effect.logWarning(`service-update.prepare.${label}`, { ...detail, cause }),
          ),
        );

    /** Polls until no run is active or the time is up; true when none is left. */
    const awaitRunsSettled = (budgetMs: number) =>
      Effect.gen(function* () {
        const deadline = (yield* Clock.currentTimeMillis) + budgetMs;
        while (true) {
          const active = yield* readActiveRuns;
          if (active.length === 0) return true;
          if ((yield* Clock.currentTimeMillis) >= deadline) return false;
          yield* Effect.sleep(Duration.millis(timings.pollMs));
        }
      });

    const awaitIdle = (budgetMs: number) =>
      Effect.gen(function* () {
        const deadline = (yield* Clock.currentTimeMillis) + budgetMs;
        while (true) {
          const rows = yield* readBlockerRows;
          if (rows.length === 0 || (yield* Clock.currentTimeMillis) >= deadline) return rows;
          yield* Effect.sleep(Duration.millis(timings.pollMs));
        }
      });

    const dispatched =
      (label: string, detail: Record<string, unknown>) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning(`service-update.prepare.${label}`, { ...detail, cause }).pipe(
              Effect.as(false),
            ),
          ),
        );

    /** Ends turns whose provider never answered the interrupt (a hung CLI, a dead socket). */
    const forceEndRuns = (nonce: string) =>
      Effect.gen(function* () {
        for (const run of yield* readActiveRuns) {
          // Close its process, then end the turn the way a completed Stop does.
          if (run.providerSessionId !== null) {
            yield* providerSessions
              .release({
                providerSessionId: ProviderSessionId.make(run.providerSessionId),
                reason: "manual_shutdown",
                detail: RELEASE_DETAIL,
              })
              .pipe(logged("release-failed", { runId: run.runId }));
          }
          if (run.providerThreadId !== null && run.providerTurnId !== null) {
            yield* threads
              .dispatch({
                type: "thread.background-work.settle",
                commandId: CommandId.make(`service-update:${nonce}:settle:${run.runId}`),
                threadId: ThreadId.make(run.threadId),
                providerThreadId: ProviderThreadId.make(run.providerThreadId),
                providerTurnId: ProviderTurnId.make(run.providerTurnId),
              })
              .pipe(logged("settle-failed", { runId: run.runId }));
          }
        }
        yield* awaitRunsSettled(timings.settleMs);
      });

    /**
     * One pass over the work left: queued messages are cancelled first, so an
     * interrupt does not start the next one, then each running turn gets a plain
     * interrupt. Unlike Stop this keeps the thread's pull request watches and the
     * rest of its delegated work. Stop is the fallback for a run that cannot be
     * interrupted and for a request whose run has already ended.
     */
    const stopRound = (nonce: string, touched: Set<string>) =>
      Effect.gen(function* () {
        const rows = yield* readBlockerRows;
        for (const row of rows) {
          if (row.kind !== "queued" || row.threadId === null || !row.runId) continue;
          touched.add(row.threadId);
          yield* threads
            .dispatch({
              type: "queued-run.cancel",
              commandId: CommandId.make(`service-update:${nonce}:cancel:${row.runId}`),
              threadId: ThreadId.make(row.threadId),
              runId: RunId.make(row.runId),
            })
            .pipe(logged("cancel-queued-failed", { threadId: row.threadId, runId: row.runId }));
        }
        const interrupted = new Set<string>();
        const stopThreads = new Set<string>();
        for (const row of rows) {
          if (row.kind !== "run" || row.threadId === null || !row.runId) continue;
          if (interrupted.has(row.runId)) continue;
          interrupted.add(row.runId);
          touched.add(row.threadId);
          const accepted = yield* threads
            .dispatch({
              type: "run.interrupt",
              commandId: CommandId.make(`service-update:${nonce}:interrupt:${row.runId}`),
              threadId: ThreadId.make(row.threadId),
              runId: RunId.make(row.runId),
              reason: STOP_REASON,
            })
            .pipe(dispatched("interrupt-failed", { threadId: row.threadId, runId: row.runId }));
          if (!accepted) stopThreads.add(row.threadId);
        }
        const runThreads = new Set(
          rows.flatMap((row) =>
            row.kind === "run" && row.threadId !== null ? [row.threadId] : [],
          ),
        );
        for (const row of rows) {
          if (row.kind === "request" && row.threadId !== null && !runThreads.has(row.threadId))
            stopThreads.add(row.threadId);
        }
        for (const threadId of stopThreads) {
          touched.add(threadId);
          yield* threads
            .dispatch({
              type: "thread.stop",
              commandId: CommandId.make(`service-update:${nonce}:stop:${threadId}`),
              threadId: ThreadId.make(threadId),
              reason: STOP_REASON,
            })
            .pipe(logged("stop-failed", { threadId }));
        }
        if (!(yield* awaitRunsSettled(timings.interruptGraceMs))) yield* forceEndRuns(nonce);
      });

    const stopWork = Effect.gen(function* () {
      const nonce = yield* Clock.currentTimeMillis;
      const touched = new Set<string>();
      // An interrupted worker can wake its coordinator, which queues or starts a new
      // turn; later rounds stop that too.
      for (let round = 0; round < STOP_ROUNDS; round += 1) {
        yield* stopRound(`${nonce}:${round}`, touched);
        const left = yield* readBlockerRows;
        if (!left.some((row) => row.kind === "run" || row.kind === "queued")) break;
      }
      // Agent processes kept open between turns also block the helper.
      yield* providerSessions
        .releaseIdle({ detail: RELEASE_DETAIL })
        .pipe(logged("release-idle-failed", {}));
      return touched.size;
    });

    const prepare = (input: ServerPrepareServiceUpdateInput) =>
      Effect.gen(function* () {
        const stoppedThreads = input.stopWork ? yield* stopWork : 0;
        const rows = input.stopWork ? yield* awaitIdle(timings.settleMs) : yield* readBlockerRows;
        const blockers = summarizeBlockers(rows);
        if (input.stopWork)
          yield* Effect.logInfo("service-update.prepare", {
            stoppedThreads,
            remaining: blockers.length,
          });
        return { idle: blockers.length === 0, stoppedThreads, blockers };
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("service-update.prepare.failed", { cause }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new ServerPrepareServiceUpdateError({
                      message: "Could not check what is still running.",
                    }),
                  ),
                ),
              ),
        ),
      );

    return ServiceUpdatePreparation.of({ prepare });
  });

export const make = makeWithTimings(DEFAULT_TIMINGS);

export const layer = Layer.effect(ServiceUpdatePreparation, make);
