/**
 * How far an increment's acceptance criteria are proven, for the plan card
 * and the compact progress in lists. A tick in the spec or a task marked done
 * is a declaration, not proof, so only `verified` (ledger evidence plus a
 * passing `specweave verify` after it) counts. Pure rules only.
 */
import type {
  ThreadIncrementCriterion,
  ThreadIncrementCriterionState,
} from "@specweave-studio/contracts";

export type CriterionPresentationState =
  | ThreadIncrementCriterionState
  | "mixed"
  | "skipped-accepted";

/** A server that predates per-AC states sends only `met`; that is a declaration at most. */
export function criterionState(criterion: ThreadIncrementCriterion): CriterionPresentationState {
  // A waiver never hides an unfinished sibling requirement or unreadable ledger.
  if (criterion.state === "open" || criterion.state === "unknown") return criterion.state;
  if (criterion.acceptance === "mixed" || criterion.acceptance === "skipped-accepted")
    return criterion.acceptance;
  return criterion.state ?? (criterion.met ? "declared" : "open");
}

/** Criteria proven `verified` out of all of them, for the plan card's "AC 1/4". */
export function verifiedCriteriaCount(criteria: ReadonlyArray<ThreadIncrementCriterion>): {
  verified: number;
  total: number;
} {
  return {
    verified: criteria.filter((criterion) => criterionState(criterion) === "verified").length,
    total: criteria.length,
  };
}
