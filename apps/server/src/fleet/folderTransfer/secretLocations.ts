// @effect-diagnostics nodeBuiltinImport:off - reads small project files and secret files in the home folder.
/**
 * Secret files a folder copy offers beyond the built-in list: the project's own
 * "Secret files" patterns and home paths, .NET user secrets that live in the home
 * folder, and hints for secrets a vault or keychain holds, which never travel.
 *
 * A home file is listed as `~/<home-relative path>`. Both machines refuse home
 * paths that hold sign-ins or start programs (`isHomeSecretPathRefused`).
 *
 * @module secretLocations
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { isHomeSecretPathRefused } from "../../workspace/WorkspaceSensitivePaths.ts";
import type { ManifestEntry } from "./manifest.ts";
import { isSafeRelativePath } from "./paths.ts";
import { MAX_SECRET_FILE_BYTES, MAX_SECRET_FILES } from "./secrets.ts";

export const MAX_SECRET_PATTERNS = 100;
export const MAX_SECRET_PATTERN_LENGTH = 512;
const HOME_PREFIX = "~/";
/** Files read from one home folder entry at most, so `~/.config` cannot list thousands. */
const MAX_FILES_PER_HOME_FOLDER = 100;
/** Project files read for a vault reference (`op://`) or a `UserSecretsId`. */
const MAX_PROBE_BYTES = 256 * 1024;
const MAX_PROBED_FILES = 200;

/** The home-relative part of a `~/` secret path, or null for a path inside the folder. */
export function homeSecretRelative(path: string): string | null {
  if (!path.startsWith(HOME_PREFIX)) return null;
  const relative = path.slice(HOME_PREFIX.length);
  return isSafeRelativePath(relative, "linux") && !isHomeSecretPathRefused(relative)
    ? relative
    : null;
}

/** True for a path the copy treats as a home file; a refused one is still not a folder path. */
export const isHomeSecretPath = (path: string) => path.startsWith(HOME_PREFIX);

const DOTNET_USER_SECRETS = ".microsoft/usersecrets/";
const WINDOWS_USER_SECRETS = "AppData/Roaming/Microsoft/UserSecrets/";
const DOTNET_USER_SECRETS_FILE =
  /^\.microsoft\/usersecrets\/[A-Za-z0-9._-]{1,200}\/secrets\.json$/u;

/**
 * The only home files a copy writes: .NET user secrets. Any other `~/` file is
 * listed for the person to copy, since a source could otherwise name a start-up
 * file the destination's refusal list misses.
 */
export const isDotnetUserSecretsFile = (homeRelative: string) =>
  DOTNET_USER_SECRETS_FILE.test(homeRelative) &&
  !homeRelative.split("/").some((part) => part === "." || part === "..");

/**
 * Where a home-relative secret lives on this platform. .NET user secrets are
 * listed by their Unix place (`.microsoft/usersecrets/<id>/secrets.json`) and kept
 * under `AppData/Roaming/Microsoft/UserSecrets` on Windows.
 */
export function platformHomePath(relative: string, platform: NodeJS.Platform): string {
  if (platform === "win32" && relative.toLowerCase().startsWith(DOTNET_USER_SECRETS))
    return `${WINDOWS_USER_SECRETS}${relative.slice(DOTNET_USER_SECRETS.length)}`;
  return relative;
}

/** Checks one "Secret files" entry: a pattern in the folder, or a `~/` home path. */
export function secretPatternProblem(pattern: string): string | null {
  const value = pattern.trim();
  if (value === "") return null;
  if (value.length > MAX_SECRET_PATTERN_LENGTH) return "is too long";
  if (value.startsWith(HOME_PREFIX)) {
    const relative = value.slice(HOME_PREFIX.length).replace(/\/+$/u, "");
    if (!isSafeRelativePath(relative, "linux")) return "is not a path in your home folder";
    if (isHomeSecretPathRefused(relative))
      return "holds sign-ins or start-up files and never travels";
    return null;
  }
  // A leading `/` anchors at the folder's top, as in `.gitignore`.
  if (/^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\") || value.startsWith("~"))
    return "must be inside the project folder, or start with ~/ for your home folder";
  if (value.split("/").includes("..")) return "cannot leave the project folder";
  return null;
}

/** The usable entries of a "Secret files" setting, trimmed and deduplicated. */
export function cleanSecretPatterns(patterns: ReadonlyArray<string> | undefined): Array<string> {
  return [
    ...new Set(
      (patterns ?? [])
        .map((pattern) => pattern.trim())
        .filter((pattern) => pattern !== "" && secretPatternProblem(pattern) === null),
    ),
  ].slice(0, MAX_SECRET_PATTERNS);
}

/** One glob as a regular expression: `*` within a name, `**` across folders, `?` one character. */
function globSource(glob: string): string {
  let out = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === "*" && glob[index + 1] === "*") {
      index += 1;
      if (glob[index + 1] === "/") {
        index += 1;
        out += "(?:.*/)?";
      } else out += ".*";
    } else if (char === "*") out += "[^/]*";
    else if (char === "?") out += "[^/]";
    else out += char.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  }
  return out;
}

