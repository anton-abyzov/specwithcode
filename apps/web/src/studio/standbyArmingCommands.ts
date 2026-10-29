import { ManagedRelay } from "@specweave-studio/client-runtime/relay";
import type { PreparedConnection } from "@specweave-studio/client-runtime/connection";
import { executeAtomQuery } from "@specweave-studio/client-runtime/state/runtime";
import {
  environmentEndpointUrl,
  executeAuthenticatedEnvironmentHttpRequest,
  RemoteEnvironmentAuthorization,
} from "@specweave-studio/client-runtime/studio";
import {
  AuthAccessWriteScope,
  AuthSessionId,
  AuthStandardClientScopes,
  type EnvironmentId,
} from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { type AsyncResult, type Atom } from "effect/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "../state/presentation";
import { readEnvironmentScope, readPreparedConnection } from "../state/session";
import { addStudioFleetMachine, changeMachineWorkGrant, inviteStudioFleetMachine } from "./fleet";
import { requestFleet, requestFleetWorkersAllow, requestWorkGrants } from "./fleetRequest";
import type { StandbyArmingCommands } from "./standbyArming";

/** The live calls behind standby arming, made from the owner's app to each machine. */

/** Every scope an invitation hands out: arming needs all of them on every machine. */
export function hasFullAccess(environmentId: EnvironmentId): boolean {
  return [...AuthStandardClientScopes, AuthAccessWriteScope].every((scope) =>
    readEnvironmentScope(environmentId, scope),
  );
}

function connected(environmentId: EnvironmentId, what: string): PreparedConnection {
  const prepared = readPreparedConnection(environmentId);
  if (
    !prepared ||
    appAtomRegistry.get(environmentPresentations.presentationAtom(environmentId))?.connection
      .phase !== "connected"
  )
    throw new Error(`Connect this machine first to ${what}.`);
  return prepared;
}

/** The message the server worded for the person, else the fallback. */
function serverMessage(cause: Cause.Cause<unknown>, fallback: string): string {
  const failure = Cause.squash(cause) as { readonly _tag?: unknown; readonly message?: unknown };
  return typeof failure === "object" &&
    failure !== null &&
    failure._tag === "EnvironmentHttpBadRequestError" &&
    typeof failure.message === "string"
    ? failure.message
    : fallback;
}

async function run<A, E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  fallback: string,
): Promise<A> {
  const result = await executeAtomQuery(appAtomRegistry, atom, {
    reportFailure: false,
    reportDefect: false,
  });
  if (result._tag === "Failure") throw new Error(serverMessage(result.cause, fallback));
  return result.value;
}

function requestClientRevoke(prepared: PreparedConnection, sessionId: string) {
  return Effect.gen(function* () {
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      prepared,
      signer,
      remoteAuthorization,
      group: "auth",
      method: "POST",
      url: (base) => environmentEndpointUrl(base, "/api/auth/clients/revoke"),
      timeoutMs: 15000,
      request: ({ client, headers }) =>
        client.revokeClient({ headers, payload: { sessionId: AuthSessionId.make(sessionId) } }),
    });
  });
}

function requestClientSessions(prepared: PreparedConnection) {
  return Effect.gen(function* () {
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      prepared,
      signer,
      remoteAuthorization,
      group: "auth",
      method: "GET",
      url: (base) => environmentEndpointUrl(base, "/api/auth/clients"),
      timeoutMs: 15000,
      request: ({ client, headers }) => client.clients({ headers }),
    });
  });
}

/** The subject the server gives a session it issued for a redeemed fleet invitation. */
const FLEET_INVITATION_SUBJECT = "fleet-invitation";

const pendingKey = (environmentId: EnvironmentId) =>
  `studio:standby-arming:pending-revoke:v1:${environmentId}`;

export const liveStandbyArmingCommands: StandbyArmingCommands = {
  fleet: (environmentId) =>
    run(
      connectionAtomRuntime.atom(requestFleet(connected(environmentId, "read its machines"))),
      "Could not read this machine's list of machines.",
    ),
  workGrants: (environmentId) =>
    run(
      connectionAtomRuntime.atom(
        requestWorkGrants(connected(environmentId, "read who may run work there")),
      ),
      "Could not read who may run work on this machine.",
    ),
  // Tailscale when it works, else a line over SpecWithCode Connect.
  invite: (environmentId, input) =>
    inviteStudioFleetMachine(environmentId, { ...input, via: "auto" }),
  add: (environmentId, invitation) => addStudioFleetMachine(environmentId, invitation),
  allow: async (environmentId, input) =>
    (
      await run(
        connectionAtomRuntime.atom(
          requestFleetWorkersAllow(connected(environmentId, "allow workers"), input),
        ),
        "Could not allow workers on this machine. Try again.",
      )
    ).workers,
  updateGrant: (environmentId, input) =>
    changeMachineWorkGrant(environmentId, { action: "update", input }),
  revokeSession: async (environmentId, sessionId) => {
    await run(
      connectionAtomRuntime.atom(
        requestClientRevoke(connected(environmentId, "remove setup access"), sessionId),
      ),
      "Could not remove the setup access on this machine.",
    );
  },
  redeemedSessions: async (environmentId, coordinatorEnvironmentId, sinceMs) => {
    const sessions = await run(
      connectionAtomRuntime.atom(
        requestClientSessions(connected(environmentId, "find the setup access")),
      ),
      "Could not read the sessions on this machine.",
    );
    return sessions
      .filter(
        (session) =>
          session.subject === FLEET_INVITATION_SUBJECT &&
          session.principal?.kind === "coordinator" &&
          session.principal.environmentId === coordinatorEnvironmentId &&
          DateTime.toEpochMillis(session.issuedAt) >= sinceMs,
      )
      .map((session) => session.sessionId);
  },
  pendingRevocations: {
    read: (environmentId) => {
      try {
        const value: unknown = JSON.parse(localStorage.getItem(pendingKey(environmentId)) ?? "[]");
        return Array.isArray(value) ? value.filter((id) => typeof id === "string") : [];
      } catch {
        return [];
      }
    },
    write: (environmentId, sessionIds) => {
      try {
        if (sessionIds.length === 0) localStorage.removeItem(pendingKey(environmentId));
        else localStorage.setItem(pendingKey(environmentId), JSON.stringify(sessionIds));
      } catch {
        /* Without storage the next attempt cannot retry; the failure was already shown. */
      }
    },
  },
};
