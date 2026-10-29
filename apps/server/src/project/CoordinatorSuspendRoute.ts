/**
 * `POST /api/coordinator/v1/suspend`: the desktop app's main process says the
 * Mac is about to sleep. The server sends every armed standby a lease marked
 * `sleeping`, so a planned sleep never starts a standby's takeover clock as
 * silence would (AC-11). The renderer path cannot be relied on here: the
 * window may be closed or asleep before its request lands.
 *
 * Only this machine's own bearer may call it: the desktop service credential
 * holds access:write. A cookie (a browser tab) or another machine's
 * coordinator session is refused.
 */
import {
  AuthAccessWriteScope,
  COORDINATOR_SUSPEND_PATH,
  type AuthPrincipal,
  type ServerAuthSessionMethod,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { CoordinatorLease } from "./CoordinatorLease.ts";

/** Whether a session is this machine's own desktop credential, allowed to announce a sleep. */
export function maySuspend(session: {
  readonly method: ServerAuthSessionMethod;
  readonly scopes: ReadonlyArray<string>;
  readonly principal?: AuthPrincipal | undefined;
}): boolean {
  return (
    session.method === "bearer-access-token" &&
    session.scopes.includes(AuthAccessWriteScope) &&
    session.principal?.kind !== "coordinator"
  );
}

export type SuspendOutcome =
  | { readonly status: 200; readonly body: { readonly answered: number } }
  | { readonly status: 401 | 403; readonly body: { readonly error: string } };

/**
 * The route's decision, apart from HTTP: who may call it, and the sleeping
 * lease sent to every standby. Never fails: a standby that does not answer
 * counts as not answered.
 */
export const suspend = (input: {
  readonly session: Option.Option<Parameters<typeof maySuspend>[0]>;
  readonly lease: Pick<CoordinatorLease["Service"], "pause">;
}): Effect.Effect<SuspendOutcome> =>
  Effect.gen(function* () {
    if (Option.isNone(input.session)) return { status: 401, body: { error: "unauthorized" } };
    if (!maySuspend(input.session.value)) return { status: 403, body: { error: "forbidden" } };
    const answered = yield* input.lease.pause({ sleeping: true });
    return { status: 200, body: { answered } };
  });

export const layer = HttpRouter.add(
  "POST",
  COORDINATOR_SUSPEND_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* auth.authenticateHttpRequest(request).pipe(Effect.option);
    const lease = yield* CoordinatorLease;
    const outcome = yield* suspend({ session, lease });
    return HttpServerResponse.jsonUnsafe(outcome.body, {
      status: outcome.status,
      headers: { "cache-control": "no-store" },
    });
  }),
);
