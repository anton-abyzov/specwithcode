// @effect-diagnostics nodeBuiltinImport:off
/**
 * WorkspaceSensitivePaths - files no workspace read or write may touch.
 *
 * Reads accept absolute host paths and any client-chosen workspace root, so a
 * client granted only file access could otherwise open the app's secret store,
 * its settings, its backups and the owner's CLI credentials, or write a login
 * hook. Callers check both the path as requested and its realpath, which also
 * refuses symlinks into the list and protected paths that became symlinks after
 * startup.
 *
 * App state is refused by shape, not by list: wherever a `.specwithcode` or
 * `.specweave-studio` folder appears in a path (the owner's home, a sibling
 * `<identity>` install, or an instance home a worker made inside a checkout), and
 * under the server's base folder (unless that folder holds the user's home), its
 * `userdata`/`dev` state folders, fleet file, backups and database copies are
 * refused. Reads keep the state subfolders
 * clients legitimately open (attachments, screenshots, themes, mods, built-in
 * browser downloads, logs other than terminal and provider logs, Antigravity's
 * plans and screenshots, and Codex shadow-home transcripts). Writes also
 * refuse the service runtime, the release store, `launch.sh` and
 * `installation.json`, the CLI wrappers, common shell start-up files (fish and
 * systemd `environment.d` included), everything under a
 * `.git` folder or named `.git`, login items and provider config files. On macOS
 * every path under `/.vol` (files named by device and inode) is refused.
 *
 * @module WorkspaceSensitivePaths
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { HostProcessEnvironment, HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";

/** The home whose credential files are protected; tests point it at a temp folder. */
export const SensitivePathsHomeDirectory = Context.Reference<string>(
  "specweave-studio/workspace/SensitivePathsHomeDirectory",
  { defaultValue: () => NodeOS.homedir() },
);

/** How long protected file identities are reused before they are read again; tests use 0. */
export const SensitivePathsIdentityCacheMillis = Context.Reference<number>(
  "specweave-studio/workspace/SensitivePathsIdentityCacheMillis",
  { defaultValue: () => 5_000 },
);

export type SensitiveAccess = "read" | "write";

export interface SensitivePathRoots {
  readonly baseDir: string;
  readonly stateDir: string;
  readonly secretsDir: string;
  readonly settingsPath: string;
  readonly dbPath: string;
  readonly homeDir: string;
  /** The server's environment, for provider homes moved by CODEX_HOME and friends. */
  readonly environment?: NodeJS.ProcessEnv;
  /** How long protected identities are reused; 5 seconds unless set. */
  readonly identityCacheMillis?: number;
  /** Worktree folders (the server's and the settings'); project files, never app state. */
  readonly worktreesDirectories?: ReadonlyArray<string>;
}

/**
 * Folder names that hold app homes. Wherever one appears in a path, even inside a
 * checkout (an instance home a test or worker made in a project), what follows it
 * is checked as `<root>` and `<root>/<identity>`.
 */
const APP_HOME_SEGMENTS = new Set([".specwithcode", ".specweave-studio"]);

/** Names of state folders inside an app home. */
const STATE_DIRECTORY_NAMES = new Set(["userdata", "dev"]);

/**
 * State subfolders a read may open: user attachments, screenshots, logs, themes,
 * mods, and the temp folder Antigravity agents get as TMPDIR.
 */
const READABLE_STATE_SUBDIRECTORIES = new Set([
  "antigravity-tmp",
  "attachments",
  "browser-artifacts",
  "snap-shots",
  "logs",
  "themes",
  "mods",
]);

/** Provider homes the app keeps in its state folder (Antigravity profiles, Codex shadow homes). */
const PROVIDERS_STATE_DIRECTORY = "providers";

/** Codex shadow home folders a read may open, as in `~/.codex`; never its `auth.json` or `config.toml`. */
const CODEX_SHADOW_READABLE_DIRECTORIES = new Set([
  "sessions",
  "archived_sessions",
  "memories",
  "log",
  "logs",
]);

type SegmentMatch = (segment: string) => boolean;
const anySegment: SegmentMatch = () => true;
const exactly =
  (name: string): SegmentMatch =>
  (segment) =>
    segment === name;

/**
 * Agent output under `<state>/providers` that people open, reads only: the plans,
 * walkthroughs and screenshots Antigravity writes under its profile's
 * `antigravity-acp/brain/<session>/`, and a Codex instance's shadow home
 * transcripts. The rest of a profile (Google sign-ins, Codex `auth.json`) stays refused.
 */
const READABLE_PROVIDER_STATE_PATHS: ReadonlyArray<ReadonlyArray<SegmentMatch>> = [
  [exactly("antigravity"), anySegment, exactly("antigravity-acp"), exactly("brain")],
  [
    exactly("codex"),
    anySegment,
    exactly("shadow"),
    (segment) => CODEX_SHADOW_READABLE_DIRECTORIES.has(segment),
  ],
];

/** True for a path strictly inside one of the readable provider folders, relative to `<state>/providers`. */
const isReadableProviderStatePath = (segments: ReadonlyArray<string>) =>
  READABLE_PROVIDER_STATE_PATHS.some(
    (pattern) =>
      segments.length > pattern.length &&
      pattern.every((matches, index) => matches(segments[index]!)),
  );

/** Log folders that replay terminal output and provider traffic; reading them needs more than file access. */
const PROTECTED_LOG_SUBDIRECTORIES = new Set(["terminals", "provider"]);

/**
 * The built-in browser's folder: agents link the files it downloads, so
 * `downloads` may be read; its `profiles` hold saved sign-ins and stay refused.
 */
const SERVER_BROWSER_DIRECTORY = "server-browser";
const SERVER_BROWSER_DOWNLOADS = "downloads";

const FLEET_CONFIG_FILE = "studio-fleet.json";

/**
 * Files at the top of an app or identity home that the service runs or trusts:
 * the LaunchAgent runs `launch.sh`, and the installer and updater read
 * `installation.json`. Writes only.
 */
const HOME_LEVEL_WRITE_DENIED_FILES = new Set(["launch.sh", "installation.json"]);

/** The release store and update agent under an app home (`~/.specwithcode/install`). Writes only. */
const INSTALL_DIRECTORY = "install";

/** The `studio` CLI wrappers the installer puts in `~/.local/bin`. Writes only. */
const CLI_WRAPPER_DIRECTORY = ".local/bin";
const isCliWrapperName = (name: string) => /^(specweave-studio|specwithcode)(-.+)?$/.test(name);

/**
 * Machine handoffs check a received worktree out under
 * `<state>/machine-handoffs/git/<operation>/` and register it as a project root,
 * so files there are project files. The retained `context-<operation>` file the
 * launch prompt points at may be read.
 */
const MACHINE_HANDOFFS_DIRECTORY = "machine-handoffs";

/** Project folders inside an app home; never mistaken for an identity home. */
const PROJECT_DIRECTORIES = new Set(["worktrees", "projects", "scratch"]);

