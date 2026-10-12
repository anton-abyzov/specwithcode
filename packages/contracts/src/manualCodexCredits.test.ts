import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { ManualCodexCreditIntent, manualCreditBindingMatches, manualCreditDispatchAllowed } from "./manualCodexCredits.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
const now = Date.parse("2026-10-09T07:00:00Z");
const selection = { instanceId: ProviderInstanceId.make("codex-1"), model: "gpt-6.1-sol" };
const intent = { type: "human-submit-existing-credits" as const, ...selection,
  expectedQuotaPoolId: `codex:sha256:${"a".repeat(64)}`, observedAt: "2026-10-09T06:59:40Z" };
const dispatch = { createdBy: "user", creationSource: "web", dispatchMode: "start_immediately", text: "Read marker.txt" };
describe("manual credit intent", () => {
  it("decodes the exact one-command binding", () => {
    expect(Schema.decodeUnknownSync(ManualCodexCreditIntent)(intent)).toEqual(intent);
  });
  it("rejects malformed pool identity", () => {
    expect(() => Schema.decodeUnknownSync(ManualCodexCreditIntent)({ ...intent, expectedQuotaPoolId: "foreign" })).toThrow();
  });
  it("requires fresh matching model and instance", () => {
    expect(manualCreditBindingMatches(intent, selection, now)).toBe(true);
    for (const changed of [{ ...selection, model: "gpt-6-astra" }, { ...selection, instanceId: "other" }])
      expect(manualCreditBindingMatches(intent, changed, now)).toBe(false);
    for (const observedAt of ["invalid", "2026-10-09T06:58:59Z", "2026-10-09T07:00:01Z"])
      expect(manualCreditBindingMatches({ ...intent, observedAt }, selection, now)).toBe(false);
  });
  it("admits immediate and prepared human sends only", () => {
    expect(manualCreditDispatchAllowed(dispatch)).toBe(true);
    expect(manualCreditDispatchAllowed({ ...dispatch, dispatchMode: "defer_start" })).toBe(true);
    for (const dispatchMode of ["queue_after_active", "steer_active", "restart_active"])
      expect(manualCreditDispatchAllowed({ ...dispatch, dispatchMode })).toBe(false);
    for (const deliveryIntent of ["steer", "restart", "queue"])
      expect(manualCreditDispatchAllowed({ ...dispatch, deliveryIntent })).toBe(false);
    for (const key of ["scheduledTaskId", "senderThreadId", "notification", "delegatedCompletion", "restartContinuationOfRunId", "usageLimitContinuationOfRunId", "manualContinuationOfRunId", "usageLimitRecoveryRequestId", "sourcePlanRef"])
      expect(manualCreditDispatchAllowed({ ...dispatch, [key]: "other" })).toBe(false);
    expect(manualCreditDispatchAllowed({ ...dispatch, text: " /goal continue forever" })).toBe(false);
    expect(manualCreditDispatchAllowed({ ...dispatch, creationSource: "server" })).toBe(false);
    expect(manualCreditDispatchAllowed({ ...dispatch, createdBy: "agent" })).toBe(false);
  });
  it("admits a project-rule continuation only from the server's limit rule", () => {
    const ruleIntent = { ...intent, type: "project-rule-existing-credits" as const };
    const continuation = { ...dispatch, creationSource: "server", manualContinuationOfRunId: "run-1", manualCodexCreditIntent: ruleIntent };
    expect(Schema.decodeUnknownSync(ManualCodexCreditIntent)(ruleIntent)).toEqual(ruleIntent);
    expect(manualCreditDispatchAllowed(continuation)).toBe(true);
    expect(manualCreditDispatchAllowed({ ...continuation, manualContinuationOfRunId: undefined })).toBe(true);
    expect(manualCreditDispatchAllowed({ ...continuation, creationSource: "web" })).toBe(false);
    expect(manualCreditDispatchAllowed({ ...continuation, dispatchMode: "defer_start" })).toBe(false);
    for (const key of ["scheduledTaskId", "restartContinuationOfRunId", "usageLimitContinuationOfRunId", "sourcePlanRef"])
      expect(manualCreditDispatchAllowed({ ...continuation, [key]: "other" })).toBe(false);
    // A human intent on the server path stays refused.
    expect(manualCreditDispatchAllowed({ ...continuation, manualCodexCreditIntent: intent })).toBe(false);
  });
});
