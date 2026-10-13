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
 * "Update now" asks for more: it also holds the service (`ServiceUpdateHold`),
 * so nothing new starts while the helper works, and it clears what Stop leaves
 * behind (`ServiceUpdateCleanup`): runs stuck before their provider answered,
 * pending requests, session rows with no live session, unsettled effects and
 * open terminals. Interrupted runs end `interrupted`; the person continues them
 * by hand after the restart (no restart continuation starts them on its own).
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
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import type * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";

import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ServiceUpdateCleanup from "./ServiceUpdateCleanup.ts";
import * as ServiceUpdateHold from "./ServiceUpdateHold.ts";

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
export const WORKING_SESSION_STATUSES = ServiceUpdateCleanup.WORKING_SESSION_STATUSES;

export const STOP_REASON = "Stopped to install the SpecWithCode update";
export const ROLLBACK_CANCELLED_MESSAGE =
  "The rollback was cancelled to install the SpecWithCode update. Run it again.";
const RELEASE_DETAIL = "Closed to install the SpecWithCode update.";
/** Effects enqueued after the drain's own cancel get at least this long to finish. */
const LATE_EFFECT_POLLS = 5;
/** Passes over new work an interrupted worker can start on its coordinator. */
const STOP_ROUNDS = 3;
/** With the hold nothing new starts, so one pass is enough. */
const HELD_STOP_ROUNDS = 1;

export interface ServiceUpdatePreparationTimings {
  /** How long Stop gets before a turn that is still running is ended locally. */
  readonly interruptGraceMs: number;
  /** How long the forced end and the outbox get to settle afterwards. */
  readonly settleMs: number;
  /** How long effects get to finish on their own before they are cancelled. */
  readonly effectGraceMs: number;
  /**
   * The whole drain's budget. Waits shrink to fit it; the cleanup that follows
   * them only writes, so the call ends shortly after.
   */
  readonly deadlineMs: number;
  readonly pollMs: number;
}