/** Folders under the home whose whole contents are refused. */
const HOME_DENIED_DIRECTORIES = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".azure",
  ".kube",
  ".config/gcloud",
  ".config/github-copilot",
  // Wrangler's OAuth token, wherever its version keeps it.
  "Library/Preferences/.wrangler/config",
  ".wrangler/config",
  ".config/.wrangler/config",
] as const;

/** Single files under the home that hold tokens or keys. */
const HOME_DENIED_FILES = [
  ".claude.json",
  ".local/share/opencode/auth.json",
  ".pi/agent/auth.json",
  ".docker/config.json",
  ".npmrc",
  ".netrc",
  ".git-credentials",
  ".config/git/credentials",
  ".pypirc",
  ".config/gh/hosts.yml",
  // Source-control CLIs the server drives: forgejo-cli, glab and tea keep tokens here.
  "Library/Application Support/forgejo-cli.forgejo-cli/keys.json",
  "Library/Application Support/Cyborus.forgejo-cli/keys.json",
  ".local/share/forgejo-cli/keys.json",
  "AppData/Roaming/forgejo-cli/forgejo-cli/data/keys.json",
  "AppData/Roaming/Cyborus/forgejo-cli/data/keys.json",
  ".config/glab-cli/config.yml",
  "Library/Application Support/glab-cli/config.yml",
  "AppData/Roaming/glab-cli/config.yml",
  "AppData/Local/glab-cli/config.yml",
  ".config/tea/config.yml",
  "Library/Application Support/tea/config.yml",
  "AppData/Local/tea/config.yml",
  ".tea/tea.yml",
  ".config/configstore/firebase-tools.json",
  ".terraform.d/credentials.tfrc.json",
  ".cargo/credentials.toml",
  ".cargo/credentials",
  ".vault-token",
  ".config/rclone/rclone.conf",
] as const;

/**
 * Files under the home that run code or change how agents start, including the
 * common shell start-up files: writes only.
 */
const HOME_WRITE_DENIED_FILES = [
  ".zshrc",
  ".zprofile",
  ".zshenv",
  ".zlogin",
  ".zlogout",
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".bash_logout",
  ".profile",
  ".gitconfig",
  ".config/git/config",
] as const;

/**
 * Folders under the home whose contents start programs at login or that the app
 * runs: login items, fish start-up files, systemd user environment files, provider
 * binaries SpecWeave installs and the legacy release store. Writes only.
 */
const HOME_WRITE_DENIED_DIRECTORIES = [
  "Library/LaunchAgents",
  ".config/autostart",
  ".config/fish",
  ".config/environment.d",
  ".local/share/specweave/providers",
  ".local/share/specweave-studio",
] as const;

/** Provider homes at their default places. */
const DEFAULT_PROVIDER_HOMES = [
  ".codex",
  ".claude",
  ".grok",
  ".gemini",
  ".cursor",
  ".config/cursor",
] as const;

/** Where SpecWeave keeps provider account profiles; credential files inside are refused at any depth. */
const ACCOUNT_PROFILES_DIRECTORY = ".local/share/specweave/account-profiles";

/** Credential files a provider keeps in its home, wherever settings or env move it. */
const PROVIDER_HOME_CREDENTIAL_FILES = new Set([
  "auth.json",
  ".credentials.json",
  ".claude.json",
  "oauth_creds.json",
  "mcp-oauth-tokens.json",
]);

/** Key and keystore names that hold private material wherever they sit in a project. */
const PROJECT_KEY_FILE =
  /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|.+\.(?:pem|key|p12|pfx|p8|keystore|jks))$/i;

/**
 * Templates that ship next to real env files and hold placeholders, not values:
 * `.env.example`, `.env.sample`, `.env.template`, `.env.dist`, `.env.defaults`.
 */
const ENV_TEMPLATE_FILE =
  /^\.env(?:\..+)?\.(?:example|sample|template|tmpl|dist|defaults)$|^\.env\.(?:example|sample|template|tmpl|dist|defaults)(?:\..+)?$/i;

/**
 * Per-stack config files that usually hold connection strings, API keys or
 * signing passwords and are kept out of Git for that reason. Only files Git does
 * not track reach this check in a folder copy: a tracked `appsettings.json` is
 * already in the repository.
 */
const STACK_SECRET_FILE = new RegExp(
  [
    // .NET: environment and local overrides, user secrets, publish profiles.
    String.raw`appsettings(?:\..+)?\.json`,
    String.raw`secrets\.json`,
    String.raw`connectionstrings\.config`,
    String.raw`.+\.publishsettings`,
    String.raw`.+\.pubxml\.user`,
    // Java, Kotlin and Spring: profile overrides and signing properties.
    String.raw`application-(?:local|dev|development|prod|production|secret|secrets)\.(?:properties|ya?ml)`,
    String.raw`(?:keystore|key|signing|secrets?)\.properties`,
    String.raw`local\.properties`,
    // Cloudflare Workers, Rails, Streamlit, Terraform, Kubernetes, Google and Firebase.
    String.raw`\.dev\.vars(?:\..+)?`,
    String.raw`master\.key`,
    String.raw`secrets\.(?:toml|ya?ml|env|ini|conf)`,
    String.raw`.+\.tfvars(?:\.json)?`,
    String.raw`terraform\.tfstate(?:\.backup)?`,
    String.raw`kubeconfig(?:\..+)?`,
    String.raw`(?:service[-_]?account|client[-_]?secret|credentials?)(?:[-_.].+)?\.json`,
    // Generic secret stores and password files.
    String.raw`\.secrets?`,
    String.raw`.+\.secrets?`,
    String.raw`\.htpasswd`,
    String.raw`\.pgpass`,
    String.raw`\.my\.cnf`,
    String.raw`\.s3cfg`,
    String.raw`\.boto`,
  ]
    .map((pattern) => `^(?:${pattern})$`)
    .join("|"),
  "i",
);

/**
 * True when a file inside a project folder looks like a credential: any `.env*`
 * file (`.env`, `.env.local`, `.envrc`, `.env-prod`) except a template such as
 * `.env.example`, a private key, or a file the home lists above refuse (`.npmrc`,
 * `.netrc`, `.docker/config.json`, provider `auth.json` and the like) at any depth.
 * A folder copy leaves these out unless the person ticks them one by one.
 */
export function isSecretLikeProjectPath(relativePath: string): boolean {
  const parts = relativePath.split("/");
  const name = parts.at(-1) ?? "";
  const env = /(?:^\.env|\.env(?:\.|$))/i.exec(name);
  if (env) return !ENV_TEMPLATE_FILE.test(name.slice(env.index));
  if (PROJECT_KEY_FILE.test(name) || PROVIDER_HOME_CREDENTIAL_FILES.has(name)) return true;
  const suffixMatches = (listed: string) =>
    relativePath === listed || relativePath.endsWith(`/${listed}`);
  if (HOME_DENIED_FILES.some(suffixMatches)) return true;
  return HOME_DENIED_DIRECTORIES.some((directory) => {
    const depth = directory.split("/").length;
    for (let end = depth; end < parts.length; end += 1)
      if (parts.slice(end - depth, end).join("/") === directory) return true;
    return false;
  });
}

