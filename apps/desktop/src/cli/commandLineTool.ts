// @effect-diagnostics nodeBuiltinImport:off - Pure path rules for POSIX and Windows paths (path.posix and path.win32), tested on any OS.
/**
 * "Install command-line tool": puts `specwithcode` on the user's PATH, pointing at the shim inside
 * the running app bundle (apps/desktop/resources/cli), so the command always runs this app's own
 * CLI and stays the app's version across updates.
 *
 * - macOS and Linux (.deb): `~/.local/bin/specwithcode` is a symlink to the bundle's shim.
 * - Linux AppImage: the bundle is mounted at a new path on every run, so the command is a small
 *   launcher that mounts the AppImage named in it and runs the shim inside.
 * - Windows: `%LOCALAPPDATA%\SpecWithCode\bin\specwithcode.cmd` calls the bundle's shim, and that
 *   folder goes on the user PATH.
 *
 * Only entries this file recognises as the app's own are ever replaced or removed. A launcher that
 * install.sh or the fleet installer wrote, or anything else at that path, is reported and kept.
 * Everything here goes through `CommandLineToolHost`, so the Windows rules are tested on any OS.
 */
import * as NodePath from "node:path";

export const SHIM_MARKER = "specwithcode-desktop-shim 1";
export const LAUNCHER_MARKER = "specwithcode-desktop-launcher 1";
export const STARTUP_LINE_MARKER = "# Added by SpecWithCode";
export const COMMAND_NAME = "specwithcode";
const MAX_LAUNCHER_BYTES = 64 * 1024;
const VERSION_TIMEOUT_MS = 10_000;
const SHELL_PROBE_TIMEOUT_MS = 5_000;
const PATH_START = "__SWC_PATH_START__";
const PATH_END = "__SWC_PATH_END__";

export type CommandLineToolPlatform = "darwin" | "linux" | "win32";

export interface EntryInfo {
  readonly kind: "file" | "symlink" | "directory" | "other";
}

export interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandLineToolFileSystem {
  /** Like lstat: never follows a link at `path`. Null when nothing is there. */
  readonly lstat: (path: string) => Promise<EntryInfo | null>;
  readonly readlink: (path: string) => Promise<string | null>;
  /** Whether `path` exists, following links. */
  readonly exists: (path: string) => Promise<boolean>;
  /** `path` with every link resolved, or null when it does not resolve. */
  readonly realpath: (path: string) => Promise<string | null>;
  /** Whether `path` (following links) is a regular file a shell would run. */
  readonly isExecutableFile: (path: string) => Promise<boolean>;
  /** Whether `path` sits on a read-only volume, such as a mounted disk image. */
  readonly isOnReadOnlyVolume: (path: string) => Promise<boolean>;
  /** A regular file's text, at most `maxBytes`; null for anything else. */
  readonly readFile: (path: string, maxBytes: number) => Promise<string | null>;
  readonly makeDirectory: (path: string) => Promise<void>;
  /** Creates a link at `path`; fails when anything is already there. */
  readonly symlink: (target: string, path: string) => Promise<void>;
  /** Creates `path` with `text`; fails when anything is already there. */
  readonly writeNewFile: (path: string, text: string, mode: number) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly unlink: (path: string) => Promise<void>;
  /** Appends to a file in place (a symlinked dotfile stays a symlink), creating it if needed. */
  readonly appendFile: (path: string, text: string) => Promise<void>;
  /** Rewrites a file's contents in place. */
  readonly rewriteFile: (path: string, text: string) => Promise<void>;
}

export interface CommandLineToolHost {
  readonly platform: CommandLineToolPlatform;
  readonly homeDirectory: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The user's login shell (os.userInfo().shell or SHELL). */
  readonly userShell: string | undefined;
  readonly appVersion: string;
  readonly isPackaged: boolean;
  /** The running bundle: the `.app` on macOS, the install folder on Linux and Windows. */
  readonly bundlePath: string;
  /** Electron's process.resourcesPath. */
  readonly resourcesPath: string;
  readonly fs: CommandLineToolFileSystem;
  /**
   * Runs a program. Resolves null when it cannot start or runs past `timeoutMs`; never waits on
   * output pipes that something the program started keeps open.
   */
  readonly run: (
    command: string,
    args: ReadonlyArray<string>,
    options: {
      readonly timeoutMs: number;
      readonly env?: Record<string, string>;
      /** False: start from `env` alone instead of the app's own environment. */
      readonly inheritEnv?: boolean;
    },
  ) => Promise<RunResult | null>;
  /** A unique suffix for temporary names. */
  readonly uniqueSuffix: () => string;
  /** Milliseconds since the epoch. */
  readonly now: () => number;
}

export type CommandLineToolUnavailable = "development" | "temporary-location" | "missing-shim";

export type CommandLineToolInstall =
  /** Nothing at the command's path. */
  | "none"
  /** The app's own command, pointing at this app. */
  | "installed"
  /** The app's own command, pointing at another copy of the app that still exists. */
  | "other-copy"
  /** The app's own command, pointing at a copy of the app that is gone. */
  | "broken"
  /** A launcher written by install.sh or the fleet installer. */
  | "blocked-managed"
  /** Something else. */
  | "blocked-other";

