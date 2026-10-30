// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises Node HTTP and filesystem boundaries.
import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthStandardClientScopes } from "@specweave-studio/contracts";
import * as NetService from "@specweave-studio/shared/Net";
import { HostProcessEnvironment } from "@specweave-studio/shared/hostProcess";
import { assert, describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command, CliError } from "effect/cli";

import { cli } from "../binCli.ts";
import {
  SERVICE_LAUNCHER_CONTEXT_ENV,
  SERVICE_LAUNCHER_PROTOCOL,
} from "../cloud/serviceProtocol.ts";
import * as ServiceLauncherClient from "../cloud/serviceLauncherClient.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
  type PersistedServerRuntimeState,
} from "../serverRuntimeState.ts";
import { localServiceOrigin } from "./liveService.ts";
import { processStartedAtMs, recordedProcess } from "../persistence/processIdentity.ts";
import {
  DevServerNotProxiableError,
  resolveDirectPairingBaseUrl,
  resolveTailscaleLocalTarget,
} from "./pair.ts";

import packageJson from "../../package.json" with { type: "json" };

const layerCliRuntime = Layer.mergeAll(NodeServices.layer, NetService.layer);

const baseState = {
  version: 1,
  pid: 123,
  port: 3_773,
  origin: "http://127.0.0.1:8319",
  startedAt: "2026-06-20T00:00:00.000Z",
} as const satisfies PersistedServerRuntimeState;

describe("pair base URL selection", () => {
  it("pairs through the dev web origin when the server fronts a dev server", () => {
    expect(resolveDirectPairingBaseUrl({ ...baseState, devUrl: "http://localhost:5733/" })).toBe(
      "http://localhost:5733/",
    );
  });

  it("pairs through the bound host when there is no dev server", () => {
    expect(resolveDirectPairingBaseUrl({ ...baseState, host: "100.64.0.7" })).toBe(
      "http://100.64.0.7:3773",
    );
    expect(resolveDirectPairingBaseUrl(baseState)).toBe("http://localhost:3773");
  });
});

describe("pair tailscale local target", () => {
  it("proxies the dev web port for dev servers", () => {
    expect(resolveTailscaleLocalTarget({ ...baseState, devUrl: "http://localhost:5733/" })).toEqual(
      { localPort: 5_733 },
    );
    // A dev server on a non-loopback interface must be proxied at that
    // interface; tailscale serve defaults to 127.0.0.1 otherwise.
    expect(
      resolveTailscaleLocalTarget({ ...baseState, devUrl: "http://192.168.1.10:5733/" }),
    ).toEqual({ localPort: 5_733, localHost: "192.168.1.10" });
    // URL.hostname keeps IPv6 brackets, so the serve target stays valid.
    expect(
      resolveTailscaleLocalTarget({ ...baseState, devUrl: "http://[fd7a:115c::1]:5733/" }),
    ).toEqual({ localPort: 5_733, localHost: "[fd7a:115c::1]" });
  });

  it("rejects HTTPS dev URLs, which tailscale serve cannot proxy", () => {
    expect(
      resolveTailscaleLocalTarget({ ...baseState, devUrl: "https://localhost:5733/" }),
    ).toBeInstanceOf(DevServerNotProxiableError);
  });

  it("proxies the backend port directly otherwise", () => {
    expect(resolveTailscaleLocalTarget(baseState)).toEqual({ localPort: 3_773 });
    expect(resolveTailscaleLocalTarget({ ...baseState, host: "0.0.0.0" })).toEqual({
      localPort: 3_773,
    });
    expect(resolveTailscaleLocalTarget({ ...baseState, host: "192.168.1.42" })).toEqual({
      localPort: 3_773,
      localHost: "192.168.1.42",
    });
  });
});

const runCli = (args: ReadonlyArray<string>) => Command.runWith(cli, { version: "0.0.0" })(args);

const provideCliTestLayers = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provide(effect, Layer.mergeAll(layerCliRuntime, TestConsole.layer));