/**
 * True for a per-stack config file that usually holds secrets when Git does not
 * track it: .NET `appsettings*.json` and `secrets.json`, Spring profile overrides,
 * signing properties, Cloudflare `.dev.vars`, Rails `master.key`, Terraform
 * variables and state, kubeconfig and service-account JSON. Callers apply it only
 * to untracked or ignored files: a tracked `appsettings.json` is ordinary work.
 */
export function isUntrackedSecretConfigPath(relativePath: string): boolean {
  return STACK_SECRET_FILE.test(relativePath.split("/").at(-1) ?? "");
}

/** A provider config file in its home that changes what the agent runs (hooks, MCP servers). */
const isProviderConfigFile = (name: string) =>
  name === "config.toml" ||
  name === "settings.json" ||
  name === "mcp.json" ||
  /^settings\..+\.json$/.test(name);

/**
 * Git metadata is never written. The server runs git in every project, and much
 * of `.git` makes git run programs: config (`core.fsmonitor`, filters, diff
 * drivers), hooks, attributes, and the `.git` file, `commondir` and `gitdir` of
 * a linked worktree, which can point git at a planted repository whose config
 * does. A name that is `.git`, or any path under one, is refused. NTFS drops
 * trailing dots and spaces and reads `name:stream` as `name`, so Windows strips
 * them first.
 */
const isGitSegment = (platform: NodeJS.Platform) =>
  platform === "win32"
    ? (segment: string) => segment.split(":", 1)[0]!.replace(/[. ]+$/, "") === ".git"
    : (segment: string) => segment === ".git";

/** At most this many entries of one protected folder are stat'ed for hard links. */
const IDENTITY_FOLDER_FILE_LIMIT = 128;

/**
 * Write-only folders hold programs a few levels down (`runtime/versions/<v>/`,
 * `providers/<name>/`): their files are listed this deep, up to this many each.
 */
const WRITE_IDENTITY_FOLDER_DEPTH = 4;
const WRITE_IDENTITY_FOLDER_FILE_LIMIT = 512;

/** macOS exposes the data volume a second time under this firmlink prefix. */
const DARWIN_DATA_VOLUME_PREFIX = "/system/volumes/data/";

/**
 * macOS volfs: `/.vol/<device>/<inode>/...` opens any file by number, and no
 * realpath resolves it, so no name rule could ever see where it leads.
 */
const DARWIN_VOLFS_ROOT = "/.vol";

/** Stats and folder listings the identity enumeration runs at once. */
const IDENTITY_IO_CONCURRENCY = 32;

/** Environment variables that move a provider's home. */
const PROVIDER_HOME_VARIABLES = ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "GROK_HOME"] as const;

/** Stats of paths already looked at during one request, shared across its checks. */
export type IdentityStatCache = Map<string, Promise<NodeFS.BigIntStats | null>>;

export interface SensitivePathGuard {
  /**
   * True when `candidatePath` must not be read (or written). Purely lexical: pass
   * both the requested path and its realpath.
   */
  readonly isDenied: (candidatePath: string, access?: SensitiveAccess) => boolean;
  /** Replaces the provider homes taken from settings; their credential and config files are refused. */
  readonly setProviderHomes: (homes: ReadonlyArray<string>) => void;
  /**
   * Replaces the worktree folders taken from settings. A worktree folder inside an
   * app home holds projects, so a repository named `dev` or `backups` there is not
   * app state.
   */
  readonly setWorktreesDirectories: (directories: ReadonlyArray<string>) => void;
  /**
   * True when the resolved path (from `realpathNative`) is, or sits inside, a
   * protected file or folder by device and inode. Backs up the name rules: it
   * catches spellings a file system treats as equal and hard links to protected
   * files. With `write`, the write-only locations (login items, launchers,
   * provider config files and the like) count too.
   */
  readonly matchesProtectedIdentity: (
    resolvedPath: string,
    statCache?: IdentityStatCache,
    access?: SensitiveAccess,
  ) => Promise<boolean>;
  /**
   * True when an open file (its `fstat`) is a protected file by device and inode,
   * so a path swapped between the check and the open is still caught.
   */
  readonly isProtectedFileIdentity: (stat: NodeFS.BigIntStats) => Promise<boolean>;
  /**
   * True when `folderPath` is, or sits inside, a folder refused as a whole (the
   * secret store, `~/.ssh` and the like). Purely lexical, like `isDenied`.
   */
  readonly isInsideDeniedFolder: (folderPath: string) => boolean;
}

/**
 * The on-disk spelling of a path. Node's JS `fs.realpath` keeps the caller's
 * spelling, so on case-insensitive APFS `~/.SSH` or `~/.ſsh` (U+017F) would come
 * back unchanged; the native call returns `~/.ssh`.
 */
const nativeRealpath = (target: string): Promise<string> =>
  new Promise((resolve, reject) =>
    NodeFS.realpath.native(target, (error, resolved) =>
      error ? reject(error) : resolve(resolved),
    ),
  );

const isMissingPathError = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/**
 * The realpath every guard caller uses. On Windows the native call fails on some
 * volumes (RAM disks, ImDisk and VeraCrypt mounts give EISDIR, EPERM or UNKNOWN),
 * so any failure other than a missing path is retried with Node's JS realpath.
 * When both fail the error stands, and callers refuse the path.
 */
export function makeRealpath(
  windows: boolean,
  native: (target: string) => Promise<string> = nativeRealpath,
  fallback: (target: string) => Promise<string> = (target) => NodeFSP.realpath(target),
): (target: string) => Promise<string> {
  if (!windows) return native;
  return async (target) => {
    try {
      return await native(target);
    } catch (error) {
      if (isMissingPathError(error)) throw error;
      return fallback(target);
    }
  };
}

// Node's path module is the Windows one exactly when the server runs on Windows.
export const realpathNative = makeRealpath(NodePath.sep === "\\");

/** The synchronous form, for building the guard; same Windows fallback. */
function realpathNativeSync(target: string, platform: NodeJS.Platform): string {
  try {
    return NodeFS.realpathSync.native(target);
  } catch (error) {
    if (platform !== "win32" || isMissingPathError(error)) throw error;
    return NodeFS.realpathSync(target);
  }
}

/** Resolves a path for the guard's callers; tests replace it to make a realpath fail. */
export const SensitivePathsRealpath = Context.Reference<(target: string) => Promise<string>>(
  "specweave-studio/workspace/SensitivePathsRealpath",
  { defaultValue: () => realpathNative },
);

/** Runs at most `max` tasks at once, in the order they arrive. */
function makeLimiter(max: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return <A>(task: () => Promise<A>) =>
    new Promise<A>((resolve, reject) => {
      const run = () => {
        active++;
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            waiting.shift()?.();
          });
      };
      if (active < max) run();
      else waiting.push(run);
    });
}

const identityKey = (stat: NodeFS.BigIntStats) => `${stat.dev}:${stat.ino}`;
const statIdentity = (target: string) => NodeFSP.stat(target, { bigint: true }).catch(() => null);
const listDirectory = (directory: string) =>
  NodeFSP.readdir(directory, { withFileTypes: true }).catch(() => [] as Array<NodeFS.Dirent>);

