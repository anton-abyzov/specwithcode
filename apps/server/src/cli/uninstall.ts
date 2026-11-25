// @effect-diagnostics nodeBuiltinImport:off
// The Windows cleanup shell must outlive this process (it deletes the
// directory this executable runs from), which Effect's scoped ChildProcess
// cannot express: it kills the child when the scope closes.
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";

import {
  HostProcessEnvironment,
  HostProcessIsExecutable,
  HostProcessPlatform,
} from "@specweave-studio/shared/hostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag, Prompt } from "effect/cli";

import * as BootService from "../cloud/bootService.ts";
import { pinnedRuntimeVersionsDir } from "../cloud/pinnedRuntime.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import {
  nodeTerminalPathFs,
  removeTerminalPathBlocks,
  terminalCommandsDir,
} from "../machineTools/terminalPath.ts";
import * as CliService from "./service.ts";
import { findWindowsShim, launcherOwnsVersionsDir, resolveLaunchedAs } from "./update.ts";
import { windowsSystem32Dir, windowsSystem32Path } from "../process/windowsSystemTools.ts";

export class CliUninstallError extends Schema.TaggedError<CliUninstallError>()(
  "CliUninstallError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

/**
 * What `specweave-studio uninstall` would remove for one Studio home. Computed before anything
 * is touched so the user sees the whole plan in one place.
 */
export interface UninstallPlan {
  /** The background service serves this home and will be stopped and removed. */
  readonly service: boolean;
  /** The `specweave-studio` launcher (symlink or `.cmd` shim) that points into this home's runtime tree. */
  readonly launcher: string | undefined;
  /** `<home>/runtime`, holding every downloaded version, when it exists. */
  readonly runtimeDir: string | undefined;
  /** `<home>/userdata`, which is never removed; shown so the user knows where it is. */
  readonly userdataDir: string;
}

/**
 * Finds the launcher this install left on PATH. Only a launcher that points
 * into this home's `runtime/versions` is claimed: a plain copy of the
 * executable, or a launcher for another home, is not ours to delete.
 */
export const findOwnedLauncher = Effect.fn("cli.uninstall.find_launcher")(function* (input: {
  readonly launchedAs: string | undefined;
  readonly versionsDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  if (input.launchedAs === undefined) return undefined;
  if (platform === "win32") {
    const shimPath = yield* findWindowsShim(input.launchedAs);
    if (shimPath === undefined) return undefined;
    const contents = yield* fs.readFileString(shimPath).pipe(Effect.option);
    const target = Option.isSome(contents) ? /^"([^"]+)"/m.exec(contents.value)?.[1] : undefined;
    return target !== undefined && launcherOwnsVersionsDir(path, input.versionsDir, target)
      ? shimPath
      : undefined;
  }
  const linkTarget = yield* fs.readLink(input.launchedAs).pipe(Effect.option);
  if (Option.isNone(linkTarget)) return undefined;
  const resolved = path.resolve(path.dirname(input.launchedAs), linkTarget.value);
  return launcherOwnsVersionsDir(path, input.versionsDir, resolved) ? input.launchedAs : undefined;
});

const planUninstall = Effect.fn("cli.uninstall.plan")(function* (input: {
  readonly baseDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const service = yield* BootService.BootService;
  const status = yield* service.status;
  const servesThisHome =
    status.installedBaseDir !== undefined &&
    path.resolve(status.installedBaseDir) === path.resolve(input.baseDir);
  const versionsDir = pinnedRuntimeVersionsDir(path, input.baseDir);
  const runtimeDir = path.dirname(versionsDir);
  const launchedAs = yield* resolveLaunchedAs;
  const plan: UninstallPlan = {
    service: status.supported && status.installed && servesThisHome,
    launcher: yield* findOwnedLauncher({ launchedAs, versionsDir }),
    runtimeDir: (yield* fs.exists(runtimeDir).pipe(Effect.orElseSucceed(() => false)))
      ? runtimeDir
      : undefined,
    userdataDir: path.join(input.baseDir, "userdata"),
  };
  return plan;
});

/**
 * Removes the runtime folder after this process exits, from a detached shell.
 * The shell, and the `ping` that waits, run by absolute path from System32,
 * never from the folder `uninstall` was started in. The folder reaches the
 * shell through the environment and is used inside quotes, so an `&` or `%`
 * in its name stays part of the name.
 */
export function spawnWindowsRuntimeRemoval(
  environment: NodeJS.ProcessEnv,
  runtimeDir: string,
  spawn: typeof NodeChildProcess.spawn = NodeChildProcess.spawn,
) {
  return spawn(
    windowsSystem32Path("cmd.exe", environment),
    [
      "/d",
      "/v:off",
      "/c",
      '""%STUDIO_UNINSTALL_PING%" -n 3 127.0.0.1 >nul & rmdir /s /q "%STUDIO_UNINSTALL_RUNTIME%""',
    ],
    {
      cwd: windowsSystem32Dir(environment),
      env: {
        ...environment,
        STUDIO_UNINSTALL_PING: windowsSystem32Path("PING.EXE", environment),
        STUDIO_UNINSTALL_RUNTIME: runtimeDir,
      },
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      // cmd.exe reads its own command line; Node's quoting would break the quotes above.
      windowsVerbatimArguments: true,
    },
  );
}

export const uninstallCommand = Command.make("uninstall", {
  ...projectLocationFlags,
  yes: Flag.Boolean("yes").pipe(
    Flag.withAlias("y"),
    Flag.withDescription(
      "Remove everything without asking. Required from a script, where there is no prompt.",
    ),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Remove specweave-studio from this machine: the background service, the launcher, and every downloaded version. Your projects and threads are kept.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);
      return yield* runUninstall({ baseDir: config.baseDir, assumeYes: flags.yes }).pipe(
        Effect.provide(CliService.layer(config)),
      );
    }),
  ),
);

