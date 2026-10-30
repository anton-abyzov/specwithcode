/**
 * How long each step of a drain may wait (`ServiceUpdatePreparation`): the
 * default for fleet and automatic installs, and a tighter one for a drain a
 * person waits on.
 *
 * @module ServiceUpdatePreparationTimings
 */

export interface ServiceUpdatePreparationTimings {
  /** How long Stop gets before a turn that is still running is ended locally. */
  readonly interruptGraceMs: number;
  /** How long the forced end and the outbox get to settle afterwards. */
  readonly settleMs: number;
  /** How long effects get to finish on their own before they are cancelled. */
  readonly effectGraceMs: number;
  /**
   * The whole drain's budget. Waits shrink to fit it; the cleanup that follows
   * them only writes, so the call ends shortly after.
   */
  readonly deadlineMs: number;
  readonly pollMs: number;
  /**
   * The checkpoint grace and the effect grace share one `effectGraceMs` window
   * instead of each getting its own.
   */
  readonly sharedEffectGrace?: boolean;
}

export const DEFAULT_TIMINGS: ServiceUpdatePreparationTimings = {
  // Longer than the Claude adapter's 10 s interrupt acknowledgement, so a slow
  // provider is ended by its own adapter before it is forced here.
  interruptGraceMs: 21_000,
  settleMs: 10_000,
  effectGraceMs: 20_000,
  deadlineMs: 70_000,
  pollMs: 400,
};

/** A drain a person waits on (`interactive`): about 15 s rather than 70 s at worst. */
export const INTERACTIVE_TIMINGS: ServiceUpdatePreparationTimings = {
  // A provider that has not stopped by now is ended locally; its turn ends
  // `interrupted` and is continued like any other.
  interruptGraceMs: 8_000,
  settleMs: 3_000,
  effectGraceMs: 5_000,
  deadlineMs: 15_000,
  pollMs: 400,
  sharedEffectGrace: true,
};

/** How long a drain waits for closed agent processes to leave the process tree. */
export const DESCENDANT_SETTLE_MS = 3_000;
