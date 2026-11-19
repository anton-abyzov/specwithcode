/**
 * The handoff wire and takeover rules of the latest release, v1.0.381, copied
 * verbatim with `git show v1.0.381:<path>` so the compatibility tests run
 * today's code against what a machine that has not updated yet still does.
 * Only the names changed (the `previous` prefix). Never edit a body here:
 * replace it from the tag of the release a later test pins.
 *
 * Sources at v1.0.381:
 * - apps/server/src/handoff/handoffWire.ts:159-250,353-372 (the preflight,
 *   takeover and heartbeat bodies, the error body, the paths the route knows)
 * - apps/server/src/handoff/handoffState.ts:603-612,638-802 (`takeoverVerdict`,
 *   `markContinued`, `heartbeatContinued`)
 * - apps/server/src/handoff/HandoffMoves.ts:674-676,863-883 (what the sender
 *   does with a takeover's failure)
 * - apps/server/src/handoff/handoffRoute.ts:76-84,100,161 (a body is decoded
 *   with no parse options; an unknown path answers 404 `not_found`)
 * - apps/server/src/handoff/handoffPeers.ts:477-517 (how an answer is read)
 */
import {
  EnvironmentId,
  type HandoffIncomingReplica,
  HandoffModeErrorCode,
  HandoffPreflightCheck,
  HandoffPreflightFailure,
  ModelSelection,
  NonNegativeInt,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  type HandoffDocument,
  type HandoffIncomingDetail,
  findIncoming,
  incomingKey,
} from "./handoffState.ts";

export const PREVIOUS_RELEASE = "v1.0.381";
export const PREVIOUS_PROTOCOL_VERSION = 2;

const text = (max: number) => Schema.String.check(Schema.isMaxLength(max));

export const PreviousPeerPreflightRequest = Schema.Struct({
  sourceEnvironmentId: EnvironmentId,
  protocolVersion: Schema.optional(NonNegativeInt),
  appVersion: Schema.optional(text(40)),
  threads: Schema.Array(
    Schema.Struct({
      sourceThreadId: ThreadId,
      /** Checked against this machine's explicit project links even before a replica exists. */
      sourceProjectId: ProjectId,
      /** The checkpoint the source will hand over; the destination must hold it. */
      sequence: NonNegativeInt,
      modelSelection: Schema.NullOr(ModelSelection),
    }),
  ).check(Schema.isMaxLength(100)),
});
export type PreviousPeerPreflightRequest = typeof PreviousPeerPreflightRequest.Type;
export const PreviousPeerPreflightResponse = Schema.Struct({
  machineLabel: text(120),
  protocolVersion: Schema.optional(NonNegativeInt),
  appVersion: Schema.optional(text(40)),
  results: Schema.Array(
    Schema.Struct({
      sourceThreadId: ThreadId,
      failures: Schema.Array(HandoffPreflightFailure),
    }),
  ),
});
export type PreviousPeerPreflightResponse = typeof PreviousPeerPreflightResponse.Type;

export const PreviousTakeoverReason = Schema.Literals([
  "handoff",
  "machine-handoff",
  "sleep",
  "continue-here",
  "auto-takeover",
]);
export type PreviousTakeoverReason = typeof PreviousTakeoverReason.Type;

export const PreviousTakeoverRequest = Schema.Struct({
  sourceEnvironmentId: EnvironmentId,
  sourceThreadId: ThreadId,
  /** The epoch the destination takes the lease at; one more than the source held. */
  epoch: NonNegativeInt,
  sequence: NonNegativeInt,
  reason: PreviousTakeoverReason,
  modelSelection: Schema.NullOr(ModelSelection),
});
export type PreviousTakeoverRequest = typeof PreviousTakeoverRequest.Type;
export const PreviousTakeoverResponse = Schema.Struct({
  threadId: ThreadId,
  /** The destination project the continuation lives in. */
  projectId: Schema.optional(ProjectId),
  machineLabel: text(120),
  modelSelection: Schema.NullOr(ModelSelection),
  resumed: Schema.Boolean,
  notice: Schema.NullOr(text(500)),
});
export type PreviousTakeoverResponse = typeof PreviousTakeoverResponse.Type;

