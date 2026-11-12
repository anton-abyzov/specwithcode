// @effect-diagnostics nodeBuiltinImport:off - runs once at startup and in sync env builders.
/**
 * Holds the project's Use worktrees setting for every provider. A thread that
 * works in the project's own checkout gets a `git` first on its PATH that
 * refuses project `git worktree add` and runs the real git for everything else, so an
 * agent cannot leave a worktree behind that no thread owns. The server never
 * puts the directory on its own PATH, so its git calls and worktree threads are
 * unaffected. POSIX disposable repositories may create worktrees within their
 * own physical temporary sandbox. Windows remains strict. There is no variable that turns it off: the agent could set one.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";

export const MANUAL_WORKTREE_REFUSAL =
  "Use worktrees is off for this project, so this checkout cannot add a worktree. Do not stop for this: keep working in the checkout this thread was given. In SpecWithCode the thread shows the user a one-click Turn on Use worktrees for this project button; once it is on, move into a worktree with studio_worktree_handoff.";

/** Global options that take their value as the next argument (`-C <dir>`). */
export const GIT_GLOBAL_OPTIONS_WITH_VALUE = [
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--config-env",
  "--attr-source",
] as const;

/** What a thread with its own folder reads when it commits or switches branch in a project clone. */
export const PROJECT_CLONE_REFUSAL =
  "This checkout is a clone in the project folder, and this thread has its own folder, so it cannot commit or switch branches here. Add the repository to the thread with studio_worktree_add_repository, then work in its worktree at the same relative path inside the thread's folder.";

export interface ManualWorktreeGuard {
  /** Holds the shim; never on the server's own PATH. */
  readonly directory: string;
  /** The git the shims run; absent only in guards built by hand. */
  readonly realGit?: string | undefined;
  readonly platform: NodeJS.Platform;
  /** The server's environment, whose PATH a child without its own builds on. */
  readonly serverEnvironment: NodeJS.ProcessEnv;
}

let installedGuard: ManualWorktreeGuard | null = null;

/** Set once the shim is written; null turns the guard off (no shim, no PATH change). */
export function setManualWorktreeGuard(guard: ManualWorktreeGuard | null): void {
  installedGuard = guard;
}

/** Whether git `args` (without `git` itself) run `git worktree add`. */
export function isGitWorktreeAdd(args: ReadonlyArray<string>): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if ((GIT_GLOBAL_OPTIONS_WITH_VALUE as ReadonlyArray<string>).includes(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return arg === "worktree" && args[index + 1] === "add";
  }
  return false;
}

/**
 * Whether git `args` commit or switch branch: `commit`, `switch`, and a
 * `checkout` that is not restoring paths after `--`.
 */
export function isGitCommitOrSwitch(args: ReadonlyArray<string>): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if ((GIT_GLOBAL_OPTIONS_WITH_VALUE as ReadonlyArray<string>).includes(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    if (arg === "commit" || arg === "switch") return true;
    return arg === "checkout" && !args.slice(index + 1).includes("--");
  }
  return false;
}

