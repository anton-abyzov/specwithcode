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
  FolderCopyCapabilities,
  FolderCopyScopes,
  FolderCopyScopesInput,
  FolderCopyDecideInput,
  FolderCopyError,
  FolderCopyOffer,
  FolderCopyOfferInput,
  FolderCopyOperationInput,
  FolderCopyReleaseInput,
  FolderCopyReleaseResult,
  FolderCopySecretsInput,
  FolderCopySentSecrets,
  FolderCopySentSecretsInput,
  FolderCopySourceStatus,
  FolderCopySourceStatusInput,
  FolderCopyStartInput,
  FolderCopyStatus,
  FolderCopyUndoInput,
  FolderCopyUndoResult,
} from "./folderCopy.ts";
import { MachineReadiness, MachineReadinessInput } from "./machineReadiness.ts";
export const MACHINE_HANDOFF_RPC_METHODS = {
  machineHandoffCopyScopes: "machineHandoff.copyScopes",
  machineHandoffCopyCapabilities: "machineHandoff.copyCapabilities",
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
  machineHandoffCopySecrets: "machineHandoff.copySecrets",
  machineHandoffSentSecrets: "machineHandoff.sentSecrets",
  machineHandoffReadiness: "machineHandoff.readiness",
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
  Rpc.make(M.machineHandoffCopyScopes, {
    payload: FolderCopyScopesInput,
    success: FolderCopyScopes,
    error: copyError,
  }),
  Rpc.make(M.machineHandoffCopyCapabilities, {
    payload: Schema.Struct({}),
    success: FolderCopyCapabilities,
    error: copyError,
  }),
  Rpc.make(M.machineHandoffCopyOffer, {
    payload: FolderCopyOfferInput,
    success: FolderCopyOffer,
    error: copyError,
  }),
  Rpc.make(M.machineHandoffCopySourceStatus, {
    payload: FolderCopySourceStatusInput,
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
  Rpc.make(M.machineHandoffCopySecrets, {
    payload: FolderCopySecretsInput,
    success: FolderCopySourceStatus,
    error: copyError,
  }),
  Rpc.make(M.machineHandoffSentSecrets, {
    payload: FolderCopySentSecretsInput,
    success: FolderCopySentSecrets,
    error: copyError,
  }),
  Rpc.make(M.machineHandoffReadiness, {
    payload: MachineReadinessInput,
    success: MachineReadiness,
    error: copyError,
  }),
] as const;
