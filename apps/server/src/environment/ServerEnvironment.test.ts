import * as NodeServices from "@effect/platform-node/NodeServices";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@specweave-studio/contracts";
import { expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import { DEFAULT_SIGNAL_EXPORT } from "@specweave-studio/shared/observability";
import {
  HostProcessArguments,
  HostProcessEnvironment,
  HostProcessIsExecutable,
  HostProcessPlatform,
} from "@specweave-studio/shared/hostProcess";
import * as OtelEnvironment from "@specweave-studio/shared/otelEnvironment";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_URL_SECRET,
} from "../cloud/config.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "./ServerEnvironment.ts";

const isServerEnvironmentIdPersistenceError = Schema.is(
  ServerEnvironment.ServerEnvironmentIdPersistenceError,
);

const layerServerEnvironment = (baseDir: string) =>
  ServerEnvironment.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
  );

const layerEmptySecretStore = Layer.succeed(
  ServerSecretStore.ServerSecretStore,
  ServerSecretStore.ServerSecretStore.of({
    get: () => Effect.succeedNone,
    set: () => Effect.void,
    create: () => Effect.void,
    getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
    remove: () => Effect.void,
  }),
);

const makeServerConfig = Effect.fn(function* (baseDir: string) {
  const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);

  return {
    ...derivedPaths,
    logLevel: "Error",
    traceMinLevel: "Info",
    traceTimingEnabled: true,
    traceBatchWindowMs: 200,
    traceMaxBytes: 10 * 1024 * 1024,
    traceMaxFiles: 10,
    otlpTracesUrl: undefined,
    otlpMetricsUrl: undefined,
    otlpLogsUrl: undefined,
    otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
    otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
    otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
    otelEnvironment: OtelEnvironment.none,
    cwd: process.cwd(),
    baseDir,
    mode: "web",
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
    port: 0,
    host: undefined,
    desktopBootstrapToken: undefined,
    staticDir: undefined,
    devUrl: undefined,
    devAllowedOrigins: [],
    noBrowser: false,
    startupPresentation: "browser",
  } satisfies ServerConfig.ServerConfig["Service"];
});

