import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export const DEFAULT_TAILSCALE_SERVE_PORT = 443;
export const TAILSCALE_STATUS_TIMEOUT = Duration.millis(1_500);
const TAILSCALE_SERVE_TIMEOUT = Duration.seconds(10);
const TAILSCALE_PROBE_TIMEOUT = Duration.millis(2_500);

/**
 * The Tailscale app for macOS (standalone and Mac App Store) installs no
 * `tailscale` command on PATH unless the user adds one. Its own executable
 * answers the same CLI arguments, so it is the fallback when `tailscale` is
 * missing. Without a terminal (`TERM`) it tries to start the GUI instead and
 * still exits 0, so it runs with `TAILSCALE_BE_CLI=1`.
 */
export const MACOS_TAILSCALE_APP_EXECUTABLE =
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

type TailscaleExecutableLabel = "tailscale" | "tailscale.exe" | "Tailscale.app";

interface TailscaleExecutable {
  readonly path: string;
  readonly label: TailscaleExecutableLabel;
  readonly env?: Readonly<Record<string, string>>;
}

// tailscale is a real executable everywhere (`tailscale.exe` on Windows), so
// it is always spawned directly rather than through cmd.exe shell mode.
const tailscaleExecutablesForPlatform = (
  platform: NodeJS.Platform,
): readonly [TailscaleExecutable, ...TailscaleExecutable[]] => {
  if (platform === "win32") return [{ path: "tailscale.exe", label: "tailscale.exe" }];
  if (platform === "darwin") {
    return [
      { path: "tailscale", label: "tailscale" },
      {
        path: MACOS_TAILSCALE_APP_EXECUTABLE,
        label: "Tailscale.app",
        env: { TAILSCALE_BE_CLI: "1" },
      },
    ];
  }
  return [{ path: "tailscale", label: "tailscale" }];
};

const TailscaleCommandContext = {
  executable: Schema.Literals(["tailscale", "tailscale.exe", "Tailscale.app"]),
  subcommand: Schema.Literals(["status", "serve"]),
  argumentCount: Schema.Number,
};

/**
 * Failure kinds we can name without quoting the CLI. Anything unrecognized
 * becomes "unknown" rather than falling back to raw text — stderr can contain
 * auth keys (`tskey-…`) and node names, and these labels are logged.
 */
export const TailscaleStderrDiagnostic = Schema.Literals([
  "no-existing-handler",
  "not-logged-in",
  "permission-denied",
  "unknown",
]);
export type TailscaleStderrDiagnostic = typeof TailscaleStderrDiagnostic.Type;

// Matched against stderr, most specific first. Patterns are deliberately short
// and anchored on tailscale's own wording.
const STDERR_DIAGNOSTIC_PATTERNS: ReadonlyArray<
  readonly [RegExp, Exclude<TailscaleStderrDiagnostic, "unknown">]
> = [
  [/handler does not exist/i, "no-existing-handler"],
  [/not logged in|logged out|needs? login/i, "not-logged-in"],
  [/permission denied|access denied|must be root|operation not permitted/i, "permission-denied"],
];

/** Classifies stderr into a safe label, dropping the text itself. */
const stderrDiagnosticOf = (stderr: string): TailscaleStderrDiagnostic | undefined => {
  if (stderr.trim().length === 0) {
    return undefined;
  }
  return STDERR_DIAGNOSTIC_PATTERNS.find(([pattern]) => pattern.test(stderr))?.[1] ?? "unknown";
};

export class TailscaleCommandSpawnError extends Schema.TaggedError<TailscaleCommandSpawnError>()(
  "TailscaleCommandSpawnError",
  {
    ...TailscaleCommandContext,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to spawn tailscale ${this.subcommand}.`;
  }
}

class TailscaleCommandOutputError extends Schema.TaggedError<TailscaleCommandOutputError>()(
  "TailscaleCommandOutputError",
  {
    ...TailscaleCommandContext,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read output from tailscale ${this.subcommand}.`;
  }
}

export class TailscaleCommandExitError extends Schema.TaggedError<TailscaleCommandExitError>()(
  "TailscaleCommandExitError",
  {
    ...TailscaleCommandContext,
    exitCode: Schema.Number,
    stdoutLength: Schema.optional(Schema.Number),
    stderrLength: Schema.Number,
    // A classified diagnostic, never raw CLI output. `tailscale` prints auth
    // keys and node identifiers into stderr, and this field is surfaced in
    // dev-runner logs — so it carries only a known-safe label from the closed
    // set below. Callers that need to recognize a specific failure (e.g.
    // `serve off` on a port with no mapping) match on the label.
    stderrDiagnostic: Schema.optional(TailscaleStderrDiagnostic),
  },
) {
  override get message(): string {
    return `tailscale ${this.subcommand} exited with code ${this.exitCode}.`;
  }
}

