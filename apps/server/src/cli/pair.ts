/**
 * `specweave-studio pair` - mint a pairing token for an already-running server and print it
 * as a QR code, without restarting anything.
 *
 * Discovery reads the `server-runtime.json` a live server persists next to its
 * database, then confirms the process is actually answering by fetching its
 * public environment descriptor. Inside a linked git worktree the worktree's
 * own `.specwithcode` is checked first (matching dev-runner precedence); otherwise the
 * shared Studio home. `--tailscale` publishes the server over Tailscale Serve
 * HTTPS and pairs through the tailnet URL instead.
 */
import {
  type AuthEnvironmentScope,
  AuthStandardClientScopes,
  type ExecutionEnvironmentDescriptor,
  PortSchema,
} from "@specweave-studio/contracts";
import { resolveWorktreeStudioHome } from "@specweave-studio/shared/devHome";
import { DEFAULT_SIGNAL_EXPORT } from "@specweave-studio/shared/observability";
import * as OtelEnvironment from "@specweave-studio/shared/otelEnvironment";
import { DEFAULT_TAILSCALE_SERVE_PORT } from "@specweave-studio/tailscale";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import * as ServerConfig from "../config.ts";
import { resolveBaseDir } from "../os-jank.ts";
import {
  type PersistedServerRuntimeState,
  readPersistedServerRuntimeState,
} from "../serverRuntimeState.ts";
import { recordedProcess } from "../persistence/processIdentity.ts";
import {
  buildPairingUrl,
  isLoopbackHost,
  renderTerminalQrCode,
  resolveHeadlessConnectionString,
} from "../startupAccess.ts";
import { probeEnvironmentDescriptor, publishOnTailscale } from "../tailscalePublish.ts";
import { authScopesFlag } from "./authScopes.ts";
import { baseDirFlag, DurationFromString } from "./config.ts";
import {
  bearerHeaders,
  livePairingTtl,
  liveServiceClient,
  liveServiceRequestError,
  type LiveServiceConfig,
  liveServiceEndpoint,
  pairingGrantScopes,
} from "./liveService.ts";

export {
  DevServerNotProxiableError,
  MagicDnsNameMissingError,
  resolveTailscaleLocalTarget,
  ServePortOccupiedError,
  ServesOtherEnvironmentError,
  TailscaleServeFailedError,
  TailscaleUnavailableError,
} from "../tailscalePublish.ts";

export type PairStateVariant = "userdata" | "dev";

// deriveServerPaths only checks devUrl for undefined-ness when picking the
// dev-vs-userdata state directory; the value itself is not used.
const DEV_VARIANT_PLACEHOLDER_URL = new URL("http://localhost");

export class NoRunningServerError extends Schema.TaggedError<NoRunningServerError>()(
  "NoRunningServerError",
  {
    checkedStatePaths: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return [
      "No running SpecWithCode server found.",
      ...this.checkedStatePaths.map((statePath) => `  checked ${statePath}`),
      "Start one with `specweave-studio serve`, or connect this machine with SpecWithCode Connect: `specweave-studio connect`.",
    ].join("\n");
  }
}

/** The URL a browser or phone should pair through, absent Tailscale. */
export const resolveDirectPairingBaseUrl = (state: PersistedServerRuntimeState): string =>
  state.devUrl ?? resolveHeadlessConnectionString(state.host, state.port);

const formatPairOutput = (input: {
  readonly serverLabel: string;
  readonly origin: string;
  readonly pairingUrl: string;
  readonly token: string;
  readonly expiresAt: DateTime.Utc;
  readonly notes: ReadonlyArray<string>;
}): string =>
  [
    `Pairing with ${input.serverLabel} (${input.origin}).`,
    "",
    renderTerminalQrCode(input.pairingUrl),
    "",
    `Pairing URL: ${input.pairingUrl}`,
    `Token: ${input.token}`,
    `Expires: ${DateTime.formatIso(input.expiresAt)}`,
    ...input.notes.flatMap((note) => ["", `Note: ${note}`]),
    "",
  ].join("\n");

/** Machine-readable form for local tools such as the desktop app. */
export const formatPairJson = (input: Parameters<typeof formatPairOutput>[0]): string =>
  JSON.stringify({
    serverLabel: input.serverLabel,
    origin: input.origin,
    pairingUrl: input.pairingUrl,
    token: input.token,
    expiresAt: DateTime.formatIso(input.expiresAt),
    notes: input.notes,
  });

export interface DiscoveredPairTarget {
  readonly baseDir: string;
  readonly variant: PairStateVariant;
  readonly state: PersistedServerRuntimeState;
  readonly descriptor: ExecutionEnvironmentDescriptor;
}

