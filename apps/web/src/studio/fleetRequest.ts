import { ManagedRelay } from "@specweave-studio/client-runtime/relay";
import {
  environmentEndpointUrl,
  executeAuthenticatedEnvironmentHttpRequest,
  RemoteEnvironmentAuthorization,
} from "@specweave-studio/client-runtime/studio";
import type { PreparedConnection } from "@specweave-studio/client-runtime/connection";
import type { ProjectId } from "@specweave-studio/contracts";
import type { StudioFleetWorkersAllowInput } from "@specweave-studio/contracts/studioFleet";
import * as Effect from "effect/Effect";

export function requestFleet(prepared: PreparedConnection) {
  return Effect.gen(function* () {
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      prepared,
      signer,
      remoteAuthorization,
      group: "studioFleet",
      method: "GET",
      url: (base) => environmentEndpointUrl(base, "/api/studio/fleet"),
      timeoutMs: 10000,
      request: ({ client, headers }) => client.fleet({ headers }),
    });
  });
}
export function requestFleetPairing(prepared: PreparedConnection, id: string) {
  return Effect.gen(function* () {
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      prepared,
      signer,
      remoteAuthorization,
      group: "studioFleet",
      method: "POST",
      url: (base) => environmentEndpointUrl(base, "/api/studio/fleet/connect"),
      timeoutMs: 15000,
      request: ({ client, headers }) => client.connectFleet({ headers, payload: { id } }),
    });
  });
}
/** Lets this server start workers on a fleet machine; the grant stays on the server. */
export function requestFleetWorkersAllow(
  prepared: PreparedConnection,
  input: StudioFleetWorkersAllowInput,
) {
  return Effect.gen(function* () {
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      prepared,
      signer,
      remoteAuthorization,
      group: "studioFleet",
      method: "POST",
      url: (base) => environmentEndpointUrl(base, "/api/studio/fleet/workers/allow"),
      timeoutMs: 30000,
      request: ({ client, headers }) => client.allowFleetWorkers({ headers, payload: input }),
    });
  });
}
export function requestFleetWorkersStop(prepared: PreparedConnection, id: string) {
  return Effect.gen(function* () {
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      prepared,
      signer,
      remoteAuthorization,
      group: "studioFleet",
      method: "POST",
      url: (base) => environmentEndpointUrl(base, "/api/studio/fleet/workers/stop"),
      timeoutMs: 15000,
      request: ({ client, headers }) => client.stopFleetWorkers({ headers, payload: { id } }),
    });
  });
}
/** Workers this server started on other machines for one project. */
export function requestRemoteWorkers(prepared: PreparedConnection, projectId: ProjectId) {
  return Effect.gen(function* () {
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      prepared,
      signer,
      remoteAuthorization,
      group: "studioFleet",
      method: "GET",
      url: (base) =>
        environmentEndpointUrl(
          base,
          `/api/studio/fleet/remote-workers?projectId=${encodeURIComponent(projectId)}`,
        ),
      timeoutMs: 10000,
      request: ({ client, headers }) => client.remoteWorkers({ headers, query: { projectId } }),
    });
  });
}
