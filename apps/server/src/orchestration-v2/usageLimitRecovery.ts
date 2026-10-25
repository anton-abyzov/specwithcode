import type {
  OrchestrationV2AppThread,
  OrchestrationV2LimitRecovery,
  OrchestrationV2LimitRecoveryUpdate,
  OrchestrationV2ServerCommand,
  ServerProvider,
} from "@specweave-studio/contracts";
import {
  canTakeTurn,
  providerUsedPercent,
  usageResetAt,
} from "@specweave-studio/shared/providerFallback";
import * as DateTime from "effect/DateTime";
import { nativeQuotaDenied } from "../studio/capacitySnapshot.ts";
import { isBlockingRuntimeRequest } from "./blockingRuntimeRequest.ts";
import type { ProjectionLimitRecoveryCandidate } from "./ProjectionStore.ts";

export const LIMIT_CHECK_INTERVAL_MS = 5 * 60_000;
/**
 * How often a held thread's instance is read for a sign-in to another
 * subscription, per instance and only while a thread there waits on a limit.
 */
export const SUBSCRIPTION_CHECK_INTERVAL_MS = 2 * 60_000;
export const LIMIT_PROOF_MAX_AGE_MS = 60_000;

/**
 * Only a request that really holds the thread keeps it stopped. A question
 * the next message answers, or one an earlier run left behind, does not.
 */
export function isLimitRecoveryCandidate(thread: ProjectionLimitRecoveryCandidate): boolean {
  return (
    thread.status === "failed" &&
    thread.lastErrorClass === "usage_limit" &&
    thread.latestRunId !== null &&
    thread.archivedAt === null &&
    thread.settledOverride !== "settled" &&
    !isBlockingRuntimeRequest(thread, thread.latestRunId)
  );
}

/**
 * Automatic re-arms of one stop chain: a limit that comes back in the same
 * window is re-armed this many times, then left for the person.
 */
export const LIMIT_REARM_MAX = 3;
/** The longest wait before a derived resume, about one session window. */
export const LIMIT_REARM_MAX_DELAY_MS = 5 * 60 * 60_000;
/** A stop this soon after the chain's last resume continues the chain, whatever reset it reports. */
export const LIMIT_STOP_CHAIN_WINDOW_MS = 5 * 60 * 60_000;
/**
 * A reset at least this far past the chain's last resume is a new limit
 * window, so its stop starts a new chain. A reset nearer than that (a
 * retry-after, a time read from relative text), one at or before the stop,
 * or none at all only continues the chain, which keeps it bounded.
 */
export const LIMIT_NEW_WINDOW_MIN_MS = 60 * 60_000;

/** The wait after a stop before a derived resume: 5, 20, 80 minutes, then 5 hours. */
export function limitRearmDelayMs(attempt: number): number {
  return Math.min(LIMIT_CHECK_INTERVAL_MS * 4 ** Math.max(0, attempt), LIMIT_REARM_MAX_DELAY_MS);
}

const CHAIN_SUFFIX = /:chain:(\d+):(-?\d+)$/;

/** Policy arms that need a derived reset carry their place in the stop chain in their id. */
export function limitChainSuffix(attempt: number, stopMs: number): string {
  return `:chain:${attempt}:${stopMs}`;
}

/**
 * The chain an arm belongs to, read from its request id. A user arm or an
 * arm made before chains were recorded is attempt 0 with no stop time.
 */
export function limitRecoveryChain(requestId: string | undefined): {
  readonly attempt: number;
  readonly stopMs: number | null;
} {
  const match = requestId === undefined ? null : CHAIN_SUFFIX.exec(requestId);
  return match
    ? { attempt: Number(match[1]), stopMs: Number(match[2]) }
    : { attempt: 0, stopMs: null };
}

/** When the stop ended, the time every reset and wait is measured from. */
export function limitStopMs(
  thread: Pick<ProjectionLimitRecoveryCandidate, "latestRunCompletedAt" | "updatedAt">,
): number {
  return DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt);
}

/**
 * The earliest moment an armed stop could have resumed: its reported reset,
 * or for an arm that waited on a provider read, the end of its wait (and
 * never before a usable reset). Null for a user or older arm without a reset.
 */
export function limitChainResumeMs(recovery: OrchestrationV2LimitRecovery): number | null {
  const chain = limitRecoveryChain(recovery.requestId);
  const resetMs = Date.parse(recovery.resetAt ?? "");
  const reset =
    Number.isFinite(resetMs) && (chain.stopMs === null || resetMs > chain.stopMs) ? resetMs : null;
  if (chain.stopMs === null) return reset;
  return Math.max(chain.stopMs + limitRearmDelayMs(chain.attempt), reset ?? -Infinity);
}

/**
 * Where a stop about to be armed sits in its chain. A stop within the chain
 * window of the previous arm's resume is the next attempt, whatever reset it
 * reports, unless it reports a usable reset at least LIMIT_NEW_WINDOW_MIN_MS
 * past that resume: a new limit window, which starts a new chain. The same
 * run armed again keeps its place.
 */