/** The key `matchesProtectedIdentity` files the target's own stat under in a stat cache. */
export const identityStatCacheKey = (resolvedPath: string) => NodePath.resolve(resolvedPath);

/**
 * Resolves symlinks in the longest existing prefix of `target`, so a protected
 * path that does not exist yet still compares equal to the realpath it will have
 * (macOS temp folders live behind `/var -> /private/var`). Runs only while the
 * guard is built or provider homes change, never per request.
 */
function canonicalize(target: string, platform: NodeJS.Platform): string {
  const missing: Array<string> = [];
  let current = NodePath.resolve(target);
  for (;;) {
    try {
      const real = realpathNativeSync(current, platform);
      return missing.length === 0 ? real : NodePath.join(real, ...[...missing].reverse());
    } catch {
      const parent = NodePath.dirname(current);
      if (parent === current) return NodePath.resolve(target);
      missing.push(NodePath.basename(current));
      current = parent;
    }
  }
}

const expandHome = (value: string, homeDir: string) =>
  value === "~"
    ? homeDir
    : value.startsWith("~/") || value.startsWith("~\\")
      ? NodePath.join(homeDir, value.slice(2))
      : value;

const isAncestorOrSelf = (ancestor: string, target: string) => {
  const relative = NodePath.relative(ancestor, target);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
};

/** Provider homes and credential files named by the server's environment. */
function environmentProviderPaths(environment: NodeJS.ProcessEnv, homeDir: string) {
  const homes: Array<string> = [];
  const files: Array<string> = [];
  for (const name of PROVIDER_HOME_VARIABLES) {
    const value = environment[name]?.trim();
    if (value) homes.push(expandHome(value, homeDir));
  }
  const xdgConfig = environment.XDG_CONFIG_HOME?.trim();
  if (xdgConfig) {
    const root = expandHome(xdgConfig, homeDir);
    homes.push(NodePath.join(root, "cursor"));
    files.push(
      NodePath.join(root, "gh", "hosts.yml"),
      NodePath.join(root, "glab-cli", "config.yml"),
      NodePath.join(root, "tea", "config.yml"),
    );
  }
  const xdgData = environment.XDG_DATA_HOME?.trim();
  if (xdgData) {
    const root = expandHome(xdgData, homeDir);
    files.push(
      NodePath.join(root, "opencode", "auth.json"),
      NodePath.join(root, "forgejo-cli", "keys.json"),
    );
  }
  const appData = environment.APPDATA?.trim();
  if (appData) {
    homes.push(NodePath.join(appData, "Cursor"));
    files.push(
      NodePath.join(appData, "forgejo-cli", "forgejo-cli", "data", "keys.json"),
      NodePath.join(appData, "Cyborus", "forgejo-cli", "data", "keys.json"),
      NodePath.join(appData, "glab-cli", "config.yml"),
    );
  }
  const localAppData = environment.LOCALAPPDATA?.trim();
  if (localAppData) {
    files.push(
      NodePath.join(localAppData, "glab-cli", "config.yml"),
      NodePath.join(localAppData, "tea", "config.yml"),
    );
  }
  const ghConfig = environment.GH_CONFIG_DIR?.trim();
  if (ghConfig) files.push(NodePath.join(expandHome(ghConfig, homeDir), "hosts.yml"));
  const glabConfig = environment.GLAB_CONFIG_DIR?.trim();
  if (glabConfig) files.push(NodePath.join(expandHome(glabConfig, homeDir), "config.yml"));
  return { homes, files };
}

