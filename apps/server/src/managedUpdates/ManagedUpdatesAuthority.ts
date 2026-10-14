import {
  AuthAccessWriteScope,
  AuthOrchestrationReadScope,
  AuthEnvironmentMaintainScope,
  ManagedUpdateError,
  type AuthEnvironmentScope,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import type { AuthSessionRecord } from "../persistence/AuthSessions.ts";

export type ManagedUpdateAction = "status" | "enroll" | "revoke" | "check";
export const managedUpdateRequiredScopes = (
  action: ManagedUpdateAction,
): readonly AuthEnvironmentScope[] =>
  action === "enroll" || action === "revoke"
    ? [AuthAccessWriteScope, AuthEnvironmentMaintainScope]
    : action === "status"
      ? [AuthOrchestrationReadScope]
      : [AuthEnvironmentMaintainScope];

/** Only a freshly persisted session is authority. Connection metadata is never a grant. */
export function authorizeManagedUpdate(
  connected: Pick<AuthenticatedSession, "sessionId" | "subject">,
  action: ManagedUpdateAction,
  persisted: AuthSessionRecord | null,
  now: number,
): AuthSessionRecord {
  if (
    persisted === null ||
    persisted.sessionId !== connected.sessionId ||
    persisted.subject !== connected.subject ||
    persisted.revokedAt !== null ||
    DateTime.toEpochMillis(persisted.expiresAt) <= now ||
    !managedUpdateRequiredScopes(action).every((scope) => persisted.scopes.includes(scope))
  )
    throw new ManagedUpdateError({ code: "unauthorized" });
  return persisted;
}

export function freshManagedUpdateAuthority<E>(
  connected: Pick<AuthenticatedSession, "sessionId" | "subject">,
  action: ManagedUpdateAction,
  readSession: () => Effect.Effect<Option.Option<AuthSessionRecord>, E>,
) {
  return Effect.gen(function* () {
    const persisted = yield* readSession().pipe(
      Effect.mapError(() => new ManagedUpdateError({ code: "unavailable" })),
    );
    const now = yield* DateTime.now;
    return yield* Effect.try({
      try: () =>
        authorizeManagedUpdate(
          connected,
          action,
          Option.getOrNull(persisted),
          DateTime.toEpochMillis(now),
        ),
      catch: () => new ManagedUpdateError({ code: "unauthorized" }),
    });
  });
}
