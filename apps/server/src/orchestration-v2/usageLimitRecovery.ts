import type {
  OrchestrationV2AppThread,
  OrchestrationV2LimitRecovery,
  OrchestrationV2LimitRecoveryUpdate,
  OrchestrationV2ServerCommand,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import type { ProjectionLimitRecoveryCandidate } from "./ProjectionStore.ts";

export const LIMIT_CHECK_INTERVAL_MS = 5 * 60_000;
export const LIMIT_PROOF_MAX_AGE_MS = 60_000;

export function isLimitRecoveryCandidate(thread: ProjectionLimitRecoveryCandidate): boolean {
  return (
    thread.status === "failed" &&
    thread.lastErrorClass === "usage_limit" &&
    thread.latestRunId !== null &&
    thread.archivedAt === null &&
    thread.settledOverride !== "settled" &&
    thread.pendingRuntimeRequest === null
  );
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
