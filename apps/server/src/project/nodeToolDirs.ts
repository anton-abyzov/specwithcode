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

import { managedNodeDir, runsOnGlibc, toolPlatformKey } from "../machineTools/machineTools.ts";

export interface NodeToolDirsInput {
  readonly home: string;
  readonly platform: NodeJS.Platform;
  /** The running Node binary, whose folder holds its own `npx`. */
  readonly execPath?: string | undefined;
  readonly fnmDir?: string | undefined;
  readonly nvmDir?: string | undefined;
  readonly voltaHome?: string | undefined;
  readonly xdgDataHome?: string | undefined;
  /** The app's home, where first-run setup installs Node.js when the machine had none. */
  readonly studioHome?: string | undefined;
  /** The machine's CPU, for the folder of that install; the running process's by default. */
  readonly arch?: string | undefined;
  /** Linux only: whether its libc is glibc; the running process's by default. */
  readonly glibc?: boolean | undefined;
}

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/;

/**
 * The installed version nvm's default alias names, else the newest one.
 * `alias` is the text of `alias/default`: a version, a prefix of one (`22`),
 * or `node`, which means the newest. The caller follows named aliases first.
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

/**
 * Every installed nvm version, the default alias's first and the rest newest
 * first: a command installed under any of them is found, the default's wins.
 */
export function orderNvmVersions(
  installed: ReadonlyArray<string>,
  alias: string | null,
): ReadonlyArray<string> {
  const rest = [...installed];
  const ordered: Array<string> = [];
  for (let wanted = alias; ; wanted = null) {
    const next = pickNvmVersion(rest, wanted);
    if (next === null) return ordered;
    ordered.push(next);
    rest.splice(rest.indexOf(next), 1);
  }
}

const NVM_ALIAS_HOPS = 4;
/** An alias that names another alias file, such as `lts/*` or `lts/jod`. */
const NVM_ALIAS_NAME = /^[\w*-]+(\/[\w*-]+)?$/;

function managedNode(input: NodeToolDirsInput): ReadonlyArray<string> {
  if (!input.studioHome) return [];
  // oxlint-disable-next-line studio/no-global-process-runtime -- the running machine's own CPU.
  const arch = input.arch ?? process.arch;
  const key = toolPlatformKey(input.platform, arch, input.glibc ?? runsOnGlibc());
  return key === null ? [] : [managedNodeDir(input.studioHome, key)];
}

/** Folders to search after PATH: version managers, then the service's own Node. Missing ones are harmless. */
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
  const readAlias = (name: string) =>
    fs.readFileString(path.join(nvmHome, "alias", ...name.split("/"))).pipe(
      Effect.map((text) => text.trim()),
      Effect.orElseSucceed(() => null),
    );
  // `default` may name another alias (`lts/*` -> `lts/jod` -> `v22.20.0`); follow it to a version.
  let nvmAlias = windows ? null : yield* readAlias("default");
  for (let hop = 0; hop < NVM_ALIAS_HOPS && nvmAlias !== null && !/^v?\d/.test(nvmAlias); hop++) {
    nvmAlias = NVM_ALIAS_NAME.test(nvmAlias) ? yield* readAlias(nvmAlias) : null;
  }
  const nvm = windows
    ? []
    : orderNvmVersions(
        yield* fs.readDirectory(nvmVersions).pipe(Effect.orElseSucceed(() => [])),
        nvmAlias,
      ).map((version) => path.join(nvmVersions, version, "bin"));

  const dirs = [
    ...fnm,
    ...nvm,
    path.join(set(input.voltaHome)[0] ?? path.join(home, ".volta"), "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".asdf", "shims"),
    path.join(home, ".local", "share", "mise", "shims"),
    // The Node.js first-run setup installed: after the person's own, before the service's.
    ...managedNode(input),
    // Last: the person's own Node comes before the one this service runs on.
    ...(input.execPath && path.isAbsolute(input.execPath) ? [path.dirname(input.execPath)] : []),
  ];
  return [...new Set(dirs)] as ReadonlyArray<string>;
});
