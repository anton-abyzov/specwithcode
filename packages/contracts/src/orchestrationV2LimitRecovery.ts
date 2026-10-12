import * as Schema from "effect/Schema";
import { CommandId, RunId, IsoDateTime } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/** Native account identity is opaque; no credentials or account labels are persisted. */
export const OrchestrationV2LimitAvailability = Schema.Struct({
  checkedAt: IsoDateTime,
  retryAt: IsoDateTime,
  status: Schema.Literals(["allowed", "denied", "unknown", "changed"]),
  threadUpdatedAt: IsoDateTime,
  affinity: Schema.optional(
    Schema.Struct({
      instanceId: ProviderInstanceId,
      continuationKey: Schema.String,
      quotaPoolId: Schema.String,
    }),
  ),
});
export type OrchestrationV2LimitAvailability = typeof OrchestrationV2LimitAvailability.Type;

export const OrchestrationV2LimitRecovery = Schema.Struct({
  requestId: Schema.optional(CommandId),
  runId: RunId,
  resetAt: Schema.NullOr(IsoDateTime),
  autoResume: Schema.Boolean,
  snooze: Schema.optional(Schema.Boolean),
  checkNow: Schema.optional(Schema.Boolean),
  availability: Schema.optional(OrchestrationV2LimitAvailability),
  explicitArm: Schema.optional(Schema.Boolean),
  armedAffinity: Schema.optional(OrchestrationV2LimitAvailability.fields.affinity.schema),
});
export type OrchestrationV2LimitRecovery = typeof OrchestrationV2LimitRecovery.Type;

/** A choice update preserves omitted options for this same run and reset. */
export const OrchestrationV2LimitRecoveryUpdate = Schema.Struct({
  runId: RunId,
  resetAt: Schema.NullOr(IsoDateTime),
  autoResume: Schema.optional(Schema.Boolean),
  snooze: Schema.optional(Schema.Boolean),
  checkNow: Schema.optional(Schema.Literal(true)),
}).check(
  Schema.makeFilter(
    (update) =>
      update.autoResume !== undefined ||
      update.snooze !== undefined ||
      update.checkNow === true ||
      "A recovery update must include autoResume, snooze or checkNow.",
  ),
);
export type OrchestrationV2LimitRecoveryUpdate = typeof OrchestrationV2LimitRecoveryUpdate.Type;
