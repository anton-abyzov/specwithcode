import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { LifecycleReceipt } from "./threadLifecycleEvidence.ts";

const decode = Schema.decodeUnknownSync(LifecycleReceipt);
const proof = {
  status: "verified",
  reference: "receipt://release/42",
  scopeRevision: "source-42",
  observedAt: "2026-10-25T01:00:00Z",
};
const receipt = {
  requestId: "request-42",
  runId: "run-42",
  acceptanceRevision: "acceptance-42",
  requestedAt: "2026-10-25T00:00:00Z",
  kind: "code",
  scope: "Installed feature",
  scopeRevision: "source-42",
  recordedAt: "2026-10-25T02:00:00Z",
  validUntil: "2026-10-26T00:00:00Z",
  reportedBy: "completion-owner",
  obligations: [
    {
      kind: "resource",
      reason: "ENOSPC stopped testing",
      owner: "cleanup-owner",
      nextEvent: "Verify test capacity",
      needsUserOutput: false,
    },
  ],
  push: proof,
  merge: proof,
  deployment: proof,
  deliverable: proof,
  verification: proof,
};

describe("lifecycle receipt persistence contract", () => {
  it("retains structured operational reasons and request identity through JSON", () => {
    expect(decode(JSON.parse(JSON.stringify(decode(receipt))))).toEqual(receipt);
  });
  it.each([
    "requestId",
    "runId",
    "acceptanceRevision",
    "reportedBy",
    "obligations",
    "push",
    "merge",
    "deployment",
    "deliverable",
    "verification",
  ])("rejects incomplete receipts missing %s", (key) => {
    const incomplete = { ...receipt } as Record<string, unknown>;
    delete incomplete[key];
    expect(() => decode(incomplete)).toThrow();
  });
  it("does not decode terminal status or prose as evidence", () => {
    expect(() => decode({ status: "completed", note: "Done" })).toThrow();
    expect(() => decode({ ...receipt, verification: { status: "verified" } })).toThrow();
  });
  it("requires explicit non-applicable gate rationale", () => {
    const na = { status: "not_applicable", rationale: "Research answer; no code changed" };
    expect(
      decode({ ...receipt, kind: "no_code", push: na, merge: na, deployment: na }).push,
    ).toEqual(na);
    expect(() => decode({ ...receipt, push: { status: "not_applicable" } })).toThrow();
  });
  it("rejects unknown reasons rather than treating them as user blockers", () => {
    expect(() =>
      decode({ ...receipt, obligations: [{ ...receipt.obligations[0], kind: "idle" }] }),
    ).toThrow();
  });
});
