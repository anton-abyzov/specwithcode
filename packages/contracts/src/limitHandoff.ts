/**
 * Handing a thread to another machine when its provider nears or hits its
 * usage limit: why each machine target can or can't take it now.
 *
 * @module limitHandoff
 */
import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";
import { EnvironmentAuthorizationError } from "./auth.ts";
import { EnvironmentId, IsoDateTime, ThreadId } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderLimitTargetOrder } from "./settings.ts";

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
export type LimitHandoffCandidateReason = typeof LimitHandoffCandidateReason.Type;

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
export type LimitHandoffCandidate = typeof LimitHandoffCandidate.Type;

export const LimitHandoffCandidatesInput = Schema.Struct({ threadId: ThreadId });
export type LimitHandoffCandidatesInput = typeof LimitHandoffCandidatesInput.Type;

export const LimitHandoffCandidatesResult = Schema.Struct({
  /** False on a server that can't move threads to another machine yet. */
  available: Schema.Boolean,
  order: ProviderLimitTargetOrder,
  /** Null when the switch happens only at the limit. */
  thresholdPercent: Schema.NullOr(Schema.Number),
  candidates: Schema.Array(LimitHandoffCandidate),
  /** Why the thread waits when no machine target qualifies, else null. */
  waiting: Schema.NullOr(Schema.String),
  checkedAt: IsoDateTime,
});
export type LimitHandoffCandidatesResult = typeof LimitHandoffCandidatesResult.Type;

export class LimitHandoffError extends Schema.TaggedError<LimitHandoffError>()(
  "LimitHandoffError",
  {
    code: Schema.Literals(["not_found", "failed"]),
    message: Schema.String,
  },
) {}

export const LIMIT_HANDOFF_RPC_METHODS = {
  limitHandoffCandidates: "limitHandoff.candidates",
} as const;

export const limitHandoffRpcs = [
  Rpc.make(LIMIT_HANDOFF_RPC_METHODS.limitHandoffCandidates, {
    payload: LimitHandoffCandidatesInput,
    success: LimitHandoffCandidatesResult,
    error: Schema.Union([LimitHandoffError, EnvironmentAuthorizationError]),
  }),
] as const;
