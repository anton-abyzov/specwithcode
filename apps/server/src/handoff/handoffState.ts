/**
 * The handoff mode document and the pure rules over it: effective mode, the
 * lease and its epoch, the side-effect journal and the badge. No I/O here, so
 * every rule is tested without a server.
 */
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
  HandoffModeSetting,
  HandoffReplicaStatus,
  HandoffThreadModeSetting,
  NonNegativeInt,
  ProjectId,
  type ThreadId,
  ThreadSideEffect,
  type ThreadSideEffectKind,
} from "@specweave-studio/contracts";

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

export const HandoffDocument = Schema.Struct({
  version: Schema.Literal(1),
  config: HandoffConfig,
  projectModes: Schema.Record(Schema.String, HandoffModeSetting),
  threads: Schema.Record(Schema.String, HandoffThreadRecord),
  incoming: Schema.Array(HandoffIncomingReplica),
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