export const DEFAULT_TIMINGS: ServiceUpdatePreparationTimings = {
  // Longer than the Claude adapter's 10 s interrupt acknowledgement, so a slow
  // provider is ended by its own adapter before it is forced here.
  interruptGraceMs: 21_000,
  settleMs: 10_000,
  effectGraceMs: 20_000,
  deadlineMs: 70_000,
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
  readonly status: string;
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
    const cleanup = yield* ServiceUpdateCleanup.ServiceUpdateCleanup;
    // Both are absent in tools and tests that build the runtime alone.
    const hold = yield* Effect.serviceOption(ServiceUpdateHold.ServiceUpdateHold);
    const terminals = yield* Effect.serviceOption(TerminalManager.TerminalManager);

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
      readonly status: string;
      readonly thread_id: string;
      readonly provider_thread_id: string | null;
      readonly provider_session_id: string | null;
      readonly provider_turn_id: string | null;
    }>`
      SELECT r.run_id, r.status, r.thread_id, r.provider_thread_id, pt.provider_session_id,
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
          status: row.status,
          threadId: row.thread_id,
          providerThreadId: row.provider_thread_id,
          providerSessionId: row.provider_session_id,
          providerTurnId: row.provider_turn_id,
        })),
      ),
    );

    /** `ms`, cut to what is left before `deadline`. */
    const within = (deadline: number, ms: number) =>
      Effect.map(Clock.currentTimeMillis, (now) => Math.max(0, Math.min(ms, deadline - now)));

    /**
     * Runs `work` in the background and waits for it at most until `deadline`.
     * Session releases can each take up to their close timeout on a hung CLI;
     * one left over finishes on its own (it is never interrupted, so its
     * release record is still written) while the drain moves on.
     */
    const boundedBy = <A, E>(deadline: number, work: Effect.Effect<A, E>) =>
      Effect.gen(function* () {
        const fiber = yield* work.pipe(Effect.forkDetach);
        const budget = Math.max(yield* within(deadline, Number.MAX_SAFE_INTEGER), timings.pollMs);
        yield* Fiber.join(fiber).pipe(
          Effect.timeoutOption(Duration.millis(budget)),
          Effect.catchCause((cause) =>
            Effect.logWarning("service-update.prepare.background-failed", { cause }),
          ),
        );
      });

    const countUnsettledEffects = sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM orchestration_v2_effect_outbox
       WHERE status IS NULL OR status NOT IN ${sql.in(TERMINAL_EFFECT_STATUSES)}
    `.pipe(Effect.map((rows) => Number(rows[0]?.count ?? 0)));

    /** Finished turns still waiting on a checkpoint that is queued or being written. */
    const countPendingCaptures = sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM orchestration_v2_projection_runs r
        JOIN orchestration_v2_effect_outbox e
          ON e.command_id = ${ServiceUpdateCleanup.CHECKPOINT_CAPTURE_COMMAND_PREFIX} || r.run_id
       WHERE r.status = 'waiting' AND e.status IN ('pending', 'running')
    `.pipe(Effect.map((rows) => Number(rows[0]?.count ?? 0)));

    const readRunStatuses = (runIds: ReadonlyArray<string>) =>
      runIds.length === 0
        ? Effect.succeed([])
        : sql<{ readonly run_id: string; readonly status: string }>`
            SELECT run_id, status FROM orchestration_v2_projection_runs
             WHERE run_id IN ${sql.in(runIds)}
          `;

    // This process's own hold; the install gate of a restart in progress is not one.
    const isHeld = Option.match(hold, {
      onNone: () => Effect.succeed(false),
      onSome: (service) => Effect.map(service.current, Option.isSome),
    });
    const openTerminals = Option.match(terminals, {
      onNone: () => Effect.succeed(0),
      onSome: (service) => service.countOpen,
    });

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
    const forceEndRuns = (nonce: string, deadline: number) =>
      Effect.gen(function* () {
        const endRun = (run: ActiveRun) =>
          Effect.gen(function* () {
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
          });
        // All at once, and no longer than the drain's budget: hung CLIs close in parallel.
        const runs = yield* readActiveRuns;
        yield* boundedBy(
          deadline,
          Effect.forEach(runs, endRun, { concurrency: "unbounded", discard: true }),
        );
        yield* awaitRunsSettled(yield* within(deadline, timings.settleMs));
      });

    /** Rollbacks the cancel stopped before they ran: their thread is told so it stops waiting. */
    const failCancelledRollbacks = (cancelled: ReadonlyArray<EffectOutbox.CancelledEffect>) =>
      Effect.forEach(
        cancelled.filter((effect) => effect.effectType === "provider-thread.rollback"),
        (effect) =>
          threads
            .dispatch({
              type: "checkpoint.rollback.fail",
              commandId: CommandId.make(`${effect.commandId}:rollback-failed`),
              threadId: ThreadId.make(effect.threadId),
              requestId: CommandId.make(effect.commandId),
              message: ROLLBACK_CANCELLED_MESSAGE,
            })
            .pipe(logged("rollback-fail-failed", { effectId: effect.effectId })),
        { discard: true },
      );

    /**
     * Gives unsettled effects `graceMs` to finish, then cancels the rest. A
     * rollback or checkpoint that is already running is left to finish (it
     * stays a blocker until it does); one that never started is cancelled.
     */
    const settleEffects = (label: string, graceMs: number) =>
      Effect.gen(function* () {
        const until = (yield* Clock.currentTimeMillis) + graceMs;
        while (true) {
          if ((yield* countUnsettledEffects) === 0) return;
          if ((yield* Clock.currentTimeMillis) >= until) break;
          yield* Effect.sleep(Duration.millis(timings.pollMs));
        }
        const cancelled = yield* cleanup
          .cancelUnsettledEffects({ reason: STOP_REASON })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(`service-update.prepare.${label}`, { cause }).pipe(
                Effect.as([] as ReadonlyArray<EffectOutbox.CancelledEffect>),
              ),
            ),
          );
        yield* failCancelledRollbacks(cancelled);
      });

    /** Cancels queued messages; the queue cannot start while held, so each would block the update. */
    const cancelQueued = (nonce: string, rows: ReadonlyArray<BlockerRow>, touched?: Set<string>) =>
      Effect.forEach(
        rows,
        (row) => {
          if (row.kind !== "queued" || row.threadId === null || !row.runId) return Effect.void;
          touched?.add(row.threadId);
          return threads
            .dispatch({
              type: "queued-run.cancel",
              commandId: CommandId.make(`service-update:${nonce}:cancel:${row.runId}`),
              threadId: ThreadId.make(row.threadId),
              runId: RunId.make(row.runId),
            })
            .pipe(logged("cancel-queued-failed", { threadId: row.threadId, runId: row.runId }));
        },
        { discard: true },
      );

    /**
     * One pass over the work left: queued messages are cancelled first, so an
     * interrupt does not start the next one, then each running turn gets a plain
     * interrupt. Unlike Stop this keeps the thread's pull request watches and the
     * rest of its delegated work. Stop is the fallback for a run that cannot be
     * interrupted and for a request whose run has already ended.
     */
    const stopRound = (nonce: string, touched: Set<string>, deadline: number) =>
      Effect.gen(function* () {
        const rows = yield* readBlockerRows;
        yield* cancelQueued(nonce, rows, touched);
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
        // A request whose run already ended is closed by the cleanup below. A full
        // Stop here would also end that thread's pull request watches and wakes.
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
        if (!(yield* awaitRunsSettled(yield* within(deadline, timings.interruptGraceMs))))
          yield* forceEndRuns(nonce, deadline);
      });

    /**
     * What Stop cannot end on its own: turns that never reached their provider,
     * requests whose run already ended, session rows whose process is gone,
     * effects nobody will finish, and terminal shells.
     */
    const clearLeftovers = (nonce: string, deadline: number) =>
      Effect.gen(function* () {
        // Agent processes, including any still busy after Stop, also block the helper.
        yield* boundedBy(
          deadline,
          providerSessions
            .releaseIdle({ detail: RELEASE_DETAIL, includeBusy: true })
            .pipe(logged("release-sessions-failed", {})),
        );
        // Closing a busy session can end its turn through the provider's own events.
        if ((yield* readActiveRuns).length > 0)
          yield* awaitRunsSettled(yield* within(deadline, timings.settleMs));
        // A finished turn waits on its checkpoint; a restart would replay it, so it
        // gets what is left of the effect grace before the turn is closed without one.
        const captureUntil =
          (yield* Clock.currentTimeMillis) + (yield* within(deadline, timings.effectGraceMs));
        while ((yield* countPendingCaptures) > 0) {
          if ((yield* Clock.currentTimeMillis) >= captureUntil) break;
          yield* Effect.sleep(Duration.millis(timings.pollMs));
        }
        yield* cleanup
          .finalizeStuckRuns({ nonce, reason: STOP_REASON })
          .pipe(logged("finalize-runs-failed", {}));
        for (const request of yield* cleanup.listMessageModeRequests.pipe(
          Effect.orElseSucceed(() => []),
        )) {
          yield* threads
            .dispatch({
              type: "thread.user-input.dismiss",
              commandId: CommandId.make(`service-update:${nonce}:dismiss:${request.requestId}`),
              threadId: request.threadId,
              requestId: request.requestId,
            })
            .pipe(logged("dismiss-failed", { requestId: request.requestId }));
        }
        yield* cleanup
          .cancelPendingRequests({ nonce, reason: STOP_REASON })
          .pipe(logged("cancel-requests-failed", {}));
        yield* cleanup.reconcileOrphanedSessions.pipe(logged("reconcile-sessions-failed", {}));
        // Effects get a moment to finish, typically the interrupts above; the rest is cancelled.
        yield* settleEffects(
          "cancel-effects-failed",
          yield* within(deadline, timings.effectGraceMs),
        );
        // Shells end; their scrollback stays for after the restart.
        return yield* Option.match(terminals, {
          onNone: () => Effect.succeed(0),
          onSome: (service) => service.closeAll,
        });
      });

    const stopWork = (input: { readonly rounds: number; readonly deadline: number }) =>
      Effect.gen(function* () {
        const nonce = yield* Clock.currentTimeMillis;
        const touched = new Set<string>();
        const activeBefore = (yield* readActiveRuns).map((active) => active.runId);
        // An interrupted worker can wake its coordinator, which queues or starts a new
        // turn; later rounds stop that too. A held service defers those wakes.
        for (let round = 0; round < input.rounds; round += 1) {
          yield* stopRound(`${nonce}:${round}`, touched, input.deadline);
          const left = yield* readBlockerRows;
          if (!left.some((row) => row.kind === "run" || row.kind === "queued")) break;
        }
        const closedTerminals = yield* clearLeftovers(`${nonce}:cleanup`, input.deadline);
        const interruptedRuns = (yield* readRunStatuses(activeBefore)).filter(
          (row) => row.status === "interrupted",
        ).length;
        return { stoppedThreads: touched.size, interruptedRuns, closedTerminals };
      });

    const report = (rows: ReadonlyArray<BlockerRow>) => {
      const blockers = summarizeBlockers(rows);
      return { idle: blockers.length === 0, blockers };
    };

    const holdUntil = Effect.gen(function* () {
      if (Option.isNone(hold)) return {};
      const current = yield* hold.value.current;
      return Option.isNone(current)
        ? {}
        : { holdUntil: DateTime.formatIso(DateTime.makeUnsafe(current.value.expiresAtMs)) };
    });

    const drain = (input: { readonly holding: boolean }) =>
      Effect.gen(function* () {
        // Held before the drain, so nothing new starts behind it.
        if (input.holding && Option.isSome(hold)) yield* hold.value.acquire();
        const deadline = (yield* Clock.currentTimeMillis) + timings.deadlineMs;
        const drained = yield* stopWork({
          rounds: input.holding ? HELD_STOP_ROUNDS : STOP_ROUNDS,
          deadline,
        });
        // At least one look, even when the budget is spent.
        let rows = yield* awaitIdle(yield* within(deadline, timings.settleMs));
        // A message that passed the hold check just before it began, or a watch
        // wake already in flight, can queue after the single held round.
        if (input.holding && rows.some((row) => row.kind === "queued")) {
          yield* cancelQueued(`${yield* Clock.currentTimeMillis}:late`, rows);
          rows = yield* readBlockerRows;
        }
        // Reactions to the runs ended above can enqueue work after the cancel.
        if (rows.some((row) => row.kind === "effect")) {
          yield* settleEffects(
            "cancel-late-effects-failed",
            Math.max(
              yield* within(deadline, timings.effectGraceMs),
              Math.min(timings.effectGraceMs, timings.pollMs * LATE_EFFECT_POLLS),
            ),
          );
          rows = yield* readBlockerRows;
        }
        // The hold's time limit starts again now, as the install request is written.
        if (input.holding && Option.isSome(hold)) yield* hold.value.acquire();
        return { rows, drained };
      });

    const prepare = (input: ServerPrepareServiceUpdateInput) =>
      Effect.gen(function* () {
        if (input.releaseHold === true) {
          if (Option.isSome(hold)) yield* hold.value.release("cancelled");
          return {
            ...report(yield* readBlockerRows),
            stoppedThreads: 0,
            held: false,
            openTerminals: yield* openTerminals,
          };
        }
        if (!input.stopWork) {
          const held = yield* isHeld;
          let rows = yield* readBlockerRows;
          // While held a queued message can never start, and it keeps the helper waiting.
          if (held && rows.some((row) => row.kind === "queued")) {
            yield* cancelQueued(`${yield* Clock.currentTimeMillis}:held`, rows);
            rows = yield* readBlockerRows;
          }
          return {
            ...report(rows),
            stoppedThreads: 0,
            held,
            ...(held ? yield* holdUntil : {}),
            openTerminals: yield* openTerminals,
          };
        }
        // Only a release the agent has found is worth holding the service for.
        const holding =
          input.hold === true && Option.isSome(hold) && (yield* hold.value.updatePending);
        if (input.hold === true && Option.isSome(hold) && !holding)
          yield* Effect.logWarning("service-update.hold.refused", {
            reason: "no service update is on its way",
          });
        const { rows, drained } = yield* drain({ holding }).pipe(
          // A drain that failed or was cut off (a closed window) installs nothing:
          // nobody would release the hold, so work may start again now.
          Effect.onError(() =>
            holding && Option.isSome(hold) ? hold.value.release("prepare-aborted") : Effect.void,
          ),
        );
        const held = yield* isHeld;
        const result = {
          ...report(rows),
          stoppedThreads: drained.stoppedThreads,
          held,
          ...(held ? yield* holdUntil : {}),
          interruptedRuns: drained.interruptedRuns,
          openTerminals: drained.closedTerminals,
        };
        yield* Effect.logInfo("service-update.prepare", {
          stoppedThreads: result.stoppedThreads,
          interruptedRuns: result.interruptedRuns,
          openTerminals: result.openTerminals,
          held: result.held,
          remaining: result.blockers.length,
        });
        return result;
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