export function nextLimitChainAttempt(thread: ProjectionLimitRecoveryCandidate): number {
  const previous = thread.limitRecovery;
  if (!previous) return 0;
  const chain = limitRecoveryChain(previous.requestId);
  if (previous.runId === thread.latestRunId) return chain.attempt;
  const resumeMs = limitChainResumeMs(previous);
  if (resumeMs === null) return 0;
  const resetMs = hasValidLimitReset(thread) ? Date.parse(thread.usageLimitResetAt!) : null;
  const newWindow =
    limitStopMs(thread) - resumeMs >= LIMIT_STOP_CHAIN_WINDOW_MS ||
    (resetMs !== null && resetMs - resumeMs >= LIMIT_NEW_WINDOW_MIN_MS);
  return newWindow ? 0 : chain.attempt + 1;
}

/** A reset the stop reported, later than the stop itself. */
export function hasValidLimitReset(
  thread: Pick<
    ProjectionLimitRecoveryCandidate,
    "usageLimitResetAt" | "latestRunCompletedAt" | "updatedAt"
  >,
): boolean {
  const resetMs = Date.parse(thread.usageLimitResetAt ?? "");
  return Number.isFinite(resetMs) && resetMs > limitStopMs(thread);
}

/**
 * When an armed stop may resume on a fresh provider read instead of its
 * reported reset, or null when the reported reset decides. That is a stop
 * with no usable reset, or any stop after an automatic resume in the same
 * window, whose old reset has already been tried.
 */
export function derivedLimitResumeAt(thread: ProjectionLimitRecoveryCandidate): number | null {
  const recovery = thread.limitRecovery;
  if (
    !isLimitRecoveryCandidate(thread) ||
    !recovery?.autoResume ||
    recovery.runId !== thread.latestRunId ||
    recovery.resetAt !== (thread.usageLimitResetAt ?? null)
  )
    return null;
  const { attempt } = limitRecoveryChain(recovery.requestId);
  if (hasValidLimitReset(thread) && attempt === 0) return null;
  const resetMs = Date.parse(thread.usageLimitResetAt ?? "");
  const due = limitStopMs(thread) + limitRearmDelayMs(attempt);
  return hasValidLimitReset(thread) ? Math.max(due, resetMs) : due;
}

/**
 * What a provider snapshot says about a stopped thread's room. `room` needs a
 * read taken after the stop that shows the instance can take a turn, with no
 * spent window and no native denial. `wait` is a reset the provider reports
 * still ahead, so nothing is read before it. `check` is anything else: a read
 * from before the stop, or one that shows no room yet, which a later read may
 * settle.
 */
export function limitReadShowsRoom(
  provider: ServerProvider | undefined,
  stopMs: number,
  nowMs: number,
): "room" | "check" | "wait" {
  if (!provider) return "check";
  const limits = provider.usageLimits;
  const denialResetMs = Date.parse(limits?.nativeDenialResetsAt ?? "");
  const windowResetMs = usageResetAt(provider, 100, nowMs);
  if (
    (Number.isFinite(denialResetMs) && denialResetMs > nowMs) ||
    (windowResetMs !== null && windowResetMs > nowMs)
  )
    return "wait";
  // Usage the provider reports is read on its own; a status read alone never
  // proves its quota came back.
  const readAt = Date.parse(limits && !limits.unavailable ? limits.checkedAt : provider.checkedAt);
  return Number.isFinite(readAt) &&
    readAt > stopMs &&
    readAt <= nowMs + 60_000 &&
    canTakeTurn(provider) &&
    !nativeQuotaDenied(limits, nowMs) &&
    (providerUsedPercent(provider, nowMs) ?? 0) < 100
    ? "room"
    : "check";
}

/**
 * Whether the instance is now signed in to another account that has room for
 * a stopped thread. The stop's reset belongs to the account it hit, so after
 * the server sees the account change (`accountChangedAt`, later than the stop)
 * a complete read of the new account, taken at or after the change and within
 * LIMIT_CHECK_INTERVAL_MS, must show room. The same account, a read of the old
 * one, a partial read or a new account that is limited too never qualifies.
 */
export function accountChangeShowsRoom(
  provider: ServerProvider | undefined,
  stopMs: number,
  nowMs: number,
): boolean {
  const limits = provider?.usageLimits;
  const changedMs = Date.parse(limits?.accountChangedAt ?? "");
  const fullReadMs = Date.parse(limits?.nativeAllowanceObservedAt ?? "");
  const readMs = Date.parse(limits?.checkedAt ?? "");
  return (
    limits !== undefined &&
    limits.unavailable === undefined &&
    Number.isFinite(changedMs) &&
    changedMs > stopMs &&
    Number.isFinite(fullReadMs) &&
    fullReadMs >= changedMs &&
    Number.isFinite(readMs) &&
    nowMs - readMs <= LIMIT_CHECK_INTERVAL_MS &&
    limitReadShowsRoom(provider, stopMs, nowMs) === "room"
  );
}

const ACCOUNT_CHANGE_MARK = ":acct:";
const LIMIT_RESUME_PREFIX = "limit-resume:";