export interface CommandLineToolState {
  readonly platform: CommandLineToolPlatform;
  readonly unavailable: CommandLineToolUnavailable | null;
  readonly commandPath: string;
  readonly binDirectory: string;
  readonly install: CommandLineToolInstall;
  /** The bundle shim or AppImage the app's own command points at. */
  readonly pointsAt: string | null;
  /** What `specwithcode --version` printed through the installed command. */
  readonly version: string | null;
  readonly appVersion: string;
  /** Whether a new terminal has the command's folder on PATH. */
  readonly onPath: "yes" | "no" | "unknown";
  /** Another `specwithcode` that a new terminal finds first. */
  readonly shadowedBy: string | null;
  /** Where "Add to PATH" writes (macOS and Linux), or null when the line must be added by hand. */
  readonly startupFile: string | null;
  /** The exact line to add by hand (macOS and Linux). */
  readonly pathLine: string | null;
  /** Whether the app's marked line or file is in the shell startup files. */
  readonly startupLineAdded: boolean;
}

/** Why an action did not (fully) happen. The app renders the sentence in the user's language. */
export type CommandLineToolReasonCode =
  | CommandLineToolUnavailable
  | "blocked-managed"
  | "blocked-other"
  /** What is at the command's path changed between the check and the write. Nothing replaced. */
  | "changed"
  | "unknown-shell"
  | "fish-file-exists"
  /** The startup file exists but could not be read in full, so it was not edited. */
  | "startup-file-unreadable"
  | "startup-file-write"
  /** The command was removed; the marked line in `path` could not be taken out. */
  | "remove-partial"
  /** The command was removed; its folder could not be taken off the Windows user PATH. */
  | "remove-partial-path"
  | "path-read"
  | "path-write"
  /** The Windows user PATH changed while the app was editing it. Nothing written. */
  | "path-changed"
  /** The AppImage's path cannot be written into a launcher. */
  | "unsafe-path"
  | "write-failed";

export interface CommandLineToolReason {
  readonly code: CommandLineToolReasonCode;
  readonly path: string | null;
  /** The system error code (EACCES, ENOENT, ...) when there is one. */
  readonly errno: string | null;
}

export type CommandLineToolResult =
  | { readonly ok: true; readonly state: CommandLineToolState }
  | {
      readonly ok: false;
      readonly reason: CommandLineToolReason;
      readonly state: CommandLineToolState;
    };

type PathFlavour = typeof NodePath.posix;

const pathFor = (platform: CommandLineToolPlatform): PathFlavour =>
  platform === "win32" ? NodePath.win32 : NodePath.posix;

const isAppImage = (host: CommandLineToolHost) =>
  host.platform === "linux" && typeof host.env.APPIMAGE === "string" && host.env.APPIMAGE !== "";

export const binDirectoryFor = (host: CommandLineToolHost): string => {
  const path = pathFor(host.platform);
  if (host.platform === "win32") {
    const fromEnv = host.env.LOCALAPPDATA;
    const localAppData =
      fromEnv && path.isAbsolute(fromEnv)
        ? fromEnv
        : path.join(host.homeDirectory, "AppData", "Local");
    return path.join(localAppData, "SpecWithCode", "bin");
  }
  return path.join(host.homeDirectory, ".local", "bin");
};

export const commandPathFor = (host: CommandLineToolHost): string =>
  pathFor(host.platform).join(
    binDirectoryFor(host),
    host.platform === "win32" ? `${COMMAND_NAME}.cmd` : COMMAND_NAME,
  );

/** The shim inside the running bundle. */
export const bundleShimPathFor = (host: CommandLineToolHost): string =>
  pathFor(host.platform).join(
    host.resourcesPath,
    "cli",
    host.platform === "win32" ? `${COMMAND_NAME}.cmd` : COMMAND_NAME,
  );

/** The running AppImage, or null outside an AppImage. */
const appImagePathFor = (host: CommandLineToolHost): string | null =>
  isAppImage(host) ? host.env.APPIMAGE! : null;

// oxlint-disable-next-line no-control-regex -- control characters are what this rejects.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** A copy of the app that may vanish: a disk image or a translocated copy on macOS. */
export const isTemporaryLocation = async (host: CommandLineToolHost): Promise<boolean> => {
  if (host.platform === "darwin") {
    return (
      host.bundlePath.startsWith("/Volumes/") ||
      host.bundlePath.includes("/AppTranslocation/") ||
      // A disk image mounted somewhere else (hdiutil attach -mountpoint) is still read-only.
      (await host.fs.isOnReadOnlyVolume(host.bundlePath))
    );
  }
  const appImage = appImagePathFor(host);
  if (appImage !== null) return appImage.startsWith("/tmp/");
  return false;
};