export const PreviousHeartbeatRequest = Schema.Struct({
  sourceEnvironmentId: EnvironmentId,
  sourceLabel: text(120),
  leases: Schema.Array(
    Schema.Struct({
      sourceThreadId: ThreadId,
      epoch: NonNegativeInt,
      /**
       * Sent only to the one machine allowed to continue this thread on its own
       * (the sleep target, else the project's standby): the delay it waits. Older
       * receivers ignore it.
       */
      autoContinueMinutes: Schema.optional(NonNegativeInt),
    }),
  ).check(Schema.isMaxLength(500)),
});
export type PreviousHeartbeatRequest = typeof PreviousHeartbeatRequest.Type;
/** Threads the destination continued at a newer epoch: the source must fence them. */
export const PreviousHeartbeatResponse = Schema.Struct({
  machineLabel: text(120),
  continued: Schema.Array(
    Schema.Struct({ sourceThreadId: ThreadId, epoch: NonNegativeInt, threadId: ThreadId }),
  ),
});
export type PreviousHeartbeatResponse = typeof PreviousHeartbeatResponse.Type;

export const PreviousPeerErrorBody = Schema.Struct({
  error: text(1000),
  code: Schema.optional(HandoffModeErrorCode),
  /** The preflight check a refusal maps to, so the source reports it per thread. */
  check: Schema.optional(HandoffPreflightCheck),
});
export type PreviousPeerErrorBody = typeof PreviousPeerErrorBody.Type;

export const PREVIOUS_PEER_PATHS: ReadonlySet<string> = new Set<string>([
  "negotiate",
  "replicate",
  "preflight",
  "takeover",
  "heartbeat",
  "coordinator-lease",
  "coordinator-replica",
  "memory-export",
  "memory-merge",
  "linked-digest",
  "linked-content",
  "linked-replica",
  "linked-supersede",
  "linked-members",
  "plan-export",
  "plan-merge",
  "extras-negotiate",
  "extras-replicate",
]);

export type PreviousTakeoverVerdict =
  | {
      readonly kind: "proceed";
      readonly replica: HandoffIncomingReplica;
      readonly detail: HandoffIncomingDetail;
    }
  | { readonly kind: "repeat"; readonly response: PreviousTakeoverResponse }
  | {
      readonly kind: "refuse";
      readonly code: HandoffModeErrorCode;
      readonly message: string;
      readonly check?: HandoffPreflightCheck;
    };

/**
 * May this machine continue the thread at `request.epoch`? A repeat of the
 * takeover it already did answers the same thread (idempotent); a lower or
 * equal epoch than the newest it saw is stale and refused.
 */
export function previousTakeoverVerdict(
  document: HandoffDocument,
  request: PreviousTakeoverRequest,
  machineLabel: string,
): PreviousTakeoverVerdict {
  const at = (message: string) => `${machineLabel}: ${message}`;
  const replica = findIncoming(document, request.sourceEnvironmentId, request.sourceThreadId);
  const detail = (document.incomingDetails ?? {})[
    incomingKey(request.sourceEnvironmentId, request.sourceThreadId)
  ];
  if (replica === undefined || detail === undefined) {
    return {
      kind: "refuse",
      code: "not_found",
      message: at("no checkpoint for this thread"),
      check: "checkpoint",
    };
  }
  if (replica.continuedThreadId !== null) {
    if (detail.takeoverEpoch === request.epoch && detail.takeover !== null) {
      return { kind: "repeat", response: detail.takeover };
    }
    return {
      kind: "refuse",
      code: "fenced",
      message: at(`already continued this thread at epoch ${detail.takeoverEpoch ?? 0}`),
      check: "lease",
    };
  }
  if (replica.checkpoint.sequence < request.sequence) {
    return {
      kind: "refuse",
      code: "invalid",
      message: at(
        `checkpoint ${request.sequence} not received yet (has ${replica.checkpoint.sequence})`,
      ),
      check: "checkpoint",
    };
  }
  if (request.epoch <= replica.lease.epoch) {
    return {
      kind: "refuse",
      code: "fenced",
      message: at(
        `stale lease epoch ${request.epoch}; this machine saw epoch ${replica.lease.epoch}`,
      ),
      check: "lease",
    };
  }
  return { kind: "proceed", replica, detail };
}

