import { ManagedRelay } from "@specweave-studio/client-runtime/relay";
import {
  environmentEndpointUrl,
  executeAuthenticatedEnvironmentHttpRequest,
  RemoteEnvironmentAuthorization,
} from "@specweave-studio/client-runtime/studio";
import type { PreparedConnection } from "@specweave-studio/client-runtime/connection";
import type { CloudSessionsQuery } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

/** Availability and the sessions this server started; `refresh` re-runs the CLI sign-in check. */
export function requestCloudSessions(prepared: PreparedConnection, query: CloudSessionsQuery = {}) {
  return Effect.gen(function* () {
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
    const search = new URLSearchParams();
    if (query.projectId !== undefined) search.set("projectId", query.projectId);
    if (query.refresh !== undefined) search.set("refresh", query.refresh);
    const suffix = search.size > 0 ? `?${search.toString()}` : "";
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      prepared,
      signer,
      remoteAuthorization,
      group: "cloudSessions",
      method: "GET",
      url: (base) => environmentEndpointUrl(base, `/api/studio/cloud-sessions${suffix}`),
      // A refresh runs `claude auth status`, which can take a few seconds.
      timeoutMs: query.refresh === "true" ? 30_000 : 10_000,
      request: ({ client, headers }) => client.cloudSessions({ headers, query }),
    });
  });
}
