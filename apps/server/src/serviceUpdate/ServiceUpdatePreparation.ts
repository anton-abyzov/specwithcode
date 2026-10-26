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
 * open terminals. Interrupted runs end `interrupted`. After the restart, a project
 * that continues threads after restarts continues them and queues the cancelled
 * messages again; elsewhere the person continues them by hand.
 *
 * Every question and approval the drain closes is recorded first
 * (`ServiceUpdateClosedQuestions`): before any turn is stopped, since an
 * interrupt can cancel a request itself, then for any asked meanwhile at each
 * stop round, at each look while turns wind down, before agent processes are
 * closed and just before the leftovers are dismissed and cancelled. A record
 * that cannot be written fails the drain (the hold ends) so nothing more is
 * closed unrecorded. They are asked again
 * after the update (`ServiceUpdateReopenQuestions`), and the preview names
 * them by thread (`questions`, `approvals` on a `request` blocker) so the
 * confirm dialog can say so before anything closes.
 *
 * An automatic install waits for quiet instead, and a turn that only waits on a
 * person for an answer nobody gave would keep it waiting forever. While the
 * update agent waits for quiet, a sweep every `STALE_WAIT_SWEEP_MS` looks for
 * that case: when every blocker belongs to a thread whose pending requests are
 * all approvals or questions (`STALE_WAIT_REQUEST_KINDS`) older than
 * `STALE_WAIT_MS` and that thread has had no activity for as long, those
 * threads are stopped the way the drain stops them (`releaseStaleWaits`): the
 * turn ends `interrupted`, so the person continues it, and the request is
 * cancelled with a reason. Each such request is recorded first and asked again
 * after the restart that installs the update, so an unanswered question never
 * holds an update back for good; a thread whose record cannot be written is
 * left waiting. A sign-in is never stopped: it cannot be asked again, so it
 * stays in Needs you and keeps the install waiting. A thread Needs you does not
 * show (`hiddenFromNeedsYou`: archived, deleted, or resolved after its request
 * was asked) waits on nobody, so it is stopped at the first look whatever it
 * waits on, and what it asked is closed without being asked again. Just before
 * each thread is stopped its pending requests and latest event are read again,
 * and a thread that changed since it was picked (someone answered) is left
 * alone. Any other work, such as a turn still producing output, keeps the
 * install waiting as before, and the sweep touches nothing then.
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
  SERVICE_UPDATE_STOP_REASON,
  ServerPrepareServiceUpdateError,
  ThreadId,
  type ServerPrepareServiceUpdateInput,
  type ServerPrepareServiceUpdateResult,
  type ServiceUpdatePrepareReason,
  type ServiceUpdateBlocker,
  type ServiceUpdateBlockerKind,
} from "@specweave-studio/contracts";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import type * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";

import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ServiceUpdateCleanup from "./ServiceUpdateCleanup.ts";
import * as ClosedQuestions from "./ServiceUpdateClosedQuestions.ts";
import * as ServiceUpdateHold from "./ServiceUpdateHold.ts";
import { captureOpenRequests } from "./ServiceUpdateReopenQuestions.ts";

/** The questions and approvals a drain is about to close could not be recorded. */
export class ClosedQuestionsNotRecorded extends Data.TaggedError("ClosedQuestionsNotRecorded")<{
  readonly cause?: unknown;
}> {}

/** What Update now says when it stopped because it could not record what it would close. */
export const NOT_RECORDED_MESSAGE =
  "Could not save the open questions and approvals before closing them, so the update stopped. Check that the disk has free space, then try again.";

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

export const STOP_REASON = SERVICE_UPDATE_STOP_REASON;
export const ROLLBACK_CANCELLED_MESSAGE =
  "The rollback was cancelled to install the SpecWithCode update. Run it again.";
const RELEASE_DETAIL = "Closed to install the SpecWithCode update.";
/** Effects enqueued after the drain's own cancel get at least this long to finish. */
const LATE_EFFECT_POLLS = 5;
/** Passes over new work an interrupted worker can start on its coordinator. */
const STOP_ROUNDS = 3;
/** With the hold nothing new starts, so one pass is enough. */
const HELD_STOP_ROUNDS = 1;

/**
 * How long a request waits on a person, with no activity on its thread, before
 * that thread no longer holds back an automatic install.
 */
