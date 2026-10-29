import {
  COORDINATOR_SUSPEND_PATH,
  DESKTOP_HANDOFF_MACHINE_ACTION,
  DESKTOP_HANDOFF_SLEEP_ACTION,
} from "@specweave-studio/contracts";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import type * as ElectronPowerMonitor from "../electron/ElectronPowerMonitor.ts";

/** Asks the renderer to hand this Mac's running threads to the sleep target. */
export const HANDOFF_SLEEP_ACTION = DESKTOP_HANDOFF_SLEEP_ACTION;
/** Opens "Move running threads" in the main window. */
export const HANDOFF_MACHINE_ACTION = DESKTOP_HANDOFF_MACHINE_ACTION;

/** The Mac may sleep within seconds of 'suspend'; a slower answer is not waited for. */
export const SUSPEND_NOTICE_TIMEOUT = Duration.seconds(5);

/** This Mac's own server and the desktop service credential that reaches it. */
export interface LocalServerTarget {
  readonly httpBaseUrl: URL;
  readonly bearerToken: string;
}

export class DesktopSuspendNoticeError extends Data.TaggedError("DesktopSuspendNoticeError")<{
  readonly reason: string;
}> {}

/**
 * Tells this Mac's server, from the main process, that the Mac is about to
 * sleep: the server then sends its coordinator standbys a sleeping lease, so
 * the sleep never reads as silence to them (AC-11). The token goes only in
 * the Authorization header, never in the URL or a log.
 */
export const notifyServerOfSuspend = Effect.fn("desktop.handoff.notifyServerOfSuspend")(function* <
  E,
>(target: Effect.Effect<LocalServerTarget, E>) {
  const { httpBaseUrl, bearerToken } = yield* target;
  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .execute(
      HttpClientRequest.post(new URL(COORDINATOR_SUSPEND_PATH, httpBaseUrl)).pipe(
        HttpClientRequest.bearerToken(bearerToken),
        HttpClientRequest.bodyJsonUnsafe({}),
      ),
    )
    .pipe(
      Effect.timeout(SUSPEND_NOTICE_TIMEOUT),
      Effect.mapError(
        (cause) =>
          new DesktopSuspendNoticeError({
            reason: cause._tag === "TimeoutError" ? "no answer in time" : "request failed",
          }),
      ),
    );
  if (response.status < 200 || response.status >= 300) {
    return yield* new DesktopSuspendNoticeError({
      reason: `the server answered ${response.status}`,
    });
  }
});

/**
 * On macOS 'suspend': forwards it to the renderer, which holds the
 * authenticated connection to the local server and reads the sleep target
 * there, and, when given, tells the server directly too, so coordinator
 * standbys hear of the sleep even with no window open. Locking the screen is
 * not leaving, so 'lock-screen' is never forwarded. Best effort: the Mac may
 * sleep before either request lands, and one failing never stops the other.
 */
export const registerHandoffSleepNotice = Effect.fn("desktop.handoff.registerSleepNotice")(
  function* <E, E2 = never>(
    powerMonitor: Pick<ElectronPowerMonitor.ElectronPowerMonitor["Service"], "onSimpleEvent">,
    dispatch: (action: string) => Effect.Effect<void, E>,
    notifyServer?: Effect.Effect<void, E2>,
  ): Effect.fn.Return<void, never, Scope.Scope> {
    const context = yield* Effect.context<never>();
    yield* powerMonitor.onSimpleEvent("suspend", () => {
      void Effect.runPromiseWith(context)(
        Effect.all(
          [
            dispatch(HANDOFF_SLEEP_ACTION).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Could not ask the window to hand off threads before sleep", {
                  cause,
                }),
              ),
            ),
            (notifyServer ?? Effect.void).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Could not tell the server this Mac is going to sleep", {
                  cause,
                }),
              ),
            ),
          ],
          { concurrency: "unbounded", discard: true },
        ),
      );
    });
  },
);