// Console output accumulates across CLI runs within a test, and each
// Console.log call is one entry — so the latest command's output is the last
// entry, even when it spans many lines.
const captureStdout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  provideCliTestLayers(
    Effect.gen(function* () {
      yield* effect;
      return (
        (yield* TestConsole.logLines).findLast(
          (line): line is string => typeof line === "string",
        ) ?? ""
      );
    }),
  );

const testDescriptor = {
  environmentId: "pair-test-environment",
  label: "pair-test",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.1",
  capabilities: { repositoryIdentity: true },
};

/** The token a running service publishes for the local CLI (auth/LocalCliCredential.ts). */
const CLI_TOKEN = "pair-test-cli-token";

interface FakePairingLink {
  readonly id: string;
  readonly subject: string;
  readonly label?: string;
  readonly scopes: ReadonlyArray<string>;
  readonly createdAt: string;
  readonly expiresAt: string;
  /** What the CLI asked for; left out means the service's five-minute default. */
  readonly ttlSeconds?: number;
}

/**
 * A running service as `pair` sees it: the environment descriptor, and the
 * auth routes it mints and lists pairing tokens through, which accept only
 * the published CLI token. `pair` never opens the service's database.
 */
const withDescriptorServer = <A, E, R>(
  run: (
    origin: string,
    links: Array<FakePairingLink>,
    seen: { bearers: number },
  ) => Effect.Effect<A, E, R>,
) => {
  const links: Array<FakePairingLink> = [];
  const seen = { bearers: 0 };
  return Effect.acquireUseRelease(
    Effect.callback<NodeHttp.Server>((resume) => {
      const server = NodeHttp.createServer((request, response) => {
        if (request.headers.authorization !== undefined) seen.bearers += 1;
        const json = (status: number, body: unknown) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(body));
        };
        if (request.url === "/.well-known/studio/environment") {
          json(200, testDescriptor);
          return;
        }
        if (request.url?.startsWith("/api/auth/")) {
          if (request.headers.authorization !== `Bearer ${CLI_TOKEN}`) {
            json(401, { _tag: "EnvironmentAuthInvalidError", message: "unauthorized" });
            return;
          }
          if (request.method === "GET" && request.url === "/api/auth/pairing-links") {
            json(200, links);
            return;
          }
          if (request.method === "POST" && request.url === "/api/auth/pairing-token") {
            let body = "";
            request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
            request.on("end", () => {
              const payload = JSON.parse(body) as {
                readonly label?: string;
                readonly scopes?: ReadonlyArray<string>;
                readonly ttlSeconds?: number;
              };
              const createdAt = DateTime.nowUnsafe();
              const link: FakePairingLink = {
                id: `pairing-${String(links.length + 1)}`,
                subject: "one-time-token",
                ...(payload.label === undefined ? {} : { label: payload.label }),
                scopes: payload.scopes ?? AuthStandardClientScopes,
                createdAt: DateTime.formatIso(createdAt),
                expiresAt: DateTime.formatIso(
                  DateTime.add(createdAt, { seconds: payload.ttlSeconds ?? 300 }),
                ),
                ...(payload.ttlSeconds === undefined ? {} : { ttlSeconds: payload.ttlSeconds }),
              };
              links.push(link);
              json(200, {
                id: link.id,
                credential: `PAIRTKN${"ABCDEFGHJK"[links.length % 10] ?? "Z"}`,
                ...(link.label === undefined ? {} : { label: link.label }),
                expiresAt: link.expiresAt,
              });
            });
            return;
          }
        }
        response.writeHead(404);
        response.end();
      });
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        return Effect.die(new Error("Expected a TCP address"));
      }
      return run(`http://127.0.0.1:${String(address.port)}`, links, seen);
    },
    (server) => Effect.sync(() => server.close()),
  );
};

/**
 * What a running service leaves in its state folder: `server-runtime.json`
 * naming this live process (with a real start time, which the test clock
 * would otherwise put in 1970) and the CLI credential beside it.
 */