export const STALE_WAIT_MS = 30 * 60_000;
/** How often the service looks for such threads while the update agent waits for quiet. */
export const STALE_WAIT_SWEEP_MS = 5 * 60_000;
export const STALE_WAIT_REASON =
  "Stopped so the app could install its update: this turn waited more than 30 minutes for an answer. It is asked again after the restart.";
/** Why a thread Needs you does not show was stopped for an automatic install. */
export const HIDDEN_WAIT_REASON =
  "Closed so the app could install its update: this thread is resolved or archived.";
/** The agent status (`update_agent.py`) of an install that waits for a quiet moment. */
const AGENT_WAITING_FOR_QUIET = "waiting-for-quiet";
/** Blocker kinds a thread that only waits on a person can have. */
const WAITING_KINDS: ReadonlySet<ServiceUpdateBlockerKind> = new Set(["run", "request", "session"]);
/**
 * The request kinds a stale wait may be released for: approvals and questions,
 * which are recorded and asked again after the restart. A sign-in
 * (`auth_refresh`) or a tool call cannot be asked again and keeps blocking.
 */
export const STALE_WAIT_REQUEST_KINDS: ReadonlySet<string> = new Set([
  "command",
  "file-read",
  "file-change",
  "permission",
  "mcp-elicitation",
  "user_input",
]);

/**
 * Whether Needs you leaves a thread out, as the Threads pane does
 * (`classifyProjectActions`): it is archived or deleted, or the person resolved
 * it after each of its pending requests was asked. Nobody is shown what such a
 * thread waits on, so it never holds an automatic install.
 */
export function hiddenFromNeedsYou(
  thread: {
    readonly archived: boolean;
    readonly settled: boolean;
    readonly settledAt: string | null;
  },
  requests: ReadonlyArray<{ readonly created_at: string | null }>,
): boolean {
  if (thread.archived) return true;
  if (!thread.settled) return false;
  const settledMs = thread.settledAt === null ? Number.NaN : Date.parse(thread.settledAt);
  if (!Number.isFinite(settledMs)) return false;
  return requests.every((request) => {
    const askedMs = request.created_at === null ? Number.NaN : Date.parse(request.created_at);
    return Number.isFinite(askedMs) && askedMs <= settledMs;
  });
}

/**
 * Whether the update agent's `state.json` says an install waits for a quiet
 * moment. An unreadable file says nothing is waiting.
 */
export function agentWaitsForQuiet(stateText: string): boolean {
  try {
    const value: unknown = JSON.parse(stateText);
    return (
      typeof value === "object" &&
      value !== null &&
      (value as Record<string, unknown>).status === AGENT_WAITING_FOR_QUIET
    );
  } catch {
    return false;
  }
}

/** Whether an ISO time is at or before `cutoffMs`. No time is long ago; an unreadable one is recent. */
const atOrBefore = (value: string | null, cutoffMs: number) => {
  if (value === null) return true;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= cutoffMs;
};

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
  /** Set for `request` rows: the runtime request's kind. */
  readonly requestKind?: string | null;
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
  // What a forced press closes and asks again: questions and approvals by thread.
  for (const row of rows) {
    if (row.kind !== "request" || row.requestKind === undefined) continue;
    const key = `${row.kind}\u0000${row.threadId ?? ""}`;
    const blocker = grouped.get(key);
    if (blocker === undefined) continue;
    const kind = row.requestKind ?? "";
    grouped.set(key, {
      ...blocker,
      questions:
        (blocker.questions ?? 0) + (ClosedQuestions.QUESTION_REQUEST_KINDS.has(kind) ? 1 : 0),
      approvals: (blocker.approvals ?? 0) + (ClosedQuestions.APPROVAL_KINDS.has(kind) ? 1 : 0),
    });
  }
  return [...grouped.values()].toSorted(
    (left, right) =>
      KIND_ORDER[left.kind] - KIND_ORDER[right.kind] ||
      (left.projectTitle ?? "").localeCompare(right.projectTitle ?? "") ||
      (left.threadTitle ?? "").localeCompare(right.threadTitle ?? ""),
  );
}

export interface ActiveRun {
  readonly runId: string;
  readonly status: string;
  readonly threadId: string;
  readonly providerThreadId: string | null;
  readonly providerSessionId: string | null;
  readonly providerTurnId: string | null;
  /** Its provider reported the turn; false while its start is still in flight. */
  readonly turnStarted: boolean;
}

/**
 * A turn whose start has not reached its provider yet. Closing its session now
 * fails the start, and a failed run is never continued, so the drain lets it
 * start first; once started, closing it ends its stream and the restart
 * continues it.
 */
