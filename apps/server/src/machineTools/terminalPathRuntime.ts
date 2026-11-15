// @effect-diagnostics nodeBuiltinImport:off - the login shell and home come from the OS account.
import * as NodeOS from "node:os";

import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import { runsOnGlibc } from "./machineTools.ts";
import { nodeTerminalPathFs, syncTerminalPath } from "./terminalPath.ts";

/** The person's login shell from the account database, else $SHELL. */
function loginShell(): string | undefined {
  try {
    const shell = NodeOS.userInfo().shell;
    if (shell) return shell;
  } catch {
    // no account entry: fall back to the environment
  }
  return process.env.SHELL;
}

/**
 * Keep the Terminal block in line with installs: once at start, then every two minutes, so a
 * tool first-run setup installs works in the next Terminal window. Off in tests and with
 * SPECWITHCODE_TERMINAL_PATH=off.
 */
export const keepTerminalCommandsReachable = (baseDir: string) =>
  Effect.gen(function* () {
    const env = process.env;
    if (env.VITEST || env.SPECWITHCODE_TERMINAL_PATH === "off") return;
    const once = Effect.tryPromise(() =>
      syncTerminalPath({
        home: NodeOS.homedir(),
        baseDir,
        // oxlint-disable-next-line studio/no-global-process-runtime -- the running machine itself.
        platform: process.platform,
        // oxlint-disable-next-line studio/no-global-process-runtime -- the running machine itself.
        arch: process.arch,
        glibc: runsOnGlibc(),
        shell: loginShell(),
        fs: nodeTerminalPathFs,
      }),
    ).pipe(
      Effect.tap((action) =>
        action === "added" || action === "updated" || action === "removed"
          ? Effect.logInfo("terminal commands path", { action })
          : Effect.void,
      ),
      Effect.catch((error) => Effect.logWarning("terminal commands path failed", { error })),
    );
    yield* once.pipe(Effect.repeat(Schedule.spaced("2 minutes")));
  });
