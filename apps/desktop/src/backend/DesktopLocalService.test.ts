import * as DateTime from "effect/DateTime";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native fixtures independently verify Electron and installed operating-system behavior.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native fixtures independently verify Electron and installed operating-system behavior.
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native fixtures independently verify Electron and installed operating-system behavior.
import * as NodePath from "node:path";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, beforeEach, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopLocalService from "./DesktopLocalService.ts";
import { DESKTOP_SERVICE_CREDENTIAL_FILE } from "./desktopServiceCredential.ts";
import serverPackageJson from "../../../server/package.json" with { type: "json" };

const { execFileMock, execFileSyncMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn(),
}));
vi.mock("node:child_process", () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
}));
vi.mock("electron", () => ({ safeStorage: {} }));

const DESCRIPTOR = {
  environmentId: "eb4f852f-8bef-4c24-9dc6-19b38ce1e31e",
  label: "Anton's Mac",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.1.4",
  orchestrationProtocolVersion: 2,
  capabilities: { repositoryIdentity: true },
};

// A stand-in for the installed service: answers the environment descriptor.
const withDescriptorServer = <A, E, R>(use: (origin: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(
      () =>
        new Promise<NodeHttp.Server>((resolve) => {
          const server = NodeHttp.createServer((request, response) => {
            if (request.url === "/.well-known/studio/environment") {
              response.setHeader("content-type", "application/json");
              response.end(JSON.stringify(DESCRIPTOR));
              return;
            }
            response.statusCode = 404;
            response.end();
          });
          server.listen(0, "127.0.0.1", () => resolve(server));
        }),
    ),
    (server) => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      return use(`http://127.0.0.1:${port}`);
    },
    (server) => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
  );

const writeJson = (path: string, value: unknown) => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, JSON.stringify(value));
};

/** A home with the fleet installer's `m4` service, which owns its own Studio home. */
const makeHomeWithInstalledService = (origin: string) => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-local-service-"));
  const studioHome = NodePath.join(home, ".specweave-studio", "m4");
  writeJson(NodePath.join(studioHome, "installation.json"), {
    schemaVersion: 1,
    identity: "m4",
    studioHome,
    stateDir: NodePath.join(studioHome, "userdata"),
    service: { installed: true, domain: "gui/501", label: "com.specweave.studio.m4" },
  });
  writeJson(NodePath.join(studioHome, "userdata", "server-runtime.json"), {
    version: 1,
    // A live process other than this one.
    pid: process.ppid,
    port: Number(new URL(origin).port),
    origin,
    startedAt: "2026-10-09T18:00:00.000Z",
  });
  return { home, studioHome };
};

const layerFor = (
  home: string,
  env: Readonly<Record<string, string>> = {},
  overrides?: {
    readonly httpClient: HttpClient.HttpClient;
    readonly crypto: ElectronSafeStorage.ElectronSafeStorage["Service"];
  },
  readFreeDiskBytes?: DesktopLocalService.FreeDiskBytesReader,
  platform: NodeJS.Platform = "darwin",
  // By default launchd no longer runs the service, so it gets only the usual grace.
  readLaunchdJob: DesktopLocalService.LaunchdJobStateReader = () => Effect.succeed("absent"),
) =>
  DesktopLocalService.layer.pipe(
    Layer.provide(Layer.succeed(DesktopLocalService.LaunchdJob, readLaunchdJob)),
    Layer.provide(
      readFreeDiskBytes === undefined
        ? Layer.empty
        : Layer.succeed(DesktopLocalService.FreeDiskBytes, readFreeDiskBytes),
    ),
    Layer.provide(
      DesktopEnvironment.layer({
        dirname: "/repo/apps/desktop/src",
        homeDirectory: home,
        platform,
        processArch: "arm64",
        appVersion: "0.1.4",
        appPath: "/repo",
        isPackaged: true,
        resourcesPath: "/missing/resources",
        runningUnderArm64Translation: false,
      }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest(env)))),
    ),
    Layer.provide(
      overrides
        ? Layer.succeed(HttpClient.HttpClient, overrides.httpClient)
        : NodeHttpClient.layerUndici,
    ),
    Layer.provide(
      Layer.succeed(
        ElectronSafeStorage.ElectronSafeStorage,
        overrides?.crypto ?? {
          isEncryptionAvailable: Effect.succeed(false),
          encryptString: () => Effect.die("discovery never stores a bearer"),
          decryptString: () => Effect.die("discovery never reads a bearer"),
          selectedStorageBackend: Effect.succeedNone,
        },
      ),
    ),
  );

