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
 * A folder that is not a Git repository yet gets `git init` first only when
 * the person asked for it ("Set up Git and SpecWeave"); the CLI then sees
 * `.git` and skips its own `git add .` and commit, so none of their files is
 * staged. An empty first commit gives branches and worktrees a base.
 *
 * @module SpecweaveSetup
 */
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import { CommandResolutionCache, resolveCommandPath } from "@specweave-studio/shared/shell";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
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
import { refreshServerPath } from "../serverPath.ts";
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

/** The refusal older clients get for a folder outside Git, word for word. */
export const NOT_A_REPOSITORY_DETAIL =
  "SpecWeave needs a Git repository: this folder is not one. Run git init here first, then try again.";

export interface SpecweaveSetupOptions {
  /** Run `git init` first when the folder is in no Git work tree. */
  readonly initGit?: boolean | undefined;
}

export type SpecweaveSetupResult =
  | { readonly ok: true; readonly alreadySetUp: boolean; readonly gitInitialized?: true }
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
    readonly setUp: (
      cwd: string,
      options?: SpecweaveSetupOptions,
    ) => Effect.Effect<SpecweaveSetupResult>;
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
  // The provider the service was built with. It reads the environment live
  // (serverConfigProvider), so each press sees PATH as it is then.
  const configProvider = yield* ConfigProvider.ConfigProvider;
  const optional = (name: string) =>
    Config.String(name).pipe(
      Config.option,
      Effect.map(Option.getOrUndefined),
      Effect.provideService(ConfigProvider.ConfigProvider, configProvider),
    );
  // The usual user installs, since the server's PATH can be narrower than a login shell's.
  const home = expandHomePath("~");
  // Where first-run setup installs Node.js; absent where the server has no config (tests).
  const studioHome = Option.getOrUndefined(
    Option.map(yield* Effect.serviceOption(ServerConfig.ServerConfig), (config) => config.baseDir),
  );
  /**
   * Where to look, read on each press: Node.js can be installed or switched
   * while the app runs, and the server's PATH grows when it is refreshed (1452).
   */
  const searchNow = Effect.gen(function* () {
    // A person pressed Set up or Retry: take in a PATH an installer changed since
    // start. Windows keeps PATH in the registry with nothing to watch, so it is
    // read again on each press; elsewhere only when the shell's files changed.
    yield* refreshServerPath({ force: platform === "win32" }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
    );
    const pathEnv = yield* optional("PATH");
    const appData = yield* optional("APPDATA");
    const pathExt = yield* optional("PATHEXT");
    const managerDirs = yield* nodeToolDirs({
      home,
      platform,
      execPath: process.execPath,
      studioHome,
      fnmDir: yield* optional("FNM_DIR"),
      nvmDir: yield* optional("NVM_DIR"),
      voltaHome: yield* optional("VOLTA_HOME"),
      xdgDataHome: yield* optional("XDG_DATA_HOME"),
      programFiles: yield* optional("ProgramFiles"),
      localAppData: yield* optional("LOCALAPPDATA"),
      nvmSymlink: yield* optional("NVM_SYMLINK"),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    const usualDirs = vskillSearchDirs({ home, pathEnv, platform, appData });
    return { pathExt, managerDirs, usualDirs };
  });
  const findIn = (dirs: ReadonlyArray<string>, name: string, pathExt: string | undefined) =>
    resolveCommandPath(name, { env: { PATH: dirs.join(delimiter), PATHEXT: pathExt } }).pipe(
      // A press looks at the disk: the shared cache would repeat a miss for 30 s
      // after Node.js or SpecWeave was installed (1452).
      Effect.provideService(CommandResolutionCache, new Map()),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcessPlatform, platform),
      Effect.orElseSucceed(() => null),
    );
  /** npm's global folder, for a prefix none of the usual places cover. */
  const npmGlobalBin = Effect.fn("SpecweaveSetup.npmGlobalBin")(function* (
    searchDirs: ReadonlyArray<string>,
    pathExt: string | undefined,
  ) {
    const npm = yield* findIn(searchDirs, "npm", pathExt);
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

  const git = (cwd: string, args: ReadonlyArray<string>, timeout = Duration.seconds(10)) =>
    runner
      .run({
        command: "git",
        args: [...args],
        cwd,
        timeout,
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: 64 * 1024,
        outputMode: "truncate",
        // Git's own words in English, so "not a git repository" reads the same everywhere.
        env: { LC_ALL: "C", LANGUAGE: "C" },
      })
      .pipe(Effect.option);

  /** A `.git` in `start` or any folder above it, read from disk. */
  const gitMarkerAbove = Effect.fnUntraced(function* (start: string) {
    let dir = yield* fs.realPath(start).pipe(Effect.orElseSucceed(() => path.resolve(start)));
    for (;;) {
      if (yield* fs.exists(path.join(dir, ".git")).pipe(Effect.orElseSucceed(() => true)))
        return dir;
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  });

  /**
   * `git init` in a folder that is in no work tree, on the branch Git is set
   * to start on (main otherwise). An error detail, or undefined once it worked.
   */
  const initRepository = Effect.fnUntraced(function* (cwd: string) {
    const above = yield* gitMarkerAbove(cwd);
    if (above !== null) {
      return `This folder is inside the Git repository at ${above}. Set SpecWeave up there instead.`;
    }
    const configured = yield* git(cwd, ["config", "--get", "init.defaultBranch"]);
    const branch =
      Option.isSome(configured) && configured.value.code === 0 && configured.value.stdout.trim()
        ? configured.value.stdout.trim()
        : "main";
    const init = yield* git(cwd, ["init", `--initial-branch=${branch}`]);
    if (Option.isNone(init))
      return "Git could not be started on this machine. Install Git, then try again.";
    if (init.value.timedOut) return "git init did not finish in time.";
    if (init.value.code !== 0) {
      const tail = outputTail(init.value);
      return `git init failed${tail === "" ? "." : `: ${tail}`}`;
    }
    return undefined;
  });

  const run = Effect.fn("SpecweaveSetup.run")(function* (
    cwd: string,
    options: SpecweaveSetupOptions | undefined,
  ) {
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
    // A git that cannot start or does not answer is said as such, never as
    // "not a repository", so no second repository is made inside a real one.
    // A missing folder fails the spawn too; say that, not that Git is missing.
    if (!(yield* fs.exists(cwd).pipe(Effect.orElseSucceed(() => true)))) {
      return {
        ok: false,
        reason: "failed",
        detail: `This project's folder is no longer there: ${cwd}`,
      } as const;
    }
    const top = yield* git(cwd, ["rev-parse", "--show-toplevel"]);
    if (Option.isNone(top)) {
      return {
        ok: false,
        reason: "failed",
        detail:
          "SpecWeave needs Git, which could not be started on this machine. Install Git, then try again.",
      } as const;
    }
    if (top.value.timedOut) {
      return {
        ok: false,
        reason: "failed",
        detail: "Git did not answer in time, so SpecWeave was not set up. Try again.",
      } as const;
    }
    const topLevel = top.value.code === 0 ? top.value.stdout.trim() : "";
    // Any other refusal (a repository Git will not read, say) is Git's to explain.
    if (topLevel === "" && !/not a git repository/i.test(top.value.stderr)) {
      const tail = outputTail(top.value);
      return {
        ok: false,
        reason: "failed",
        detail: `Git could not read this folder${tail === "" ? "." : `: ${tail}`}`,
      } as const;
    }
    // Run only once the CLI is found, so a missing Node.js leaves no repository behind.
    const needsInit = topLevel === "";
    if (needsInit && options?.initGit !== true) {
      return { ok: false, reason: "failed", detail: NOT_A_REPOSITORY_DETAIL } as const;
    }
    const [here, root] = yield* Effect.all([
      fs.realPath(cwd).pipe(Effect.orElseSucceed(() => cwd)),
      fs.realPath(topLevel).pipe(Effect.orElseSucceed(() => topLevel)),
    ]);
    if (!needsInit && here !== root) {
      return {
        ok: false,
        reason: "failed",
        detail: `This folder is inside the Git repository at ${topLevel}. Set SpecWeave up there instead.`,
      } as const;
    }
    // Resolved on each request: the CLI can be installed while the app runs.
    const { pathExt, managerDirs, usualDirs } = yield* searchNow;
    const searchDirs = [...new Set([...usualDirs, ...managerDirs])];
    let specweave = yield* findIn(searchDirs, "specweave", pathExt);
    if (specweave === null) {
      const npmBin = yield* npmGlobalBin(searchDirs, pathExt);
      if (npmBin !== null) specweave = yield* findIn([npmBin], "specweave", pathExt);
    }
    const npx = specweave === null ? yield* findIn(searchDirs, "npx", pathExt) : null;
    const command = specweave ?? npx;
    if (command === null) {
      // Node.js without npm (a distribution's nodejs package) is not a missing Node.js.
      const node = yield* findIn(searchDirs, "node", pathExt);
      return {
        ok: false,
        reason: "unavailable",
        detail: specweaveUnavailableDetail(platform),
        ...(node === null ? { needs: "node" as const } : {}),
      } as const;
    }
    if (needsInit) {
      const initError = yield* initRepository(cwd);
      if (initError !== undefined)
        return { ok: false, reason: "failed", detail: initError } as const;
    }
    const gitInitialized = needsInit;
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
    if (gitInitialized) {
      // Only an empty commit: the person's files and SpecWeave's stay for them
      // to review. Soft, since Git may have no name or email on this machine.
      const commit = yield* git(
        cwd,
        ["commit", "--allow-empty", "--no-verify", "--message", "Initial commit"],
        Duration.seconds(30),
      );
      if (Option.isNone(commit) || commit.value.timedOut || commit.value.code !== 0) {
        yield* Effect.logInfo("The empty first commit was not made", {
          cwd,
          detail: Option.isSome(commit) ? outputTail(commit.value) : "git did not start",
        });
      }
      return { ok: true, alreadySetUp: false, gitInitialized: true } as const;
    }
    return { ok: true, alreadySetUp: false } as const;
  });

  // The reason reaches the person once, in the app; the log keeps it for later.
  const setUp: SpecweaveSetup["Service"]["setUp"] = (cwd, options) =>
    run(cwd, options).pipe(
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