/** Python's shlex.quote. */
export const shellQuote = (value: string): string => {
  if (value === "") return "''";
  if (!/[^A-Za-z0-9_@%+=:,./-]/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
};

const shellUnquote = (value: string): string | null => {
  // Only what shellQuote writes: a bare word, or single-quoted runs joined by "'"'"'.
  if (!value.startsWith("'")) return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : null;
  if (!value.endsWith("'")) return null;
  const inner = value.slice(1, -1);
  const parts = inner.split(`'"'"'`);
  if (parts.some((part) => part.includes("'"))) return null;
  return parts.join("'");
};

/** The AppImage launcher: mounts `appImage` and runs the shim inside it. */
export const renderAppImageLauncher = (appImage: string): string =>
  [
    "#!/bin/sh",
    `# ${LAUNCHER_MARKER}`,
    "# Runs the specwithcode command inside the SpecWithCode AppImage named below. The app wrote",
    "# this (Settings > Machines > Command line) and keeps it pointed at the app.",
    "set -eu",
    `appimage=${shellQuote(appImage)}`,
    'if [ ! -x "$appimage" ]; then',
    '  echo "specwithcode: the SpecWithCode app is no longer at $appimage. Open the app once to repair this command." >&2',
    "  exit 127",
    "fi",
    'work=$(mktemp -d "${TMPDIR:-/tmp}/specwithcode.XXXXXX")',
    '"$appimage" --appimage-mount >"$work/mount" 2>"$work/error" </dev/null &',
    "mounter=$!",
    'cleanup() { kill "$mounter" 2>/dev/null || :; wait "$mounter" 2>/dev/null || :; rm -rf "$work"; }',
    "trap cleanup EXIT",
    "trap 'exit 130' INT",
    "trap 'exit 143' TERM",
    "# The mount prints its folder as one line; wait about 10 seconds for it, no longer.",
    "tries=0",
    'while [ "$tries" -lt "${SPECWITHCODE_MOUNT_WAIT:-100}" ]; do',
    '  case $(wc -l <"$work/mount") in *[1-9]*) break ;; esac',
    '  kill -0 "$mounter" 2>/dev/null || break',
    "  sleep 0.1 2>/dev/null || sleep 1",
    "  tries=$((tries + 1))",
    "done",
    "mount=''",
    'IFS= read -r mount <"$work/mount" || :',
    'if [ -z "$mount" ] || [ ! -x "$mount/resources/cli/specwithcode" ]; then',
    '  echo "specwithcode: could not open $appimage. AppImages need FUSE; see https://docs.appimage.org/user-guide/troubleshooting/fuse.html" >&2',
    "  exit 127",
    "fi",
    "status=0",
    '"$mount/resources/cli/specwithcode" "$@" || status=$?',
    'exit "$status"',
    "",
  ].join("\n");

const parseAppImageLauncher = (text: string): string | null => {
  if (!text.startsWith(`#!/bin/sh\n# ${LAUNCHER_MARKER}\n`)) return null;
  const line = text.split("\n").find((item) => item.startsWith("appimage="));
  if (line === undefined) return null;
  const value = shellUnquote(line.slice("appimage=".length));
  if (value === null || !value.startsWith("/")) return null;
  return renderAppImageLauncher(value) === text ? value : null;
};

/**
 * The Windows launcher. `call` returns to a batch file that runs the command; the shim's path goes
 * through a variable so `call`'s second round of `%` expansion cannot touch it.
 */
export const renderWindowsLauncher = (shim: string): string =>
  [
    "@echo off",
    `rem ${LAUNCHER_MARKER}`,
    "rem Runs the specwithcode command inside the SpecWithCode app. The app wrote this",
    "rem (Settings > Machines > Command line) and keeps it pointed at the app.",
    "setlocal",
    `set "SWC_SHIM=${shim.replaceAll("%", "%%")}"`,
    'call "%%SWC_SHIM%%" %*',
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n");

const parseWindowsLauncher = (text: string): string | null => {
  if (!text.startsWith(`@echo off\r\nrem ${LAUNCHER_MARKER}\r\n`)) return null;
  const line = text.split("\r\n").find((item) => item.startsWith('set "SWC_SHIM='));
  if (line === undefined || !line.endsWith('"')) return null;
  const shim = line.slice('set "SWC_SHIM='.length, -1).replaceAll("%%", "%");
  if (!/\\cli\\specwithcode\.cmd$/i.test(shim)) return null;
  return renderWindowsLauncher(shim) === text ? shim : null;
};

/** A link target that is the shim inside some copy of the app. */
const isBundleShimTarget = (target: string) =>
  /\/(Contents\/Resources|resources)\/cli\/specwithcode$/.test(target);

/** The `#!/bin/sh` launcher install.sh and scripts/studio-fleet/launcher.py write. */
const isManagedWrapperText = (text: string) =>
  text.startsWith("#!/bin/sh\nset -eu\numask 077\n") && /\/bin\.mjs['"]? "\$@"\n$/.test(text);

const samePath = (platform: CommandLineToolPlatform, left: string, right: string) => {
  const path = pathFor(platform);
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    const trimmed =
      resolved.length > 1 && /[\\/]$/.test(resolved) && !/^[A-Za-z]:\\$/.test(resolved)
        ? resolved.slice(0, -1)
        : resolved;
    return platform === "win32" ? trimmed.toLowerCase() : trimmed;
  };
  return normalize(left) === normalize(right);
};

/** Whether `shim` is a real shim inside an app bundle: the marker, and the app beside it. */
const isRealShim = async (host: CommandLineToolHost, shim: string) => {
  const text = await host.fs.readFile(shim, MAX_LAUNCHER_BYTES);
  if (text === null || !text.includes(SHIM_MARKER)) return false;
  if (host.platform === "win32") return true;
  const resources = NodePath.posix.dirname(NodePath.posix.dirname(shim));
  return host.fs.exists(NodePath.posix.join(resources, "app.asar"));
};

/** What is at a path, compact enough to compare: a link's target or a file's text. */
const identityOf = async (host: CommandLineToolHost, path: string): Promise<string> => {
  const entry = await host.fs.lstat(path);
  if (entry === null) return "none";
  if (entry.kind === "symlink") return `link:${(await host.fs.readlink(path)) ?? "?"}`;
  if (entry.kind === "file") {
    return `file:${(await host.fs.readFile(path, MAX_LAUNCHER_BYTES)) ?? "?"}`;
  }
  return entry.kind;
};

interface Classified {
  readonly install: CommandLineToolInstall;
  readonly pointsAt: string | null;
  /** What was at the path when it was classified; re-checked right before any change. */
  readonly identity: string;
}

/** What is at the command's path, and whether it is the app's own. */
export const classify = async (host: CommandLineToolHost): Promise<Classified> => {
  const path = pathFor(host.platform);
  const commandPath = commandPathFor(host);
  const identity = await identityOf(host, commandPath);
  const result = (install: CommandLineToolInstall, pointsAt: string | null = null) => ({
    install,
    pointsAt,
    identity,
  });
  const entry = await host.fs.lstat(commandPath);
  if (entry === null) return result("none");
  if (entry.kind === "symlink") {
    if (host.platform === "win32") return result("blocked-other");
    const raw = await host.fs.readlink(commandPath);
    if (raw === null) return result("blocked-other");
    const target = path.resolve(path.dirname(commandPath), raw);
    if (!isBundleShimTarget(target)) {
      // install.sh used to link into $STUDIO_HOME/runtime/versions.
      return result(target.includes("/runtime/versions/") ? "blocked-managed" : "blocked-other");
    }
    if (!(await host.fs.exists(target))) return result("broken", target);
    // A lookalike path that is not a shim inside an app is someone else's.
    if (!(await isRealShim(host, target))) return result("blocked-other");
    if (isAppImage(host) || !samePath(host.platform, target, bundleShimPathFor(host))) {
      return result("other-copy", target);
    }
    return result("installed", target);
  }
  if (entry.kind !== "file") return result("blocked-other");
  const text = await host.fs.readFile(commandPath, MAX_LAUNCHER_BYTES);
  if (text === null) return result("blocked-other");
  if (host.platform === "win32") {
    const shim = parseWindowsLauncher(text);
    if (shim === null) return result("blocked-other");
    if (!(await host.fs.exists(shim))) return result("broken", shim);
    if (!(await isRealShim(host, shim))) return result("blocked-other");
    return samePath(host.platform, shim, bundleShimPathFor(host))
      ? result("installed", shim)
      : result("other-copy", shim);
  }
  const appImage = parseAppImageLauncher(text);
  if (appImage !== null) {
    if (!(await host.fs.exists(appImage))) return result("broken", appImage);
    const running = appImagePathFor(host);
    return running !== null && samePath(host.platform, appImage, running)
      ? result("installed", appImage)
      : result("other-copy", appImage);
  }
  return result(isManagedWrapperText(text) ? "blocked-managed" : "blocked-other");
};

export const unavailableReason = async (
  host: CommandLineToolHost,
): Promise<CommandLineToolUnavailable | null> => {
  if (!host.isPackaged) return "development";
  if (await isTemporaryLocation(host)) return "temporary-location";
  if (!(await host.fs.exists(bundleShimPathFor(host)))) return "missing-shim";
  return null;
};

// ---------------------------------------------------------------------------------------------
// Shell PATH (macOS and Linux)

const shellName = (host: CommandLineToolHost) =>
  pathFor(host.platform).basename(host.userShell ?? host.env.SHELL ?? "");

const zshDirectory = (host: CommandLineToolHost) => host.env.ZDOTDIR || host.homeDirectory;
const FISH_FILE_PATH = (host: CommandLineToolHost) =>
  NodePath.posix.join(host.homeDirectory, ".config", "fish", "conf.d", "specwithcode.fish");
const MAC_BASH_FILES = [".bash_profile", ".bash_login", ".profile"];

/** The shell startup file the app may add its line to, or null for a shell it does not know. */
export const startupFileFor = async (host: CommandLineToolHost): Promise<string | null> => {
  const path = NodePath.posix;
  const home = host.homeDirectory;
  switch (shellName(host)) {
    case "zsh":
      return path.join(zshDirectory(host), host.platform === "darwin" ? ".zprofile" : ".zshrc");
    case "bash": {
      if (host.platform !== "darwin") return path.join(home, ".bashrc");
      // bash reads only the first of these that exists; creating .bash_profile would hide an
      // existing .profile. A dangling link is skipped, as bash skips it.
      for (const name of MAC_BASH_FILES) {
        const candidate = path.join(home, name);
        if (await host.fs.exists(candidate)) return candidate;
      }
      return path.join(home, ".bash_profile");
    }
    case "fish":
      return FISH_FILE_PATH(host);
    default:
      return null;
  }
};

/** Every startup file the app could have added its line to, for any shell. */
const knownStartupFiles = (host: CommandLineToolHost): string[] => {
  const path = NodePath.posix;
  const home = host.homeDirectory;
  return [
    ...new Set([
      path.join(zshDirectory(host), ".zprofile"),
      path.join(zshDirectory(host), ".zshrc"),
      path.join(home, ".zprofile"),
      path.join(home, ".zshrc"),
      ...MAC_BASH_FILES.map((name) => path.join(home, name)),
      path.join(home, ".bashrc"),
    ]),
  ];
};

const POSIX_LINE = `export PATH="$HOME/.local/bin:$PATH" ${STARTUP_LINE_MARKER}`;
const FISH_LINE = `set -gx PATH $HOME/.local/bin $PATH ${STARTUP_LINE_MARKER}`;

export const pathLineFor = (host: CommandLineToolHost): string =>
  shellName(host) === "fish" ? FISH_LINE : POSIX_LINE;

const FISH_FILE = (line: string) => `${STARTUP_LINE_MARKER}\n${line}\n`;
const MAX_STARTUP_FILE_BYTES = 8 * 1024 * 1024;

/** Whether the line is in `file`; "unreadable" when the file is there but cannot be read in full. */
const startupLineIn = async (
  host: CommandLineToolHost,
  file: string | null,
): Promise<"yes" | "no" | "unreadable"> => {
  if (file === null) return "no";
  const text = await host.fs.readFile(file, MAX_STARTUP_FILE_BYTES);
  if (text === null) return (await host.fs.lstat(file)) === null ? "no" : "unreadable";
  return text.split(/\r?\n/).includes(pathLineFor(host)) ? "yes" : "no";
};

const probeCache = new WeakMap<
  CommandLineToolHost,
  { readonly at: number; readonly value: Promise<string[] | null> }
>();
const PROBE_CACHE_MS = 60_000;

/** Drops the remembered shell PATH, after the app changed a startup file. */
const forgetShellPath = (host: CommandLineToolHost) => probeCache.delete(host);

/**
 * The PATH a new terminal gets, read from the user's own shell; null when it cannot be read.
 * macOS terminals start login shells; Linux terminals start interactive non-login shells, which
 * read ~/.bashrc (where the app adds its line), not ~/.profile.
 */
export const probeShellPath = (host: CommandLineToolHost): Promise<string[] | null> => {
  const cached = probeCache.get(host);
  if (cached !== undefined && host.now() - cached.at < PROBE_CACHE_MS) return cached.value;
  const value = runShellProbe(host);
  probeCache.set(host, { at: host.now(), value });
  return value;
};

const runShellProbe = async (host: CommandLineToolHost): Promise<string[] | null> => {
  const shell =
    host.userShell || host.env.SHELL || (host.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  const fish = shellName(host) === "fish";
  const script = fish
    ? `printf '${PATH_START}%s${PATH_END}\\n' (string join : $PATH)`
    : `printf '${PATH_START}%s${PATH_END}\\n' "$PATH"`;
  // A clean environment: the app's own PATH must not leak in; it may already hold ~/.local/bin.
  const env: Record<string, string> = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  for (const name of [
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "LANG",
    "ZDOTDIR",
    "XDG_CONFIG_HOME",
  ]) {
    const value = host.env[name];
    if (value) env[name] = value;
  }
  env.HOME = host.homeDirectory;
  env.TERM = "dumb";
  const args = host.platform === "darwin" ? ["-l", "-i", "-c", script] : ["-i", "-c", script];
  const result = await host.run(shell, args, {
    timeoutMs: SHELL_PROBE_TIMEOUT_MS,
    env,
    inheritEnv: false,
  });
  if (result === null) return null;
  const match = new RegExp(`${PATH_START}(.*?)${PATH_END}`).exec(result.stdout);
  if (match === null) return null;
  return match[1]!.split(":").filter((part) => part !== "");
};

// ---------------------------------------------------------------------------------------------
// Windows user PATH

/** `value` (a `;` list) with `directory` added at the end or every copy of it removed. */
export const editWindowsPath = (
  value: string,
  directory: string,
  mode: "add" | "remove",
  expand: (entry: string) => string = (entry) => entry,
): string => {
  const parts = value.split(";");
  const same = (entry: string) =>
    entry.trim() !== "" && samePath("win32", expand(entry.trim()), directory);
  if (mode === "add") {
    if (parts.some(same)) return value;
    return value === "" ? directory : `${value.replace(/;+$/, "")};${directory}`;
  }
  return parts.some(same) ? parts.filter((part) => !same(part)).join(";") : value;
};

const POWERSHELL = "powershell.exe";
const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];

const READ_WINDOWS_PATH = `$ErrorActionPreference='Stop'
$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
$raw=''; $kind='ExpandString'
if ($key -ne $null -and ($key.GetValueNames() -contains 'Path')) {
  $raw=$key.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $kind=[string]$key.GetValueKind('Path')
}
$machine=[Environment]::GetEnvironmentVariable('Path','Machine')
[Console]::Out.Write((ConvertTo-Json -Compress @{ raw=[string]$raw; kind=$kind; user=[Environment]::ExpandEnvironmentVariables([string]$raw); machine=[string]$machine }))`;

/** Writes only when the value is still what the app read, so another installer's edit survives. */
const WRITE_WINDOWS_PATH = `$ErrorActionPreference='Stop'
$key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
$now=''
if ($key.GetValueNames() -contains 'Path') { $now=[string]$key.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
if ($now -cne [string]$env:SWC_PATH_EXPECTED) { $key.Close(); [Console]::Out.Write('changed'); exit 0 }
$kind=[Microsoft.Win32.RegistryValueKind]$env:SWC_PATH_KIND
if ($env:SWC_PATH_VALUE -eq '') { $key.DeleteValue('Path',$false) } else { $key.SetValue('Path',$env:SWC_PATH_VALUE,$kind) }
$key.Close()
[Environment]::SetEnvironmentVariable('SPECWITHCODE_PATH_REFRESH','1','User')
[Environment]::SetEnvironmentVariable('SPECWITHCODE_PATH_REFRESH',$null,'User')
[Console]::Out.Write('ok')`;

interface WindowsPath {
  readonly raw: string;
  readonly kind: string;
  readonly user: string;
  readonly machine: string;
}

const readWindowsPath = async (host: CommandLineToolHost): Promise<WindowsPath | null> => {
  const result = await host.run(POWERSHELL, [...POWERSHELL_ARGS, READ_WINDOWS_PATH], {
    timeoutMs: SHELL_PROBE_TIMEOUT_MS * 2,
  });
  if (result === null || result.code !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout.trim()) as Partial<WindowsPath>;
    if (typeof parsed.raw !== "string" || typeof parsed.kind !== "string") return null;
    return {
      raw: parsed.raw,
      kind: parsed.kind,
      user: typeof parsed.user === "string" ? parsed.user : parsed.raw,
      machine: typeof parsed.machine === "string" ? parsed.machine : "",
    };
  } catch {
    return null;
  }
};

class ToolFailure extends Error {
  readonly reason: CommandLineToolReason;
  constructor(
    code: CommandLineToolReasonCode,
    path: string | null = null,
    errno: string | null = null,
  ) {
    super(code);
    this.reason = { code, path, errno };
  }
}

const errnoOf = (error: unknown): string | null => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^E[A-Z]+$/.test(code) ? code : null;
};

