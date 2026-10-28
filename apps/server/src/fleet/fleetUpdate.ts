/**
 * Fleet updates over SpecWithCode Connect (increment 1119).
 *
 * The fleet primary asks one of its machines to install a published release
 * with the management token it already holds there, over whichever address
 * answers (Connect first in practice, Tailscale when it is on). This machine
 * does the install the way its own app would:
 *
 * - a macOS service: the drain and hold Update now makes
 *   (`ServiceUpdatePreparation.prepare`), then a forced install request to
 *   its update agent (`update_request.py request --force`), which installs
 *   only a release it downloaded and verified against the release's
 *   SHA256SUMS;
 * - a Linux boot service: the server self-update (`ServerSelfUpdate.update`),
 *   which downloads the release archive and checks it against the release
 *   checksums before the launcher switches over.
 *
 * The request path is narrow on purpose: install a newer published version,
 * cancel a request this path wrote (never one Update now or anything else on
 * the machine wrote), look for a release, read status. Nothing in
 * the payload names a path, command or URL. It narrows the path, not the
 * token: tokens issued before `fleet:update` still carry their broad scopes.
 *
 * The answer comes before the drain or download, since a Connect response is
 * cut off after about 100 s and a held drain can take 150 s; the primary
 * reads progress with the status call.
 */
