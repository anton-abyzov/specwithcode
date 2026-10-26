// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native bootstrap probes launchd before the managed Effect runtime is available.
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native bootstrap probes launchd before the managed Effect runtime is available.
import * as NodeFS from "node:fs";

import {
  bootstrapRemoteBearerSession,
  fetchRemoteSessionState,
} from "@specweave-studio/client-runtime/authorization";
import {
  canonicalStudioPath,
  LEGACY_STUDIO_HOME_DIRECTORY,
  STUDIO_HOME_DIRECTORY,
  studioRootDirectory,
} from "@specweave-studio/shared/studioIdentity";
import {
  AuthSessionState,
  ExecutionEnvironmentDescriptor,
  ServerAuthDescriptor,
  statfsBytes,
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
  parseWindowsCommandLine,
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
// An installed service whose process launchd runs answers once it has opened its
// store, and a release that rebuilds a large store can take minutes (1.0.89 took
// 8.5). Its home holds the person's projects, so the app waits this long for it
// instead of opening its own, empty home in its place.
export const SERVICE_START_WAIT_LIMIT_MINUTES = 20;
const SERVICE_START_WAIT_LIMIT_MS = SERVICE_START_WAIT_LIMIT_MINUTES * 60_000;
const PAIR_TIMEOUT_MS = 30_000;
// Under this much free space (1 GB, the server's critical line) the service
// stalls on its own writes, which is the likely reason it does not answer.
const LOW_DISK_FREE_BYTES = 1e9;
const DESKTOP_SESSION_LABEL = "SpecWithCode Desktop";

export interface AttachedLocalService {
  /** The Studio home the service runs with; pairing must target the same one. */
  readonly baseDir: string;
  readonly runtime: RunningServerRuntimeState;
  readonly descriptor: ExecutionEnvironmentDescriptor;
  readonly httpBaseUrl: URL;
  /**
   * Found through a fleet installation receipt that installed a launchd service
   * for this home. The fleet launcher starts the server without the Node IPC
   * launcher, so its runtime state never says `serviceManaged`.
   */
  readonly installedService?: boolean;
}

/** Whether the attached server is an installed service that outlives the app. */
export function isInstalledService(service: AttachedLocalService | null): boolean {
  return service !== null && (service.runtime.serviceManaged || service.installedService === true);
}

export type LocalServiceDiscovery =
  | { readonly _tag: "none" }
  | { readonly _tag: "running"; readonly service: AttachedLocalService }
  | {
      /**
       * An installed service owns the person's projects but has not answered
       * within the start wait; the app must not open its own empty home instead.
       */
      readonly _tag: "service-not-started";
      readonly baseDir: string;
      readonly stateDir: string;
    }
  | {
      readonly _tag: "unresponsive";
      readonly runtime: RunningServerRuntimeState;
      readonly stateDir: string;
      /** Free bytes on the disk holding `stateDir`, present only when it is nearly full. */
      readonly lowDiskFreeBytes?: number;
    };

/** Reads free bytes on the disk holding `path`; none when it cannot tell. */
export type FreeDiskBytesReader = (path: string) => Effect.Effect<Option.Option<number>>;

/**
 * What launchd reports for an installed service's job: `running` while its
 * process is up (a release rebuilding a large store is up but silent), `stopped`
 * while loaded without a process (a crash loop between throttled restarts),
 * `absent` when launchd has no such job.
 */
export type LaunchdJobState = "running" | "stopped" | "absent" | "unknown";
export type LaunchdJobStateReader = (target: string) => Effect.Effect<LaunchdJobState>;

/** Reads the job's `state = …` line from `launchctl print` output. */
export function parseLaunchdJobState(output: string): LaunchdJobState {
  const state = /^\s*state = (.+?)\s*$/m.exec(output)?.[1];
  if (state === undefined) return "unknown";
  return state === "running" ? "running" : "stopped";
}

/** How discovery asks launchd (macOS only) about an installed service's job; tests replace it. */
export const LaunchdJob = Context.Reference<LaunchdJobStateReader>(
  "@specweave-studio/desktop/backend/DesktopLocalService/LaunchdJob",
  {
    defaultValue: () => (target) =>
      Effect.callback<LaunchdJobState>((resume) => {
        NodeChildProcess.execFile(
          "/bin/launchctl",
          ["print", target],
          { encoding: "utf8", timeout: 5_000, maxBuffer: 1024 * 1024 },
          (error, stdout) => {
            if (error) {
              // 113: launchd has no such job (the service was removed or never loaded).
              resume(Effect.succeed(error.code === 113 ? "absent" : "unknown"));
              return;
            }
            resume(Effect.succeed(parseLaunchdJobState(stdout)));
          },
        );
      }),
  },
);

/** How discovery reads free disk space; tests replace it. */
export const FreeDiskBytes = Context.Reference<FreeDiskBytesReader>(
  "@specweave-studio/desktop/backend/DesktopLocalService/FreeDiskBytes",
  {
    defaultValue: () => (path) =>
      Effect.sync(() => {
        try {
          const stats = NodeFS.statfsSync(path, { bigint: true });
          return Option.some(statfsBytes(stats.bavail, stats.bsize));
        } catch {
          return Option.none<number>();
        }
      }),
  },
);

interface StudioHomeCandidate {
  readonly baseDir: string;
  readonly stateDir: string;
  /** An installed launchd service that may still be starting. */
  readonly serviceInstalled: boolean;
  readonly launchdTarget?: string;
}

export interface DiscoverOptions {
  /** Runs once when discovery starts waiting for a service update to finish. */
  readonly onInstallWait?: Effect.Effect<void>;
  /** Runs once when discovery starts waiting for an installed service to start. */
  readonly onServiceStartWait?: Effect.Effect<void>;
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
    /** Records that the app started its own backend instead of attaching to one. */
    readonly markSpawned: Effect.Effect<void>;
    /**
     * Whether the local backend is one this app started, which quits with it.
     * Never true while attached to a running service.
     */
    readonly ownsBundledService: Effect.Effect<boolean>;
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
      // @effect-diagnostics-next-line globalFetchInEffect:off -- This native bootstrap probe precedes the managed HTTP client and preserves its abort signal.
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

// Win32_Process exposes the image path and the raw command line; the pid is a
// number, so nothing user-controlled reaches the PowerShell command.
const windowsProcessQuery = (pid: number) =>
  `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p) { [Console]::Out.Write((@{ executable = $p.ExecutablePath; commandLine = $p.CommandLine } | ConvertTo-Json -Compress)) }`;

const readWindowsCommandLine = (pid: number): { argv?: string[]; executable?: string } => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return {};
  try {
    const raw = NodeChildProcess.execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", windowsProcessQuery(pid)],
      { encoding: "utf8", timeout: 10_000, windowsHide: true },
    ).trim();
    if (raw.length === 0) return {};
    const parsed = JSON.parse(raw) as { executable?: unknown; commandLine?: unknown };
    const argv =
      typeof parsed.commandLine === "string" ? parseWindowsCommandLine(parsed.commandLine) : [];
    const executable =
      typeof parsed.executable === "string" && parsed.executable.length > 0
        ? parsed.executable
        : undefined;
    return {
      ...(argv.length > 0 ? { argv } : {}),
      ...(executable === undefined ? {} : { executable }),
    };
  } catch {
    return {};
  }
};

