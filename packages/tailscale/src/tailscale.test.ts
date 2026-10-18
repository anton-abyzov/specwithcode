import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";

import {
  buildTailscaleHttpsBaseUrl,
  disableTailscaleServe,
  ensureTailscaleServe,
  findTailscaleServeRouteForLocalPort,
  isTailscaleIpv4Address,
  MACOS_TAILSCALE_APP_EXECUTABLE,
  parseTailscaleMagicDnsName,
  parseTailscaleServeRoutes,
  parseTailscaleBackendStatus,
  parseTailscaleStatus,
  startTailscaleLogin,
  readTailscaleServeRoutes,
  readTailscaleStatus,
  TAILSCALE_STATUS_TIMEOUT,
  TailscaleCommandExitError,
  TailscaleCommandSpawnError,
  TailscaleCommandTimeoutError,
  TailscaleStatusParseError,
} from "./tailscale.ts";

const encoder = new TextEncoder();

/**
 * Asserts nothing reachable from `error` contains `secret`. Recurses through
 * nested objects, arrays, and `cause` chains rather than checking only
 * top-level strings: a leak one level down (say, a wrapped cause carrying raw
 * stderr) is just as visible in a log, and a shallow check would pass it.
 *
 * Walks values instead of serializing so it holds for fields added later, and
 * tracks visited objects so a cyclic cause chain terminates.
 */