export class TailscaleCommandTimeoutError extends Schema.TaggedError<TailscaleCommandTimeoutError>()(
  "TailscaleCommandTimeoutError",
  {
    ...TailscaleCommandContext,
    timeoutMs: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `tailscale ${this.subcommand} timed out after ${this.timeoutMs}ms.`;
  }
}

export type TailscaleCommandError =
  | TailscaleCommandSpawnError
  | TailscaleCommandOutputError
  | TailscaleCommandExitError
  | TailscaleCommandTimeoutError;

export class TailscaleStatusParseError extends Schema.TaggedError<TailscaleStatusParseError>()(
  "TailscaleStatusParseError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to decode tailscale status JSON.";
  }
}

const TailscaleStatusSelf = Schema.Struct({
  DNSName: Schema.optional(Schema.Unknown),
  TailscaleIPs: Schema.optional(Schema.Unknown),
});

const TailscaleStatusJson = Schema.Struct({
  Self: Schema.optional(TailscaleStatusSelf),
});

export type TailscaleStatusJson = typeof TailscaleStatusJson.Type;

export interface TailscaleStatus {
  readonly magicDnsName: string | null;
  readonly tailnetIpv4Addresses: readonly string[];
}

const collectStdout = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const collectStderr = collectStdout;

const decodeTailscaleStatusJson = Schema.decodeEffect(Schema.fromJsonString(TailscaleStatusJson));

function normalizeMagicDnsName(status: TailscaleStatusJson): string | null {
  const dnsName = status.Self?.DNSName;
  if (typeof dnsName !== "string") {
    return null;
  }

  const normalized = dnsName.trim().replace(/\.$/u, "");
  return normalized.length > 0 ? normalized : null;
}

export const parseTailscaleMagicDnsName = (
  rawStatusJson: string,
): Effect.Effect<string | null, TailscaleStatusParseError> =>
  decodeTailscaleStatusJson(rawStatusJson).pipe(
    Effect.mapError((cause) => new TailscaleStatusParseError({ cause })),
    Effect.map(normalizeMagicDnsName),
  );

export function isTailscaleIpv4Address(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return false;
  }
  const [first, second, third, fourth] = parts.map((part) => Number.parseInt(part, 10));
  if (
    first === undefined ||
    second === undefined ||
    third === undefined ||
    fourth === undefined ||
    [first, second, third, fourth].some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  return first === 100 && second >= 64 && second <= 127;
}

export const parseTailscaleStatus = (
  rawStatusJson: string,
): Effect.Effect<TailscaleStatus, TailscaleStatusParseError> =>
  decodeTailscaleStatusJson(rawStatusJson).pipe(
    Effect.mapError((cause) => new TailscaleStatusParseError({ cause })),
    Effect.map((parsed) => {
      const rawIps = parsed.Self?.TailscaleIPs;
      const tailnetIpv4Addresses: Array<string> = [];
      if (Array.isArray(rawIps)) {
        for (const address of rawIps) {
          if (typeof address === "string" && isTailscaleIpv4Address(address)) {
            tailnetIpv4Addresses.push(address);
          }
        }
      }

      return {
        magicDnsName: normalizeMagicDnsName(parsed),
        tailnetIpv4Addresses,
      };
    }),
  );

/**
 * Spawns one tailscale executable and returns its stdout. The command context
 * names the executable by label, never by path or arguments, because both end
 * up in logs.
 */