import {
  AuthEnvironmentMaintainScope,
  AuthFleetUpdateScope,
  type AuthEnvironmentScope,
  type ServerPrepareServiceUpdateError,
  type ServerPrepareServiceUpdateInput,
  type ServerPrepareServiceUpdateResult,
  type ServerSelfUpdateProgressStage,
  StudioFleetUpdateError,
  WS_METHODS,
  WsRpcGroup,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
} from "@specweave-studio/contracts";
import type {
  StudioFleetUpdateInput,
  StudioFleetUpdateMethod,
  StudioFleetUpdatePhase,
  StudioFleetUpdateRefusal,
  StudioFleetUpdateRequestRecord,
  StudioFleetUpdateResult,
  StudioFleetUpdateStatus,
} from "@specweave-studio/contracts/studioFleet";
import {
  CLI_RELEASE_BASE_URL_ENV,
  CLI_RELEASE_CHECKSUMS_FILE,
  chooseCliArchive,
  cliArchivePlatformKey,
  cliReleaseDownloadBaseUrl,
  parseChecksums,
} from "@specweave-studio/shared/cliRelease";
import { HostProcessArchitecture, HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { RpcClient } from "effect/rpc";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";

import * as ServerConfig from "../config.ts";
import * as ServerSelfUpdate from "../cloud/selfUpdate.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { installedManagedUpdateHelper } from "../managedUpdates/ManagedUpdatesService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServiceUpdatePreparation from "../serviceUpdate/ServiceUpdatePreparation.ts";
import { checkIdentity, FleetError, type FleetTarget, readBoundedJson } from "../studioFleet.ts";
import { type FleetLink, fleetRequest, reachFleetMachine } from "./fleetTransport.ts";

// ---------------------------------------------------------------------------
// Shared rules
// ---------------------------------------------------------------------------

/** `X.Y.Z` as numbers, or null for anything else (ranges, tags, prereleases). */
export function parseReleaseVersion(value: unknown): readonly [number, number, number] | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,4})\.(\d{1,5})\.(\d{1,6})$/.exec(value.trim());
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Negative when `a` is older than `b`, 0 when equal, positive when newer; null when either is not `X.Y.Z`. */
export function compareReleaseVersions(a: unknown, b: unknown): number | null {
  const left = parseReleaseVersion(a);
  const right = parseReleaseVersion(b);
  if (left === null || right === null) return null;
  for (let index = 0; index < 3; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Whether a session may use the fleet update path: the fleet primary's own
 * management token (a coordinator principal for `coordinatorEnvironmentId`)
 * holding `fleet:update`, or `environment:maintain` for tokens issued before
 * that scope existed.
 */
export function fleetUpdateAllowed(
  session: {
    readonly principal?: { readonly kind: string; readonly environmentId?: string } | undefined;
    readonly scopes: ReadonlySet<AuthEnvironmentScope>;
  },
  coordinatorEnvironmentId: string,
): boolean {
  return (
    session.principal?.kind === "coordinator" &&
    session.principal.environmentId === coordinatorEnvironmentId &&
    (session.scopes.has(AuthFleetUpdateScope) || session.scopes.has(AuthEnvironmentMaintainScope))
  );
}

/** Agent states in which a release is on its way (fleet_rollout.PENDING_STATUSES). */
const PENDING_STATUSES = new Set([
  "available",
  "downloading",
  "downloaded",
  "waiting-for-quiet",
  "installing",
]);

/**
 * True when the update agent offers `version` in a way the service holds for:
 * the check fleet_rollout.offers and ServiceUpdateHold make before a hold.
 */
export function agentOffers(status: Record<string, unknown>, version: string): boolean {
  const offered = status.downloadedVersion ?? status.availableVersion;
  if (offered !== version) return false;
  if (typeof status.status === "string" && PENDING_STATUSES.has(status.status)) return true;
  const older = compareReleaseVersions(status.installedVersion, version);
  return older !== null && older < 0;
}

/** True while a forced request stands on the host (fleet_rollout.forced_pending). */
export function forcedPending(status: Record<string, unknown>, now: number): boolean {
  const time = (value: unknown) =>
    typeof value === "string" && !Number.isNaN(Date.parse(value)) ? Date.parse(value) : null;
  const asked = time(status.installRequestedAt);
  const cancelled = time(status.installCancelledAt);
  const until = time(status.installHoldUntil);
  if (status.installMode !== "force" || asked === null || until === null) return false;
  if (cancelled !== null && cancelled >= asked) return false;
  return until > now;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** The install request as `update_request.py` reports it. */
export function requestRecordOf(value: unknown): StudioFleetUpdateRequestRecord | undefined {
  if (!record(value)) return undefined;
  const request = record(value.installRequest) ? value.installRequest : null;
  return {
    installRequestedAt: text(value.installRequestedAt),
    installMode: text(value.installMode),
    installHoldUntil: text(value.installHoldUntil),
    installRequest:
      request !== null && typeof request.at === "string" && typeof request.version === "string"
        ? { at: request.at, version: request.version }
        : null,
  };
}

// ---------------------------------------------------------------------------
// This machine: the worker side
// ---------------------------------------------------------------------------

/** What the update request asks, without the caller's identity. */
export type FleetUpdateAsk =
  | {
      readonly version: string;
      readonly mode: "force" | "normal";
      readonly holdMinutes?: number | undefined;
    }
  | { readonly cancel: string }
  | { readonly check: true };

export const fleetUpdateAskOf = (input: StudioFleetUpdateInput): FleetUpdateAsk => {
  const fields = input as Record<string, unknown>;
  if (typeof fields.cancel === "string") return { cancel: fields.cancel };
  if (fields.check === true) return { check: true };
  return {
    version: String(fields.version),
    mode: fields.mode === "normal" ? "normal" : "force",
    ...(typeof fields.holdMinutes === "number" ? { holdMinutes: fields.holdMinutes } : {}),
  };
};

export class FleetUpdateWorker extends Context.Service<
  FleetUpdateWorker,
  {
    readonly request: (
      ask: FleetUpdateAsk,
    ) => Effect.Effect<StudioFleetUpdateResult, StudioFleetUpdateError>;
    readonly status: Effect.Effect<StudioFleetUpdateStatus, StudioFleetUpdateError>;
  }
>()("specweave-studio/fleet/fleetUpdate/FleetUpdateWorker") {}

/** The longest a forced install request keeps the service held (update_request.HOLD_MAX_MINUTES). */
export const FLEET_UPDATE_HOLD_MAX_MINUTES = 15;

export interface FleetUpdateWorkerDeps {
  readonly serverVersion: string;
  /** How this machine installs, or null when it cannot take a request (desktop app, foreground run). */
  readonly method: Effect.Effect<StudioFleetUpdateMethod | null>;
  /** `update_request.py <args> --identity <this machine>`: its JSON answer, `error` included. */
  readonly agent: (args: ReadonlyArray<string>) => Effect.Effect<Record<string, unknown>>;
  /** The drain and hold Update now makes. */
  readonly prepare: (
    input: ServerPrepareServiceUpdateInput,
  ) => Effect.Effect<ServerPrepareServiceUpdateResult, ServerPrepareServiceUpdateError>;
  /** True when `version` is a published release with an archive for this platform. */
  readonly releasePublished: (version: string) => Effect.Effect<boolean>;
  /** The boot service's self-update to `version`. */
  readonly selfUpdate: (
    version: string,
    report: (stage: ServerSelfUpdateProgressStage) => Effect.Effect<void>,
  ) => Effect.Effect<unknown, { readonly reason: string }>;
}

interface WorkerState {
  readonly phase: StudioFleetUpdatePhase;
  readonly targetVersion?: string;
  readonly lastError?: string;
  readonly lastErrorReason?: StudioFleetUpdateRefusal;
  readonly request?: StudioFleetUpdateRequestRecord;
}

const IN_FLIGHT: ReadonlySet<StudioFleetUpdatePhase> = new Set([
  "draining",
  "requesting",
  "downloading",
  "installing",
]);

const refuse = (reason: StudioFleetUpdateRefusal, message: string) =>
  new StudioFleetUpdateError({ reason, message });

const agentError = (answer: Record<string, unknown>): string | null =>
  typeof answer.error === "string" ? answer.error : null;

export const makeFleetUpdateWorker = (deps: FleetUpdateWorkerDeps) =>
  Effect.gen(function* () {
    const state = yield* Ref.make<WorkerState>({ phase: "idle" });
    const set = (next: WorkerState) => Ref.set(state, next);
    /** `installRequestedAt` of each request this path wrote: the only ones it may cancel. */
    const written = yield* Ref.make<ReadonlySet<string>>(new Set());
    /** True while this path holds the service: the only hold it may release. */
    const heldHere = yield* Ref.make(false);
    const remember = (request: StudioFleetUpdateRequestRecord | undefined) =>
      request?.installRequestedAt == null
        ? Effect.void
        : Ref.update(written, (stamps) => new Set([...stamps, request.installRequestedAt!]));
    /** One request at a time: claimed before the first await, so two cannot both pass the busy check. */
    const claimed = yield* Ref.make(false);
    const exclusive = <A, E>(
      effect: Effect.Effect<A, E>,
    ): Effect.Effect<A, E | StudioFleetUpdateError> =>
      Ref.modify(claimed, (taken) => [!taken, true] as const).pipe(
        Effect.flatMap((acquired): Effect.Effect<A, E | StudioFleetUpdateError> =>
          acquired
            ? effect.pipe(Effect.ensuring(Ref.set(claimed, false)))
            : Effect.fail(
                refuse(
                  "busy",
                  "Another update request is being handled here; read its progress with the status call.",
                ),
              ),
        ),
      );
    const fail = (
      current: WorkerState,
      reason: StudioFleetUpdateRefusal,
      message: string,
    ): WorkerState => ({
      phase: "failed",
      ...(current.targetVersion === undefined ? {} : { targetVersion: current.targetVersion }),
      lastError: message,
      lastErrorReason: reason,
    });

    const requireMethod = Effect.gen(function* () {
      const method = yield* deps.method;
      if (method === null)
        return yield* refuse(
          "unsupported",
          "This machine installs updates through its SpecWithCode app, not a background service; choose Update now there.",
        );
      return method;
    });

    const agent = (args: ReadonlyArray<string>) =>
      deps.agent(args).pipe(
        Effect.flatMap((answer) => {
          const error = agentError(answer);
          return error === null ? Effect.succeed(answer) : Effect.fail(refuse("failed", error));
        }),
      );

    /** The forced install: drain and hold, then the request, as Update now does. */
    const forcedInstall = (version: string, holdMinutes: number) =>
      Effect.gen(function* () {
        const prepared = yield* deps
          .prepare({ stopWork: true, hold: true, reason: "install" })
          .pipe(Effect.option);
        if (Option.isNone(prepared) || prepared.value.held !== true) {
          yield* set(
            fail(
              { phase: "draining", targetVersion: version },
              "not-held",
              Option.isNone(prepared)
                ? "The service could not stop its work for the update; nothing was requested."
                : "The service did not hold for the update (its update agent has no release on the way); nothing was requested.",
            ),
          );
          return;
        }
        yield* Ref.set(heldHere, true);
        yield* set({ phase: "requesting", targetVersion: version });
        const answer = yield* deps.agent([
          "request",
          "--version",
          version,
          "--force",
          "--hold-minutes",
          String(holdMinutes),
          "--kickstart",
        ]);
        const error = agentError(answer);
        if (error !== null) {
          // Nobody would release a hold no request follows: let work start again now.
          yield* deps.prepare({ stopWork: false, releaseHold: true }).pipe(Effect.ignore);
          yield* Ref.set(heldHere, false);
          yield* set(fail({ phase: "requesting", targetVersion: version }, "failed", error));
          return;
        }
        const request = requestRecordOf(answer.request);
        yield* remember(request);
        yield* set({
          phase: answer.result === "already-installed" ? "idle" : "requested",
          targetVersion: version,
          ...(request === undefined ? {} : { request }),
        });
      });

    const started = (
      method: StudioFleetUpdateMethod,
      ask: Extract<FleetUpdateAsk, { version: string }>,
    ) =>
      Effect.gen(function* () {
        const version = ask.version;
        const current = yield* Ref.get(state);
        if (IN_FLIGHT.has(current.phase))
          return yield* refuse(
            "busy",
            `An update to ${current.targetVersion ?? "a new release"} is already ${current.phase} here.`,
          );

        if (method === "boot-service") {
          if (!(yield* deps.releasePublished(version)))
            return yield* refuse(
              "unknown-version",
              `${version} is not a published release with an archive for this machine.`,
            );
          yield* set({ phase: "downloading", targetVersion: version });
          yield* deps
            .selfUpdate(version, (stage) => set({ phase: stage, targetVersion: version }))
            .pipe(
              Effect.matchEffect({
                onFailure: (error) =>
                  set(
                    fail({ phase: "downloading", targetVersion: version }, "failed", error.reason),
                  ),
                onSuccess: () => set({ phase: "handed-off", targetVersion: version }),
              }),
              Effect.forkDetach,
            );
          return {
            method,
            result: "accepted" as const,
            phase: "downloading" as const,
            serverVersion: deps.serverVersion,
          };
        }

        const status = yield* agent(["status"]);
        const offered = status.downloadedVersion ?? status.availableVersion;
        const newer = compareReleaseVersions(offered, version);
        if (newer !== null && newer > 0)
          return yield* refuse(
            "not-offered",
            `The update agent here offers ${String(offered)}, newer than ${version}; ask for ${String(offered)}.`,
          );
        if (!agentOffers(status, version)) {
          // Its feed lists only published releases, each checked against SHA256SUMS.
          yield* agent(["check", "--kickstart"]);
          yield* set({ phase: "checking", targetVersion: version });
          return {
            method,
            result: "checking" as const,
            phase: "checking" as const,
            serverVersion: deps.serverVersion,
          };
        }
        if (ask.mode === "normal") {
          const answer = yield* agent(["request", "--version", version, "--kickstart"]);
          const request = requestRecordOf(answer.request);
          yield* remember(request);
          const installed = answer.result === "already-installed";
          yield* set({
            phase: installed ? "idle" : "requested",
            targetVersion: version,
            ...(request === undefined ? {} : { request }),
          });
          return {
            method,
            result: installed ? ("already-installed" as const) : ("requested" as const),
            phase: installed ? ("idle" as const) : ("requested" as const),
            serverVersion: deps.serverVersion,
            ...(request === undefined ? {} : { request }),
          };
        }
        const holdMinutes = Math.min(
          FLEET_UPDATE_HOLD_MAX_MINUTES,
          Math.max(1, ask.holdMinutes ?? FLEET_UPDATE_HOLD_MAX_MINUTES),
        );
        yield* set({ phase: "draining", targetVersion: version });
        yield* forcedInstall(version, holdMinutes).pipe(
          Effect.catchCause(() =>
            set(
              fail(
                { phase: "draining", targetVersion: version },
                "failed",
                "The update request stopped unexpectedly.",
              ),
            ),
          ),
          Effect.forkDetach,
        );
        return {
          method,
          result: "accepted" as const,
          phase: "draining" as const,
          serverVersion: deps.serverVersion,
        };
      });

    const install = (
      method: StudioFleetUpdateMethod,
      ask: Extract<FleetUpdateAsk, { version: string }>,
    ) =>
      Effect.gen(function* () {
        const version = ask.version;
        const order = compareReleaseVersions(version, deps.serverVersion);
        if (order === null && parseReleaseVersion(version) === null)
          return yield* refuse("unknown-version", `${version} is not an exact release version.`);
        if (order === 0)
          return {
            method,
            result: "already-installed" as const,
            phase: (yield* Ref.get(state)).phase,
            serverVersion: deps.serverVersion,
          };
        if (order !== null && order < 0)
          return yield* refuse(
            "downgrade",
            `This machine runs ${deps.serverVersion}, newer than ${version}; a fleet update never installs an older release.`,
          );
        return yield* exclusive(started(method, ask));
      });

    const cancel = (method: StudioFleetUpdateMethod, request: string) =>
      Effect.gen(function* () {
        if (method !== "service-agent")
          return yield* refuse(
            "unsupported",
            "A boot-service update cannot be cancelled once it was asked for.",
          );
        if (!(yield* Ref.get(written)).has(request))
          return yield* refuse(
            "unsupported",
            "That install request was not made through the fleet update path, so it is not cancelled from here; choose Cancel update on that machine.",
          );
        yield* agent(["cancel", "--request", request]);
        yield* Ref.update(written, (stamps) => new Set([...stamps].filter((at) => at !== request)));
        const status = yield* agent(["status"]);
        const current = yield* Ref.get(state);
        const installing = status.status === "installing";
        // Release only the hold this path placed, and only when nothing still needs it
        // (fleet_rollout.release).
        if (
          (yield* Ref.get(heldHere)) &&
          !installing &&
          !forcedPending(status, yield* Clock.currentTimeMillis)
        ) {
          yield* deps.prepare({ stopWork: false, releaseHold: true }).pipe(Effect.ignore);
          yield* Ref.set(heldHere, false);
        }
        yield* set({
          phase: "cancelled",
          ...(current.targetVersion === undefined ? {} : { targetVersion: current.targetVersion }),
        });
        return {
          method,
          result: "cancelled" as const,
          phase: "cancelled" as const,
          serverVersion: deps.serverVersion,
        };
      });

    const request = (ask: FleetUpdateAsk) =>
      Effect.gen(function* () {
        const method = yield* requireMethod;
        if ("cancel" in ask) return yield* exclusive(cancel(method, ask.cancel));
        if ("check" in ask) {
          if (method === "service-agent") yield* agent(["check", "--kickstart"]);
          return {
            method,
            result: "check-requested" as const,
            phase: (yield* Ref.get(state)).phase,
            serverVersion: deps.serverVersion,
          };
        }
        return yield* install(method, ask);
      });

    const status = Effect.gen(function* () {
      const method = yield* requireMethod;
      const current = yield* Ref.get(state);
      const base: StudioFleetUpdateStatus = {
        method,
        serverVersion: deps.serverVersion,
        phase: current.phase,
        ...(current.targetVersion === undefined ? {} : { targetVersion: current.targetVersion }),
        ...(current.lastError === undefined ? {} : { lastError: current.lastError }),
        ...(current.lastErrorReason === undefined
          ? {}
          : { lastErrorReason: current.lastErrorReason }),
      };
      if (method !== "service-agent") return base;
      return { ...base, agent: yield* agent(["status"]) };
    });

    return FleetUpdateWorker.of({ request, status });
  });

/** The machine's identity as its update agent names it: the folder above its state dir. */
export function agentIdentityOf(path: Path.Path, stateDir: string): string | null {
  const identity = path.basename(path.dirname(stateDir));
  return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(identity) ? identity : null;
}

const AGENT_TIMEOUT = Duration.seconds(60);
const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);

/** The live worker: this server's update agent, drain, release feed and self-update. */
export const layer = Layer.effect(
  FleetUpdateWorker,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const runner = yield* ProcessRunner.ProcessRunner;
    const preparation = yield* ServiceUpdatePreparation.ServiceUpdatePreparation;
    const selfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const httpClient = yield* HttpClient.HttpClient;
    const path = yield* Path.Path;
    const platform = yield* HostProcessPlatform;
    const arch = yield* HostProcessArchitecture;
    const helperContext = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    const releaseBaseUrl = Option.getOrUndefined(
      yield* Config.String(CLI_RELEASE_BASE_URL_ENV).pipe(Config.option),
    );
    const descriptor = yield* environment.getDescriptor;
    const identity = agentIdentityOf(path, config.stateDir);
    // Resolved on each call: the agent's files can be installed or replaced while this runs.
    const requestScript = installedManagedUpdateHelper.pipe(
      Effect.provide(helperContext),
      Effect.map((helper) =>
        helper === null ? null : path.join(path.dirname(helper), "update_request.py"),
      ),
      Effect.orElseSucceed(() => null),
    );
    const method: Effect.Effect<StudioFleetUpdateMethod | null> = Effect.gen(function* () {
      if (config.mode === "desktop") return null;
      if (platform === "darwin" && identity !== null && (yield* requestScript) !== null)
        return "service-agent" as const;
      return descriptor.capabilities.serverSelfUpdate === "boot-service"
        ? ("boot-service" as const)
        : null;
    });
    const agent = (args: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const script = yield* requestScript;
        if (script === null || identity === null)
          return { error: "This machine has no SpecWithCode update agent." };
        const [command, ...rest] = args;
        const output = yield* runner
          .run({
            command: "/usr/bin/python3",
            args: ["-B", "-E", "-s", script, command!, "--identity", identity, ...rest],
            timeout: AGENT_TIMEOUT,
            maxOutputBytes: 64 * 1024,
            outputMode: "error",
          })
          .pipe(Effect.option);
        if (Option.isNone(output) || output.value.timedOut)
          return { error: "The update agent did not answer." };
        const last = output.value.stdout.trim().split("\n").at(-1) ?? "";
        const parsed = Schema.decodeOption(UnknownFromJsonString)(last);
        return Option.isSome(parsed) && record(parsed.value)
          ? parsed.value
          : { error: "The update agent gave no status." };
      });
    const releasePublished = (version: string) =>
      Effect.gen(function* () {
        const key = cliArchivePlatformKey(platform, arch);
        if (key === undefined) return false;
        const body = yield* httpClient
          .execute(
            HttpClientRequest.get(
              `${cliReleaseDownloadBaseUrl(version, releaseBaseUrl)}/${CLI_RELEASE_CHECKSUMS_FILE}`,
            ),
          )
          .pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap((response) => response.text),
            Effect.timeout(Duration.seconds(20)),
          );
        return chooseCliArchive(parseChecksums(body), version, key) !== undefined;
      }).pipe(Effect.orElseSucceed(() => false));
    return yield* makeFleetUpdateWorker({
      serverVersion: descriptor.serverVersion,
      method,
      agent,
      prepare: preparation.prepare,
      releasePublished,
      selfUpdate: (version, report) =>
        selfUpdate.update({ targetVersion: version }, (stage) => report(stage)),
    });
  }),
);

