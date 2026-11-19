/**
 * The previous release's side of a handoff, as far as a reviewer lock touches
 * it, copied from tag `v1.0.384`. Each block names the file it came from.
 * Nothing here imports this version's handoff code, so a change there cannot
 * move what the previous release does.
 *
 * Used by `handoffReviewLock.test.ts` to run this version against that
 * release in both directions.
 */
import {
  EnvironmentId,
  HandoffCheckpoint,
  HandoffLease,
  IsoDateTime,
  ModelSelection,
  NonNegativeInt,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  TeamRulesCarried,
  ThreadExecutionRecord,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";

export const PREVIOUS_RELEASE = "v1.0.384";
export const PREVIOUS_APP_VERSION = "1.0.384";

/* apps/server/src/handoff/handoffWire.ts */

export const HANDOFF_PROTOCOL_VERSION = 2;
const HANDOFF_TRANSCRIPT_MAX_MESSAGES = 8;
const HANDOFF_TRANSCRIPT_MESSAGE_MAX_CHARS = 1500;

const text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const repositoryPath = text(1024);

const PeerTranscriptMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  text: text(HANDOFF_TRANSCRIPT_MESSAGE_MAX_CHARS),
});

export const ReplicateMeta = Schema.Struct({
  sourceEnvironmentId: EnvironmentId,
  sourceLabel: text(120),
  sourceProjectId: ProjectId,
  sourceThreadId: ThreadId,
  repositoryPath,
  title: text(500),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  checkpoint: HandoffCheckpoint,
  lease: Schema.NullOr(HandoffLease),
  transcript: Schema.Array(PeerTranscriptMessage).check(
    Schema.isMaxLength(HANDOFF_TRANSCRIPT_MAX_MESSAGES),
  ),
  /** The source thread's owner and execution history, carried into the continuation. */
  execution: Schema.NullOr(ThreadExecutionRecord),
  protocolVersion: Schema.optional(NonNegativeInt),
  appVersion: Schema.optional(text(40)),
  /** The ceiling the thread carries. The sender refuses a machine too old to hold it. */
  carried: Schema.optional(TeamRulesCarried),
});
export type ReplicateMeta = typeof ReplicateMeta.Type;

/* apps/server/src/handoff/handoffWire.ts: every operation that release answers. */