const runTailscaleExecutable = (input: {
  readonly executable: TailscaleExecutable;
  readonly subcommand: "status" | "serve";
  readonly args: readonly string[];
  readonly timeout: Duration.Duration;
  readonly reportStdoutLength: boolean;
}): Effect.Effect<string, TailscaleCommandError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const commandContext = {
      executable: input.executable.label,
      subcommand: input.subcommand,
      argumentCount: input.args.length,
    };
    return yield* Effect.gen(function* () {
      const command = input.executable.env
        ? ChildProcess.make(input.executable.path, input.args, {
            env: input.executable.env,
            extendEnv: true,
          })
        : ChildProcess.make(input.executable.path, input.args);
      const child = yield* spawner.spawn(command).pipe(
        Effect.mapError((cause) => new TailscaleCommandSpawnError({ ...commandContext, cause })),
        // Spawning can also fail as a defect rather than a typed error - a
        // non-directory entry on PATH makes node throw ENOTDIR synchronously.
        // `mapError` never sees that, so it would escape as an uncaught error.
        Effect.catchDefect((cause) =>
          Effect.fail(new TailscaleCommandSpawnError({ ...commandContext, cause })),
        ),
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectStdout(child.stdout),
          collectStderr(child.stderr),
          child.exitCode.pipe(Effect.map(Number)),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError((cause) => new TailscaleCommandOutputError({ ...commandContext, cause })),
      );
      if (exitCode !== 0) {
        return yield* new TailscaleCommandExitError({
          ...commandContext,
          exitCode,
          ...(input.reportStdoutLength ? { stdoutLength: stdout.length } : {}),
          stderrLength: stderr.length,
          ...(stderrDiagnosticOf(stderr) !== undefined
            ? { stderrDiagnostic: stderrDiagnosticOf(stderr) }
            : {}),
        });
      }
      return stdout;
    }).pipe(
      Effect.scoped,
      Effect.timeout(input.timeout),
      Effect.catchTags({
        TimeoutError: (cause) =>
          Effect.fail(
            new TailscaleCommandTimeoutError({
              ...commandContext,
              timeoutMs: Duration.toMillis(input.timeout),
              cause,
            }),
          ),
      }),
    );
  });

/**
 * Runs a tailscale command with the first executable that spawns. Only a
 * spawn failure moves on to the next candidate: an exit code or a timeout
 * comes from a real tailscale and is the answer.
 */
const runTailscale = (input: {
  readonly subcommand: "status" | "serve";
  readonly args: readonly string[];
  readonly timeout: Duration.Input;
  readonly reportStdoutLength?: boolean;
}): Effect.Effect<string, TailscaleCommandError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const hostPlatform = yield* HostProcessPlatform;
    const [first, ...fallbacks] = tailscaleExecutablesForPlatform(hostPlatform);
    const run = (executable: TailscaleExecutable) =>
      runTailscaleExecutable({
        executable,
        subcommand: input.subcommand,
        args: input.args,
        timeout: Duration.fromInputUnsafe(input.timeout),
        reportStdoutLength: input.reportStdoutLength === true,
      });
    let attempt = run(first);
    for (const fallback of fallbacks) {
      attempt = attempt.pipe(Effect.catchTags({ TailscaleCommandSpawnError: () => run(fallback) }));
    }
    return yield* attempt;
  });

export const readTailscaleStatus = runTailscale({
  subcommand: "status",
  args: ["status", "--json"],
  timeout: TAILSCALE_STATUS_TIMEOUT,
  reportStdoutLength: true,
}).pipe(Effect.flatMap(parseTailscaleStatus));

/** One `tailscale serve` web handler: HTTPS on `host:servePort` path `/` proxied to `proxy`. */
export interface TailscaleServeRoute {
  readonly host: string;
  readonly servePort: number;
  readonly proxy: string;
}

export class TailscaleServeStatusParseError extends Schema.TaggedError<TailscaleServeStatusParseError>()(
  "TailscaleServeStatusParseError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to decode tailscale serve status JSON.";
  }
}

