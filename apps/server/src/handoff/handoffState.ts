/**
 * The handoff mode document and the pure rules over it: effective mode, the
 * lease and its epoch, the side-effect journal, the badge, and what a
 * destination accepts (replicas, takeovers, heartbeats). No I/O here, so
 * every rule is tested without a server.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  DEFAULT_HANDOFF_CONFIG,
  HANDOFF_LEASE_STALE_MS,
  type EnvironmentId,
  type HandoffBadge,
  HandoffCheckpoint,
  HandoffConfig,
  type HandoffConfigPatch,
  HandoffContinuation,
  HandoffIncomingReplica,
  HandoffLease,
  HandoffMachineRun,
  type HandoffModeErrorCode,
  HandoffModeSetting,
  type HandoffPreflightCheck,
  HandoffReplicaStatus,
  HandoffThreadModeSetting,
  ModelSelection,
  NonNegativeInt,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadExecutionRecord,
  type ThreadId,
  ThreadSideEffect,
  type ThreadSideEffectKind,
} from "@specweave-studio/contracts";

import {
  PeerTranscriptMessage,
  type ReplicateMeta,
  type TakeoverRequest,
  TakeoverResponse,
} from "./handoffWire.ts";

export const HANDOFF_SIDE_EFFECT_JOURNAL_MAX = 200;

export const HandoffThreadRecord = Schema.Struct({
  projectId: ProjectId,
  mode: HandoffThreadModeSetting,
  checkpoint: Schema.NullOr(HandoffCheckpoint),
  replicas: Schema.Array(HandoffReplicaStatus),
  lease: Schema.NullOr(HandoffLease),
  continuedOn: Schema.NullOr(HandoffContinuation),
  fencedBranch: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
  /** Set when handoff mode itself interrupted the latest run. */
  fencedBy: Schema.NullOr(Schema.Literals(["handoff", "sleep"])),
  sideEffects: Schema.Array(ThreadSideEffect),
  /** A continuation resumes the source's turn under its key. */
  resumeTurnKey: Schema.NullOr(Schema.String),
  /** The lease epoch each recent run started under, newest last. */
  runEpochs: Schema.Record(Schema.String, NonNegativeInt),
});
export type HandoffThreadRecord = typeof HandoffThreadRecord.Type;

/** What a destination keeps beside an incoming replica to continue it. */
export const HandoffIncomingDetail = Schema.Struct({
  sourceProjectId: ProjectId,
  repositoryPath: Schema.String,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  transcript: Schema.Array(PeerTranscriptMessage),
  execution: Schema.NullOr(ThreadExecutionRecord),
  /** The epoch this machine continued the thread at, and what it answered. */
  takeoverEpoch: Schema.NullOr(NonNegativeInt),
  takeover: Schema.NullOr(TakeoverResponse),
});
export type HandoffIncomingDetail = typeof HandoffIncomingDetail.Type;

export const HandoffDocument = Schema.Struct({
  version: Schema.Literal(1),
  config: HandoffConfig,
  projectModes: Schema.Record(Schema.String, HandoffModeSetting),
  threads: Schema.Record(Schema.String, HandoffThreadRecord),
  incoming: Schema.Array(HandoffIncomingReplica),
  /** Keyed by `incomingKey`; added after the first release, so older files decode to `{}`. */
  incomingDetails: Schema.optionalKey(Schema.Record(Schema.String, HandoffIncomingDetail)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({})),
  ),
  pausedSince: Schema.NullOr(Schema.String),
  machineRun: Schema.NullOr(HandoffMachineRun),
});
export type HandoffDocument = typeof HandoffDocument.Type;

export const EMPTY_HANDOFF_DOCUMENT: HandoffDocument = {
  version: 1,
  config: DEFAULT_HANDOFF_CONFIG,
  projectModes: {},
  threads: {},
  incoming: [],
  incomingDetails: {},
  pausedSince: null,
  machineRun: null,
};