export function makeSensitivePathGuard(
  roots: SensitivePathRoots,
  platform: NodeJS.Platform = process.platform,
): SensitivePathGuard {
  // APFS and NTFS default to case-insensitive names, so `~/.SSH` is `~/.ssh`. APFS
  // also folds the full Unicode way (`ſ` U+017F is `s`, the Kelvin sign is `k`) and
  // ignores normalization. NFKC, then upper- and lower-casing, maps those spellings
  // to one; any over-match only refuses more. The fold applies to the whole
  // candidate, so a leaf that does not exist yet (`.zſhenv`) folds too.
  const fold =
    platform === "darwin" || platform === "win32"
      ? (value: string) => value.normalize("NFKC").toUpperCase().toLowerCase()
      : (value: string) => value;
  const forms = (entry: string) => [
    ...new Set([fold(NodePath.resolve(entry)), fold(canonicalize(entry, platform))]),
  ];
  const homeDir = NodePath.resolve(roots.homeDir);
  const inHome = (relative: string) => NodePath.join(homeDir, relative);
  const gitSegment = isGitSegment(platform);
  const environmentPaths = environmentProviderPaths(roots.environment ?? {}, homeDir);
  const identityIo = makeLimiter(IDENTITY_IO_CONCURRENCY);
  const list = (directory: string) => identityIo(() => listDirectory(directory));
  const statLimited = (target: string) => identityIo(() => statIdentity(target));

  // A custom base folder that is, or holds, the user's home is not checked by
  // shape: `~/dev`, `~/backups` or `~/runtime` are the user's folders there. The
  // configured state folder and the fleet file are still refused by name.
  const baseHoldsHome = isAncestorOrSelf(NodePath.resolve(roots.baseDir), homeDir);
  const baseRoots = baseHoldsHome ? [] : forms(roots.baseDir);
  const baseFleetFile = NodePath.join(roots.baseDir, FLEET_CONFIG_FILE);
  const cliWrapperDirectories = new Set(forms(inHome(CLI_WRAPPER_DIRECTORY)));
  const stateDirectories = forms(roots.stateDir);
  const deniedDirectories = [roots.secretsDir, ...HOME_DENIED_DIRECTORIES.map(inHome)].flatMap(
    forms,
  );
  const writeDeniedDirectories = HOME_WRITE_DENIED_DIRECTORIES.map(inHome).flatMap(forms);
  const deniedFiles = new Set(
    [
      roots.settingsPath,
      roots.dbPath,
      `${roots.dbPath}-wal`,
      `${roots.dbPath}-shm`,
      `${roots.dbPath}-journal`,
      baseFleetFile,
      ...HOME_DENIED_FILES.map(inHome),
      ...environmentPaths.files,
    ].flatMap(forms),
  );
  const writeDeniedFiles = new Set(HOME_WRITE_DENIED_FILES.map(inHome).flatMap(forms));
  const accountProfiles = forms(inHome(ACCOUNT_PROFILES_DIRECTORY));
  const staticProviderHomes = [...DEFAULT_PROVIDER_HOMES.map(inHome), ...environmentPaths.homes];
  let providerHomes = new Set(staticProviderHomes.flatMap(forms));
  let providerHomePaths: ReadonlyArray<string> = staticProviderHomes;
  // A worktree folder that is itself an app home, or holds the base, state or home
  // folder, would switch the shape rules off for app state; it is ignored.
  const worktreePathsFrom = (directories: ReadonlyArray<string>) =>
    directories
      .map((directory) => NodePath.resolve(expandHome(directory, homeDir)))
      .filter(
        (directory) =>
          NodePath.isAbsolute(directory) &&
          !APP_HOME_SEGMENTS.has(fold(NodePath.basename(directory))) &&
          ![roots.baseDir, roots.stateDir, homeDir].some((folder) =>
            isAncestorOrSelf(directory, NodePath.resolve(folder)),
          ),
      );
  const staticWorktrees = worktreePathsFrom(roots.worktreesDirectories ?? []);
  let worktreePaths: ReadonlyArray<string> = staticWorktrees;
  let worktreeFolders: ReadonlyArray<string> = [...new Set(staticWorktrees.flatMap(forms))];

  // Folders refused as a whole and single protected files, for the identity check.
  const identityDirectories = [roots.secretsDir, ...HOME_DENIED_DIRECTORIES.map(inHome)];
  const identityFiles = [
    roots.settingsPath,
    roots.dbPath,
    baseFleetFile,
    ...HOME_DENIED_FILES.map(inHome),
    ...environmentPaths.files,
  ];
  // Write-only locations, for the identity check on writes.
  const writeIdentityDirectories = HOME_WRITE_DENIED_DIRECTORIES.map(inHome);
  const writeIdentityFiles = HOME_WRITE_DENIED_FILES.map(inHome);
  type IdentityPaths = {
    readonly directories: Array<string>;
    readonly files: Array<string>;
    readonly writeDirectories: Array<string>;
    readonly writeFiles: Array<string>;
  };

  /** What a state folder refuses by name: everything but the readable subfolders. */
  const addStateFolder = async (stateDirectory: string, out: IdentityPaths) => {
    // Readable entries are still never written; received worktrees (`git`) are projects.
    const nested = async (
      folder: string,
      readable: (entry: NodeFS.Dirent) => boolean,
      project: (entry: NodeFS.Dirent) => boolean = () => false,
    ) => {
      for (const entry of await list(folder)) {
        if (project(entry)) continue;
        const child = NodePath.join(folder, entry.name);
        if (readable(entry)) {
          (entry.isDirectory() ? out.writeDirectories : out.writeFiles).push(child);
        } else {
          (entry.isDirectory() ? out.directories : out.files).push(child);
        }
      }
    };
    // Everything under `providers` but the readable agent output.
    const addProviderState = async (
      folder: string,
      patterns: ReadonlyArray<ReadonlyArray<SegmentMatch>>,
    ): Promise<void> => {
      for (const entry of await list(folder)) {
        const child = NodePath.join(folder, entry.name);
        const matching = patterns.filter((pattern) => pattern[0]!(entry.name));
        if (matching.some((pattern) => pattern.length === 1)) {
          (entry.isDirectory() ? out.writeDirectories : out.writeFiles).push(child);
        } else if (matching.length > 0 && entry.isDirectory()) {
          await addProviderState(
            child,
            matching.map((pattern) => pattern.slice(1)),
          );
        } else {
          (entry.isDirectory() ? out.directories : out.files).push(child);
        }
      }
    };
    for (const entry of await list(stateDirectory)) {
      const child = NodePath.join(stateDirectory, entry.name);
      if (!entry.isDirectory()) {
        out.files.push(child);
      } else if (entry.name === "logs") {
        out.writeDirectories.push(child);
        for (const name of PROTECTED_LOG_SUBDIRECTORIES)
          out.directories.push(NodePath.join(child, name));
      } else if (READABLE_STATE_SUBDIRECTORIES.has(entry.name)) {
        out.writeDirectories.push(child);
      } else if (entry.name === SERVER_BROWSER_DIRECTORY) {
        await nested(child, (inner) => inner.name === SERVER_BROWSER_DOWNLOADS);
      } else if (entry.name === PROVIDERS_STATE_DIRECTORY) {
        await addProviderState(child, READABLE_PROVIDER_STATE_PATHS);
      } else if (entry.name === MACHINE_HANDOFFS_DIRECTORY) {
        await nested(
          child,
          (inner) => inner.name.startsWith("context-") && !inner.isDirectory(),
          (inner) => inner.name === "git" && inner.isDirectory(),
        );
      } else {
        out.directories.push(child);
      }
    }
  };

  /** One level of an app home: its state folders, backups, database backups and fleet file. */
  const addAppHomeLevel = async (home: string, out: IdentityPaths) => {
    await Promise.all(
      [...STATE_DIRECTORY_NAMES].map((name) => addStateFolder(NodePath.join(home, name), out)),
    );
    out.directories.push(
      NodePath.join(home, "backups"),
      NodePath.join(home, "runtime", "db-backup"),
    );
    out.files.push(NodePath.join(home, FLEET_CONFIG_FILE));
    out.writeDirectories.push(
      NodePath.join(home, "runtime"),
      NodePath.join(home, INSTALL_DIRECTORY),
    );
    for (const name of HOME_LEVEL_WRITE_DENIED_FILES)
      out.writeFiles.push(NodePath.join(home, name));
  };

  /**
   * App homes: the server's base folder and the owner's `~/.specwithcode` and
   * `~/.specweave-studio`, each with its `<identity>` homes one level down.
   */
  const addAppHomes = async (out: IdentityPaths) => {
    const homes = new Set(baseHoldsHome ? [] : [NodePath.resolve(roots.baseDir)]);
    for (const segment of APP_HOME_SEGMENTS) homes.add(NodePath.join(homeDir, segment));
    await addStateFolder(roots.stateDir, out);
    const worktrees = new Set(worktreePaths);
    await Promise.all(
      [...homes].map(async (home) => {
        await addAppHomeLevel(home, out);
        const identities = (await list(home)).filter(
          (entry) =>
            entry.isDirectory() &&
            !PROJECT_DIRECTORIES.has(entry.name) &&
            !STATE_DIRECTORY_NAMES.has(entry.name) &&
            entry.name !== "backups" &&
            entry.name !== "runtime" &&
            entry.name !== INSTALL_DIRECTORY &&
            !worktrees.has(NodePath.join(home, entry.name)),
        );
        await Promise.all(
          identities.map((entry) => addAppHomeLevel(NodePath.join(home, entry.name), out)),
        );
      }),
    );
  };

  /** Credential files at any depth under the account profiles folder, within a small budget. */
  const addAccountProfileCredentials = async (out: IdentityPaths) => {
    let budget = 512;
    const walk = async (folder: string, depth: number): Promise<void> => {
      if (depth > 6 || budget <= 0) return;
      const entries = await list(folder);
      budget -= entries.length;
      await Promise.all(
        entries.map((entry) => {
          const child = NodePath.join(folder, entry.name);
          if (entry.isDirectory()) return walk(child, depth + 1);
          if (PROVIDER_HOME_CREDENTIAL_FILES.has(entry.name)) out.files.push(child);
          return undefined;
        }),
      );
    };
    await walk(inHome(ACCOUNT_PROFILES_DIRECTORY), 0);
  };

  /** Provider config files and the installer's CLI wrappers, which a write must not replace. */
  const addWriteOnlyFiles = async (out: IdentityPaths) => {
    const matching = async (folder: string, matches: (name: string) => boolean) => {
      for (const entry of await list(folder)) {
        if (!entry.isDirectory() && matches(entry.name)) {
          out.writeFiles.push(NodePath.join(folder, entry.name));
        }
      }
    };
    await Promise.all([
      ...providerHomePaths.map((home) => matching(home, isProviderConfigFile)),
      matching(inHome(CLI_WRAPPER_DIRECTORY), isCliWrapperName),
    ]);
  };

  type Identities = {
    readonly directories: Set<string>;
    readonly files: Set<string>;
    readonly writeDirectories: Set<string>;
    readonly writeFiles: Set<string>;
  };
  let identities: { readonly at: number; readonly value: Promise<Identities> } | undefined;
  const readIdentities = async (): Promise<Identities> => {
    const credentialFiles = providerHomePaths.flatMap((home) =>
      [...PROVIDER_HOME_CREDENTIAL_FILES].map((name) => NodePath.join(home, name)),
    );
    const found: IdentityPaths = {
      directories: [...identityDirectories],
      files: [],
      writeDirectories: [...writeIdentityDirectories],
      writeFiles: [...writeIdentityFiles],
    };
    await Promise.all([
      addAppHomes(found),
      addAccountProfileCredentials(found),
      addWriteOnlyFiles(found),
    ]);
    const directories = [...new Set(found.directories)];
    const writeDirectories = [...new Set(found.writeDirectories)];
    // Files directly inside the refused folders count too, so a hard link to a
    // stored secret, key, backup or login item is recognised.
    const filesIn = async (folders: ReadonlyArray<string>) =>
      (
        await Promise.all(
          folders.map((directory) =>
            list(directory).then((entries) =>
              entries
                .filter((entry) => !entry.isDirectory())
                .slice(0, IDENTITY_FOLDER_FILE_LIMIT)
                .map((entry) => NodePath.join(directory, entry.name)),
            ),
          ),
        )
      ).flat();
    /** Files under a write-only folder, nearest first, within a budget. */
    const filesUnder = async (folder: string) => {
      const out: Array<string> = [];
      let level = [folder];
      for (let depth = 0; depth < WRITE_IDENTITY_FOLDER_DEPTH && level.length > 0; depth++) {
        const next: Array<string> = [];
        for (const [directory, entries] of await Promise.all(
          level.map(async (directory) => [directory, await list(directory)] as const),
        )) {
          for (const entry of entries) {
            const child = NodePath.join(directory, entry.name);
            if (entry.isDirectory()) next.push(child);
            else if (out.length < WRITE_IDENTITY_FOLDER_FILE_LIMIT) out.push(child);
          }
        }
        if (out.length >= WRITE_IDENTITY_FOLDER_FILE_LIMIT) break;
        level = next.slice(0, WRITE_IDENTITY_FOLDER_FILE_LIMIT);
      }
      return out;
    };
    const [folderFiles, writeFolderFiles] = await Promise.all([
      filesIn(directories),
      Promise.all(writeDirectories.map(filesUnder)).then((lists) => lists.flat()),
    ]);
    const files = [
      ...new Set([...identityFiles, ...credentialFiles, ...found.files, ...folderFiles]),
    ];
    const writeFiles = [...new Set([...found.writeFiles, ...writeFolderFiles])];
    const keys = async (paths: ReadonlyArray<string>, kind: "directory" | "file") =>
      new Set(
        (await Promise.all(paths.map(statLimited))).flatMap((stat) =>
          stat && (kind === "directory" ? stat.isDirectory() : stat.isFile())
            ? [identityKey(stat)]
            : [],
        ),
      );
    const [directoryKeys, fileKeys, writeDirectoryKeys, writeFileKeys] = await Promise.all([
      keys(directories, "directory"),
      keys(files, "file"),
      keys(writeDirectories, "directory"),
      keys(writeFiles, "file"),
    ]);
    return {
      directories: directoryKeys,
      files: fileKeys,
      writeDirectories: writeDirectoryKeys,
      writeFiles: writeFileKeys,
    };
  };
  const identityCacheMillis = roots.identityCacheMillis ?? 5_000;
  /** Shared by concurrent callers and reused for a few seconds, so a search reads it once. */
  const loadIdentities = () => {
    // A plain cache age inside a promise-based check; no Effect clock is in reach here.
    // @effect-diagnostics-next-line globalDate:off
    const now = Date.now();
    if (!identities || now - identities.at >= identityCacheMillis) {
      identities = { at: now, value: readIdentities() };
    }
    return identities.value;
  };
  const within = (candidate: string, directory: string) =>
    candidate.startsWith(`${directory}${NodePath.sep}`);
  const segmentsUnder = (candidate: string, directory: string) =>
    candidate.slice(directory.length + 1).split(NodePath.sep);

  /**
   * A path inside a state folder: only reads of files in a readable subfolder
   * pass, and never terminal or provider logs.
   */
  const deniedInState = (stateRelative: ReadonlyArray<string>, access: SensitiveAccess) => {
    const [folder, child] = stateRelative;
    if (folder === MACHINE_HANDOFFS_DIRECTORY) {
      if (child === "git" && stateRelative.length >= 4) return false;
      return !(access === "read" && stateRelative.length === 2 && child!.startsWith("context-"));
    }
    if (access === "write") return true;
    if (folder === PROVIDERS_STATE_DIRECTORY) {
      return !isReadableProviderStatePath(stateRelative.slice(1));
    }
    if (folder === SERVER_BROWSER_DIRECTORY) {
      return !(child === SERVER_BROWSER_DOWNLOADS && stateRelative.length >= 3);
    }
    if (stateRelative.length < 2 || !READABLE_STATE_SUBDIRECTORIES.has(folder!)) return true;
    return folder === "logs" && PROTECTED_LOG_SUBDIRECTORIES.has(child!);
  };

  /** One level of an app home: state folders, the fleet file, backups and the service runtime. */
  const deniedInHomeLevel = (segments: ReadonlyArray<string>, access: SensitiveAccess) => {
    const [first, second] = segments;
    if (first === undefined) return false;
    if (STATE_DIRECTORY_NAMES.has(first)) return deniedInState(segments.slice(1), access);
    if (segments.length === 1) {
      return (
        first === FLEET_CONFIG_FILE ||
        (access === "write" && HOME_LEVEL_WRITE_DENIED_FILES.has(first))
      );
    }
    if (first === "backups") return true;
    if (first === INSTALL_DIRECTORY) return access === "write";
    // The service executable under runtime/versions is spawned on restart.
    if (first === "runtime") return access === "write" || second === "db-backup";
    return false;
  };

  /** An app home and, one level down, its `<identity>` homes. */
  const deniedInAppRoot = (segments: ReadonlyArray<string>, access: SensitiveAccess): boolean => {
    const [first] = segments;
    if (first === undefined || PROJECT_DIRECTORIES.has(first)) return false;
    if (deniedInHomeLevel(segments, access)) return true;
    if (segments.length < 2 || PROJECT_DIRECTORIES.has(segments[1]!)) {
      return false;
    }
    return deniedInHomeLevel(segments.slice(1), access);
  };

  const deniedInProviderHome = (candidate: string, access: SensitiveAccess) => {
    if (!providerHomes.has(NodePath.dirname(candidate))) return false;
    const name = NodePath.basename(candidate);
    return (
      PROVIDER_HOME_CREDENTIAL_FILES.has(name) || (access === "write" && isProviderConfigFile(name))
    );
  };

  /** Folded, with the macOS data-volume firmlink prefix removed. */
  const normalize = (candidatePath: string) => {
    const candidate = fold(NodePath.resolve(candidatePath));
    if (platform !== "darwin" || !candidate.toLowerCase().startsWith(DARWIN_DATA_VOLUME_PREFIX)) {
      return candidate;
    }
    return candidate.slice(DARWIN_DATA_VOLUME_PREFIX.length - 1);
  };

  const isVolfs = (candidate: string) =>
    platform === "darwin" &&
    (candidate === DARWIN_VOLFS_ROOT || candidate.startsWith(`${DARWIN_VOLFS_ROOT}/`));

  /**
   * How many leading segments of `candidate` belong to the deepest worktree folder
   * holding it (0 when none): app home rules only apply past that point.
   */
  const worktreeDepth = (candidate: string) => {
    let depth = 0;
    for (const folder of worktreeFolders) {
      if (candidate === folder || within(candidate, folder)) {
        depth = Math.max(depth, folder.split(NodePath.sep).length);
      }
    }
    return depth;
  };

  const statCached = (target: string, cache: IdentityStatCache) => {
    let entry = cache.get(target);
    if (!entry) {
      entry = statIdentity(target);
      cache.set(target, entry);
    }
    return entry;
  };

  return {
    isInsideDeniedFolder: (folderPath) => {
      const candidate = normalize(folderPath);
      if (isVolfs(candidate)) return true;
      return deniedDirectories.some(
        (directory) => candidate === directory || within(candidate, directory),
      );
    },
    isDenied: (candidatePath, access = "read") => {
      const candidate = normalize(candidatePath);
      if (isVolfs(candidate)) return true;
      if (deniedFiles.has(candidate)) return true;
      if (deniedDirectories.some((directory) => within(candidate, directory))) return true;
      if (access === "write") {
        if (writeDeniedFiles.has(candidate)) return true;
        if (candidate.split(NodePath.sep).some(gitSegment)) return true;
        if (writeDeniedDirectories.some((directory) => within(candidate, directory))) return true;
        if (
          cliWrapperDirectories.has(NodePath.dirname(candidate)) &&
          isCliWrapperName(NodePath.basename(candidate))
        ) {
          return true;
        }
      }
      if (deniedInProviderHome(candidate, access)) return true;
      if (
        accountProfiles.some((directory) => within(candidate, directory)) &&
        PROVIDER_HOME_CREDENTIAL_FILES.has(NodePath.basename(candidate))
      ) {
        return true;
      }
      for (const stateDirectory of stateDirectories) {
        if (
          within(candidate, stateDirectory) &&
          deniedInState(segmentsUnder(candidate, stateDirectory), access)
        ) {
          return true;
        }
      }
      // Inside a configured worktree folder, only app homes past it count (an
      // instance home a worker made inside a checkout).
      const projectDepth = worktreeDepth(candidate);
      for (const root of baseRoots) {
        if (
          within(candidate, root) &&
          root.split(NodePath.sep).length > projectDepth &&
          deniedInAppRoot(segmentsUnder(candidate, root), access)
        ) {
          return true;
        }
      }
      // Every app home segment anywhere in the path, checkouts included.
      const segments = candidate.split(NodePath.sep);
      for (let index = projectDepth; index < segments.length - 1; index++) {
        if (
          APP_HOME_SEGMENTS.has(segments[index]!) &&
          deniedInAppRoot(segments.slice(index + 1), access)
        ) {
          return true;
        }
      }
      return false;
    },
    setProviderHomes: (homes) => {
      providerHomePaths = [
        ...staticProviderHomes,
        ...homes.map((home) => expandHome(home, homeDir)),
      ];
      providerHomes = new Set(providerHomePaths.flatMap(forms));
      identities = undefined;
    },
    setWorktreesDirectories: (directories) => {
      worktreePaths = [...staticWorktrees, ...worktreePathsFrom(directories)];
      worktreeFolders = [...new Set(worktreePaths.flatMap(forms))];
      identities = undefined;
    },
    matchesProtectedIdentity: async (resolvedPath, statCache = new Map(), access = "read") => {
      const target = NodePath.resolve(resolvedPath);
      // Every ancestor is compared, since another name for a protected folder (a
      // firmlink such as /System/Volumes/Data, a bind mount) can sit at any depth.
      const chain: Array<string> = [];
      for (let current = target; ;) {
        chain.push(current);
        const parent = NodePath.dirname(current);
        if (parent === current) break;
        current = parent;
      }
      const [known, ...stats] = await Promise.all([
        loadIdentities(),
        ...chain.map((entry) => statCached(entry, statCache)),
      ]);
      const stat = stats[0];
      const write = access === "write";
      if (stat && stat.isFile()) {
        const key = identityKey(stat);
        if (known.files.has(key) || (write && known.writeFiles.has(key))) return true;
      }
      return stats.some(
        (entry) =>
          entry != null &&
          (known.directories.has(identityKey(entry)) ||
            (write && known.writeDirectories.has(identityKey(entry)))),
      );
    },
    isProtectedFileIdentity: async (stat) => (await loadIdentities()).files.has(identityKey(stat)),
  };
}

