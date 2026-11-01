import type {
  ProviderApprovalDecision,
  ProviderApprovalOption,
  ProviderRequestKind,
} from "@specweave-studio/contracts";

export const DEFAULT_APPROVAL_OPTIONS: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "accept", label: "Approve" },
  { decision: "acceptForSession", label: "Always allow this session" },
  { decision: "decline", label: "Decline" },
];

/** Readable card title when the provider names no app; matches the web approval bar. */
export function approvalKindTitle(requestKind: ProviderRequestKind): string {
  switch (requestKind) {
    case "command":
      return "Command approval";
    case "file-read":
      return "File read approval";
    case "permission":
      return "App permission approval";
    case "mcp-elicitation":
      return "App access approval";
    case "file-change":
      return "File change approval";
  }
}

const DECISION_ORDER: Record<ProviderApprovalDecision, number> = {
  accept: 0,
  acceptForSession: 1,
  acceptAlways: 2,
  decline: 3,
  cancel: 4,
};

/**
 * Accept first and cancel last, whatever order the provider sent. Cancel is split out
 * so the card can render it as a quiet text button under the stack.
 */
export function orderApprovalOptions(options: ReadonlyArray<ProviderApprovalOption>): {
  readonly stacked: ReadonlyArray<ProviderApprovalOption>;
  readonly cancel: ProviderApprovalOption | null;
} {
  const sorted = options
    .map((option, index) => ({ option, index }))
    .sort(
      (a, b) =>
        DECISION_ORDER[a.option.decision] - DECISION_ORDER[b.option.decision] || a.index - b.index,
    )
    .map(({ option }) => option);
  return {
    stacked: sorted.filter((option) => option.decision !== "cancel"),
    cancel: sorted.find((option) => option.decision === "cancel") ?? null,
  };
}

export function approvalOptionTone(
  decision: ProviderApprovalDecision,
): "primary" | "secondary" | "danger" {
  return decision === "accept" ? "primary" : decision === "decline" ? "danger" : "secondary";
}