const setWindowsPath = async (host: CommandLineToolHost, mode: "add" | "remove") => {
  const current = await readWindowsPath(host);
  if (current === null) throw new ToolFailure("path-read");
  // Only the two kinds Windows uses for Path; anything else is left exactly as it is.
  if (current.kind !== "String" && current.kind !== "ExpandString") {
    throw new ToolFailure("path-write", binDirectoryFor(host), current.kind);
  }
  const next = editWindowsPath(current.raw, binDirectoryFor(host), mode, (entry) =>
    entry.replace(/%([^%]+)%/g, (whole, name: string) => {
      const key = Object.keys(host.env).find((item) => item.toLowerCase() === name.toLowerCase());
      return key === undefined ? whole : (host.env[key] ?? whole);
    }),
  );
  if (next === current.raw) return;
  const result = await host.run(POWERSHELL, [...POWERSHELL_ARGS, WRITE_WINDOWS_PATH], {
    timeoutMs: SHELL_PROBE_TIMEOUT_MS * 2,
    env: { SWC_PATH_VALUE: next, SWC_PATH_KIND: current.kind, SWC_PATH_EXPECTED: current.raw },
  });
  if (result?.code === 0 && result.stdout.includes("changed")) {
    throw new ToolFailure("path-changed");
  }
  if (result === null || result.code !== 0 || !result.stdout.includes("ok")) {
    throw new ToolFailure("path-write", binDirectoryFor(host));
  }
};

