import * as Schema from "effect/Schema";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * One request allowed to use existing paid credits: a single human
 * submission, or one continuation the project's limit rule sends after a
 * person turned "spend credits" on for that project. Never a thread or
 * session spending preference: each intent binds one instance, model and
 * fresh account observation.
 */
export const ManualCodexCreditIntent = Schema.Struct({
  type: Schema.Literals(["human-submit-existing-credits", "project-rule-existing-credits"]),
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  expectedQuotaPoolId: Schema.String.check(Schema.isPattern(/^codex:sha256:[a-f0-9]{64}$/)),
  observedAt: IsoDateTime,
});
export type ManualCodexCreditIntent = typeof ManualCodexCreditIntent.Type;
export const MANUAL_CREDIT_OBSERVATION_MAX_AGE_MS = 60_000;

export function manualCreditBindingMatches(
  intent: ManualCodexCreditIntent,
  selection: { readonly instanceId: string; readonly model: string },
  now: number,
): boolean {
  const age = now - Date.parse(intent.observedAt);
  return intent.instanceId === selection.instanceId && intent.model === selection.model &&
    Number.isFinite(age) && age >= 0 && age <= MANUAL_CREDIT_OBSERVATION_MAX_AGE_MS;
}

/**
 * Explicit dispatch only. User provenance alone also occurs in automatic
 * recovery. A project-rule intent is the one server-created exception: the
 * limit rule continues the stopped run (`manualContinuationOfRunId`) and
 * nothing else, so no other automatic path can borrow the permission.
 */
export function manualCreditDispatchAllowed(input: {
  readonly manualCodexCreditIntent?: { readonly type: string } | undefined;
  readonly createdBy: string;
  readonly creationSource?: string | undefined;
  readonly dispatchMode: string;
  readonly deliveryIntent?: string | undefined;
  readonly scheduledTaskId?: unknown;
  readonly senderThreadId?: unknown;
  readonly notification?: unknown;
  readonly delegatedCompletion?: unknown;
  readonly restartContinuationOfRunId?: unknown;
  readonly usageLimitContinuationOfRunId?: unknown;
  readonly manualContinuationOfRunId?: unknown;
  readonly usageLimitRecoveryRequestId?: unknown;
  readonly sourcePlanRef?: unknown;
  readonly text: string;
}): boolean {
  const automatic = [input.scheduledTaskId,input.senderThreadId,input.notification,input.delegatedCompletion,
    input.restartContinuationOfRunId,input.usageLimitContinuationOfRunId,
    input.usageLimitRecoveryRequestId,input.sourcePlanRef];
  if (input.manualCodexCreditIntent?.type === "project-rule-existing-credits") {
    return input.createdBy === "user" && input.creationSource === "server" &&
      input.dispatchMode === "start_immediately" &&
      (input.deliveryIntent === undefined || input.deliveryIntent === "auto" || input.deliveryIntent === "start") &&
      !/^\s*\/goal(?:\s|$)/i.test(input.text) &&
      automatic.every((value) => value === undefined);
  }
  return input.createdBy === "user" && input.creationSource === "web" &&
    (input.dispatchMode === "start_immediately" || input.dispatchMode === "defer_start") &&
    (input.deliveryIntent === undefined || input.deliveryIntent === "auto" || input.deliveryIntent === "start") &&
    !/^\s*\/goal(?:\s|$)/i.test(input.text) &&
    [...automatic, input.manualContinuationOfRunId].every((value) => value === undefined);
}
