import { request, subscribe } from "@specweave-studio/client-runtime/rpc";
import { createEnvironmentSubscriptionAtomFamily } from "@specweave-studio/client-runtime/state/runtime";
import {
  type ComputerUseAction,
  type ComputerUseActionResult,
  type ComputerUseHostInput,
  computerUseHostPlatformFor,
  computerUsePermissionFor,
  computerUseUnsupportedPlatformReason,
  WS_METHODS,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { connectionAtomRuntime } from "../connection/runtime";
import {
  beginComputerUsePermissionWait,
  endComputerUsePermissionWait,
} from "./computerUsePermissionWait";

/**
 * Runs one action. When it needs a permission the app does not have yet, the
 * asking thread shows the permission card while the action waits for it.
 */
async function runWithPermissionCard(
  action: ComputerUseAction,
  threadId: string | undefined,
): Promise<ComputerUseActionResult> {
  const bridge = window.desktopBridge;
  if (bridge?.runComputerUseAction === undefined) {
    throw new Error(
      computerUseUnsupportedPlatformReason(
        computerUseHostPlatformFor(bridge?.getClientPlatform?.()),
      ),
    );
  }
  const required = computerUsePermissionFor(action.kind);
  let token: symbol | undefined;
  if (required !== undefined && threadId !== undefined && bridge.getComputerUsePermissions) {
    const permissions = await bridge.getComputerUsePermissions().catch(() => undefined);
    const granted =
      required === "screen-recording" ? permissions?.screenRecording : permissions?.accessibility;
    if (permissions !== undefined && !granted) {
      token = beginComputerUsePermissionWait(threadId, required);
    }
  }
  try {
    return await bridge.runComputerUseAction(action);
  } finally {
    if (token !== undefined && threadId !== undefined) {
      endComputerUsePermissionWait(threadId, token);
    }
  }
}

/** The bridge's rejection, without Electron's "Error invoking remote method" wrapper. */
export function computerUseErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, "").trim();
  return message.slice(0, 2_000) || "The action failed.";
}

/**
 * This desktop window answering agents' `computer_*` actions for its own
 * machine's server. Mounting the atom offers the window as a host; each
 * request runs in the app's main process, which holds the macOS permissions.
 */
export const computerUseHost = createEnvironmentSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:computer-use:host",
  idleTtlMs: 0,
  subscribe: (input: ComputerUseHostInput) =>
    Stream.suspend(() => {
      let hostId: string | undefined;
      return subscribe(WS_METHODS.computerUseHost, input).pipe(
        Stream.mapEffect((event) => {
          if (event.type === "connected") {
            hostId = event.hostId;
            return Effect.succeed(0);
          }
          const { requestId, action, threadId } = event.request;
          const respondingHost = hostId;
          if (respondingHost === undefined) return Effect.succeed(0);
          return Effect.promise(() =>
            runWithPermissionCard(action, threadId).then(
              (result) => ({ result }),
              (error: unknown) => ({ error: computerUseErrorMessage(error) }),
            ),
          ).pipe(
            Effect.flatMap((outcome) =>
              request(WS_METHODS.computerUseRespond, {
                hostId: respondingHost,
                requestId,
                ...outcome,
              }),
            ),
            Effect.ignore,
            Effect.as(1),
          );
        }),
      );
    }),
});