export const discoverPairTarget = Effect.fn("pair.discoverPairTarget")(function* (
  explicitBaseDir: string | undefined,
) {
  const bases: Array<string> = [];
  if (explicitBaseDir !== undefined && explicitBaseDir.trim().length > 0) {
    bases.push(yield* resolveBaseDir(explicitBaseDir));
  } else {
    // Same precedence as dev-runner: inside a linked worktree its own `.specwithcode`
    // outranks the shared home, so `specweave-studio pair` in a worktree pairs with the dev
    // server under test rather than the daily-driver install.
    const worktreeHome = yield* resolveWorktreeStudioHome(process.cwd());
    if (worktreeHome !== undefined) {
      bases.push(worktreeHome);
    }
    const envHome = yield* Config.String("STUDIO_HOME").pipe(Config.option);
    bases.push(yield* resolveBaseDir(Option.getOrUndefined(envHome)));
  }

  const checkedStatePaths: Array<string> = [];
  for (const baseDir of new Set(bases)) {
    for (const variant of ["userdata", "dev"] as const) {
      const derivedPaths = yield* ServerConfig.deriveServerPaths(
        baseDir,
        variant === "dev" ? DEV_VARIANT_PLACEHOLDER_URL : undefined,
        {},
      );
      const statePath = derivedPaths.serverRuntimeStatePath;
      checkedStatePaths.push(statePath);
      const state = yield* readPersistedServerRuntimeState(statePath);
      if (Option.isNone(state)) {
        continue;
      }
      // The pid and start-time check guards against a dead server's state
      // file whose pid or port was since reused by another process; the CLI
      // credential then goes only to the confirmed service (mintPairingLink).
      if ((yield* recordedProcess(state.value.pid, state.value.startedAt)) !== "running") {
        continue;
      }
      const probed = yield* probeEnvironmentDescriptor(state.value.origin);
      if (probed._tag !== "descriptor") {
        continue;
      }
      return {
        baseDir,
        variant,
        state: state.value,
        descriptor: probed.descriptor,
      } satisfies DiscoveredPairTarget;
    }
  }
  return yield* new NoRunningServerError({ checkedStatePaths });
});

/**
 * Server config pointed at the discovered server's state directory, so the
 * CLI credential is read from the home of the server that answered. Built by
 * hand rather than through `resolveServerConfig` to keep the dev-vs-userdata
 * choice pinned to where the runtime state was actually found, independent of
 * ambient environment variables.
 */
export const makePairServerConfig = Effect.fn(function* (input: {
  readonly target: DiscoveredPairTarget;
  readonly logLevel: ServerConfig.ServerConfig["Service"]["logLevel"];
}) {
  const { baseDir, variant, state } = input.target;
  // The state-dir variant does not imply dev-ness: a worktree dev server uses
  // an explicit home and therefore lands in `userdata`. The recorded devUrl is
  // what actually marks a dev server.
  const devUrl = state.devUrl !== undefined ? new URL(state.devUrl) : undefined;
  const derivedPaths = yield* ServerConfig.deriveServerPaths(
    baseDir,
    variant === "dev" ? DEV_VARIANT_PLACEHOLDER_URL : undefined,
    {},
  );
  return ServerConfig.make({
    logLevel: input.logLevel,
    traceMinLevel: "Info",
    traceTimingEnabled: false,
    traceBatchWindowMs: 1_000,
    traceMaxBytes: 10 * 1024 * 1024,
    traceMaxFiles: 10,
    otlpTracesUrl: undefined,
    otlpMetricsUrl: undefined,
    otlpLogsUrl: undefined,
    otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
    otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
    otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
    otelEnvironment: OtelEnvironment.none,
    mode: "web",
    port: state.port,
    host: state.host,
    cwd: process.cwd(),
    baseDir,
    ...derivedPaths,
    staticDir: undefined,
    devUrl,
    devAllowedOrigins: [],
    noBrowser: true,
    startupPresentation: "headless",
    desktopBootstrapToken: undefined,
    desktopTelemetryFd: undefined,
    desktopBrowserFd: undefined,
    desktopBrowserControlFd: undefined,
    desktopTelemetryControlFd: undefined,
    resourceMonitorPath: undefined,
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
    tailscaleServeEnabled: false,
    tailscaleServePort: DEFAULT_TAILSCALE_SERVE_PORT,
  });
});

/** Publishes the discovered server on this machine's Tailscale name; see tailscalePublish.ts. */
export const resolveTailscalePairingBase = Effect.fn("pair.resolveTailscalePairingBase")(
  function* (input: { readonly target: DiscoveredPairTarget; readonly servePort: number }) {
    const published = yield* publishOnTailscale({
      environmentId: input.target.descriptor.environmentId,
      state: input.target.state,
      servePort: input.servePort,
    });
    return { baseUrl: published.baseUrl, notes: published.notes };
  },
);