const shSingleQuoted = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** The POSIX sh shim; isGitWorktreeAdd is the same parse in TypeScript. */
export function posixGitShim(realGit: string, temporaryRoot?: string): string {
  const refusal = shSingleQuoted(`fatal: ${MANUAL_WORKTREE_REFUSAL}`);
  return `#!/bin/sh
# Written by SpecWithCode for threads that work in the project's own checkout.
real_git=${shSingleQuoted(realGit)}
# Fixture permission is limited to one physical temporary sandbox. The source
# repository and destination must both stay there; project repositories still
# cannot create worktrees, even when their destination is temporary.
fixture_worktree() (
  # Git -C resolves relative to cwd and never searches the shell CDPATH.
  unset CDPATH
  fixture_nl='
'
  # Preserve command output through substitution, then reject newline path bytes.
  # The command's one output delimiter is removed only after the sentinel.
  fixture_path() (
    fixture_value=$("$@" && printf '.') || exit 1
    fixture_value=\${fixture_value%.}
    fixture_value=\${fixture_value%"$fixture_nl"}
    case "$fixture_value" in *"$fixture_nl"*) exit 1 ;; esac
    printf '%s' "$fixture_value"
  )
  for fixture_arg do
    case "$fixture_arg" in *"$fixture_nl"*) exit 1 ;; esac
  done
  fixture_path pwd -P >/dev/null || exit 1
  fixture_temp=${shSingleQuoted(temporaryRoot ?? "")}
  [ -n "$fixture_temp" ] || exit 1
  case "$fixture_temp" in *"$fixture_nl"*) exit 1 ;; esac
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -C)
        [ "$#" -ge 2 ] || exit 1
        # Shell cd '-' uses OLDPWD; Git -C '-' is a literal directory.
        [ "$2" != - ] || exit 1
        cd -P -- "$2" || exit 1
        shift 2 ;;
      --no-pager|-P) shift ;;
      worktree) shift; break ;;
      *) exit 1 ;;
    esac
  done
  [ "$1" = add ] || exit 1
  shift
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -b|-B|-qb) [ "$#" -ge 2 ] || exit 1; shift 2 ;;
      --detach|-d|--force|-f|--quiet|-q|--no-checkout) shift ;;
      --) shift; break ;;
      -*) exit 1 ;;
      *) break ;;
    esac
  done
  [ "$#" -gt 0 ] || exit 1
  fixture_common=$(fixture_path "$real_git" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 1
  fixture_common=$(cd -P -- "$fixture_common" && fixture_path pwd -P) || exit 1
  case "$fixture_common" in "$fixture_temp"/*/*) ;; *) exit 1 ;; esac
  fixture_relative=\${fixture_common#"$fixture_temp"/}
  fixture_sandbox="$fixture_temp/\${fixture_relative%%/*}"
  fixture_parent=$(fixture_path dirname -- "$1") || exit 1
  # Prefix relative parents so a literal '-' cannot invoke shell OLDPWD.
  case "$fixture_parent" in /*) ;; *) fixture_parent="./$fixture_parent" ;; esac
  fixture_name=$(fixture_path basename -- "$1") || exit 1
  case "$fixture_name" in .|..|'') exit 1 ;; esac
  fixture_suffix=
  while [ ! -d "$fixture_parent" ]; do
    fixture_part=$(fixture_path basename -- "$fixture_parent") || exit 1
    case "$fixture_part" in .|..|'') exit 1 ;; esac
    [ ! -L "$fixture_parent" ] || exit 1
    fixture_suffix="/$fixture_part$fixture_suffix"
    fixture_parent=$(fixture_path dirname -- "$fixture_parent") || exit 1
  done
  fixture_parent=$(cd -P -- "$fixture_parent" && fixture_path pwd -P) || exit 1
  fixture_parent="$fixture_parent$fixture_suffix"
  case "$fixture_parent/" in "$fixture_sandbox/"*) ;; *) exit 1 ;; esac
  [ ! -L "$fixture_parent/$fixture_name" ] || exit 1
)
skip=
sub=
for arg do
  if [ -n "$skip" ]; then skip=; continue; fi
  if [ -n "$sub" ]; then
    if [ "$sub" = worktree ] && [ "$arg" = add ]; then
      if fixture_worktree "$@"; then exec "$real_git" "$@"; fi
      printf '%s\\n' ${refusal} >&2
      exit 128
    fi
    break
  fi
  case $arg in
    ${GIT_GLOBAL_OPTIONS_WITH_VALUE.join("|")}) skip=1 ;;
    -*) ;;
    *) sub=$arg ;;
  esac
done
exec "$real_git" "$@"
`;
}

/**
 * The sh shim for a thread that has its own folder: it refuses `git commit`
 * and a branch switch run inside a clone of its own (a `.git` folder) below
 * `projectRoot`, and runs the real git for everything else. The project
 * folder's own repository is exempt, because SpecWeave planning is committed
 * there, and so is everything outside the project folder, the thread's own
 * worktrees included. isGitCommitOrSwitch is the same parse in TypeScript.
 */
export function posixCloneGuardShim(realGit: string, projectRoot: string): string {
  const refusal = shSingleQuoted(`fatal: ${PROJECT_CLONE_REFUSAL}`);
  return `#!/bin/sh
# Written by SpecWithCode for threads that work in a folder of their own.
real_git=${shSingleQuoted(realGit)}
project_root=${shSingleQuoted(projectRoot.replace(/[\\/]+$/u, ""))}
# Exit 0 when the command runs in a clone inside the project folder.
in_project_clone() (
  unset CDPATH
  skip=
  for arg do
    if [ -n "$skip" ]; then
      if [ "$skip" = -C ] && [ "$arg" != - ]; then cd -- "$arg" 2>/dev/null || exit 1; fi
      skip=
      continue
    fi
    case $arg in
      ${GIT_GLOBAL_OPTIONS_WITH_VALUE.join("|")}) skip=$arg ;;
      -*) ;;
      *) break ;;
    esac
  done
  top=$("$real_git" rev-parse --show-toplevel 2>/dev/null) || exit 1
  [ -d "$top/.git" ] || exit 1
  case "$top" in "$project_root"/*) exit 0 ;; esac
  exit 1
)
skip=
sub=
restore=
for arg do
  if [ -n "$skip" ]; then skip=; continue; fi
  if [ -n "$sub" ]; then
    [ "$arg" = -- ] && restore=1
    continue
  fi
  case $arg in
    ${GIT_GLOBAL_OPTIONS_WITH_VALUE.join("|")}) skip=1 ;;
    -*) ;;
    *) sub=$arg ;;
  esac
done
case $sub in
  commit|switch) ;;
  checkout) [ -z "$restore" ] || exec "$real_git" "$@" ;;
  *) exec "$real_git" "$@" ;;
esac
if in_project_clone "$@"; then
  printf '%s\n' ${refusal} >&2
  exit 128
fi
exec "$real_git" "$@"
`;
}

