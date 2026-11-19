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
import { MODEL_TRACKS } from "./modelTracks.ts";
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
  /**
   * Set when a review thread stays because of this machine: it offers no
   * reviewer the lock permits, or its SpecWithCode is too old to keep the
   * lock. `reason` stays one an older client reads.
   */
  review: Schema.optional(Schema.Literals(["no_reviewer", "update_needed"])),
  usedPercent: Schema.NullOr(Schema.Number),
  resetsAt: Schema.NullOr(IsoDateTime),
});
export type LimitHandoffCandidate = typeof LimitHandoffCandidate.Type;

/** What one paired machine answered for a thread whose track is out here. */
export const LimitHandoffTrackMachine = Schema.Struct({
  environmentId: EnvironmentId,
  machineLabel: Schema.String,
  /**
   * `room`: a sign-in on the track with a fresh reading below the threshold.
   * `out`: it answered, and nothing on the track has room there. The others
   * mean it could not be asked, which is never read as out.
   */
  state: Schema.Literals(["room", "out", "needs-update", "unreachable", "error"]),
  /** "Minis: Same Claude account as M4: adds no usage". */
  line: Schema.String,
  /** When the sign-in it answered for resets, when it said. */
  resetsAt: Schema.NullOr(IsoDateTime),
});
export type LimitHandoffTrackMachine = typeof LimitHandoffTrackMachine.Type;

/**
 * The automatic start's decision for one thread on a track (1390): whether
 * the track is out on this machine, the machine and sign-in chosen, or why
 * the thread stays. The limit banner shows it, and so does the progress view.
 */
export const LimitHandoffTrackDecision = Schema.Struct({
  threadId: ThreadId,
  track: Schema.Literals(MODEL_TRACKS),
  /** This machine, as the lines name it. */
  machineLabel: Schema.String,
  /** Every source of the thread's model and every later model of its track is out here. */
  trackOut: Schema.Boolean,
  /** "Daily track out of tokens on M4". */
  reason: Schema.String,
  /** The machine the thread was handed to, or null when it stays. */
  target: Schema.NullOr(
    Schema.Struct({
      environmentId: EnvironmentId,
      machineLabel: Schema.String,
      /** The sign-in and model that machine confirmed for the track. */
      modelSelection: ModelSelection,
      /** `resume` continues the stopped turn there; `ready` leaves the thread idle. */
      disposition: Schema.Literals(["resume", "ready"]),
    }),
  ),
  /** Every machine that could take the track answered, and none has room. */
  everyMachineOut: Schema.Boolean,
  /** The earliest known reset of the track on any machine; null is "Reset unknown". */
  earliestReset: Schema.NullOr(Schema.Struct({ machineLabel: Schema.String, at: IsoDateTime })),
  /** When the machines are asked again; nothing is asked before it. */
  recheckAt: Schema.NullOr(IsoDateTime),
  machines: Schema.Array(LimitHandoffTrackMachine),
  decidedAt: IsoDateTime,
});
export type LimitHandoffTrackDecision = typeof LimitHandoffTrackDecision.Type;

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
  /** The automatic start's decision for a thread on a track; absent from an older server. */
  track: Schema.optional(Schema.NullOr(LimitHandoffTrackDecision)),
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
