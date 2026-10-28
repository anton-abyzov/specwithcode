import {
  DESKTOP_HANDOFF_MACHINE_ACTION,
  DESKTOP_HANDOFF_SLEEP_ACTION,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import type * as ElectronPowerMonitor from "../electron/ElectronPowerMonitor.ts";

/** Asks the renderer to hand this Mac's running threads to the sleep target. */
export const HANDOFF_SLEEP_ACTION = DESKTOP_HANDOFF_SLEEP_ACTION;
/** Opens "Move running threads" in the main window. */
export const HANDOFF_MACHINE_ACTION = DESKTOP_HANDOFF_MACHINE_ACTION;

/**
 * Forwards macOS 'suspend' to the renderer, which holds the authenticated
 * connection to the local server and reads the sleep target there. Locking
 * the screen is not leaving, so 'lock-screen' is never forwarded. Best effort:
 * the Mac may sleep before the request lands.
 */
export const registerHandoffSleepNotice = Effect.fn("desktop.handoff.registerSleepNotice")(
  function* <E>(
    powerMonitor: Pick<ElectronPowerMonitor.ElectronPowerMonitor["Service"], "onSimpleEvent">,
    dispatch: (action: string) => Effect.Effect<void, E>,
  ): Effect.fn.Return<void, never, Scope.Scope> {
    const context = yield* Effect.context<never>();
    yield* powerMonitor.onSimpleEvent("suspend", () => {
      void Effect.runPromiseWith(context)(
        dispatch(HANDOFF_SLEEP_ACTION).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not ask the window to hand off threads before sleep", {
              cause,
            }),
          ),
        ),
      );
    });
  },
);
