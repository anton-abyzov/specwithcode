import { createEnvironmentRpcCommand } from "@specweave-studio/client-runtime/state/runtime";
import { WS_METHODS } from "@specweave-studio/contracts";
import { connectionAtomRuntime } from "../connection/runtime";

export const machineHandoff = {
  copyScopes: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "machine-handoff:copy-scopes",
    tag: WS_METHODS.machineHandoffCopyScopes,
  }),
  copyCapabilities: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "machine-handoff:copy-capabilities",
    tag: WS_METHODS.machineHandoffCopyCapabilities,
  }),
  prepare: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "machine-handoff:prepare",
    tag: WS_METHODS.machineHandoffPrepare,
  }),
  receive: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "machine-handoff:receive",
    tag: WS_METHODS.machineHandoffReceive,
  }),
  copyOffer: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "machine-handoff:copy-offer",
    tag: WS_METHODS.machineHandoffCopyOffer,
  }),
  copySourceStatus: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "machine-handoff:copy-source-status",
    tag: WS_METHODS.machineHandoffCopySourceStatus,
  }),
  copySourceCancel: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "machine-handoff:copy-source-cancel",
    tag: WS_METHODS.machineHandoffCopySourceCancel,
  }),
  copyDrift: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "machine-handoff:copy-drift",
    tag: WS_METHODS.machineHandoffCopyDrift,
  }),
  copyRelease: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "machine-handoff:copy-release",
    tag: WS_METHODS.machineHandoffCopyRelease,
  }),
  copyStart: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "machine-handoff:copy-start",
    tag: WS_METHODS.machineHandoffCopyStart,
  }),
  copyStatus: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "machine-handoff:copy-status",
    tag: WS_METHODS.machineHandoffCopyStatus,
  }),
  copyDecide: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "machine-handoff:copy-decide",
    tag: WS_METHODS.machineHandoffCopyDecide,
  }),
  copyApprove: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "machine-handoff:copy-approve",
    tag: WS_METHODS.machineHandoffCopyApprove,
  }),
  copyRetry: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "machine-handoff:copy-retry",
    tag: WS_METHODS.machineHandoffCopyRetry,
  }),
  copyCancel: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "machine-handoff:copy-cancel",
    tag: WS_METHODS.machineHandoffCopyCancel,
  }),
  copyUndo: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "machine-handoff:copy-undo",
    tag: WS_METHODS.machineHandoffCopyUndo,
  }),
  copySecrets: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "machine-handoff:copy-secrets",
    tag: WS_METHODS.machineHandoffCopySecrets,
  }),
  sentSecrets: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "machine-handoff:sent-secrets",
    tag: WS_METHODS.machineHandoffSentSecrets,
  }),
  readiness: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "machine-handoff:readiness",
    tag: WS_METHODS.machineHandoffReadiness,
  }),
};