describe("DesktopLocalService.bearerToken", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset().mockReturnValue("");
    execFileMock
      .mockReset()
      .mockImplementation(
        (
          _command: string,
          _args: ReadonlyArray<string>,
          _options: unknown,
          callback: (error: Error | null, stdout: string) => void,
        ) => callback(null, "Token: synthetic-pairing-token"),
      );
  });

  const crypto: ElectronSafeStorage.ElectronSafeStorage["Service"] = {
    isEncryptionAvailable: Effect.succeed(true),
    encryptString: (token) => Effect.succeed(Buffer.from(`encrypted:${token}`)),
    decryptString: (encrypted) =>
      Effect.succeed(Buffer.from(encrypted).toString().slice("encrypted:".length)),
    selectedStorageBackend: Effect.succeedNone,
  };

  const validSession = {
    authenticated: true,
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["bearer-access-token"],
      sessionCookieName: "studio_session",
    },
    sessionMethod: "bearer-access-token",
  };
  const newerAuth = { ...validSession.auth, policy: "a-policy-from-a-newer-service" };
  const malformedSessions = [
    { failure: "empty-object", body: {} },
    { failure: "null-body", body: null },
    { failure: "array-body", body: [] },
    { failure: "error-envelope", body: { error: "service still starting" } },
    { failure: "missing-auth", body: { authenticated: true } },
    { failure: "wrong-authenticated", body: { ...validSession, authenticated: "true" } },
    { failure: "wrong-auth", body: { ...validSession, auth: [] } },
    {
      failure: "missing-auth-methods",
      body: {
        ...validSession,
        auth: { policy: "remote-reachable", sessionCookieName: "studio_session" },
      },
    },
    {
      failure: "wrong-bootstrap-methods",
      body: { ...validSession, auth: { ...validSession.auth, bootstrapMethods: "one-time-token" } },
    },
    { failure: "wrong-session-method", body: { ...validSession, sessionMethod: 1 } },
    { failure: "invalid-expiry", body: { ...validSession, expiresAt: "not-a-date" } },
    {
      failure: "newer-policy-with-wrong-authenticated",
      body: { ...validSession, authenticated: "true", auth: newerAuth },
    },
    {
      failure: "newer-policy-with-invalid-expiry",
      body: { ...validSession, auth: newerAuth, expiresAt: "not-a-date" },
    },
    {
      failure: "newer-policy-with-wrong-method-entry",
      body: { ...validSession, auth: { ...newerAuth, sessionMethods: [42] } },
    },
    {
      failure: "newer-policy-with-missing-cookie-name",
      body: {
        ...validSession,
        auth: { policy: newerAuth.policy, bootstrapMethods: [], sessionMethods: [] },
      },
    },
    {
      failure: "newer-policy-with-wrong-scopes",
      body: { ...validSession, auth: newerAuth, scopes: "orchestration:read" },
    },
    {
      failure: "empty-policy",
      body: { ...validSession, auth: { ...validSession.auth, policy: " " } },
    },
    {
      failure: "newer-policy-with-empty-method",
      body: { ...validSession, auth: newerAuth, sessionMethod: "" },
    },
    {
      failure: "newer-policy-with-wrong-permission-entry",
      body: { ...validSession, auth: newerAuth, permissions: [42] },
    },
  ] as const;

  it.effect.each([
    { failure: "fetch", recovery: "reuse" },
    { failure: "fetch", recovery: "replace" },
    { failure: "timeout", recovery: "reuse" },
    { failure: "timeout", recovery: "replace" },
    { failure: "503", recovery: "reuse" },
    { failure: "503", recovery: "replace" },
    { failure: "invalid-json", recovery: "reuse" },
    { failure: "invalid-json", recovery: "replace" },
    { failure: "undeclared-401", recovery: "reuse" },
    ...malformedSessions.map((testCase) => ({ ...testCase, recovery: "reuse" as const })),
    // An HTTP 200 with no session state (an empty object, or an error envelope from
    // a service still starting) must not pair; a later authoritative "not
    // authenticated" reply on the same instance is what replaces the login.
    ...malformedSessions
      .filter(({ failure }) => failure === "empty-object" || failure === "error-envelope")
      .map((testCase) => ({ ...testCase, recovery: "replace" as const })),
  ] as const)(
    "handles $failure before $recovery without caching an unverified bearer",
    (testCase) => {
      const { failure, recovery } = testCase;
      const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-bearer-retry-"));
      const filePath = NodePath.join(
        home,
        ".specweave-studio",
        "userdata",
        DESKTOP_SERVICE_CREDENTIAL_FILE,
      );
      writeJson(filePath, {
        [DESCRIPTOR.environmentId]: {
          encryptedBearerToken: Buffer.from("encrypted:stored-bearer").toString("base64"),
        },
      });
      const before = NodeFS.readFileSync(filePath);
      const encryptString = vi.fn(crypto.encryptString);
      let sessionChecks = 0;
      let exchanges = 0;
      const httpClient = HttpClient.make((request) => {
        const path = new URL(request.url).pathname;
        if (path === "/api/auth/session") {
          sessionChecks += 1;
          assert.strictEqual(request.headers.authorization, "Bearer stored-bearer");
          if (sessionChecks === 1) {
            if ("body" in testCase) {
              return Effect.succeed(
                HttpClientResponse.fromWeb(request, Response.json(testCase.body)),
              );
            }
            if (failure === "503" || failure === "invalid-json" || failure === "undeclared-401") {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  failure === "invalid-json"
                    ? new Response("{not json", {
                        headers: { "content-type": "application/json" },
                      })
                    : new Response("unavailable", { status: failure === "503" ? 503 : 401 }),
                ),
              );
            }
            return failure === "timeout"
              ? Effect.never
              : Effect.fail(
                  new HttpClientError.HttpClientError({
                    reason: new HttpClientError.TransportError({
                      request,
                      cause: "synthetic connection reset",
                    }),
                  }),
                );
          }
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                authenticated: recovery === "reuse",
                auth: {
                  policy: "remote-reachable",
                  bootstrapMethods: ["one-time-token"],
                  sessionMethods: ["bearer-access-token"],
                  sessionCookieName: "studio_session",
                },
                sessionMethod: "bearer-access-token",
              }),
            ),
          );
        }
        assert.strictEqual(path, "/oauth/token");
        exchanges += 1;
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              access_token: "replacement-bearer",
              issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
              token_type: "Bearer",
              expires_in: 3600,
              scope: "orchestration:read",
            }),
          ),
        );
      });

      return Effect.gen(function* () {
        const service = yield* DesktopLocalService.DesktopLocalService;
        yield* service.attach({
          baseDir: NodePath.join(home, ".specweave-studio", "m4"),
          runtime: { pid: 123, port: 8319, origin: "http://service.test", serviceManaged: true },
          descriptor: {
            ...DESCRIPTOR,
            serverVersion: serverPackageJson.version,
          } as DesktopLocalService.AttachedLocalService["descriptor"],
          httpBaseUrl: new URL("http://service.test"),
        });
        const first = yield* service.bearerToken.pipe(Effect.result, Effect.forkChild);
        if (failure === "timeout") yield* TestClock.adjust("10 seconds");
        const result = yield* Fiber.join(first);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result))
          assert.strictEqual(result.failure._tag, "DesktopLocalServicePairingError");
        assert.deepStrictEqual(NodeFS.readFileSync(filePath), before);
        assert.lengthOf(execFileMock.mock.calls, 0);
        assert.lengthOf(execFileSyncMock.mock.calls, 0);
        assert.strictEqual(exchanges, 0);
        assert.strictEqual(sessionChecks, 1);
        assert.lengthOf(encryptString.mock.calls, 0);

        const expected = recovery === "reuse" ? "stored-bearer" : "replacement-bearer";
        assert.strictEqual(yield* service.bearerToken, expected);
        assert.strictEqual(yield* service.bearerToken, expected);
        assert.strictEqual(sessionChecks, 2);
        assert.strictEqual(exchanges, recovery === "reuse" ? 0 : 1);
        assert.lengthOf(execFileMock.mock.calls, exchanges);
        assert.lengthOf(encryptString.mock.calls, exchanges);
        if (recovery === "reuse") assert.deepStrictEqual(NodeFS.readFileSync(filePath), before);
        else
          assert.strictEqual(
            JSON.parse(NodeFS.readFileSync(filePath, "utf8"))[DESCRIPTOR.environmentId]
              .encryptedBearerToken,
            Buffer.from("encrypted:replacement-bearer").toString("base64"),
          );
      }).pipe(
        Effect.provide(
          layerFor(home, {}, { httpClient, crypto: { ...crypto, encryptString } }).pipe(
            Layer.provideMerge(TestClock.layer()),
          ),
        ),
        Effect.ensuring(Effect.sync(() => NodeFS.rmSync(home, { recursive: true, force: true }))),
      );
    },
  );
  it.effect.each([
    { field: "policy", body: { ...validSession, auth: newerAuth } },
    {
      field: "bootstrap method",
      body: {
        ...validSession,
        auth: { ...validSession.auth, bootstrapMethods: ["new-bootstrap"] },
      },
    },
    {
      field: "supported session method",
      body: { ...validSession, auth: { ...validSession.auth, sessionMethods: ["new-session"] } },
    },
    { field: "session method", body: { ...validSession, sessionMethod: "new-session" } },
    { field: "scope", body: { ...validSession, scopes: ["new-scope"] } },
    {
      field: "update scope",
      body: {
        ...validSession,
        auth: { ...validSession.auth, serverUpdateScope: "new-update-scope" },
      },
    },
  ])("pairs again for a complete session with an unknown $field", ({ body }) => {
    // Preserve the intentional newer-service compatibility path, but require
    // a complete session response rather than accepting any JSON schema error.
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-bearer-schema-"));
    const filePath = NodePath.join(
      home,
      ".specweave-studio",
      "userdata",
      DESKTOP_SERVICE_CREDENTIAL_FILE,
    );
    writeJson(filePath, {
      [DESCRIPTOR.environmentId]: {
        encryptedBearerToken: Buffer.from("encrypted:stored-bearer").toString("base64"),
      },
    });
    const encryptString = vi.fn(crypto.encryptString);
    let sessionChecks = 0;
    let exchanges = 0;
    const httpClient = HttpClient.make((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/auth/session") {
        sessionChecks += 1;
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body)));
      }
      assert.strictEqual(path, "/oauth/token");
      exchanges += 1;
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            access_token: "replacement-bearer",
            issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
            token_type: "Bearer",
            expires_in: 3600,
            scope: "orchestration:read",
          }),
        ),
      );
    });

    return Effect.gen(function* () {
      const service = yield* DesktopLocalService.DesktopLocalService;
      yield* service.attach({
        baseDir: NodePath.join(home, ".specweave-studio", "m4"),
        runtime: { pid: 123, port: 8319, origin: "http://service.test", serviceManaged: true },
        descriptor: {
          ...DESCRIPTOR,
          serverVersion: serverPackageJson.version,
        } as DesktopLocalService.AttachedLocalService["descriptor"],
        httpBaseUrl: new URL("http://service.test"),
      });
      assert.strictEqual(yield* service.bearerToken, "replacement-bearer");
      assert.strictEqual(yield* service.bearerToken, "replacement-bearer");
      assert.strictEqual(sessionChecks, 1);
      assert.strictEqual(exchanges, 1);
      assert.lengthOf(execFileMock.mock.calls, 1);
      assert.lengthOf(encryptString.mock.calls, 1);
      assert.strictEqual(
        JSON.parse(NodeFS.readFileSync(filePath, "utf8"))[DESCRIPTOR.environmentId]
          .encryptedBearerToken,
        Buffer.from("encrypted:replacement-bearer").toString("base64"),
      );
    }).pipe(
      Effect.provide(layerFor(home, {}, { httpClient, crypto: { ...crypto, encryptString } })),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(home, { recursive: true, force: true }))),
    );
  });
});

