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
import {
  FolderCopyCancelInput,
  FolderCopyDecideInput,
  FolderCopyError,
  FolderCopyOffer,
  FolderCopyOfferInput,
  FolderCopyOperationInput,
  FolderCopyReleaseInput,
  FolderCopyReleaseResult,
  FolderCopySourceStatus,
  FolderCopyStartInput,
  FolderCopyStatus,
  FolderCopyUndoInput,
  FolderCopyUndoResult,
} from "./folderCopy.ts";
export const MACHINE_HANDOFF_RPC_METHODS = {
  machineHandoffPrepare: "machineHandoff.prepare",
  machineHandoffReceive: "machineHandoff.receive",
  machineHandoffCopyOffer: "machineHandoff.copyOffer",
  machineHandoffCopySourceStatus: "machineHandoff.copySourceStatus",
  machineHandoffCopySourceCancel: "machineHandoff.copySourceCancel",
  machineHandoffCopyRelease: "machineHandoff.copyRelease",
  machineHandoffCopyStart: "machineHandoff.copyStart",
  machineHandoffCopyStatus: "machineHandoff.copyStatus",
  machineHandoffCopyDecide: "machineHandoff.copyDecide",
  machineHandoffCopyApprove: "machineHandoff.copyApprove",
  machineHandoffCopyRetry: "machineHandoff.copyRetry",
  machineHandoffCopyUndo: "machineHandoff.copyUndo",
  machineHandoffCopyCancel: "machineHandoff.copyCancel",
} as const;
const copyError = Schema.Union([FolderCopyError, EnvironmentAuthorizationError]);
const M = MACHINE_HANDOFF_RPC_METHODS;
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

/** Folder copy RPCs, registered as their own group (see `WsFolderCopyRpcGroup`). */
export const folderCopyRpcs = [
  Rpc.make(M.machineHandoffCopyOffer, {
    payload: FolderCopyOfferInput,
    success: FolderCopyOffer,
    error: copyError,
  }),
  Rpc.make(M.machineHandoffCopySourceStatus, {
    payload: FolderCopyOperationInput,
    success: FolderCopySourceStatus,
    error: copyError,
  }),
  Rpc.make(M.machineHandoffCopySourceCancel, {
    payload: FolderCopyCancelInput,
    success: FolderCopySourceStatus,
    error: copyError,
  }),
  Rpc.make(M.machineHandoffCopyRelease, {
    payload: FolderCopyReleaseInput,
    success: FolderCopyReleaseResult,
    error: copyError,
  }),
  Rpc.make(M.machineHandoffCopyStart, {
    payload: FolderCopyStartInput,
    success: FolderCopyStatus,
    error: copyError,
  }),
  Rpc.make(M.machineHandoffCopyStatus, {
    payload: FolderCopyOperationInput,
    success: FolderCopyStatus,
    error: copyError,
  }),
  Rpc.make(M.machineHandoffCopyDecide, {
    payload: FolderCopyDecideInput,
    success: FolderCopyStatus,
    error: copyError,
  }),
  Rpc.make(M.machineHandoffCopyApprove, {
    payload: FolderCopyOperationInput,
    success: FolderCopyStatus,
    error: copyError,
  }),
  Rpc.make(M.machineHandoffCopyRetry, {
    payload: FolderCopyOperationInput,
    success: FolderCopyStatus,
    error: copyError,
  }),
  Rpc.make(M.machineHandoffCopyUndo, {
    payload: FolderCopyUndoInput,
    success: FolderCopyUndoResult,
    error: copyError,
  }),
  Rpc.make(M.machineHandoffCopyCancel, {
    payload: FolderCopyCancelInput,
    success: FolderCopyStatus,
    error: copyError,
  }),
] as const;
