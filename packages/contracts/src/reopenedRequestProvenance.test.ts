import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  OrchestrationV2PendingRuntimeRequestSummaryJson,
  OrchestrationV2RuntimeRequestJson,
} from "./orchestrationV2.ts";

it("round-trips original reopened ask chronology through request payload JSON, including legacy absence", () => {
  const request = {
    id: "update-reopen:q1",
    nodeId: "request-node",
    providerTurnId: null,
    nativeRequestRef: null,
    kind: "user_input",
    status: "pending",
    responseCapability: { type: "message" },
    createdAt: "2026-10-29T15:00:00.000Z",
    resolvedAt: null,
  };
  for (const provenance of [
    {},
    { reopenedFromAskedAt: null },
    { reopenedFromAskedAt: "2026-10-29T13:00:00Z" },
  ]) {
    const wire = { ...request, ...provenance };
    const decoded = Schema.decodeUnknownSync(OrchestrationV2RuntimeRequestJson)(wire);
    expect(Schema.encodeSync(OrchestrationV2RuntimeRequestJson)(decoded)).toEqual(wire);
  }
});

it("carries reopened ask provenance on the shell pending-request summary", () => {
  // Attention reads only the shell summary, never full requests: provenance
  // must survive this wire shape or reopened cards lose their chronology.
  const summary = {
    id: "update-reopen:q1",
    kind: "user_input",
    createdAt: "2026-10-29T15:00:00.000Z",
    reopenedFromAskedAt: "2026-10-29T13:00:00Z",
  };
  const decoded = Schema.decodeUnknownSync(OrchestrationV2PendingRuntimeRequestSummaryJson)(
    summary,
  );
  expect(decoded.reopenedFromAskedAt).toBe("2026-10-29T13:00:00Z");
  expect(Schema.encodeSync(OrchestrationV2PendingRuntimeRequestSummaryJson)(decoded)).toEqual(
    summary,
  );
  const legacy = { id: "update-reopen:legacy", kind: "user_input", createdAt: summary.createdAt };
  expect(
    Schema.decodeUnknownSync(OrchestrationV2PendingRuntimeRequestSummaryJson)(legacy)
      .reopenedFromAskedAt,
  ).toBeUndefined();
});
