import { WS_METHODS } from "@specweave-studio/contracts";
import type * as Crypto from "effect/Crypto";
import type { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/** Reads never enroll. Every mutation is separately scoped to the selected destination. */
export function createManagedUpdateAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  return {
    status: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "managed-updates:status",
      tag: WS_METHODS.managedUpdatesStatus,
      staleTimeMs: 0,
      idleTtlMs: 30_000,
    }),
    enroll: createEnvironmentRpcCommand(runtime, {
      label: "managed-updates:enroll",
      tag: WS_METHODS.managedUpdatesEnroll,
    }),
    revoke: createEnvironmentRpcCommand(runtime, {
      label: "managed-updates:revoke",
      tag: WS_METHODS.managedUpdatesRevoke,
    }),
    check: createEnvironmentRpcCommand(runtime, {
      label: "managed-updates:check",
      tag: WS_METHODS.managedUpdatesCheck,
    }),
  };
}