// ---------------------------------------------------------------------------------------------
// PATH lookup

const WINDOWS_EXTENSIONS = [".com", ".exe", ".bat", ".cmd", ".ps1"];

const expandHome = (host: CommandLineToolHost, entry: string) => {
  if (host.platform === "win32") return entry;
  if (entry === "~" || entry.startsWith("~/")) return host.homeDirectory + entry.slice(1);
  return entry
    .replace(/^\$HOME(?=\/|$)/, host.homeDirectory)
    .replace(/^\$\{HOME\}(?=\/|$)/, host.homeDirectory);
};

interface PathLookup {
  readonly onPath: "yes" | "no" | "unknown";
  readonly shadowedBy: string | null;
}

/** Whether `candidate` is this same app's command by another route: a link chain or a launcher. */
const isThisAppsCommand = async (host: CommandLineToolHost, candidate: string) => {
  const [real, shim] = await Promise.all([
    host.fs.realpath(candidate),
    host.fs.realpath(bundleShimPathFor(host)),
  ]);
  if (real !== null && shim !== null && samePath(host.platform, real, shim)) return true;
  const text = await host.fs.readFile(candidate, MAX_LAUNCHER_BYTES);
  if (text === null) return false;
  if (host.platform === "win32") {
    const target = parseWindowsLauncher(text);
    return target !== null && samePath(host.platform, target, bundleShimPathFor(host));
  }
  const appImage = parseAppImageLauncher(text);
  const running = appImagePathFor(host);
  return appImage !== null && running !== null && samePath(host.platform, appImage, running);
};