describe("DesktopLocalService pairing on Windows", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    execFileMock
      .mockReset()
      .mockImplementation(
        (
          _command: string,
          _args: ReadonlyArray<string>,
          _options: unknown,
          callback: (error: Error | null, stdout: string) => void,
        ) => callback(null, "Token: synthetic-pairing-token"),
      );
  });

  const crypto: ElectronSafeStorage.ElectronSafeStorage["Service"] = {
    isEncryptionAvailable: Effect.succeed(true),
    encryptString: (token) => Effect.succeed(Buffer.from(`encrypted:${token}`)),
    decryptString: (encrypted) =>
      Effect.succeed(Buffer.from(encrypted).toString().slice("encrypted:".length)),
    selectedStorageBackend: Effect.succeedNone,
  };
  const httpClient = HttpClient.make((request) => {
    assert.strictEqual(new URL(request.url).pathname, "/oauth/token");
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({
          access_token: "windows-bearer",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "orchestration:read",
        }),
      ),
    );
  });
  const attachOlderService = (home: string) =>
    Effect.gen(function* () {
      const service = yield* DesktopLocalService.DesktopLocalService;
      yield* service.attach({
        baseDir: NodePath.join(home, ".specweave-studio", "m4"),
        runtime: { pid: 4242, port: 8319, origin: "http://service.test", serviceManaged: true },
        descriptor: {
          ...DESCRIPTOR,
          serverVersion: "0.0.1-older",
        } as DesktopLocalService.AttachedLocalService["descriptor"],
        httpBaseUrl: new URL("http://service.test"),
      });
      return service;
    });

  it.effect("pairs through the CLI-run server's own Node and script", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-win-pair-"));
    const node = NodePath.join(home, "node.exe");
    const script = NodePath.join(home, "My Tools", "bin.mjs");
    NodeFS.writeFileSync(node, "");
    NodeFS.mkdirSync(NodePath.dirname(script), { recursive: true });
    NodeFS.writeFileSync(script, "");
    execFileSyncMock.mockReturnValue(
      JSON.stringify({ executable: node, commandLine: `"${node}" "${script}" serve --port 8319` }),
    );
    return Effect.gen(function* () {
      const service = yield* attachOlderService(home);
      assert.strictEqual(yield* service.bearerToken, "windows-bearer");
      const [command, args, options] = execFileSyncMock.mock.calls[0]!;
      assert.strictEqual(command, "powershell.exe");
      assert.includeMembers(args, ["-NoProfile", "-NonInteractive", "-Command"]);
      assert.include(args.at(-1), "ProcessId=4242");
      assert.include(options, { windowsHide: true });
      const [pairCommand, pairArgs, pairOptions] = execFileMock.mock.calls[0]!;
      assert.strictEqual(pairCommand, node);
      assert.strictEqual(pairArgs[0], script);
      assert.strictEqual(pairArgs[1], "pair");
      assert.include(pairOptions, { windowsHide: true });
    }).pipe(
      Effect.provide(layerFor(home, {}, { httpClient, crypto }, undefined, "win32")),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(home, { recursive: true, force: true }))),
    );
  });

  it.effect("refuses to pair an older service whose command line cannot be read", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-win-pair-"));
    execFileSyncMock.mockImplementation(() => {
      throw new Error("powershell.exe not found");
    });
    return Effect.gen(function* () {
      const service = yield* attachOlderService(home);
      const result = yield* service.bearerToken.pipe(Effect.result);
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result))
        assert.strictEqual(result.failure._tag, "DesktopLocalServicePairingError");
      assert.lengthOf(execFileMock.mock.calls, 0);
    }).pipe(
      Effect.provide(layerFor(home, {}, { httpClient, crypto }, undefined, "win32")),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(home, { recursive: true, force: true }))),
    );
  });
});