const publishLiveService = (input: {
  readonly statePath: string;
  readonly port: number;
  readonly config?: Parameters<typeof makePersistedServerRuntimeState>[0]["config"];
  readonly credential?: boolean;
  /** The environment id the home recorded; the CLI sends its token only to that service. */
  readonly environmentId?: string;
}) =>
  Effect.gen(function* () {
    NodeFS.mkdirSync(NodePath.dirname(input.statePath), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(NodePath.dirname(input.statePath), "environment-id"),
      `${input.environmentId ?? testDescriptor.environmentId}\n`,
    );
    const state = yield* makePersistedServerRuntimeState({
      config: input.config ?? { host: "127.0.0.1", devUrl: undefined },
      port: input.port,
    });
    yield* persistServerRuntimeState({
      path: input.statePath,
      state: { ...state, startedAt: DateTime.formatIso(DateTime.nowUnsafe()) },
    });
    if (input.credential === false) return;
    const secretsDir = NodePath.join(NodePath.dirname(input.statePath), "secrets");
    NodeFS.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
    NodeFS.writeFileSync(NodePath.join(secretsDir, "local-cli-credential.bin"), CLI_TOKEN, {
      mode: 0o600,
    });
  });

describe("specweave-studio pair", () => {
  it.effect("mints a token and prints a QR pairing URL for a live server", () =>
    withDescriptorServer((origin) =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-pair-test-"));
        const port = Number(new URL(origin).port);
        const statePath = NodePath.join(baseDir, "userdata", "server-runtime.json");
        yield* publishLiveService({ statePath, port });

        const output = yield* captureStdout(runCli(["pair", "--base-dir", baseDir]));

        assert.include(output, `Pairing with pair-test (${origin})`);
        assert.include(output, `Pairing URL: ${origin}/pair#token=`);
        assert.isTrue(output.includes("█") || output.includes("▀") || output.includes("▄"));
        // Loopback origins are not reachable from a phone; the output must say so.
        assert.include(output, "only reachable from this machine");

        const token = /#token=([A-Z2-9]+)/.exec(output)?.[1];
        assert.isString(token);

        // The running service minted it; `auth pairing list` asks the same service.
        const listed = yield* captureStdout(
          runCli(["auth", "pairing", "list", "--base-dir", baseDir, "--json"]),
        );
        const credentials = JSON.parse(listed) as ReadonlyArray<{
          readonly label?: string;
          readonly scopes: ReadonlyArray<string>;
        }>;
        assert.equal(credentials.length, 1);
        assert.equal(credentials[0]?.label, "specweave-studio pair");
        assert.deepEqual(credentials[0]?.scopes, AuthStandardClientScopes);
        // Nothing opened the service's database: there is none in this home.
        assert.isFalse(NodeFS.existsSync(NodePath.join(baseDir, "userdata", "statev2.sqlite")));
      }),
    ).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(HostProcessEnvironment, {
        ...process.env,
        [SERVICE_LAUNCHER_CONTEXT_ENV]: JSON.stringify({
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          childVersion: packageJson.version,
        }),
      }),
      Effect.provideService(ServiceLauncherClient.ServiceLauncherHostProcess, {
        connected: false,
        send: () => false,
        on: () => undefined,
        off: () => undefined,
      }),
    ),
  );

  it.effect("mints a pairing grant with only the selected scopes", () =>
    withDescriptorServer((origin) =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "studio-pair-scopes-test-"),
        );
        yield* publishLiveService({
          statePath: NodePath.join(baseDir, "userdata", "server-runtime.json"),
          port: Number(new URL(origin).port),
        });

        yield* captureStdout(
          runCli([
            "pair",
            "--base-dir",
            baseDir,
            "--scope",
            "orchestration:read",
            "--scope",
            "relay:read",
            "--scope",
            "orchestration:read",
          ]),
        );
        const listed = yield* captureStdout(
          runCli(["auth", "pairing", "list", "--base-dir", baseDir, "--json"]),
        );
        const credentials = JSON.parse(listed) as ReadonlyArray<{
          readonly scopes: ReadonlyArray<string>;
        }>;
        assert.lengthOf(credentials, 1);
        assert.deepEqual(credentials[0]?.scopes, ["orchestration:read", "relay:read"]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("prints one JSON object with --json for local tools", () =>
    withDescriptorServer((origin) =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "studio-pair-json-test-"),
        );
        yield* publishLiveService({
          statePath: NodePath.join(baseDir, "userdata", "server-runtime.json"),
          port: Number(new URL(origin).port),
        });

        const output = yield* captureStdout(
          runCli(["pair", "--base-dir", baseDir, "--json", "--label", "SpecWithCode Desktop"]),
        );
        const parsed = JSON.parse(output.trim()) as Record<string, unknown>;
        assert.equal(parsed.origin, origin);
        assert.equal(parsed.serverLabel, "pair-test");
        assert.match(String(parsed.token), /^[A-Z2-9]+$/);
        assert.equal(parsed.pairingUrl, `${origin}/pair#token=${String(parsed.token)}`);
        assert.isFalse(output.includes("█"));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("pairs through the recorded dev web URL for dev servers", () =>
    withDescriptorServer((origin) =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-pair-dev-test-"));
        const port = Number(new URL(origin).port);
        const statePath = NodePath.join(baseDir, "dev", "server-runtime.json");
        yield* publishLiveService({
          statePath,
          port,
          config: { host: undefined, devUrl: new URL("http://localhost:5733") },
        });

        const output = yield* captureStdout(runCli(["pair", "--base-dir", baseDir]));

        assert.include(output, "Pairing URL: http://localhost:5733/pair#token=");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "creates a 30-minute pairing link through the running service, as the installed-app check does",
    () =>
      withDescriptorServer((origin, links) =>
        Effect.gen(function* () {
          const baseDir = NodeFS.mkdtempSync(
            NodePath.join(NodeOS.tmpdir(), "studio-auth-pairing-ttl-test-"),
          );
          yield* publishLiveService({
            statePath: NodePath.join(baseDir, "userdata", "server-runtime.json"),
            port: Number(new URL(origin).port),
          });

          const output = yield* captureStdout(
            runCli([
              "auth",
              "pairing",
              "create",
              "--base-dir",
              baseDir,
              "--ttl",
              "30m",
              "--label",
              "e2e",
              "--base-url",
              origin,
              "--json",
            ]),
          );

          const issued = JSON.parse(output) as { readonly pairUrl?: string };
          assert.isTrue(issued.pairUrl?.startsWith(origin));
          assert.lengthOf(links, 1);
          assert.equal(links[0]?.ttlSeconds, 1800);
          assert.equal(links[0]?.label, "e2e");
          assert.isFalse(NodeFS.existsSync(NodePath.join(baseDir, "userdata", "statev2.sqlite")));
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("passes --ttl to the running service and refuses one beyond 30 days", () =>
    withDescriptorServer((origin, links) =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-pair-ttl-test-"));
        yield* publishLiveService({
          statePath: NodePath.join(baseDir, "userdata", "server-runtime.json"),
          port: Number(new URL(origin).port),
        });

        // The desktop asks for two minutes; scripts ask for longer.
        yield* captureStdout(runCli(["pair", "--base-dir", baseDir, "--ttl", "2m", "--json"]));
        yield* captureStdout(runCli(["pair", "--base-dir", baseDir, "--ttl", "1h", "--json"]));
        yield* captureStdout(runCli(["pair", "--base-dir", baseDir, "--json"]));
        assert.deepStrictEqual(
          links.map((link) => link.ttlSeconds),
          [120, 3600, undefined],
        );

        const error = yield* provideCliTestLayers(
          runCli(["pair", "--base-dir", baseDir, "--ttl", "31 days"]).pipe(Effect.flip),
        );
        assert.include(String(error), "outside what the running SpecWithCode issues");
        assert.lengthOf(links, 3);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("says the running service published no CLI credential, opening no database", () =>
    withDescriptorServer((origin, links) =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "studio-pair-nocred-test-"),
        );
        yield* publishLiveService({
          statePath: NodePath.join(baseDir, "userdata", "server-runtime.json"),
          port: Number(new URL(origin).port),
          credential: false,
        });

        const error = yield* provideCliTestLayers(
          runCli(["pair", "--base-dir", baseDir]).pipe(Effect.flip),
        );
        assert.include(String(error), "has not published a credential for this CLI");
        assert.lengthOf(links, 0);
        assert.isFalse(NodeFS.existsSync(NodePath.join(baseDir, "userdata", "statev2.sqlite")));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "creates auth pairing tokens through the running service and refuses session issue",
    () =>
      withDescriptorServer((origin, links) =>
        Effect.gen(function* () {
          const baseDir = NodeFS.mkdtempSync(
            NodePath.join(NodeOS.tmpdir(), "studio-auth-live-test-"),
          );
          yield* publishLiveService({
            statePath: NodePath.join(baseDir, "userdata", "server-runtime.json"),
            port: Number(new URL(origin).port),
          });

          const created = yield* captureStdout(
            runCli([
              "auth",
              "pairing",
              "create",
              "--base-dir",
              baseDir,
              "--json",
              "--scope",
              "orchestration:read",
            ]),
          );
          assert.deepEqual(
            (JSON.parse(created) as { readonly scopes: ReadonlyArray<string> }).scopes,
            ["orchestration:read"],
          );
          assert.lengthOf(links, 1);

          const error = yield* provideCliTestLayers(
            runCli(["auth", "session", "issue", "--base-dir", baseDir]).pipe(Effect.flip),
          );
          assert.include(String(error), "SpecWithCode is running");
          assert.include(String(error), "Pair the device instead");
          assert.isFalse(NodeFS.existsSync(NodePath.join(baseDir, "userdata", "statev2.sqlite")));
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "directs to specweave-studio serve or specweave-studio connect when no server is running",
    () =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "studio-pair-none-test-"),
        );

        const error = yield* provideCliTestLayers(
          runCli(["pair", "--base-dir", baseDir]).pipe(Effect.flip),
        );

        const rendered = String(
          typeof error === "object" && error !== null && "cause" in error ? error.cause : error,
        );
        assert.include(rendered, "No running SpecWithCode server found.");
        assert.include(rendered, "Start one with `specweave-studio serve`");
        assert.include(rendered, "SpecWithCode Connect: `specweave-studio connect`");
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("ignores runtime state whose recorded pid is no longer alive", () =>
    withDescriptorServer((origin) =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-pair-pid-test-"));
        const statePath = NodePath.join(baseDir, "userdata", "server-runtime.json");
        // The origin answers (another server reused the port), but the pid
        // that wrote this state file is dead — pairing must not mint a token
        // into the dead server's database.
        const state = yield* makePersistedServerRuntimeState({
          config: { host: "127.0.0.1", devUrl: undefined },
          port: Number(new URL(origin).port),
        });
        yield* persistServerRuntimeState({
          path: statePath,
          // pid 2**22 + 1 exceeds any default Linux/macOS pid range.
          state: { ...state, pid: 4_194_305 },
        });

        const error = yield* provideCliTestLayers(
          runCli(["pair", "--base-dir", baseDir]).pipe(Effect.flip),
        );

        const rendered = String(
          typeof error === "object" && error !== null && "cause" in error ? error.cause : error,
        );
        assert.include(rendered, "No running SpecWithCode server found.");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("ignores runtime state whose pid now belongs to a later process", () =>
    withDescriptorServer((origin, _links, seen) =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "studio-pair-reuse-test-"),
        );
        const statePath = NodePath.join(baseDir, "userdata", "server-runtime.json");
        yield* publishLiveService({ statePath, port: Number(new URL(origin).port) });
        // The recorded pid is alive (this process) but started after the record:
        // a crash left the file and the pid was reused.
        const state = yield* makePersistedServerRuntimeState({
          config: { host: "127.0.0.1", devUrl: undefined },
          port: Number(new URL(origin).port),
        });
        yield* persistServerRuntimeState({
          path: statePath,
          state: { ...state, startedAt: "2000-01-01T00:00:00.000Z" },
        });
        // Where start times cannot be read (Windows), a live pid still counts.
        if ((yield* processStartedAtMs(process.pid)) === null) {
          assert.equal(yield* recordedProcess(process.pid, "2000-01-01T00:00:00.000Z"), "running");
          return;
        }

        const error = yield* provideCliTestLayers(
          runCli(["pair", "--base-dir", baseDir]).pipe(Effect.flip),
        );
        const rendered = String(
          typeof error === "object" && error !== null && "cause" in error ? error.cause : error,
        );
        assert.include(rendered, "No running SpecWithCode server found.");
        assert.equal(seen.bearers, 0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("sends the CLI credential only to this home's own service", () =>
    withDescriptorServer((origin, links, seen) =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-pair-impostor-"));
        // Another server answers on the recorded port with its own environment id.
        yield* publishLiveService({
          statePath: NodePath.join(baseDir, "userdata", "server-runtime.json"),
          port: Number(new URL(origin).port),
          environmentId: "this-home-environment",
        });

        const error = yield* provideCliTestLayers(
          runCli(["pair", "--base-dir", baseDir]).pipe(Effect.flip),
        );
        assert.include(String(error), "not this home's this-home-environment");
        assert.include(String(error), "the CLI credential was not sent");
        assert.equal(seen.bearers, 0);
        assert.lengthOf(links, 0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("ignores stale runtime state pointing at a dead server", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-pair-stale-test-"));
      const statePath = NodePath.join(baseDir, "userdata", "server-runtime.json");
      // A port from the dynamic range with nothing listening: the probe fails
      // fast with ECONNREFUSED and discovery moves on.
      yield* persistServerRuntimeState({
        path: statePath,
        state: yield* makePersistedServerRuntimeState({
          config: { host: "127.0.0.1", devUrl: undefined },
          port: 1,
        }),
      });

      const error = yield* provideCliTestLayers(
        runCli(["pair", "--base-dir", baseDir]).pipe(Effect.flip),
      );

      const rendered = String(
        typeof error === "object" && error !== null && "cause" in error ? error.cause : error,
      );
      assert.include(rendered, "No running SpecWithCode server found.");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("localServiceOrigin", () => {
  const state = { pid: 1, port: 8_319 } as const;
  it.effect("calls a wildcard or loopback service on its loopback address", () =>
    Effect.gen(function* () {
      assert.equal(yield* localServiceOrigin(state), "http://127.0.0.1:8319");
      assert.equal(
        yield* localServiceOrigin({ ...state, host: "0.0.0.0" }),
        "http://127.0.0.1:8319",
      );
      assert.equal(yield* localServiceOrigin({ ...state, host: "::" }), "http://127.0.0.1:8319");
      assert.equal(
        yield* localServiceOrigin({ ...state, host: "127.0.0.1" }),
        "http://127.0.0.1:8319",
      );
      assert.equal(yield* localServiceOrigin({ ...state, host: "::1" }), "http://[::1]:8319");
    }),
  );
  it.effect("refuses to send the credential to a non-loopback name or address", () =>
    Effect.gen(function* () {
      for (const host of ["m4.local", "100.64.0.7", "m4.tailnet.ts.net"]) {
        const error = yield* localServiceOrigin({ ...state, host }).pipe(Effect.flip);
        assert.include(error.message, `listens on ${host}, not on a loopback address`);
      }
    }),
  );
});

describe("auth scope options", () => {
  it.effect.each([
    { group: "pairing", action: "create" },
    { group: "session", action: "issue" },
  ] as const)(
    "issues and persists only the selected scopes for auth $group $action",
    ({ group, action }) =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "studio-cli-auth-scopes-test-"),
        );
        const output = yield* captureStdout(
          runCli([
            "auth",
            group,
            action,
            "--base-dir",
            baseDir,
            "--json",
            "--scope",
            "orchestration:read",
            "--scope",
            "access:read",
            "--scope",
            "orchestration:read",
          ]),
        );
        const issued = JSON.parse(output) as { readonly scopes: ReadonlyArray<string> };
        const listOutput = yield* captureStdout(
          runCli(["auth", group, "list", "--base-dir", baseDir, "--json"]),
        );
        const listed = JSON.parse(listOutput) as ReadonlyArray<{
          readonly scopes: ReadonlyArray<string>;
        }>;

        assert.deepEqual(issued.scopes, ["orchestration:read", "access:read"]);
        assert.lengthOf(listed, 1);
        assert.deepEqual(listed[0]?.scopes, issued.scopes);
      }),
  );

  it.effect.each(
    [["pair"], ["auth", "pairing", "create"], ["auth", "session", "issue"]].map((command) => ({
      command,
      label: command.join(" "),
    })),
  )("rejects invalid scopes before running $label", ({ command }) =>
    Effect.gen(function* () {
      const error = yield* runCli([
        ...command,
        "--scope",
        "orchestration:read",
        "--scope",
        "admin",
      ]).pipe(Effect.provide(layerCliRuntime), Effect.flip);

      if (!CliError.isCliError(error) || error._tag !== "ShowHelp") {
        assert.fail(`Expected ShowHelp, got ${String(error)}`);
      }
      assert.deepEqual(error.commandPath, ["specweave-studio", ...command]);
      const scopeError = error.errors[0];
      if (scopeError?._tag !== "InvalidValue") {
        assert.fail(`Expected InvalidValue, got ${String(scopeError?._tag)}`);
      }
      assert.equal(scopeError.option, "scope");
      assert.equal(scopeError.value, "admin");
    }),
  );
});

describe("auth pairing create --base-url", () => {
  it.effect.each(["192.168.1.5:3773", "localhost:3773", "ftp://localhost:3773"])(
    "rejects %s before issuing a token",
    (baseUrl) =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "studio-cli-base-url-test-"),
        );
        const error = yield* runCli([
          "auth",
          "pairing",
          "create",
          "--base-dir",
          baseDir,
          "--base-url",
          baseUrl,
        ]).pipe(Effect.provide(layerCliRuntime), Effect.flip);

        if (!CliError.isCliError(error) || error._tag !== "ShowHelp") {
          assert.fail(`Expected ShowHelp, got ${String(error)}`);
        }
        const flagError = error.errors[0];
        if (flagError?._tag !== "InvalidValue") {
          assert.fail(`Expected InvalidValue, got ${String(flagError?._tag)}`);
        }
        assert.equal(flagError.option, "base-url");
        assert.equal(flagError.value, baseUrl);

        const listOutput = yield* captureStdout(
          runCli(["auth", "pairing", "list", "--base-dir", baseDir, "--json"]),
        );
        assert.deepEqual(JSON.parse(listOutput), []);
      }),
  );

  it.effect.each(["http://192.168.1.5:3773", "https://example.com", "http:localhost:3773"])(
    "prints a pair URL for %s",
    (baseUrl) =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "studio-cli-base-url-test-"),
        );
        const output = yield* captureStdout(
          runCli([
            "auth",
            "pairing",
            "create",
            "--base-dir",
            baseDir,
            "--base-url",
            baseUrl,
            "--json",
          ]),
        );
        const issued = JSON.parse(output) as {
          readonly credential: string;
          readonly pairUrl: string;
        };

        assert.equal(issued.pairUrl, `${new URL(baseUrl).origin}/pair#token=${issued.credential}`);
      }),
  );
});
