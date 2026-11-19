/**
 * Rules of the previous release, v1.0.378, copied verbatim with
 * `git show v1.0.378:<path>` so the compatibility tests run today's code
 * against what a machine that has not updated yet still does. Only the
 * function names changed (the `previous` prefix). Never edit a body here:
 * replace it from the tag of the release a later test pins.
 *
 * Sources at v1.0.378:
 * - apps/server/src/handoff/handoffState.ts:748-802 (`heartbeatContinued`)
 * - apps/server/src/handoff/HandoffAutoContinue.ts:66-71,243-307
 *   (`autoContinueMinutes`, `autoContinueCandidates`)
 * - apps/server/src/away/awayPeerCall.ts:128-145 (how a peer's answer is read)
 */
import {
  type HandoffConfig,
  type ThreadId,
  isResumableHandoffEnding,
} from "@specweave-studio/contracts";

import { type HandoffDocument, findIncoming, incomingKey } from "./handoffState.ts";

export const PREVIOUS_RELEASE = "v1.0.378";

const AUTO_CONTINUE_MIN_MINUTES = 5;

/** The delay in minutes, at least five; null when the setting is off. */
export function previousAutoContinueMinutes(config: Pick<HandoffConfig, "autoTakeoverMinutes">) {
  const minutes = config.autoTakeoverMinutes;
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return Math.max(AUTO_CONTINUE_MIN_MINUTES, Math.floor(minutes));
}

/**
 * A heartbeat from a source: every thread it still holds that this machine
 * continued comes back, whatever epoch the source names, so the source fences
 * that copy (a continued source thread never runs again; a handback is a new
 * thread). For a replica not continued, the epoch the source holds raises the
 * replica's lease, so a delayed takeover at a lower epoch is refused. Also
 * records that the source answered.
 */
export function previousHeartbeatContinued(
  document: HandoffDocument,
  request: {
    readonly sourceEnvironmentId: string;
    readonly leases: ReadonlyArray<{
      readonly sourceThreadId: ThreadId;
      readonly epoch: number;
      readonly autoContinueMinutes?: number | undefined;
    }>;
  },
  now: string,
): readonly [
  Array<{ readonly sourceThreadId: ThreadId; readonly epoch: number; readonly threadId: ThreadId }>,
  HandoffDocument,
] {
  const continued: Array<{ sourceThreadId: ThreadId; epoch: number; threadId: ThreadId }> = [];
  const held = new Map(request.leases.map((lease) => [lease.sourceThreadId, lease.epoch]));
  for (const sourceThreadId of held.keys()) {
    const replica = findIncoming(document, request.sourceEnvironmentId, sourceThreadId);
    const detail = (document.incomingDetails ?? {})[
      incomingKey(request.sourceEnvironmentId, sourceThreadId)
    ];
    if (replica?.continuedThreadId == null) continue;
    continued.push({
      sourceThreadId,
      epoch: detail?.takeoverEpoch ?? replica.lease.epoch,
      threadId: replica.continuedThreadId,
    });
  }
  const incoming = document.incoming.map((replica) => {
    if (replica.sourceEnvironmentId !== request.sourceEnvironmentId) return replica;
    const epoch = held.get(replica.sourceThreadId);
    const lease =
      replica.continuedThreadId === null && epoch !== undefined && epoch >= replica.lease.epoch
        ? { ...replica.lease, epoch, renewedAt: now, state: "active" as const }
        : replica.lease;
    return { ...replica, lease, sourceLastSeenAt: now, sourceUnreachable: false };
  });
  // Each heartbeat restates which copies this machine may continue on its own;
  // a copy it leaves out, or names without a delay, loses that designation.
  const designated = new Map(
    request.leases.map((lease) => [lease.sourceThreadId as string, lease.autoContinueMinutes]),
  );
  let incomingDetails = document.incomingDetails ?? {};
  for (const replica of incoming) {
    if (replica.sourceEnvironmentId !== request.sourceEnvironmentId) continue;
    const key = incomingKey(replica.sourceEnvironmentId, replica.sourceThreadId);
    const detail = incomingDetails[key];
    if (detail === undefined) continue;
    const minutes = designated.get(replica.sourceThreadId) ?? null;
    if ((detail.autoContinueMinutes ?? null) === minutes) continue;
    incomingDetails = { ...incomingDetails, [key]: { ...detail, autoContinueMinutes: minutes } };
  }
  return [continued, { ...document, incoming, incomingDetails }];
}

export interface AutoContinueCandidate {
  readonly sourceEnvironmentId: EnvironmentId;
  readonly sourceThreadId: ThreadId;
}

/**
 * Copies this machine continues now: the source named it with a delay in its
 * latest heartbeat, the copy was still running, the source was heard during
 * the current watch, and the full delay passed since.
 */
export function previousAutoContinueCandidates(
  document: Pick<HandoffDocument, "incoming" | "incomingDetails">,
  input: {
    readonly nowMs: number;
    readonly watchingSinceMs: number;
    /** The local project linked to the source's, for its members' coordinator threads. */
    readonly projectOf: (projectId: string) => {
      readonly workspaceSettings?:
        | {
            readonly logicalProject?:
              | {
                  readonly members: ReadonlyArray<{
                    readonly environmentId: string;
                    readonly coordinatorThreadId?: string;
                  }>;
                }
              | null
              | undefined;
          }
        | null
        | undefined;
    } | null;
  },
): Array<AutoContinueCandidate> {
  const out: Array<AutoContinueCandidate> = [];
  for (const replica of document.incoming) {
    if (replica.continuedThreadId !== null || replica.projectId === null) continue;
    const detail = (document.incomingDetails ?? {})[
      incomingKey(replica.sourceEnvironmentId, replica.sourceThreadId)
    ];
    const announced = detail?.autoContinueMinutes ?? null;
    if (detail === undefined || announced === null || announced <= 0) continue;
    if (replica.sourceThreadId === `project-coordinator:${detail.sourceProjectId}`) continue;
    const members =
      input.projectOf(replica.projectId)?.workspaceSettings?.logicalProject?.members ?? [];
    if (
      members.some(
        (member) =>
          member.environmentId === replica.sourceEnvironmentId &&
          member.coordinatorThreadId === replica.sourceThreadId,
      )
    )
      continue;
    if (!isResumableHandoffEnding(replica.checkpoint.runEnding)) continue;
    const seen = Date.parse(replica.sourceLastSeenAt ?? "");
    if (!Number.isFinite(seen) || seen < input.watchingSinceMs) continue;
    const minutes = Math.max(AUTO_CONTINUE_MIN_MINUTES, announced);
    if (input.nowMs - seen < minutes * 60_000) continue;
    out.push({
      sourceEnvironmentId: replica.sourceEnvironmentId,
      sourceThreadId: replica.sourceThreadId,
    });
  }
  return out;
}

/**
 * How the previous release reads a peer's answer to an Away call
 * (`makeAwayPeerPost`): a 2xx is an answer, a 5xx without our `{ error }`
 * body may have come after the peer acted, and anything else is a refusal
 * that changed nothing there.
 */
export function previousAwayAnswerKind(
  status: number,
  json: unknown,
): "answered" | "refused" | "uncertain" {
  if (status >= 200 && status < 300) return "answered";
  const said =
    typeof json === "object" &&
    json !== null &&
    "error" in json &&
    typeof (json as { error: unknown }).error === "string"
      ? (json as { error: string }).error
      : undefined;
  return said === undefined && status >= 500 ? "uncertain" : "refused";
}
