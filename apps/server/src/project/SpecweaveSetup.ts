/**
 * SpecweaveSetup - turns SpecWeave on for a project folder, and only when the
 * person asks: the "Use SpecWeave" box on a new project, or "Set up
 * SpecWeave" in Project settings. SpecWithCode never runs it on its own.
 *
 * It runs the person's own `specweave` CLI (`specweave init --quick --adapter
 * claude`), or the current 3.x release through npx when none is installed.
 * Both are looked for beyond the service's PATH (fnm, nvm, volta, npm's global
 * folder), since a service started by systemd or launchd rarely has Node on it.
 * Whether a project uses SpecWeave is then read from disk
 * (`isSpecweaveProject`), so there is no flag to keep in step.
 *
 * @module SpecweaveSetup
 */
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import { resolveCommandPath } from "@specweave-studio/shared/shell";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { vskillSearchDirs } from "../fleet/fleetSkills.ts";
import { expandHomePath } from "../pathExpansion.ts";
import * as ProcessRunner from "../processRunner.ts";
import { nodeToolDirs } from "./nodeToolDirs.ts";
import { hasAnySpecweaveConfig, hasSpecweaveConfig } from "./ThreadIncrementProgress.ts";

/** Non-interactive, never `--force`: an existing `.specweave` is left alone. */
export const SPECWEAVE_INIT_ARGS = ["init", "--quick", "--adapter", "claude"] as const;
/** Used only when no `specweave` is installed; the major is pinned, not the patch. */
export const NPX_SPECWEAVE_ARGS = ["--yes", "specweave@3"] as const;
// npx may download the package first.
const INIT_TIMEOUT = Duration.minutes(3);
const NPM_PREFIX_TIMEOUT = Duration.seconds(10);

/** Why nothing ran, and a fix that needs no sudo and no reinstall. */
export const specweaveUnavailableDetail = (platform: NodeJS.Platform): string =>
  platform === "win32"
    ? "SpecWeave needs Node.js, and SpecWithCode found neither specweave nor npx on this machine. Install Node.js from nodejs.org, then try again."
    : 'SpecWeave needs Node.js, and SpecWithCode found neither specweave nor npx on this machine (it looked on its PATH, in ~/.local/bin and in the fnm, nvm, volta and npm folders). Install Node.js, or if a terminal already has it run: mkdir -p ~/.local/bin && ln -sf "$(command -v node)" "$(command -v npx)" ~/.local/bin/ and try again.';

export type SpecweaveSetupResult =
  | { readonly ok: true; readonly alreadySetUp: boolean }
  | {
      readonly ok: false;
      readonly reason: "unavailable" | "failed";
      readonly detail: string;
      /** Node.js is missing, which the app can install from first-run setup's machine basics. */
      readonly needs?: "node";
    };

export class SpecweaveSetup extends Context.Service<
  SpecweaveSetup,
  {
    /**
     * Runs `specweave init` in `cwd` unless it is already set up. Never fails:
     * a missing CLI or a failed init comes back as `ok: false` with what to
     * tell the person.
     */
    readonly setUp: (cwd: string) => Effect.Effect<SpecweaveSetupResult>;
  }
>()("specweave-studio/project/SpecweaveSetup") {}

