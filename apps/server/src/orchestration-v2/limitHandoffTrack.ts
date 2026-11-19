/** Stub: the tests for the automatic track start come first (1390 T-13). */
export type ThreadTrackState = { readonly kind: "none" };
export const TRACK_RECHECK_UNKNOWN_MS = 0;
export const TRACK_RECHECK_UNREACHED_MS = 0;
export const limitHandoffTrackState = (_input: unknown): ThreadTrackState => ({ kind: "none" });
export const judgeTrackMachine = (_input: unknown) => ({ state: "error", line: "", evidence: null });
export const trackDecision = (_input: unknown) => null;
export const trackOutReason = (_track: string, _label: string) => "";
export const trackStartCapabilityFailure = (_input: unknown) => null;