/**
 * Mints the pairing token through the running service, with the credential it
 * published for this machine's CLI: `POST /api/auth/pairing-token`, the call
 * Settings > Connections makes. The live database is never opened here.
 * `--ttl` is passed through; left out, the service's tokens last five minutes.
 */
export const mintPairingLink = Effect.fn("pair.mintPairingLink")(function* (input: {
  readonly config: LiveServiceConfig;
  readonly target: Pick<DiscoveredPairTarget, "state">;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly ttl: Option.Option<Duration.Duration>;
  readonly label: Option.Option<string>;
}) {
  const ttl = yield* livePairingTtl(input.ttl);
  const scopes = yield* pairingGrantScopes(input.scopes);
  const { origin, token } = yield* liveServiceEndpoint(input.config, input.target.state);
  return yield* Effect.gen(function* () {
    const client = yield* liveServiceClient(origin);
    return yield* client.auth.pairingCredential({
      headers: bearerHeaders(token),
      payload: {
        scopes,
        ...ttl,
        label: Option.getOrElse(input.label, () => "specweave-studio pair"),
      },
    });
  }).pipe(Effect.mapError(liveServiceRequestError(origin, "issue a pairing token")));
});

const ttlFlag = Flag.String("ttl").pipe(
  Flag.withSchema(DurationFromString),
  Flag.withDescription(
    "Token TTL, for example `5m`, `1h`, or `15 minutes`. Defaults to 5 minutes.",
  ),
  Flag.optional,
);

const labelFlag = Flag.String("label").pipe(
  Flag.withDescription("Optional label shown in the server's connections list."),
  Flag.optional,
);

const tailscaleFlag = Flag.Boolean("tailscale").pipe(
  Flag.withDescription(
    "Publish the server over Tailscale Serve HTTPS and pair through the tailnet URL.",
  ),
  Flag.withDefault(false),
);

const tailscaleServePortFlag = Flag.Int("tailscale-serve-port").pipe(
  Flag.withSchema(PortSchema),
  Flag.withDescription("HTTPS port for Tailscale Serve when --tailscale is enabled."),
  Flag.withDefault(DEFAULT_TAILSCALE_SERVE_PORT),
);

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Print the pairing details as one JSON object instead of a QR code."),
  Flag.withDefault(false),
);

export const pairCommand = Command.make("pair", {
  baseDir: baseDirFlag,
  json: jsonFlag,
  scopes: authScopesFlag(AuthStandardClientScopes),
  ttl: ttlFlag,
  label: labelFlag,
  tailscale: tailscaleFlag,
  tailscaleServePort: tailscaleServePortFlag,
}).pipe(
  Command.withDescription(
    "Mint a pairing token for a running SpecWithCode server and print it as a QR code.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const cliLogLevel = yield* GlobalFlag.LogLevel;
      // Default to Warn so storage/migration chatter cannot bury the QR code;
      // an explicit --log-level still wins.
      const logLevel = Option.getOrElse(cliLogLevel, () => "Warn" as const);

      const target = yield* discoverPairTarget(Option.getOrUndefined(flags.baseDir));

      const notes: Array<string> = [];
      let pairingBaseUrl: string;
      if (flags.tailscale) {
        const resolved = yield* resolveTailscalePairingBase({
          target,
          servePort: flags.tailscaleServePort,
        });
        pairingBaseUrl = resolved.baseUrl;
        notes.push(...resolved.notes);
      } else {
        pairingBaseUrl = resolveDirectPairingBaseUrl(target.state);
        if (isLoopbackHost(new URL(pairingBaseUrl).hostname)) {
          notes.push(
            "This URL is only reachable from this machine. Re-run with --tailscale, or restart the server with a reachable --host.",
          );
        }
        if (target.variant === "dev" && target.state.devUrl === undefined) {
          notes.push(
            "This dev server did not record its web URL; restart it so pairing can go through the web origin.",
          );
        }
      }

      const config = yield* makePairServerConfig({ target, logLevel });
      const issued = yield* mintPairingLink({
        config,
        target,
        scopes: flags.scopes,
        ttl: flags.ttl,
        label: flags.label,
      });
      const pairingUrl = buildPairingUrl(pairingBaseUrl, issued.credential);

      const output = {
        serverLabel: target.descriptor.label,
        origin: target.state.origin,
        pairingUrl,
        token: issued.credential,
        expiresAt: issued.expiresAt,
        notes,
      };
      yield* Console.log(flags.json ? formatPairJson(output) : formatPairOutput(output));
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  ),
);