const readCommandLine = (pid: number, platform: NodeJS.Platform) =>
  Effect.sync((): { argv?: string[]; joinedArgs?: string; executable?: string } => {
    if (platform === "win32") return readWindowsCommandLine(pid);
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
            windowsHide: true,
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
  const readFreeDiskBytes = yield* FreeDiskBytes;
  const readLaunchdJob = yield* LaunchdJob;
  const httpClient = yield* HttpClient.HttpClient;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const attachedRef = yield* Ref.make(Option.none<AttachedLocalService>());
  const spawnedRef = yield* Ref.make(false);
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
  // `~/.specwithcode/<identity>` (or an unmigrated `~/.specweave-studio/<identity>`),
  // not from the default home.
  const listCandidates = Effect.sync((): ReadonlyArray<StudioHomeCandidate> => {
    const own = {
      baseDir: environment.baseDir,
      stateDir: environment.stateDir,
      serviceInstalled: false,
    };
    const home = environment.homeDirectory;
    const brandedRoot = environment.path.join(home, STUDIO_HOME_DIRECTORY);
    const legacyRoot = environment.path.join(home, LEGACY_STUDIO_HOME_DIRECTORY);
    if (
      environment.baseDir !== studioRootDirectory(home) &&
      environment.baseDir !== brandedRoot &&
      environment.baseDir !== legacyRoot
    ) {
      return [own];
    }
    // Branded first; a real (unmigrated) legacy root may still hold a service next to a
    // fresh branded profile. A migrated legacy root is a link to the branded one.
    const roots = [brandedRoot];
    try {
      if (!NodeFS.lstatSync(legacyRoot).isSymbolicLink()) roots.push(legacyRoot);
    } catch {
      // No legacy root.
    }
    const seen = new Set<string>();
    const installed: StudioHomeCandidate[] = [];
    for (const studioRoot of roots) {
      let entries: NodeFS.Dirent[];
      try {
        entries = NodeFS.readdirSync(studioRoot, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || seen.has(entry.name)) continue;
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
          canonical: (path) => canonicalStudioPath(path, home),
        });
        if (installation === null) continue;
        seen.add(entry.name);
        if (installation.stateDir === environment.stateDir) continue;
        installed.push({
          baseDir: installation.studioHome,
          stateDir: installation.stateDir,
          serviceInstalled: installation.serviceInstalled,
          ...(installation.launchdTarget === undefined
            ? {}
            : { launchdTarget: installation.launchdTarget }),
        });
      }
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
      let startWaitStartedAt: number | null = null;
      // The installed service launchd runs but which has not answered yet.
      let starting: {
        candidate: StudioHomeCandidate;
        runtime: RunningServerRuntimeState | null;
      } | null = null;
      for (let attempt = 0; attempt < UNRESPONSIVE_GRACE_ATTEMPTS; attempt += 1) {
        let waiting = false;
        unresponsive = null;
        const silentServices: Array<{
          candidate: StudioHomeCandidate;
          runtime: RunningServerRuntimeState | null;
        }> = [];
        for (const candidate of candidates) {
          const runtime = yield* readRuntime(candidate.stateDir);
          if (runtime === null || runtime.pid === process.pid || !isProcessAlive(runtime.pid)) {
            // launchd restarts a KeepAlive service shortly after it stops.
            if (candidate.serviceInstalled) {
              waiting = true;
              silentServices.push({ candidate, runtime: null });
            }
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
                installedService: candidate.serviceInstalled,
              },
            } as const;
          }
          waiting = true;
          unresponsive ??= { runtime, stateDir: candidate.stateDir };
          if (candidate.serviceInstalled) silentServices.push({ candidate, runtime });
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
        // An installed service in another home holds the person's projects. While
        // launchd runs its process it is still starting (a release that rebuilds a
        // large store can take minutes), so a server started on the app's own, empty
        // home would show no projects at all. A job loaded but not running is a
        // crash loop between restarts: that keeps the usual grace.
        starting = null;
        for (const silent of silentServices) {
          const target = silent.candidate.launchdTarget;
          if (silent.candidate.stateDir === environment.stateDir || target === undefined) continue;
          if (environment.platform === "darwin" && (yield* readLaunchdJob(target)) === "running") {
            starting = silent;
            break;
          }
        }
        // An update install has its own wait and limit; the start wait begins once it ends.
        if (installing !== undefined && !installWaitOver) startWaitStartedAt = null;
        else if (starting !== null) {
          if (startWaitStartedAt === null) {
            startWaitStartedAt = now;
            yield* logInfo("waiting for the installed Studio service to start", {
              baseDir: starting.candidate.baseDir,
            });
            if (options?.onServiceStartWait !== undefined) yield* options.onServiceStartWait;
          }
          // Not counted until the limit: the full grace still follows it.
          if (now - startWaitStartedAt < SERVICE_START_WAIT_LIMIT_MS) attempt = -1;
        }
        yield* Effect.sleep(UNRESPONSIVE_GRACE_INTERVAL_MS);
      }
      if (starting !== null) {
        // launchd still runs it, so its home is still the person's store:
        // report it rather than open an empty one in its place.
        yield* logWarning("the installed Studio service did not start in time", {
          baseDir: starting.candidate.baseDir,
          ...(starting.runtime === null ? {} : { pid: starting.runtime.pid }),
        });
        if (starting.runtime === null || !isProcessAlive(starting.runtime.pid)) {
          return {
            _tag: "service-not-started",
            baseDir: starting.candidate.baseDir,
            stateDir: starting.candidate.stateDir,
          } as const;
        }
        unresponsive = { runtime: starting.runtime, stateDir: starting.candidate.stateDir };
      } else if (unresponsive === null || unresponsive.stateDir !== environment.stateDir) {
        // Only a live owner of the app's own home blocks startup; an installed
        // service elsewhere whose job launchd no longer runs leaves this home free.
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
      // A full disk is the usual reason a live service stops answering; name it
      // instead of leaving the person to guess.
      // The disk the stalled service writes to, which STUDIO_HOME can put on
      // another volume than the home folder.
      const freeBytes = yield* readFreeDiskBytes(unresponsive.stateDir);
      const lowDiskFreeBytes =
        Option.isSome(freeBytes) && freeBytes.value < LOW_DISK_FREE_BYTES
          ? freeBytes.value
          : undefined;
      yield* logWarning("a live process owns this Studio home but does not answer", {
        pid: unresponsive.runtime.pid,
        origin: unresponsive.runtime.origin,
        ...(lowDiskFreeBytes === undefined ? {} : { lowDiskFreeBytes }),
      });
      return {
        _tag: "unresponsive",
        ...unresponsive,
        ...(lowDiskFreeBytes === undefined ? {} : { lowDiskFreeBytes }),
      } as const;
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
    markSpawned: Ref.set(spawnedRef, true),
    ownsBundledService: Effect.map(
      Effect.all([Ref.get(spawnedRef), Ref.get(attachedRef)]),
      ([spawned, attached]) => spawned && Option.isNone(attached),
    ),
    bearerToken,
  });
});

export const layer = Layer.effect(DesktopLocalService, make);

/** Test layer: optionally attached to a service, minting `bearer` on demand. */
export const layerTest = (input?: {
  readonly attached?: AttachedLocalService;
  readonly bearer?: string;
  readonly spawned?: boolean;
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
      markSpawned: Effect.void,
      ownsBundledService: Effect.succeed(input?.spawned === true && !input.attached),
      bearerToken:
        input?.attached && input.bearer
          ? Effect.succeed(input.bearer)
          : Effect.fail(new DesktopLocalServiceNotAttachedError()),
    }),
  );
