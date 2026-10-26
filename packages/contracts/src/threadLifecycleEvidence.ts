import * as Schema from "effect/Schema";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

const Text = TrimmedNonEmptyString.check(Schema.isMaxLength(2000));
const Identity = TrimmedNonEmptyString.check(Schema.isMaxLength(500));

export const LifecycleRequest = Schema.Struct({
  requestId: Identity,
  runId: Identity,
  acceptanceRevision: Identity,
  requestedAt: IsoDateTime,
});

export const LifecycleObligation = Schema.Struct({
  kind: Schema.Literals([
    "agent_work",
    "resource",
    "network",
    "tool",
    "deployment",
    "review",
    "dependency",
    "user_action",
    "authentication",
    "provider",
    "usage_limit",
    "nested_work",
    "stopped",
    "unknown",
  ]),
  reason: Text,
  owner: Identity,
  nextEvent: Text,
  needsUserOutput: Schema.Boolean,
});

export const LifecycleGate = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("verified"),
    reference: Text,
    observedAt: IsoDateTime,
    scopeRevision: Identity,
  }),
  Schema.Struct({ status: Schema.Literal("not_applicable"), rationale: Text }),
  Schema.Struct({ status: Schema.Literal("pending"), reason: Text }),
]);

/**
 * A persisted adjudication, not a provider completion signal. Server handlers
 * bind reporting identity and current request before accepting this record.
 * Old threads omit the whole record; never default omitted gates to verified.
 */
/**
 * What an adjudicating thread reports. The server binds the request identity,
 * recording time and reporter, so a caller can never name another request or
 * vouch for itself under a different identity.
 */
export const LifecycleReceiptReport = Schema.Struct({
  kind: Schema.Literals(["code", "no_code"]),
  scope: Text,
  scopeRevision: Identity,
  validUntil: IsoDateTime,
  obligations: Schema.Array(LifecycleObligation).check(Schema.isMaxLength(100)),
  push: LifecycleGate,
  merge: LifecycleGate,
  deployment: LifecycleGate,
  deliverable: LifecycleGate,
  verification: LifecycleGate,
});
export type LifecycleReceiptReport = typeof LifecycleReceiptReport.Type;

export const LifecycleReceipt = Schema.Struct({
  ...LifecycleRequest.fields,
  ...LifecycleReceiptReport.fields,
  recordedAt: IsoDateTime,
  reportedBy: Identity,
});
export type LifecycleReceipt = typeof LifecycleReceipt.Type;