export function emptyThreadRecord(projectId: ProjectId): HandoffThreadRecord {
  return {
    projectId,
    mode: "inherit",
    checkpoint: null,
    replicas: [],
    lease: null,
    continuedOn: null,
    fencedBranch: null,
    lastError: null,
    fencedBy: null,
    sideEffects: [],
    resumeTurnKey: null,
    runEpochs: {},
  };
}

export function applyConfigPatch(config: HandoffConfig, patch: HandoffConfigPatch): HandoffConfig {
  return {
    defaultMode: patch.defaultMode ?? config.defaultMode,
    noteModel: patch.noteModel ?? config.noteModel,
    pushToOrigin: patch.pushToOrigin ?? config.pushToOrigin,
    sleepTarget: patch.sleepTarget === undefined ? config.sleepTarget : patch.sleepTarget,
    autoTakeoverMinutes: patch.autoTakeoverMinutes ?? config.autoTakeoverMinutes,
  };
}

/** Thread setting, else the project's, else the global default. */
export function effectiveHandoffMode(
  document: Pick<HandoffDocument, "config" | "projectModes">,
  projectId: ProjectId,
  threadMode: HandoffThreadModeSetting,
): HandoffModeSetting {
  if (threadMode !== "inherit") return threadMode;
  return document.projectModes[projectId] ?? document.config.defaultMode;
}

// Lease

export interface LeaseHolder {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly threadId: ThreadId;
}

/** A new holder always gets a strictly greater epoch than any it replaces. */
export function acquireLease(
  current: HandoffLease | null,
  holder: LeaseHolder,
  now: string,
  minimumEpoch = 0,
): HandoffLease {
  return {
    holderEnvironmentId: holder.environmentId,
    holderLabel: holder.label,
    holderThreadId: holder.threadId,
    epoch: Math.max(current?.epoch ?? 0, minimumEpoch) + 1,
    renewedAt: now,
    state: "active",
  };
}

/** Only the active holder renews; anyone else's renewal is ignored. */
export function renewLease(
  lease: HandoffLease | null,
  environmentId: EnvironmentId,
  now: string,
): HandoffLease | null {
  if (lease === null || lease.state !== "active") return lease;
  if (lease.holderEnvironmentId !== environmentId) return lease;
  return { ...lease, renewedAt: now };
}

export const HANDOFF_RUN_EPOCHS_MAX = 20;

/** Remembers the epoch a run started under; the first observation wins. */
export function noteRunEpoch(
  runEpochs: Readonly<Record<string, number>>,
  runId: string,
  epoch: number,
): Record<string, number> {
  if (runEpochs[runId] !== undefined) return { ...runEpochs };
  const entries = [...Object.entries(runEpochs), [runId, epoch] as const];
  return Object.fromEntries(entries.slice(-HANDOFF_RUN_EPOCHS_MAX));
}

export function isLeaseStale(lease: HandoffLease, now: number): boolean {
  const renewed = Date.parse(lease.renewedAt);
  return !Number.isFinite(renewed) || now - renewed > HANDOFF_LEASE_STALE_MS;
}

export type EpochVerdict =
  | { readonly kind: "ok"; readonly epoch: number }
  | { readonly kind: "unleased" }
  | { readonly kind: "fenced"; readonly message: string }
  | { readonly kind: "stale"; readonly message: string };

/**
 * May this machine act for the thread under `epoch`? A copy that handed off
 * or saw a newer epoch is refused; a thread without a lease is unrestricted
 * (handoff mode was never used on it).
 */
export function checkEpoch(
  record: Pick<HandoffThreadRecord, "lease" | "continuedOn"> | undefined,
  environmentId: EnvironmentId,
  epoch?: number,
): EpochVerdict {
  if (record === undefined) return { kind: "unleased" };
  if (record.continuedOn !== null) {
    return {
      kind: "fenced",
      message: `This thread continues on ${record.continuedOn.machineLabel}; this copy is read-only.`,
    };
  }
  const lease = record.lease;
  if (lease === null) return { kind: "unleased" };
  if (lease.state === "fenced" || lease.holderEnvironmentId !== environmentId) {
    return {
      kind: "fenced",
      message: `Another machine (${lease.holderLabel}) runs this thread now; this copy is read-only.`,
    };
  }
  if (epoch !== undefined && epoch !== lease.epoch) {
    return {
      kind: "stale",
      message: `Stale lease epoch ${epoch}; the thread is at epoch ${lease.epoch}.`,
    };
  }
  return { kind: "ok", epoch: lease.epoch };
}