/**
 * Matches folder paths against the project's patterns, like a `.gitignore` line:
 * a pattern without a slash matches a name at any depth, one with a slash matches
 * from the folder's top, and a trailing slash covers everything inside.
 */
export function secretPatternMatcher(
  patterns: ReadonlyArray<string> | undefined,
): (relative: string) => boolean {
  const sources = cleanSecretPatterns(patterns)
    .filter((pattern) => !pattern.startsWith(HOME_PREFIX))
    .map((pattern) => {
      const folder = pattern.endsWith("/");
      const body = pattern.replace(/^\/+|\/+$/gu, "");
      const anchored = pattern.startsWith("/") || body.includes("/");
      const source = globSource(body);
      return `${anchored ? "^" : "(?:^|/)"}${source}${folder ? "/.+" : "(?:/.+)?"}$`;
    });
  if (sources.length === 0) return () => false;
  const expression = new RegExp(sources.join("|"), "iu");
  return (relative) => expression.test(relative);
}

export interface HomeSecretFile {
  /** `~/<home-relative path>`, with forward slashes on every platform. */
  readonly path: string;
  readonly size: number;
}

export interface SecretHint {
  /** The file that shows where the secrets are kept. */
  readonly path: string;
  /** The keychain or vault holding them: "1Password", "Doppler", ".NET user secrets". */
  readonly source: string;
  readonly hint: string;
}

export interface SecretLocations {
  readonly homeFiles: ReadonlyArray<HomeSecretFile>;
  readonly hints: ReadonlyArray<SecretHint>;
}

/** Marker files of tools that keep secrets out of the folder. */
const VAULT_MARKERS: ReadonlyArray<{
  readonly name: RegExp;
  readonly source: string;
  readonly hint: string;
}> = [
  {
    name: /^\.?doppler\.ya?ml$/iu,
    source: "Doppler",
    hint: "Secrets stay in Doppler. Run doppler login on the other machine.",
  },
  {
    name: /^\.infisical\.json$/iu,
    source: "Infisical",
    hint: "Secrets stay in Infisical. Run infisical login on the other machine.",
  },
  {
    name: /^\.sops\.ya?ml$/iu,
    source: "SOPS",
    hint: "Encrypted files are copied as they are. The key that opens them (age, GPG or a cloud KMS) stays here.",
  },
  {
    name: /^\.envrc$/iu,
    source: "direnv",
    hint: "direnv can load secrets from a command or a vault. Run direnv allow on the other machine.",
  },
];

