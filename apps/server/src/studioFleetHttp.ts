import {
  AuthAccessWriteScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  EnvironmentHttpForbiddenError,
  EnvironmentHttpBadRequestError,
  EnvironmentHttpInternalServerError,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as HttpEffect from "effect/http/HttpEffect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { requireEnvironmentScope } from "./auth/http.ts";
import * as Config from "./config.ts";
import * as FleetWorkerGrants from "./fleet/FleetWorkerGrants.ts";
import * as RemoteWorkers from "./fleet/RemoteWorkers.ts";
import { capacityMutationOriginAllowed, mutationTrustedOrigins } from "./studio/http.ts";
import {
  connectFleet,
  discoverFleet,
  fleetConnectPermission,
  FleetError,
  readFleetConfig,
} from "./studioFleet.ts";

const noStore = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(
    HttpServerResponse.setHeaders(response, {
      "cache-control": "no-store",
      pragma: "no-cache",
      "x-content-type-options": "nosniff",
    }),
  ),
);
const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) => {
      const failure = error instanceof FleetError ? error : new FleetError("config");
      return failure.kind === "forbidden"
        ? new EnvironmentHttpForbiddenError({ message: failure.message })
        : failure.kind === "unknown-machine"
          ? new EnvironmentHttpBadRequestError({ message: failure.message })
          : new EnvironmentHttpInternalServerError({ message: failure.message });
    },
  });
const grantFailure = (error: FleetWorkerGrants.FleetWorkerGrantError) =>
  error.reason === "unknown_machine" || error.reason === "rate_limited"
    ? new EnvironmentHttpBadRequestError({ message: error.message })
    : new EnvironmentHttpInternalServerError({ message: error.message });

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "studioFleet",
  Effect.fnUntraced(function* (handlers) {
    const config = yield* Config.ServerConfig;
    const grants = yield* FleetWorkerGrants.FleetWorkerGrants;
    /**
     * Allowing or stopping workers mints or revokes a credential on another
     * machine, so it needs the owner's access-management scope and a request
     * the browser sent from this app itself.
     */
    const requireGrantManager = Effect.gen(function* () {
      yield* requireEnvironmentScope(AuthAccessWriteScope);
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (
        !capacityMutationOriginAllowed({
          origin: request.headers.origin,
          host: request.headers.host,
          requestUrl: request.originalUrl,
          forwardedProto: request.headers["x-forwarded-proto"],
          fetchSite: request.headers["sec-fetch-site"],
          authorization: request.headers.authorization,
          cookie: request.headers.cookie,
          trustedOrigins: mutationTrustedOrigins(config),
        })
      )
        return yield* new EnvironmentHttpForbiddenError({
          message: "Changing worker access requires an authorized same-origin request.",
        });
    });
    return handlers
      .handle("fleet", () =>
        Effect.gen(function* () {
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          yield* noStore;
          const snapshot = yield* Effect.tryPromise({
            try: async () => discoverFleet(await readFleetConfig(config.baseDir), config.host),
            catch: () =>
              new EnvironmentHttpInternalServerError({ message: new FleetError("config").message }),
          });
          const machines = yield* Effect.forEach(
            snapshot.machines,
            (machine) =>
              Effect.map(grants.status(machine.id), (workers) => ({ ...machine, workers })),
            { concurrency: 4 },
          );
          return { ...snapshot, machines };
        }),
      )
      .handle("allowFleetWorkers", ({ payload }) =>
        Effect.gen(function* () {
          yield* noStore;
          yield* requireGrantManager;
          const workers = yield* grants
            .allow({
              machineId: payload.id,
              access: payload.access,
              pairingCode: payload.pairingCode,
            })
            .pipe(Effect.mapError(grantFailure));
          return { id: payload.id, workers };
        }),
      )
      .handle("stopFleetWorkers", ({ payload }) =>
        Effect.gen(function* () {
          yield* noStore;
          yield* requireGrantManager;
          const result = yield* grants.stop(payload.id).pipe(Effect.mapError(grantFailure));
          return {
            id: payload.id,
            workers: result.workers,
            remoteSessionKept: result.remoteSessionKept,
          };
        }),
      )
      .handle("remoteWorkers", ({ query }) =>
        Effect.gen(function* () {
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          yield* noStore;
          const remote = yield* RemoteWorkers.RemoteWorkers;
          return { workers: yield* remote.workersForProject(query.projectId) };
        }),
      )
      .handle("connectFleet", ({ payload }) =>
        Effect.gen(function* () {
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          yield* noStore;
          const fleetConfig = yield* attempt(() => readFleetConfig(config.baseDir));
          const principal = yield* requireEnvironmentScope(fleetConnectPermission(fleetConfig));
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (
            !capacityMutationOriginAllowed({
              origin: request.headers.origin,
              host: request.headers.host,
              requestUrl: request.originalUrl,
              forwardedProto: request.headers["x-forwarded-proto"],
              fetchSite: request.headers["sec-fetch-site"],
              authorization: request.headers.authorization,
              cookie: request.headers.cookie,
              trustedOrigins: mutationTrustedOrigins(config),
            })
          )
            return yield* new EnvironmentHttpForbiddenError({
              message: "Pairing requires an authorized same-origin request.",
            });
          return yield* attempt(async () =>
            connectFleet(fleetConfig, payload.id, principal.scopes),
          );
        }),
      );
  }),
);