const TailscaleServeStatusJson = Schema.Struct({
  Web: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

const decodeTailscaleServeStatusJson = Schema.decodeEffect(
  Schema.fromJsonString(TailscaleServeStatusJson),
);

/**
 * Lists the root (`/`) proxy handlers in `tailscale serve status --json`.
 * Other handler kinds (file paths, text) and sub-paths do not serve Studio.
 */
export const parseTailscaleServeRoutes = (
  rawServeStatusJson: string,
): Effect.Effect<readonly TailscaleServeRoute[], TailscaleServeStatusParseError> =>
  decodeTailscaleServeStatusJson(rawServeStatusJson.trim() === "" ? "{}" : rawServeStatusJson).pipe(
    Effect.mapError((cause) => new TailscaleServeStatusParseError({ cause })),
    Effect.map((parsed) => {
      const routes: TailscaleServeRoute[] = [];
      for (const [hostPort, web] of Object.entries(parsed.Web ?? {})) {
        const separator = hostPort.lastIndexOf(":");
        if (separator <= 0) continue;
        const host = hostPort.slice(0, separator).replace(/\.$/u, "").toLowerCase();
        const servePort = Number(hostPort.slice(separator + 1));
        if (!Number.isInteger(servePort) || servePort < 1 || servePort > 65_535) continue;
        const handlers =
          typeof web === "object" && web !== null
            ? (web as { readonly Handlers?: unknown }).Handlers
            : undefined;
        const root =
          typeof handlers === "object" && handlers !== null
            ? (handlers as Record<string, unknown>)["/"]
            : undefined;
        const proxy =
          typeof root === "object" && root !== null
            ? (root as { readonly Proxy?: unknown }).Proxy
            : undefined;
        if (typeof proxy !== "string" || proxy.trim() === "") continue;
        routes.push({ host, servePort, proxy: proxy.trim() });
      }
      return routes;
    }),
  );

export const readTailscaleServeRoutes = runTailscale({
  subcommand: "serve",
  args: ["serve", "status", "--json"],
  timeout: TAILSCALE_STATUS_TIMEOUT,
  reportStdoutLength: true,
}).pipe(Effect.flatMap(parseTailscaleServeRoutes));

const LOOPBACK_PROXY_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * Finds the Serve route on this machine's MagicDNS name that forwards to a
 * loopback port, whoever configured it (Studio, the fleet installer, or the
 * user by hand).
 */
export function findTailscaleServeRouteForLocalPort(
  routes: readonly TailscaleServeRoute[],
  input: { readonly magicDnsName: string; readonly localPort: number },
): TailscaleServeRoute | null {
  const magicDnsName = input.magicDnsName.replace(/\.$/u, "").toLowerCase();
  const matches = routes.filter((route) => {
    if (route.host !== magicDnsName) return false;
    let target: URL;
    try {
      target = new URL(
        /^[a-z][a-z0-9+.-]*:\/\//iu.test(route.proxy) ? route.proxy : `http://${route.proxy}`,
      );
    } catch {
      return false;
    }
    if (target.protocol !== "http:") return false;
    if (!LOOPBACK_PROXY_HOSTS.has(target.hostname.toLowerCase())) return false;
    return Number(target.port || "80") === input.localPort;
  });
  // Prefer the default HTTPS port, so the link has no port in it.
  return (
    matches.find((route) => route.servePort === DEFAULT_TAILSCALE_SERVE_PORT) ?? matches[0] ?? null
  );
}

export function buildTailscaleHttpsBaseUrl(input: {
  readonly magicDnsName: string;
  readonly servePort?: number;
}): string {
  const url = new URL(`https://${input.magicDnsName}`);
  const servePort = input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT;
  if (servePort !== DEFAULT_TAILSCALE_SERVE_PORT) {
    url.port = String(servePort);
  }
  url.pathname = "/";
  return url.toString();
}

const runTailscaleCommand = (
  args: readonly string[],
  timeoutInput: Duration.Input,
): Effect.Effect<void, TailscaleCommandError, ChildProcessSpawner.ChildProcessSpawner> =>
  runTailscale({ subcommand: "serve", args, timeout: timeoutInput }).pipe(Effect.asVoid);

export const ensureTailscaleServe = (input: {
  readonly localPort: number;
  readonly servePort?: number;
  readonly localHost?: string;
}): Effect.Effect<void, TailscaleCommandError, ChildProcessSpawner.ChildProcessSpawner> => {
  const servePort = input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT;
  const localHost = input.localHost ?? "127.0.0.1";
  const args = ["serve", "--bg", `--https=${servePort}`, `http://${localHost}:${input.localPort}`];
  return runTailscaleCommand(args, TAILSCALE_SERVE_TIMEOUT);
};

export const disableTailscaleServe = (
  input: {
    readonly servePort?: number;
  } = {},
): Effect.Effect<void, TailscaleCommandError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const servePort = input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT;
    return yield* runTailscaleCommand(
      ["serve", `--https=${servePort}`, "off"],
      TAILSCALE_SERVE_TIMEOUT,
    );
  });

export const probeTailscaleHttpsEndpoint = (input: {
  readonly baseUrl: string;
  readonly timeout?: Duration.Input;
}): Effect.Effect<boolean, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* Effect.gen(function* () {
      const url = new URL("/.well-known/studio/environment", input.baseUrl);
      const request = HttpClientRequest.get(url.toString());
      return yield* client.execute(request);
    }).pipe(Effect.timeoutOption(input.timeout ?? TAILSCALE_PROBE_TIMEOUT));

    return Option.match(response, {
      onNone: () => false,
      onSome: (httpResponse) => httpResponse.status >= 200 && httpResponse.status < 300,
    });
  }).pipe(Effect.orElseSucceed(() => false));