describe("DesktopLocalService.ownsBundledService", () => {
  it.effect("is true only for a backend the app started itself", () =>
    withDescriptorServer((origin) => {
      const { home } = makeHomeWithInstalledService(origin);
      return Effect.gen(function* () {
        const service = yield* DesktopLocalService.DesktopLocalService;
        // Before bootstrap decides, nothing is owned.
        assert.isFalse(yield* service.ownsBundledService);
        yield* service.markSpawned;
        assert.isTrue(yield* service.ownsBundledService);
      }).pipe(
        Effect.provide(layerFor(home)),
        Effect.ensuring(Effect.sync(() => NodeFS.rmSync(home, { recursive: true, force: true }))),
      );
    }),
  );

  it.effect("is false while attached to a running service", () =>
    withDescriptorServer((origin) => {
      const { home } = makeHomeWithInstalledService(origin);
      return Effect.gen(function* () {
        const service = yield* DesktopLocalService.DesktopLocalService;
        const discovery = yield* service.discover();
        assert.equal(discovery._tag, "running");
        if (discovery._tag !== "running") return;
        yield* service.attach(discovery.service);
        assert.isFalse(yield* service.ownsBundledService);
        // Even a stray spawn mark does not make an attached service the app's own.
        yield* service.markSpawned;
        assert.isFalse(yield* service.ownsBundledService);
      }).pipe(
        Effect.provide(layerFor(home)),
        Effect.ensuring(Effect.sync(() => NodeFS.rmSync(home, { recursive: true, force: true }))),
      );
    }),
  );
});

