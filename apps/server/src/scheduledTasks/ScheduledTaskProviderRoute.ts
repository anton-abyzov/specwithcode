import {
  isProviderAvailable,
  ORCHESTRATION_V2_PROVIDER_OPEN_FAILED_FAILURE_CODE,
  ORCHESTRATION_V2_PROVIDER_UNAVAILABLE_FAILURE_CODE,
  ProviderInstanceId,
  type ModelSelection,
  type ScheduledTask,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { providersChecking } from "@specweave-studio/shared/coordinatorDefault";
import {
  canTakeTurn,
  providerUsedPercent,
  reportsNoUsage,
  resolveProviderFallback,
  usageDeniesTurn,
  usageResetAt,
  type ProviderFallbackRule,
} from "@specweave-studio/shared/providerFallback";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import {
  LIMIT_FALLBACK_MESSAGE_PREFIX,
  LIMIT_STOP_MAX_AGE_MS,
  PROVIDER_FALLBACK_MESSAGE_PREFIX,
  UNOPENABLE_HOLD_MS,
} from "../orchestration-v2/ProviderFallbackWorker.ts";
import { projectCompatibleProviders } from "../project/ProjectProviderCompatibility.ts";
import { taskError } from "./ScheduledTaskStorage.ts";

/**
 * Failure codes a run ends with when its provider could not open a session:
 * `provider_unavailable` (setup) and `provider_open_failed` (any other open
 * failure). Matched by code, never by message.
 */
export const OPEN_FAILURE_CODES: ReadonlyArray<string> = [
  ORCHESTRATION_V2_PROVIDER_UNAVAILABLE_FAILURE_CODE,
  ORCHESTRATION_V2_PROVIDER_OPEN_FAILED_FAILURE_CODE,
];

/** A deferred fire waits at least this long, so a provider read can change first. */
export const DEFER_MIN_MS = 5 * 60_000;
/** A deferred fire with no reset time to aim at tries again after this long. */
export const DEFER_DEFAULT_MS = 15 * 60_000;
/** A deferred fire never waits longer than this before checking again. */
export const DEFER_MAX_MS = 60 * 60_000;

/** When a deferred fire tries again: the soonest known reset, else 15 minutes; 5 to 60 minutes out. */
export function deferUntil(nowMs: number, resets: ReadonlyArray<number | null>): number {
  const soonest = Math.min(
    nowMs + DEFER_DEFAULT_MS,
    ...resets.filter((at): at is number => at !== null && Number.isFinite(at) && at > nowMs),
  );
  return Math.min(Math.max(soonest, nowMs + DEFER_MIN_MS), nowMs + DEFER_MAX_MS);
}

/** One of the destination thread's recent runs, latest first. */
export interface RouteRun {
  readonly runId: string;
  readonly instanceId: string | null;
  readonly model: string | null;
  readonly status: string;
  readonly completedAtMs: number | null;
  readonly userMessageId: string | null;
  /** Code and message of the run's latest open failure, if it ended on one. */
  readonly openFailureCode: string | null;
  readonly openFailureMessage: string | null;
  /** The run stopped on the usage limit; when it said the limit resets. */
  readonly limitStop: boolean;
  readonly limitResetAtMs: number | null;
}

export interface RouteInput {
  /** Every provider this machine reports. */
  readonly providers: ReadonlyArray<ServerProvider>;
  /** The providers the routine's project can run on; fallback targets come from these. */
  readonly candidates: ReadonlyArray<ServerProvider>;
  /** The model the dispatch sends, or undefined to keep the destination thread's provider. */
  readonly modelSelection: ModelSelection | undefined;
  /** The destination thread's provider and model, or null for a new thread. */
  readonly thread: { readonly instanceId: string | null; readonly model: string | null } | null;
  readonly threadId: string | null;
  readonly runs: ReadonlyArray<RouteRun>;
  /** Instances some thread failed to open on recently, with when. */
  readonly openFailures: ReadonlyMap<string, number>;
  /** The project's limit rule, or null when this host has no settings to read. */
  readonly rule: ProviderFallbackRule | null;
  readonly nowMs: number;
}

export type RoutineRoute =
  /** Dispatch with this model (undefined keeps the thread's provider); `note` says why it moved. */
  | {
      readonly type: "fire";
      readonly modelSelection: ModelSelection | undefined;
      readonly note: string | null;
    }
  /** Nothing can take the run now: keep this occurrence and try again at `untilMs`. */
  | { readonly type: "defer"; readonly untilMs: number; readonly reason: string };

const nameOf = (provider: ServerProvider) => provider.displayName ?? provider.instanceId;

/**
 * Instances still held after an open failure: no read since shows them able
 * to take a turn, and no run has started on them since (see `readRouteState`).
 */
function activeHolds(input: RouteInput): ReadonlyMap<string, number> {
  const held = new Map<string, number>();
  for (const [instanceId, failedAt] of input.openFailures) {
    if (input.nowMs - failedAt >= UNOPENABLE_HOLD_MS) continue;
    const provider = input.providers.find((entry) => entry.instanceId === instanceId);
    if (provider !== undefined && readyAfter(provider, failedAt)) continue;
    held.set(instanceId, failedAt);
  }
  return held;
}

/** A read taken after `atMs` found the provider able to take a turn. */
const readyAfter = (provider: ServerProvider, atMs: number) =>
  Date.parse(provider.checkedAt) > atMs && canTakeTurn(provider);

/** The usage read says the provider has no room for `model` now. */
const limitedNow = (provider: ServerProvider, nowMs: number, model: string | null) =>
  usageDeniesTurn(provider) || (providerUsedPercent(provider, nowMs, model) ?? 0) >= 100;

/**
 * Whether a failed open says the provider cannot open, not just that one
 * attempt failed. `provider_unavailable` always does. `provider_open_failed`
 * can be transient, so it counts only for a fallback move, or when the run
 * before it on the same provider failed to open too, within the limit-stop
 * window: one transient error never moves a thread.
 */
function openFailureConfirmed(run: RouteRun, input: RouteInput): boolean {
  if (run.openFailureCode === ORCHESTRATION_V2_PROVIDER_UNAVAILABLE_FAILURE_CODE) return true;
  if (run.openFailureCode === null) return false;
  const message = run.userMessageId ?? "";
  if (
    input.threadId !== null &&
    (message.startsWith(`${LIMIT_FALLBACK_MESSAGE_PREFIX}${input.threadId}:`) ||
      message.startsWith(`${PROVIDER_FALLBACK_MESSAGE_PREFIX}${input.threadId}:`))
  )
    return true;
  const previous = input.runs.find(
    (candidate) => candidate.runId !== run.runId && candidate.instanceId === run.instanceId,
  );
  return (
    previous?.status === "failed" &&
    previous.openFailureCode !== null &&
    (run.completedAtMs ?? 0) - (previous.completedAtMs ?? 0) < LIMIT_STOP_MAX_AGE_MS
  );
}

interface Blocked {
  readonly detail: string;
  /** The block is a usage limit, which a reset ends. */
  readonly limit: boolean;
  /** When the block is expected to end, if known. */
  readonly endsAtMs: number | null;
}

/**
 * Why `provider` cannot take this run now, or null. Disabled, signed out or
 * unavailable on this machine; its latest run on the destination thread
 * failed to open it (see `openFailureConfirmed`), or any thread's run in the
 * last 30 minutes found it unavailable, with no ready read since; or it is at its usage limit by its own read or by the thread's
 * latest stop. Not installed or not prepared alone does not block: a session
 * start installs an on-demand agent.
 */
function blockedOn(
  provider: ServerProvider,
  model: string | null,
  input: RouteInput,
  holds: ReadonlyMap<string, number>,
): Blocked | null {
  if (!provider.enabled) return { detail: "It is disabled.", limit: false, endsAtMs: null };
  if (provider.auth.status === "unauthenticated")
    return { detail: "It is signed out.", limit: false, endsAtMs: null };
  if (!isProviderAvailable(provider))
    return {
      detail: provider.unavailableReason ?? provider.message ?? "It is unavailable.",
      limit: false,
      endsAtMs: null,
    };
  const latest = input.runs[0];
  if (
    latest?.instanceId === provider.instanceId &&
    latest.status === "failed" &&
    openFailureConfirmed(latest, input) &&
    !readyAfter(provider, latest.completedAtMs ?? 0)
  )
    return {
      detail: latest.openFailureMessage ?? "It could not open a session.",
      limit: false,
      endsAtMs: (latest.completedAtMs ?? input.nowMs) + UNOPENABLE_HOLD_MS,
    };
  const heldSince = holds.get(provider.instanceId);
  if (heldSince !== undefined)
    return {
      detail: "Another thread found it unavailable.",
      limit: false,
      endsAtMs: heldSince + UNOPENABLE_HOLD_MS,
    };
  if (limitedNow(provider, input.nowMs, model))
    return {
      detail: "It is at its usage limit.",
      limit: true,
      endsAtMs: usageResetAt(provider, 100, input.nowMs, model),
    };
  // A provider that reports no usage is limited only by the thread's own stop.
  if (
    latest?.instanceId === provider.instanceId &&
    latest.status === "failed" &&
    latest.limitStop
  ) {
    const reset = latest.limitResetAtMs;
    const current =
      reset !== null
        ? reset > input.nowMs
        : reportsNoUsage(provider) &&
          input.nowMs - (latest.completedAtMs ?? 0) < LIMIT_STOP_MAX_AGE_MS;
    if (current) return { detail: "It is at its usage limit.", limit: true, endsAtMs: reset };
  }
  return null;
}

interface FallbackOrigin {
  readonly selection: ModelSelection;
  readonly stoppedAtMs: number;
  readonly resetAtMs: number | null;
}

/**
 * Where the thread ran before the limit fallback moved it, when its runs
 * since the move all ran on the fallback's provider. Null for a thread a
 * person moved, and for one the provider fallback moved off a provider that
 * could not open: nothing goes back from that move, the same as the
 * fallback's own way back, since a provider whose read says ready can still
 * fail to open, and going back each fire would fail and move the thread again.
 */
export function fallbackOrigin(
  threadId: string,
  instanceId: string,
  runs: ReadonlyArray<RouteRun>,
): FallbackOrigin | null {
  for (const run of runs) {
    if (run.instanceId !== instanceId) return null;
    const message = run.userMessageId ?? "";
    if (message.startsWith(`${PROVIDER_FALLBACK_MESSAGE_PREFIX}${threadId}:`)) return null;
    if (!message.startsWith(`${LIMIT_FALLBACK_MESSAGE_PREFIX}${threadId}:`)) continue;
    // `<prefix><thread>:[hop-N:]<stopped run>`: the stopped run id comes last.
    const stopped = runs.find(
      (candidate) => candidate.runId !== run.runId && message.endsWith(`:${candidate.runId}`),
    );
    if (
      stopped === undefined ||
      stopped.instanceId === null ||
      stopped.instanceId === instanceId ||
      stopped.model === null
    )
      return null;
    return {
      selection: { instanceId: ProviderInstanceId.make(stopped.instanceId), model: stopped.model },
      stoppedAtMs: stopped.completedAtMs ?? 0,
      resetAtMs: stopped.limitResetAtMs,
    };
  }
  return null;
}

/**
 * Whether the limit fallback's origin can take this run now: its reset has
 * passed, or a read since the stop shows room.
 */
function originReady(
  origin: FallbackOrigin,
  input: RouteInput,
  holds: ReadonlyMap<string, number>,
): boolean {
  const provider = input.candidates.find(
    (entry) => entry.instanceId === origin.selection.instanceId,
  );
  if (provider === undefined || !canTakeTurn(provider) || holds.has(provider.instanceId))
    return false;
  if (limitedNow(provider, input.nowMs, origin.selection.model)) return false;
  if (origin.resetAtMs !== null) return origin.resetAtMs <= input.nowMs;
  return Date.parse(provider.checkedAt) > origin.stoppedAtMs && !reportsNoUsage(provider);
}

/**
 * Which model a fire dispatches on, or that it waits. A thread the limit
 * fallback moved goes back to where it ran before once that provider can
 * take a turn, the way the fallback's own way back does. When
 * the provider the run would use cannot take it, the `switch` rule moves it
 * to the first ready fallback with that provider excluded; under `ask` and
 * `wait`, or with nothing ready, the fire waits for the provider's reset or
 * a later read.
 */
export function routineRoute(input: RouteInput): RoutineRoute {
  const fire: RoutineRoute = { type: "fire", modelSelection: input.modelSelection, note: null };
  const holds = activeHolds(input);
  const instanceId = input.modelSelection?.instanceId ?? input.thread?.instanceId ?? null;
  if (instanceId === null) return fire;
  const model = input.modelSelection?.model ?? input.thread?.model ?? null;
  const origin =
    input.modelSelection === undefined && input.threadId !== null
      ? fallbackOrigin(input.threadId, instanceId, input.runs)
      : null;
  if (origin !== null) {
    if (originReady(origin, input, holds)) {
      const back = input.providers.find(
        (entry) => entry.instanceId === origin.selection.instanceId,
      );
      return {
        type: "fire",
        modelSelection: origin.selection,
        note: `Back on ${back === undefined ? origin.selection.instanceId : nameOf(back)}.`,
      };
    }
  }
  const provider = input.providers.find((entry) => entry.instanceId === instanceId);
  // An unknown provider, or one still awaiting its first check, fires as before.
  if (provider === undefined || providersChecking([provider])) return fire;
  const blocked = blockedOn(provider, model, input, holds);
  if (blocked === null) return fire;
  const name = nameOf(provider);
  const why = blocked.limit
    ? `${name} is at its usage limit.`
    : `${name} cannot start on this machine: ${blocked.detail}`;
  if (input.rule?.providerLimitAction === "switch") {
    const target = resolveProviderFallback({
      providers: input.candidates,
      currentInstanceId: provider.instanceId,
      ...(model === null ? {} : { currentModel: model }),
      currentOptions: input.modelSelection?.options,
      rule: input.rule,
      nowMs: input.nowMs,
      belowPercent: input.rule.providerLimitSwitchAtPercent ?? 100,
      anyReady: true,
      limitedInstanceIds: new Set([...holds.keys(), provider.instanceId]),
    });
    if (target !== null) {
      const to = input.providers.find((entry) => entry.instanceId === target.instanceId);
      return {
        type: "fire",
        modelSelection: target,
        note: `Moved to ${to === undefined ? target.instanceId : nameOf(to)}: ${why}`,
      };
    }
  }
  // The origin's reset is the way back, so it is worth waking for too.
  return {
    type: "defer",
    untilMs: deferUntil(input.nowMs, [blocked.endsAtMs, origin?.resetAtMs ?? null]),
    reason: why,
  };
}

const epoch = (value: string | null) => {
  const ms = Date.parse(value ?? "");
  return Number.isFinite(ms) ? ms : null;
};

/**
 * Reads what `routineRoute` needs about the destination: its thread's
 * provider and recent runs, and the instances any thread found unavailable
 * (`provider_unavailable`) within the hold. Another thread's single
 * `provider_open_failed` may be transient, so it holds nothing here.
 */
export const readRouteState = Effect.fn("ScheduledTaskService.readRouteState")(function* (
  task: Pick<ScheduledTask, "id">,
  threadId: string | null,
  nowMs: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const fail = (cause: unknown) =>
    taskError("Could not read routine destination.", { taskId: task.id, cause });
  const codes = OPEN_FAILURE_CODES;
  const threads =
    threadId === null
      ? []
      : yield* sql<{ readonly instance_id: string | null; readonly model: string | null }>`
          SELECT provider_instance_id AS instance_id,
                 json_extract(payload_json, '$.modelSelection.model') AS model
          FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
        `.pipe(Effect.mapError(fail));
  const rows =
    threadId === null
      ? []
      : yield* sql<{
          readonly run_id: string;
          readonly instance_id: string | null;
          readonly model: string | null;
          readonly status: string;
          readonly completed_at: string | null;
          readonly user_message_id: string | null;
          readonly open_code: string | null;
          readonly open_message: string | null;
          readonly limit_stop: number;
          readonly limit_reset_at: string | null;
        }>`
          SELECT run.run_id,
                 run.provider_instance_id AS instance_id,
                 json_extract(run.payload_json, '$.modelSelection.model') AS model,
                 run.status,
                 run.completed_at,
                 COALESCE(
                   json_extract(run.payload_json, '$.startMessageId'),
                   json_extract(run.payload_json, '$.userMessageId')
                 ) AS user_message_id,
                 open_failure.code AS open_code,
                 open_failure.message AS open_message,
                 EXISTS (
                   SELECT 1 FROM orchestration_v2_projection_turn_items item
                   WHERE item.run_id = run.run_id AND item.type = 'error'
                     AND json_extract(item.payload_json, '$.failure.class') = 'usage_limit'
                 ) AS limit_stop,
                 (
                   SELECT MAX(json_extract(item.payload_json, '$.failure.resetAt'))
                   FROM orchestration_v2_projection_turn_items item
                   WHERE item.run_id = run.run_id AND item.type = 'error'
                     AND json_extract(item.payload_json, '$.failure.class') = 'usage_limit'
                 ) AS limit_reset_at
          FROM orchestration_v2_projection_runs run
          LEFT JOIN (
            SELECT item.run_id,
                   json_extract(item.payload_json, '$.failure.code') AS code,
                   json_extract(item.payload_json, '$.failure.message') AS message,
                   ROW_NUMBER() OVER (PARTITION BY item.run_id ORDER BY item.ordinal DESC) AS position
            FROM orchestration_v2_projection_turn_items item
            WHERE item.thread_id = ${threadId} AND item.type = 'error'
              AND json_extract(item.payload_json, '$.failure.code') IN ${sql.in(codes)}
          ) open_failure ON open_failure.run_id = run.run_id AND open_failure.position = 1
          WHERE run.thread_id = ${threadId}
          ORDER BY run.ordinal DESC
          LIMIT 20
        `.pipe(Effect.mapError(fail));
  const since = DateTime.formatIso(DateTime.makeUnsafe(nowMs - UNOPENABLE_HOLD_MS));
  const failures = yield* sql<{ readonly instance_id: string; readonly failed_at: string }>`
    SELECT run.provider_instance_id AS instance_id, MAX(run.completed_at) AS failed_at
    FROM orchestration_v2_projection_runs run
    WHERE run.status = 'failed' AND run.completed_at >= ${since}
      AND run.provider_instance_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM orchestration_v2_projection_turn_items item
        WHERE item.run_id = run.run_id AND item.type = 'error'
          AND json_extract(item.payload_json, '$.failure.code') = ${ORCHESTRATION_V2_PROVIDER_UNAVAILABLE_FAILURE_CODE}
      )
      -- A run that started on the instance since shows it opens again.
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_runs later
        WHERE later.provider_instance_id = run.provider_instance_id
          AND json_extract(later.payload_json, '$.startedAt') > run.completed_at
      )
    GROUP BY run.provider_instance_id
  `.pipe(Effect.mapError(fail));
  const openFailures = new Map<string, number>();
  for (const row of failures) {
    const at = epoch(row.failed_at);
    if (at !== null) openFailures.set(row.instance_id, at);
  }
  return {
    thread:
      threads[0] === undefined
        ? null
        : { instanceId: threads[0].instance_id, model: threads[0].model },
    runs: rows.map((row): RouteRun => ({
      runId: row.run_id,
      instanceId: row.instance_id,
      model: row.model,
      status: row.status,
      completedAtMs: epoch(row.completed_at),
      userMessageId: row.user_message_id,
      openFailureCode: row.open_code,
      openFailureMessage: row.open_message,
      limitStop: Number(row.limit_stop) === 1,
      limitResetAtMs: epoch(row.limit_reset_at),
    })),
    openFailures,
  };
});

/**
 * Routes one fire: reads the destination's state and decides with
 * `routineRoute`. Fallback targets are limited to the providers the
 * routine's project can run on.
 */
export const routeRoutineFire = Effect.fn("ScheduledTaskService.routeRoutineFire")(
  function* (input: {
    readonly task: Pick<ScheduledTask, "id" | "runtimeMode" | "interactionMode">;
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly destination: {
      readonly threadId: string | null;
      readonly modelSelection: ModelSelection | undefined;
    };
    readonly rule: ProviderFallbackRule | null;
    readonly project: Parameters<typeof projectCompatibleProviders>[0]["project"];
    readonly nowMs: number;
  }) {
    const state = yield* readRouteState(input.task, input.destination.threadId, input.nowMs);
    return routineRoute({
      providers: input.providers,
      candidates: projectCompatibleProviders({
        project: input.project,
        providers: input.providers,
        cwd: input.project?.workspaceRoot ?? null,
        runtimePolicy: {
          runtimeMode: input.task.runtimeMode,
          interactionMode: input.task.interactionMode,
        },
      }),
      modelSelection: input.destination.modelSelection,
      thread: state.thread,
      threadId: input.destination.threadId,
      runs: state.runs,
      openFailures: state.openFailures,
      rule: input.rule,
      nowMs: input.nowMs,
    });
  },
);
