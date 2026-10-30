#!/usr/bin/env node
/**
 * Turns the per-platform CLI archives of one release into the npm packages
 * behind `npx specweave-studio` / `npm i -g specweave-studio`: one `@specweave-studio/studio-<platformKey>` package per
 * archive holding the archive's contents verbatim, plus the `specweave-studio` launcher
 * that lists them as optionalDependencies and execs the one npm installed.
 * The bytes a user gets from npm are therefore the release archive's, and
 * running them needs neither a Node runtime, npm, nor a native build.
 *
 * Output layout under `--output-dir`:
 *
 *   @specweave-studio/studio-<platformKey>/      archive contents flattened + package.json
 *   @specweave-studio/studio-<platformKey>.tgz   the same tree as an npm tarball
 *   studio/                             launcher: package.json, bin/{specweave-studio,specwithcode}.js, README.md
 *   specweave-studio.tgz                          the launcher as an npm tarball
 *
 * The tarballs are what gets published. `npm publish <dir>` always drops
 * `node_modules/` (npm-packlist ignores it whatever `files` says, and
 * bundleDependencies needs an arborist tree these flattened installs are
 * not), whereas `npm publish <tarball>` uploads the bytes as given.
 */
import { legacyCliLauncherScript } from "@specweave-studio/shared/legacyCliLauncher";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  CLI_ARCHIVE_PLATFORM_KEYS,
  cliArchiveFileName,
  type CliArchivePlatformKey,
} from "@specweave-studio/shared/cliRelease";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import { fromJsonStringPretty } from "@specweave-studio/shared/schemaJson";
import { isCommandAvailable } from "@specweave-studio/shared/shell";
import serverPackageJson from "../apps/server/package.json" with { type: "json" };

import { windowsSystemTar } from "./build-cli-archive.ts";

export const NPM_PLATFORM_PACKAGE_SCOPE = "@specweave-studio";
export const NPM_LAUNCHER_PACKAGE_NAME = "specweave-studio";

const encodePackageJson = Schema.encodeEffect(fromJsonStringPretty(Schema.Unknown));

export class NpmPackagesCommandFailedError extends Schema.TaggedError<NpmPackagesCommandFailedError>()(
  "NpmPackagesCommandFailedError",
  { command: Schema.String, exitCode: Schema.Int },
) {
  override get message(): string {
    return `${this.command} exited with code ${this.exitCode}.`;
  }
}

export class NpmPackagesToolMissingError extends Schema.TaggedError<NpmPackagesToolMissingError>()(
  "NpmPackagesToolMissingError",
  { tool: Schema.String, purpose: Schema.String },
) {
  override get message(): string {
    return `\`${this.tool}\` is not on PATH; it is needed to ${this.purpose}.`;
  }
}

export class NpmPackagesArchivesMissingError extends Schema.TaggedError<NpmPackagesArchivesMissingError>()(
  "NpmPackagesArchivesMissingError",
  { archivesDir: Schema.String, missing: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `${this.archivesDir} lacks archives for ${this.missing.join(", ")}. A launcher published without them would silently skip those platforms; pass --allow-missing for a deliberately partial build.`;
  }
}

export class NpmPackagesArchiveLayoutError extends Schema.TaggedError<NpmPackagesArchiveLayoutError>()(
  "NpmPackagesArchiveLayoutError",
  { archive: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `${this.archive}: ${this.detail}`;
  }
}

export function npmPlatformPackageName(platformKey: CliArchivePlatformKey): string {
  return `${NPM_PLATFORM_PACKAGE_SCOPE}/studio-${platformKey}`;
}

/**
 * package.json for one platform package; `os`/`cpu` let npm skip the other
 * five. The archive's runtime `node_modules` (native addons and their
 * loaders) ships inside the tarball, and npm only keeps a nested tree it can
 * account for: anything not declared is extraneous and pruned on the next
 * `npm install` in that project, which then breaks the executable. Declaring
 * every bundled package as a bundled dependency at the exact version on disk
 * makes npm treat the tree as part of this package and leave it alone.
 */
