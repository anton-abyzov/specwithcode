/**
 * nodeToolDirs - where Node version managers keep `node`, `npx` and globally
 * installed commands. A service started by systemd or launchd gets a short
 * PATH without them, while a login shell adds them from its profile.
 *
 * @module nodeToolDirs
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export interface NodeToolDirsInput {
  readonly home: string;
  readonly platform: NodeJS.Platform;
  /** The running Node binary, whose folder holds its own `npx`. */
  readonly execPath?: string | undefined;
  readonly fnmDir?: string | undefined;
  readonly nvmDir?: string | undefined;
  readonly voltaHome?: string | undefined;
  readonly xdgDataHome?: string | undefined;
}

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/;

/**
 * The installed version nvm's default alias names, else the newest one.
 * `alias` is the text of `alias/default`: a version, a prefix of one (`22`),
 * or a name such as `node` or `lts/*`, which means the newest here.
 */
export function pickNvmVersion(
  installed: ReadonlyArray<string>,
  alias: string | null,
): string | null {
  const versions = installed
    .flatMap((name) => {
      const match = VERSION.exec(name);
      return match ? [{ name, parts: match.slice(1).map(Number) }] : [];
    })
    .toSorted(
      (a, b) => b.parts[0]! - a.parts[0]! || b.parts[1]! - a.parts[1]! || b.parts[2]! - a.parts[2]!,
    );
  const wanted = (alias ?? "").trim().replace(/^v/, "");
  const named = /^\d+(\.\d+){0,2}$/.test(wanted)
    ? versions.find(
        ({ name }) =>
          name.replace(/^v/, "") === wanted || name.replace(/^v/, "").startsWith(`${wanted}.`),
      )
    : undefined;
  return (named ?? versions[0])?.name ?? null;
}

/** Folders to search after PATH, most specific first. Missing ones are harmless. */
export const nodeToolDirs = Effect.fn("nodeToolDirs")(function* (input: NodeToolDirsInput) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { home } = input;
  const windows = input.platform === "win32";
  const set = (value: string | undefined) => (value && path.isAbsolute(value) ? [value] : []);

  const fnmHomes = [
    ...set(input.fnmDir),
    ...set(input.xdgDataHome).map((dir) => path.join(dir, "fnm")),
    path.join(home, ".local", "share", "fnm"),
    path.join(home, "Library", "Application Support", "fnm"),
    path.join(home, ".fnm"),
  ];
  // fnm's default alias links to an installation: `bin` holds the commands, except on Windows.
  const fnm = fnmHomes.map((dir) =>
    windows ? path.join(dir, "aliases", "default") : path.join(dir, "aliases", "default", "bin"),
  );

  const nvmHome = set(input.nvmDir)[0] ?? path.join(home, ".nvm");
  const nvmVersions = path.join(nvmHome, "versions", "node");
  const nvmVersion = windows
    ? null
    : pickNvmVersion(
        yield* fs.readDirectory(nvmVersions).pipe(Effect.orElseSucceed(() => [])),
        yield* fs
          .readFileString(path.join(nvmHome, "alias", "default"))
          .pipe(Effect.orElseSucceed(() => null)),
      );

  const dirs = [
    ...(input.execPath && path.isAbsolute(input.execPath) ? [path.dirname(input.execPath)] : []),
    ...fnm,
    ...(nvmVersion === null ? [] : [path.join(nvmVersions, nvmVersion, "bin")]),
    path.join(set(input.voltaHome)[0] ?? path.join(home, ".volta"), "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".asdf", "shims"),
    path.join(home, ".local", "share", "mise", "shims"),
  ];
  return [...new Set(dirs)] as ReadonlyArray<string>;
});
