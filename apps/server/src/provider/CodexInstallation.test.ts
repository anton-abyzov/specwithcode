import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ModelManifest from "./ModelManifest.ts";
import { expect, it } from "@effect/vitest";
import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessPlatform,
} from "@specweave-studio/shared/hostProcess";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as CodexInstallation from "./CodexInstallation.ts";

// The harness runs as the host so real files, PATH lookup and `tar` behave as
// they do in production: a Windows host gets the Windows package layout and a
// `.CMD` stand-in for the local CLI.
const windowsHost = HostProcessPlatform.defaultValue() === "win32";
const executableName = windowsHost ? "codex.exe" : "codex";
const exe = windowsHost ? ".exe" : "";
const posixArchive = Buffer.from(
  "H4sIAAAAAAAC/+3W0W6DIBQGYB/FcD0sKNSkD7J7aom6tmAQtzXL3n3QZM3qdWVt+n8XoCckJp78wLY3q8bu9Ge2HBbUUp7nYD4H8s9zrNdSsCxnWQLT6JULn8ye09K9h/u2/c0/jSM9xqGzo0+bf3Gdf15WQiD/Kdy61/CA+z8dlO9Wrv2387+c5Z9VZY38p7BY0+Gh8t/sVauLt9Ga9Pnnop7ln1e4/6fxRQ7qZCf/qt3YW0M2OX/JyfvljbCCy3XBSaiGH9VqH4tKuaZbC6qG4aDpTrmP3sQV2nh3Gmxvzqsud0vyjaABAAAAAAAAAAAAAAAk8gOq19rvACgAAA==",
  "base64",
);
const windowsArchive = Buffer.from(
  "H4sIAAAAAAAC/+3XwW6DIADGcR/FcC4WVGyzB9m1QUus2woGaGuz7N0HLlsaL71ML36/AyoxMZH8Ddad3jbmqIZMDSqZBwt2QozHYHoMxMN5mOesyFmSsmQBF+elDY9P1mlc+wTWqv7tn8aRnuNwMs7/5+fgef/lpP+C5yX6X0Jca1SwXj/t99KftradaQ/wvP980j/nbIf+l2BbNID+e9m8y1Zlb87o5fvnYrr/50WB/hfxST7k3Vz8q7KuM5q8pHyTkuvfFWEZF1XGSZgNL6pVPk4O++pQlbRv6K3TR3Nz9OyuTbxHaW/vven0eF/9+HdJvpAbAAAAAAAAAAAAAADA7L4BHTa57wAoAAA=",
  "base64",
);
const archive = windowsHost ? windowsArchive : posixArchive;
const asset = {
  version: "0.156.1",
  target: windowsHost ? "x86_64-pc-windows-msvc" : "aarch64-apple-darwin",
  url: "https://github.com/openai/codex/releases/download/test/package.tar.gz",
  archiveBytes: archive.length,
};
/** A local Codex CLI stand-in that logs its arguments to `probeLog` when given. */
const writeLocalCli = Effect.fn("test.writeLocalCli")(function* (
  file: string,
  local: { version: string; appServerFails?: boolean; versionFails?: boolean },
  probeLog?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  if (windowsHost) {
    yield* fs.writeFileString(
      file,
      [
        "@echo off",
        // The spawner quotes each argument, so log them unquoted like `$*`.
        ...(probeLog
          ? [`if "%~2"=="" (>>"${probeLog}" echo %~1) else (>>"${probeLog}" echo %~1 %~2)`]
          : []),
        `if "%~1"=="--version" ${local.versionFails ? "exit /b 1" : `(echo codex-cli ${local.version}& exit /b 0)`}`,
        `if "%~1"=="app-server" exit /b ${local.appServerFails ? "1" : "0"}`,
        "",
      ].join("\r\n"),
    );
    return;
  }
  yield* fs.writeFileString(
    file,
    probeLog
      ? `#!/bin/sh\nprintf '%s\\n' "$*" >> '${probeLog}'\ncase "$1" in\n--version) ${local.versionFails ? "exit 1" : `printf '%s\\n' 'codex-cli ${local.version}'`};;\napp-server) exit ${local.appServerFails ? "1" : "0"};;\nesac\n`
      : `#!/bin/sh\nprintf 'codex-cli ${local.version}\\n'\n`,
    { mode: 0o755 },
  );
});
const readProbes = (fs: FileSystem.FileSystem, probeLog: string) =>
  fs.readFileString(probeLog).pipe(Effect.map((text) => text.trim().split(/\r?\n/u)));
