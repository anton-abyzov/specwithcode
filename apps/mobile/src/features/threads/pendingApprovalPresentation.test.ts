import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_APPROVAL_OPTIONS,
  approvalKindTitle,
  approvalOptionTone,
  orderApprovalOptions,
} from "./pendingApprovalPresentation";

describe("approvalKindTitle", () => {
  it("names every request kind in words", () => {
    expect(approvalKindTitle("command")).toBe("Command approval");
    expect(approvalKindTitle("file-change")).toBe("File change approval");
    expect(approvalKindTitle("file-read")).toBe("File read approval");
    expect(approvalKindTitle("permission")).toBe("App permission approval");
    expect(approvalKindTitle("mcp-elicitation")).toBe("App access approval");
  });
});

describe("orderApprovalOptions", () => {
  it("puts accept first, decline after the allows and splits cancel out", () => {
    const { stacked, cancel } = orderApprovalOptions([
      { decision: "cancel", label: "Cancel" },
      { decision: "decline", label: "No" },
      { decision: "acceptForSession", label: "Session" },
      { decision: "accept", label: "Yes" },
      { decision: "acceptAlways", label: "Always" },
    ]);
    expect(stacked.map((option) => option.decision)).toEqual([
      "accept",
      "acceptForSession",
      "acceptAlways",
      "decline",
    ]);
    expect(cancel?.label).toBe("Cancel");
  });

  it("returns no cancel when the provider offers none", () => {
    const { stacked, cancel } = orderApprovalOptions(DEFAULT_APPROVAL_OPTIONS);
    expect(stacked.map((option) => option.label)).toEqual([
      "Approve",
      "Always allow this session",
      "Decline",
    ]);
    expect(cancel).toBeNull();
  });
});

describe("approvalOptionTone", () => {
  it("makes accept primary and decline danger", () => {
    expect(approvalOptionTone("accept")).toBe("primary");
    expect(approvalOptionTone("decline")).toBe("danger");
    expect(approvalOptionTone("acceptForSession")).toBe("secondary");
  });
});