/** Fences the local copy: it never starts another turn or side effect. */
export function fenceRecord(
  record: HandoffThreadRecord,
  continuation: HandoffContinuation,
  fencedBy: "handoff" | "sleep" | null,
): HandoffThreadRecord {
  return {
    ...record,
    continuedOn: continuation,
    fencedBy: fencedBy ?? record.fencedBy,
    lease: record.lease === null ? null : { ...record.lease, state: "fenced" },
  };
}

// Side-effect journal

export type SideEffectVerdict =
  | { readonly kind: "proceed"; readonly epoch: number; readonly turnKey: string }
  | { readonly kind: "reuse"; readonly effect: ThreadSideEffect }
  | { readonly kind: "refuse"; readonly message: string };

/**
 * Before a turn's external side effect: refuse on a fenced or stale copy,
 * reuse a journaled result for the same turn, kind and target, else proceed.
 * A continuation checks the source's turn key too, so nothing the source
 * already did runs again.
 */
export function guardSideEffect(input: {
  readonly record: HandoffThreadRecord | undefined;
  readonly environmentId: EnvironmentId;
  readonly turnKey: string;
  readonly kind: ThreadSideEffectKind;
  readonly target: string;
  readonly epoch?: number;
}): SideEffectVerdict {
  const verdict = checkEpoch(input.record, input.environmentId, input.epoch);
  if (verdict.kind === "fenced" || verdict.kind === "stale") {
    return { kind: "refuse", message: verdict.message };
  }
  const keys = new Set([input.turnKey]);
  if (input.record?.resumeTurnKey) keys.add(input.record.resumeTurnKey);
  const done = input.record?.sideEffects.find(
    (effect) =>
      keys.has(effect.turnKey) && effect.kind === input.kind && effect.target === input.target,
  );
  if (done !== undefined) return { kind: "reuse", effect: done };
  return {
    kind: "proceed",
    epoch: verdict.kind === "ok" ? verdict.epoch : 0,
    turnKey: input.turnKey,
  };
}

export function recordSideEffect(
  record: HandoffThreadRecord,
  effect: ThreadSideEffect,
): HandoffThreadRecord {
  return { ...record, sideEffects: mergeSideEffects(record.sideEffects, [effect]) };
}

/** Joins journals from the source and destination, keeping one entry per effect. */
export function mergeSideEffects(
  ...journals: ReadonlyArray<ReadonlyArray<ThreadSideEffect>>
): Array<ThreadSideEffect> {
  const byKey = new Map<string, ThreadSideEffect>();
  for (const effect of journals.flat()) {
    const key = `${effect.turnKey}\u0000${effect.kind}\u0000${effect.target}`;
    const seen = byKey.get(key);
    if (seen === undefined || seen.at <= effect.at) {
      byKey.delete(key);
      byKey.set(key, effect);
    }
  }
  return [...byKey.values()].slice(-HANDOFF_SIDE_EFFECT_JOURNAL_MAX);
}

// Badge

/**
 * continued: this copy is fenced. handing-off: a transfer is in flight.
 * paused: woke after a fence and no peer answered. ready: the latest
 * checkpoint reached every replica (or origin when there are none). behind:
 * a checkpoint exists but has not reached them yet.
 */