export interface ProtectedPathCheckOptions {
  /** Resolves symlinks; the native realpath unless set. */
  readonly realpath?: (target: string) => Promise<string>;
  /**
   * A path that does not exist (a file a diff deletes) is resolved through its
   * nearest existing folder instead of being refused.
   */
  readonly allowMissing?: boolean;
  /** Paths resolved at once; 16 unless set. */
  readonly concurrency?: number;
}

export interface ProtectedPathCheck {
  /** The protected ones among `relativePaths`. */
  readonly protectedAmong: (relativePaths: Iterable<string>) => Promise<ReadonlySet<string>>;
  readonly isProtected: (relativePath: string) => Promise<boolean>;
}

/**
 * Decides which paths under `root` are protected, for a whole search, review
 * preview or Changes totals. A lexical pass runs over every path first; the rest
 * are resolved a bounded number at a time, each once however many lists name it.
 * A file costs one `lstat`: its folder is resolved once for all files in it, and
 * only a symlink is resolved on its own. Then the name and identity checks run on
 * the resolved path. Fails closed: when the root or a path cannot be resolved, the
 * path counts as protected.
 */
export function makeProtectedPathCheck(
  guard: SensitivePathGuard,
  root: string,
  options: ProtectedPathCheckOptions = {},
): ProtectedPathCheck {
  const realpath = options.realpath ?? realpathNative;
  const limit = makeLimiter(options.concurrency ?? 16);
  const statCache: IdentityStatCache = new Map();
  const verdicts = new Map<string, Promise<boolean>>();
  let realRoot: Promise<string | null> | undefined;

  // Folders resolved once, shared: most files in a list share a few folders.
  const resolvedFolders = new Map<string, Promise<string | null>>();
  const resolveFolder = (folder: string) => {
    let resolved = resolvedFolders.get(folder);
    if (!resolved) {
      resolved = resolveTarget(folder);
      resolvedFolders.set(folder, resolved);
    }
    return resolved;
  };
  /** In its folder's realpath; a missing path (with `allowMissing`) as well. */
  const inResolvedFolder = async (absolutePath: string) => {
    const parent = NodePath.dirname(absolutePath);
    if (parent === absolutePath) return null;
    const resolvedParent = await resolveFolder(parent);
    return resolvedParent === null
      ? null
      : NodePath.join(resolvedParent, NodePath.basename(absolutePath));
  };
  const resolveTarget = async (absolutePath: string): Promise<string | null> => {
    try {
      return await realpath(absolutePath);
    } catch (error) {
      if (!options.allowMissing || !isMissingPathError(error)) return null;
      return inResolvedFolder(absolutePath);
    }
  };
  const resolveFile = async (absolutePath: string): Promise<string | null> => {
    let stat: NodeFS.BigIntStats;
    try {
      stat = await NodeFSP.lstat(absolutePath, { bigint: true });
    } catch (error) {
      return options.allowMissing && isMissingPathError(error)
        ? inResolvedFolder(absolutePath)
        : null;
    }
    if (stat.isSymbolicLink()) return resolveTarget(absolutePath);
    const resolved = await inResolvedFolder(absolutePath);
    // Not a link, so its stat is the one the identity check would take.
    if (resolved !== null) statCache.set(identityStatCacheKey(resolved), Promise.resolve(stat));
    return resolved;
  };

  const decide = async (absolutePath: string) => {
    realRoot ??= realpath(root).catch(() => null);
    if ((await realRoot) === null) return true;
    const realPath = await resolveFile(absolutePath);
    if (realPath === null) return true;
    return guard.isDenied(realPath) || (await guard.matchesProtectedIdentity(realPath, statCache));
  };

  const protectedAmong = async (relativePaths: Iterable<string>) => {
    const unique = [...new Set(relativePaths)];
    for (const relativePath of unique) {
      if (verdicts.has(relativePath)) continue;
      const absolutePath = NodePath.resolve(root, relativePath);
      verdicts.set(
        relativePath,
        guard.isDenied(absolutePath)
          ? Promise.resolve(true)
          : limit(() => decide(absolutePath)).catch(() => true),
      );
    }
    const results = await Promise.all(unique.map((relativePath) => verdicts.get(relativePath)!));
    return new Set(unique.filter((_, index) => results[index]));
  };

  return {
    protectedAmong,
    isProtected: async (relativePath) => (await protectedAmong([relativePath])).has(relativePath),
  };
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Provider homes the settings point at: `homePath` and `shadowHomePath` of every
 * legacy provider block and provider instance, plus home variables set in an
 * instance's environment.
 */
export function providerHomesFromSettings(settings: unknown): ReadonlyArray<string> {
  if (!record(settings)) return [];
  const homes: Array<string> = [];
  const addHomePaths = (config: unknown) => {
    if (!record(config)) return;
    for (const key of ["homePath", "shadowHomePath"]) {
      const value = config[key];
      if (typeof value === "string" && value.trim()) homes.push(value.trim());
    }
  };
  if (record(settings.providers)) Object.values(settings.providers).forEach(addHomePaths);
  if (record(settings.providerInstances)) {
    for (const instance of Object.values(settings.providerInstances)) {
      if (!record(instance)) continue;
      addHomePaths(instance.config);
      if (!Array.isArray(instance.environment)) continue;
      for (const variable of instance.environment) {
        if (
          record(variable) &&
          typeof variable.name === "string" &&
          (PROVIDER_HOME_VARIABLES as ReadonlyArray<string>).includes(variable.name) &&
          typeof variable.value === "string" &&
          variable.value.trim()
        ) {
          homes.push(variable.value.trim());
        }
      }
    }
  }
  return homes;
}

/** Worktree folders the settings name: the current one and earlier ones. */
export function worktreesDirectoriesFromSettings(settings: unknown): ReadonlyArray<string> {
  if (!record(settings)) return [];
  const directories: Array<string> = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim()) directories.push(value.trim());
  };
  add(settings.worktreesDirectory);
  if (Array.isArray(settings.previousWorktreesDirectories)) {
    settings.previousWorktreesDirectories.forEach(add);
  }
  return directories;
}

