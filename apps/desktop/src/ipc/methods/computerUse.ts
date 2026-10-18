import { ComputerUseAction, ComputerUseActionResult } from "@specweave-studio/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Electron from "electron";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import { runComputerUseAction } from "../../computerUse/MacComputerUse.ts";
import type { MacPermission } from "../../permissions/MacPermission.ts";
import * as MacPermissions from "../../permissions/MacPermissions.ts";
import { RUN_COMPUTER_USE_ACTION_CHANNEL } from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

class ComputerUseRunFailed extends Data.TaggedError("ComputerUseRunFailed")<{
  readonly reason: string;
}> {}

/** Results cross IPC as values so the renderer sees the agent-facing message, never an Effect failure. */
const ComputerUseIpcResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), result: ComputerUseActionResult }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
]);

/**
 * Runs agents' computer-use actions in the app's main process: macOS grants
 * Screen Recording and Accessibility to the app, so its child processes may
 * capture the screen and post input where the background service may not.
 */
export const installComputerUse = Effect.fn("desktop.ipc.installComputerUse")(function* () {
  // The preload exposes the bridge on macOS only; other platforms have no runner yet.
  if ((yield* DesktopEnvironment.DesktopEnvironment).platform !== "darwin") return;
  const ipc = yield* DesktopIpc.DesktopIpc;
  const permissions = yield* MacPermissions.MacPermissions;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  // The drag-to-allow helper sits next to System Settings while the action waits.
  const showHelper = (permission: MacPermission) =>
    void runPromise(
      permissions.showHelper(permission, null, () =>
        permission === "accessibility"
          ? Electron.systemPreferences.isTrustedAccessibilityClient(false)
          : Electron.systemPreferences.getMediaAccessStatus("screen") === "granted",
      ),
    );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: RUN_COMPUTER_USE_ACTION_CHANNEL,
      payload: ComputerUseAction,
      result: ComputerUseIpcResult,
      handler: (action) =>
        Effect.tryPromise({
          try: () => runComputerUseAction(action, showHelper),
          catch: (error) =>
            new ComputerUseRunFailed({
              reason: error instanceof Error ? error.message : String(error),
            }),
        }).pipe(
          Effect.map((result) => ({ ok: true as const, result })),
          Effect.catch((error) =>
            Effect.gen(function* () {
              const message = error.reason;
              yield* Effect.logWarning("Computer use action failed", {
                kind: action.kind,
                message,
              });
              return { ok: false as const, error: message || "The action failed." };
            }),
          ),
        ),
    }),
  );
});
