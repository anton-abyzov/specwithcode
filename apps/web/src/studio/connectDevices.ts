import { ManagedRelay } from "@specweave-studio/client-runtime/relay";
import {
  environmentEndpointUrl,
  executeAuthenticatedEnvironmentHttpRequest,
  RemoteEnvironmentAuthorization,
} from "@specweave-studio/client-runtime/studio";
import type { PreparedConnection } from "@specweave-studio/client-runtime/connection";
import { executeAtomQuery } from "@specweave-studio/client-runtime/state/runtime";
import type { EnvironmentId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import type * as Atom from "effect/reactivity/Atom";
import type { AsyncResult } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readPreparedConnection } from "../state/session";

export * from "./connectDevices.logic";

/** The shared parts of one call to a machine's `connectDevices` endpoints. */
const options = (prepared: PreparedConnection, path: string) =>
  Effect.gen(function* () {
    return {
      prepared,
      signer: yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner),
      remoteAuthorization: yield* Effect.serviceOption(RemoteEnvironmentAuthorization),
      group: "connectDevices" as const,
      method: "POST" as const,
      url: (base: string) => environmentEndpointUrl(base, `/api/auth/connect-devices/${path}`),
      timeoutMs: 15000,
    };
  });

function preparedFor(environmentId: EnvironmentId): PreparedConnection {
  const prepared = readPreparedConnection(environmentId);
  if (!prepared) throw new Error("This machine is not connected.");
  return prepared;
}

async function run<A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>): Promise<A> {
  const result = await executeAtomQuery(appAtomRegistry, atom, {
    reportFailure: false,
    reportDefect: false,
  });
  if (result._tag === "Failure") throw new Error("Could not reach this machine. Try again.");
  return result.value;
}

export const connectDevices = {
  list: (environmentId: EnvironmentId) =>
    run(
      connectionAtomRuntime.atom(
        options(preparedFor(environmentId), "list").pipe(
          Effect.flatMap((base) =>
            executeAuthenticatedEnvironmentHttpRequest({
              ...base,
              request: ({ client, headers }) => client.list({ headers, payload: {} }),
            }),
          ),
        ),
      ),
    ),
  approve: (environmentId: EnvironmentId, code: string) =>
    run(
      connectionAtomRuntime.atom(
        options(preparedFor(environmentId), "approve").pipe(
          Effect.flatMap((base) =>
            executeAuthenticatedEnvironmentHttpRequest({
              ...base,
              request: ({ client, headers }) =>
                client.approve({ headers, payload: { code: code.trim() } }),
            }),
          ),
        ),
      ),
    ),
  deny: (environmentId: EnvironmentId, requestId: string) =>
    run(
      connectionAtomRuntime.atom(
        options(preparedFor(environmentId), "deny").pipe(
          Effect.flatMap((base) =>
            executeAuthenticatedEnvironmentHttpRequest({
              ...base,
              request: ({ client, headers }) => client.deny({ headers, payload: { requestId } }),
            }),
          ),
        ),
      ),
    ),
  remove: (environmentId: EnvironmentId, key: string) =>
    run(
      connectionAtomRuntime.atom(
        options(preparedFor(environmentId), "remove").pipe(
          Effect.flatMap((base) =>
            executeAuthenticatedEnvironmentHttpRequest({
              ...base,
              request: ({ client, headers }) => client.remove({ headers, payload: { key } }),
            }),
          ),
        ),
      ),
    ),
  confirmReview: (environmentId: EnvironmentId) =>
    run(
      connectionAtomRuntime.atom(
        options(preparedFor(environmentId), "confirm-review").pipe(
          Effect.flatMap((base) =>
            executeAuthenticatedEnvironmentHttpRequest({
              ...base,
              request: ({ client, headers }) => client.confirmReview({ headers, payload: {} }),
            }),
          ),
        ),
      ),
    ),
  repair: (environmentId: EnvironmentId) =>
    run(
      connectionAtomRuntime.atom(
        options(preparedFor(environmentId), "repair").pipe(
          Effect.flatMap((base) =>
            executeAuthenticatedEnvironmentHttpRequest({
              ...base,
              request: ({ client, headers }) => client.repair({ headers, payload: {} }),
            }),
          ),
        ),
      ),
    ),
};