/** Points the guard at the provider homes and worktree folders in `settings`. */
const applySettings = (guard: SensitivePathGuard, settings: unknown) => {
  guard.setProviderHomes(providerHomesFromSettings(settings));
  guard.setWorktreesDirectories(worktreesDirectoriesFromSettings(settings));
};

/**
 * The guard for the running server: its own state, every app home, the owner's
 * home credentials and the provider homes from the environment and from the
 * settings at construction. Needs no scope; see makeServerSensitivePathGuard for
 * one that follows settings changes.
 */
export const makeServerSensitivePathGuardSnapshot = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const homeDir = yield* SensitivePathsHomeDirectory;
  const platform = yield* HostProcessPlatform;
  const environment = yield* HostProcessEnvironment;
  const guard = makeSensitivePathGuard(
    {
      baseDir: config.baseDir,
      stateDir: config.stateDir,
      secretsDir: config.secretsDir,
      settingsPath: config.settingsPath,
      dbPath: config.dbPath,
      homeDir,
      environment,
      identityCacheMillis: yield* SensitivePathsIdentityCacheMillis,
      worktreesDirectories: [config.worktreesDir],
    },
    platform,
  );
  const settingsService = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  if (settingsService._tag === "Some") {
    const current = yield* settingsService.value.getSettings.pipe(Effect.option);
    if (current._tag === "Some") applySettings(guard, current.value);
  }
  return { guard, settingsService };
});

