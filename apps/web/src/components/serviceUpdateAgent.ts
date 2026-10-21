import type {
  StudioServiceUpdateState,
  StudioServiceUpdateStatus,
} from "@specweave-studio/contracts";

import {
  advanceServiceUpdateProgress,
  isRestartRefusalWithRelease,
  pendingHoldUntil,
  type ServiceUpdateProgress,
  startServiceUpdateProgress,
} from "./sidebar/SidebarRestartToUpdate.logic";

/**
 * What the update agent's state says, read the same way by every part of the
 * service's "Update now": no window state here.
 */

// The agent may still act on an install request in these states.
export const AGENT_WORKING: ReadonlySet<StudioServiceUpdateStatus> = new Set([
  "downloading",
  "downloaded",
  "waiting-for-quiet",
  "installing",
]);

// The agent will not install anything in these states: a hold left on the
// service has nothing to wait for.
export const AGENT_SETTLED: ReadonlySet<StudioServiceUpdateStatus> = new Set([
  "not-managed",
  "disabled",
  "up-to-date",
  "installed",
  "manual-required",
  "error",
]);

/**
 * The desktop reports an install request the agent has not finished. The
 * desktop this renderer ships with always reports one, or null for none: a
 * state without it has none pending.
 */
export function hasPendingRequest(state: StudioServiceUpdateState): boolean {
  return state.pendingInstall !== undefined && state.pendingInstall !== null;
}

/** The desktop reports a forced request pending whose hold has not run out. */
export function isPendingRequestLive(state: StudioServiceUpdateState | null): boolean {
  return (pendingHoldUntil(state) ?? Number.NEGATIVE_INFINITY) > Date.now();
}

/** When the agent wrote `agent` (ms); null when the state does not say. */
export function writtenAt(agent: StudioServiceUpdateState): number | null {
  const at = typeof agent.updatedAt === "string" ? Date.parse(agent.updatedAt) : Number.NaN;
  return Number.isFinite(at) ? at : null;
}

/**
 * The state among `candidates` the agent wrote last. The desktop publishes
 * only on a change, so a read can be newer than what it published, and the
 * other way round. Null when none says when it was written.
 */
export function newestWritten(
  candidates: ReadonlyArray<StudioServiceUpdateState | null>,
): StudioServiceUpdateState | null {
  let newest: StudioServiceUpdateState | null = null;
  let newestAt = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    const at = candidate === null ? null : writtenAt(candidate);
    if (at !== null && at > newestAt) {
      newest = candidate;
      newestAt = at;
    }
  }
  return newest;
}

/**
 * The agent has written nothing for `ms` (or cannot say when it wrote): a
 * pass that answered and went back to sleep (older agents), not one still
 * retrying for a request.
 */
export function agentSilentFor(
  agent: StudioServiceUpdateState | null,
  now: number,
  ms: number,
): boolean {
  const written = agent === null ? null : writtenAt(agent);
  return written === null || now - written >= ms;
}

// The agent has not finished with the version it runs in these states.
export const AGENT_UNSETTLED_ON_VERSION: ReadonlySet<StudioServiceUpdateStatus> = new Set([
  "installing",
  "error",
  "manual-required",
]);

export function isWaitingPhase(progress: ServiceUpdateProgress | null): boolean {
  return progress?.phase === "requesting" || progress?.phase === "waiting";
}

/**
 * The desktop reports a request pending that is not the one `progress` asked
 * for or follows: written later, with a hold of its own (another window
 * pressed since, or the window that pressed renewed it). The same request
 * asked again is written later too, but keeps its hold.
 */
export function newerRequestPending(
  agent: StudioServiceUpdateState,
  progress: ServiceUpdateProgress,
): boolean {
  const pending = agent.pendingInstall;
  if (pending === undefined || pending === null) return false;
  const requestedAt = Date.parse(pending.requestedAt);
  if (!Number.isFinite(requestedAt)) return false;
  if (requestedAt <= (progress.requestedAt ?? Number.NEGATIVE_INFINITY)) return false;
  return pendingHoldUntil(agent) !== progress.holdUntil;
}

/**
 * In a state the agent wrote after `progress`'s request, the desktop no
 * longer reports a request pending, while it still waits and before its hold
 * ran out: it lapsed then, and the toast says so.
 */
export function withdrawnAfterRequest(
  agent: StudioServiceUpdateState,
  progress: ServiceUpdateProgress | null,
  now: number,
): boolean {
  if (!isWaitingPhase(progress)) return false;
  // Written before the request, or unknown when: not the agent's answer to it.
  const written = writtenAt(agent) ?? Number.NEGATIVE_INFINITY;
  if (written < (progress?.requestedAt ?? Number.POSITIVE_INFINITY)) return false;
  if (now >= (progress?.holdUntil ?? Number.POSITIVE_INFINITY)) return false;
  return !hasPendingRequest(agent);
}

/**
 * The agent refused `progress`'s request for a fault only a held request gets
 * past, and the desktop no longer reports it (see withdrawnAfterRequest):
 * another window withdrew it before that pass ended. Such a pass never takes
 * the request up, so it writes neither "Update cancelled" nor an install
 * result; the same refusal after an install it tried for the request (which
 * takes the request up, and the desktop stops reporting it too) is the
 * agent's answer.
 */
export function refusedAfterWithdrawal(
  agent: StudioServiceUpdateState,
  progress: ServiceUpdateProgress | null,
  now: number,
): boolean {
  if (!isRestartRefusalWithRelease(agent) || !withdrawnAfterRequest(agent, progress, now)) {
    return false;
  }
  const tried = Date.parse(agent.lastInstall?.at ?? "");
  return !(tried >= (progress?.requestedAt ?? Number.POSITIVE_INFINITY));
}

/**
 * Where a forced request the desktop reports pending stands, for a window that
 * follows it: null when none is pending whose hold lasts, or it is for another
 * version than `targetVersion`.
 */
export function pendingRequestProgress(
  serviceState: StudioServiceUpdateState | null,
  targetVersion: string | null,
  blockers: ServiceUpdateProgress["blockers"],
  now: number,
): ServiceUpdateProgress | null {
  const pending = serviceState?.pendingInstall ?? null;
  const holdUntil = pendingHoldUntil(serviceState);
  if (serviceState === null || pending === null || holdUntil === undefined || holdUntil <= now) {
    return null;
  }
  if (targetVersion !== null && pending.version !== null && pending.version !== targetVersion) {
    return null;
  }
  const requestedAt = Date.parse(pending.requestedAt);
  const base: ServiceUpdateProgress = {
    ...startServiceUpdateProgress(serviceState, pending.version ?? targetVersion),
    phase: "requesting",
    blockers,
    holdUntil,
    ...(Number.isFinite(requestedAt) ? { requestedAt, startedAt: requestedAt } : {}),
  };
  return advanceServiceUpdateProgress(base, serviceState, now);
}
