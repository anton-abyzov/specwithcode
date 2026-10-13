import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";
import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  MachineHandoffError,
  MachineHandoffPrepareInput,
  MachineHandoffPrepareResult,
  MachineHandoffReceiveInput,
  MachineHandoffReceiveResult,
} from "./machineHandoff.ts";
export const MACHINE_HANDOFF_RPC_METHODS = {
  machineHandoffPrepare: "machineHandoff.prepare",
  machineHandoffReceive: "machineHandoff.receive",
} as const;
const error = Schema.Union([MachineHandoffError, EnvironmentAuthorizationError]);
export const machineHandoffRpcs = [
  Rpc.make(MACHINE_HANDOFF_RPC_METHODS.machineHandoffPrepare, {
    payload: MachineHandoffPrepareInput,
    success: MachineHandoffPrepareResult,
    error,
  }),
  Rpc.make(MACHINE_HANDOFF_RPC_METHODS.machineHandoffReceive, {
    payload: MachineHandoffReceiveInput,
    success: MachineHandoffReceiveResult,
    error,
  }),
] as const;
