import { createClerkClient } from "@clerk/backend";
import { isClerkAPIResponseError } from "@clerk/backend/errors";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as RelayConfiguration from "../Config.ts";

/** Clerk calls must leave room in the relay's 9 s request deadline. */
export const CLERK_SESSION_REQUEST_TIMEOUT = Duration.seconds(3);

export class ClerkSessionLookupFailed extends Schema.TaggedError<ClerkSessionLookupFailed>()(
  "ClerkSessionLookupFailed",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to look up a Clerk session.";
  }
}

/** Clerk Backend API session calls used by phone removal. */
export class ClerkSessions extends Context.Service<
  ClerkSessions,
  {
    /** When the session was created (epoch ms), or null when Clerk has no such session. */
    readonly getCreatedAt: (
      sessionId: string,
    ) => Effect.Effect<number | null, ClerkSessionLookupFailed>;
    /** Ends the session, signing that device out of Clerk. Best effort: failures are logged. */
    readonly revoke: (sessionId: string) => Effect.Effect<void>;
  }
>()("studio-relay/auth/ClerkSessions") {}

export const layer = Layer.effect(
  ClerkSessions,
  Effect.gen(function* () {
    const config = yield* RelayConfiguration.RelayConfiguration;
    const client = () =>
      createClerkClient({
        secretKey: Redacted.value(config.clerkSecretKey),
        publishableKey: config.clerkPublishableKey,
      });
    return ClerkSessions.of({
      getCreatedAt: Effect.fn("relay.clerk_sessions.get_created_at")(function* (sessionId) {
        return yield* Effect.tryPromise({
          try: async () => {
            try {
              return (await client().sessions.getSession(sessionId)).createdAt;
            } catch (error) {
              if (isClerkAPIResponseError(error) && error.status === 404) return null;
              throw error;
            }
          },
          catch: (cause) => new ClerkSessionLookupFailed({ cause }),
        }).pipe(
          Effect.timeoutOrElse({
            duration: CLERK_SESSION_REQUEST_TIMEOUT,
            orElse: () =>
              Effect.fail(new ClerkSessionLookupFailed({ cause: "clerk_session_lookup_timeout" })),
          }),
        );
      }),
      revoke: Effect.fn("relay.clerk_sessions.revoke")(function* (sessionId) {
        yield* Effect.tryPromise(async () => {
          try {
            await client().sessions.revokeSession(sessionId);
          } catch (error) {
            // An ended or unknown session is already signed out.
            if (isClerkAPIResponseError(error) && [400, 404].includes(error.status)) return;
            throw error;
          }
        }).pipe(
          Effect.timeout(CLERK_SESSION_REQUEST_TIMEOUT),
          Effect.catch((error) =>
            Effect.logWarning("Clerk session revocation failed", {
              errorTag: (error as { readonly _tag?: string })._tag ?? "unknown",
            }),
          ),
        );
      }),
    });
  }),
);
