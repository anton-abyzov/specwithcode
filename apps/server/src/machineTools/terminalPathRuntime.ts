// @effect-diagnostics nodeBuiltinImport:off - the login shell and home come from the OS account.
import * as NodeOS from "node:os";

import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";
import { runsOnGlibc } from "./machineTools.ts";
import {
  nodeTerminalPathFs,
  syncTerminalCommandLinks,
  syncTerminalPath,
} from "./terminalPath.ts";

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
 * Keep the commands folder and the Terminal block in line with installs and with "Use these
 * commands in Terminal": at start, every two minutes, and when the setting changes. A block the
 * person deleted turns the setting off. Off in tests and with SPECWITHCODE_TERMINAL_PATH=off.
 */
export const keepTerminalCommandsReachable = (baseDir: string) =>
  Effect.gen(function* () {
    const env = process.env;
    if (env.VITEST || env.SPECWITHCODE_TERMINAL_PATH === "off") return;
    const settings = yield* ServerSettings.ServerSettingsService;
    // Say what changed once, not every pass.
    let last: string | null = null;
    const input = () => ({
      home: NodeOS.homedir(),
      baseDir,
      // oxlint-disable-next-line studio/no-global-process-runtime -- the running machine itself.
      platform: process.platform,
      // oxlint-disable-next-line studio/no-global-process-runtime -- the running machine itself.
      arch: process.arch,
      glibc: runsOnGlibc(),
      shell: loginShell(),
      fs: nodeTerminalPathFs,
    });
    const once = Effect.gen(function* () {
      const enabled = (yield* settings.getSettings).terminalCommands;
      const action = yield* Effect.tryPromise(async () => {
        await syncTerminalCommandLinks(input());
        return syncTerminalPath({ ...input(), enabled });
      });
      if (action === "opted-out" && enabled) {
        yield* settings.updateSettings({ terminalCommands: false });
        yield* Effect.logInfo("terminal commands turned off: the block was deleted");
      }
      const changed = action !== last;
      last = action;
      if (changed && action !== "unchanged" && action !== "busy")
        yield* Effect.logInfo("terminal commands path", { action });
    }).pipe(
      Effect.catch((error) => {
        const changed = last !== "failed";
        last = "failed";
        return changed
          ? Effect.logWarning("terminal commands path failed", { error })
          : Effect.void;
      }),
    );
    // A flipped switch applies right away, not on the next two-minute pass.
    yield* settings.streamChanges.pipe(
      Stream.map((next) => next.terminalCommands),
      Stream.changesWith((previous, next) => previous === next),
      Stream.runForEach(() => once),
      Effect.forkScoped,
    );
    yield* once.pipe(Effect.repeat(Schedule.spaced("2 minutes")));
  });