export const isStartInFlight = (run: Pick<ActiveRun, "status" | "turnStarted">) =>
  run.status === "preparing" ||
  run.status === "starting" ||
  (run.status === "running" && !run.turnStarted);

export class ServiceUpdatePreparation extends Context.Service<
  ServiceUpdatePreparation,
  {
    readonly prepare: (
      input: ServerPrepareServiceUpdateInput,
    ) => Effect.Effect<ServerPrepareServiceUpdateResult, ServerPrepareServiceUpdateError>;
  }
>()("specweave-studio/serviceUpdate/ServiceUpdatePreparation") {}

export interface StaleWaitRelease {
  /** Threads stopped because they only waited on a person; empty when anything else is left. */
  readonly releasedThreads: ReadonlyArray<string>;
}

/**
 * A thread picked as only waiting on an approval, with what it looked like
 * then: its pending request ids and its latest event. It is stopped only while
 * both are unchanged.
 */
export interface StaleWaitThread {
  readonly threadId: string;
  readonly requestIds: string;
  readonly latestSequence: number | null;
  /** Needs you does not show it: what it asked is closed, not asked again. */
  readonly hidden?: boolean;
}

const quoted = (values: ReadonlyArray<string>) => values.map((value) => `'${value}'`).join(", ");
const TERMINAL_RUNS_SQL = quoted(TERMINAL_RUN_STATUSES);
const TERMINAL_EFFECTS_SQL = quoted(TERMINAL_EFFECT_STATUSES);
const WORKING_SESSIONS_SQL = quoted(WORKING_SESSION_STATUSES);

/**
 * The service and what its sweep uses: `releaseStaleWaits` and whether this
 * process holds itself for an update.
 */
