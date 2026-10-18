import { request, subscribe } from "@specweave-studio/client-runtime/rpc";
import { createEnvironmentSubscriptionAtomFamily } from "@specweave-studio/client-runtime/state/runtime";
import { type ComputerUseHostInput, WS_METHODS } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { connectionAtomRuntime } from "../connection/runtime";

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
          const { requestId, action } = event.request;
          const run = window.desktopBridge?.runComputerUseAction;
          const respondingHost = hostId;
          if (respondingHost === undefined) return Effect.succeed(0);
          return Effect.promise(() =>
            run === undefined
              ? Promise.resolve({ error: "This desktop app cannot control the computer." })
              : run(action).then(
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
