/**
 * What Settings shows about personal data: every machine that may run work
 * here, what each may read, what it asked for, and the log.
 *
 * @module personalDataStatus
 */
import {
  type EnvironmentId,
  PersonalDataAccessError,
  type PersonalDataSetAccessInput,
  WS_METHODS,
  WsPersonalDataRpcGroup,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import * as WorkGrants from "../fleet/WorkGrants.ts";
import { grantKindOf } from "../fleet/workGrantPolicy.ts";
import { labelsOf } from "../mcp/workGrantAccess.ts";
import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import * as PersonalDataAccess from "./PersonalDataAccess.ts";

/** The machines allowed to run work here now, the owner's own marked. */
const machinesOf = Effect.gen(function* () {
  const grants = yield* WorkGrants.WorkGrants;
  const policies = yield* grants.policies.pipe(Effect.orElseSucceed(() => []));
  // Unreadable sessions mean no machine is taken for the owner's own.
  const managers = yield* grants.managers.pipe(
    Effect.orElseSucceed((): ReadonlySet<string> => new Set()),
  );
  const labels = yield* labelsOf;
  return policies
    .filter((policy) => policy.revokedAt === null)
    .map((policy) => ({
      environmentId: policy.coordinatorEnvironmentId as EnvironmentId,
      label: labels.get(policy.coordinatorEnvironmentId) ?? "Another machine",
      ownMachine: policy.legacy || grantKindOf(policy, managers) === "own",
    }));
});

export const personalDataStatus = Effect.gen(function* () {
  const access = yield* PersonalDataAccess.PersonalDataAccess;
  return yield* access.status(yield* machinesOf);
});

/** The owner's change, then the new status. A machine that holds nothing here cannot be given a source. */
export const setPersonalDataAccess = Effect.fn("personalData.setAccess")(function* (
  input: PersonalDataSetAccessInput,
) {
  const access = yield* PersonalDataAccess.PersonalDataAccess;
  const machines = yield* machinesOf;
  const machine = machines.find((entry) => entry.environmentId === input.environmentId);
  if (machine === undefined && input.change === "allow") {
    return yield* new PersonalDataAccessError({ reason: "unknown_machine" });
  }
  yield* access.set(input, machine?.label ?? "Another machine");
  return yield* access.status(machines);
});

/**
 * The `personalData.*` handlers, registered apart from the rest of the
 * WebSocket API (see `WsPersonalDataRpcGroup`).
 */
export const layerRpcHandlers = WsPersonalDataRpcGroup.middleware(RpcInstrumentation).toLayer(
  Effect.succeed({
    [WS_METHODS.personalDataStatus]: () => personalDataStatus,
    [WS_METHODS.personalDataSetAccess]: (input: PersonalDataSetAccessInput) =>
      setPersonalDataAccess(input),
  }),
);
