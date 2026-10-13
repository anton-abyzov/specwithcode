import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

import {
  bootstrapRemoteBearerSession,
  fetchRemoteSessionState,
} from "@specweave-studio/client-runtime/authorization";
import {
  AuthSessionState,
  ExecutionEnvironmentDescriptor,
  ServerAuthDescriptor,
  TrimmedNonEmptyString,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import {
  DESKTOP_SERVICE_CREDENTIAL_FILE,
  isStoredBearerReusable,
  resolveDesktopServiceBearer,
} from "./desktopServiceCredential.ts";
import {
  buildPairArgs,
  isProcessAlive,
  parsePairToken,
  parseServerRuntimeState,
  parseStudioInstallation,
  resolveServiceCliCommand,
  type RunningServerRuntimeState,
  type ServiceCliCommand,
} from "./localServiceAttach.ts";
import {
  SERVICE_INSTALL_LIMIT_MS,
  serviceInstallInProgress,
} from "../updates/serviceInstallMarker.ts";
import serverPackageJson from "../../../server/package.json" with { type: "json" };

const { logInfo, logWarning } = DesktopObservability.makeComponentLogger("desktop-local-service");

const WELL_KNOWN_ENVIRONMENT_PATH = "/.well-known/studio/environment";
const PROBE_TIMEOUT_MS = 2_500;
// A service that was just (re)started may own the store before it answers.
const UNRESPONSIVE_GRACE_ATTEMPTS = 6;
const UNRESPONSIVE_GRACE_INTERVAL_MS = 1_000;
// An update installing over the service restarts it on the new release; the
// app waits while the install runs (the marker's own age bounds that), and
// never longer than this in all, measured in time rather than probes.
const INSTALL_WAIT_LIMIT_MS = SERVICE_INSTALL_LIMIT_MS;
const PAIR_TIMEOUT_MS = 30_000;
const DESKTOP_SESSION_LABEL = "SpecWithCode Desktop";

export interface AttachedLocalService {
  /** The Studio home the service runs with; pairing must target the same one. */
  readonly baseDir: string;
  readonly runtime: RunningServerRuntimeState;
  readonly descriptor: ExecutionEnvironmentDescriptor;
  readonly httpBaseUrl: URL;
}

export type LocalServiceDiscovery =
  | { readonly _tag: "none" }
  | { readonly _tag: "running"; readonly service: AttachedLocalService }
  | {
      readonly _tag: "unresponsive";
      readonly runtime: RunningServerRuntimeState;
      readonly stateDir: string;
    };

interface StudioHomeCandidate {
  readonly baseDir: string;
  readonly stateDir: string;
  /** An installed launchd service that may still be starting. */
  readonly serviceInstalled: boolean;
}

export interface DiscoverOptions {
  /** Runs once when discovery starts waiting for a service update to finish. */
  readonly onInstallWait?: Effect.Effect<void>;
}

export class DesktopLocalServicePairingError extends Schema.TaggedError<DesktopLocalServicePairingError>()(
  "DesktopLocalServicePairingError",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Could not pair with the running SpecWithCode service: ${this.reason}`;
  }
}

export class DesktopLocalServiceNotAttachedError extends Schema.TaggedError<DesktopLocalServiceNotAttachedError>()(
  "DesktopLocalServiceNotAttachedError",
  {},
) {
  override get message(): string {
    return "The desktop app is not attached to a running SpecWithCode service.";
  }
}

export class DesktopLocalService extends Context.Service<
  DesktopLocalService,
  {
    /** Finds a live server that already owns this machine's Studio home. */
    readonly discover: (options?: DiscoverOptions) => Effect.Effect<LocalServiceDiscovery>;
    readonly attach: (service: AttachedLocalService) => Effect.Effect<void>;
    readonly attached: Effect.Effect<Option.Option<AttachedLocalService>>;
    /** A bearer for the attached service, minted through that installation's own CLI. */
    readonly bearerToken: Effect.Effect<
      string,
      DesktopLocalServicePairingError | DesktopLocalServiceNotAttachedError
    >;
  }
>()("@specweave-studio/desktop/backend/DesktopLocalService") {}

// What counts as evidence of a newer contract when stored-bearer validation
// cannot decode an HTTP 200 reply: the reply is a complete session (every field
// this build knows is present and well typed, optional ones included) and the only
// thing it fails on is an enum value this build does not know (auth policy,
// bootstrap or session method, scope, permission, update scope). Re-pairing is
// right then, because retrying never teaches this build the new value.
// Anything else ({}, an error envelope from a service still starting, a missing
// or wrongly typed field) has no decoded session state and proves nothing, so the
// caller keeps the encrypted bytes and returns a retryable failure.
const SessionStateWithUnknownEnums = Schema.Struct({
  ...AuthSessionState.fields,
  auth: Schema.Struct({
    ...ServerAuthDescriptor.fields,
    policy: TrimmedNonEmptyString,
    bootstrapMethods: Schema.Array(TrimmedNonEmptyString),
    sessionMethods: Schema.Array(TrimmedNonEmptyString),
    serverUpdateScope: Schema.optionalKey(TrimmedNonEmptyString),
  }),
  scopes: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  permissions: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  sessionMethod: Schema.optionalKey(TrimmedNonEmptyString),
});
const decodeSessionWithUnknownEnums = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.toCodecJson(SessionStateWithUnknownEnums)),
);

const probeDescriptor = (origin: string) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(new URL(WELL_KNOWN_ENVIRONMENT_PATH, origin), {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      return Schema.decodeUnknownOption(ExecutionEnvironmentDescriptor)(await response.json());
    },
    catch: () => null,
  }).pipe(
    Effect.map((value) => (value === null ? Option.none() : value)),
    Effect.orElseSucceed(() => Option.none<ExecutionEnvironmentDescriptor>()),
  );

const readCommandLine = (pid: number, platform: NodeJS.Platform) =>
  Effect.sync((): { argv?: string[]; joinedArgs?: string } => {
    if (platform === "linux") {
      try {
        const raw = NodeFS.readFileSync(`/proc/${pid}/cmdline`, "utf8");
        return { argv: raw.split("\0").filter((part) => part.length > 0) };
      } catch {
        return {};
      }
    }
    if (platform === "darwin") {
      try {
        const joinedArgs = NodeChildProcess.execFileSync(
          "/bin/ps",
          ["-ww", "-o", "args=", "-p", String(pid)],
          {
            encoding: "utf8",
            timeout: 5_000,
          },
        ).trim();
        return joinedArgs.length > 0 ? { joinedArgs } : {};
      } catch {
        return {};
      }
    }
    return {};
  });

const runPair = (command: ServiceCliCommand, pairArgs: ReadonlyArray<string>) =>
  Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        NodeChildProcess.execFile(
          command.command,
          [...command.args, ...pairArgs],
          {
            timeout: PAIR_TIMEOUT_MS,
            maxBuffer: 1024 * 1024,
            env: {
              ...process.env,
              // Electron's own binary runs scripts only in Node mode.
              ...(command.viaRuntime ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
            },
          },
          (error, stdout) => (error ? reject(error) : resolve(stdout)),
        );
      }),
    catch: (cause) =>
      new DesktopLocalServicePairingError({ reason: "the pair command failed", cause }),
  });

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const httpClient = yield* HttpClient.HttpClient;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const attachedRef = yield* Ref.make(Option.none<AttachedLocalService>());
  const tokenRef = yield* Ref.make(Option.none<string>());
  const mutex = yield* Semaphore.make(1);
  const readRuntime = (stateDir: string) =>
    Effect.sync(() => {
      try {
        return parseServerRuntimeState(
          NodeFS.readFileSync(environment.path.join(stateDir, "server-runtime.json"), "utf8"),
        );
      } catch {
        return null;
      }
    });

  // The app's own home first. With no explicit STUDIO_HOME, also every home
  // the fleet installer created beside it: the installed service runs from
  // `~/.specweave-studio/<identity>`, not from the default home.
  const listCandidates = Effect.sync((): ReadonlyArray<StudioHomeCandidate> => {
    const own = {
      baseDir: environment.baseDir,
      stateDir: environment.stateDir,
      serviceInstalled: false,
    };
    const studioRoot = environment.path.join(environment.homeDirectory, ".specweave-studio");
    if (environment.baseDir !== studioRoot) return [own];
    let entries: NodeFS.Dirent[];
    try {
      entries = NodeFS.readdirSync(studioRoot, { withFileTypes: true });
    } catch {
      return [own];
    }
    const installed: StudioHomeCandidate[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      let text: string;
      try {
        text = NodeFS.readFileSync(
          environment.path.join(studioRoot, entry.name, "installation.json"),
          "utf8",
        );
      } catch {
        continue;
      }
      const installation = parseStudioInstallation(text, {
        studioRoot,
        directoryName: entry.name,
        join: environment.path.join,
      });
      if (installation === null || installation.stateDir === environment.stateDir) continue;
      installed.push({
        baseDir: installation.studioHome,
        stateDir: installation.stateDir,
        serviceInstalled: installation.serviceInstalled,
      });
    }
    // Services before plain installs, then by name for a stable order.
    installed.sort(
      (a, b) =>
        Number(b.serviceInstalled) - Number(a.serviceInstalled) ||
        a.baseDir.localeCompare(b.baseDir),
    );
    return [own, ...installed];
  });

  const discover = (options?: DiscoverOptions) =>
    Effect.gen(function* () {
      const candidates = yield* listCandidates;
      let unresponsive: { runtime: RunningServerRuntimeState; stateDir: string } | null = null;
      let installWaitStartedAt: number | null = null;
      let installWaitOver = false;
      for (let attempt = 0; attempt < UNRESPONSIVE_GRACE_ATTEMPTS; attempt += 1) {
        let waiting = false;
        unresponsive = null;
        for (const candidate of candidates) {
          const runtime = yield* readRuntime(candidate.stateDir);
          if (runtime === null || runtime.pid === process.pid || !isProcessAlive(runtime.pid)) {
            // launchd restarts a KeepAlive service shortly after it stops.
            if (candidate.serviceInstalled) waiting = true;
            continue;
          }
          const descriptor = yield* probeDescriptor(runtime.origin);
          if (Option.isSome(descriptor)) {
            yield* logInfo("found a running Studio server", {
              pid: runtime.pid,
              origin: runtime.origin,
              baseDir: candidate.baseDir,
              serviceManaged: runtime.serviceManaged,
              serverVersion: descriptor.value.serverVersion,
            });
            return {
              _tag: "running",
              service: {
                baseDir: candidate.baseDir,
                runtime,
                descriptor: descriptor.value,
                httpBaseUrl: new URL(runtime.origin),
              },
            } as const;
          }
          waiting = true;
          unresponsive ??= { runtime, stateDir: candidate.stateDir };
        }
        if (!waiting) return { _tag: "none" } as const;
        // A server started now would take the port the updated service needs.
        const now = yield* Clock.currentTimeMillis;
        const installing = installWaitOver
          ? undefined
          : candidates.find(
              (candidate) =>
                candidate.serviceInstalled && serviceInstallInProgress(candidate.baseDir, now),
            );
        if (installing !== undefined && installWaitStartedAt === null) {
          installWaitStartedAt = now;
          yield* logInfo("waiting for the Studio service update to finish", {
            baseDir: installing.baseDir,
          });
          if (options?.onInstallWait !== undefined) yield* options.onInstallWait;
        }
        if (installing !== undefined && installWaitStartedAt !== null) {
          if (now - installWaitStartedAt < INSTALL_WAIT_LIMIT_MS) {
            // Not counted: the full grace still follows once the install ends.
            attempt = -1;
          } else {
            installWaitOver = true;
            yield* logWarning("the Studio service update did not finish in time", {
              baseDir: installing.baseDir,
            });
          }
        }
        yield* Effect.sleep(UNRESPONSIVE_GRACE_INTERVAL_MS);
      }
      // Only a live owner of the app's own home blocks startup; an installed
      // service elsewhere that never answered leaves this home free.
      if (unresponsive === null || unresponsive.stateDir !== environment.stateDir) {
        if (unresponsive !== null) {
          yield* logWarning(
            "an installed Studio service does not answer; starting a local server",
            {
              pid: unresponsive.runtime.pid,
              origin: unresponsive.runtime.origin,
            },
          );
        }
        return { _tag: "none" } as const;
      }
      if (!isProcessAlive(unresponsive.runtime.pid)) return { _tag: "none" } as const;
      yield* logWarning("a live process owns this Studio home but does not answer", {
        pid: unresponsive.runtime.pid,
        origin: unresponsive.runtime.origin,
      });
      return { _tag: "unresponsive", ...unresponsive } as const;
    }).pipe(Effect.withSpan("desktop.localService.discover"));

  const resolvePairCommand = Effect.fn("desktop.localService.resolvePairCommand")(function* (
    service: AttachedLocalService,
  ) {
    const commandLine = yield* readCommandLine(service.runtime.pid, environment.platform);
    const own = resolveServiceCliCommand({ ...commandLine, exists: NodeFS.existsSync });
    if (own !== null) return own;
    // Without the owner's command line, only a build of the same version may
    // write its database.
    if (service.descriptor.serverVersion === serverPackageJson.version) {
      return {
        command: process.execPath,
        args: [environment.backendEntryPath],
        viaRuntime: true,
      } satisfies ServiceCliCommand;
    }
    return yield* new DesktopLocalServicePairingError({
      reason: `the service runs version ${service.descriptor.serverVersion}, this app bundles ${serverPackageJson.version}, and its command line could not be read`,
    });
  });

  const mintBearer = Effect.fn("desktop.localService.mintBearer")(function* (
    service: AttachedLocalService,
  ) {
    const command = yield* resolvePairCommand(service);
    const stdout = yield* runPair(
      command,
      buildPairArgs({ baseDir: service.baseDir, label: DESKTOP_SESSION_LABEL }),
    );
    const credential = parsePairToken(stdout);
    if (credential === null) {
      return yield* new DesktopLocalServicePairingError({
        reason: "the pair command printed no token",
      });
    }
    const session = yield* bootstrapRemoteBearerSession({
      httpBaseUrl: service.httpBaseUrl.href,
      credential,
      clientMetadata: { label: DESKTOP_SESSION_LABEL, deviceType: "desktop" },
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.mapError(
        (cause) =>
          new DesktopLocalServicePairingError({ reason: "the token exchange failed", cause }),
      ),
    );
    return session.access_token;
  });

  const bearerToken = mutex.withPermits(1)(
    Effect.gen(function* () {
      const cached = yield* Ref.get(tokenRef);
      if (Option.isSome(cached)) return cached.value;
      const attached = yield* Ref.get(attachedRef);
      if (Option.isNone(attached)) return yield* new DesktopLocalServiceNotAttachedError();
      const service = attached.value;
      // Reuse the bearer an earlier launch minted while the service accepts it.
      const token = yield* resolveDesktopServiceBearer({
        filePath: environment.path.join(environment.stateDir, DESKTOP_SERVICE_CREDENTIAL_FILE),
        key: service.descriptor.environmentId,
        crypto: safeStorage,
        isReusable: (bearerToken) =>
          Effect.gen(function* () {
            const responseRef = yield* Ref.make(
              Option.none<HttpClientResponse.HttpClientResponse>(),
            );
            return yield* fetchRemoteSessionState({
              httpBaseUrl: service.httpBaseUrl.href,
              bearerToken,
            }).pipe(
              Effect.provideService(
                HttpClient.HttpClient,
                httpClient.pipe(
                  HttpClient.tap((response) => Ref.set(responseRef, Option.some(response))),
                ),
              ),
              Effect.flatMap((state) =>
                DateTime.now.pipe(
                  Effect.map((now) => isStoredBearerReusable(state, DateTime.toEpochMillis(now))),
                ),
              ),
              Effect.catchTags({
                RemoteEnvironmentAuthInvalidJsonError: (error) =>
                  Effect.gen(function* () {
                    const response = yield* Ref.get(responseRef);
                    if (Option.isNone(response) || response.value.status !== 200) {
                      return yield* Effect.fail(error);
                    }
                    // The HTTP decoder caches arrayBuffer; validate the same body,
                    // without another request or retaining raw input in errors.
                    const body = yield* response.value.arrayBuffer.pipe(
                      Effect.mapError(() => error),
                    );
                    return Option.isSome(
                      decodeSessionWithUnknownEnums(new TextDecoder().decode(body)),
                    )
                      ? false
                      : yield* Effect.fail(error);
                  }),
              }),
              // Unavailable or structurally malformed state remains retryable:
              // preserve the credential and mint/cache nothing until validation.
              Effect.mapError(
                (cause) =>
                  new DesktopLocalServicePairingError({
                    reason:
                      "the stored bearer could not be validated; retry when the service is available",
                    cause,
                  }),
              ),
            );
          }),
        mint: mintBearer(service),
      });
      yield* Ref.set(tokenRef, Option.some(token));
      return token;
    }),
  );

  return DesktopLocalService.of({
    discover,
    attach: (service) =>
      Ref.set(attachedRef, Option.some(service)).pipe(
        Effect.andThen(Ref.set(tokenRef, Option.none())),
      ),
    attached: Ref.get(attachedRef),
    bearerToken,
  });
});

export const layer = Layer.effect(DesktopLocalService, make);

/** Test layer: optionally attached to a service, minting `bearer` on demand. */
export const layerTest = (input?: {
  readonly attached?: AttachedLocalService;
  readonly bearer?: string;
}) =>
  Layer.succeed(
    DesktopLocalService,
    DesktopLocalService.of({
      discover: () =>
        Effect.succeed(
          input?.attached ? { _tag: "running", service: input.attached } : { _tag: "none" },
        ),
      attach: () => Effect.void,
      attached: Effect.succeed(Option.fromUndefinedOr(input?.attached)),
      bearerToken:
        input?.attached && input.bearer
          ? Effect.succeed(input.bearer)
          : Effect.fail(new DesktopLocalServiceNotAttachedError()),
    }),
  );