it.layer(NodeServices.layer)("ServerEnvironmentLive", (it) => {
  it.effect("publishes proven install ownership only for manually updated servers", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      // Ownership is proven against the resolved entry, so the published
      // prefix is the real one. macOS hands out temp directories under the
      // `/var` link to `/private/var`.
      const path = yield* Path.Path;
      const baseDir = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      // npm lays a global install out as <prefix>/lib/node_modules plus a bin
      // symlink on POSIX, and <prefix>\node_modules plus a .cmd shim on Windows.
      const windows = process.platform === "win32";
      const prefix = path.join(baseDir, "node");
      const packageRoot = windows
        ? path.join(prefix, "node_modules", "specweave-studio")
        : path.join(prefix, "lib", "node_modules", "specweave-studio");
      const entry = path.join(packageRoot, "dist", "bin.mjs");
      yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
      yield* fs.writeFileString(entry, "");
      yield* fs.writeFileString(
        path.join(packageRoot, "package.json"),
        '{"name":"specweave-studio","version":"0.0.45","bin":{"specweave-studio":"./dist/bin.mjs"}}',
      );
      if (windows) {
        yield* fs.writeFileString(
          path.join(prefix, "specweave-studio.cmd"),
          '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\specweave-studio\\dist\\bin.mjs" %*\r\n',
        );
      } else {
        yield* fs.makeDirectory(path.join(prefix, "bin"), { recursive: true });
        yield* fs.symlink(entry, path.join(prefix, "bin", "specweave-studio"));
      }
      const config = yield* makeServerConfig(baseDir);
      yield* fs.makeDirectory(config.stateDir, { recursive: true });
      for (const mode of ["web", "desktop"] as const) {
        const descriptor = yield* Effect.gen(function* () {
          const environment = yield* ServerEnvironment.ServerEnvironment;
          return yield* environment.getDescriptor;
        }).pipe(
          Effect.provide(
            ServerEnvironment.layer.pipe(
              Layer.provide(layerEmptySecretStore),
              Layer.provide(ServerConfig.layer({ ...config, mode })),
            ),
          ),
          Effect.provideService(HostProcessArguments, ["node", entry]),
          Effect.provideService(HostProcessIsExecutable, false),
          Effect.provideService(HostProcessPlatform, windows ? "win32" : "linux"),
          Effect.provideService(HostProcessEnvironment, {}),
        );
        expect(descriptor.capabilities.serverInstallation).toEqual(
          mode === "web" ? { kind: "npm-global", prefix } : undefined,
        );
        expect(descriptor.capabilities.serverSelfUpdate).toBe(
          mode === "web" ? undefined : "desktop-managed",
        );
      }
    }),
  );
  it.effect.each([
    { name: "missing", content: undefined },
    { name: "empty", content: "" },
    { name: "whitespace-only", content: " \t\n" },
  ])("concurrent initializers recover a $name environment id file", ({ content }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const crypto = yield* Crypto.Crypto;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "studio-server-environment-concurrent-test-",
      });
      const serverConfig = yield* makeServerConfig(baseDir);
      yield* fileSystem.makeDirectory(serverConfig.stateDir, { recursive: true });
      if (content !== undefined) {
        yield* fileSystem.writeFileString(serverConfig.environmentIdPath, content);
      }
      const bothGenerated = yield* Deferred.make<void>();
      const bothReadEmpty = yield* Deferred.make<void>();
      const firstInitialized = yield* Deferred.make<void>();
      let remaining = 2;
      let emptyReads = 0;
      const readIdentity = Effect.gen(function* () {
        const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
        return yield* identity.getEnvironmentId;
      }).pipe(
        Effect.tap(() => Deferred.succeed(firstInitialized, undefined)),
        Effect.provide(Layer.fresh(ServerEnvironment.layerIdentity)),
        Effect.provideService(ServerConfig.ServerConfig, serverConfig),
        Effect.provideService(FileSystem.FileSystem, {
          ...fileSystem,
          readFileString: (path) =>
            fileSystem.readFileString(path).pipe(
              Effect.tap(
                Effect.fn(function* (value) {
                  if (path !== serverConfig.environmentIdPath || remaining > 0 || value.trim()) {
                    return;
                  }
                  // Both observe the empty file, but one repairs it after the other has finished.
                  if (++emptyReads === 2) {
                    yield* Deferred.succeed(bothReadEmpty, undefined);
                    yield* Deferred.await(firstInitialized);
                  } else {
                    yield* Deferred.await(bothReadEmpty);
                  }
                }),
              ),
            ),
        }),
        Effect.provideService(Crypto.Crypto, {
          ...crypto,
          randomUUIDv4: Effect.gen(function* () {
            const id = yield* crypto.randomUUIDv4;
            if (--remaining === 0) {
              yield* Deferred.succeed(bothGenerated, undefined);
            }
            yield* Deferred.await(bothGenerated);
            return id;
          }),
        }),
      );

      const [first, second] = yield* Effect.all([readIdentity, readIdentity], {
        concurrency: "unbounded",
      });
      const persisted = yield* fileSystem.readFileString(serverConfig.environmentIdPath);

      expect(first).toBe(second);
      expect(persisted.trim()).toBe(first);
    }),
  );

  it.effect("persists the environment id across service restarts", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "studio-server-environment-test-",
      });

      const first = yield* Effect.gen(function* () {
        const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
        return yield* serverEnvironment.getDescriptor;
      }).pipe(Effect.provide(layerServerEnvironment(baseDir)));
      const second = yield* Effect.gen(function* () {
        const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
        return yield* serverEnvironment.getDescriptor;
      }).pipe(Effect.provide(layerServerEnvironment(baseDir)));

      expect(first.environmentId).toBe(second.environmentId);
      expect(first.orchestrationProtocolVersion).toBe(ORCHESTRATION_PROTOCOL_VERSION);
      expect(second.capabilities.repositoryIdentity).toBe(true);
      expect(second.capabilities.connectionProbe).toBe(true);
      expect(second.capabilities.attachmentUploads).toBe(true);
      expect(second.capabilities.fileAttachments).toEqual({ maxUploadBytes: 50 * 1024 * 1024 });
      expect(second.capabilities.pullRequests).toBe(true);
      expect(second.capabilities.requiredWorktreeBootstrap).toBe(true);
      expect(second.capabilities.usagePriceOverrides).toBe(true);
      expect(second.capabilities.threadActiveReorder).toBe(true);
      expect(second.capabilities.gitHubSignIn).toBe(true);
      expect(second.capabilities.gitHubCredentialCopy).toBe(true);
      expect(second.capabilities.studioFleetRemove).toBe(true);
      expect(second.capabilities.threadTitleRegeneration).toBe(true);
      expect(second.capabilities.threadPullRequests).toBe(true);
      expect(second.capabilities.threadPullRequestLinking).toBe(true);
      expect(second.capabilities.serverResolvedCommandContext).toBe(true);
      expect(second.capabilities.agentActivityPublishing).toBe(false);
    }),
  );

  it.effect("reports agent activity publishing from the current secret state", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "studio-server-environment-publish-test-",
      });
      const layerTest = Layer.mergeAll(
        ServerEnvironment.layer.pipe(Layer.provide(ServerSecretStore.layer)),
        ServerSecretStore.layer,
      ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)));

      yield* Effect.gen(function* () {
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
        const encode = (value: string) => new TextEncoder().encode(value);
        // The capability is cached for a few seconds so the environment probe
        // never waits on disk; each flip is observed once that window passes.
        const afterCacheWindow = TestClock.adjust(
          `${ServerEnvironment.AGENT_ACTIVITY_PUBLISHING_CACHE_TTL_MS} millis`,
        );

        const unlinked = yield* serverEnvironment.getDescriptor;
        expect(unlinked.capabilities.agentActivityPublishing).toBe(false);

        // The opt-in alone is not enough: without relay link credentials no
        // publish would leave this environment.
        yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, encode("true"));
        yield* afterCacheWindow;
        const withoutLink = yield* serverEnvironment.getDescriptor;
        expect(withoutLink.capabilities.agentActivityPublishing).toBe(false);

        // Empty credentials are as unconfigured as missing ones: the
        // publisher's truthiness gate skips them, so the capability must not
        // advertise publishing.
        yield* secrets.set(RELAY_URL_SECRET, encode(""));
        yield* secrets.set(RELAY_ENVIRONMENT_CREDENTIAL_SECRET, encode("credential"));
        yield* afterCacheWindow;
        const emptyUrl = yield* serverEnvironment.getDescriptor;
        expect(emptyUrl.capabilities.agentActivityPublishing).toBe(false);

        yield* secrets.set(RELAY_URL_SECRET, encode("https://relay.example"));
        yield* afterCacheWindow;
        const linked = yield* serverEnvironment.getDescriptor;
        expect(linked.capabilities.agentActivityPublishing).toBe(true);

        // The toggle changes at runtime, so the same service instance must
        // reflect a flip without a restart.
        yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, encode("false"));
        yield* afterCacheWindow;
        const disabled = yield* serverEnvironment.getDescriptor;
        expect(disabled.capabilities.agentActivityPublishing).toBe(false);
      }).pipe(Effect.provide(layerTest));
    }),
  );

  it.effect("answers descriptor requests from memory while the secret store is slow", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "studio-server-environment-publish-cache-test-",
      });
      const serverConfig = yield* makeServerConfig(baseDir);
      yield* fileSystem.makeDirectory(serverConfig.stateDir, { recursive: true });
      const values = new Map<string, string>([
        [PUBLISH_AGENT_ACTIVITY_SECRET, "true"],
        [RELAY_URL_SECRET, "https://relay.example"],
        [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "credential"],
      ]);
      let reads = 0;
      let stall: Deferred.Deferred<void> | undefined;
      const layerCountingSecretStore = Layer.succeed(
        ServerSecretStore.ServerSecretStore,
        ServerSecretStore.ServerSecretStore.of({
          get: (name) =>
            Effect.gen(function* () {
              reads += 1;
              if (stall !== undefined) yield* Deferred.await(stall);
              const value = values.get(name);
              return value === undefined
                ? Option.none()
                : Option.some(new TextEncoder().encode(value));
            }),
          set: () => Effect.void,
          create: () => Effect.void,
          getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
          remove: () => Effect.void,
        }),
      );

      yield* Effect.gen(function* () {
        const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
        // Startup reads the three secrets once.
        expect(reads).toBe(3);
        for (let index = 0; index < 5; index += 1) {
          const descriptor = yield* serverEnvironment.getDescriptor;
          expect(descriptor.capabilities.agentActivityPublishing).toBe(true);
        }
        expect(reads).toBe(3);

        // Once the window passes, a stalled store does not hold the request:
        // it answers from the last value after a short wait, and the shared
        // refresh lands when the store responds.
        values.set(PUBLISH_AGENT_ACTIVITY_SECRET, "false");
        stall = yield* Deferred.make<void>();
        yield* TestClock.adjust(
          `${ServerEnvironment.AGENT_ACTIVITY_PUBLISHING_CACHE_TTL_MS} millis`,
        );
        const pending = yield* serverEnvironment.getDescriptor.pipe(Effect.forkChild);
        yield* TestClock.adjust("250 millis");
        const stale = yield* Fiber.join(pending);
        expect(stale.capabilities.agentActivityPublishing).toBe(true);
        // A second request during the same refresh shares it instead of reading again.
        const second = yield* serverEnvironment.getDescriptor.pipe(Effect.forkChild);
        yield* TestClock.adjust("250 millis");
        expect((yield* Fiber.join(second)).capabilities.agentActivityPublishing).toBe(true);
        expect(reads).toBe(6);

        yield* Deferred.succeed(stall, undefined);
        stall = undefined;
        // The next request joins the same in-flight refresh and sees its result.
        const refreshed = yield* serverEnvironment.getDescriptor;
        expect(refreshed.capabilities.agentActivityPublishing).toBe(false);
        expect(reads).toBe(6);
      }).pipe(
        Effect.provide(
          ServerEnvironment.layer.pipe(
            Layer.provide(layerCountingSecretStore),
            Layer.provide(ServerConfig.layer(serverConfig)),
          ),
        ),
      );
    }),
  );

  it.effect("advertises desktopAppUpdate only with desktop mode and the control fd", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "studio-server-environment-desktop-update-test-",
      });
      const serverConfig = yield* makeServerConfig(baseDir);
      yield* fileSystem.makeDirectory(serverConfig.stateDir, { recursive: true });

      const describeWith = (overrides: Partial<ServerConfig.ServerConfig["Service"]>) =>
        Effect.gen(function* () {
          const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
          return yield* serverEnvironment.getDescriptor;
        }).pipe(
          Effect.provide(
            ServerEnvironment.layer.pipe(
              Layer.provide(ServerSecretStore.layer),
              Layer.provide(ServerConfig.layer({ ...serverConfig, ...overrides })),
            ),
          ),
        );

      const withFd = yield* describeWith({ mode: "desktop", desktopTelemetryControlFd: 5 });
      expect(withFd.capabilities.serverSelfUpdate).toBe("desktop-managed");
      expect(withFd.capabilities.desktopAppUpdate).toBe(true);
      expect(withFd.capabilities.serverSelfUpdateProgress).toBe(true);
      // v2 recovery terminalizes running runs on restart, so continuation
      // stays unadvertised until the v2 runtime carries the markers.
      expect(withFd.capabilities.serverUpdateThreadContinuation).toBeUndefined();

      const withoutFd = yield* describeWith({ mode: "desktop" });
      expect(withoutFd.capabilities.serverSelfUpdate).toBe("desktop-managed");
      expect(withoutFd.capabilities.desktopAppUpdate).toBeUndefined();
      expect(withoutFd.capabilities.serverSelfUpdateProgress).toBeUndefined();
      expect(withoutFd.capabilities.serverUpdateThreadContinuation).toBeUndefined();

      const web = yield* describeWith({ mode: "web", desktopTelemetryControlFd: 5 });
      expect(web.capabilities.desktopAppUpdate).toBeUndefined();
    }),
  );

  it.effect("structures persisted environment id filesystem failures", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "studio-server-environment-error-test-",
      });
      const serverConfig = yield* makeServerConfig(baseDir);
      const environmentIdPath = serverConfig.environmentIdPath;
      const tempPath = `${environmentIdPath}.tmp`;
      const methodByOperation = {
        check: "exists",
        read: "readFileString",
        write: "writeFileString",
      } as const;

      for (const operation of ["check", "read", "write"] as const) {
        const writeAttempts: string[] = [];
        const cause = PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: methodByOperation[operation],
          description: "permission denied",
          pathOrDescriptor: environmentIdPath,
        });
        const layerFailingFileSystem = FileSystem.layerNoop({
          exists: () =>
            operation === "check" ? Effect.fail(cause) : Effect.succeed(operation === "read"),
          readFileString: () => Effect.fail(cause),
          makeTempFileScoped: () => Effect.succeed(tempPath),
          writeFileString: (path) => {
            writeAttempts.push(path);
            return Effect.fail(cause);
          },
        });

        const error = yield* Effect.gen(function* () {
          const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
          return yield* serverEnvironment.getDescriptor;
        }).pipe(
          Effect.provide(
            ServerEnvironment.layer.pipe(
              Layer.provide(layerEmptySecretStore),
              Layer.provide(Layer.merge(ServerConfig.layer(serverConfig), layerFailingFileSystem)),
            ),
          ),
          Effect.flip,
        );

        expect(isServerEnvironmentIdPersistenceError(error)).toBe(true);
        if (!isServerEnvironmentIdPersistenceError(error)) {
          throw error;
        }
        expect(error.operation).toBe(operation);
        expect(error.environmentIdPath).toBe(environmentIdPath);
        expect(error.cause).toBe(cause);
        expect(error.message).toBe(
          `Server environment ID ${operation} failed at '${environmentIdPath}'.`,
        );
        expect(writeAttempts).toEqual(operation === "write" ? [tempPath] : []);
      }
    }),
  );
});
