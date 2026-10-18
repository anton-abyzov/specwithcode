import {
  AuthAccessWriteScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  EnvironmentHttpForbiddenError,
  EnvironmentHttpBadRequestError,
  EnvironmentHttpInternalServerError,
  StudioFleetInviteError,
} from "@specweave-studio/contracts";
import { DEFAULT_TAILSCALE_SERVE_PORT } from "@specweave-studio/tailscale";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { HttpClient } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HttpEffect from "effect/http/HttpEffect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import { requireEnvironmentScope } from "./auth/http.ts";
import * as Config from "./config.ts";
import * as FleetWorkerGrants from "./fleet/FleetWorkerGrants.ts";
import * as RemoteWorkers from "./fleet/RemoteWorkers.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import {
  makePersistedServerRuntimeState,
  type PersistedServerRuntimeState,
  readPersistedServerRuntimeState,
} from "./serverRuntimeState.ts";
import { capacityMutationOriginAllowed, mutationTrustedOrigins } from "./studio/http.ts";
import {
  connectFleet,
  discoverFleet,
  fleetConnectPermission,
  FleetError,
  readFleetConfig,
} from "./studioFleet.ts";
import {
  fleetInviteProblem,
  fleetTailscaleSignInProblem,
  issueFleetInvitation,
  readFleetTailscaleStatus,
  startFleetTailscaleSignIn,
} from "./studioFleetInvite.ts";
import { addFleetMachine, FleetJoinError } from "./studioFleetJoin.ts";

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
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const httpClient = yield* HttpClient.HttpClient;
    const fileSystem = yield* FileSystem.FileSystem;
    /**
     * Where this server listens now: the runtime state it recorded at
     * startup (the bound port), else its configuration.
     */
    const listening = readPersistedServerRuntimeState(config.serverRuntimeStatePath).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.map((found) => Option.filter(found, (state) => state.pid === process.pid)),
      Effect.orElseSucceed(() => Option.none<PersistedServerRuntimeState>()),
      Effect.flatMap(
        Option.match({
          onSome: Effect.succeed,
          onNone: () => makePersistedServerRuntimeState({ config, port: config.port }),
        }),
      ),
    );
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
      .handle("addFleetMachine", ({ payload }) =>
        Effect.gen(function* () {
          yield* noStore;
          // Adding a machine stores a credential for it, like allowing workers there.
          yield* requireGrantManager;
          return yield* Effect.tryPromise({
            try: () =>
              addFleetMachine({
                baseDir: config.baseDir,
                code: payload.invitation,
                label: payload.label?.trim() || undefined,
              }),
            catch: (error) => {
              const kind =
                error instanceof FleetJoinError || error instanceof FleetError
                  ? error.kind
                  : "write";
              const message =
                error instanceof FleetJoinError || error instanceof FleetError
                  ? error.message
                  : new FleetJoinError("write").message;
              return kind === "write" || kind === "config"
                ? new EnvironmentHttpInternalServerError({ message })
                : new EnvironmentHttpBadRequestError({ message });
            },
          });
        }),
      )
      .handle("inviteFleetMachine", ({ payload }) =>
        Effect.gen(function* () {
          // The answer holds a management credential: never cached, never logged.
          yield* noStore;
          // It mints an access-management session, like allowing workers.
          yield* requireGrantManager;
          const descriptor = yield* serverEnvironment.getDescriptor;
          const state = yield* listening;
          const issued = yield* issueFleetInvitation({
            environmentId: descriptor.environmentId,
            ownLabel: descriptor.label,
            state,
            // The port Tailscale HTTPS already uses here, so an existing
            // mapping for this server is reused rather than duplicated.
            servePort: config.tailscaleServeEnabled
              ? config.tailscaleServePort
              : DEFAULT_TAILSCALE_SERVE_PORT,
            label: payload.label,
            ...(payload.days !== undefined ? { ttl: Duration.days(payload.days) } : {}),
          }).pipe(
            Effect.provideService(EnvironmentAuth.EnvironmentAuth, environmentAuth),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.mapError((error) =>
              EnvironmentAuth.isServerAuthInternalError(error)
                ? new EnvironmentHttpInternalServerError({
                    message: "Could not make an invitation on this machine. Try again.",
                  })
                : new StudioFleetInviteError(fleetInviteProblem(error)),
            ),
          );
          return issued.invitation;
        }),
      )
      .handle("fleetTailscale", () =>
        Effect.gen(function* () {
          // Read-only, but only an access manager can act on it.
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          yield* noStore;
          return yield* readFleetTailscaleStatus().pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
          );
        }),
      )
      .handle("signInFleetTailscale", () =>
        Effect.gen(function* () {
          // The answer is a one-time sign-in page: never cached, never logged.
          yield* noStore;
          // It starts programs on this machine, like publishing an invitation.
          yield* requireGrantManager;
          return yield* startFleetTailscaleSignIn().pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.mapError(
              (error) => new StudioFleetInviteError(fleetTailscaleSignInProblem(error)),
            ),
          );
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