/** The id mark of a resume sent because the account changed, before the arm's request id. */
export function accountChangeMark(changedMs: number): string {
  return `:acct:${changedMs}`;
}

/** When the account changed, read from a resume's id, or null for any other resume. */
export function accountChangeOf(commandId: string): number | null {
  const at = commandId.indexOf(ACCOUNT_CHANGE_MARK);
  if (at < 0) return null;
  // A refused id can come back as the next arm's request id, at the end of a
  // later resume's id. A mark inside it follows a second `limit-resume:` and is
  // no fresh proof of a change.
  if (commandId.slice(0, at).lastIndexOf(LIMIT_RESUME_PREFIX) !== 0) return null;
  const match = /^(\d+):/.exec(commandId.slice(at + ACCOUNT_CHANGE_MARK.length));
  return match ? Number(match[1]) : null;
}

/** A recovery snooze may end early; a user-chosen unrelated snooze remains authoritative. */
export function recoverySnoozeBlocks(
  thread: Pick<ProjectionLimitRecoveryCandidate, "snoozedUntil" | "limitRecovery">,
  now: number,
  early: boolean,
): boolean {
  if (thread.snoozedUntil == null || DateTime.toEpochMillis(thread.snoozedUntil) <= now)
    return false;
  return !(
    early &&
    thread.limitRecovery?.snooze === true &&
    DateTime.toEpochMillis(thread.snoozedUntil) === Date.parse(thread.limitRecovery.resetAt ?? "")
  );
}

export function hasFreshLimitPermission(
  thread: Pick<
    ProjectionLimitRecoveryCandidate,
    "limitRecovery" | "providerInstanceId" | "updatedAt" | "latestRunCompletedAt"
  >,
  now: number,
): boolean {
  const observed = thread.limitRecovery?.availability;
  const armed = thread.limitRecovery?.armedAffinity;
  if (
    !thread.limitRecovery?.explicitArm ||
    !armed ||
    observed?.affinity?.quotaPoolId !== armed.quotaPoolId ||
    observed.affinity.continuationKey !== armed.continuationKey ||
    observed.affinity.instanceId !== armed.instanceId
  )
    return false;
  if (
    !observed ||
    observed.status !== "allowed" ||
    observed.affinity?.instanceId !== thread.providerInstanceId ||
    observed.threadUpdatedAt !== DateTime.formatIso(thread.updatedAt)
  )
    return false;
  const at = Date.parse(observed.checkedAt);
  return (
    Number.isFinite(at) &&
    at <= now &&
    now - at <= LIMIT_PROOF_MAX_AGE_MS &&
    thread.latestRunCompletedAt != null &&
    at > DateTime.toEpochMillis(thread.latestRunCompletedAt)
  );
}

export function updateLimitRecovery(
  previous: OrchestrationV2LimitRecovery | null | undefined,
  update: OrchestrationV2LimitRecoveryUpdate | null | undefined,
  commandId: OrchestrationV2ServerCommand["commandId"],
  policyArm = false,
  affinity?: NonNullable<OrchestrationV2LimitRecovery["armedAffinity"]>,
): OrchestrationV2LimitRecovery | null | undefined {
  if (update === undefined) return previous;
  if (update === null) return null;
  const same =
    previous?.runId === update.runId && previous.resetAt === update.resetAt ? previous : null;
  return {
    ...update,
    autoResume: update.autoResume ?? same?.autoResume ?? false,
    snooze: update.snooze ?? same?.snooze ?? false,
    checkNow: update.checkNow === true,
    ...(same?.availability && update.autoResume !== true
      ? { availability: { ...same.availability, status: "unknown" as const } }
      : {}),
    ...(update.autoResume === true
      ? affinity
        ? { armedAffinity: affinity }
        : {}
      : same?.armedAffinity
        ? { armedAffinity: same.armedAffinity }
        : {}),
    explicitArm: update.autoResume === true ? !policyArm : (same?.explicitArm ?? false),
    requestId: commandId,
  };
}

/** Compare-and-set makes a delayed account check harmless after any user/thread change. */
export function applyLimitObservation<
  T extends Pick<
    OrchestrationV2AppThread,
    | "limitRecovery"
    | "updatedAt"
    | "providerInstanceId"
    | "archivedAt"
    | "deletedAt"
    | "settledOverride"
  >,
>(
  thread: T,
  command: Extract<OrchestrationV2ServerCommand, { type: "thread.metadata.update" }>,
  now: DateTime.Utc,
): T | null {
  const check = command.limitAvailability;
  const recovery = thread.limitRecovery;
  if (
    !check ||
    !recovery ||
    recovery.runId !== check.runId ||
    recovery.requestId !== check.requestId ||
    DateTime.formatIso(thread.updatedAt) !== check.expectedUpdatedAt ||
    (thread.providerInstanceId !== check.observation.affinity?.instanceId &&
      check.observation.status === "allowed") ||
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    thread.settledOverride === "settled"
  )
    return null;
  return {
    ...thread,
    limitRecovery: {
      ...recovery,
      checkNow: false,
      availability: { ...check.observation, threadUpdatedAt: DateTime.formatIso(now) },
    },
  };
}