export function deriveHandoffBadge(input: {
  readonly record: HandoffThreadRecord | undefined;
  readonly effectiveMode: HandoffModeSetting;
  readonly paused: boolean;
}): HandoffBadge | null {
  const record = input.record;
  if (record?.continuedOn) return "continued";
  if (input.effectiveMode === "off" || record === undefined) return null;
  if (record.lease?.state === "handing-off") return "handing-off";
  if (input.paused) return "paused";
  const checkpoint = record.checkpoint;
  if (checkpoint === null) return null;
  if (record.replicas.length === 0) return checkpoint.pushedToOrigin ? "ready" : "behind";
  const allCurrent = record.replicas.every(
    (replica) =>
      replica.state === "current" &&
      replica.sequence !== null &&
      replica.sequence >= checkpoint.sequence,
  );
  return allCurrent ? "ready" : "behind";
}

// Destination: replicas, takeovers and heartbeats

export const HANDOFF_INCOMING_MAX = 500;

export function incomingKey(environmentId: string, threadId: string): string {
  return `${environmentId}/${threadId}`;
}

export function findIncoming(
  document: HandoffDocument,
  environmentId: string,
  threadId: string,
): HandoffIncomingReplica | undefined {
  return document.incoming.find(
    (replica) =>
      replica.sourceEnvironmentId === environmentId && replica.sourceThreadId === threadId,
  );
}

export interface LinkableProject {
  readonly id: ProjectId;
  readonly title: string;
  readonly deletedAt?: string | null | undefined;
  readonly workspaceRoot: string;
  readonly workspaceSettings?:
    | {
        readonly logicalProject?:
          | {
              readonly members: ReadonlyArray<{
                readonly environmentId: string;
                readonly projectId: string;
              }>;
            }
          | null
          | undefined;
      }
    | null
    | undefined;
}

/**
 * The local project explicitly linked (0948) to the source's project, or null.
 * Two projects that only share a name are never joined.
 */
export function linkedLocalProject<P extends LinkableProject>(
  projects: ReadonlyArray<P>,
  sourceEnvironmentId: string,
  sourceProjectId: string,
): P | null {
  return (
    projects.find(
      (project) =>
        (project.deletedAt ?? null) === null &&
        (project.workspaceSettings?.logicalProject?.members ?? []).some(
          (member) =>
            member.environmentId === sourceEnvironmentId && member.projectId === sourceProjectId,
        ),
    ) ?? null
  );
}

export type IncomingVerdict =
  | { readonly kind: "stored"; readonly document: HandoffDocument }
  | { readonly kind: "refused"; readonly code: HandoffModeErrorCode; readonly message: string };

/**
 * Stores a replicated checkpoint. A copy this machine already continued is
 * refused (the source must fence itself); an older sequence only refreshes
 * when the source was last seen. Continued entries are evicted last.
 */
export function upsertIncoming(
  document: HandoffDocument,
  input: {
    readonly meta: ReplicateMeta;
    readonly projectId: ProjectId | null;
    readonly machineLabel: string;
    readonly now: string;
  },
): IncomingVerdict {
  const { meta, now } = input;
  const existing = findIncoming(document, meta.sourceEnvironmentId, meta.sourceThreadId);
  if (existing?.continuedThreadId != null) {
    return {
      kind: "refused",
      code: "fenced",
      message: `${input.machineLabel} already continues this thread; this copy is read-only.`,
    };
  }
  const key = incomingKey(meta.sourceEnvironmentId, meta.sourceThreadId);
  const lease: HandoffLease = meta.lease ?? {
    holderEnvironmentId: meta.sourceEnvironmentId,
    holderLabel: meta.sourceLabel,
    holderThreadId: meta.sourceThreadId,
    epoch: meta.checkpoint.epoch,
    renewedAt: now,
    state: "active",
  };
  if (existing !== undefined && existing.checkpoint.sequence > meta.checkpoint.sequence) {
    return {
      kind: "stored",
      document: replaceIncoming(document, {
        ...existing,
        sourceLastSeenAt: now,
        sourceUnreachable: false,
      }),
    };
  }
  const replica: HandoffIncomingReplica = {
    sourceEnvironmentId: meta.sourceEnvironmentId,
    sourceLabel: meta.sourceLabel,
    sourceThreadId: meta.sourceThreadId,
    projectId: input.projectId,
    title: meta.title,
    checkpoint: meta.checkpoint,
    lease,
    sourceLastSeenAt: now,
    sourceUnreachable: false,
    receivedAt: now,
    continuedThreadId: null,
  };
  const detail: HandoffIncomingDetail = {
    sourceProjectId: meta.sourceProjectId,
    repositoryPath: meta.repositoryPath,
    modelSelection: meta.modelSelection,
    runtimeMode: meta.runtimeMode,
    interactionMode: meta.interactionMode,
    transcript: meta.transcript,
    execution: meta.execution,
    takeoverEpoch: null,
    takeover: null,
  };
  const next = replaceIncoming(document, replica);
  return {
    kind: "stored",
    document: capIncoming({
      ...next,
      incomingDetails: { ...next.incomingDetails, [key]: detail },
    }),
  };
}

