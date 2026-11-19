import { createEnvironmentRpcCommand } from "@specweave-studio/client-runtime/state/runtime";
import { WS_METHODS } from "@specweave-studio/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import type { EnvironmentScopeAccess } from "../state/session";

/** The hand off batch's window calls (1390). The server authorizes each again. */
export const handoffBatch = {
  start: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "handoff-batch:start",
    tag: WS_METHODS.handoffBatchStart,
  }),
  read: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "handoff-batch:read",
    tag: WS_METHODS.handoffBatchRead,
  }),
};

export interface HandoffBatchGate {
  /** The window may read an open batch on that machine. */
  readonly canRead: boolean;
  /** The window may start a batch there. */
  readonly canStart: boolean;
  /** Shown under the greyed check and "Hand off"; null when nothing is greyed. */
  readonly blocked: {
    readonly text: string;
    readonly values: { readonly machine: string };
  } | null;
}

/**
 * What a window may do with a batch on the machine work leaves. A window that
 * holds only read scopes there can open the dialog and read an open batch,
 * with "Hand off" greyed under one line. `operate` and `read` are the window's
 * access for the scopes of `handoffBatch.start` and `handoffBatch.read`.
 */
export function handoffBatchGate(input: {
  readonly machine: string;
  readonly operate: EnvironmentScopeAccess | undefined;
  readonly read: EnvironmentScopeAccess | undefined;
}): HandoffBatchGate {
  const canStart = input.operate === "granted";
  return {
    canRead: input.read === "granted",
    canStart,
    blocked: canStart
      ? null
      : { text: "This window can only read {machine}", values: { machine: input.machine } },
  };
}