/** The last lines of a run, without colour codes. */
function outputTail(output: { readonly stdout: string; readonly stderr: string }, max = 400) {
  // oxlint-disable-next-line no-control-regex -- strips terminal colour codes.
  const plain = `${output.stderr}\n${output.stdout}`.replace(/\u001b\[[0-9;]*m/g, "").trim();
  return plain.length > max ? `…${plain.slice(-max)}` : plain;
}

const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const delimiter = platform === "win32" ? ";" : ":";
  const pathEnv = Option.getOrUndefined(yield* Config.String("PATH").pipe(Config.option));
  const appData = Option.getOrUndefined(yield* Config.String("APPDATA").pipe(Config.option));
  const pathExt = Option.getOrUndefined(yield* Config.String("PATHEXT").pipe(Config.option));
  // The usual user installs, since the server's PATH can be narrower than a login shell's.
  const home = expandHomePath("~");
  const optional = (name: string) =>
    Config.String(name).pipe(Config.option, Effect.map(Option.getOrUndefined));
  const managerEnv = {
    fnmDir: yield* optional("FNM_DIR"),
    nvmDir: yield* optional("NVM_DIR"),
    voltaHome: yield* optional("VOLTA_HOME"),
    xdgDataHome: yield* optional("XDG_DATA_HOME"),
  };
  const usualDirs = vskillSearchDirs({ home, pathEnv, platform, appData });
  // Where first-run setup installs Node.js; absent where the server has no config (tests).
  const studioHome = Option.getOrUndefined(
    Option.map(yield* Effect.serviceOption(ServerConfig.ServerConfig), (config) => config.baseDir),
  );
  // Read on each request: Node can be installed or switched while the app runs.
  const managerDirsNow = nodeToolDirs({
    home,
    platform,
    execPath: process.execPath,
    studioHome,
    ...managerEnv,
  }).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(Path.Path, path));
  const findIn = (dirs: ReadonlyArray<string>, name: string) =>
    resolveCommandPath(name, { env: { PATH: dirs.join(delimiter), PATHEXT: pathExt } }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcessPlatform, platform),
      Effect.orElseSucceed(() => null),
    );
  /** npm's global folder, for a prefix none of the usual places cover. */
  const npmGlobalBin = Effect.fn("SpecweaveSetup.npmGlobalBin")(function* (
    searchDirs: ReadonlyArray<string>,
  ) {
    const npm = yield* findIn(searchDirs, "npm");
    if (npm === null) return null;
    const output = yield* runner
      .run({
        command: npm,
        args: ["prefix", "-g"],
        timeout: NPM_PREFIX_TIMEOUT,
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: 16 * 1024,
        outputMode: "truncate",
        env: { PATH: [path.dirname(npm), ...searchDirs].join(delimiter) },
      })
      .pipe(Effect.option);
    if (Option.isNone(output) || output.value.timedOut || output.value.code !== 0) return null;
    const prefix = output.value.stdout.trim();
    if (!path.isAbsolute(prefix)) return null;
    return platform === "win32" ? prefix : path.join(prefix, "bin");
  });

  const run = Effect.fn("SpecweaveSetup.run")(function* (cwd: string) {
    if (yield* Effect.promise(() => hasSpecweaveConfig(cwd))) {
      return { ok: true, alreadySetUp: true } as const;
    }
    // init rewrites config.json, and a write through a link changes the file it points at.
    if (yield* Effect.promise(() => hasAnySpecweaveConfig(cwd))) {
      return {
        ok: false,
        reason: "failed",
        detail:
          ".specweave/config.json is a link or not a regular file, so SpecWeave was left as it is.",
      } as const;
    }
    // Outside a repository init runs `git init` and commits the whole folder;
    // in a subfolder it nests a second repository. Only the repository's top runs it.
    const top = yield* runner
      .run({
        command: "git",
        args: ["rev-parse", "--show-toplevel"],
        cwd,
        timeout: Duration.seconds(10),
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: 64 * 1024,
        outputMode: "truncate",
      })
      .pipe(Effect.option);
    const topLevel =
      Option.isSome(top) && !top.value.timedOut && top.value.code === 0
        ? top.value.stdout.trim()
        : "";
    if (topLevel === "") {
      return {
        ok: false,
        reason: "failed",
        detail:
          "SpecWeave needs a Git repository: this folder is not one. Run git init here first, then try again.",
      } as const;
    }
    const [here, root] = yield* Effect.all([
      fs.realPath(cwd).pipe(Effect.orElseSucceed(() => cwd)),
      fs.realPath(topLevel).pipe(Effect.orElseSucceed(() => topLevel)),
    ]);
    if (here !== root) {
      return {
        ok: false,
        reason: "failed",
        detail: `This folder is inside the Git repository at ${topLevel}. Set SpecWeave up there instead.`,
      } as const;
    }
    // Resolved on each request: the CLI can be installed while the app runs.
    const managerDirs = yield* managerDirsNow;
    const searchDirs = [...new Set([...usualDirs, ...managerDirs])];
    let specweave = yield* findIn(searchDirs, "specweave");
    if (specweave === null) {
      const npmBin = yield* npmGlobalBin(searchDirs);
      if (npmBin !== null) specweave = yield* findIn([npmBin], "specweave");
    }
    const npx = specweave === null ? yield* findIn(searchDirs, "npx") : null;
    const command = specweave ?? npx;
    if (command === null) {
      // Node.js without npm (a distribution's nodejs package) is not a missing Node.js.
      const node = yield* findIn(searchDirs, "node");
      return {
        ok: false,
        reason: "unavailable",
        detail: specweaveUnavailableDetail(platform),
        ...(node === null ? { needs: "node" as const } : {}),
      } as const;
    }
    const args =
      specweave === null
        ? [...NPX_SPECWEAVE_ARGS, ...SPECWEAVE_INIT_ARGS]
        : [...SPECWEAVE_INIT_ARGS];
    const output = yield* runner
      .run({
        command,
        args,
        cwd,
        timeout: INIT_TIMEOUT,
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: 256 * 1024,
        outputMode: "truncate",
        // A node script: its own folder first, so its `node` is found, then a
        // version manager's Node ahead of an older one the system may carry.
        env: {
          PATH: [...new Set([path.dirname(command), ...managerDirs, ...usualDirs])]
            .filter(Boolean)
            .join(delimiter),
          NO_COLOR: "1",
        },
      })
      .pipe(Effect.option);
    if (Option.isNone(output)) {
      return {
        ok: false,
        reason: "failed",
        detail: "specweave init could not be started.",
      } as const;
    }
    const run = output.value;
    if (run.timedOut) {
      return {
        ok: false,
        reason: "failed",
        detail: "specweave init did not finish in time.",
      } as const;
    }
    const tail = outputTail(run);
    if (run.code !== 0) {
      return {
        ok: false,
        reason: "failed",
        detail: `specweave init exited with ${String(run.code)}${tail === "" ? "." : `: ${tail}`}`,
      } as const;
    }
    // Exit 0 without a config is still not a SpecWeave project.
    if (!(yield* Effect.promise(() => hasSpecweaveConfig(cwd)))) {
      return {
        ok: false,
        reason: "failed",
        detail: `specweave init finished without writing .specweave/config.json${tail === "" ? "." : `: ${tail}`}`,
      } as const;
    }
    return { ok: true, alreadySetUp: false } as const;
  });

  // The reason reaches the person once, in the app; the log keeps it for later.
  const setUp: SpecweaveSetup["Service"]["setUp"] = (cwd) =>
    run(cwd).pipe(
      Effect.tap((result) =>
        result.ok
          ? Effect.void
          : Effect.logWarning("SpecWeave was not set up", {
              cwd,
              reason: result.reason,
              detail: result.detail,
            }),
      ),
    );

  return SpecweaveSetup.of({ setUp });
});

export const layer = Layer.effect(SpecweaveSetup, make);
