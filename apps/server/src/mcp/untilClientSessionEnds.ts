import { AuthSessionId, OrchestratorMcpFailure } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

export const SESSION_ENDED_MESSAGE =
  "This client's sign-in was revoked here, so the wait ended. Sign in again to keep following threads.";

/**
 * Runs a long call (a wait of up to an hour) only while the outside client's
 * session lasts: a revoke, including another machine's grant being revoked,
 * ends it at once with an error, as /mcp refuses that client's next request.
 * A thread caller, or a server without auth (tests), runs it unchanged.
 */
export const untilClientSessionEnds = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | OrchestratorMcpFailure, R | McpInvocationContext.McpInvocationContext> =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const auth = yield* Effect.serviceOption(EnvironmentAuth.EnvironmentAuth);
    const client = scope.thread === undefined ? scope.client : undefined;
    if (client === undefined || Option.isNone(auth)) return yield* effect;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const ended = yield* auth.value.watchSessionEnd({
          sessionId: AuthSessionId.make(client.sessionId),
          // An MCP client's token expiry is not an end; only a revoke is.
          method: "bearer-access-token",
        });
        return yield* Effect.raceFirst(
          effect,
          ended.pipe(
            Effect.andThen(
              Effect.fail(
                new OrchestratorMcpFailure({
                  code: "capability_denied",
                  message: SESSION_ENDED_MESSAGE,
                }),
              ),
            ),
          ),
        );
      }),
    );
  });