export function npmPlatformPackageManifest(
  platformKey: CliArchivePlatformKey,
  version: string,
  bundled: Readonly<Record<string, string>>,
) {
  const [os, cpu] = platformKey.split("-") as [string, string];
  const bundleDependencies = Object.keys(bundled).sort();
  return {
    name: npmPlatformPackageName(platformKey),
    version,
    description: `SpecWithCode CLI executable for ${platformKey}`,
    license: serverPackageJson.license,
    repository: serverPackageJson.repository,
    os: [os],
    cpu: [cpu],
    files: [
      "specweave-studio",
      "specweave-studio.exe",
      "client",
      "resource-monitor",
      "lib",
      "node_modules",
    ],
    preferUnplugged: true,
    dependencies: Object.fromEntries(bundleDependencies.map((name) => [name, bundled[name]])),
    bundleDependencies,
  };
}

const PackageVersion = Schema.Struct({ version: Schema.String });
const decodePackageVersion = Schema.decodeUnknownEffect(Schema.fromJsonString(PackageVersion));

/** Every top-level package under `node_modules`, scoped ones included, at the version its manifest names. */
const readBundledPackages = Effect.fn("readBundledPackages")(function* (nodeModulesDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const bundled: Record<string, string> = {};
  const packageDirs: Array<{ readonly name: string; readonly dir: string }> = [];
  for (const entry of yield* fs.readDirectory(nodeModulesDir)) {
    if (entry.startsWith(".")) continue;
    const dir = path.join(nodeModulesDir, entry);
    if (entry.startsWith("@")) {
      for (const scoped of yield* fs.readDirectory(dir)) {
        packageDirs.push({ name: `${entry}/${scoped}`, dir: path.join(dir, scoped) });
      }
    } else {
      packageDirs.push({ name: entry, dir });
    }
  }
  for (const { name, dir } of packageDirs) {
    const manifest = yield* fs.readFileString(path.join(dir, "package.json"));
    bundled[name] = (yield* decodePackageVersion(manifest)).version;
  }
  return bundled;
});

/**
 * README for one platform package. Without one at the package root, npm
 * shows the first README it finds in the tarball, which is a bundled
 * dependency's (ffi-rs).
 */
export function npmPlatformPackageReadme(platformKey: CliArchivePlatformKey): string {
  return [
    `# ${npmPlatformPackageName(platformKey)}`,
    "",
    `The SpecWithCode CLI executable for ${platformKey}. Do not install this package directly:`,
    `it is an optional dependency of \`${NPM_LAUNCHER_PACKAGE_NAME}\`, which picks the package for the`,
    "current platform and runs the executable inside it.",
    "",
    "```sh",
    `npx ${NPM_LAUNCHER_PACKAGE_NAME}@latest`,
    "```",
    "",
    "Source and documentation: https://github.com/anton-abyzov/specwithcode",
    "",
  ].join("\n");
}

/** package.json for the `specweave-studio` launcher. No engines: bin/specweave-studio.js is trivial CJS. */
export function npmLauncherPackageManifest(
  version: string,
  platformKeys: ReadonlyArray<CliArchivePlatformKey>,
) {
  return {
    name: NPM_LAUNCHER_PACKAGE_NAME,
    version,
    description: "SpecWithCode CLI. Installs the self-contained executable for this platform.",
    license: serverPackageJson.license,
    repository: serverPackageJson.repository,
    bin: {
      "specweave-studio": "./bin/specweave-studio.js",
      specwithcode: "./bin/specwithcode.js",
    },
    files: ["bin", "dist"],
    optionalDependencies: Object.fromEntries(
      platformKeys.map((key) => [npmPlatformPackageName(key), version]),
    ),
  };
}

/**
 * The launcher every `npx specweave-studio` runs. Plain CommonJS with no dependencies so it
 * loads on any Node that npm itself runs on; the real work happens in the
 * single-executable it execs.
 */
/** bin/specwithcode.js: its own file, so shims that never pass the typed name still carry it. */
export const NPM_ALIAS_LAUNCHER_SCRIPT = `#!/usr/bin/env node
"use strict";
require("./specweave-studio.js");
`;

