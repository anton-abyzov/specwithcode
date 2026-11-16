// @effect-diagnostics nodeBuiltinImport:off - the login shell and home come from the OS account.
import * as NodeOS from "node:os";

import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
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
 * person deleted turns the setting off; turning it back on adds the block again. Passes run one
 * at a time, each reading the setting it applies. Off in tests and with
 * SPECWITHCODE_TERMINAL_PATH=off.
 */
export const keepTerminalCommandsReachable = (baseDir: string) =>
  Effect.gen(function* () {
    const env = process.env;
    if (env.VITEST || env.SPECWITHCODE_TERMINAL_PATH === "off") return;
    const settings = yield* ServerSettings.ServerSettingsService;
    const oneAtATime = yield* Semaphore.make(1);
    // Say what changed once, not every pass.
    let last: string | null = null;
    // Turned on since the last pass that got through: a block deleted earlier comes back.
    let rearm = false;
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
    const pass = Effect.gen(function* () {
      const enabled = (yield* settings.getSettings).terminalCommands;
      const rearming = enabled && rearm;
      const action = yield* Effect.tryPromise(async () => {
        if (enabled) await syncTerminalCommandLinks(input());
        return syncTerminalPath({ ...input(), enabled, rearm: rearming });
      });
      if (action !== "busy") rearm = false;
      // The record still names the file, so a failed write here is retried on the next pass.
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
    const once = oneAtATime.withPermits(1)(pass);
    // A flipped switch applies right away, not on the next two-minute pass.
    let previous = (yield* settings.getSettings).terminalCommands;
    yield* settings.streamChanges.pipe(
      Stream.runForEach((next) => {
        const turnedOn = !previous && next.terminalCommands;
        const flipped = previous !== next.terminalCommands;
        previous = next.terminalCommands;
        if (turnedOn) rearm = true;
        return flipped ? once : Effect.void;
      }),
      Effect.forkScoped,
    );
    yield* once.pipe(Effect.repeat(Schedule.spaced("2 minutes")));
  });