export const makePartsWithTimings = (timings: ServiceUpdatePreparationTimings) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const cleanup = yield* ServiceUpdateCleanup.ServiceUpdateCleanup;
    // Both are absent in tools and tests that build the runtime alone.
    const hold = yield* Effect.serviceOption(ServiceUpdateHold.ServiceUpdateHold);
    const terminals = yield* Effect.serviceOption(TerminalManager.TerminalManager);
    const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
    // Absent in tools and tests that build the runtime alone: nothing is recorded then.
    const closedQuestions = yield* Effect.serviceOption(
      ClosedQuestions.ServiceUpdateClosedQuestions,
    );

    const readBlockerRows = Effect.gen(function* () {
      const rows = yield* sql.unsafe<{
        readonly kind: ServiceUpdateBlockerKind;
        readonly thread_id: string | null;
        readonly run_id: string | null;
        readonly request_kind: string | null;
      }>(`
        SELECT CASE WHEN status = 'queued' THEN 'queued' ELSE 'run' END AS kind,
               thread_id, run_id, NULL AS request_kind
          FROM orchestration_v2_projection_runs
         WHERE status NOT IN (${TERMINAL_RUNS_SQL})
           -- A held queue starts only when someone resumes it, so it is not work the
           -- update waits for, and it stays held across the restart (update.py agrees).
           AND NOT (status = 'queued' AND json_extract(payload_json, '$.queueHeld') IS 1)
        UNION ALL
        SELECT 'request', thread_id, NULL, kind FROM orchestration_v2_projection_runtime_requests
         WHERE status = 'pending'
        UNION ALL
        SELECT 'effect', thread_id, NULL, NULL FROM orchestration_v2_effect_outbox
         WHERE status IS NULL OR status NOT IN (${TERMINAL_EFFECTS_SQL})
        UNION ALL
        SELECT 'session', thread_id, NULL, NULL FROM orchestration_v2_projection_provider_sessions
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
        ...(row.kind === "request" ? { requestKind: row.request_kind } : {}),
      }));
    });

    const readActiveRuns = sql<{
      readonly run_id: string;
      readonly status: string;
      readonly thread_id: string;
      readonly provider_thread_id: string | null;
      readonly provider_session_id: string | null;
      readonly provider_turn_id: string | null;
      readonly turn_started: number;
    }>`
      SELECT r.run_id, r.status, r.thread_id, r.provider_thread_id, pt.provider_session_id,
             (SELECT t.provider_turn_id FROM orchestration_v2_projection_provider_turns t
               WHERE t.provider_thread_id = r.provider_thread_id
               ORDER BY t.ordinal DESC LIMIT 1) AS provider_turn_id,
             EXISTS (SELECT 1 FROM orchestration_v2_projection_provider_turns t
               WHERE t.run_attempt_id = json_extract(r.payload_json, '$.activeAttemptId'))
               AS turn_started
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
          turnStarted: Number(row.turn_started) === 1,
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

    /**
     * Records every question and approval still open (of `threadIds`, when
     * given) that `known` does not hold yet, before anything closes it. Fails
     * when the record cannot be read or written: nothing may then be closed.
     */
    const recordOpenRequests = (
      known: Set<string>,
      options: { readonly threadIds?: ReadonlyArray<string>; readonly afterRestart?: boolean } = {},
    ): Effect.Effect<void, ClosedQuestionsNotRecorded> =>
      Option.match(closedQuestions, {
        onNone: () => Effect.void,
        onSome: (store) =>
          Effect.gen(function* () {
            const entries = yield* captureOpenRequests({
              sql,
              threads,
              ...(options.threadIds === undefined ? {} : { threadIds: options.threadIds }),
              skip: (requestId) => known.has(requestId),
            });
            if (entries.length === 0) return;
            const written = yield* store.record(
              options.afterRestart === true
                ? entries.map((entry) => ({ ...entry, reopenAfterRestart: true }))
                : entries,
            );
            if (!written) return yield* new ClosedQuestionsNotRecorded({});
            for (const entry of entries) known.add(entry.requestId);
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("service-update.prepare.record-questions-failed", { cause }).pipe(
                Effect.andThen(Effect.fail(new ClosedQuestionsNotRecorded({ cause }))),
              ),
            ),
          ),
      });
    const whileDraining = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Option.isSome(closedQuestions) ? closedQuestions.value.draining(effect) : effect;

    /**
     * Polls until no run (that `only` keeps) is active or the time is up; true
     * when none is left. `onLook` runs at each look (a drain records what was
     * asked meanwhile, before the turn's end can cancel it).
     */
    const awaitRunsSettled = <E = never>(
      budgetMs: number,
      only: (run: ActiveRun) => boolean = () => true,
      onLook: Effect.Effect<void, E> = Effect.void,
    ) =>
      Effect.gen(function* () {
        const deadline = (yield* Clock.currentTimeMillis) + budgetMs;
        while (true) {
          yield* onLook;
          const active = (yield* readActiveRuns).filter(only);
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

    /**
     * Ends turns whose provider never answered the interrupt (a hung CLI, a dead
     * socket): every active run, or only those `only` keeps.
     */
    const forceEndRuns = (
      nonce: string,
      deadline: number,
      only: (run: ActiveRun) => boolean = () => true,
      record: Effect.Effect<void, ClosedQuestionsNotRecorded> = Effect.void,
    ) =>
      Effect.gen(function* () {
        // Closing a process cancels what its turn asked: recorded first.
        yield* record;
        const endRun = (run: ActiveRun) =>
          Effect.gen(function* () {
            // Close its process, then end the turn the way a completed Stop does.
            if (run.providerSessionId !== null) {
              yield* providerSessions
                .release({
                  providerSessionId: ProviderSessionId.make(run.providerSessionId),
                  reason: "manual_shutdown",
                  detail: RELEASE_DETAIL,
                  keepMcpCredentials: true,
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
        const runs = (yield* readActiveRuns).filter(only);
        yield* boundedBy(
          deadline,
          Effect.forEach(runs, endRun, { concurrency: "unbounded", discard: true }),
        );
        yield* awaitRunsSettled(yield* within(deadline, timings.settleMs), only, record);
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
              cause: "service_update",
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
    const stopRound = (
      nonce: string,
      touched: Set<string>,
      deadline: number,
      record: Effect.Effect<void, ClosedQuestionsNotRecorded>,
    ) =>
      Effect.gen(function* () {
        // What a turn asked since the last round, before this round stops it.
        yield* record;
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
              cause: "service_update",
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
              cause: "service_update",
            })
            .pipe(logged("stop-failed", { threadId }));
        }
        if (
          !(yield* awaitRunsSettled(
            yield* within(deadline, timings.interruptGraceMs),
            undefined,
            record,
          ))
        )
          yield* forceEndRuns(nonce, deadline, undefined, record);
      });

    /**
     * What Stop cannot end on its own: turns that never reached their provider,
     * requests whose run already ended, session rows whose process is gone,
     * effects nobody will finish, and terminal shells.
     */
    const clearLeftovers = (
      nonce: string,
      deadline: number,
      record: Effect.Effect<void, ClosedQuestionsNotRecorded>,
    ) =>
      Effect.gen(function* () {
        // Closing an agent process cancels what its turn asked: recorded first.
        yield* record;
        // Agent processes, including any still busy after Stop, also block the helper.
        // A turn started after the last stop round (a delegated task's wake-up) is
        // cut here: its stream ends rather than fails, so finalizeStuckRuns below
        // marks it stopped for the update and the restart continues it. A turn
        // still starting would fail its start instead, so starts finish first.
        yield* awaitRunsSettled(yield* within(deadline, timings.settleMs), isStartInFlight, record);
        yield* boundedBy(
          deadline,
          providerSessions
            .releaseIdle({
              detail: RELEASE_DETAIL,
              includeBusy: true,
              keepMcpCredentials: true,
              endStreams: true,
            })
            .pipe(logged("release-sessions-failed", {})),
        );
        // Closing a busy session can end its turn through the provider's own events.
        if ((yield* readActiveRuns).length > 0)
          yield* awaitRunsSettled(yield* within(deadline, timings.settleMs), undefined, record);
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
        // Anything asked since the last record is recorded before it is closed.
        yield* record;
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

    const stopWork = (input: {
      readonly rounds: number;
      readonly deadline: number;
      readonly record: Effect.Effect<void, ClosedQuestionsNotRecorded>;
    }) =>
      Effect.gen(function* () {
        const nonce = yield* Clock.currentTimeMillis;
        const touched = new Set<string>();
        const activeBefore = (yield* readActiveRuns).map((active) => active.runId);
        // An interrupted worker can wake its coordinator, which queues or starts a new
        // turn; later rounds stop that too. A held service defers those wakes.
        for (let round = 0; round < input.rounds; round += 1) {
          yield* stopRound(`${nonce}:${round}`, touched, input.deadline, input.record);
          const left = yield* readBlockerRows;
          if (!left.some((row) => row.kind === "run" || row.kind === "queued")) break;
        }
        const closedTerminals = yield* clearLeftovers(
          `${nonce}:cleanup`,
          input.deadline,
          input.record,
        );
        const interruptedRuns = (yield* readRunStatuses(activeBefore)).filter(
          (row) => row.status === "interrupted",
        ).length;
        return { stoppedThreads: touched.size, interruptedRuns, closedTerminals };
      });

    const report = (rows: ReadonlyArray<BlockerRow>) =>
      Effect.gen(function* () {
        const summarized = summarizeBlockers(rows);
        const current = Option.isSome(settings)
          ? yield* settings.value.getSettings.pipe(Effect.orElseSucceed(() => null))
          : null;
        const blockers =
          current === null
            ? summarized
            : summarized.map((blocker) => ({
                ...blocker,
                continuesAfterRestart: resolveProjectSettings(current, blocker.projectId).settings
                  .continueThreadsAfterServerUpdate,
              }));
        return { idle: blockers.length === 0, blockers };
      });

    const holdUntil = Effect.gen(function* () {
      if (Option.isNone(hold)) return {};
      const current = yield* hold.value.current;
      if (Option.isNone(current)) return {};
      const holdReason = current.value.reason;
      return {
        holdUntil: DateTime.formatIso(DateTime.makeUnsafe(current.value.expiresAtMs)),
        ...(holdReason === "app-restart" || holdReason === "install" ? { holdReason } : {}),
      };
    });

    const drain = (input: {
      readonly holding: boolean;
      readonly reason: ServiceUpdatePrepareReason;
    }) =>
      Effect.gen(function* () {
        // An app restart may never be followed by an install request: hold briefly.
        const ttlMs =
          input.reason === "app-restart" ? ServiceUpdateHold.APP_RESTART_HOLD_TTL_MS : undefined;
        const acquire = (draining: boolean) =>
          Option.isSome(hold) && input.holding
            ? hold.value.acquire({
                reason: input.reason,
                draining,
                ...(ttlMs === undefined ? {} : { ttlMs }),
              })
            : Effect.void;
        // Held before the drain, so nothing new starts behind it.
        yield* acquire(true);
        const deadline = (yield* Clock.currentTimeMillis) + timings.deadlineMs;
        // Recorded before any turn stops (an interrupt can cancel its own
        // request), and again before each step that can close one.
        const known = new Set<string>();
        const drained = yield* stopWork({
          rounds: input.holding ? HELD_STOP_ROUNDS : STOP_ROUNDS,
          deadline,
          record: recordOpenRequests(known),
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
        yield* acquire(false);
        return { rows, drained };
      });

    const prepare = (input: ServerPrepareServiceUpdateInput) =>
      Effect.gen(function* () {
        const reason = input.reason ?? "install";
        // A hold refuses everyone's work: record who asked for one, at the level the fleet logs.
        if (input.stopWork || input.releaseHold === true) {
          yield* Effect.logWarning("service-update.prepare.requested", {
            reason,
            stopWork: input.stopWork,
            hold: input.hold === true,
            releaseHold: input.releaseHold === true,
          });
        }
        if (input.releaseHold === true) {
          if (Option.isSome(hold)) yield* hold.value.release("cancelled");
          return {
            ...(yield* report(yield* readBlockerRows)),
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
            ...(yield* report(rows)),
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
        const { rows, drained } = yield* whileDraining(drain({ holding, reason })).pipe(
          // A drain that failed or was cut off (a closed window) installs nothing:
          // nobody would release the hold, so work may start again now.
          Effect.onError(() =>
            holding && Option.isSome(hold) ? hold.value.release("prepare-aborted") : Effect.void,
          ),
        );
        const held = yield* isHeld;
        const result = {
          ...(yield* report(rows)),
          stoppedThreads: drained.stoppedThreads,
          held,
          ...(held ? yield* holdUntil : {}),
          interruptedRuns: drained.interruptedRuns,
          openTerminals: drained.closedTerminals,
        };
        yield* Effect.logWarning("service-update.prepare", {
          reason,
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
                      message: Cause.findErrorOption(cause).pipe(
                        Option.exists((error) => error instanceof ClosedQuestionsNotRecorded),
                      )
                        ? NOT_RECORDED_MESSAGE
                        : "Could not check what is still running.",
                    }),
                  ),
                ),
              ),
        ),
      );

    /** A thread's pending requests and latest event, as `StaleWaitThread` keeps them. */
    const readWaitState = (threadId: string) =>
      Effect.gen(function* () {
        const requests = yield* sql<{
          readonly runtime_request_id: string;
          readonly kind: string;
          readonly created_at: string | null;
        }>`
          SELECT runtime_request_id, kind, created_at
            FROM orchestration_v2_projection_runtime_requests
           WHERE thread_id = ${threadId} AND status = 'pending'
           ORDER BY runtime_request_id
        `;
        const latest = yield* sql<{ readonly sequence: number; readonly occurred_at: string }>`
          SELECT sequence, occurred_at FROM orchestration_v2_events
           WHERE thread_id = ${threadId} ORDER BY sequence DESC LIMIT 1
        `;
        const shown = yield* sql<{
          readonly archived: number;
          readonly settled: number;
          readonly settled_at: string | null;
        }>`
          SELECT (deleted_at IS NOT NULL OR archived_at IS NOT NULL
                  OR json_extract(payload_json, '$.archivedAt') IS NOT NULL) AS archived,
                 json_extract(payload_json, '$.settledOverride') IS 'settled' AS settled,
                 json_extract(payload_json, '$.settledAt') AS settled_at
            FROM orchestration_v2_projection_threads
           WHERE thread_id = ${threadId}
        `;
        const thread = shown[0];
        const hidden =
          thread !== undefined &&
          hiddenFromNeedsYou(
            {
              archived: Boolean(thread.archived),
              settled: Boolean(thread.settled),
              settledAt: thread.settled_at,
            },
            requests,
          );
        return { requests, latest: latest[0] ?? null, hidden };
      });

    /**
     * The threads that only wait on a person, when nothing else blocks the
     * update: every blocker is a run, request or session of such a thread, and
     * either Needs you does not show the thread (`hiddenFromNeedsYou`), or each
     * of its pending requests is an approval or a question (or a card asking a
     * closed one again) older than `STALE_WAIT_MS` and nothing was recorded on
     * it for as long. Empty otherwise.
     */
    const selectStaleWaits = Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const rows = yield* readBlockerRows;
      const kinds = new Map<string, Set<ServiceUpdateBlockerKind>>();
      for (const row of rows) {
        // Work that belongs to no thread cannot be waiting on a person.
        if (row.threadId === null || !WAITING_KINDS.has(row.kind)) return [];
        const seen = kinds.get(row.threadId) ?? new Set();
        seen.add(row.kind);
        kinds.set(row.threadId, seen);
      }
      const cutoffMs = nowMs - STALE_WAIT_MS;
      const selected: Array<StaleWaitThread> = [];
      for (const [threadId, seen] of kinds) {
        if (!seen.has("request")) return [];
        const { requests, latest, hidden } = yield* readWaitState(threadId);
        if (requests.length === 0) return [];
        if (!hidden) {
          if (
            !requests.every(
              (request) =>
                // A card that asks a closed approval again waits like that approval did.
                (STALE_WAIT_REQUEST_KINDS.has(request.kind) ||
                  ClosedQuestions.isReopenedApprovalRequestId(request.runtime_request_id)) &&
                request.created_at !== null &&
                atOrBefore(request.created_at, cutoffMs),
            )
          )
            return [];
          if (!atOrBefore(latest?.occurred_at ?? null, cutoffMs)) return [];
        }
        selected.push({
          threadId,
          requestIds: requests.map((request) => request.runtime_request_id).join("\n"),
          latestSequence: latest?.sequence ?? null,
          ...(hidden ? { hidden: true } : {}),
        });
      }
      return selected;
    });

    /** Whether a selected thread still looks as it did: nobody answered or did anything since. */
    const unchangedSince = (selected: StaleWaitThread) =>
      Effect.map(
        readWaitState(selected.threadId),
        ({ requests, latest }) =>
          requests.map((request) => request.runtime_request_id).join("\n") ===
            selected.requestIds && (latest?.sequence ?? null) === selected.latestSequence,
      );

    /**
     * Stops the threads `selectStaleWaits` picked, so an automatic install can
     * go ahead. Each thread is read again just before its turn is interrupted
     * and skipped when it changed since it was picked. Each turn gets a plain
     * interrupt (a turn whose provider does not answer is ended locally, its
     * agent process closed), what is left ends `interrupted` with the update
     * named as the cause, and each request is cancelled with the reason. The
     * person continues the thread when back. A thread Needs you does not show
     * is stopped the same way, with `HIDDEN_WAIT_REASON`, and nothing it asked
     * is recorded to be asked again.
     */
    const releaseSelected = (selected: ReadonlyArray<StaleWaitThread>) =>
      Effect.gen(function* () {
        if (selected.length === 0) return { releasedThreads: [] };
        const nowMs = yield* Clock.currentTimeMillis;
        const nonce = `${nowMs}:stale`;
        const deadline = nowMs + timings.deadlineMs;
        const activeRuns = yield* readActiveRuns;
        const stale: Array<string> = [];
        const hidden = new Set<string>();
        const runs: Array<ActiveRun> = [];
        for (const thread of selected) {
          if (!(yield* unchangedSince(thread))) {
            yield* Effect.logInfo("service-update.stale-waits.changed", {
              threadId: thread.threadId,
            });
            continue;
          }
          // Recorded before anything closes, and asked again after the restart
          // that installs the update. Without a record the thread keeps waiting.
          // A thread nobody is shown is not asked again.
          const recorded =
            thread.hidden === true ||
            (yield* recordOpenRequests(new Set(), {
              threadIds: [thread.threadId],
              afterRestart: true,
            }).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            ));
          if (!recorded) continue;
          stale.push(thread.threadId);
          if (thread.hidden === true) hidden.add(thread.threadId);
          for (const run of activeRuns) {
            if (run.threadId !== thread.threadId) continue;
            runs.push(run);
            yield* threads
              .dispatch({
                type: "run.interrupt",
                commandId: CommandId.make(`service-update:${nonce}:interrupt:${run.runId}`),
                threadId: ThreadId.make(run.threadId),
                runId: RunId.make(run.runId),
                reason: thread.hidden === true ? HIDDEN_WAIT_REASON : STALE_WAIT_REASON,
                cause: "service_update",
              })
              .pipe(logged("stale-interrupt-failed", { threadId: run.threadId, runId: run.runId }));
          }
        }
        if (stale.length === 0) return { releasedThreads: [] };
        const scope = new Set(stale);
        const inScope = (run: ActiveRun) => scope.has(run.threadId);
        yield* Effect.logWarning("service-update.stale-waits.release", { threads: stale.length });
        if (!(yield* awaitRunsSettled(yield* within(deadline, timings.interruptGraceMs), inScope)))
          yield* forceEndRuns(nonce, deadline, inScope);
        // A turn its provider ended can leave its agent process waiting on the
        // answer; it is closed too, and the next turn opens a new one.
        const sessionIds = new Set(
          runs.flatMap((run) => (run.providerSessionId === null ? [] : [run.providerSessionId])),
        );
        yield* boundedBy(
          deadline,
          Effect.forEach(
            sessionIds,
            (providerSessionId) =>
              providerSessions
                .release({
                  providerSessionId: ProviderSessionId.make(providerSessionId),
                  reason: "manual_shutdown",
                  detail: RELEASE_DETAIL,
                  keepMcpCredentials: true,
                })
                .pipe(logged("stale-release-failed", { providerSessionId })),
            { concurrency: "unbounded", discard: true },
          ),
        );
        // Each group ends with its own reason; an empty one is skipped, since no
        // thread ids means every thread to the cleanup.
        const groups = [
          { reason: STALE_WAIT_REASON, threadIds: stale.filter((id) => !hidden.has(id)) },
          { reason: HIDDEN_WAIT_REASON, threadIds: stale.filter((id) => hidden.has(id)) },
        ].filter((group) => group.threadIds.length > 0);
        for (const group of groups)
          yield* cleanup.finalizeStuckRuns({
            nonce,
            reason: group.reason,
            threadIds: group.threadIds,
          });
        for (const request of yield* cleanup.listMessageModeRequests) {
          if (!scope.has(request.threadId)) continue;
          yield* threads
            .dispatch({
              type: "thread.user-input.dismiss",
              commandId: CommandId.make(`service-update:${nonce}:dismiss:${request.requestId}`),
              threadId: request.threadId,
              requestId: request.requestId,
            })
            .pipe(logged("stale-dismiss-failed", { requestId: request.requestId }));
        }
        for (const group of groups)
          yield* cleanup.cancelPendingRequests({
            nonce,
            reason: group.reason,
            threadIds: group.threadIds,
          });
        yield* cleanup.reconcileOrphanedSessions;
        return { releasedThreads: stale };
      });

    const releaseStaleWaits = Effect.flatMap(selectStaleWaits, releaseSelected);

    return {
      service: ServiceUpdatePreparation.of({ prepare }),
      selectStaleWaits,
      releaseSelected,
      releaseStaleWaits,
      isHeld,
    };
  });

export const makeWithTimings = (timings: ServiceUpdatePreparationTimings) =>
  Effect.map(makePartsWithTimings(timings), (parts) => parts.service);

export const make = makeWithTimings(DEFAULT_TIMINGS);

/**
 * One look for threads that only wait on a person, made only while the update
 * agent waits for a quiet moment to install (`agentWaiting`) and this process
 * is not held for "Update now", whose drain stops everything anyway.
 */
export const sweepStaleWaits = <E>(input: {
  readonly agentWaiting: Effect.Effect<boolean>;
  readonly isHeld: Effect.Effect<boolean>;
  readonly releaseStaleWaits: Effect.Effect<StaleWaitRelease, E>;
}): Effect.Effect<StaleWaitRelease> =>
  Effect.gen(function* () {
    if (!(yield* input.agentWaiting) || (yield* input.isHeld)) return { releasedThreads: [] };
    return yield* input.releaseStaleWaits;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("service-update.stale-waits.failed", { cause }).pipe(
        Effect.as({ releasedThreads: [] }),
      ),
    ),
  );

export const layer = Layer.effect(
  ServiceUpdatePreparation,
  Effect.gen(function* () {
    const parts = yield* makePartsWithTimings(DEFAULT_TIMINGS);
    // Both are absent in tools and tests that build the runtime alone: no sweep then.
    const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
    const fileSystem = yield* Effect.serviceOption(FileSystem.FileSystem);
    const path = yield* Effect.serviceOption(Path.Path);
    if (Option.isSome(config) && Option.isSome(fileSystem) && Option.isSome(path)) {
      const statePath = path.value.join(config.value.baseDir, "updates", "state.json");
      const agentWaiting = fileSystem.value.readFileString(statePath).pipe(
        Effect.map(agentWaitsForQuiet),
        Effect.orElseSucceed(() => false),
      );
      yield* Effect.sleep(Duration.millis(STALE_WAIT_SWEEP_MS)).pipe(
        Effect.andThen(
          sweepStaleWaits({
            agentWaiting,
            isHeld: parts.isHeld,
            releaseStaleWaits: parts.releaseStaleWaits,
          }),
        ),
        Effect.forever,
        Effect.forkScoped,
      );
    }
    return parts.service;
  }),
);