export const NPM_LAUNCHER_SCRIPT = `#!/usr/bin/env node
"use strict";
const { spawnSync } = require("node:child_process");
const { constants } = require("node:os");
const { basename, dirname, join } = require("node:path");

const SUPPORTED = [${CLI_ARCHIVE_PLATFORM_KEYS.map((key) => `"${key}"`).join(", ")}];
const key = process.platform + "-" + process.arch;

let packageDir;
try {
  packageDir = dirname(require.resolve("${NPM_PLATFORM_PACKAGE_SCOPE}/studio-" + key + "/package.json"));
} catch {
  process.stderr.write(
    [
      "specweave-studio: no SpecWithCode CLI build is available for this platform (" + key + ").",
      "Supported platforms: " + SUPPORTED.join(", ") + ".",
      "If yours is listed, reinstall specweave-studio so npm fetches its optional dependency.",
      "The desktop app and release archives are at https://github.com/anton-abyzov/specwithcode/releases",
      "",
    ].join("\\n"),
  );
  process.exit(1);
}

const executable = join(packageDir, process.platform === "win32" ? "specweave-studio.exe" : "specweave-studio");
// Tell the CLI which bin was typed so --version names it. npm, pnpm and Windows .cmd shims
// run the file named in "bin", and a symlinked bin keeps its own name, so argv[1] names it.
const invokedAs = basename(process.argv[1] || "").replace(/\\.(?:[cm]?js|cmd)$/i, "");
const env =
  invokedAs === "specweave-studio" || invokedAs === "specwithcode"
    ? { ...process.env, STUDIO_CLI_NAME: invokedAs }
    : process.env;
const result = spawnSync(executable, process.argv.slice(2), { stdio: "inherit", env });
if (result.error) {
  process.stderr.write("specweave-studio: failed to start " + executable + ": " + result.error.message + "\\n");
  process.exit(1);
}
// A child killed by a signal has no status; report it the way a shell would.
process.exit(result.status ?? 128 + (constants.signals[result.signal] || 1));
`;

const runCommand = Effect.fn("runCommand")(function* (
  command: ChildProcess.StandardCommand,
  label: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(command.command, command.args, {
      ...command.options,
      stdout: "inherit",
      stderr: "inherit",
    }),
  );
  const exitCode = Number(yield* child.exitCode);
  if (exitCode !== 0) {
    return yield* new NpmPackagesCommandFailedError({ command: label, exitCode });
  }
});

/**
 * Extracts an archive and returns its single top-level directory. Windows
 * reads both formats with the bsdtar it ships (a GNU tar earlier on PATH
 * takes `C:` for a remote host); elsewhere `.tar.gz` goes through tar and
 * `.zip` through `unzip`, since GNU tar cannot read zip.
 */
const extractArchive = Effect.fn("extractArchive")(function* (archive: string, into: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  if (platform === "win32") {
    yield* runCommand(
      ChildProcess.make(windowsSystemTar(), ["-xf", archive, "-C", into]),
      "tar.exe -xf",
    );
  } else if (!archive.endsWith(".zip")) {
    yield* runCommand(ChildProcess.make("tar", ["-xf", archive, "-C", into]), "tar -xf");
  } else {
    if (!(yield* isCommandAvailable("unzip"))) {
      return yield* new NpmPackagesToolMissingError({
        tool: "unzip",
        purpose: `extract ${path.basename(archive)} (GNU tar cannot read zip)`,
      });
    }
    yield* runCommand(ChildProcess.make("unzip", ["-q", archive, "-d", into]), "unzip");
  }
  const entries = yield* fs.readDirectory(into);
  const [root] = entries;
  if (root === undefined || entries.length !== 1) {
    return yield* new NpmPackagesArchiveLayoutError({
      archive: path.basename(archive),
      detail: `expected exactly one top-level directory, found ${String(entries.length)} entries`,
    });
  }
  return path.join(into, root);
});

/** Tar to build npm tarballs with; see build-cli-archive.ts for why Windows names bsdtar by path. */
const hostTar = Effect.map(HostProcessPlatform, (platform) =>
  platform === "win32" ? windowsSystemTar() : "tar",
);

