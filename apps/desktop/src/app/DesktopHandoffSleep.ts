import {
  AWAY_WAKE_PATH,
  COORDINATOR_SUSPEND_PATH,
  DESKTOP_AWAY_WAKE_ACTION,
  DESKTOP_HANDOFF_MACHINE_ACTION,
} from "@specweave-studio/contracts";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import type * as ElectronPowerMonitor from "../electron/ElectronPowerMonitor.ts";

/** Opens "Move running threads" in the main window. */
export const HANDOFF_MACHINE_ACTION = DESKTOP_HANDOFF_MACHINE_ACTION;

/** Shows the Away wake card in the main window (Bring back). */
export const AWAY_WAKE_ACTION = DESKTOP_AWAY_WAKE_ACTION;

/** The Mac may sleep within seconds of 'suspend'; a slower answer is not waited for. */
export const SUSPEND_NOTICE_TIMEOUT = Duration.seconds(5);

/** This Mac's own server and the desktop service credential that reaches it. */
export interface LocalServerTarget {
  readonly httpBaseUrl: URL;
  readonly bearerToken: string;
}

export class DesktopSuspendNoticeError extends Data.TaggedError("DesktopSuspendNoticeError")<{
  readonly reason: string;
  /** The request may have reached the server (it timed out). */
  readonly uncertain?: boolean;
}> {}

/** POSTs `body` to this Mac's own server with the desktop credential; the JSON answer. */
const postLocal = <E>(
  target: Effect.Effect<LocalServerTarget, E>,
  path: string,
  body: unknown,
  timeout: Duration.Input,
) =>
  Effect.gen(function* () {
    const { httpBaseUrl, bearerToken } = yield* target;
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(
        HttpClientRequest.post(new URL(path, httpBaseUrl)).pipe(
          HttpClientRequest.bearerToken(bearerToken),
          HttpClientRequest.bodyJsonUnsafe(body),
        ),
      )
      .pipe(
        Effect.flatMap((answer) =>
          answer.json.pipe(
            Effect.orElseSucceed(() => null),
            Effect.map((json) => ({ status: answer.status, json })),
          ),
        ),
        Effect.timeout(timeout),
        Effect.mapError((cause) =>
          cause._tag === "TimeoutError"
            ? new DesktopSuspendNoticeError({ reason: "no answer in time", uncertain: true })
            : new DesktopSuspendNoticeError({ reason: "request failed" }),
        ),
      );
    if (response.status < 200 || response.status >= 300) {
      return yield* new DesktopSuspendNoticeError({
        reason: `the server answered ${response.status}`,
      });
    }
    return response.json;
  });

const outcomeOf = (json: unknown): unknown =>
  typeof json === "object" && json !== null && "outcome" in json
    ? (json as { outcome: unknown }).outcome
    : undefined;

/**
 * Tells this Mac's server it woke or was unlocked. True when work moved while
 * it slept and the wake card should show (`prompt`, or `auto` with bringing
 * back already started).
 */
export const notifyServerOfAwayWake = Effect.fn("desktop.away.notifyServerOfWake")(function* <E>(
  target: Effect.Effect<LocalServerTarget, E>,
  onBattery: boolean,
) {
  // Waking leaves time: the server may wait on the target's answer to the cancel.
  const json = yield* postLocal(target, AWAY_WAKE_PATH, { onBattery }, Duration.seconds(10));
  const outcome = outcomeOf(json);
  return outcome === "prompt" || outcome === "auto";
});

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
 * On 'suspend': tells this Mac's server, so coordinator standbys hear of the
 * sleep even with no window open. That is a notice, and all a sleep does:
 * no window and no server is asked to move threads (1390 AC-36). Locking the
 * screen is not sleeping, so 'lock-screen' sends nothing. Best effort: the Mac
 * may sleep before the request lands.
 */
export const registerHandoffSleepNotice = Effect.fn("desktop.handoff.registerSleepNotice")(
  function* <E>(
    powerMonitor: Pick<ElectronPowerMonitor.ElectronPowerMonitor["Service"], "onSimpleEvent">,
    notifyServer: Effect.Effect<void, E>,
  ): Effect.fn.Return<void, never, Scope.Scope> {
    const context = yield* Effect.context<never>();
    yield* powerMonitor.onSimpleEvent("suspend", () => {
      void Effect.runPromiseWith(context)(
        notifyServer.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not tell the server this Mac is going to sleep", { cause }),
          ),
        ),
      );
    });
  },
);

/**
 * On 'resume' and 'unlock-screen': tells this Mac's server it is back. The
 * server settles a lid close an earlier release sent; when work did move, the
 * main window shows the wake card. Runs in the main process, so
 * it works with no window open; the card shows when one opens.
 */
export const registerAwayWakeNotice = Effect.fn("desktop.away.registerWakeNotice")(function* <
  E,
  E2,
>(
  powerMonitor: Pick<ElectronPowerMonitor.ElectronPowerMonitor["Service"], "onSimpleEvent">,
  dispatch: (action: string) => Effect.Effect<void, E>,
  wake: Effect.Effect<boolean, E2>,
): Effect.fn.Return<void, never, Scope.Scope> {
  const context = yield* Effect.context<never>();
  const onWake = () => {
    void Effect.runPromiseWith(context)(
      wake.pipe(
        Effect.flatMap((prompt) => (prompt ? dispatch(AWAY_WAKE_ACTION) : Effect.void)),
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not tell the server this Mac is back", { cause }),
        ),
      ),
    );
  };
  yield* powerMonitor.onSimpleEvent("resume", onWake);
  yield* powerMonitor.onSimpleEvent("unlock-screen", onWake);
});
