import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  type AuthEnvironmentScope,
  type EnvironmentId,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  EnvironmentHttpForbiddenError,
  EnvironmentHttpBadRequestError,
  EnvironmentHttpInternalServerError,
  type EnvironmentAuthInvalidError,
  EnvironmentAuthenticatedPrincipal,
  StudioFleetInviteError,
  StudioFleetSkillError,
  StudioFleetUpdateError,
} from "@specweave-studio/contracts";
import type { TeamRulesRefusal } from "@specweave-studio/contracts";
import {
  type StudioFleetInviteInput,
  type StudioFleetWorkerAccess,
  StudioFleetWorkersResult,
  StudioFleetWorkersSelfAllowInput,
} from "@specweave-studio/contracts/studioFleet";
import {
  teamRulesMachineLinkRefusal,
  teamRulesReachOff,
  teamRulesReachRefusal,
  type TeamRulesState,
} from "@specweave-studio/shared/teamRules";
import { DEFAULT_TAILSCALE_SERVE_PORT } from "@specweave-studio/tailscale";
import { currentTeamRules } from "./teamRules/TeamRules.ts";
import { isConnectSubject, isPhoneSession } from "./teamRules/TeamRulesReach.ts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
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
import * as FleetDiskRoom from "./fleet/fleetDiskRoom.ts";
import * as FleetSkills from "./fleet/fleetSkills.ts";
import * as FleetUpdate from "./fleet/fleetUpdate.ts";
import * as FleetWorkerGrants from "./fleet/FleetWorkerGrants.ts";
import * as RemoteWorkers from "./fleet/RemoteWorkers.ts";
import * as ReleaseRuns from "./releases/ReleaseRunService.ts";
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
  checkIdentity,
  connectFleet,
  discoverFleet,
  fleetConnectPermission,
  FleetError,
  type FleetTarget,
  readBoundedJson,
  readFleetConfig,
} from "./studioFleet.ts";
import { fleetRequest, reachFleetMachine } from "./fleet/fleetTransport.ts";
import {
  fleetInviteProblem,
  fleetTailscaleSignInProblem,
  FLEET_INVITE_MAKER_SCOPES,
  FLEET_INVITE_SESSION_LABEL,
  issueFleetInvitation,
  readFleetTailscaleStatus,
  startFleetTailscaleSignIn,
} from "./studioFleetInvite.ts";
import {
  addFleetMachine,
  decodeFleetJoinCode,
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

const refusedConnect = (state: TeamRulesState) =>
  teamRulesReachOff(state, "connect") ? teamRulesReachRefusal(state, "connect") : null;

const refuseByTeamRules = (check: (state: TeamRulesState) => TeamRulesRefusal | null) =>
  currentTeamRules.pipe(
    Effect.flatMap((state) => {
      const refused = check(state);
      return refused === null
        ? Effect.void
        : Effect.fail(new EnvironmentHttpForbiddenError({ message: refused.message }));
    }),
  );

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
/** A fleet file change that failed: the user can act on everything but a write. */
const joinFailure = (error: unknown) => {
  const kind =
    error instanceof FleetJoinError || error instanceof FleetError ? error.kind : "write";
  const message =
    error instanceof FleetJoinError || error instanceof FleetError
      ? error.message
      : new FleetJoinError("write").message;
  return kind === "write" || kind === "config"
    ? new EnvironmentHttpInternalServerError({ message })
    : new EnvironmentHttpBadRequestError({ message });
};
const decodeWorkersResult = Schema.decodeUnknownOption(StudioFleetWorkersResult);
const encodeSelfAllow = Schema.encodeSync(Schema.fromJsonString(StudioFleetWorkersSelfAllowInput));

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
    const releaseRuns = yield* ReleaseRuns.ReleaseRunService;
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
    const fleetUpdates = yield* Effect.serviceOption(FleetUpdate.FleetUpdateWorker);
    const fleetDiskRoom = yield* Effect.serviceOption(FleetDiskRoom.FleetDiskRoom);
    /**
     * Only the fleet primary's own management token: a coordinator principal
     * for the primary named in the request, with `fleet:update` (or
     * `environment:maintain`, which every token issued before it holds).
     */
    const requireFleetPrimaryFor = <S>(
      service: Option.Option<S>,
      coordinatorEnvironmentId: EnvironmentId,
      unsupported: string,
    ) =>
      Effect.gen(function* () {
        const session = yield* EnvironmentAuthenticatedPrincipal;
        if (!FleetUpdate.fleetUpdateAllowed(session, coordinatorEnvironmentId))
          return yield* new EnvironmentHttpForbiddenError({
            message:
              "Only this machine's fleet primary, with the management token it holds here, can ask it to update.",
          });
        if (Option.isNone(service))
          return yield* new StudioFleetUpdateError({ reason: "unsupported", message: unsupported });
        return service.value;
      });
    const requireFleetPrimary = (coordinatorEnvironmentId: EnvironmentId) =>
      requireFleetPrimaryFor(
        fleetUpdates,
        coordinatorEnvironmentId,
        "This machine cannot take update requests from its fleet primary.",
      );
    const fleetSkills = yield* Effect.serviceOption(FleetSkills.FleetSkillWorker);
    /** The same gate for skill installs, with `fleet:skills` (or `environment:maintain`). */
    const requireFleetSkillsPrimary = (coordinatorEnvironmentId: EnvironmentId) =>
      Effect.gen(function* () {
        const session = yield* EnvironmentAuthenticatedPrincipal;
        if (!FleetSkills.fleetSkillsAllowed(session, coordinatorEnvironmentId))
          return yield* new EnvironmentHttpForbiddenError({
            message:
              "Only this machine's fleet primary, with the management token it holds here, can ask it to install skills.",
          });
        if (Option.isNone(fleetSkills))
          return yield* new StudioFleetSkillError({
            reason: "unsupported",
            message: "This machine cannot take skill installs from its fleet primary.",
          });
        return fleetSkills.value;
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
    /** Adds the machine an invitation line names to this machine's fleet file. */
    const addMachine = (invitation: string, label?: string, renewWorkers?: boolean) =>
      Effect.gen(function* () {
        const localEnvironmentId = yield* serverEnvironment.getEnvironmentId;
        return yield* Effect.tryPromise({
          try: () =>
            addFleetMachine({
              baseDir: config.baseDir,
              code: invitation,
              label,
              link: fleetLink,
              localEnvironmentId,
              renewWorkers,
            }),
          catch: joinFailure,
        });
      });
    /** The grant store here revokes its sessions on `target` and forgets the grant. */
    const revokeWorkerAccess = (target: FleetTarget) =>
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
      );
    /**
     * Adds the machine a line names and allows its workers. Adding spends the
     * line for a management token there, so a machine this call added leaves
     * again, token revoked, when allowing fails. Runs to its end even when the
     * caller hangs up: stopped between the two steps it would leave the machine
     * listed with no grant and nothing taken back.
     */
    const addAndAllowWorkers = (
      invitation: string,
      access: StudioFleetWorkerAccess,
      renewWorkers = false,
    ) =>
      Effect.gen(function* () {
        const added = yield* addMachine(invitation, undefined, renewWorkers);
        const workers = yield* grants.allow({ machineId: added.id, access }).pipe(
          Effect.mapError(grantFailure),
          Effect.tapError(() =>
            added.change === "added"
              ? Effect.promise(() =>
                  removeFleetMachineEverywhere({
                    baseDir: config.baseDir,
                    machine: added.id,
                    fetcher: fleetLink,
                    revokeWorkerAccess,
                  }).catch(() => undefined),
                )
              : Effect.void,
          ),
        );
        return { added, workers };
      }).pipe(Effect.uninterruptible);
    /**
     * The line hands out the invite scopes, so only a caller holding all of
     * them may make one: never more than the maker holds.
     */
    const requireInviteMaker = (message: string) =>
      Effect.gen(function* () {
        const principal = yield* requireEnvironmentScope(AuthAccessWriteScope);
        if (!FLEET_INVITE_MAKER_SCOPES.every((scope) => principal.scopes.has(scope)))
          return yield* new EnvironmentHttpForbiddenError({ message });
        return principal;
      });
    /** An invitation line for `coordinatorEnvironmentId` to add this machine. */
    const issueInvitation = (
      input: Pick<StudioFleetInviteInput, "coordinatorEnvironmentId"> & {
        readonly label?: string | undefined;
        readonly days?: number | undefined;
        readonly via?: StudioFleetInviteInput["via"];
      },
    ) =>
      Effect.gen(function* () {
        const descriptor = yield* serverEnvironment.getDescriptor;
        const state = yield* listening;
        const issued = yield* issueFleetInvitation({
          environmentId: descriptor.environmentId,
          coordinatorEnvironmentId: input.coordinatorEnvironmentId,
          ownLabel: descriptor.label,
          state,
          // The port Tailscale HTTPS already uses here, so an existing
          // mapping for this server is reused rather than duplicated.
          servePort: config.tailscaleServeEnabled
            ? config.tailscaleServePort
            : DEFAULT_TAILSCALE_SERVE_PORT,
          label: input.label,
          ...(input.days !== undefined ? { ttl: Duration.days(input.days) } : {}),
          via: input.via,
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
      });
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
        // The release runs this machine recorded, for the Releases view; read-only.
        .handle("releaseRuns", () =>
          Effect.gen(function* () {
            yield* requireEnvironmentScope(AuthOrchestrationReadScope);
            yield* noStore;
            return yield* releaseRuns.list();
          }),
        )
        .handle("requestFleetUpdate", ({ payload }) =>
          Effect.gen(function* () {
            yield* noStore;
            const worker = yield* requireFleetPrimary(payload.coordinatorEnvironmentId);
            const ask = FleetUpdate.fleetUpdateAskOf(payload);
            const result = yield* worker.request(ask);
            yield* Effect.logInfo("Fleet primary asked this machine to update.", {
              coordinatorEnvironmentId: payload.coordinatorEnvironmentId,
              ask:
                "version" in ask
                  ? `${ask.mode} ${ask.version}`
                  : "cancel" in ask
                    ? "cancel"
                    : "check",
              result: result.result,
            });
            return result;
          }),
        )
        .handle("fleetUpdateStatus", ({ query }) =>
          Effect.gen(function* () {
            yield* noStore;
            const worker = yield* requireFleetPrimary(query.coordinatorEnvironmentId);
            return yield* worker.status;
          }),
        )
        .handle("fleetDiskRoom", ({ query }) =>
          Effect.gen(function* () {
            yield* noStore;
            const worker = yield* requireFleetPrimaryFor(
              fleetDiskRoom,
              query.coordinatorEnvironmentId,
              "This machine cannot report its disk room to its fleet primary.",
            );
            return yield* worker.report({ version: query.version, fullRead: query.fullRead });
          }),
        )
        .handle("requestFleetSkill", ({ payload }) =>
          Effect.gen(function* () {
            yield* noStore;
            const worker = yield* requireFleetSkillsPrimary(payload.coordinatorEnvironmentId);
            const ask = FleetSkills.fleetSkillAskOf(payload);
            const result = yield* worker.request(ask);
            yield* Effect.logInfo("Fleet primary asked this machine to install a skill.", {
              coordinatorEnvironmentId: payload.coordinatorEnvironmentId,
              skill: `${ask.skill}@${ask.version}`,
              scope: ask.scope,
              pin: ask.pin,
              requestId: result.requestId,
            });
            return result;
          }),
        )
        .handle("fleetSkillStatus", ({ query }) =>
          Effect.gen(function* () {
            yield* noStore;
            const worker = yield* requireFleetSkillsPrimary(query.coordinatorEnvironmentId);
            return yield* worker.status;
          }),
        )
        .handle("addFleetMachine", ({ payload }) =>
          Effect.gen(function* () {
            yield* noStore;
            // Adding a machine stores a credential for it, like allowing workers there.
            yield* requireGrantManager;
            yield* refuseByTeamRules(teamRulesMachineLinkRefusal);
            return yield* addMachine(payload.invitation, payload.label?.trim() || undefined);
          }),
        )
        .handle("inviteFleetMachine", ({ payload }) =>
          Effect.gen(function* () {
            // The answer holds a management credential: never cached, never logged.
            yield* noStore;
            // It mints an access-management session, like allowing workers.
            yield* requireGrantManager;
            yield* refuseByTeamRules(teamRulesMachineLinkRefusal);
            if (payload.via === "connect") {
              yield* refuseByTeamRules((state) => teamRulesReachRefusal(state, "connect"));
            }
            yield* requireInviteMaker(
              "Inviting this machine hands out full access to it, so it needs a sign-in that has full access here. Use Join a main machine in the SpecWithCode app on this machine, or run `specwithcode fleet invite --coordinator '<main-machine-environment-id>'` there. Replace <main-machine-environment-id> with the environment ID from Settings > Machines on your main machine. This explicitly approves that machine to manage access here.",
            );
            return yield* issueInvitation(payload);
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
            yield* refuseByTeamRules(teamRulesMachineLinkRefusal);
            // The tunnel takes a few seconds to stop, and this answer holds a credential.
            yield* refuseByTeamRules((state) =>
              arrivedOverConnect(request) ? refusedConnect(state) : null,
            );
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
            yield* refuseByTeamRules(teamRulesMachineLinkRefusal);
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
        // A coordinator adds itself here from a line its own machine made and
        // lets itself run workers, so the owner allows them from that machine.
        .handle("selfAllowFleetWorkers", ({ payload }) =>
          Effect.gen(function* () {
            yield* noStore;
            const session = yield* requireEnvironmentScope(AuthAccessWriteScope);
            const principal = session.principal;
            if (principal?.kind !== "coordinator")
              return yield* new EnvironmentHttpForbiddenError({
                message:
                  "Only a main machine, with the management token it holds here, can add itself to this machine's list.",
              });
            const invite = yield* Effect.try({
              try: () => decodeFleetJoinCode(payload.invitation),
              catch: joinFailure,
            });
            // A coordinator key may add and allow only its own machine.
            if (invite.environmentId !== principal.environmentId)
              return yield* new EnvironmentHttpForbiddenError({
                message:
                  "This line names a different machine. A main machine can add and allow only itself here.",
              });
            yield* refuseByTeamRules(teamRulesMachineLinkRefusal);
            const { added, workers } = yield* addAndAllowWorkers(
              payload.invitation,
              payload.access,
            );
            yield* Effect.logInfo("A main machine added itself and allowed its workers here.", {
              coordinatorEnvironmentId: principal.environmentId,
              machine: added.id,
              change: added.change,
            });
            return { id: added.id, workers };
          }),
        )
        // The owner, on another machine of the same SpecWithCode Connect
        // account, lets this machine's agents work there: that app made the
        // line on its own machine and hands it over through its Connect
        // sign-in here. The relay proved that sign-in is this machine's own
        // account, and it already carries terminal and file access here, so
        // the line needs no second approval on this machine.
        .handle("accountJoinFleetWorkers", ({ payload }) =>
          Effect.gen(function* () {
            // The line holds a credential: never cached, never logged.
            yield* noStore;
            const session = yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
            if (!isConnectSubject(session.subject) || session.principal !== undefined)
              return yield* new EnvironmentHttpForbiddenError({
                message:
                  "Only a sign-in through this machine's own SpecWithCode Connect account can add a machine this way. Use Join a main machine on the other machine, then Add a machine here.",
              });
            // A phone signs in through Connect too. It is known by its own word,
            // so this keeps the app's phones out of it, not a forged client.
            if (isPhoneSession({ subject: session.subject, deviceType: session.clientDeviceType }))
              return yield* new EnvironmentHttpForbiddenError({
                message:
                  "A phone cannot add a machine. Open the SpecWithCode desktop app on the machine that should take work, then choose Allow there.",
              });
            yield* refuseByTeamRules(teamRulesMachineLinkRefusal);
            yield* refuseByTeamRules((state) => teamRulesReachRefusal(state, "connect"));
            // The owner's own machine: its grant renews by itself.
            const { added, workers } = yield* addAndAllowWorkers(
              payload.invitation,
              payload.access,
              true,
            );
            yield* Effect.logInfo("A machine of this Connect account joined and was allowed.", {
              machine: added.id,
              environmentId: added.environmentId,
              change: added.change,
            });
            return { id: added.id, workers };
          }),
        )
        // The owner lets a fleet machine run workers here from this machine:
        // this machine invites it, then asks it to add and allow this one with
        // the management token held there.
        .handle("allowIncomingFleetWorkers", ({ payload }) =>
          Effect.gen(function* () {
            // The line sent holds a credential: never cached, never logged.
            yield* noStore;
            yield* requireGrantManager;
            yield* refuseByTeamRules(teamRulesMachineLinkRefusal);
            yield* refuseByTeamRules((state) => teamRulesReachRefusal(state, "connect"));
            yield* requireInviteMaker(
              "Letting another machine run workers here hands out full access to this machine, so it needs a sign-in that has full access here.",
            );
            const fleetConfig = yield* attempt(() => readFleetConfig(config.baseDir));
            const target = fleetConfig?.machines.find((machine) => machine.id === payload.id);
            if (target === undefined)
              return yield* new EnvironmentHttpBadRequestError({
                message: new FleetError("unknown-machine").message,
              });
            const token = target.managementToken;
            if (token === undefined)
              return yield* new EnvironmentHttpBadRequestError({
                message: `No management token is saved here for ${target.label}. On ${target.label}, choose Join a main machine in Settings > Machines and add the line here first.`,
              });
            const remote = yield* attempt(async () => {
              const reached = await reachFleetMachine(fleetLink, target, { token });
              return checkIdentity(fleetLink.fetch, {
                url: reached.origin,
                environmentId: target.environmentId,
              });
            });
            if ((remote.capabilities as Record<string, unknown>).fleetSelfAllowWorkers !== true)
              return yield* new EnvironmentHttpBadRequestError({
                message: `${target.label} runs an older SpecWithCode; update it, then try again.`,
              });
            const descriptor = yield* serverEnvironment.getDescriptor;
            const issued = yield* issueInvitation({
              coordinatorEnvironmentId: target.environmentId,
              label: descriptor.label,
              via: "connect",
            });
            // Without that machine's answer the line is revoked here; once it is
            // spent, that machine itself takes back what it added (self-allow).
            const revokeIssued = Effect.all([
              issued.pairingId === undefined
                ? Effect.void
                : environmentAuth.revokePairingLink(issued.pairingId),
              issued.sessionId === undefined
                ? Effect.void
                : environmentAuth.revokeSession(issued.sessionId),
            ]).pipe(Effect.ignore);
            const answer = yield* Effect.tryPromise({
              try: async () => {
                const { response } = await fleetRequest(
                  fleetLink,
                  target,
                  "/api/studio/fleet/workers/self-allow",
                  {
                    method: "POST",
                    token,
                    headers: { "content-type": "application/json" },
                    body: encodeSelfAllow({ invitation: issued.code, access: payload.access }),
                    timeoutMs: 60_000,
                  },
                );
                const body = await readBoundedJson(response).catch(() => null);
                return { ok: response.ok, status: response.status, body };
              },
              catch: (error) =>
                new EnvironmentHttpInternalServerError({
                  message: (error instanceof FleetError ? error : new FleetError("unreachable"))
                    .message,
                }),
            }).pipe(Effect.tapError(() => revokeIssued));
            if (!answer.ok) {
              yield* revokeIssued;
              const said =
                typeof answer.body === "object" &&
                answer.body !== null &&
                "message" in answer.body &&
                typeof answer.body.message === "string"
                  ? answer.body.message
                  : `${target.label} answered HTTP ${answer.status}.`;
              const message = `${target.label} refused: ${said}`;
              return yield* answer.status === 401 || answer.status === 403
                ? Effect.fail(new EnvironmentHttpForbiddenError({ message }))
                : Effect.fail(new EnvironmentHttpBadRequestError({ message }));
            }
            const result = decodeWorkersResult(answer.body);
            if (Option.isNone(result)) {
              yield* revokeIssued;
              return yield* new EnvironmentHttpInternalServerError({
                message: `${target.label} gave no answer about its workers.`,
              });
            }
            yield* Effect.logInfo("Asked a fleet machine to add and allow this one.", {
              machine: target.id,
              workers: result.value.workers.status,
            });
            return result.value;
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
                  revokeWorkerAccess,
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
              catch: joinFailure,
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
            yield* refuseByTeamRules((state) => teamRulesReachRefusal(state, "phones"));
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
            yield* refuseByTeamRules((state) => teamRulesReachRefusal(state, "phones"));
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
).pipe(Layer.provide(ReleaseRuns.layer));