/** Whether `entries` (in order) reach the command's folder, and any other `specwithcode` first. */
export const lookUpCommand = async (
  host: CommandLineToolHost,
  entries: ReadonlyArray<string> | null,
): Promise<PathLookup> => {
  if (entries === null) return { onPath: "unknown", shadowedBy: null };
  const path = pathFor(host.platform);
  const binDirectory = binDirectoryFor(host);
  const names =
    host.platform === "win32"
      ? WINDOWS_EXTENSIONS.map((ext) => `${COMMAND_NAME}${ext}`)
      : [COMMAND_NAME];
  for (const [index, raw] of entries.entries()) {
    const entry = expandHome(host, raw.trim());
    if (entry === "" || !path.isAbsolute(entry)) continue;
    if (samePath(host.platform, entry, binDirectory)) return { onPath: "yes", shadowedBy: null };
    for (const name of names) {
      const candidate = path.join(entry, name);
      // A shell skips what it cannot run.
      if (!(await host.fs.isExecutableFile(candidate))) continue;
      if (await isThisAppsCommand(host, candidate)) continue;
      const reached = entries
        .slice(index + 1)
        .some((item) =>
          samePath(host.platform, expandHome(host, item.trim()) || ".", binDirectory),
        );
      return { onPath: reached ? "yes" : "no", shadowedBy: candidate };
    }
  }
  return { onPath: "no", shadowedBy: null };
};

