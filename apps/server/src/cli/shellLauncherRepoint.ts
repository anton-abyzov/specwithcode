import { HostProcessEnvironment, HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import type { ServerSelfUpdateOutcome } from "@specweave-studio/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { pinnedRuntimeVersionsDir } from "../cloud/pinnedRuntime.ts";
import { STUDIO_CLI_NAMES } from "./cliName.ts";
import { parseShellLauncher, readRegularFile, replaceRegularFile } from "./shellLauncher.ts";

/**
 * The `#!/bin/sh` launchers install.sh and the fleet installer write under both CLI names
 * (shellLauncher.ts) run node on a release's bin.mjs, not a symlink, so repointLauncher leaves
 * them. Each one on PATH or in ~/.local/bin that belongs to this home is rewritten to run the new
 * version's bin.mjs. It belongs here when its STUDIO_HOME, if it sets one, is this home, and its
 * entry is `<versionsDir>/<version>/bin.mjs`, or, for the fleet installer, a release in its own
 * HOME's release store while its STUDIO_HOME is this home: the store is shared by every identity.
 * Whole decoded operands are compared, never raw text.
 */
export const repointShellLaunchers = Effect.fn("cli.update.repoint_shell_launchers")(
  function* (input: {
    readonly baseDir: string;
    readonly versionsDir: string;
    readonly versionDir: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcessPlatform;
    const repointed: Array<string> = [];
    if (platform === "win32") return repointed;
    const environment = yield* HostProcessEnvironment;
    const home = environment["HOME"];
    const launchers = new Set<string>();
    for (const name of STUDIO_CLI_NAMES) {
      const onPath = yield* findCommandOnPath(name);
      if (onPath !== undefined) launchers.add(onPath);
      // Where the installers put them, for an update run over SSH without it on PATH.
      if (home !== undefined && path.isAbsolute(home)) {
        const installed = path.join(home, ".local", "bin", name);
        if (yield* fs.exists(installed).pipe(Effect.orElseSucceed(() => false)))
          launchers.add(installed);
      }
    }
    // Identity, not spelling: a home reached through a link (~/.specweave-studio pointing at
    // ~/.specwithcode) is the same home.
    const real = (location: string) =>
      fs.realPath(location).pipe(Effect.orElseSucceed(() => path.resolve(location)));
    const baseDir = yield* real(input.baseDir);
    const versionsDir = yield* real(input.versionsDir);
    const target = path.join(input.versionDir, "bin.mjs");
    for (const launcher of launchers) {
      const file = yield* Effect.promise(() => readRegularFile(launcher, 64 * 1024));
      if (file === undefined) continue;
      const parsed = parseShellLauncher(file.text);
      if (parsed === undefined) continue;
      const studioHome = parsed.environment.get("STUDIO_HOME");
      if (studioHome !== undefined && (yield* real(studioHome)) !== baseDir) continue;
      const entry = parsed.prefix.at(-1)!;
      const release = path.dirname(entry);
      const store = path.dirname(release);
      if (
        path.basename(entry) !== "bin.mjs" ||
        [".", ".."].includes(path.basename(release)) ||
        path.join(store, path.basename(release), "bin.mjs") !== entry
      )
        continue;
      const launcherHome = parsed.environment.get("HOME");
      const fleetStores =
        studioHome !== undefined && launcherHome !== undefined && path.isAbsolute(launcherHome)
          ? [
              path.join(launcherHome, ".specwithcode", "install", "releases"),
              path.join(launcherHome, ".local", "share", "specweave-studio", "releases"),
            ]
          : [];
      if ((yield* real(store)) !== versionsDir && !fleetStores.includes(store)) continue;
      if (entry === target) continue;
      if (!(yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false)))) continue;
      const next = parsed.render([...parsed.prefix.slice(0, -1), target]);
      // Best effort: a launcher this user cannot rewrite (a root-owned /usr/local/bin) must not
      // stop the update before the service switch.
      const written = yield* Effect.tryPromise(() => replaceRegularFile(launcher, next, file)).pipe(
        Effect.as(true),
        Effect.catch(() =>
          Console.log(
            `  Could not repoint the ${path.basename(launcher)} launcher at ${launcher}; it still runs the old version.`,
          ).pipe(Effect.as(false)),
        ),
      );
      if (written) repointed.push(launcher);
    }
    return repointed;
  },
);

/** The first file named `command` in a directory on this shell's PATH. */
export const findCommandOnPath = Effect.fn("cli.update.find_command_on_path")(function* (
  command: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const environment = yield* HostProcessEnvironment;
  const platform = yield* HostProcessPlatform;
  const delimiter = platform === "win32" ? ";" : ":";
  for (const directory of (environment["PATH"] ?? "").split(delimiter)) {
    if (directory.length === 0) continue;
    const candidate = path.join(directory, command);
    if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
      return candidate;
    }
  }
  return undefined;
});

/**
 * The service launcher switches activeVersion on its own for an update it was asked for (Update
 * now, `fleet update`, SpecWithCode Connect): the CLI's `update`, which repoints the shell
 * launchers itself, never runs. The server the launcher committed does it instead, once the
 * switch is durable, and again on every later start while service-state.json still records that
 * committed update, so a crash in between heals on the next start. Best effort: it only logs, and
 * never fails the server's startup.
 */
export const repointShellLaunchersAfterServiceUpdate = Effect.fn(
  "cli.update.repoint_shell_launchers_after_service_update",
)(function* (input: {
  readonly baseDir: string;
  readonly outcome: ServerSelfUpdateOutcome | undefined;
}) {
  const outcome = input.outcome;
  if (outcome?.status !== "committed") return [];
  const path = yield* Path.Path;
  const versionsDir = pinnedRuntimeVersionsDir(path, input.baseDir);
  return yield* repointShellLaunchers({
    baseDir: input.baseDir,
    versionsDir,
    versionDir: path.join(versionsDir, outcome.targetVersion),
  }).pipe(
    Effect.tap((repointed) =>
      repointed.length === 0
        ? Effect.void
        : Effect.logInfo("Repointed the shell launchers to the committed service version.", {
            targetVersion: outcome.targetVersion,
            launchers: repointed,
          }),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not repoint the shell launchers after the service update.", {
        targetVersion: outcome.targetVersion,
        cause,
      }).pipe(Effect.as<ReadonlyArray<string>>([])),
    ),
  );
});
