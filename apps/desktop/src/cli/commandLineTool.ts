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

export type CommandLineToolResult =
  | { readonly ok: true; readonly state: CommandLineToolState }
  | { readonly ok: false; readonly reason: string; readonly state: CommandLineToolState };

type PathFlavour = typeof NodePath.posix;

const pathFor = (platform: CommandLineToolPlatform): PathFlavour =>
  platform === "win32" ? NodePath.win32 : NodePath.posix;

const isAppImage = (host: CommandLineToolHost) =>
  host.platform === "linux" && typeof host.env.APPIMAGE === "string" && host.env.APPIMAGE !== "";

export const binDirectoryFor = (host: CommandLineToolHost): string => {
  const path = pathFor(host.platform);
  if (host.platform === "win32") {
    const localAppData = host.env.LOCALAPPDATA ?? path.join(host.homeDirectory, "AppData", "Local");
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

/** A copy of the app that may vanish: a disk image or a translocated copy on macOS. */
export const isTemporaryLocation = (host: CommandLineToolHost): boolean => {
  if (host.platform === "darwin") {
    return (
      host.bundlePath.startsWith("/Volumes/") || host.bundlePath.includes("/AppTranslocation/")
    );
  }
  if (isAppImage(host)) {
    const appImage = host.env.APPIMAGE!;
    return appImage.startsWith("/tmp/");
  }
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
    'mkfifo "$work/mount"',
    '"$appimage" --appimage-mount >"$work/mount" &',
    "mounter=$!",
    'cleanup() { kill "$mounter" 2>/dev/null || :; wait "$mounter" 2>/dev/null || :; rm -rf "$work"; }',
    "trap cleanup EXIT",
    "trap 'exit 130' INT",
    "trap 'exit 143' TERM",
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

/** The Windows launcher: one line that hands its arguments to the bundle's shim. */
export const renderWindowsLauncher = (shim: string): string =>
  [
    "@echo off",
    `rem ${LAUNCHER_MARKER}`,
    "rem Runs the specwithcode command inside the SpecWithCode app. The app wrote this",
    "rem (Settings > Machines > Command line) and keeps it pointed at the app.",
    `"${shim.replaceAll("%", "%%")}" %*`,
    "",
  ].join("\r\n");

const parseWindowsLauncher = (text: string): string | null => {
  if (!text.startsWith(`@echo off\r\nrem ${LAUNCHER_MARKER}\r\n`)) return null;
  const line = text.split("\r\n").find((item) => item.startsWith('"') && item.endsWith('" %*'));
  if (line === undefined) return null;
  const shim = line.slice(1, -'" %*'.length).replaceAll("%%", "%");
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

interface Classified {
  readonly install: CommandLineToolInstall;
  readonly pointsAt: string | null;
}

/** What is at the command's path, and whether it is the app's own. */
export const classify = async (host: CommandLineToolHost): Promise<Classified> => {
  const path = pathFor(host.platform);
  const commandPath = commandPathFor(host);
  const entry = await host.fs.lstat(commandPath);
  if (entry === null) return { install: "none", pointsAt: null };
  if (entry.kind === "symlink") {
    if (host.platform === "win32") return { install: "blocked-other", pointsAt: null };
    const raw = await host.fs.readlink(commandPath);
    if (raw === null) return { install: "blocked-other", pointsAt: null };
    const target = path.resolve(path.dirname(commandPath), raw);
    if (!isBundleShimTarget(target)) {
      // install.sh used to link into $STUDIO_HOME/runtime/versions.
      return {
        install: target.includes("/runtime/versions/") ? "blocked-managed" : "blocked-other",
        pointsAt: null,
      };
    }
    if (!(await host.fs.exists(target))) return { install: "broken", pointsAt: target };
    if (isAppImage(host) || !samePath(host.platform, target, bundleShimPathFor(host))) {
      return { install: "other-copy", pointsAt: target };
    }
    return { install: "installed", pointsAt: target };
  }
  if (entry.kind !== "file") return { install: "blocked-other", pointsAt: null };
  const text = await host.fs.readFile(commandPath, MAX_LAUNCHER_BYTES);
  if (text === null) return { install: "blocked-other", pointsAt: null };
  if (host.platform === "win32") {
    const shim = parseWindowsLauncher(text);
    if (shim === null) return { install: "blocked-other", pointsAt: null };
    if (!(await host.fs.exists(shim))) return { install: "broken", pointsAt: shim };
    return samePath(host.platform, shim, bundleShimPathFor(host))
      ? { install: "installed", pointsAt: shim }
      : { install: "other-copy", pointsAt: shim };
  }
  const appImage = parseAppImageLauncher(text);
  if (appImage !== null) {
    if (!(await host.fs.exists(appImage))) return { install: "broken", pointsAt: appImage };
    return isAppImage(host) && samePath(host.platform, appImage, host.env.APPIMAGE!)
      ? { install: "installed", pointsAt: appImage }
      : { install: "other-copy", pointsAt: appImage };
  }
  return {
    install: isManagedWrapperText(text) ? "blocked-managed" : "blocked-other",
    pointsAt: null,
  };
};

export const unavailableReason = async (
  host: CommandLineToolHost,
): Promise<CommandLineToolUnavailable | null> => {
  if (!host.isPackaged) return "development";
  if (isTemporaryLocation(host)) return "temporary-location";
  if (!(await host.fs.exists(bundleShimPathFor(host)))) return "missing-shim";
  return null;
};

// ---------------------------------------------------------------------------------------------
// Shell PATH (macOS and Linux)

const shellName = (host: CommandLineToolHost) =>
  pathFor(host.platform).basename(host.userShell ?? host.env.SHELL ?? "");

/** The shell startup file the app may add its line to, or null for a shell it does not know. */
export const startupFileFor = async (host: CommandLineToolHost): Promise<string | null> => {
  const path = NodePath.posix;
  const home = host.homeDirectory;
  switch (shellName(host)) {
    case "zsh": {
      const directory = host.env.ZDOTDIR || home;
      return path.join(directory, host.platform === "darwin" ? ".zprofile" : ".zshrc");
    }
    case "bash": {
      if (host.platform !== "darwin") return path.join(home, ".bashrc");
      // bash reads only the first of these; creating .bash_profile would hide an existing .profile.
      for (const name of [".bash_profile", ".bash_login", ".profile"]) {
        const candidate = path.join(home, name);
        if ((await host.fs.lstat(candidate)) !== null) return candidate;
      }
      return path.join(home, ".bash_profile");
    }
    case "fish":
      return path.join(home, ".config", "fish", "conf.d", "specwithcode.fish");
    default:
      return null;
  }
};

export const pathLineFor = (host: CommandLineToolHost): string =>
  shellName(host) === "fish"
    ? `set -gx PATH $HOME/.local/bin $PATH ${STARTUP_LINE_MARKER}`
    : `export PATH="$HOME/.local/bin:$PATH" ${STARTUP_LINE_MARKER}`;

const FISH_FILE = (line: string) => `${STARTUP_LINE_MARKER}\n${line}\n`;

const hasStartupLine = async (host: CommandLineToolHost, file: string | null) => {
  if (file === null) return false;
  const text = await host.fs.readFile(file, 1024 * 1024);
  if (text === null) return false;
  return text.split(/\r?\n/).includes(pathLineFor(host));
};

/** The PATH a new terminal gets, read from the user's own shell; null when it cannot be read. */
export const probeShellPath = async (host: CommandLineToolHost): Promise<string[] | null> => {
  const shell =
    host.userShell || host.env.SHELL || (host.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  const fish = shellName(host) === "fish";
  const script = fish
    ? `printf '${PATH_START}%s${PATH_END}\\n' (string join : $PATH)`
    : `printf '${PATH_START}%s${PATH_END}\\n' "$PATH"`;
  // A login, interactive shell from a clean environment: what a new terminal (or, on Linux, the
  // next session) sees. The app's own PATH must not leak in; it may already hold ~/.local/bin.
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
  const result = await host.run(shell, ["-l", "-i", "-c", script], {
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
  const parts = value.split(";").filter((part) => part.trim() !== "");
  const same = (entry: string) => samePath("win32", expand(entry.trim()), directory);
  if (mode === "add") return parts.some(same) ? parts.join(";") : [...parts, directory].join(";");
  return parts.filter((part) => !same(part)).join(";");
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

const WRITE_WINDOWS_PATH = `$ErrorActionPreference='Stop'
$key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
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
      kind: parsed.kind === "String" ? "String" : "ExpandString",
      user: typeof parsed.user === "string" ? parsed.user : parsed.raw,
      machine: typeof parsed.machine === "string" ? parsed.machine : "",
    };
  } catch {
    return null;
  }
};

const writeWindowsPath = async (host: CommandLineToolHost, value: string, kind: string) => {
  const result = await host.run(POWERSHELL, [...POWERSHELL_ARGS, WRITE_WINDOWS_PATH], {
    timeoutMs: SHELL_PROBE_TIMEOUT_MS * 2,
    env: { SWC_PATH_VALUE: value, SWC_PATH_KIND: kind },
  });
  if (result === null || result.code !== 0 || !result.stdout.includes("ok")) {
    throw new Error(
      `Could not update the user PATH${result?.stderr ? `: ${result.stderr.trim()}` : ""}`,
    );
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
  for (const raw of entries) {
    const entry = expandHome(host, raw.trim());
    if (entry === "" || !path.isAbsolute(entry)) continue;
    if (samePath(host.platform, entry, binDirectory)) return { onPath: "yes", shadowedBy: null };
    for (const name of names) {
      const candidate = path.join(entry, name);
      if ((await host.fs.lstat(candidate)) === null) continue;
      // A second link to this same app's shim is not in the way.
      if (host.platform !== "win32") {
        const target = await host.fs.readlink(candidate);
        if (
          target !== null &&
          samePath(host.platform, path.resolve(entry, target), bundleShimPathFor(host))
        ) {
          continue;
        }
      }
      const rest = entries.slice(entries.indexOf(raw) + 1);
      const reached = rest.some((item) =>
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
      ? await host.run(
          host.env.ComSpec || "cmd.exe",
          ["/d", "/s", "/c", `""${commandPath}" --version"`],
          { timeoutMs: VERSION_TIMEOUT_MS },
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
    startupLineAdded: await hasStartupLine(host, startupFile),
  };
};

// ---------------------------------------------------------------------------------------------
// Actions

const BLOCKED_REASON: Record<"blocked-managed" | "blocked-other", (path: string) => string> = {
  "blocked-managed": (path) =>
    `${path} is the specwithcode command from the command-line install of SpecWithCode. It is kept as it is; that install keeps it up to date.`,
  "blocked-other": (path) =>
    `Something else is already at ${path}. It was not changed. Move it away if you want the app's command there.`,
};

/** Points the command at this app: creates it, or replaces the app's own older entry. */
const writeCommand = async (host: CommandLineToolHost, replace: boolean) => {
  const path = pathFor(host.platform);
  const commandPath = commandPathFor(host);
  await host.fs.makeDirectory(binDirectoryFor(host));
  const temporary = replace
    ? path.join(path.dirname(commandPath), `.${path.basename(commandPath)}.${host.uniqueSuffix()}`)
    : commandPath;
  if (host.platform === "win32") {
    await host.fs.writeNewFile(temporary, renderWindowsLauncher(bundleShimPathFor(host)), 0o644);
  } else if (isAppImage(host)) {
    await host.fs.writeNewFile(temporary, renderAppImageLauncher(host.env.APPIMAGE!), 0o755);
  } else {
    await host.fs.symlink(bundleShimPathFor(host), temporary);
  }
  if (replace) {
    try {
      await host.fs.rename(temporary, commandPath);
    } catch (error) {
      await host.fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
};

const failure = async (
  host: CommandLineToolHost,
  reason: string,
): Promise<CommandLineToolResult> => ({
  ok: false,
  reason,
  state: await inspect(host),
});

const UNAVAILABLE_REASON: Record<CommandLineToolUnavailable, string> = {
  development: "A development build has no command to install.",
  "temporary-location":
    "This copy of the app runs from a disk image or a temporary folder. Move SpecWithCode to Applications, open it from there, then install the command.",
  "missing-shim": "This copy of the app has no specwithcode command inside it. Reinstall the app.",
};

export const install = async (host: CommandLineToolHost): Promise<CommandLineToolResult> => {
  const unavailable = await unavailableReason(host);
  if (unavailable !== null) return failure(host, UNAVAILABLE_REASON[unavailable]);
  const { install: current } = await classify(host);
  if (current === "blocked-managed" || current === "blocked-other") {
    return failure(host, BLOCKED_REASON[current](commandPathFor(host)));
  }
  try {
    if (current !== "installed") await writeCommand(host, current !== "none");
    if (host.platform === "win32") await setWindowsPath(host, "add");
  } catch (error) {
    return failure(host, error instanceof Error ? error.message : String(error));
  }
  return { ok: true, state: await inspect(host) };
};

const setWindowsPath = async (host: CommandLineToolHost, mode: "add" | "remove") => {
  const current = await readWindowsPath(host);
  if (current === null) throw new Error("Could not read the user PATH.");
  const next = editWindowsPath(current.raw, binDirectoryFor(host), mode, (entry) =>
    entry.replace(/%([^%]+)%/g, (whole, name: string) => {
      const key = Object.keys(host.env).find((item) => item.toLowerCase() === name.toLowerCase());
      return key === undefined ? whole : (host.env[key] ?? whole);
    }),
  );
  if (next !== current.raw) await writeWindowsPath(host, next, current.kind);
};

/** Adds the marked PATH line to the shell startup file (macOS and Linux), after the user asked. */
export const addToShellPath = async (host: CommandLineToolHost): Promise<CommandLineToolResult> => {
  if (host.platform === "win32") return install(host);
  const file = await startupFileFor(host);
  if (file === null) {
    return failure(host, "The app does not know this shell's startup file. Add the line yourself.");
  }
  try {
    if (!(await hasStartupLine(host, file))) {
      const line = pathLineFor(host);
      if (shellName(host) === "fish") {
        await host.fs.makeDirectory(NodePath.posix.dirname(file));
        if ((await host.fs.lstat(file)) !== null) {
          return failure(
            host,
            `${file} already exists and was not changed. Add the line yourself.`,
          );
        }
        await host.fs.writeNewFile(file, FISH_FILE(line), 0o644);
      } else {
        const existing = await host.fs.readFile(file, 1024 * 1024);
        const separator =
          existing === null || existing === "" || existing.endsWith("\n") ? "" : "\n";
        await host.fs.appendFile(file, `${separator}${line}\n`);
      }
    }
  } catch (error) {
    return failure(host, error instanceof Error ? error.message : String(error));
  }
  return { ok: true, state: await inspect(host) };
};

const removeStartupLine = async (host: CommandLineToolHost) => {
  const file = await startupFileFor(host);
  if (file === null) return;
  const text = await host.fs.readFile(file, 1024 * 1024);
  if (text === null) return;
  const line = pathLineFor(host);
  if (shellName(host) === "fish") {
    if (text === FISH_FILE(line)) await host.fs.unlink(file);
    return;
  }
  const lines = text.split("\n");
  const kept = lines.filter((item) => item.replace(/\r$/, "") !== line);
  if (kept.length !== lines.length) await host.fs.rewriteFile(file, kept.join("\n"));
};

/** Removes the app's own command and the PATH change the app made; nothing else. */
export const remove = async (host: CommandLineToolHost): Promise<CommandLineToolResult> => {
  const { install: current } = await classify(host);
  if (current === "blocked-managed" || current === "blocked-other") {
    return failure(host, BLOCKED_REASON[current](commandPathFor(host)));
  }
  try {
    if (current !== "none") await host.fs.unlink(commandPathFor(host));
    if (host.platform === "win32") await setWindowsPath(host, "remove");
    else await removeStartupLine(host);
  } catch (error) {
    return failure(host, error instanceof Error ? error.message : String(error));
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
  const { install: current } = await classify(host);
  if (current !== "broken") return "unchanged";
  await writeCommand(host, true);
  return "repaired";
};