const terminalPathEntries = async (host: CommandLineToolHost): Promise<string[] | null> => {
  if (host.platform === "win32") {
    const windowsPath = await readWindowsPath(host);
    if (windowsPath === null) return null;
    // A new terminal's PATH is the machine PATH, then the user PATH.
    return [...windowsPath.machine.split(";"), ...windowsPath.user.split(";")].filter(
      (part) => part.trim() !== "",
    );
  }
  return probeShellPath(host);
};

// ---------------------------------------------------------------------------------------------
// State

const parseVersion = (output: string): string | null => {
  const match = /v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(output);
  return match ? match[1]! : null;
};

const readVersion = async (host: CommandLineToolHost): Promise<string | null> => {
  const commandPath = commandPathFor(host);
  const result =
    host.platform === "win32"
      ? // Through a variable: cmd expands `%` in a literal path, but not in a variable's value.
        await host.run(
          host.env.ComSpec || "cmd.exe",
          ["/d", "/s", "/c", '""%SWC_COMMAND%" --version"'],
          { timeoutMs: VERSION_TIMEOUT_MS, env: { SWC_COMMAND: commandPath } },
        )
      : await host.run(commandPath, ["--version"], { timeoutMs: VERSION_TIMEOUT_MS });
  if (result === null || result.code !== 0) return null;
  return parseVersion(result.stdout);
};

export const inspect = async (host: CommandLineToolHost): Promise<CommandLineToolState> => {
  const unavailable = await unavailableReason(host);
  const { install, pointsAt } = await classify(host);
  const [version, lookup, startupFile] = await Promise.all([
    install === "installed" || install === "other-copy" ? readVersion(host) : Promise.resolve(null),
    terminalPathEntries(host).then((entries) => lookUpCommand(host, entries)),
    host.platform === "win32" ? Promise.resolve(null) : startupFileFor(host),
  ]);
  return {
    platform: host.platform,
    unavailable,
    commandPath: commandPathFor(host),
    binDirectory: binDirectoryFor(host),
    install,
    pointsAt,
    version,
    appVersion: host.appVersion,
    onPath: lookup.onPath,
    shadowedBy: lookup.shadowedBy,
    startupFile,
    pathLine: host.platform === "win32" ? null : pathLineFor(host),
    startupLineAdded: (await startupLineIn(host, startupFile)) === "yes",
  };
};

// ---------------------------------------------------------------------------------------------
// Actions

/** Stops when what is at the command's path is no longer what was classified. */
const ensureUnchanged = async (host: CommandLineToolHost, identity: string) => {
  if ((await identityOf(host, commandPathFor(host))) !== identity) {
    throw new ToolFailure("changed", commandPathFor(host));
  }
};

/**
 * Points the command at this app: creates it when nothing is there (an exclusive create), or
 * replaces the app's own older entry after checking it is still the one classified.
 */