// ---------------------------------------------------------------------------
// The fleet primary: the client side
// ---------------------------------------------------------------------------

export type FleetUpdateFailureReason =
  | "unreachable"
  | "connect-unbound"
  | "connect-key-missing"
  | "identity-mismatch"
  | "unauthorized"
  | StudioFleetUpdateRefusal;

/** Why the primary could not get a fleet update done; `reason` is stable for scripts. */
export class FleetUpdateFailure extends Error {
  readonly reason: FleetUpdateFailureReason;
  constructor(reason: FleetUpdateFailureReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

export type FleetUpdateAction =
  | { readonly kind: "status" }
  | { readonly kind: "check" }
  | { readonly kind: "cancel"; readonly request: string }
  | {
      readonly kind: "request";
      readonly version: string;
      readonly hold: boolean;
      readonly holdMinutes?: number | undefined;
    };

/** One line of JSON for `fleet update --json`, shaped like `update_request.py`'s. */
export type FleetUpdateOutcome = Record<string, unknown>;

/** How the primary updates a boot-service machine that predates the fleet update endpoint. */
export type LegacySelfUpdate = (input: {
  readonly webSocketUrl: string;
  readonly version: string;
}) => Promise<void>;

export interface FleetUpdateClientInput {
  readonly link: FleetLink;
  readonly target: FleetTarget;
  readonly coordinatorEnvironmentId: string;
  readonly action: FleetUpdateAction;
  /** Older boot-service machines: `server.updateServer` over the machine's own socket. */
  readonly legacySelfUpdate?: LegacySelfUpdate;
  /** How long a forced request may take to drain and be written. */
  readonly waitMs?: number;
  readonly pollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Checks a version is published (its SHA256SUMS lists an archive for that platform). */
  readonly releasePublished?: (version: string, platformKey: string) => Promise<boolean>;
}

const STATUS_KEYS = [
  "identity",
  "version",
  "installFinalized",
  "status",
  "message",
  "availableVersion",
  "downloadedVersion",
  "installedVersion",
  "lastInstall",
  "installRequestedAt",
  "installMode",
  "installHoldUntil",
  "installCancelledAt",
  "installRequest",
] as const;

const transportOf = (origin: { readonly transport: string }) =>
  origin.transport === "connect" ? "connect" : "tailnet";

const fleetFailureOf = (error: unknown): FleetUpdateFailure => {
  if (error instanceof FleetUpdateFailure) return error;
  if (error instanceof FleetError) {
    const reason =
      error.kind === "connect-unbound" ||
      error.kind === "connect-key-missing" ||
      error.kind === "identity-mismatch"
        ? error.kind
        : error.kind === "pairing-unavailable" || error.kind === "forbidden"
          ? "unauthorized"
          : "unreachable";
    return new FleetUpdateFailure(reason, error.message);
  }
  return new FleetUpdateFailure(
    "unreachable",
    "This machine is unavailable over Connect or Tailscale.",
  );
};

/** The status line for a machine running the fleet update endpoint. */
export function flattenFleetUpdateStatus(
  status: StudioFleetUpdateStatus,
  transport: "connect" | "tailnet",
): FleetUpdateOutcome {
  const base: Record<string, unknown> = Object.fromEntries(STATUS_KEYS.map((key) => [key, null]));
  if (status.method === "service-agent" && status.agent !== undefined) {
    for (const key of STATUS_KEYS) if (key in status.agent) base[key] = status.agent[key];
  } else {
    const settling =
      status.phase === "downloading" || status.phase === "installing" || status.phase === "failed";
    base.version = status.serverVersion;
    base.installedVersion = status.serverVersion;
    base.availableVersion = status.targetVersion ?? null;
    base.status = status.phase;
    base.message = status.lastError ?? null;
    base.installFinalized =
      !settling &&
      (status.targetVersion === undefined || status.targetVersion === status.serverVersion);
  }
  return {
    ...base,
    transport,
    method: status.method,
    phase: status.phase,
    serverVersion: status.serverVersion,
    ...(status.lastError === undefined ? {} : { lastError: status.lastError }),
    ...(status.lastErrorReason === undefined ? {} : { lastErrorReason: status.lastErrorReason }),
  };
}

async function answerOf(response: Response): Promise<unknown> {
  return readBoundedJson(response).catch(() => null);
}

/** A refusal answer from the worker, as a failure. */
async function refusalOf(response: Response): Promise<FleetUpdateFailure> {
  const body = await answerOf(response);
  const message =
    record(body) && typeof body.message === "string"
      ? body.message
      : `The machine answered HTTP ${response.status}.`;
  if (response.status === 401 || response.status === 403)
    return new FleetUpdateFailure(
      "unauthorized",
      `The management token saved for this machine is not allowed to update it (${message}). On that machine choose Invite this machine again and add the new line here.`,
    );
  if (record(body) && body._tag === "StudioFleetUpdateError" && typeof body.reason === "string")
    return new FleetUpdateFailure(body.reason as StudioFleetUpdateRefusal, message);
  return new FleetUpdateFailure("failed", message);
}

const defaultSleep = (ms: number) => Effect.runPromise(Effect.sleep(Duration.millis(ms)));
const nowMillis = () => Effect.runSync(Clock.currentTimeMillis);
const isoNow = () => DateTime.formatIso(DateTime.makeUnsafe(nowMillis()));

/** The public `/.well-known` descriptor GitHub release check for an older boot-service machine. */
async function defaultReleasePublished(
  fetcher: typeof fetch,
  version: string,
  platformKey: string,
): Promise<boolean> {
  try {
    const response = await fetcher(
      `${cliReleaseDownloadBaseUrl(version, process.env[CLI_RELEASE_BASE_URL_ENV])}/${CLI_RELEASE_CHECKSUMS_FILE}`,
      { redirect: "follow", signal: AbortSignal.timeout(20_000) },
    );
    if (!response.ok) return false;
    const key = cliArchivePlatformKey(
      platformKey.split("-")[0] as NodeJS.Platform,
      platformKey.split("-")[1] ?? "",
    );
    return (
      key !== undefined &&
      chooseCliArchive(parseChecksums(await response.text()), version, key) !== undefined
    );
  } catch {
    return false;
  }
}

/**
 * Runs one `fleet update` action against `target` from the primary, over its
 * first address that answers as that machine and accepts the token.
 */
export async function runFleetUpdate(input: FleetUpdateClientInput): Promise<FleetUpdateOutcome> {
  const { link, target, action } = input;
  const token = target.managementToken;
  if (token === undefined)
    throw new FleetUpdateFailure(
      "unauthorized",
      `No management token is saved for ${target.label}. On that machine choose Invite this machine and add the line here.`,
    );
  let reached;
  let descriptor;
  try {
    reached = await reachFleetMachine(link, target, { token });
    descriptor = await checkIdentity(link.fetch, {
      url: reached.origin,
      environmentId: target.environmentId,
    });
  } catch (error) {
    throw fleetFailureOf(error);
  }
  const transport = transportOf(reached);
  const capabilities = descriptor.capabilities as Record<string, unknown>;
  if (capabilities.fleetUpdateRequest === true)
    return runOverEndpoint({ ...input, token, transport });
  if (capabilities.serverSelfUpdate === "boot-service")
    return runLegacyBootService({
      ...input,
      token,
      transport,
      serverVersion: descriptor.serverVersion,
      platformKey: `${descriptor.platform.os}-${descriptor.platform.arch}`,
    });
  if (action.kind === "status")
    return {
      ...Object.fromEntries(STATUS_KEYS.map((key) => [key, null])),
      version: descriptor.serverVersion,
      transport,
      method: null,
      phase: "idle",
      serverVersion: descriptor.serverVersion,
    };
  throw new FleetUpdateFailure(
    "unsupported",
    `${target.label} runs ${descriptor.serverVersion}, which cannot take update requests from here; its update agent installs automatically, or choose Update now there.`,
  );
}

async function runOverEndpoint(
  input: FleetUpdateClientInput & {
    readonly token: string;
    readonly transport: "connect" | "tailnet";
  },
): Promise<FleetUpdateOutcome> {
  const { link, target, token, action, coordinatorEnvironmentId } = input;
  const sleep = input.sleep ?? defaultSleep;
  const readStatus = async (): Promise<FleetUpdateOutcome> => {
    let response: Response;
    let address;
    try {
      ({ response, address } = await fleetRequest(
        link,
        target,
        `/api/studio/fleet/update?coordinatorEnvironmentId=${encodeURIComponent(coordinatorEnvironmentId)}`,
        { method: "GET", token, idempotent: true, timeoutMs: 75_000 },
      ));
    } catch (error) {
      throw fleetFailureOf(error);
    }
    if (!response.ok) throw await refusalOf(response);
    const body = await answerOf(response);
    if (!record(body) || typeof body.method !== "string" || typeof body.phase !== "string")
      throw new FleetUpdateFailure("failed", "The machine gave no update status.");
    return flattenFleetUpdateStatus(
      body as unknown as StudioFleetUpdateStatus,
      transportOf(address),
    );
  };
  if (action.kind === "status") return readStatus();
  const payload =
    action.kind === "cancel"
      ? { coordinatorEnvironmentId, cancel: action.request }
      : action.kind === "check"
        ? { coordinatorEnvironmentId, check: true }
        : {
            coordinatorEnvironmentId,
            version: action.version,
            mode: action.hold ? "force" : "normal",
            ...(action.holdMinutes === undefined ? {} : { holdMinutes: action.holdMinutes }),
          };
  let response: Response;
  let address;
  try {
    ({ response, address } = await fleetRequest(link, target, "/api/studio/fleet/update", {
      method: "POST",
      token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      timeoutMs: 75_000,
    }));
  } catch (error) {
    throw fleetFailureOf(error);
  }
  if (!response.ok) throw await refusalOf(response);
  const body = await answerOf(response);
  if (!record(body) || typeof body.result !== "string")
    throw new FleetUpdateFailure("failed", "The machine gave no answer to the update request.");
  const accepted = body as unknown as StudioFleetUpdateResult;
  const common = {
    identity: target.id,
    transport: transportOf(address),
    method: accepted.method,
    phase: accepted.phase,
    serverVersion: accepted.serverVersion,
  };
  if (action.kind !== "request" || accepted.result !== "accepted")
    return {
      ...common,
      result: accepted.result,
      ...(accepted.request === undefined ? {} : { request: accepted.request }),
    };
  if (accepted.method === "boot-service")
    return {
      ...common,
      result: "requested",
      request: {
        installRequestedAt: null,
        installMode: "self-update",
        installHoldUntil: null,
        installRequest: { at: isoNow(), version: action.version },
      },
    };
  // A forced request: wait for the drain and the request it writes.
  const deadline = nowMillis() + (input.waitMs ?? 200_000);
  for (;;) {
    await sleep(input.pollMs ?? 3_000);
    const status = await readStatus();
    if (status.phase === "requested" || status.phase === "idle")
      return {
        ...common,
        phase: status.phase,
        result: status.phase === "idle" ? "already-installed" : "requested",
        request: requestRecordOf(status) ?? null,
      };
    if (status.phase === "failed")
      throw new FleetUpdateFailure(
        (typeof status.lastErrorReason === "string"
          ? status.lastErrorReason
          : "failed") as StudioFleetUpdateRefusal,
        typeof status.lastError === "string" ? status.lastError : "The update request failed.",
      );
    if (nowMillis() >= deadline)
      throw new FleetUpdateFailure(
        "busy",
        `${target.label} is still ${String(status.phase)} for the update; read its progress with --status.`,
      );
  }
}

async function runLegacyBootService(
  input: FleetUpdateClientInput & {
    readonly token: string;
    readonly transport: "connect" | "tailnet";
    readonly serverVersion: string;
    readonly platformKey: string;
  },
): Promise<FleetUpdateOutcome> {
  const { link, target, token, action, serverVersion, transport } = input;
  if (action.kind === "status")
    return {
      ...Object.fromEntries(STATUS_KEYS.map((key) => [key, null])),
      identity: target.id,
      version: serverVersion,
      installedVersion: serverVersion,
      installFinalized: true,
      status: "idle",
      transport,
      method: "boot-service",
      phase: "idle",
      serverVersion,
    };
  if (action.kind !== "request")
    throw new FleetUpdateFailure(
      "unsupported",
      `${target.label} runs ${serverVersion}, which can only be asked to install a version from here.`,
    );
  // This machine predates the guards the endpoint makes, so the primary makes them.
  const order = compareReleaseVersions(action.version, serverVersion);
  if (order === 0)
    return {
      identity: target.id,
      transport,
      method: "boot-service",
      result: "already-installed",
      version: serverVersion,
    };
  if (order === null || order < 0)
    throw new FleetUpdateFailure(
      order === null ? "unknown-version" : "downgrade",
      order === null
        ? `${action.version} or ${serverVersion} is not an exact release version.`
        : `${target.label} runs ${serverVersion}, newer than ${action.version}; a fleet update never installs an older release.`,
    );
  const published = await (
    input.releasePublished ?? ((version, key) => defaultReleasePublished(link.fetch, version, key))
  )(action.version, input.platformKey);
  if (!published)
    throw new FleetUpdateFailure(
      "unknown-version",
      `${action.version} is not a published release with an archive for ${input.platformKey}.`,
    );
  if (input.legacySelfUpdate === undefined)
    throw new FleetUpdateFailure(
      "unsupported",
      `${target.label} runs ${serverVersion}, which needs its own self-update call.`,
    );
  let response: Response;
  let address;
  try {
    ({ response, address } = await fleetRequest(link, target, "/api/auth/websocket-ticket", {
      method: "POST",
      token,
      timeoutMs: 20_000,
    }));
  } catch (error) {
    throw fleetFailureOf(error);
  }
  if (!response.ok) throw await refusalOf(response);
  const body = await answerOf(response);
  if (!record(body) || typeof body.ticket !== "string")
    throw new FleetUpdateFailure("failed", "The machine gave no WebSocket ticket.");
  try {
    await input.legacySelfUpdate({
      webSocketUrl: fleetWebSocketUrl(address.origin, body.ticket),
      version: action.version,
    });
  } catch (error) {
    throw new FleetUpdateFailure(
      "failed",
      error instanceof Error ? error.message : "The self-update call failed.",
    );
  }
  return {
    identity: target.id,
    transport: transportOf(address),
    method: "boot-service",
    phase: "handed-off",
    result: "requested",
    request: {
      installRequestedAt: null,
      installMode: "self-update",
      installHoldUntil: null,
      installRequest: { at: isoNow(), version: action.version },
    },
  };
}

/** A machine's `/ws` URL for a ticket, as its clients connect. */
export function fleetWebSocketUrl(origin: string, ticket: string): string {
  const url = new URL(origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  url.hash = "";
  url.searchParams.set("wsTicket", ticket);
  url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, String(ORCHESTRATION_PROTOCOL_VERSION));
  return url.toString();
}

class FleetLegacyUpdateError extends Data.TaggedError("FleetLegacyUpdateError")<{
  readonly message: string;
}> {}

/** Download, verify and hand-off together; the launcher restarts the service after. */
const LEGACY_SELF_UPDATE_TIMEOUT = Duration.minutes(10);

/** `server.updateServer` over a fresh socket to an older boot-service machine. */
export const legacySelfUpdateOverSocket: LegacySelfUpdate = ({ webSocketUrl, version }) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* RpcClient.make(WsRpcGroup);
        yield* client[WS_METHODS.serverUpdateServer]({ targetVersion: version });
      }),
    ).pipe(
      Effect.provide(
        Layer.effect(
          RpcClient.Protocol,
          RpcClient.makeProtocolSocket({
            retryTransientErrors: false,
            retryPolicy: Schedule.recurs(0),
          }),
        ).pipe(
          Layer.provide(
            Layer.mergeAll(
              Socket.layerWebSocket(webSocketUrl, { openTimeout: Duration.seconds(15) }).pipe(
                Layer.provide(NodeSocket.layerWebSocketConstructor),
              ),
              RpcSerialization.layerJson,
            ),
          ),
        ),
      ),
      Effect.timeoutOrElse({
        duration: LEGACY_SELF_UPDATE_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new FleetLegacyUpdateError({
              message: "The machine did not finish the update in time.",
            }),
          ),
      }),
      Effect.mapError((error) => new FleetLegacyUpdateError({ message: error.message })),
    ),
  );