/**
 * Writes `stageDir/package` as a gzipped npm tarball and then moves the tree
 * to `packageDir` so the contents stay inspectable beside the tarball.
 */
const packAndPlace = Effect.fn("packAndPlace")(function* (input: {
  readonly stageDir: string;
  readonly packageDir: string;
  readonly tarball: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(input.tarball, { force: true });
  yield* runCommand(
    ChildProcess.make(yield* hostTar, ["-czf", input.tarball, "-C", input.stageDir, "package"]),
    `tar (${input.tarball})`,
  );
  yield* fs.remove(input.packageDir, { recursive: true, force: true });
  yield* fs.rename(`${input.stageDir}/package`, input.packageDir);
});

export interface NpmPackageOutput {
  readonly name: string;
  readonly packageDir: string;
  readonly tarball: string;
}

/**
 * Extracts one archive, adds its package.json, and emits the package dir and
 * tarball. The scratch dir lives inside the output dir so the extracted tree
 * is renamed into place rather than copied across filesystems.
 */
const stagePlatformPackage = Effect.fn("stagePlatformPackage")(function* (input: {
  readonly key: CliArchivePlatformKey;
  readonly archive: string;
  readonly outputDir: string;
  readonly version: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* Effect.log(`[npm-packages] Extracting ${path.basename(input.archive)}...`);
  const scratch = yield* fs.makeTempDirectoryScoped({
    directory: input.outputDir,
    prefix: ".extract-",
  });
  const extractDir = path.join(scratch, "extract");
  yield* fs.makeDirectory(extractDir);
  const contentDir = yield* extractArchive(input.archive, extractDir);
  const executableName = input.key.startsWith("win32")
    ? "specweave-studio.exe"
    : "specweave-studio";
  const executable = path.join(contentDir, executableName);
  if (!(yield* fs.exists(executable))) {
    return yield* new NpmPackagesArchiveLayoutError({
      archive: path.basename(input.archive),
      detail: `missing ${executableName} at the archive root`,
    });
  }
  // The tarball carries the on-disk mode, so the bit must be set before packing.
  if (executableName === "specweave-studio") {
    yield* fs.chmod(executable, 0o755);
  }
  const bundled = yield* readBundledPackages(path.join(contentDir, "node_modules"));
  yield* fs.writeFileString(
    path.join(contentDir, "package.json"),
    `${yield* encodePackageJson(npmPlatformPackageManifest(input.key, input.version, bundled))}\n`,
  );
  yield* fs.writeFileString(
    path.join(contentDir, "README.md"),
    npmPlatformPackageReadme(input.key),
  );
  // npm tarballs root everything under `package/`.
  yield* fs.rename(contentDir, path.join(scratch, "package"));
  const name = npmPlatformPackageName(input.key);
  const output: NpmPackageOutput = {
    name,
    packageDir: path.join(input.outputDir, name),
    tarball: path.join(input.outputDir, `${name}.tgz`),
  };
  yield* packAndPlace({ stageDir: scratch, ...output });
  return output;
}, Effect.scoped);

/** Writes the launcher package (package.json, bin/*.js, README) and its tarball. */
const stageLauncherPackage = Effect.fn("stageLauncherPackage")(function* (input: {
  readonly outputDir: string;
  readonly version: string;
  readonly platformKeys: ReadonlyArray<CliArchivePlatformKey>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scratch = yield* fs.makeTempDirectoryScoped({
    directory: input.outputDir,
    prefix: ".launcher-",
  });
  const stageDir = path.join(scratch, "package");
  yield* fs.makeDirectory(path.join(stageDir, "bin"), { recursive: true });
  yield* fs.writeFileString(
    path.join(stageDir, "package.json"),
    `${yield* encodePackageJson(npmLauncherPackageManifest(input.version, input.platformKeys))}\n`,
  );
  const launcherScript = path.join(stageDir, "bin/specweave-studio.js");
  yield* fs.writeFileString(launcherScript, NPM_LAUNCHER_SCRIPT);
  yield* fs.chmod(launcherScript, 0o755);
  const aliasScript = path.join(stageDir, "bin/specwithcode.js");
  yield* fs.writeFileString(aliasScript, NPM_ALIAS_LAUNCHER_SCRIPT);
  yield* fs.chmod(aliasScript, 0o755);
  // Older service updaters and launchers run this exact path with Node.
  // Keep it in the package so they can preflight and start the new executable.
  yield* fs.makeDirectory(path.join(stageDir, "dist"));
  yield* fs.writeFileString(path.join(stageDir, "dist/bin.mjs"), legacyCliLauncherScript());
  const readme = yield* path.fromFileUrl(new URL("../apps/server/README.md", import.meta.url));
  if (yield* fs.exists(readme)) {
    yield* fs.copyFile(readme, path.join(stageDir, "README.md"));
  }
  const output: NpmPackageOutput = {
    name: NPM_LAUNCHER_PACKAGE_NAME,
    packageDir: path.join(input.outputDir, NPM_LAUNCHER_PACKAGE_NAME),
    tarball: path.join(input.outputDir, `${NPM_LAUNCHER_PACKAGE_NAME}.tgz`),
  };
  yield* packAndPlace({ stageDir: scratch, ...output });
  return output;
}, Effect.scoped);

export const buildNpmPlatformPackages = Effect.fn("buildNpmPlatformPackages")(function* (input: {
  readonly archivesDir: string;
  readonly version: string;
  readonly outputDir: string;
  readonly allowMissing: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const present = yield* fs.readDirectory(input.archivesDir);
  const archives = CLI_ARCHIVE_PLATFORM_KEYS.flatMap((key) => {
    const fileName = cliArchiveFileName(input.version, key);
    return present.includes(fileName)
      ? [{ key, archive: path.join(input.archivesDir, fileName) }]
      : [];
  });
  const missing = CLI_ARCHIVE_PLATFORM_KEYS.filter(
    (key) => !archives.some((entry) => entry.key === key),
  );
  if (missing.length > 0 && (!input.allowMissing || archives.length === 0)) {
    return yield* new NpmPackagesArchivesMissingError({ archivesDir: input.archivesDir, missing });
  }

  yield* fs.makeDirectory(path.join(input.outputDir, NPM_PLATFORM_PACKAGE_SCOPE), {
    recursive: true,
  });
  // Each archive stages in its own scratch dir, so all of them unpack and
  // compress at once. Sequentially this took about 45s for five archives.
  const platformOutputs = yield* Effect.forEach(
    archives,
    ({ key, archive }) =>
      stagePlatformPackage({ key, archive, outputDir: input.outputDir, version: input.version }),
    { concurrency: "unbounded" },
  );
  const outputs = [
    ...platformOutputs,
    yield* stageLauncherPackage({
      outputDir: input.outputDir,
      version: input.version,
      platformKeys: archives.map((entry) => entry.key),
    }),
  ];

  for (const output of outputs) {
    yield* Effect.log(`[npm-packages] Wrote ${output.packageDir} and ${output.tarball}`);
  }
  if (missing.length > 0) {
    yield* Effect.logWarning(
      `[npm-packages] Launcher omits ${missing.join(", ")} (--allow-missing).`,
    );
  }
  return outputs;
});

const command = Command.make(
  "build-npm-platform-packages",
  {
    archivesDir: Flag.String("archives-dir").pipe(
      Flag.withDescription("Directory holding the release's studio-<version>-<platform> archives."),
    ),
    version: Flag.String("version").pipe(
      Flag.withDescription(
        "Exact release version; selects the archives and versions the packages.",
      ),
    ),
    outputDir: Flag.String("output-dir").pipe(Flag.withDefault("npm-packages")),
    allowMissing: Flag.Boolean("allow-missing").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Build a launcher that lists only the platforms present."),
    ),
  },
  buildNpmPlatformPackages,
).pipe(
  Command.withDescription(
    "Build the specweave-studio launcher and @specweave-studio/studio-<platform> npm packages from CLI release archives.",
  ),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer)),
    NodeRuntime.runMain,
  );
}
