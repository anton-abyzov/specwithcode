import { createEnvironmentRpcCommand } from "@specweave-studio/client-runtime/state/runtime";
import { WS_METHODS } from "@specweave-studio/contracts";
import { connectionAtomRuntime } from "../connection/runtime";

/** Why each machine target can or can't take a limited thread now. */
export const limitHandoff = {
  candidates: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "limit-handoff:candidates",
    tag: WS_METHODS.limitHandoffCandidates,
  }),
};