function assertCarriesNoSecret(error: object, secret: string): void {
  const seen = new WeakSet<object>();

  const walk = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      assert.notInclude(value, secret, `${path} leaked stderr`);
      return;
    }
    if (typeof value !== "object" || value === null || seen.has(value)) {
      return;
    }
    seen.add(value);

    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${path}[${String(index)}]`));
      return;
    }
    // `message` and `cause` are getters on Error subclasses, so they are not
    // own enumerable properties and Object.entries alone would skip them.
    walk((value as { message?: unknown }).message, `${path}.message`);
    walk((value as { cause?: unknown }).cause, `${path}.cause`);
    for (const [key, nested] of Object.entries(value)) {
      walk(nested, `${path}.${key}`);
    }
  };

  walk(error, "error");
}
const tailscaleStatusJson = `{"Self":{"DNSName":"desktop.tail.ts.net.","TailscaleIPs":["100.100.100.100","fd7a:115c:a1e0::1","192.168.1.20"]}}`;
const tailscaleStatusWithSingleIpJson = `{"Self":{"DNSName":"desktop.tail.ts.net.","TailscaleIPs":["100.90.1.2"]}}`;

function mockHandle(result: { stdout?: string; stderr?: string; code?: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout ?? "")),
    stderr: Stream.make(encoder.encode(result.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function neverFinishingMockHandle() {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.never,
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

// The executable name depends on the host platform (`tailscale.exe` on
// Windows), so pin it: these tests assert the posix spelling.
function layerSpawner(spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) {
  return Layer.merge(
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Layer.succeed(HostProcessPlatform, "linux"),
  );
}

function layerMockSpawner(
  handler: (
    command: string,
    args: ReadonlyArray<string>,
  ) => { stdout?: string; stderr?: string; code?: number },
) {
  return layerSpawner(
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      return Effect.succeed(mockHandle(handler(childProcess.command, childProcess.args)));
    }),
  );
}

describe("tailscale", () => {
  it.effect("detects Tailnet IPv4 addresses", () =>
    Effect.sync(() => {
      assert.equal(isTailscaleIpv4Address("100.64.0.1"), true);
      assert.equal(isTailscaleIpv4Address("100.127.255.254"), true);
      assert.equal(isTailscaleIpv4Address("100.128.0.1"), false);
      assert.equal(isTailscaleIpv4Address("192.168.1.44"), false);
    }),
  );

  it.effect("parses MagicDNS names from tailscale status", () =>
    Effect.gen(function* () {
      const dnsName = yield* parseTailscaleMagicDnsName(tailscaleStatusJson);
      assert.equal(dnsName, "desktop.tail.ts.net");
      assert.equal(yield* parseTailscaleMagicDnsName("{}"), null);
    }),
  );

  it.effect("parses status facts", () =>
    Effect.gen(function* () {
      const status = yield* parseTailscaleStatus(tailscaleStatusJson);
      assert.deepEqual(status, {
        magicDnsName: "desktop.tail.ts.net",
        tailnetIpv4Addresses: ["100.100.100.100"],
      });
    }),
  );

  it.effect("preserves status decoding failures without exposing cause text", () =>
    Effect.gen(function* () {
      const error = yield* parseTailscaleStatus("{not-json").pipe(Effect.flip);

      assert.instanceOf(error, TailscaleStatusParseError);
      assert.equal(error.message, "Failed to decode tailscale status JSON.");
      assert.isDefined(error.cause);
      assert.notInclude(error.message, String(error.cause));
    }),
  );

  it.effect("builds clean HTTPS base URLs", () =>
    Effect.sync(() => {
      assert.equal(
        buildTailscaleHttpsBaseUrl({ magicDnsName: "desktop.tail.ts.net" }),
        "https://desktop.tail.ts.net/",
      );
      assert.equal(
        buildTailscaleHttpsBaseUrl({ magicDnsName: "desktop.tail.ts.net", servePort: 8443 }),
        "https://desktop.tail.ts.net:8443/",
      );
    }),
  );

  it.effect("reads tailscale status through the process spawner service", () => {
    const layer = layerMockSpawner((command, args) => {
      assert.equal(command, "tailscale");
      assert.deepEqual(args, ["status", "--json"]);
      return {
        stdout: tailscaleStatusWithSingleIpJson,
      };
    });

    return Effect.gen(function* () {
      const status = yield* readTailscaleStatus.pipe(Effect.provide(layer));
      assert.deepEqual(status, {
        magicDnsName: "desktop.tail.ts.net",
        tailnetIpv4Addresses: ["100.90.1.2"],
      });
    });
  });

  it.effect("preserves tailscale spawn failures as causes", () => {
    const systemCause = new Error("private executable lookup detail");
    const cause = PlatformError.systemError({
      _tag: "NotFound",
      module: "ChildProcess",
      method: "spawn",
      cause: systemCause,
    });
    const layer = layerSpawner(ChildProcessSpawner.make(() => Effect.fail(cause)));

    return Effect.gen(function* () {
      const error = yield* readTailscaleStatus.pipe(Effect.flip, Effect.provide(layer));

      assert.instanceOf(error, TailscaleCommandSpawnError);
      assert.equal(error.executable, "tailscale");
      assert.equal(error.subcommand, "status");
      assert.equal(error.argumentCount, 2);
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message, "Failed to spawn tailscale status.");
      assert.notInclude(error.message, systemCause.message);
    });
  });

  it.effect("turns spawn defects into typed spawn failures", () => {
    // A non-directory entry on PATH makes node's spawn throw ENOTDIR
    // synchronously. The platform spawner calls `NodeChildProcess.spawn` from
    // inside an `Effect.callback` registration, so that throw arrives as a
    // defect rather than a typed error - the shape reproduced here.
    const defect = Object.assign(new Error("spawn tailscale ENOTDIR"), { code: "ENOTDIR" });
    const layer = layerSpawner(
      ChildProcessSpawner.make(() =>
        Effect.callback<never, never>(() => {
          throw defect;
        }),
      ),
    );

    return Effect.gen(function* () {
      const statusError = yield* readTailscaleStatus.pipe(Effect.flip, Effect.provide(layer));
      assert.instanceOf(statusError, TailscaleCommandSpawnError);
      assert.equal(statusError.subcommand, "status");
      assert.strictEqual(statusError.cause, defect);

      const serveError = yield* ensureTailscaleServe({ localPort: 13773, servePort: 8443 }).pipe(
        Effect.flip,
        Effect.provide(layer),
      );
      assert.instanceOf(serveError, TailscaleCommandSpawnError);
      assert.equal(serveError.subcommand, "serve");
      assert.strictEqual(serveError.cause, defect);

      // What callers actually rely on: the desktop endpoint providers recover
      // with `Effect.orElseSucceed`, which only sees the typed error channel.
      const degraded = yield* readTailscaleStatus.pipe(
        Effect.orElseSucceed(() => null),
        Effect.provide(layer),
      );
      assert.equal(degraded, null);
    });
  });

  it.effect("keeps nonzero exit diagnostics structured", () => {
    const layer = layerMockSpawner(() => ({
      code: 7,
      stderr: "not logged in tskey-auth-secret-token-value",
    }));

    return Effect.gen(function* () {
      const error = yield* readTailscaleStatus.pipe(Effect.flip, Effect.provide(layer));

      assert.instanceOf(error, TailscaleCommandExitError);
      assert.equal(error.executable, "tailscale");
      assert.equal(error.subcommand, "status");
      assert.equal(error.argumentCount, 2);
      assert.equal(error.exitCode, 7);
      assert.equal(error.stdoutLength, 0);
      assert.equal(error.stderrLength, 43);
      assert.notProperty(error, "command");
      assert.notProperty(error, "stderr");
      assert.notInclude(error.message, "tskey-auth-secret-token-value");
      assert.equal(error.message, "tailscale status exited with code 7.");
      assert.equal(error.stderrDiagnostic, "not-logged-in");
      assertCarriesNoSecret(error, "tskey-auth-secret-token-value");
    });
  });

  it.effect("classifies unrecognized stderr without quoting it", () => {
    const layer = layerMockSpawner(() => ({
      code: 3,
      stderr: "something novel went wrong for node fluffy-badger tskey-auth-secret-token-value",
    }));

    return Effect.gen(function* () {
      const error = yield* readTailscaleStatus.pipe(Effect.flip, Effect.provide(layer));

      assert.instanceOf(error, TailscaleCommandExitError);
      // Unmatched stderr degrades to "unknown" rather than passing text
      // through — that fallback is what keeps novel output from leaking.
      assert.equal(error.stderrDiagnostic, "unknown");
      assertCarriesNoSecret(error, "tskey-auth-secret-token-value");
      assertCarriesNoSecret(error, "fluffy-badger");
    });
  });

  it.effect("times out tailscale status through TestClock", () => {
    const layer = Layer.merge(
      TestClock.layer(),
      layerSpawner(ChildProcessSpawner.make(() => Effect.succeed(neverFinishingMockHandle()))),
    );

    return Effect.gen(function* () {
      const fiber = yield* readTailscaleStatus.pipe(Effect.flip, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(TAILSCALE_STATUS_TIMEOUT);
      const error = yield* Fiber.join(fiber);

      assert.instanceOf(error, TailscaleCommandTimeoutError);
      assert.equal(error.executable, "tailscale");
      assert.equal(error.subcommand, "status");
      assert.equal(error.argumentCount, 2);
      assert.equal(error.timeoutMs, 1_500);
      assert.isTrue(Cause.isTimeoutError(error.cause));
      assert.equal(error.message, "tailscale status timed out after 1500ms.");
    }).pipe(Effect.provide(layer));
  });

  it.effect("configures tailscale serve through the process spawner service", () => {
    const layer = layerMockSpawner((command, args) => {
      assert.equal(command, "tailscale");
      assert.deepEqual(args, ["serve", "--bg", "--https=8443", "http://127.0.0.1:13773"]);
      return {};
    });

    return ensureTailscaleServe({ localPort: 13773, servePort: 8443 }).pipe(Effect.provide(layer));
  });

  it.effect("retains tailscale serve exit diagnostics", () => {
    const layer = layerMockSpawner(() => ({
      code: 1,
      stderr: "serve permission denied tskey-auth-secret-token-value",
    }));

    return Effect.gen(function* () {
      const error = yield* ensureTailscaleServe({ localPort: 13773, servePort: 8443 }).pipe(
        Effect.flip,
        Effect.provide(layer),
      );

      assert.instanceOf(error, TailscaleCommandExitError);
      assert.equal(error.executable, "tailscale");
      assert.equal(error.subcommand, "serve");
      assert.equal(error.argumentCount, 4);
      assert.equal(error.exitCode, 1);
      assert.equal(error.stderrLength, 53);
      assert.notProperty(error, "command");
      assert.notProperty(error, "stderr");
      assert.notInclude(error.message, "tskey-auth-secret-token-value");
      // The diagnostic classifies the failure without quoting stderr, so the
      // key cannot reach a log through it either.
      assert.equal(error.stderrDiagnostic, "permission-denied");
      assertCarriesNoSecret(error, "tskey-auth-secret-token-value");
    });
  });

  it.effect("disables tailscale serve through the process spawner service", () => {
    const commands: {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
    }[] = [];
    const layer = layerMockSpawner((command, args) => {
      commands.push({ command, args });
      assert.equal(command, "tailscale");
      assert.deepEqual(args, ["serve", "--https=8443", "off"]);
      return {};
    });

    return Effect.gen(function* () {
      yield* disableTailscaleServe({ servePort: 8443 }).pipe(Effect.provide(layer));
      assert.deepEqual(commands, [
        { command: "tailscale", args: ["serve", "--https=8443", "off"] },
      ]);
    });
  });

  it.effect("falls back to the Tailscale app executable on macOS", () => {
    const commands: string[] = [];
    let appEnv: unknown;
    const notFound = PlatformError.systemError({
      _tag: "NotFound",
      module: "ChildProcess",
      method: "spawn",
      cause: new Error("spawn tailscale ENOENT"),
    });
    const layer = Layer.merge(
      Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => {
          const { command: executable, options } = command as unknown as {
            readonly command: string;
            readonly options: { readonly env?: unknown; readonly extendEnv?: boolean };
          };
          commands.push(executable);
          if (executable !== "tailscale") appEnv = options;
          return executable === "tailscale"
            ? Effect.fail(notFound)
            : Effect.succeed(mockHandle({ stdout: tailscaleStatusWithSingleIpJson }));
        }),
      ),
      Layer.succeed(HostProcessPlatform, "darwin"),
    );

    return Effect.gen(function* () {
      const status = yield* readTailscaleStatus.pipe(Effect.provide(layer));
      assert.equal(status.magicDnsName, "desktop.tail.ts.net");
      assert.deepEqual(commands, ["tailscale", MACOS_TAILSCALE_APP_EXECUTABLE]);
      // Without this the app binary starts its GUI instead of answering.
      assert.deepInclude(appEnv, { env: { TAILSCALE_BE_CLI: "1" }, extendEnv: true });
    });
  });

  it.effect("labels the macOS app executable without its path when it fails", () => {
    const layer = Layer.merge(
      Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => {
          const { command: executable } = command as unknown as { readonly command: string };
          return executable === "tailscale"
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "NotFound",
                  module: "ChildProcess",
                  method: "spawn",
                  cause: new Error("spawn tailscale ENOENT"),
                }),
              )
            : Effect.succeed(mockHandle({ code: 1, stderr: "not logged in" }));
        }),
      ),
      Layer.succeed(HostProcessPlatform, "darwin"),
    );

    return Effect.gen(function* () {
      const error = yield* readTailscaleStatus.pipe(Effect.flip, Effect.provide(layer));
      assert.instanceOf(error, TailscaleCommandExitError);
      assert.equal(error.executable, "Tailscale.app");
      assert.equal(error.stderrDiagnostic, "not-logged-in");
    });
  });

  it.effect("does not fall back when tailscale ran and failed", () => {
    const commands: string[] = [];
    const layer = Layer.merge(
      Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => {
          const { command: executable } = command as unknown as { readonly command: string };
          commands.push(executable);
          return Effect.succeed(mockHandle({ code: 1 }));
        }),
      ),
      Layer.succeed(HostProcessPlatform, "darwin"),
    );

    return Effect.gen(function* () {
      yield* readTailscaleStatus.pipe(Effect.flip, Effect.provide(layer));
      assert.deepEqual(commands, ["tailscale"]);
    });
  });

  it.effect("reads tailscale serve routes", () => {
    const serveStatus = JSON.stringify({
      TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true } },
      Web: {
        "desktop.tail.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8319" } } },
        "desktop.tail.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:18319" } } },
        "desktop.tail.ts.net:8444": { Handlers: { "/docs": { Path: "/srv/docs" } } },
      },
    });
    const layer = layerMockSpawner((command, args) => {
      assert.equal(command, "tailscale");
      assert.deepEqual(args, ["serve", "status", "--json"]);
      return { stdout: serveStatus };
    });

    return Effect.gen(function* () {
      const routes = yield* readTailscaleServeRoutes.pipe(Effect.provide(layer));
      assert.deepEqual(routes, [
        { host: "desktop.tail.ts.net", servePort: 443, proxy: "http://127.0.0.1:8319" },
        { host: "desktop.tail.ts.net", servePort: 8443, proxy: "http://127.0.0.1:18319" },
      ]);
    });
  });

  it.effect("treats an empty serve config as no routes", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* parseTailscaleServeRoutes("{}"), []);
      assert.deepEqual(yield* parseTailscaleServeRoutes(""), []);
    }),
  );

  it.effect("finds the serve route that forwards to a loopback port", () =>
    Effect.sync(() => {
      const routes = [
        { host: "desktop.tail.ts.net", servePort: 8443, proxy: "http://127.0.0.1:8319" },
        { host: "desktop.tail.ts.net", servePort: 443, proxy: "http://localhost:8319" },
        { host: "desktop.tail.ts.net", servePort: 8444, proxy: "http://127.0.0.1:18319" },
        { host: "other.tail.ts.net", servePort: 443, proxy: "http://127.0.0.1:3773" },
        { host: "desktop.tail.ts.net", servePort: 9443, proxy: "http://192.168.1.5:3773" },
        { host: "desktop.tail.ts.net", servePort: 10443, proxy: "127.0.0.1:4000" },
      ];
      assert.deepEqual(
        findTailscaleServeRouteForLocalPort(routes, {
          magicDnsName: "Desktop.tail.ts.net.",
          localPort: 8319,
        }),
        { host: "desktop.tail.ts.net", servePort: 443, proxy: "http://localhost:8319" },
      );
      assert.equal(
        findTailscaleServeRouteForLocalPort(routes, {
          magicDnsName: "desktop.tail.ts.net",
          localPort: 4000,
        })?.servePort,
        10443,
      );
      assert.isNull(
        findTailscaleServeRouteForLocalPort(routes, {
          magicDnsName: "desktop.tail.ts.net",
          localPort: 3773,
        }),
      );
    }),
  );
});

describe("tailscale sign-in", () => {
  const waitingHandle = (output: string) =>
    ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1),
      exitCode: Effect.never,
      isRunning: Effect.succeed(true),
      kill: () => Effect.void,
      unref: Effect.succeed(Effect.void),
      stdin: Sink.drain,
      stdout: Stream.empty,
      stderr: Stream.make(encoder.encode(output)),
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    });

  it.effect("reads whether Tailscale is signed in from BackendState", () =>
    Effect.gen(function* () {
      assert.deepEqual(
        yield* parseTailscaleBackendStatus(
          `{"BackendState":"Running","Self":{"DNSName":"mac.tail.ts.net."}}`,
        ),
        { backendState: "Running", magicDnsName: "mac.tail.ts.net" },
      );
      assert.deepEqual(yield* parseTailscaleBackendStatus(`{"BackendState":"NeedsLogin"}`), {
        backendState: "NeedsLogin",
        magicDnsName: null,
      });
      assert.deepEqual(yield* parseTailscaleBackendStatus("{}"), {
        backendState: null,
        magicDnsName: null,
      });
    }),
  );

  it.effect("returns the sign-in link `tailscale up` prints, without flags or keys", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const layer = layerSpawner(
      ChildProcessSpawner.make((command) => {
        calls.push((command as unknown as { readonly args: ReadonlyArray<string> }).args);
        return Effect.succeed(
          waitingHandle(
            "\nTo authenticate, visit:\n\n\thttps://login.tailscale.com/a/synthetic123\n\n",
          ),
        );
      }),
    );
    return Effect.gen(function* () {
      const started = yield* startTailscaleLogin().pipe(Effect.provide(layer));
      assert.deepEqual(started, { loginUrl: "https://login.tailscale.com/a/synthetic123" });
      assert.deepEqual(calls, [["up"]]);
    });
  });

  it.effect("returns no link when this machine is already signed in", () =>
    Effect.gen(function* () {
      const started = yield* startTailscaleLogin().pipe(
        Effect.provide(layerMockSpawner(() => ({ stdout: "" }))),
      );
      assert.deepEqual(started, { loginUrl: null });
    }),
  );

  it.effect("names a refusal that needs an administrator without returning its output", () =>
    Effect.gen(function* () {
      const error = yield* startTailscaleLogin().pipe(
        Effect.provide(
          layerMockSpawner(() => ({
            stderr: "Access denied: prefs write access denied tskey-secret",
            code: 1,
          })),
        ),
        Effect.flip,
      );
      assert.instanceOf(error, TailscaleCommandExitError);
      assert.equal((error as TailscaleCommandExitError).stderrDiagnostic, "permission-denied");
      assertCarriesNoSecret(error, "tskey-secret");
    }),
  );
});
