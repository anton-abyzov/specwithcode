import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  type AuthEnvironmentScope,
  type EnvironmentId,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  EnvironmentHttpForbiddenError,
  EnvironmentHttpBadRequestError,
  EnvironmentHttpInternalServerError,
  type EnvironmentAuthInvalidError,
  StudioFleetInviteError,
} from "@specweave-studio/contracts";
import { DEFAULT_TAILSCALE_SERVE_PORT } from "@specweave-studio/tailscale";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
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
import {
  failEnvironmentAuthInvalid,
  failEnvironmentRateLimited,
  requireEnvironmentScope,
} from "./auth/http.ts";
import {
  arrivedOverConnect,
  gateRequest,
  recordRequestFailure,
} from "./auth/CredentialFailureLimiter.ts";
import { requestRemoteAddress } from "./auth/utils.ts";
import * as Config from "./config.ts";
import * as FleetWorkerGrants from "./fleet/FleetWorkerGrants.ts";
import * as RemoteWorkers from "./fleet/RemoteWorkers.ts";
import * as ManagedProjectFolders from "./project/ManagedProjectFolders.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import { readConnectOrigin } from "./cloud/config.ts";
import {
  makePersistedServerRuntimeState,
  type PersistedServerRuntimeState,
  readPersistedServerRuntimeState,
} from "./serverRuntimeState.ts";
import { capacityMutationOriginAllowed, mutationTrustedOrigins } from "./auth/requestOrigin.ts";
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
  FLEET_INVITE_SCOPES,
  FLEET_INVITE_SESSION_LABEL,
  issueFleetInvitation,
  readFleetTailscaleStatus,
  startFleetTailscaleSignIn,
} from "./studioFleetInvite.ts";
import {
  addFleetMachine,
  FleetJoinError,
  removeFleetMachineEverywhere,
} from "./studioFleetJoin.ts";
import * as FleetTargets from "./fleet/FleetTargets.ts";
import * as PhoneLinks from "./fleet/phoneLinks.ts";
import * as DirectEndpoints from "./environment/DirectEndpoints.ts";
import * as WorkGrants from "./fleet/WorkGrants.ts";
import { coordinatorLabels, workGrantsSnapshot } from "./fleet/workGrantsSnapshot.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "./project/ProjectService.ts";
import * as ProviderRegistry from "./provider/ProviderRegistry.ts";
import * as ServerSettings from "./serverSettings.ts";

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
        : // The user can act on these: a new invitation from that machine fixes both.
          failure.kind === "unknown-machine" ||
            failure.kind === "invitation-limited" ||
            failure.kind === "reapproval-required" ||
            failure.kind === "connect-unbound" ||
            failure.kind === "connect-key-missing" ||
            failure.kind === "connect-browser-unsupported"
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
     * A change that mints or revokes a credential needs `scope` and a request
     * the browser sent from this app itself (bearer requests carry no origin).
     */
    const requireTrustedRequest = (scope: AuthEnvironmentScope, message: string) =>
      Effect.gen(function* () {
        const principal = yield* requireEnvironmentScope(scope);
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
          return yield* new EnvironmentHttpForbiddenError({ message });
        return principal;
      });
    /**
     * Allowing or stopping workers mints or revokes a credential on another
     * machine, so it needs the owner's access-management scope and a request
     * the browser sent from this app itself.
     */
    const requireGrantManager = requireTrustedRequest(
      AuthAccessWriteScope,
      "Changing worker access requires an authorized same-origin request.",
    ).pipe(
      Effect.flatMap((session) =>
        session.principal?.kind === "coordinator"
          ? Effect.fail(
              new EnvironmentHttpForbiddenError({
                message:
                  "Only this machine's owner can change worker access. Approve this device again on this machine to restore its access.",
              }),
            )
          : Effect.void,
      ),
    );
    const directEndpoints = yield* Effect.serviceOption(DirectEndpoints.DirectEndpoints);
    const managedFolders = yield* Effect.serviceOption(ManagedProjectFolders.ManagedProjectFolders);
    const isScratch = Option.isSome(managedFolders) ? managedFolders.value.isScratch : undefined;
    const authFailure = () =>
      new EnvironmentHttpInternalServerError({
        message: "Could not read the clients paired with this machine.",
      });
    const threadManagement = yield* ThreadManagement.ThreadManagementService;
    const projectService = yield* ProjectService.ProjectService;
    const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
    const serverSettings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
    /** Coordinator names for the grants list: the fleet list's, else shared nicknames. */
    const grantLabels = Effect.gen(function* () {
      const fleetConfig = yield* Effect.tryPromise(() => readFleetConfig(config.baseDir)).pipe(
        Effect.orElseSucceed(() => null),
      );
      const settings = Option.isSome(serverSettings)
        ? yield* serverSettings.value.getSettings.pipe(Effect.option)
        : Option.none();
      return coordinatorLabels(
        fleetConfig?.machines ?? [],
        Option.getOrUndefined(settings)?.machineNicknames,
      );
    });
    const fleetTargets = yield* FleetTargets.FleetTargets;
    const fleetFetch = fleetTargets.fetch;
    // One proof key and address book for every fleet call this group makes.
    const fleetLink = FleetTargets.linkOf(fleetTargets);
    const secretStore = yield* Effect.serviceOption(ServerSecretStore.ServerSecretStore);
    /** This machine's validated SpecWithCode Connect origin, or null when not linked. */
    const connectOrigin: Effect.Effect<string | null> = Option.isSome(secretStore)
      ? readConnectOrigin.pipe(
          Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore.value),
          Effect.provideService(ServerEnvironment.ServerEnvironment, serverEnvironment),
        )
      : Effect.succeed(null);
    /**
     * A change to who may run work here, made only by this machine's access
     * manager from this app, answering with the grant as the screen shows it.
     */
    const changeWorkGrant = (
      coordinatorEnvironmentId: EnvironmentId,
      change: (
        service: WorkGrants.WorkGrantsShape,
      ) => Effect.Effect<unknown, WorkGrants.WorkGrantsError>,
    ) =>
      Effect.gen(function* () {
        yield* noStore;
        yield* requireGrantManager;
        const service = yield* WorkGrants.WorkGrants;
        yield* change(service).pipe(
          Effect.mapError((error) =>
            error.reason === "unknown_grant"
              ? new EnvironmentHttpBadRequestError({ message: error.message })
              : new EnvironmentHttpInternalServerError({ message: error.message }),
          ),
        );
        const snapshot = yield* workGrantsSnapshot({
          ownEnvironmentId: yield* serverEnvironment.getEnvironmentId,
          labels: yield* grantLabels,
          ...(isScratch === undefined ? {} : { isScratch }),
        }).pipe(
          Effect.provideService(EnvironmentAuth.EnvironmentAuth, environmentAuth),
          Effect.provideService(ThreadManagement.ThreadManagementService, threadManagement),
          Effect.provideService(ProjectService.ProjectService, projectService),
          Effect.provideService(ProviderRegistry.ProviderRegistry, providerRegistry),
          Effect.mapError(
            () =>
              new EnvironmentHttpInternalServerError({
                message: "Could not read who may run work on this machine.",
              }),
          ),
        );
        const grant = snapshot.grants.find(
          (entry) => entry.coordinatorEnvironmentId === coordinatorEnvironmentId,
        );
        if (grant === undefined)
          return yield* new EnvironmentHttpInternalServerError({
            message: "Could not read who may run work on this machine.",
          });
        return { grant };
      });
    return (
      handlers
        .handle("fleet", () =>
          Effect.gen(function* () {
            yield* requireEnvironmentScope(AuthOrchestrationReadScope);
            yield* noStore;
            const snapshot = yield* Effect.tryPromise({
              try: async () =>
                discoverFleet(await readFleetConfig(config.baseDir), config.host, fleetLink),
              catch: () =>
                new EnvironmentHttpInternalServerError({
                  message: new FleetError("config").message,
                }),
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
            const localEnvironmentId = yield* serverEnvironment.getEnvironmentId;
            return yield* Effect.tryPromise({
              try: () =>
                addFleetMachine({
                  baseDir: config.baseDir,
                  code: payload.invitation,
                  label: payload.label?.trim() || undefined,
                  link: fleetLink,
                  localEnvironmentId,
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
            // The line hands out the invite scopes, so only a caller holding all
            // of them may make one: never more than the maker holds.
            const principal = yield* requireEnvironmentScope(AuthAccessWriteScope);
            if (!FLEET_INVITE_SCOPES.every((scope) => principal.scopes.has(scope)))
              return yield* new EnvironmentHttpForbiddenError({
                message:
                  "Inviting this machine hands out full access to it, so it needs a sign-in that has full access here. Use Invite this machine in the SpecWithCode app on this machine, or run `specwithcode fleet invite --coordinator '<main-machine-environment-id>'` there. Replace <main-machine-environment-id> with the environment ID from Settings > Connections on your main machine. This explicitly approves that machine to manage access here.",
              });
            const descriptor = yield* serverEnvironment.getDescriptor;
            const state = yield* listening;
            const issued = yield* issueFleetInvitation({
              environmentId: descriptor.environmentId,
              coordinatorEnvironmentId: payload.coordinatorEnvironmentId,
              ownLabel: descriptor.label,
              state,
              // The port Tailscale HTTPS already uses here, so an existing
              // mapping for this server is reused rather than duplicated.
              servePort: config.tailscaleServeEnabled
                ? config.tailscaleServePort
                : DEFAULT_TAILSCALE_SERVE_PORT,
              label: payload.label,
              ...(payload.days !== undefined ? { ttl: Duration.days(payload.days) } : {}),
              via: payload.via,
              readConnectOrigin: connectOrigin,
              fetch: fleetFetch,
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
        // Another machine spends this machine's v2 invitation line: its
        // one-time credential buys a management token bound to the DPoP key
        // that signed the request. Principal, scopes and lifetime come only
        // from the line this machine's owner made.
        .handle("redeemFleetInvitation", ({ payload, request }) =>
          Effect.gen(function* () {
            // The answer holds a management credential: never cached, never logged.
            yield* noStore;
            yield* gateRequest(request).pipe(Effect.catch(failEnvironmentRateLimited));
            const refused = (error: EnvironmentAuth.ServerAuthCredentialError) =>
              recordRequestFailure(request).pipe(
                Effect.andThen(
                  failEnvironmentAuthInvalid(
                    "invalid_credential",
                    EnvironmentAuth.serverAuthDpopFailureReason(error),
                  ),
                ),
              );
            const internal = () =>
              new EnvironmentHttpInternalServerError({
                message: "Could not redeem the invitation on this machine. Try again.",
              });
            const failed = (
              error:
                | EnvironmentAuth.ServerAuthInvalidCredentialError
                | EnvironmentAuth.ServerAuthInternalError,
            ): Effect.Effect<
              never,
              EnvironmentAuthInvalidError | EnvironmentHttpInternalServerError
            > =>
              error._tag === "ServerAuthInvalidCredentialError"
                ? refused(error)
                : Effect.fail(internal());
            const thumbprint = yield* environmentAuth
              .verifyRequestProof(request)
              .pipe(Effect.catch(failed));
            const redeemed = yield* environmentAuth
              .consumeFleetRedemption(payload.credential)
              .pipe(Effect.catch(failed));
            const forwarded = arrivedOverConnect(request)
              ? request.headers["cf-connecting-ip"]?.trim()
              : requestRemoteAddress(request);
            const redeemedFrom =
              forwarded !== undefined && forwarded.length > 0 && forwarded.length <= 64
                ? forwarded
                : undefined;
            // Checked after the credential is spent, so a mismatched line is gone either way.
            if (redeemed.principal.environmentId !== payload.coordinatorEnvironmentId)
              return yield* new EnvironmentHttpBadRequestError({
                message:
                  "This invitation was made for a different main machine. Make a new line for this one.",
              });
            const issued = yield* environmentAuth
              .issueSession({
                subject: EnvironmentAuth.FLEET_INVITATION_SUBJECT,
                principal: redeemed.principal,
                principalGeneration: redeemed.principalGeneration,
                scopes: redeemed.scopes,
                label: redeemed.label ?? FLEET_INVITE_SESSION_LABEL,
                ttl: Duration.days(redeemed.days),
                proofKeyThumbprint: thumbprint,
                ...(redeemedFrom === undefined ? {} : { ipAddress: redeemedFrom }),
              })
              .pipe(Effect.mapError(internal));
            // A leaked line can be redeemed by someone else's key: leave a
            // trace the owner can match against the client list.
            yield* Effect.logInfo("Redeemed a fleet invitation for a main machine.", {
              coordinatorEnvironmentId: redeemed.principal.environmentId,
              sessionId: issued.sessionId,
              overConnect: arrivedOverConnect(request),
              ...(redeemedFrom === undefined ? {} : { from: redeemedFrom }),
            });
            return {
              managementToken: issued.token,
              sessionId: issued.sessionId,
              expiresAt: DateTime.formatIso(issued.expiresAt),
            };
          }),
        )
        .handle("fleetTailscale", () =>
          Effect.gen(function* () {
            // Read-only, but only an access manager can act on it.
            yield* requireEnvironmentScope(AuthAccessWriteScope);
            yield* noStore;
            const status = yield* readFleetTailscaleStatus().pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              Effect.provideService(FileSystem.FileSystem, fileSystem),
            );
            const origin = yield* connectOrigin;
            return { ...status, connect: { linked: origin !== null, origin } };
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
        .handle("removeFleetMachine", ({ payload }) =>
          Effect.gen(function* () {
            yield* noStore;
            // Removing a machine revokes credentials this machine holds there.
            yield* requireGrantManager;
            return yield* Effect.tryPromise({
              try: () =>
                removeFleetMachineEverywhere({
                  baseDir: config.baseDir,
                  machine: payload.id,
                  fetcher: fleetLink,
                  // The grant store here revokes its sessions there and forgets the grant.
                  revokeWorkerAccess: (target) =>
                    Effect.runPromise(
                      grants.status(target.id).pipe(
                        Effect.flatMap((before) =>
                          grants
                            .stop(target.id)
                            .pipe(
                              Effect.map((stopped) =>
                                stopped.remoteSessionKept
                                  ? ("kept" as const)
                                  : before.status === "not_allowed"
                                    ? ("none" as const)
                                    : ("revoked" as const),
                              ),
                            ),
                        ),
                        Effect.orElseSucceed(() => "kept" as const),
                      ),
                    ),
                  unlinkPhones: (target) =>
                    Effect.runPromise(serverEnvironment.getEnvironmentId).then((hubEnvironmentId) =>
                      PhoneLinks.unlinkPhonesFrom({
                        stateDir: config.stateDir,
                        fetcher: fleetLink,
                        target,
                        hubEnvironmentId,
                      }),
                    ),
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
        .handle("workGrants", () =>
          Effect.gen(function* () {
            yield* requireEnvironmentScope(AuthAccessReadScope);
            yield* noStore;
            return yield* workGrantsSnapshot({
              ownEnvironmentId: yield* serverEnvironment.getEnvironmentId,
              labels: yield* grantLabels,
              ...(isScratch === undefined ? {} : { isScratch }),
            }).pipe(
              Effect.provideService(EnvironmentAuth.EnvironmentAuth, environmentAuth),
              Effect.provideService(ThreadManagement.ThreadManagementService, threadManagement),
              Effect.provideService(ProjectService.ProjectService, projectService),
              Effect.provideService(ProviderRegistry.ProviderRegistry, providerRegistry),
              Effect.mapError(
                () =>
                  new EnvironmentHttpInternalServerError({
                    message: "Could not read who may run work on this machine.",
                  }),
              ),
            );
          }),
        )
        .handle("updateWorkGrant", ({ payload }) =>
          changeWorkGrant(payload.coordinatorEnvironmentId, (service) => service.update(payload)),
        )
        .handle("revokeWorkGrant", ({ payload }) =>
          changeWorkGrant(payload.coordinatorEnvironmentId, (service) =>
            service.revoke(payload.coordinatorEnvironmentId),
          ),
        )
        .handle("restoreWorkGrant", ({ payload }) =>
          changeWorkGrant(payload.coordinatorEnvironmentId, (service) =>
            service.restore(payload.coordinatorEnvironmentId),
          ),
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
              connectFleet(fleetConfig, payload.id, principal.scopes, fleetLink),
            );
          }),
        )
        // The other machines in this fleet, for a phone paired here, with a
        // phone-only pairing code from each machine it asked for.
        .handle("phoneRoster", ({ payload }) =>
          Effect.gen(function* () {
            yield* noStore;
            const principal = yield* requireTrustedRequest(
              AuthOrchestrationReadScope,
              "Linking a phone requires an authorized request.",
            );
            const sessions = yield* environmentAuth
              .listSessions()
              .pipe(Effect.mapError(authFailure));
            const session = sessions.find((entry) => entry.sessionId === principal.sessionId);
            if (session === undefined || !PhoneLinks.isPhoneDevice(session.client.deviceType))
              return yield* new EnvironmentHttpForbiddenError({
                message: "Only a phone paired with this machine can link to the other machines.",
              });
            const hub = yield* serverEnvironment.getDescriptor;
            const fleetConfig = yield* Effect.tryPromise(() =>
              readFleetConfig(config.baseDir),
            ).pipe(Effect.orElseSucceed(() => null));
            const now = yield* Clock.currentTimeMillis;
            return yield* Effect.promise(() =>
              PhoneLinks.buildPhoneRoster({
                config: fleetConfig,
                fetcher: fleetLink,
                hub: { environmentId: hub.environmentId, label: hub.label },
                phone: {
                  sessionId: principal.sessionId,
                  label: session.client.label?.trim() || "iPhone",
                  scopes: principal.scopes,
                },
                mint: new Set(payload.mint ?? []),
                recordMint: (environmentId) =>
                  PhoneLinks.recordPhoneMint(config.stateDir, {
                    environmentId,
                    hubSessionId: principal.sessionId,
                    now,
                  }),
                now,
              }),
            );
          }),
        )
        // A pairing code for a phone already paired with the asking machine.
        .handle("phoneMint", ({ payload }) =>
          Effect.gen(function* () {
            yield* noStore;
            const principal = yield* requireTrustedRequest(
              AuthAccessWriteScope,
              "Linking a phone requires an authorized request.",
            );
            if (principal.principal?.kind === "coordinator")
              return yield* new EnvironmentHttpForbiddenError({
                message: "Only this machine's owner can approve a phone here.",
              });
            const scopes = PhoneLinks.phoneCodeScopes(payload.scopes, principal.scopes);
            if (scopes === null)
              return yield* new EnvironmentHttpBadRequestError({
                message:
                  "A phone code needs distinct client scopes the asking machine holds, including read access.",
              });
            const issued = yield* environmentAuth
              .createPairingLink({
                ttl: PhoneLinks.PHONE_CODE_TTL,
                label: payload.label,
                scopes,
                subject: PhoneLinks.phoneLinkSubject(
                  payload.hubEnvironmentId,
                  payload.hubSessionId,
                ),
              })
              .pipe(Effect.mapError(authFailure));
            const routes = Option.isSome(directEndpoints)
              ? yield* directEndpoints.value.resolve()
              : [];
            return {
              code: issued.credential,
              expiresAt: DateTime.formatIso(issued.expiresAt),
              routes: routes.map((route) => ({ kind: route.kind, httpBaseUrl: route.httpBaseUrl })),
            };
          }),
        )
        // Revokes the phone sessions the asking machine no longer has, and lists the rest.
        .handle("phoneLinks", ({ payload }) =>
          Effect.gen(function* () {
            yield* noStore;
            yield* requireTrustedRequest(
              AuthAccessWriteScope,
              "Linking a phone requires an authorized request.",
            );
            return yield* PhoneLinks.syncPhoneLinksHere(payload).pipe(
              Effect.provideService(EnvironmentAuth.EnvironmentAuth, environmentAuth),
              Effect.mapError(authFailure),
            );
          }),
        )
    );
  }),
);