const runUninstall = Effect.fn("cli.uninstall.run")(function* (input: {
  readonly baseDir: string;
  readonly assumeYes: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcessPlatform;
  const environment = yield* HostProcessEnvironment;
  const service = yield* BootService.BootService;
  const plan = yield* planUninstall({ baseDir: input.baseDir });

  if (!plan.service && plan.launcher === undefined && plan.runtimeDir === undefined) {
    yield* Console.log(
      `Nothing to remove: specweave-studio is not installed for ${input.baseDir}.`,
    );
    if (!(yield* HostProcessIsExecutable)) {
      yield* Console.log(
        "  This specweave-studio runs from a Node script, so it was installed by npm or built from source. Remove it the same way (`npm uninstall -g specweave-studio`, or delete the checkout).",
      );
    }
    // An earlier uninstall or a by-hand removal can leave the Terminal block behind.
    if (platform !== "win32") yield* removeTerminalCommands(input.baseDir);
    return;
  }

  yield* Console.log("This will remove:");
  if (plan.service) yield* Console.log("  the background service (stopping it first)");
  if (plan.launcher !== undefined) yield* Console.log(`  the launcher at ${plan.launcher}`);
  if (plan.runtimeDir !== undefined) {
    yield* Console.log(`  every downloaded version under ${plan.runtimeDir}`);
  }
  if (platform !== "win32") {
    yield* Console.log("  the SpecWithCode commands block in your Terminal startup file, if any");
  }
  yield* Console.log(
    `Your projects, threads, and settings under ${plan.userdataDir} are kept. Delete that directory yourself if you want them gone too.`,
  );

  if (!input.assumeYes) {
    if (!(process.stdin.isTTY && process.stdout.isTTY)) {
      return yield* new CliUninstallError({
        reason:
          "Not a terminal, so nothing was removed. Rerun with --yes to confirm from a script.",
      });
    }
    const confirmed = yield* Prompt.run(
      Prompt.Confirm({ message: "Remove specweave-studio from this machine?", initial: false }),
    ).pipe(Effect.catchTags({ QuitError: () => Effect.succeed(false) }));
    if (!confirmed) {
      yield* Console.log("Left as is.");
      return;
    }
  }

  if (plan.service) {
    yield* service.uninstall;
    yield* Console.log("Removed the background service.");
  }
  if (plan.launcher !== undefined) {
    yield* fs
      .remove(plan.launcher, { force: true })
      .pipe(
        Effect.mapError(
          () =>
            new CliUninstallError({ reason: `Could not remove the launcher at ${plan.launcher}.` }),
        ),
      );
    yield* Console.log(`Removed ${plan.launcher}.`);
  }
  if (plan.runtimeDir !== undefined) {
    // This process runs from inside runtimeDir. POSIX unlinks a running
    // executable fine; Windows refuses, so the tree is removed after this
    // process exits by a detached shell, and the user is told either way.
    if (platform === "win32") {
      const runtimeDir = plan.runtimeDir;
      yield* Effect.try({
        try: () => spawnWindowsRuntimeRemoval(environment, runtimeDir).unref(),
        catch: () =>
          new CliUninstallError({
            reason: `Could not schedule removal of ${runtimeDir}. Delete it yourself once this window is closed.`,
          }),
      });
      yield* Console.log(`${runtimeDir} will be removed once specweave-studio exits.`);
    } else {
      yield* fs
        .remove(plan.runtimeDir, { recursive: true, force: true })
        .pipe(
          Effect.mapError(
            () => new CliUninstallError({ reason: `Could not remove ${plan.runtimeDir}.` }),
          ),
        );
      yield* Console.log(`Removed ${plan.runtimeDir}.`);
    }
  }
  if (platform !== "win32") yield* removeTerminalCommands(input.baseDir);
  yield* Console.log("");
  yield* Console.log("specweave-studio is uninstalled. Thanks for trying SpecWithCode.");
});

/** The Terminal block and the commands folder it lists; a file that refused is named, not fatal. */
const removeTerminalCommands = Effect.fn("cli.uninstall.terminal_commands")(function* (
  baseDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const left = yield* Effect.tryPromise(() =>
    removeTerminalPathBlocks(NodeOS.homedir(), nodeTerminalPathFs),
  ).pipe(Effect.orElseSucceed(() => ["your Terminal startup file"]));
  for (const file of left) {
    yield* Console.log(
      `Could not edit ${file}. Delete the lines between "# >>> SpecWithCode commands >>>" and "# <<< SpecWithCode commands <<<" yourself.`,
    );
  }
  yield* fs
    .remove(terminalCommandsDir(baseDir), { recursive: true, force: true })
    .pipe(Effect.ignore);
  if (left.length === 0)
    yield* Console.log("No SpecWithCode commands block is left in your Terminal startup files.");
});
