import type { ProviderApprovalDecision, ProviderApprovalOption } from "@specweave-studio/contracts";

export const DEFAULT_APPROVAL_OPTIONS = [
  { decision: "cancel", label: "Cancel" },
  { decision: "decline", label: "Decline" },
  { decision: "acceptForSession", label: "Always allow this session" },
  { decision: "accept", label: "Approve" },
] satisfies ReadonlyArray<ProviderApprovalOption>;

// Providers list their options in their own order (Antigravity puts accept first).
// The bar always reads the same way: decline, broader grants, then accept last.
const DECISION_RANK: Record<ProviderApprovalDecision, number> = {
  cancel: 0,
  decline: 1,
  acceptForSession: 2,
  acceptAlways: 3,
  accept: 4,
};

export interface OrderedApprovalOptions {
  /** Stops the turn; shown apart from the decisions as a quiet control. */
  cancel: ProviderApprovalOption | undefined;
  /** Decline first and accept last, provider labels kept. */
  decisions: ProviderApprovalOption[];
}

export function orderApprovalOptions(
  options: ReadonlyArray<ProviderApprovalOption>,
): OrderedApprovalOptions {
  const ordered = options
    .map((option, index) => ({ option, index }))
    .toSorted(
      (a, b) =>
        DECISION_RANK[a.option.decision] - DECISION_RANK[b.option.decision] || a.index - b.index,
    )
    .map(({ option }) => option);
  return {
    cancel: ordered.find((option) => option.decision === "cancel"),
    decisions: ordered.filter((option) => option.decision !== "cancel"),
  };
}