/** Reads a small regular file without following a link; null when it is gone, large or a link. */
async function readSmall(absolute: string, limit: number): Promise<string | null> {
  let handle: NodeFSP.FileHandle | null = null;
  try {
    handle = await NodeFSP.open(absolute, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) return null;
    return (await handle.readFile()).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/** A regular file's size, never through a link on any folder of its path. */
async function homeFileSize(home: string, relative: string): Promise<number | null> {
  const absolute = NodePath.join(home, relative);
  try {
    if ((await NodeFSP.realpath(NodePath.dirname(absolute))) !== NodePath.dirname(absolute))
      return null;
    const stat = await NodeFSP.lstat(absolute);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

/** The files of one home entry: the file itself, or a folder's files (links skipped). */
async function homeEntryFiles(
  home: string,
  relative: string,
  platform: NodeJS.Platform,
): Promise<Array<HomeSecretFile>> {
  const local = platformHomePath(relative, platform);
  const absolute = NodePath.join(home, local);
  let stat: NodeFS.Stats;
  try {
    stat = await NodeFSP.lstat(absolute);
  } catch {
    return [];
  }
  if (stat.isFile()) {
    const size = await homeFileSize(home, local);
    return size === null ? [] : [{ path: `${HOME_PREFIX}${relative}`, size }];
  }
  if (!stat.isDirectory()) return [];
  const result: Array<HomeSecretFile> = [];
  const visit = async (folder: string) => {
    let entries: Array<NodeFS.Dirent>;
    try {
      entries = await NodeFSP.readdir(NodePath.join(home, platformHomePath(folder, platform)), {
        withFileTypes: true,
      });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (result.length >= MAX_FILES_PER_HOME_FOLDER) return;
      const child = `${folder}/${entry.name}`;
      if (!isSafeRelativePath(child, "linux") || isHomeSecretPathRefused(child)) continue;
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) {
        const size = await homeFileSize(home, platformHomePath(child, platform));
        if (size !== null) result.push({ path: `${HOME_PREFIX}${child}`, size });
      }
    }
  };
  await visit(relative);
  return result;
}

const USER_SECRETS_ID = /<UserSecretsId>\s*([A-Za-z0-9._-]{1,200})\s*<\/UserSecretsId>/u;

/**
 * Finds the project's secrets outside the built-in list: its `~/` "Secret files"
 * entries, .NET user secrets named by a `.csproj` file's `UserSecretsId`, and the
 * vault references and marker files that say where other secrets are kept.
 */
export async function findSecretLocations(input: {
  readonly root: string;
  readonly entries: ReadonlyArray<Pick<ManifestEntry, "path" | "type" | "size" | "class">>;
  readonly patterns?: ReadonlyArray<string> | undefined;
  readonly home: string;
  readonly platform?: NodeJS.Platform;
}): Promise<SecretLocations> {
  const platform = input.platform ?? process.platform;
  // Every home path is checked against its real location, so a linked home (/var/home) is read as itself.
  const home = await NodeFSP.realpath(input.home).catch(() => input.home);
  const homeFiles = new Map<string, HomeSecretFile>();
  const hints: Array<SecretHint> = [];
  const add = (files: ReadonlyArray<HomeSecretFile>) => {
    for (const file of files) {
      if (homeFiles.size >= MAX_SECRET_FILES) return;
      if (file.size <= MAX_SECRET_FILE_BYTES && homeSecretRelative(file.path) !== null)
        homeFiles.set(file.path, file);
    }
  };
  for (const pattern of cleanSecretPatterns(input.patterns)) {
    if (!pattern.startsWith(HOME_PREFIX)) continue;
    for (const file of await homeEntryFiles(home, pattern.slice(2).replace(/\/+$/u, ""), platform))
      if (isDotnetUserSecretsFile(file.path.slice(HOME_PREFIX.length))) add([file]);
      else
        hints.push({
          path: file.path,
          source: "Home folder",
          hint: "Listed in Secret files. Copy it to the same place on the other machine yourself; a copy writes only .NET user secrets into the home folder.",
        });
  }
  let probed = 0;
  for (const entry of input.entries) {
    if (entry.type !== "file") continue;
    const name = entry.path.split("/").at(-1) ?? "";
    const marker = VAULT_MARKERS.find((item) => item.name.test(name));
    if (marker) hints.push({ path: entry.path, source: marker.source, hint: marker.hint });
    const csproj = /\.(?:cs|fs|vb)proj$/iu.test(name);
    const secret = entry.class === "secret";
    if ((!csproj && !secret) || entry.size > MAX_PROBE_BYTES || probed >= MAX_PROBED_FILES)
      continue;
    probed += 1;
    const text = await readSmall(NodePath.join(input.root, entry.path), MAX_PROBE_BYTES);
    if (text === null) continue;
    if (secret && text.includes("op://"))
      hints.push({
        path: entry.path,
        source: "1Password",
        hint: "Holds 1Password references (op://). The values stay in 1Password; sign in to the 1Password CLI on the other machine.",
      });
    const id = csproj ? USER_SECRETS_ID.exec(text)?.[1] : undefined;
    if (!id) continue;
    const relative = `${DOTNET_USER_SECRETS}${id}/secrets.json`;
    const found = await homeEntryFiles(home, relative, platform);
    if (found.length > 0) add(found);
    else
      hints.push({
        path: entry.path,
        source: ".NET user secrets",
        hint: `Uses user secrets ${id}, but this machine has none saved. Set them on the other machine with dotnet user-secrets.`,
      });
  }
  return { homeFiles: [...homeFiles.values()], hints: hints.slice(0, 50) };
}