export const PEER_PATHS: ReadonlySet<string> = new Set([
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

/* apps/server/src/handoff/handoffRoute.ts: its answer to any other path. */

export const unknownPath = {
  status: 404,
  body: { error: "not_found", code: "not_found" },
} as const;

/* packages/contracts/src/handoffMode.ts */

export const HandoffPreflightCheck = Schema.Literals([
  "checkpoint",
  "ignored-files",
  "grant",
  "provider",
  "model",
  "project-link",
  "lease",
  "version",
]);

const bounded = (max: number) => Schema.String.check(Schema.isMaxLength(max));

export const HandoffPreflightFailure = Schema.Struct({
  check: HandoffPreflightCheck,
  message: bounded(500),
});

export const HandoffModeErrorCode = Schema.Literals([
  "not_found",
  "invalid",
  "busy",
  "not_a_repository",
  "unreachable",
  "needs_grant",
  "fenced",
  "too_large",
  "failed",
]);

/* apps/server/src/handoff/handoffWire.ts */

export const PeerErrorBody = Schema.Struct({
  error: text(1000),
  code: Schema.optional(HandoffModeErrorCode),
  /** The preflight check a refusal maps to, so the source reports it per thread. */
  check: Schema.optional(HandoffPreflightCheck),
});

/* packages/contracts/src/limitHandoff.ts */

export const LimitHandoffCandidateReason = Schema.Literals([
  "eligible",
  "not_paired",
  "offline",
  "needs_grant",
  "grant_revoked",
  "grant_expired",
  "pair_again",
  "update_needed",
  "not_checked",
  /** The thread's project has no linked copy on that machine. */
  "not_linked",
  "no_project_grant",
  "ambiguous_project",
  "not_installed",
  "unavailable",
  "account_not_granted",
  "model_missing",
  "signed_out",
  "same_account",
  "limited",
  "at_threshold",
  "unknown_account",
  "unknown_usage",
  "stale_usage",
  /** The target's preflight refused this thread (missing files, secrets, grants or sign-in). */
  "refused",
]);

export const LimitHandoffCandidate = Schema.Struct({
  environmentId: EnvironmentId,
  machineLabel: Schema.String,
  modelSelection: ModelSelection,
  eligible: Schema.Boolean,
  reason: LimitHandoffCandidateReason,
  /** "Minis: same Claude account as M4". */
  text: Schema.String,
  usedPercent: Schema.NullOr(Schema.Number),
  resetsAt: Schema.NullOr(IsoDateTime),
});

/*
 * apps/server/src/environment/ServerEnvironment.ts: what the descriptor says a
 * server can do. A part of that release's list; it has no `handoffReviewLock`.
 */

export const descriptorCapabilities = {
  repositoryIdentity: true,
  connectionProbe: true,
  attachmentUploads: true,
  questionAttachments: true,
  pullRequests: true,
  teamRulesCarried: true,
  deviceApproval: true,
  pullRequestChecks: true,
  inlineMessageContext: true,
  requiredWorktreeBootstrap: true,
  threadSettlement: true,
  threadAutoSettlement: true,
  advisor: true,
  threadReviewMode: true,
} as const;

/** The descriptor a machine on the previous release answers its identity check with. */
export const descriptor = (environmentId: string, label: string) => ({
  environmentId,
  label,
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: PREVIOUS_APP_VERSION,
  capabilities: descriptorCapabilities,
});

/* apps/server/src/fleet/fleetTransport.ts: what it keeps of another machine's descriptor. */

export const peerRules = (said: {
  readonly capabilities: { readonly teamRulesCarried?: boolean };
}) => ({
  carried: said.capabilities.teamRulesCarried === true,
});

/* apps/server/src/handoff/HandoffMoves.ts: the checkpoint message it sends. */

export const outgoingMeta = (input: {
  readonly self: EnvironmentId;
  readonly selfLabel: string;
  readonly shell: Pick<
    ReplicateMeta,
    "title" | "modelSelection" | "runtimeMode" | "interactionMode"
  > & { readonly id: ThreadId; readonly projectId: ProjectId };
  readonly repositoryPath: string;
  readonly checkpoint: ReplicateMeta["checkpoint"];
  readonly lease: ReplicateMeta["lease"];
  readonly transcript: ReplicateMeta["transcript"];
  readonly execution: ReplicateMeta["execution"];
  readonly carried?: ReplicateMeta["carried"];
}): ReplicateMeta => {
  const { self, selfLabel, shell, repositoryPath: path, checkpoint, carried } = input;
  return {
    sourceEnvironmentId: self,
    sourceLabel: selfLabel.slice(0, 120),
    sourceProjectId: shell.projectId,
    sourceThreadId: shell.id,
    repositoryPath: path,
    title: shell.title.slice(0, 500),
    modelSelection: shell.modelSelection,
    runtimeMode: shell.runtimeMode,
    interactionMode: shell.interactionMode,
    checkpoint,
    lease: input.lease,
    transcript: input.transcript,
    execution: input.execution,
    protocolVersion: HANDOFF_PROTOCOL_VERSION,
    appVersion: PREVIOUS_APP_VERSION,
    ...(carried === undefined ? {} : { carried }),
  };
};

/* apps/server/src/handoff/handoffState.ts: what it keeps beside an incoming copy. */

export const incomingDetail = (meta: ReplicateMeta) => ({
  sourceProjectId: meta.sourceProjectId,
  repositoryPath: meta.repositoryPath,
  modelSelection: meta.modelSelection,
  runtimeMode: meta.runtimeMode,
  interactionMode: meta.interactionMode,
  transcript: meta.transcript,
  execution: meta.execution,
  ...(meta.carried === undefined ? {} : { carried: meta.carried }),
  takeoverEpoch: null,
  takeover: null,
  ...(meta.protocolVersion === undefined ? {} : { sourceProtocolVersion: meta.protocolVersion }),
  ...(meta.appVersion === undefined ? {} : { sourceAppVersion: meta.appVersion }),
});

/* apps/server/src/handoff/HandoffReceiver.ts: the model a takeover continues on, and its launch. */

export const takeoverLaunch = (
  request: { readonly modelSelection: ModelSelection | null },
  detail: { readonly modelSelection: ModelSelection },
  title: string,
) => {
  const modelSelection = request.modelSelection ?? detail.modelSelection;
  return {
    title,
    modelSelection,
    createdBy: "system",
    creationSource: "server",
  } as const;
};

/* apps/server/src/orchestration-v2/MachineLimitHandoff.ts: a marked review has no machine targets. */

export const limitTargets = <T>(
  thread: { readonly routing?: { readonly reviewFamily?: string } | null },
  targets: ReadonlyArray<T>,
): ReadonlyArray<T> => (thread.routing?.reviewFamily !== undefined ? [] : targets);
