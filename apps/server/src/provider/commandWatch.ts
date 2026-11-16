/**
 * Notices an agent's command-line program appearing, changing or going away,
 * so a provider that is not installed is checked again without a click.
 *
 * The question asked every few seconds is a mark made from `stat` alone: the
 * saved command path, or the command's name in each folder the machine looks
 * in, plus the files a driver names beside it. No file is opened and nothing
 * is run. Only a changed mark leads to the real check.
 *
 * @module provider/commandWatch
 */
import * as NodeOS from "node:os";

import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import {
  readEnvPath,
  resolveKnownPosixCliDirs,
  resolveKnownWindowsCliDirs,
} from "@specweave-studio/shared/shell";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

export interface CommandProbe {
  /** The command as the driver runs it: a saved path, or a bare name. */
  readonly command: string;
  /** The environment the driver runs it with; its PATH is read at each use. */
  readonly environment: NodeJS.ProcessEnv;
  /**
   * Files beside the command that change when its program is installed or
   * repaired while the command itself stays the same (a launcher's version
   * note, for one).
   */
  readonly beside?: ReadonlyArray<string>;
}

export interface CommandMark {
  /** Changes whenever a file the command depends on appears, changes or goes. */
  readonly mark: string;
  /** The first place the command was found, as the machine would run it. */
  readonly path: string | undefined;
}

/** More folders than any real PATH has; a runaway PATH is not walked whole. */
const MAX_FOLDERS = 64;
/** Folders watched for one command. The mark still covers the rest. */
const MAX_WATCHED_FOLDERS = 16;

const WINDOWS_EXTENSIONS = [".COM", ".EXE", ".BAT", ".CMD"];

function windowsExtensions(environment: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const listed = (environment.PATHEXT ?? "")
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => (entry.startsWith(".") ? entry : `.${entry}`).toUpperCase());
  return listed.length > 0 ? [...new Set(listed)] : WINDOWS_EXTENSIONS;
}

function homeFolder(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const fromEnvironment =
    platform === "win32" ? environment.USERPROFILE?.trim() : environment.HOME?.trim();
  return fromEnvironment || NodeOS.homedir();
}

const separatorOf = (platform: NodeJS.Platform) => (platform === "win32" ? "\\" : "/");

function hasSeparator(command: string, platform: NodeJS.Platform): boolean {
  return command.includes("/") || (platform === "win32" && command.includes("\\"));
}

function folderOf(file: string, platform: NodeJS.Platform): string {
  const cut = Math.max(file.lastIndexOf("/"), platform === "win32" ? file.lastIndexOf("\\") : -1);
  return cut <= 0 ? file.slice(0, cut + 1) : file.slice(0, cut);
}

/** The file names one command can have: itself, or on Windows one per runnable extension. */
function commandNames(command: string, probe: CommandProbe, platform: NodeJS.Platform) {
  if (platform !== "win32") return [command];
  const extensions = windowsExtensions(probe.environment);
  const dot = command.lastIndexOf(".");
  const named = dot > Math.max(command.lastIndexOf("/"), command.lastIndexOf("\\"));
  if (named && extensions.includes(command.slice(dot).toUpperCase())) return [command];
  return extensions.map((extension) => `${command}${extension.toLowerCase()}`);
}

/** Every folder the machine would look in for a bare command, in its order. */
export function commandFolders(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): ReadonlyArray<string> {
  const delimiter = platform === "win32" ? ";" : ":";
  const onPath = (readEnvPath(environment) ?? "")
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"+|"+$/g, ""))
    .filter((entry) => entry.length > 0);
  // Read fresh each time: an installer may have made one of these since the server started.
  const known =
    platform === "win32"
      ? resolveKnownWindowsCliDirs(environment)
      : resolveKnownPosixCliDirs(environment, platform);
  const seen = new Set<string>();
  const folders: string[] = [];
  for (const folder of [...onPath, ...known]) {
    const key = platform === "win32" ? folder.toLowerCase() : folder;
    if (seen.has(key)) continue;
    seen.add(key);
    folders.push(folder);
    if (folders.length === MAX_FOLDERS) break;
  }
  return folders;
}

/**
 * Every file that could be this command, most preferred first. A command with
 * a folder in it is that one file; a bare name is looked for in each folder.
 */
