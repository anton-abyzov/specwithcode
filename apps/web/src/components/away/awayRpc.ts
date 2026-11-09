import {
  createEnvironmentRpcCommand,
  runAtomCommand,
  type AtomCommand,
} from "@specweave-studio/client-runtime/state/runtime";
import { WS_METHODS, type EnvironmentId } from "@specweave-studio/contracts";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { handoffModeFailureText, type HandoffModeOutcome } from "../../studio/handoffMode";

/** Away mode RPCs on one machine's server. */
export const awayRpc = {
  preflight: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "away:preflight",
    tag: WS_METHODS.awayPreflight,
  }),
  requestAccess: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "away:request-access",
    tag: WS_METHODS.awayRequestAccess,
  }),
  accessStatus: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "away:access-status",
    tag: WS_METHODS.awayAccessStatus,
  }),
  accessRequests: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "away:access-requests",
    tag: WS_METHODS.awayAccessRequests,
  }),
  decideAccess: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "away:decide-access",
    tag: WS_METHODS.awayDecideAccess,
  }),
  start: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "away:start",
    tag: WS_METHODS.awayStart,
  }),
  bringBack: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "away:bring-back",
    tag: WS_METHODS.awayBringBack,
  }),
  snapshot: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "away:snapshot",
    tag: WS_METHODS.awaySnapshot,
  }),
  updateConfig: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "away:update-config",
    tag: WS_METHODS.awayUpdateConfig,
  }),
};

/** Runs one Away RPC outside React and words a failure for the user. */
export async function runAway<W extends { environmentId: EnvironmentId }, A, E>(
  rpc: AtomCommand<W, A, E>,
  value: W,
): Promise<HandoffModeOutcome<A>> {
  const result = await runAtomCommand(appAtomRegistry, rpc, value, {
    label: rpc.label,
    reportFailure: false,
    reportDefect: false,
  });
  return result._tag === "Success"
    ? { ok: true, value: result.value }
    : { ok: false, error: handoffModeFailureText(result) };
}