const writeCommand = async (host: CommandLineToolHost, identity: string) => {
  const path = pathFor(host.platform);
  const commandPath = commandPathFor(host);
  const replace = identity !== "none";
  const appImage = appImagePathFor(host);
  // The launcher names the AppImage for good: a relative path or a line break could never be
  // read back, and the command would lock itself out.
  if (appImage !== null && (!appImage.startsWith("/") || CONTROL_CHARACTERS.test(appImage))) {
    throw new ToolFailure("unsafe-path", appImage);
  }
  await host.fs.makeDirectory(binDirectoryFor(host));
  const temporary = replace
    ? path.join(path.dirname(commandPath), `.${path.basename(commandPath)}.${host.uniqueSuffix()}`)
    : commandPath;
  try {
    if (host.platform === "win32") {
      await host.fs.writeNewFile(temporary, renderWindowsLauncher(bundleShimPathFor(host)), 0o644);
    } else if (appImage !== null) {
      await host.fs.writeNewFile(temporary, renderAppImageLauncher(appImage), 0o755);
    } else {
      await host.fs.symlink(bundleShimPathFor(host), temporary);
    }
  } catch (error) {
    // Something appeared at the path after it was checked: the exclusive create refused it.
    if (!replace && errnoOf(error) === "EEXIST") throw new ToolFailure("changed", commandPath);
    throw error;
  }
  if (replace) {
    try {
      await ensureUnchanged(host, identity);
      await host.fs.rename(temporary, commandPath);
    } catch (error) {
      await host.fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
};

const failure = async (
  host: CommandLineToolHost,
  reason: CommandLineToolReason,
): Promise<CommandLineToolResult> => ({
  ok: false,
  reason,
  state: await inspect(host),
});

const reasonOf = (error: unknown, path: string | null): CommandLineToolReason =>
  error instanceof ToolFailure
    ? error.reason
    : { code: "write-failed", path, errno: errnoOf(error) };

const blocked = (host: CommandLineToolHost, code: CommandLineToolReasonCode) =>
  failure(host, { code, path: commandPathFor(host), errno: null });

export const install = async (host: CommandLineToolHost): Promise<CommandLineToolResult> => {
  const unavailable = await unavailableReason(host);
  if (unavailable !== null) return blocked(host, unavailable);
  const { install: current, identity } = await classify(host);
  if (current === "blocked-managed" || current === "blocked-other") return blocked(host, current);
  try {
    if (current !== "installed") await writeCommand(host, identity);
    if (host.platform === "win32") await setWindowsPath(host, "add");
  } catch (error) {
    return failure(host, reasonOf(error, commandPathFor(host)));
  }
  return { ok: true, state: await inspect(host) };
};

/** Adds the marked PATH line to the shell startup file (macOS and Linux), after the user asked. */
export const addToShellPath = async (host: CommandLineToolHost): Promise<CommandLineToolResult> => {
  if (host.platform === "win32") return install(host);
  const file = await startupFileFor(host);
  if (file === null) return failure(host, { code: "unknown-shell", path: null, errno: null });
  try {
    const present = await startupLineIn(host, file);
    if (present === "unreadable") throw new ToolFailure("startup-file-unreadable", file);
    if (present === "no") {
      const line = pathLineFor(host);
      if (shellName(host) === "fish") {
        await host.fs.makeDirectory(NodePath.posix.dirname(file));
        if ((await host.fs.lstat(file)) !== null) throw new ToolFailure("fish-file-exists", file);
        await host.fs.writeNewFile(file, FISH_FILE(line), 0o644);
      } else {
        const existing = await host.fs.readFile(file, MAX_STARTUP_FILE_BYTES);
        const separator =
          existing === null || existing === "" || existing.endsWith("\n") ? "" : "\n";
        await host.fs.appendFile(file, `${separator}${line}\n`);
      }
    }
  } catch (error) {
    return failure(
      host,
      error instanceof ToolFailure
        ? error.reason
        : { code: "startup-file-write", path: file, errno: errnoOf(error) },
    );
  } finally {
    forgetShellPath(host);
  }
  return { ok: true, state: await inspect(host) };
};

/** Takes the app's marked line out of every startup file it may have added it to. */
const removeStartupLines = async (host: CommandLineToolHost): Promise<CommandLineToolReason[]> => {
  const problems: CommandLineToolReason[] = [];
  const edit = async (
    file: string,
    change: (text: string) => string | null,
    deleteWhenEmpty: boolean,
  ) => {
    const text = await host.fs.readFile(file, MAX_STARTUP_FILE_BYTES);
    if (text === null) return;
    const next = change(text);
    if (next === null || next === text) return;
    try {
      if (deleteWhenEmpty && next.trim() === "") await host.fs.unlink(file);
      else await host.fs.rewriteFile(file, next);
    } catch (error) {
      problems.push({ code: "remove-partial", path: file, errno: errnoOf(error) });
    }
  };
  for (const file of knownStartupFiles(host)) {
    await edit(
      file,
      (text) => {
        const lines = text.split("\n");
        const kept = lines.filter((item) => item.replace(/\r$/, "") !== POSIX_LINE);
        return kept.length === lines.length ? null : kept.join("\n");
      },
      false,
    );
  }
  // The fish file is the app's own; anything the user added to it stays.
  await edit(
    FISH_FILE_PATH(host),
    (text) => {
      const lines = text.split("\n");
      const kept = lines.filter(
        (item) => ![STARTUP_LINE_MARKER, FISH_LINE].includes(item.replace(/\r$/, "")),
      );
      return kept.length === lines.length ? null : kept.join("\n");
    },
    true,
  );
  forgetShellPath(host);
  return problems;
};

/** Removes the app's own command and the PATH change the app made; nothing else. */
export const remove = async (host: CommandLineToolHost): Promise<CommandLineToolResult> => {
  const { install: current, identity } = await classify(host);
  if (current === "blocked-managed" || current === "blocked-other") return blocked(host, current);
  try {
    if (current !== "none") {
      await ensureUnchanged(host, identity);
      await host.fs.unlink(commandPathFor(host));
    }
  } catch (error) {
    return failure(host, reasonOf(error, commandPathFor(host)));
  }
  // The command is gone; say plainly what of the PATH change could not be undone.
  if (host.platform === "win32") {
    try {
      await setWindowsPath(host, "remove");
    } catch (error) {
      return failure(host, {
        code: "remove-partial-path",
        path: binDirectoryFor(host),
        errno: error instanceof ToolFailure ? error.reason.errno : errnoOf(error),
      });
    }
  } else {
    const problems = await removeStartupLines(host);
    if (problems.length > 0) return failure(host, problems[0]!);
  }
  return { ok: true, state: await inspect(host) };
};

/**
 * At launch: re-points the app's own command when it points at a copy of the app that is gone
 * (the app moved, or an old copy was deleted). Never creates the command or touches anything else.
 */
export const repairAtLaunch = async (
  host: CommandLineToolHost,
): Promise<"repaired" | "unchanged"> => {
  if ((await unavailableReason(host)) !== null) return "unchanged";
  const { install: current, identity } = await classify(host);
  if (current !== "broken") return "unchanged";
  await writeCommand(host, identity);
  return "repaired";
};
