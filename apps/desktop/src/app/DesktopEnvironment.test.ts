import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopConfig from "./DesktopConfig.ts";

const defaultInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "0.0.22",
  appPath: "/Applications/SpecWeave Studio.app/Contents/Resources/app.asar",
  isPackaged: false,
  resourcesPath: "/Applications/SpecWeave Studio.app/Contents/Resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const layerEnvironment = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) =>
  DesktopEnvironment.layer({
    ...defaultInput,
    ...overrides,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, NodePath.layerPosix, DesktopConfig.layerTest(env)),
    ),
  );

const makeEnvironment = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) => DesktopEnvironment.DesktopEnvironment.pipe(Effect.provide(layerEnvironment(overrides, env)));

describe("DesktopEnvironment", () => {
  it("names the Electron app after the product on macOS and keeps the old name elsewhere", () => {
    const name = (platform: NodeJS.Platform, appVersion: string, isDevelopment = false) =>
      DesktopEnvironment.resolveDesktopElectronAppName({ platform, appVersion, isDevelopment });
    assert.equal(name("darwin", "1.0.0"), "SpecWithCode");
    assert.equal(name("darwin", "1.0.0", true), "SpecWithCode (Dev)");
    assert.equal(name("darwin", "1.0.1-nightly.20261012.1"), "SpecWithCode (Nightly)");
    assert.equal(name("linux", "1.0.0"), "SpecWeave Studio (Alpha)");
    assert.equal(name("win32", "1.0.0"), "SpecWeave Studio (Alpha)");
  });

  it.effect("derives state paths and development identity inside Effect", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {},
        {
          STUDIO_HOME: " /tmp/studio ",
          STUDIO_COMMIT_HASH: " 0123456789abcdef ",
          STUDIO_PORT: "4949",
          VITE_DEV_SERVER_URL: "http://localhost:5173",
          STUDIO_DEV_REMOTE_STUDIO_SERVER_ENTRY_PATH: " /remote/server.mjs ",
          STUDIO_OTLP_TRACES_URL: " http://127.0.0.1:4318/v1/traces ",
          STUDIO_OTLP_METRICS_URL: " http://127.0.0.1:4318/v1/metrics ",
          STUDIO_OTLP_LOGS_URL: " http://127.0.0.1:4318/v1/logs ",
          STUDIO_OTLP_EXPORT_INTERVAL_MS: "2500",
          STUDIO_OTLP_HEADERS: "authorization=Basic%20abc%3D%3D,x-tenant=specweave-studio",
          STUDIO_OTLP_PROTOCOL: "http/protobuf",
        },
      );

      assert.equal(environment.isDevelopment, true);
      assert.equal(environment.appDataDirectory, "/Users/alice/Library/Application Support");
      assert.equal(environment.baseDir, "/tmp/studio");
      assert.equal(environment.stateDir, "/tmp/studio/userdata");
      assert.equal(environment.desktopSettingsPath, "/tmp/studio/userdata/desktop-settings.json");
      assert.equal(environment.clientSettingsPath, "/tmp/studio/userdata/client-settings.json");
      assert.equal(
        environment.savedEnvironmentRegistryPath,
        "/tmp/studio/userdata/saved-environments.json",
      );
      assert.equal(environment.serverSettingsPath, "/tmp/studio/userdata/settings.json");
      assert.equal(environment.logDir, "/tmp/studio/userdata/logs");
      assert.equal(environment.browserArtifactsDir, "/tmp/studio/userdata/browser-artifacts");
      assert.equal(environment.rootDir, "/repo");
      assert.equal(environment.appRoot, "/repo");
      assert.equal(environment.serverRoot, "/repo");
      assert.equal(environment.backendEntryPath, "/repo/apps/server/dist/bin.mjs");
      assert.equal(environment.backendCwd, "/repo");
      assert.equal(environment.appUserModelId, "com.specweave.studio.dev");
      assert.equal(environment.linuxWmClass, "specweave-studio-dev");
      assert.equal(
        environment.linuxDesktopEntryName,
        "com.specweave.SpecWeaveStudio.Development.desktop",
      );
      assert.deepEqual(
        Option.map(environment.devServerUrl, (url) => url.href),
        Option.some("http://localhost:5173/"),
      );
      assert.deepEqual(
        environment.devRemoteStudioServerEntryPath,
        Option.some("/remote/server.mjs"),
      );
      assert.deepEqual(environment.configuredBackendPort, Option.some(4949));
      assert.deepEqual(environment.commitHashOverride, Option.some("0123456789abcdef"));
      assert.deepEqual(environment.otlpTracesUrl, Option.some("http://127.0.0.1:4318/v1/traces"));
      assert.deepEqual(environment.otlpMetricsUrl, Option.some("http://127.0.0.1:4318/v1/metrics"));
      assert.deepEqual(environment.otlpLogsUrl, Option.some("http://127.0.0.1:4318/v1/logs"));
      assert.equal(environment.otlpExportIntervalMs, 2500);
      assert.deepEqual(
        environment.otlpHeaders,
        Option.some({
          authorization: "Basic abc==",
          "x-tenant": "specweave-studio",
        }),
      );
      assert.equal(environment.otlpProtocol, "http/protobuf");
    }),
  );

  it.effect("stores production state under userdata in an explicit home", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {},
        {
          STUDIO_HOME: "/tmp/studio",
        },
      );

      assert.equal(environment.isDevelopment, false);
      assert.equal(environment.stateDir, "/tmp/studio/userdata");
      assert.equal(environment.logDir, "/tmp/studio/userdata/logs");
      assert.equal(environment.browserArtifactsDir, "/tmp/studio/userdata/browser-artifacts");
      assert.equal(environment.serverSettingsPath, "/tmp/studio/userdata/settings.json");
      assert.equal(environment.otlpProtocol, "http/json");
    }),
  );

  it.effect("uses the packaged Windows server sidecar as the backend root", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment({
        platform: "win32",
        isPackaged: true,
        appPath: "/install/resources/app.asar",
        resourcesPath: "/install/resources",
      });

      assert.equal(environment.appRoot, "/install/resources/app.asar");
      assert.equal(environment.serverRoot, "/install/resources/server.asar");
      assert.equal(
        environment.backendEntryPath,
        "/install/resources/server.asar/apps/server/dist/bin.mjs",
      );
      assert.equal(
        environment.clientAssetsDir,
        "/install/resources/server.asar/apps/server/dist/client",
      );
    }),
  );

  it.effect("uses the stable desktop entry as the packaged Linux portal identity", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment({
        platform: "linux",
        isPackaged: true,
        appPath: "/tmp/.mount_studio/resources/app.asar",
        resourcesPath: "/tmp/.mount_studio/resources",
      });

      assert.equal(environment.linuxDesktopEntryName, "com.specweave.SpecWeaveStudio.desktop");
    }),
  );

  it.effect("keeps implicit development state separate from production state", () =>
    Effect.gen(function* () {
      const development = yield* makeEnvironment(
        {},
        { VITE_DEV_SERVER_URL: "http://localhost:5173" },
      );
      const production = yield* makeEnvironment();

      assert.equal(development.stateDir, "/Users/alice/.specwithcode/dev");
      assert.equal(production.stateDir, "/Users/alice/.specwithcode/userdata");
    }),
  );

  it.effect("uses a configured app user model id override", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {},
        {
          STUDIO_DESKTOP_APP_USER_MODEL_ID: " com.specweave.studio.dev.local ",
          VITE_DEV_SERVER_URL: "http://localhost:5173",
        },
      );

      assert.equal(environment.appUserModelId, "com.specweave.studio.dev.local");
    }),
  );

  it.effect("resolves picker defaults without nullish sentinels", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment();

      assert.deepEqual(environment.resolvePickFolderDefaultPath(null), Option.none());
      assert.deepEqual(
        environment.resolvePickFolderDefaultPath({ initialPath: " " }),
        Option.none(),
      );
      assert.deepEqual(
        environment.resolvePickFolderDefaultPath({ initialPath: "~" }),
        Option.some("/Users/alice"),
      );
      assert.deepEqual(
        environment.resolvePickFolderDefaultPath({ initialPath: "~/project" }),
        Option.some("/Users/alice/project"),
      );
    }),
  );
});