/** A short stable name for a project folder's shim directory. */
function cloneGuardName(projectRoot: string): string {
  let hash = 5381;
  for (let index = 0; index < projectRoot.length; index += 1)
    hash = ((hash << 5) + hash + projectRoot.charCodeAt(index)) >>> 0;
  return `clones-${hash.toString(36)}`;
}

/**
 * The directory holding the clone guard for `projectRoot`, written on first
 * use and rewritten when the git or the folder changes. The folder is baked
 * into the shim, so no variable an agent could unset turns it off. Windows
 * gets the sh shim Git Bash finds and a `.cmd` that only runs git: cmd.exe
 * cannot resolve the checkout it runs in. Null when it cannot be written.
 */
export function cloneGuardDirectory(
  guard: ManualWorktreeGuard,
  projectRoot: string,
): string | null {
  if (guard.realGit === undefined) return null;
  try {
    const windows = guard.platform === "win32";
    const root = windows ? projectRoot.replaceAll("\\", "/") : NodeFS.realpathSync(projectRoot);
    const directory = NodePath.join(guard.directory, cloneGuardName(root));
    const files: ReadonlyArray<readonly [string, string]> = windows
      ? [
          ["git", posixCloneGuardShim(msysPath(guard.realGit), root)],
          ["git.cmd", `@echo off\r\n"${guard.realGit}" %*\r\nexit /b %errorlevel%\r\n`],
        ]
      : [["git", posixCloneGuardShim(guard.realGit, root)]];
    NodeFS.mkdirSync(directory, { recursive: true });
    for (const [name, content] of files) {
      const target = NodePath.join(directory, name);
      const current = NodeFS.existsSync(target) ? NodeFS.readFileSync(target, "utf8") : null;
      if (current === content) continue;
      const temporary = `${target}.${process.pid}.tmp`;
      NodeFS.writeFileSync(temporary, content, { mode: 0o755 });
      NodeFS.renameSync(temporary, target);
    }
    return directory;
  } catch {
    return null;
  }
}

/**
 * The Windows shim, found through PATHEXT by cmd.exe and PowerShell. cmd
 * splits unquoted arguments at `=`, `,` and `;` too, so `-c key=value` arrives
 * as two words and option values cannot be skipped reliably. It refuses any
 * bare `worktree` followed by `add` instead: stricter than isGitWorktreeAdd
 * (`git log worktree add` is refused too), never looser. The scan ends at a
 * missing argument (`[%1]`), not an empty one (`""`), and never wraps `%1` in
 * quotes, which a quoted argument with a space or `=` would turn into a syntax
 * error.
 */
export function windowsGitShim(realGit: string): string {
  return `@echo off\r
rem Written by SpecWithCode for threads that work in the project's own checkout.\r
call :sw_scan %*\r
if errorlevel 1 (\r
  >&2 echo fatal: ${MANUAL_WORKTREE_REFUSAL}\r
  exit /b 128\r
)\r
"${realGit}" %*\r
exit /b %errorlevel%\r
:sw_scan\r
if [%1]==[] exit /b 0\r
if "%~1"=="worktree" if "%~2"=="add" exit /b 1\r
shift\r
goto sw_scan\r
`;
}

/** `C:\Program Files\Git\cmd\git.exe` as Git Bash names it: `/c/Program Files/Git/cmd/git.exe`. */
export function msysPath(windowsPath: string): string {
  const drive = /^([A-Za-z]):[\\/]/.exec(windowsPath);
  const rest = windowsPath.replaceAll("\\", "/");
  return drive === null ? rest : `/${drive[1]!.toLowerCase()}/${rest.slice(3)}`;
}

