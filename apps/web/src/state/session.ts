import { useAtomValue } from "@effect/atom-react";
import { createEnvironmentSessionAtoms } from "@specweave-studio/client-runtime/state/session";
import {
  type AuthEnvironmentScope,
  type AuthSessionState,
  type EnvironmentId,
  sessionGrantsScope,
} from "@specweave-studio/contracts";
import { useMemo } from "react";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

export const environmentSession = createEnvironmentSessionAtoms(connectionAtomRuntime);

const EMPTY_SESSION_STATE_ATOM = Atom.make(AsyncResult.initial<AuthSessionState>());

/** Uses the selected environment's grant, including cached scopes during a refresh. */
export function useEnvironmentScope(
  environmentId: EnvironmentId | null,
  scope: AuthEnvironmentScope,
): boolean {
  const result = useAtomValue(
    environmentId === null
      ? EMPTY_SESSION_STATE_ATOM
      : environmentSession.sessionStateAtom(environmentId),
  );
  return sessionHasScope(result, scope);
}

/**
 * Whether this browser may use a scope on an environment, telling a missing
 * grant apart from a session that is signed out or not loaded, so the UI does
 * not report a permission problem when the real problem is the sign-in.
 */
export type EnvironmentScopeAccess = "granted" | "denied" | "signed-out" | "unknown";

/** The parts of an environment's connection that decide whether its cached grant is current. */
export interface ScopeAccessConnection {
  readonly phase: string;
  readonly blockedReason?: string;
}

/**
 * The session is fetched only while the connection is up, so a disconnected
 * environment keeps its last answer. Report that answer only while connected.
 */
export function environmentScopeAccess(
  result: AsyncResult.AsyncResult<AuthSessionState, unknown>,
  scope: AuthEnvironmentScope,
  connection?: ScopeAccessConnection | null,
): EnvironmentScopeAccess {
  if (connection?.blockedReason === "authentication") return "signed-out";
  if (connection && connection.phase !== "connected") return "unknown";
  // A failed re-check keeps the last grant the host confirmed.
  const session = Option.getOrNull(AsyncResult.value(result));
  if (session === null) return "unknown";
  if (!session.authenticated) return "signed-out";
  return sessionGrantsScope(session, scope) ? "granted" : "denied";
}

export function useEnvironmentScopeAccess(
  environmentId: EnvironmentId | null,
  scope: AuthEnvironmentScope,
  connection?: ScopeAccessConnection | null,
): EnvironmentScopeAccess {
  const result = useAtomValue(
    environmentId === null
      ? EMPTY_SESSION_STATE_ATOM
      : environmentSession.sessionStateAtom(environmentId),
  );
  return environmentScopeAccess(result, scope, connection);
}

export function readEnvironmentScopeAccess(
  environmentId: EnvironmentId,
  scope: AuthEnvironmentScope,
  connection?: ScopeAccessConnection | null,
): EnvironmentScopeAccess {
  return environmentScopeAccess(
    appAtomRegistry.get(environmentSession.sessionStateAtom(environmentId)),
    scope,
    connection,
  );
}

/** Why a provider update cannot start from this browser, or null when it can. */
export function providerManageBlockedText(access: EnvironmentScopeAccess): string | null {
  switch (access) {
    case "granted":
      return null;
    case "denied":
      return "This connection cannot manage provider accounts.";
    case "signed-out":
      return "This browser is signed out of this host. Reload the page to sign in again.";
    case "unknown":
      return "Waiting to confirm this browser's access to the host.";
  }
}

/**
 * A failed re-check (a slow host, a dropped relay hop) keeps the last grant the
 * host confirmed, so one timeout does not turn every view read-only. The host
 * still enforces every scope on each request.
 */
function sessionHasScope(
  result: AsyncResult.AsyncResult<AuthSessionState, unknown>,
  scope: AuthEnvironmentScope,
): boolean {
  const session = Option.getOrNull(AsyncResult.value(result));
  return session !== null && sessionGrantsScope(session, scope);
}

/** Whether new browsers can sign in to this environment with a token or an approved code. */
export function useEnvironmentAcceptsBrowserSignIn(environmentId: EnvironmentId | null): boolean {
  const result = useAtomValue(
    environmentId === null
      ? EMPTY_SESSION_STATE_ATOM
      : environmentSession.sessionStateAtom(environmentId),
  );
  const session = Option.getOrNull(AsyncResult.value(result));
  return session?.auth.bootstrapMethods.includes("one-time-token") === true;
}

/** Subscribe to the grants of every selected environment. */
export function useEnvironmentsWithScope(
  environments: ReadonlyArray<{ readonly environmentId: EnvironmentId }>,
  scope: AuthEnvironmentScope,
): ReadonlySet<EnvironmentId> {
  const permitted = useMemo(
    () =>
      Atom.make((get) => {
        const ids = new Set<EnvironmentId>();
        for (const { environmentId } of environments) {
          const result = get(environmentSession.sessionStateAtom(environmentId));
          if (sessionHasScope(result, scope)) {
            ids.add(environmentId);
          }
        }
        return ids;
      }),
    [environments, scope],
  );
  return useAtomValue(permitted);
}

export function readEnvironmentScope(
  environmentId: EnvironmentId,
  scope: AuthEnvironmentScope,
): boolean {
  return sessionHasScope(
    appAtomRegistry.get(environmentSession.sessionStateAtom(environmentId)),
    scope,
  );
}

/**
 * Like readEnvironmentScope, but loads the grant first when no view holds it.
 * The session record is dropped after five idle minutes, so a dialog opened
 * later would otherwise read an empty record and report a missing permission.
 */
export function awaitEnvironmentScope(
  environmentId: EnvironmentId,
  scope: AuthEnvironmentScope,
): Promise<boolean> {
  const atom = environmentSession.sessionStateAtom(environmentId);
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* AtomRegistry.mount(appAtomRegistry, atom);
        const session = yield* AtomRegistry.getResult(appAtomRegistry, atom, {
          suspendOnWaiting: false,
        }).pipe(
          Effect.timeoutOption(6_000),
          Effect.catchCause(() => Effect.succeed(Option.none<AuthSessionState>())),
          // A failed re-check falls back to the last grant the host confirmed.
          Effect.map((fresh) =>
            Option.orElse(fresh, () => AsyncResult.value(appAtomRegistry.get(atom))),
          ),
        );
        return Option.isSome(session) && sessionGrantsScope(session.value, scope);
      }),
    ),
  );
}

const EMPTY_PREPARED_CONNECTION_ATOM = Atom.make(Option.none()).pipe(
  Atom.withLabel("web-prepared-connection:empty"),
);

export function usePreparedConnection(environmentId: EnvironmentId | null) {
  return useAtomValue(
    environmentId === null
      ? EMPTY_PREPARED_CONNECTION_ATOM
      : environmentSession.preparedConnectionValueAtom(environmentId),
  );
}

export function readPreparedConnection(environmentId: EnvironmentId) {
  return Option.getOrNull(
    appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
  );
}

/**
 * This client's authenticated session on one environment, as reported by that
 * environment's `/api/auth/session` endpoint. `data` stays populated across
 * SWR revalidations; `isPending` is only meaningful before the first resolve.
 */
export function useEnvironmentSessionState(environmentId: EnvironmentId) {
  const result = useAtomValue(environmentSession.sessionStateAtom(environmentId));
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    hasError: result._tag === "Failure",
    isPending: result.waiting,
  };
}