function replaceIncoming(
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

function capIncoming(document: HandoffDocument): HandoffDocument {
  const excess = document.incoming.length - HANDOFF_INCOMING_MAX;
  if (excess <= 0) return document;
  const order = [
    ...document.incoming.filter((entry) => entry.continuedThreadId === null),
    ...document.incoming.filter((entry) => entry.continuedThreadId !== null),
  ];
  const drop = new Set(
    order
      .slice(0, excess)
      .map((entry) => incomingKey(entry.sourceEnvironmentId, entry.sourceThreadId)),
  );
  const details = Object.fromEntries(
    Object.entries(document.incomingDetails ?? {}).filter(([key]) => !drop.has(key)),
  );
  return {
    ...document,
    incoming: document.incoming.filter(
      (entry) => !drop.has(incomingKey(entry.sourceEnvironmentId, entry.sourceThreadId)),
    ),
    incomingDetails: details,
  };
}

export type TakeoverVerdict =
  | {
      readonly kind: "proceed";
      readonly replica: HandoffIncomingReplica;
      readonly detail: HandoffIncomingDetail;
    }
  | { readonly kind: "repeat"; readonly response: TakeoverResponse }
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
export function takeoverVerdict(
  document: HandoffDocument,
  request: TakeoverRequest,
  machineLabel: string,
): TakeoverVerdict {
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
export function markContinued(
  document: HandoffDocument,
  request: TakeoverRequest,
  response: TakeoverResponse,
  now: string,
): HandoffDocument {
  const key = incomingKey(request.sourceEnvironmentId, request.sourceThreadId);
  const replica = findIncoming(document, request.sourceEnvironmentId, request.sourceThreadId);
  const detail = (document.incomingDetails ?? {})[key];
  if (replica === undefined || detail === undefined) return document;
  const next = replaceIncoming(document, {
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

/**
 * A heartbeat from a source: every thread it still holds that this machine
 * continued comes back, whatever epoch the source names, so the source fences
 * that copy (a continued source thread never runs again; a handback is a new
 * thread). For a replica not continued, the epoch the source holds raises the
 * replica's lease, so a delayed takeover at a lower epoch is refused. Also
 * records that the source answered.
 */
export function heartbeatContinued(
  document: HandoffDocument,
  request: {
    readonly sourceEnvironmentId: string;
    readonly leases: ReadonlyArray<{ readonly sourceThreadId: ThreadId; readonly epoch: number }>;
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
  return [continued, { ...document, incoming }];
}

/** Replicas whose source has not answered for longer than a stale lease read "unknown". */
export function markUnreachable(document: HandoffDocument, now: number): HandoffDocument {
  let changed = false;
  const incoming = document.incoming.map((replica) => {
    if (replica.continuedThreadId !== null || replica.sourceUnreachable) return replica;
    const seen = Date.parse(replica.sourceLastSeenAt ?? replica.receivedAt);
    if (Number.isFinite(seen) && now - seen <= HANDOFF_LEASE_STALE_MS) return replica;
    changed = true;
    return { ...replica, sourceUnreachable: true };
  });
  return changed ? { ...document, incoming } : document;
}