export function commandCandidates(
  probe: CommandProbe,
  platform: NodeJS.Platform,
): ReadonlyArray<string> {
  const command = probe.command.trim();
  if (command.length === 0) return [];
  const separator = separatorOf(platform);
  if (command === "~" || command.startsWith("~/") || command.startsWith("~\\")) {
    const expanded = `${homeFolder(probe.environment, platform)}${separator}${command.slice(2)}`;
    return commandNames(expanded, probe, platform);
  }
  if (hasSeparator(command, platform)) return commandNames(command, probe, platform);
  const names = commandNames(command, probe, platform);
  return commandFolders(probe.environment, platform).flatMap((folder) =>
    names.map((name) => `${folder.replace(/[\\/]+$/, "")}${separator}${name}`),
  );
}

const statMark = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.stat(file);
    const changed = Option.match(info.mtime, {
      onNone: () => "",
      onSome: (time) => String(time.getTime()),
    });
    const node = Option.getOrElse(info.ino, () => 0);
    return { type: info.type, mark: `${Number(info.size)}:${changed}:${node}:${info.mode}` };
  }).pipe(Effect.orElseSucceed(() => undefined));

/**
 * The mark of one command, and where it was found. Never fails: a file that is
 * not there, or that cannot be read, is simply not part of the mark.
 */
export const commandMark = (
  probe: CommandProbe,
): Effect.Effect<CommandMark, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    const candidates = commandCandidates(probe, platform);
    const stats = yield* Effect.forEach(candidates, statMark, { concurrency: 16 });
    const found = candidates.flatMap((file, index) => {
      const stat = stats[index];
      return stat && stat.type === "File" ? [{ file, mark: stat.mark }] : [];
    });
    const separator = separatorOf(platform);
    // A command that is there and does not start is often a launcher whose
    // program is missing beside it. The folder's own stat changes when a
    // file is added to it or removed, so that program landing counts; the
    // files a driver names cover one rewritten in place.
    const folders = [...new Set(found.map(({ file }) => folderOf(file, platform)))];
    const besideFiles = [
      ...folders,
      ...folders.flatMap((folder) =>
        (probe.beside ?? []).map((name) => `${folder}${separator}${name}`),
      ),
    ];
    const besideStats = yield* Effect.forEach(besideFiles, statMark, { concurrency: 16 });
    const parts = [
      ...found.map(({ file, mark }) => `${file}=${mark}`),
      ...besideFiles.map((file, index) => `${file}=${besideStats[index]?.mark ?? "-"}`),
    ];
    return { mark: parts.length > 0 ? parts.join("|") : "none", path: found[0]?.file };
  });

/**
 * The folders worth watching for this command: the ones that exist, the
 * machine's usual installer folders first. A folder that does not exist yet
 * cannot be watched; the mark finds the command there once it does.
 */
export const commandWatchFolders = (
  probe: CommandProbe,
): Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const platform = yield* HostProcessPlatform;
    const folders = [
      ...new Set(commandCandidates(probe, platform).map((file) => folderOf(file, platform))),
    ].filter((folder) => folder.length > 0);
    const known = new Set(
      platform === "win32"
        ? resolveKnownWindowsCliDirs(probe.environment)
        : resolveKnownPosixCliDirs(probe.environment, platform),
    );
    const ordered = [
      ...folders.filter((folder) => known.has(folder)),
      ...folders.filter((folder) => !known.has(folder)),
    ];
    const exists = yield* Effect.forEach(
      ordered,
      (folder) =>
        fs.stat(folder).pipe(
          Effect.map((info) => info.type === "Directory"),
          Effect.orElseSucceed(() => false),
        ),
      { concurrency: 16 },
    );
    return ordered.filter((_, index) => exists[index]).slice(0, MAX_WATCHED_FOLDERS);
  });

/**
 * Runs `onChange` shortly after anything changes in one of `folders`, for as
 * long as the returned effect runs. It says only that something moved; the
 * caller reads the mark to learn whether it matters. Never fails: a folder
 * that cannot be watched is left to the mark.
 */
export const watchCommandFolders = (input: {
  readonly folders: ReadonlyArray<string>;
  readonly onChange: Effect.Effect<void>;
  readonly debounce?: Duration.Input;
}): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    if (input.folders.length === 0) return;
    const fs = yield* FileSystem.FileSystem;
    yield* Stream.mergeAll(
      input.folders.map((folder) => fs.watch(folder).pipe(Stream.catchCause(() => Stream.empty))),
      { concurrency: "unbounded" },
    ).pipe(
      Stream.debounce(Duration.fromInputUnsafe(input.debounce ?? "500 millis")),
      Stream.runForEach(() => input.onChange),
      Effect.ignoreCause({ log: true }),
    );
  });