/** One guard for the whole server, following provider homes in settings. */
export class SensitivePaths extends Context.Service<SensitivePaths, SensitivePathGuard>()(
  "specweave-studio/workspace/WorkspaceSensitivePaths/SensitivePaths",
) {}

/** The server guard, kept up to date with provider homes while the layer lives. */
export const makeServerSensitivePathGuard = Effect.gen(function* () {
  const { guard, settingsService } = yield* makeServerSensitivePathGuardSnapshot;
  if (settingsService._tag === "Some") {
    yield* settingsService.value.streamChanges.pipe(
      Stream.runForEach((next) => Effect.sync(() => applySettings(guard, next))),
      Effect.forkScoped,
    );
  }
  return guard;
});

/** Provides the shared guard; build it once per server. */
export const layer = Layer.effect(SensitivePaths, makeServerSensitivePathGuard);

/**
 * The shared guard when the server provides it, otherwise one built here (tests
 * and standalone layers), following settings changes while the scope lives.
 */
export const sensitivePathGuard = Effect.gen(function* () {
  const shared = yield* Effect.serviceOption(SensitivePaths);
  if (shared._tag === "Some") return shared.value;
  return yield* makeServerSensitivePathGuard;
});

/** Like `sensitivePathGuard`, for callers without a scope: falls back to a settings snapshot. */
export const sensitivePathGuardSnapshot = Effect.gen(function* () {
  const shared = yield* Effect.serviceOption(SensitivePaths);
  if (shared._tag === "Some") return shared.value;
  return (yield* makeServerSensitivePathGuardSnapshot).guard;
});
