import { createEnvironmentRpcCommand } from "@specweave-studio/client-runtime/state/runtime";
import { WS_METHODS } from "@specweave-studio/contracts";
import { connectionAtomRuntime } from "../connection/runtime";

export const machineHandoff = {
  prepare: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "machine-handoff:prepare",
    tag: WS_METHODS.machineHandoffPrepare,
  }),
  receive: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "machine-handoff:receive",
    tag: WS_METHODS.machineHandoffReceive,
  }),
};