const makeHarness = Effect.fn("test.makeCodexInstallation")(function* (
  input: {
    options?: Partial<CodexInstallation.CodexInstallationOptions>;
    manifestCurrent?: Effect.Effect<ModelManifest.ModelManifestData>;
    body?: Stream.Stream<Uint8Array>;
    baseDir?: string;
    local?: { version: string; appServerFails?: boolean; versionFails?: boolean };
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir =
    input.baseDir ?? (yield* fs.makeTempDirectoryScoped({ prefix: "studio-codex-install-test-" }));
  const localDirectory = path.join(baseDir, "local");
  const localBinaryPath = path.join(localDirectory, windowsHost ? "codex.CMD" : "codex");
  const probeLog = path.join(baseDir, "local-probes.txt");
  if (input.local) {
    yield* fs.makeDirectory(localDirectory, { recursive: true });
    yield* writeLocalCli(localBinaryPath, input.local, probeLog);
  }
  let downloads = 0;
  const crypto = yield* Crypto.Crypto;
  const sha256 = Hex.encode(yield* crypto.digest("SHA-256", archive).pipe(Effect.orDie));
  const installation = yield* CodexInstallation.makeCodexInstallation({
    baseDir,
    releaseAsset: { ...asset, sha256 },
    validate: () => Effect.void,
    ...input.options,
  }).pipe(
    Effect.provideService(ModelManifest.ModelManifest, {
      current: input.manifestCurrent ?? Effect.succeed(ModelManifest.BUNDLED_MODEL_MANIFEST),
      refresh: Effect.succeed(ModelManifest.BUNDLED_MODEL_MANIFEST),
      forceRefresh: Effect.succeed(ModelManifest.BUNDLED_MODEL_MANIFEST),
      refreshInBackground: Effect.void,
    }),
    Effect.provideService(HostProcessPlatform, windowsHost ? "win32" : "darwin"),
    Effect.provideService(HostProcessArchitecture, windowsHost ? "x64" : "arm64"),
    Effect.provideService(HostProcessEnvironment, { PATH: input.local ? localDirectory : "" }),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          downloads++;
          return Object.defineProperty(
            HttpClientResponse.fromWeb(request, new Response(null)),
            "stream",
            {
              value: input.body ?? Stream.succeed(archive),
            },
          );
        }),
      ),
    ),
  );
  return {
    installation,
    fs,
    path,
    baseDir,
    localBinaryPath,
    probeLog,
    downloads: () => downloads,
  };
});
const terminalState = (installation: CodexInstallation.CodexInstallation["Service"]) =>
  installation.changes.pipe(
    Stream.filter((state) => ["succeeded", "failed", "cancelled"].includes(state.phase)),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

it.effect.each(["0.156.0", "0.156.1", "0.156.2", "0.157.0"])(
  "reuses installed Codex %s without downloading or taking ownership of it",
  (version) =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ local: { version } });
      expect(yield* h.installation.start).toMatchObject({
        source: "local",
        phase: "succeeded",
        installedVersion: version,
        executablePath: h.localBinaryPath,
        canRemove: false,
      });
      expect(yield* h.installation.resolve()).toMatchObject({
        source: "local",
        executablePath: h.localBinaryPath,
        managedVersionDirectory: null,
        version,
      });
      yield* h.installation.acquire().pipe(Effect.scoped);
      expect(h.downloads()).toBe(0);
      expect(yield* h.fs.exists(h.installation.managedDirectory)).toBe(false);
      expect(yield* readProbes(h.fs, h.probeLog)).toEqual(["--version", "app-server --help"]);
      yield* h.installation.remove();
      expect(yield* h.fs.exists(h.localBinaryPath)).toBe(true);
      expect((yield* h.installation.state).source).toBe("local");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.effect.each([
  { version: "0.128.9" },
  { version: "0.145.0" },
  { version: "0.155.1" },
  { version: "0.155.9" },
  { version: "0.156.1-alpha.1" },
  { version: "unknown" },
  { version: "0.156.1", appServerFails: true },
  { version: "0.156.1", versionFails: true },
])("downloads the pinned release when the local CLI is unsupported or broken: %j", (local) =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ local });
    expect((yield* h.installation.state).installedVersion).toBeNull();
    yield* h.installation.start;
    const installed = yield* terminalState(h.installation);
    expect(installed.phase).toBe("succeeded");
    const executable = yield* h.installation.resolve();
    expect(executable.source).toBe("managed");
    expect(installed.executablePath).toBe(executable.executablePath);
    expect(h.downloads()).toBe(1);
    expect(yield* h.fs.exists(h.localBinaryPath)).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.effect("falls back to a managed download when the reused local executable disappears", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ local: { version: "0.156.1" } });
    expect((yield* h.installation.resolve()).source).toBe("local");
    yield* h.fs.remove(h.localBinaryPath);
    yield* h.installation.start;
    expect((yield* terminalState(h.installation)).phase).toBe("succeeded");
    expect((yield* h.installation.resolve()).source).toBe("managed");
    expect(h.downloads()).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rechecks compatibility after the local executable is replaced", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ local: { version: "0.156.1" } });
    expect((yield* h.installation.resolve()).source).toBe("local");
    yield* h.fs.remove(h.localBinaryPath);
    yield* writeLocalCli(h.localBinaryPath, { version: "0.128.9" });
    yield* h.installation.start;
    expect((yield* terminalState(h.installation)).phase).toBe("succeeded");
    expect((yield* h.installation.resolve()).source).toBe("managed");
    expect(h.downloads()).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rechecks a cached local executable when the shared manifest policy changes", () =>
  Effect.gen(function* () {
    let manifest = ModelManifest.BUNDLED_MODEL_MANIFEST;
    const h = yield* makeHarness({
      local: { version: "0.156.0" },
      manifestCurrent: Effect.sync(() => manifest),
    });
    expect((yield* h.installation.resolve()).source).toBe("local");
    manifest = {
      ...manifest,
      compatibility: [
        {
          driver: "codex",
          studioCodeRange: ">=0.0.42",
          ranges: [
            { range: ">=0.156.1", status: "supported" },
            { range: "<0.156.1", status: "broken" },
          ],
        },
      ],
    };
    yield* h.installation.start;
    expect((yield* terminalState(h.installation)).phase).toBe("succeeded");
    expect((yield* h.installation.resolve()).source).toBe("managed");
    expect(h.downloads()).toBe(1);
    expect(yield* readProbes(h.fs, h.probeLog)).toEqual(["--version", "app-server --help"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("uses bundled Codex compatibility when the remote manifest omits its policy", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({
      local: { version: "0.156.0" },
      manifestCurrent: Effect.succeed({
        ...ModelManifest.BUNDLED_MODEL_MANIFEST,
        compatibility: [],
      }),
    });
    expect((yield* h.installation.start).source).toBe("local");
    expect(h.downloads()).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// Version-manager shims (asdf, mise) dispatch on the `$0` of a symlinked sh
// launcher, a POSIX-only install shape.
it.effect.skipIf(windowsHost)(
  "preserves the invoked name of version-manager launcher symlinks",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ local: { version: "0.156.1" } });
      const launcher = `${h.baseDir}/launcher`;
      yield* h.fs.writeFileString(
        launcher,
        '#!/bin/sh\ncase "$0" in */codex) ;; *) exit 1;; esac\ncase "$1" in --version) printf "codex-cli 0.156.1\\n";; app-server) exit 0;; esac\n',
        { mode: 0o755 },
      );
      yield* h.fs.remove(h.localBinaryPath);
      yield* h.fs.symlink(launcher, h.localBinaryPath);
      expect(yield* h.installation.start).toMatchObject({ source: "local", phase: "succeeded" });
      expect((yield* h.installation.resolve()).executablePath).toBe(h.localBinaryPath);
      expect(h.downloads()).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "installs the complete verified package in tools/codex/version and survives a restart",
  () =>
    Effect.gen(function* () {
      const { installation, fs, path, baseDir } = yield* makeHarness();
      yield* installation.start;
      expect((yield* terminalState(installation)).phase).toBe("succeeded");
      const executable = yield* installation.resolve();
      expect(executable.executablePath).toBe(
        path.join(baseDir, "tools", "codex", "0.156.1", "bin", executableName),
      );
      expect(
        yield* fs.readFileString(
          `${executable.managedVersionDirectory}/bin/codex-code-mode-host${exe}`,
        ),
      ).toBe("host");
      expect(
        yield* fs.readFileString(`${executable.managedVersionDirectory}/codex-path/rg${exe}`),
      ).toBe("rg");
      const restarted = yield* makeHarness({ baseDir });
      expect((yield* restarted.installation.resolve()).version).toBe("0.156.1");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("requires an update before running an older activated managed installation", () =>
  Effect.gen(function* () {
    const first = yield* makeHarness();
    yield* first.installation.start;
    yield* terminalState(first.installation);
    const executable = yield* first.installation.resolve();
    const oldDirectory = `${first.installation.managedDirectory}/0.155.1`;
    yield* first.fs.rename(executable.managedVersionDirectory!, oldDirectory);
    for (const name of ["codex-package.json", ".install-complete.json"]) {
      const file = `${oldDirectory}/${name}`;
      yield* first.fs.writeFileString(
        file,
        (yield* first.fs.readFileString(file)).replaceAll("0.156.1", "0.155.1"),
      );
    }
    yield* first.fs.writeFileString(
      `${first.installation.managedDirectory}/active.json`,
      '{"version":"0.155.1"}',
    );
    const restarted = yield* makeHarness({ baseDir: first.baseDir });
    expect((yield* Effect.flip(restarted.installation.resolve())).detail).toContain(
      "outside the supported range",
    );
    yield* restarted.installation.start;
    expect((yield* terminalState(restarted.installation)).phase).toBe("succeeded");
    expect((yield* restarted.installation.resolve()).version).toBe("0.156.1");
    expect(restarted.downloads()).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects corrupted downloads without publishing a runtime", () =>
  Effect.gen(function* () {
    const { installation, fs } = yield* makeHarness({
      options: { releaseAsset: { ...asset, sha256: "0".repeat(64) } },
    });
    yield* installation.start;
    const state = yield* terminalState(installation);
    expect(state.phase).toBe("failed");
    expect(state.message).toContain("SHA-256");
    expect(yield* fs.exists(`${installation.managedDirectory}/active.json`)).toBe(false);
    expect(yield* fs.exists(`${installation.managedDirectory}/0.156.1`)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("cancels an in-flight download and cleans the staging directory", () =>
  Effect.gen(function* () {
    const downloading = yield* Deferred.make<void>();
    const body = Stream.fromEffect(
      Deferred.succeed(downloading, undefined).pipe(Effect.andThen(Effect.never)),
    );
    const { installation, fs } = yield* makeHarness({ body });
    const started = yield* installation.start;
    yield* Deferred.await(downloading);
    expect((yield* installation.cancel(started.operationId!)).phase).toBe("cancelled");
    expect(
      (yield* fs.readDirectory(installation.managedDirectory)).filter((name) =>
        name.startsWith(".install-"),
      ),
    ).toEqual([]);
    expect(yield* fs.exists(`${installation.managedDirectory}/active.json`)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("protects active process leases and removes the runtime after release", () =>
  Effect.gen(function* () {
    const { installation, fs } = yield* makeHarness();
    yield* installation.start;
    yield* terminalState(installation);
    const leaseScope = yield* Scope.make();
    yield* installation.acquire().pipe(Effect.provideService(Scope.Scope, leaseScope));
    expect((yield* Effect.flip(installation.remove())).detail).toContain("Stop Codex sessions");
    yield* Scope.close(leaseScope, Exit.void);
    yield* installation.remove();
    expect(yield* fs.exists(installation.managedDirectory)).toBe(false);
    expect((yield* installation.state).installedVersion).toBeNull();
    expect((yield* installation.state).executablePath).toBeNull();
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps an activated runtime when a later update fails verification", () =>
  Effect.gen(function* () {
    const first = yield* makeHarness();
    yield* first.installation.start;
    yield* terminalState(first.installation);
    const update = yield* makeHarness({
      baseDir: first.baseDir,
      options: { releaseAsset: { ...asset, version: "0.156.2", sha256: "0".repeat(64) } },
    });
    expect((yield* update.installation.state).executablePath).toBe(
      (yield* first.installation.resolve()).executablePath,
    );
    yield* update.installation.start;
    expect((yield* terminalState(update.installation)).phase).toBe("failed");
    expect((yield* update.installation.resolve()).version).toBe("0.156.1");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("publishes complete packages for all supported platforms", () => {
  for (const platform of ["darwin", "linux", "win32"] as const)
    for (const arch of ["x64", "arm64"])
      expect(CodexInstallation.resolveCodexReleaseAsset(platform, arch)?.url).toContain(
        "codex-package-",
      );
  expect(CodexInstallation.resolveCodexReleaseAsset("linux", "riscv64")).toBeNull();
});