/** Marks the replica continued here; a heartbeat from the source then fences it. */
export function previousMarkContinued(
  document: HandoffDocument,
  request: PreviousTakeoverRequest,
  response: PreviousTakeoverResponse,
  now: string,
): HandoffDocument {
  const key = incomingKey(request.sourceEnvironmentId, request.sourceThreadId);
  const replica = findIncoming(document, request.sourceEnvironmentId, request.sourceThreadId);
  const detail = (document.incomingDetails ?? {})[key];
  if (replica === undefined || detail === undefined) return document;
  const next = previousReplaceIncoming(document, {
    ...replica,
    continuedThreadId: response.threadId,
    lease: {
      ...replica.lease,
      epoch: request.epoch,
      renewedAt: now,
      state: "fenced",
    },
  });
  return {
    ...next,
    incomingDetails: {
      ...next.incomingDetails,
      [key]: { ...detail, takeoverEpoch: request.epoch, takeover: response },
    },
  };
}

function previousReplaceIncoming(
  document: HandoffDocument,
  replica: HandoffIncomingReplica,
): HandoffDocument {
  const others = document.incoming.filter(
    (entry) =>
      entry.sourceEnvironmentId !== replica.sourceEnvironmentId ||
      entry.sourceThreadId !== replica.sourceThreadId,
  );
  return { ...document, incoming: [...others, replica] };
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
/**
 * What the previous release's sender does when its takeover fails
 * (`handOffLocked`): an answer that never came keeps the hold and the request
 * for a re-send; anything else releases the hold and the thread runs on the
 * source again.
 */
export function previousTakeoverFailure(error: {
  readonly uncertain: boolean;
}): "kept-in-doubt" | "released" {
  return error.uncertain ? "kept-in-doubt" : "released";
}

export type PreviousAnswer<A> =
  | { readonly kind: "ok"; readonly value: A }
  | {
      readonly kind: "refused";
      readonly code: HandoffModeErrorCode;
      readonly message: string;
      readonly check: HandoffPreflightCheck | undefined;
      readonly uncertain: false;
    }
  | { readonly kind: "unreachable"; readonly uncertain: true };

/**
 * How the previous release reads a peer's HTTP answer (`handoffPeers.ts`): a
 * non-OK status with our error body is a refusal, a 5xx without it or a 200 it
 * cannot decode is in doubt, any other non-OK status is a plain failure.
 */
export function previousReadAnswer<A>(
  status: number,
  json: unknown,
  decode: (raw: unknown) => Option.Option<A>,
): PreviousAnswer<A> {
  if (status < 200 || status >= 300) {
    const refusal = Schema.decodeUnknownOption(PreviousPeerErrorBody)(json);
    if (Option.isSome(refusal)) {
      return {
        kind: "refused",
        code: refusal.value.code ?? "failed",
        message: refusal.value.error,
        check: refusal.value.check,
        uncertain: false,
      };
    }
    return status >= 500
      ? { kind: "unreachable", uncertain: true }
      : {
          kind: "refused",
          code: "failed",
          message: `refused the request (HTTP ${status}).`,
          check: undefined,
          uncertain: false,
        };
  }
  const decoded = decode(json);
  return Option.isSome(decoded)
    ? { kind: "ok", value: decoded.value }
    : { kind: "unreachable", uncertain: true };
}

/** A body as it arrives: what JSON carries, and nothing else. */
export const overTheWire = (value: unknown): unknown => structuredClone(value);

export const encodePreviousPreflightRequest = Schema.encodeSync(PreviousPeerPreflightRequest);
export const encodePreviousPreflightResponse = Schema.encodeSync(PreviousPeerPreflightResponse);
export const encodePreviousTakeoverRequest = Schema.encodeSync(PreviousTakeoverRequest);
export const encodePreviousTakeoverResponse = Schema.encodeSync(PreviousTakeoverResponse);
export const encodePreviousHeartbeatResponse = Schema.encodeSync(PreviousHeartbeatResponse);

/** The previous release's route for a path it does not know. */
export const PREVIOUS_UNKNOWN_PATH = {
  status: 404,
  body: { error: "not_found", code: "not_found" },
} as const;