describe("DesktopLocalService.discover", () => {
  it.effect("finds the installed service in its own home beside the default one", () =>
    withDescriptorServer((origin) => {
      const { home, studioHome } = makeHomeWithInstalledService(origin);
      return Effect.gen(function* () {
        const service = yield* DesktopLocalService.DesktopLocalService;
        const discovery = yield* service.discover();
        assert.equal(discovery._tag, "running");
        if (discovery._tag !== "running") return;
        assert.equal(discovery.service.baseDir, studioHome);
        assert.equal(discovery.service.httpBaseUrl.origin, origin);
        assert.equal(discovery.service.descriptor.serverVersion, "0.1.4");
        // launchd starts the fleet service without the Node launcher, so its
        // runtime state never says serviceManaged; the receipt does.
        assert.isFalse(discovery.service.runtime.serviceManaged);
        assert.isTrue(discovery.service.installedService);
        assert.isTrue(DesktopLocalService.isInstalledService(discovery.service));
      }).pipe(
        Effect.provide(layerFor(home)),
        Effect.ensuring(Effect.sync(() => NodeFS.rmSync(home, { recursive: true, force: true }))),
      );
    }),
  );

  // The helper has stopped the old service and not yet started the new one.
  // The marker is dated `ageMs` before the test clock's now.
  const stopForInstall = (studioHome: string, ageMs: number, marker: object = {}) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const runtimePath = NodePath.join(studioHome, "userdata", "server-runtime.json");
      const runtime = NodeFS.readFileSync(runtimePath, "utf8");
      const markerPath = NodePath.join(studioHome, "updates", "install-in-progress.json");
      NodeFS.rmSync(runtimePath);
      writeJson(markerPath, {
        version: "1.0.7",
        ...marker,
        at: DateTime.formatIso(DateTime.makeUnsafe(now - ageMs)),
      });
      return {
        restart: () => NodeFS.writeFileSync(runtimePath, runtime),
        clearMarker: () => NodeFS.rmSync(markerPath),
      };
    });

  const advanceSeconds = (seconds: number) =>
    Effect.gen(function* () {
      for (let second = 0; second < seconds; second += 1) yield* TestClock.adjust("1 second");
    });

  it.effect("waits for a service update instead of starting its own server", () =>
    withDescriptorServer((origin) => {
      const { home, studioHome } = makeHomeWithInstalledService(origin);
      return Effect.gen(function* () {
        const install = yield* stopForInstall(studioHome, 0, { receipt: "update-1.0.7.json" });
        const service = yield* DesktopLocalService.DesktopLocalService;
        let notices = 0;
        const discovering = yield* Effect.forkChild(
          service.discover({ onInstallWait: Effect.sync(() => (notices += 1)) }),
        );
        // Well past the six seconds a restarting service normally gets.
        yield* advanceSeconds(60);
        assert.isUndefined(discovering.pollUnsafe());
        // The app shows that it waits, once.
        assert.equal(notices, 1);
        // The new release answers, then the agent clears its marker.
        install.restart();
        yield* TestClock.adjust("1 second");
        const discovery = yield* Fiber.join(discovering);
        assert.equal(discovery._tag, "running");
        assert.equal(notices, 1);
        install.clearMarker();
      }).pipe(
        Effect.provide(layerFor(home)),
        Effect.ensuring(Effect.sync(() => NodeFS.rmSync(home, { recursive: true, force: true }))),
      );
    }),
  );

  it.effect("keeps the full grace after the install ends without a running service", () =>
    withDescriptorServer((origin) => {
      const { home, studioHome } = makeHomeWithInstalledService(origin);
      return Effect.gen(function* () {
        const install = yield* stopForInstall(studioHome, 0);
        const service = yield* DesktopLocalService.DesktopLocalService;
        const discovering = yield* Effect.forkChild(service.discover());
        yield* advanceSeconds(30);
        install.clearMarker();
        yield* advanceSeconds(4);
        assert.isUndefined(discovering.pollUnsafe());
        // launchd brings the new release up within the grace.
        install.restart();
        yield* TestClock.adjust("1 second");
        assert.equal((yield* Fiber.join(discovering))._tag, "running");
      }).pipe(
        Effect.provide(layerFor(home)),
        Effect.ensuring(Effect.sync(() => NodeFS.rmSync(home, { recursive: true, force: true }))),
      );
    }),
  );

  it.effect("starts its own server once an install outlasts the agent's window", () =>
    withDescriptorServer((origin) => {
      const { home, studioHome } = makeHomeWithInstalledService(origin);
      return Effect.gen(function* () {
        yield* stopForInstall(studioHome, 0);
        const service = yield* DesktopLocalService.DesktopLocalService;
        const discovering = yield* Effect.forkChild(service.discover());
        yield* TestClock.adjust("14 minutes");
        assert.isUndefined(discovering.pollUnsafe());
        // 15 minutes of waiting, then the usual six-second grace.
        yield* TestClock.adjust("1 minute");
        yield* advanceSeconds(5);
        assert.isUndefined(discovering.pollUnsafe());
        yield* TestClock.adjust("1 second");
        assert.equal((yield* Fiber.join(discovering))._tag, "none");
      }).pipe(
        Effect.provide(layerFor(home)),
        Effect.ensuring(Effect.sync(() => NodeFS.rmSync(home, { recursive: true, force: true }))),
      );
    }),
  );

  it.effect("falls back when the marker ages out partway through the wait", () =>
    withDescriptorServer((origin) => {
      const { home, studioHome } = makeHomeWithInstalledService(origin);
      return Effect.gen(function* () {
        // Ten seconds of the agent's 15-minute window are left.
        yield* stopForInstall(studioHome, 14 * 60_000 + 50_000);
        const service = yield* DesktopLocalService.DesktopLocalService;
        const discovering = yield* Effect.forkChild(service.discover());
        yield* advanceSeconds(15);
        assert.isUndefined(discovering.pollUnsafe());
        yield* TestClock.adjust("1 second");
        assert.equal((yield* Fiber.join(discovering))._tag, "none");
      }).pipe(
        Effect.provide(layerFor(home)),
        Effect.ensuring(Effect.sync(() => NodeFS.rmSync(home, { recursive: true, force: true }))),
      );
    }),
  );

  it.effect("keeps waiting past the window while the install helper still runs", () =>
    withDescriptorServer((origin) => {
      const { home, studioHome } = makeHomeWithInstalledService(origin);
      const receipt = NodePath.join(studioHome, "updates", "receipts", "update-1.0.7-x.json");
      // The agent gave up waiting at 15 minutes; the helper (a live process) rolls back.
      writeJson(receipt, { phase: "restart-requested", helperPid: process.ppid });
      return Effect.gen(function* () {
        const install = yield* stopForInstall(studioHome, 20 * 60_000, { receipt });
        const service = yield* DesktopLocalService.DesktopLocalService;
        const discovering = yield* Effect.forkChild(service.discover());
        yield* TestClock.adjust("10 minutes");
        assert.isUndefined(discovering.pollUnsafe());
        // The helper put the service back; the next agent pass clears the marker.
        install.restart();
        yield* TestClock.adjust("1 second");
        assert.equal((yield* Fiber.join(discovering))._tag, "running");
      }).pipe(
        Effect.provide(layerFor(home)),
        Effect.ensuring(Effect.sync(() => NodeFS.rmSync(home, { recursive: true, force: true }))),
      );
    }),
  );

  it.effect("stops waiting for a live helper once the marker reaches the hard limit", () =>
    withDescriptorServer((origin) => {
      const { home, studioHome } = makeHomeWithInstalledService(origin);
      const receipt = NodePath.join(studioHome, "updates", "receipts", "update-1.0.7-x.json");
      writeJson(receipt, { helperPid: process.ppid });
      return Effect.gen(function* () {
        // 59 minutes old: one minute of the hour a helper is trusted is left.
        yield* stopForInstall(studioHome, 59 * 60_000, { receipt });
        const service = yield* DesktopLocalService.DesktopLocalService;
        const discovering = yield* Effect.forkChild(service.discover());
        yield* TestClock.adjust("1 minute");
        yield* advanceSeconds(5);
        assert.isUndefined(discovering.pollUnsafe());
        yield* TestClock.adjust("1 second");
        assert.equal((yield* Fiber.join(discovering))._tag, "none");
      }).pipe(
        Effect.provide(layerFor(home)),
        Effect.ensuring(Effect.sync(() => NodeFS.rmSync(home, { recursive: true, force: true }))),
      );
    }),
  );

  it.effect("ignores a marker left by an install that died long ago", () =>
    withDescriptorServer((origin) => {
      const { home, studioHome } = makeHomeWithInstalledService(origin);
      return Effect.gen(function* () {
        yield* stopForInstall(studioHome, 16 * 60_000);
        const service = yield* DesktopLocalService.DesktopLocalService;
        let notices = 0;
        const discovering = yield* Effect.forkChild(
          service.discover({ onInstallWait: Effect.sync(() => (notices += 1)) }),
        );
        yield* advanceSeconds(6);
        assert.equal((yield* Fiber.join(discovering))._tag, "none");
        assert.equal(notices, 0);
      }).pipe(
        Effect.provide(layerFor(home)),
        Effect.ensuring(Effect.sync(() => NodeFS.rmSync(home, { recursive: true, force: true }))),
      );
    }),
  );

  it.effect("gives a stopped service only the usual grace when no update is installing", () =>
    withDescriptorServer((origin) => {
      const { home, studioHome } = makeHomeWithInstalledService(origin);
      NodeFS.rmSync(NodePath.join(studioHome, "userdata", "server-runtime.json"));
      return Effect.gen(function* () {
        const service = yield* DesktopLocalService.DesktopLocalService;
        const discovering = yield* Effect.forkChild(service.discover());
        yield* advanceSeconds(5);
        assert.isUndefined(discovering.pollUnsafe());
        yield* TestClock.adjust("1 second");
        assert.equal((yield* Fiber.join(discovering))._tag, "none");
      }).pipe(
        Effect.provide(layerFor(home)),
        Effect.ensuring(Effect.sync(() => NodeFS.rmSync(home, { recursive: true, force: true }))),
      );
    }),
  );

  // 1.0.89 on M4: the updated service took two minutes to answer, the app gave up
  // after six seconds and opened its own empty home, so every project vanished.
  it.effect("waits for an installed service launchd is still starting, not an empty home", () =>
    withDescriptorServer((origin) => {
      const { home, studioHome } = makeHomeWithInstalledService(origin);
      const runtimePath = NodePath.join(studioHome, "userdata", "server-runtime.json");
      const runtime = NodeFS.readFileSync(runtimePath, "utf8");
      NodeFS.rmSync(runtimePath);
      const asked: Array<string> = [];
      return Effect.gen(function* () {
        const service = yield* DesktopLocalService.DesktopLocalService;
        let notices = 0;
        const discovering = yield* Effect.forkChild(
          service.discover({ onServiceStartWait: Effect.sync(() => (notices += 1)) }),
        );
        yield* TestClock.adjust("10 minutes");
        assert.isUndefined(discovering.pollUnsafe());
        assert.equal(notices, 1);
        assert.equal(asked[0], "gui/501/com.specweave.studio.m4");
        // The service finishes opening its store and writes its runtime state.
        NodeFS.writeFileSync(runtimePath, runtime);
        yield* TestClock.adjust("1 second");
        const discovery = yield* Fiber.join(discovering);
        assert.equal(discovery._tag, "running");
        if (discovery._tag !== "running") return;
        assert.equal(discovery.service.baseDir, studioHome);
        assert.equal(notices, 1);
      }).pipe(
        Effect.provide(
          layerFor(home, {}, undefined, undefined, "darwin", (target) =>
            Effect.sync(() => {
              asked.push(target);
              return "running" as const;
            }),
          ),
        ),
        Effect.ensuring(Effect.sync(() => NodeFS.rmSync(home, { recursive: true, force: true }))),
      );
    }),
  );

  it.effect("reports a service that never starts instead of opening an empty home", () =>
    withDescriptorServer((origin) => {
      const { home, studioHome } = makeHomeWithInstalledService(origin);
      NodeFS.rmSync(NodePath.join(studioHome, "userdata", "server-runtime.json"));
      return Effect.gen(function* () {
        const service = yield* DesktopLocalService.DesktopLocalService;
        const discovering = yield* Effect.forkChild(service.discover());
        yield* TestClock.adjust(`${DesktopLocalService.SERVICE_START_WAIT_LIMIT_MINUTES} minutes`);
        // The usual grace still follows the wait.
        yield* advanceSeconds(5);
        assert.isUndefined(discovering.pollUnsafe());
        yield* TestClock.adjust("1 second");
        const discovery = yield* Fiber.join(discovering);
        assert.equal(discovery._tag, "service-not-started");
        if (discovery._tag !== "service-not-started") return;
        assert.equal(discovery.stateDir, NodePath.join(studioHome, "userdata"));
      }).pipe(
        Effect.provide(
          layerFor(home, {}, undefined, undefined, "darwin", () => Effect.succeed("running")),
        ),
        Effect.ensuring(Effect.sync(() => NodeFS.rmSync(home, { recursive: true, force: true }))),
      );
    }),
  );

  // A stopped service with the job state launchd reports, on a given platform,
  // falls back to the app's own home after the usual six seconds.
  const fallsBackAfterGrace = (
    platform: NodeJS.Platform,
    readLaunchdJob: DesktopLocalService.LaunchdJobStateReader,
  ) =>
    withDescriptorServer((origin) => {
      const { home, studioHome } = makeHomeWithInstalledService(origin);
      NodeFS.rmSync(NodePath.join(studioHome, "userdata", "server-runtime.json"));
      return Effect.gen(function* () {
        const service = yield* DesktopLocalService.DesktopLocalService;
        const discovering = yield* Effect.forkChild(service.discover());
        yield* advanceSeconds(5);
        assert.isUndefined(discovering.pollUnsafe());
        yield* TestClock.adjust("1 second");
        assert.equal((yield* Fiber.join(discovering))._tag, "none");
      }).pipe(
        Effect.provide(layerFor(home, {}, undefined, undefined, platform, readLaunchdJob)),
        Effect.ensuring(Effect.sync(() => NodeFS.rmSync(home, { recursive: true, force: true }))),
      );
    });

  it.effect("keeps the usual grace when launchd cannot say whether the service runs", () =>
    fallsBackAfterGrace("darwin", () => Effect.succeed("unknown")),
  );

  it.effect("keeps the usual grace for a crash-looping job launchd has not restarted", () =>
    fallsBackAfterGrace("darwin", () => Effect.succeed("stopped")),
  );

  it.effect("never asks launchd off macOS", () =>
    fallsBackAfterGrace("linux", () => Effect.die("launchctl is macOS only")),
  );

  it.effect("stops waiting once launchd no longer runs the service", () =>
    withDescriptorServer((origin) => {
      const { home, studioHome } = makeHomeWithInstalledService(origin);
      NodeFS.rmSync(NodePath.join(studioHome, "userdata", "server-runtime.json"));
      let state: DesktopLocalService.LaunchdJobState = "running";
      return Effect.gen(function* () {
        const service = yield* DesktopLocalService.DesktopLocalService;
        const discovering = yield* Effect.forkChild(service.discover());
        yield* TestClock.adjust("3 minutes");
        assert.isUndefined(discovering.pollUnsafe());
        // The service was unloaded: its home no longer answers for anyone.
        state = "absent";
        yield* advanceSeconds(7);
        assert.equal((yield* Fiber.join(discovering))._tag, "none");
      }).pipe(
        Effect.provide(
          layerFor(home, {}, undefined, undefined, "darwin", () => Effect.sync(() => state)),
        ),
        Effect.ensuring(Effect.sync(() => NodeFS.rmSync(home, { recursive: true, force: true }))),
      );
    }),
  );

  it.effect("starts the start wait only once an update install ends", () =>
    withDescriptorServer((origin) => {
      const { home, studioHome } = makeHomeWithInstalledService(origin);
      return Effect.gen(function* () {
        const install = yield* stopForInstall(studioHome, 0);
        const service = yield* DesktopLocalService.DesktopLocalService;
        const discovering = yield* Effect.forkChild(service.discover());
        // A 12-minute install, then the new release rebuilds its store for 15 minutes:
        // past 20 minutes in all, but within the start wait counted from the install's end.
        yield* TestClock.adjust("12 minutes");
        install.clearMarker();
        yield* TestClock.adjust("15 minutes");
        assert.isUndefined(discovering.pollUnsafe());
        install.restart();
        yield* TestClock.adjust("1 second");
        assert.equal((yield* Fiber.join(discovering))._tag, "running");
      }).pipe(
        Effect.provide(
          layerFor(home, {}, undefined, undefined, "darwin", () => Effect.succeed("running")),
        ),
        Effect.ensuring(Effect.sync(() => NodeFS.rmSync(home, { recursive: true, force: true }))),
      );
    }),
  );

  it.effect("attaches at once to a service that still answers while its update runs", () =>
    withDescriptorServer((origin) => {
      const { home, studioHome } = makeHomeWithInstalledService(origin);
      return Effect.gen(function* () {
        writeJson(NodePath.join(studioHome, "updates", "install-in-progress.json"), {
          at: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
        });
        const service = yield* DesktopLocalService.DesktopLocalService;
        const discovery = yield* service.discover();
        assert.equal(discovery._tag, "running");
      }).pipe(
        Effect.provide(layerFor(home)),
        Effect.ensuring(Effect.sync(() => NodeFS.rmSync(home, { recursive: true, force: true }))),
      );
    }),
  );

  // The own home's server runs and holds the store but never answers, as a
  // service stalled on a full disk does.
  const withUnresponsiveOwnHome = <A, E, R>(
    use: (input: {
      readonly home: string;
      readonly env: Record<string, string>;
    }) => Effect.Effect<A, E, R>,
  ) =>
    Effect.acquireUseRelease(
      Effect.promise(
        () =>
          new Promise<NodeHttp.Server>((resolve) => {
            const server = NodeHttp.createServer((_request, response) => {
              response.statusCode = 503;
              response.end();
            });
            server.listen(0, "127.0.0.1", () => resolve(server));
          }),
      ),
      (server) => {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-local-service-"));
        const studioHome = NodePath.join(home, "own");
        writeJson(NodePath.join(studioHome, "userdata", "server-runtime.json"), {
          version: 1,
          pid: process.ppid,
          port,
          origin: `http://127.0.0.1:${port}`,
          startedAt: "2026-10-18T18:00:00.000Z",
        });
        return use({ home, env: { STUDIO_HOME: studioHome } }).pipe(
          Effect.ensuring(Effect.sync(() => NodeFS.rmSync(home, { recursive: true, force: true }))),
        );
      },
      (server) =>
        Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
    );

  const discoverUnresponsive = (home: string, env: Record<string, string>, freeBytes: number) => {
    const readPaths: Array<string> = [];
    return Effect.gen(function* () {
      const service = yield* DesktopLocalService.DesktopLocalService;
      const discovering = yield* Effect.forkChild(service.discover());
      // Each probe is a real request, so let it land before the grace sleep
      // it is followed by can be advanced.
      for (let second = 0; second < 6; second += 1) {
        yield* TestClock.withLive(Effect.sleep("100 millis"));
        yield* TestClock.adjust("1 second");
      }
      return { discovery: yield* Fiber.join(discovering), readPaths };
    }).pipe(
      Effect.provide(
        layerFor(home, env, undefined, (path) =>
          Effect.sync(() => {
            readPaths.push(path);
            return Option.some(freeBytes);
          }),
        ),
      ),
    );
  };

  it.effect("names a nearly full disk when its own service does not answer", () =>
    withUnresponsiveOwnHome(({ home, env }) =>
      Effect.gen(function* () {
        const { discovery, readPaths } = yield* discoverUnresponsive(home, env, 412_000_000);
        assert.equal(discovery._tag, "unresponsive");
        if (discovery._tag !== "unresponsive") return;
        assert.equal(discovery.lowDiskFreeBytes, 412_000_000);
        // The disk the stalled service writes to, not the home folder's.
        assert.deepEqual(readPaths, [discovery.stateDir]);
        assert.equal(discovery.stateDir, NodePath.join(env.STUDIO_HOME!, "userdata"));
      }),
    ),
  );

  it.effect("leaves disk space out when the disk has room", () =>
    withUnresponsiveOwnHome(({ home, env }) =>
      Effect.gen(function* () {
        const { discovery } = yield* discoverUnresponsive(home, env, 40_000_000_000);
        assert.equal(discovery._tag, "unresponsive");
        if (discovery._tag !== "unresponsive") return;
        assert.isUndefined(discovery.lowDiskFreeBytes);
      }),
    ),
  );

  it.effect("keeps an explicit STUDIO_HOME to itself", () =>
    withDescriptorServer((origin) => {
      const { home } = makeHomeWithInstalledService(origin);
      const own = NodePath.join(home, "elsewhere");
      return Effect.gen(function* () {
        const service = yield* DesktopLocalService.DesktopLocalService;
        assert.equal((yield* service.discover())._tag, "none");
      }).pipe(
        Effect.provide(layerFor(home, { STUDIO_HOME: own })),
        Effect.ensuring(Effect.sync(() => NodeFS.rmSync(home, { recursive: true, force: true }))),
      );
    }),
  );
});

describe("parseLaunchdJobState", () => {
  it("tells a running service from a loaded job between restarts", () => {
    const print = (state: string) =>
      `gui/501/com.specweave.studio.m4 = {\n\tactive count = 1\n\ttype = LaunchAgent\n\tstate = ${state}\n\n\tprogram = /usr/bin/caffeinate\n}\n`;
    assert.equal(DesktopLocalService.parseLaunchdJobState(print("running")), "running");
    assert.equal(DesktopLocalService.parseLaunchdJobState(print("not running")), "stopped");
    assert.equal(DesktopLocalService.parseLaunchdJobState("garbage"), "unknown");
  });
});