/**
 * The shim files for `platform`. Windows gets the `.cmd` for cmd.exe and
 * PowerShell plus an extensionless sh script for Git Bash, which ignores
 * PATHEXT (the layout npm uses for its own commands). A program that starts
 * `git.exe` directly, without a shell, finds neither.
 */
export function manualWorktreeGuardFiles(
  platform: NodeJS.Platform,
  realGit: string,
  temporaryRoot?: string,
): ReadonlyArray<readonly [name: string, content: string]> {
  if (platform !== "win32") return [["git", posixGitShim(realGit, temporaryRoot)]];
  return [
    ["git.cmd", windowsGitShim(realGit)],
    ["git", posixGitShim(msysPath(realGit))],
  ];
}

/** The first git on `pathValue`, skipping the shim's own directory. */
export function resolveRealGit(
  pathValue: string | undefined,
  options: {
    readonly platform: NodeJS.Platform;
    readonly exclude?: string;
    readonly isExecutable?: (candidate: string) => boolean;
  },
): string | null {
  const platform = options.platform;
  const path = platform === "win32" ? NodePath.win32 : NodePath.posix;
  const name = platform === "win32" ? "git.exe" : "git";
  const isExecutable =
    options.isExecutable ??
    ((candidate: string) => {
      try {
        NodeFS.accessSync(
          candidate,
          platform === "win32" ? NodeFS.constants.F_OK : NodeFS.constants.X_OK,
        );
        return NodeFS.statSync(candidate).isFile();
      } catch {
        return false;
      }
    });
  for (const entry of (pathValue ?? "").split(path.delimiter)) {
    if (entry.length === 0 || !path.isAbsolute(entry)) continue;
    if (options.exclude !== undefined && path.resolve(entry) === path.resolve(options.exclude))
      continue;
    const candidate = path.join(entry, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/**
 * Writes the shim under `stateDir` for the git on the server's PATH, or returns
 * null when there is no git to wrap. Rewritten at every start, so a moved or
 * upgraded git is picked up.
 */
export function installManualWorktreeGuard(input: {
  readonly stateDir: string;
  readonly serverEnvironment: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
}): ManualWorktreeGuard | null {
  const { platform, serverEnvironment } = input;
  const directory = NodePath.join(input.stateDir, "agent-bin");
  const realGit = resolveRealGit(serverEnvironment[pathKey(serverEnvironment, platform)], {
    platform,
    exclude: directory,
  });
  if (realGit === null) return null;
  NodeFS.mkdirSync(directory, { recursive: true });
  for (const [name, content] of manualWorktreeGuardFiles(
    platform,
    realGit,
    NodeFS.realpathSync(NodeOS.tmpdir()),
  )) {
    const target = NodePath.join(directory, name);
    const temporary = `${target}.tmp`;
    NodeFS.writeFileSync(temporary, content, { mode: 0o755 });
    NodeFS.renameSync(temporary, target);
  }
  return { directory, platform, serverEnvironment, realGit };
}

function pathKey(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform !== "win32") return "PATH";
  return Object.keys(environment).find((key) => key.toUpperCase() === "PATH") ?? "Path";
}

/**
 * The PATH entry that puts the shim first, built on `environment`'s PATH (the
 * server's when it has none). Empty when the guard is off or not installed.
 */
export function manualWorktreeGuardPath(
  environment: NodeJS.ProcessEnv | undefined,
  /** True for a thread in the project's own checkout; the project folder for one with its own folder. */
  blocked: boolean | string | undefined,
  guard: ManualWorktreeGuard | null = installedGuard,
): Record<string, string> {
  if ((blocked !== true && typeof blocked !== "string") || guard === null) return {};
  const { platform, serverEnvironment } = guard;
  const directory = blocked === true ? guard.directory : cloneGuardDirectory(guard, blocked);
  if (directory === null) return {};
  const delimiter = platform === "win32" ? ";" : ":";
  const key = pathKey(environment ?? {}, platform);
  const base = environment?.[key] ?? serverEnvironment[pathKey(serverEnvironment, platform)] ?? "";
  // Either guard replaces the other: a thread has one or the other, never both.
  const rest = base
    .split(delimiter)
    .filter((entry) => entry.length > 0 && !entry.startsWith(guard.directory));
  return { [key]: [directory, ...rest].join(delimiter) };
}

/** `environment` with the shim first on its PATH when `blocked`. */
export function withManualWorktreeGuard(
  environment: NodeJS.ProcessEnv,
  blocked: boolean | string | undefined,
): NodeJS.ProcessEnv {
  const guardPath = manualWorktreeGuardPath(environment, blocked);
  return Object.keys(guardPath).length === 0 ? environment : { ...environment, ...guardPath };
}
