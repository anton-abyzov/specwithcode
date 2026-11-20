/**
 * Keeps a running server's PATH current. `fixPath` reads the login shell once
 * at start; an installer that adds a folder to the shell's startup files after
 * that would otherwise stay invisible until a restart.
 *
 * A call is cheap unless something says the PATH may have moved: it compares a
 * mark of the shell's startup files (stat only) and reads the login shell again
 * only when that mark changed or the caller insists. PATH only grows here;
 * whatever was on it stays until the server restarts.
 *
 * @module serverPath
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";

import { HostProcessEnvironment, HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import {
  listLoginShellCandidates,
  mergePathEntries,
  mergePathValues,
  readEnvironmentFromLoginShellAsync,
  readEnvPath,
  resolveKnownPosixCliDirs,
  resolveKnownWindowsCliDirs,
} from "@specweave-studio/shared/shell";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

/** A read just finished answers the next caller too. */
const READ_REUSE_MS = 2_000;
/** The startup files are looked at no more often than this. */
const MARK_REUSE_MS = 2_000;
/** Windows keeps PATH in the registry, with no file to watch, so it is asked on a timer. */
const WINDOWS_REREAD_MS = 30_000;
/** One read may take this long in all, however many shells or registry keys it asks. */
export const PATH_READ_LIMIT_MS = 5_000;
/** A caller waits for the read, which is over by its limit, and a moment for it to settle. */
const WAIT_LIMIT = Duration.millis(PATH_READ_LIMIT_MS + 500);
/** A shell that did not answer is not asked again by itself for this long. */
const FAILED_READ_RETRY_MS = 60_000;

const HOME_STARTUP_FILES = [
  ".zshenv",
  ".zprofile",
  ".zshrc",
  ".zlogin",
  ".bash_profile",
  ".bash_login",
  ".profile",
  ".bashrc",
  ".config/fish/config.fish",
];
const ZSH_STARTUP_FILES = [".zshenv", ".zprofile", ".zshrc", ".zlogin"];
const SYSTEM_STARTUP_PATHS = [
  "/etc/paths",
  "/etc/paths.d",
  "/etc/profile",
  "/etc/profile.d",
  "/etc/zshenv",
  "/etc/zprofile",
  "/etc/zshrc",
  "/etc/environment",
];

/**
 * A mark of the files a login shell builds PATH from. Stat only: it changes
 * when one of them is written, added or removed, and says nothing of what is
 * in them.
 */
export const startupFilesMark = (
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Effect.Effect<string, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    if (platform === "win32") return "registry";
    const fs = yield* FileSystem.FileSystem;
    const home = environment.HOME?.trim() || NodeOS.homedir();
    const zshFolder = environment.ZDOTDIR?.trim();
    const files = [
      ...HOME_STARTUP_FILES.map((name) => `${home}/${name}`),
      ...(zshFolder && zshFolder !== home
        ? ZSH_STARTUP_FILES.map((name) => `${zshFolder}/${name}`)
        : []),
      ...SYSTEM_STARTUP_PATHS,
    ];
    const marks = yield* Effect.forEach(
      files,
      (file) =>
        fs.stat(file).pipe(
          Effect.map(
            (info) =>
              `${Number(info.size)}:${Option.match(info.mtime, {
                onNone: () => "",
                onSome: (time) => String(time.getTime()),
              })}`,
          ),
          Effect.orElseSucceed(() => "-"),
        ),
      { concurrency: "unbounded" },
    );
    return marks.join("|");
  });

type ExecFile = (
  file: string,
  args: ReadonlyArray<string>,
  options: { readonly timeout: number },
) => Promise<string>;

const execFile: ExecFile = (file, args, options) =>
  new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      file,
      [...args],
      { encoding: "utf8", timeout: options.timeout, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });

function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const wanted = name.toUpperCase();
  for (const [key, value] of Object.entries(environment)) {
    if (key.toUpperCase() === wanted) return value;
  }
  return undefined;
}

/**
 * The `Path` value in one `reg query ... /v Path` answer, with `%NAME%`
 * references filled in from the environment as Windows does for a new process.
 */
export function parseRegistryPath(output: string, environment: NodeJS.ProcessEnv) {
  const value = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*?)\s*$/im.exec(output)?.[1];
  if (!value) return undefined;
  return value.replace(
    /%([^%;]+)%/g,
    (whole, name: string) => environmentValue(environment, name) ?? whole,
  );
}

const REGISTRY_PATH_KEYS = [
  "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
  "HKCU\\Environment",
];

/** PATH as a process started now would get it: the machine's folders, then the person's. */
export async function readWindowsRegistryPath(
  environment: NodeJS.ProcessEnv,
  run: ExecFile = execFile,
  limitMs = PATH_READ_LIMIT_MS,
): Promise<string | undefined> {
  const parts: string[] = [];
  const deadline = performance.now() + limitMs;
  for (const key of REGISTRY_PATH_KEYS) {
    // Whole milliseconds: a child process refuses a fractional limit.
    const left = Math.floor(deadline - performance.now());
    if (left <= 0) break;
    try {
      const value = parseRegistryPath(
        await run("reg.exe", ["query", key, "/v", "Path"], { timeout: left }),
        environment,
      );
      if (value) parts.push(value);
    } catch {
      // A key that cannot be read leaves the other one, and the PATH already held.
    }
  }
  return parts.length > 0 ? parts.join(";") : undefined;
}

/**
 * Asks each shell in turn until one answers, all within one limit: a shell
 * that hangs leaves the next one only what is left of it.
 */
export async function readShellPathWithin(
  shells: ReadonlyArray<string>,
  limitMs: number,
  read: (shell: string, timeoutMs: number) => Promise<string | undefined>,
): Promise<string | undefined> {
  const deadline = performance.now() + limitMs;
  for (const shell of shells) {
    // Whole milliseconds: a child process refuses a fractional limit.
    const left = Math.floor(deadline - performance.now());
    if (left <= 0) break;
    try {
      const path = await read(shell, left);
      if (path) return path;
    } catch {
      // The next shell is asked; with no answer at all the PATH stays as it is.
    }
  }
  return undefined;
}

async function readLoginShellPath(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  if (platform === "win32") return readWindowsRegistryPath(environment);
  return readShellPathWithin(
    listLoginShellCandidates(platform, environment.SHELL),
    PATH_READ_LIMIT_MS,
    async (shell, timeoutMs) =>
      (await readEnvironmentFromLoginShellAsync(shell, ["PATH"], undefined, timeoutMs)).PATH,
  );
}

export type LoginShellPathReader = typeof readLoginShellPath;

/** How the PATH a new login would get is read; tests answer it themselves. */
export const LoginShellPath = Context.Reference<LoginShellPathReader>(
  "@specweave-studio/server/serverPath/LoginShellPath",
  { defaultValue: () => readLoginShellPath },
);

function pathKey(environment: NodeJS.ProcessEnv): string {
  return Object.keys(environment).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
}

/**
 * Folds a freshly read PATH and the usual installer folders into the
 * environment. macOS and Linux follow the shell's own order, as at start;
 * Windows keeps the order it has and adds what is new. Nothing is dropped.
 */
export function mergeServerPath(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  freshPath: string | undefined,
): void {
  const current = readEnvPath(environment);
  const merged =
    platform === "win32"
      ? mergePathValues(
          mergePathValues(current, freshPath, platform),
          resolveKnownWindowsCliDirs(environment).join(";"),
          platform,
        )
      : mergePathEntries(
          mergePathEntries(freshPath, current, platform),
          resolveKnownPosixCliDirs(environment, platform).join(":"),
          platform,
        );
  if (merged && merged !== current) environment[pathKey(environment)] = merged;
}

interface PathState {
  /** The startup files as they were when the shell last answered; null before the first look. */
  shellMark: string | null;
  markedAt: number;
  readAt: number;
  /** When the shell last gave no answer; a person's click asks again at once. */
  failedAt: number;
  reading: Promise<void> | null;
}

/** Keyed by the environment it keeps current, so a test's own environment starts clean. */
const states = new WeakMap<NodeJS.ProcessEnv, PathState>();

function stateOf(environment: NodeJS.ProcessEnv): PathState {
  let state = states.get(environment);
  if (!state) {
    state = {
      shellMark: null,
      markedAt: Number.NEGATIVE_INFINITY,
      readAt: Number.NEGATIVE_INFINITY,
      failedAt: Number.NEGATIVE_INFINITY,
      reading: null,
    };
    states.set(environment, state);
  }
  return state;
}

/**
 * Records the shell's startup files as they are now. Run once at server start,
 * right after `fixPath` read the shell: a file an installer changes from then
 * on counts as a change, also when nobody has looked at Providers yet.
 */
export const noteServerPathRead: Effect.Effect<void, never, FileSystem.FileSystem> = Effect.gen(
  function* () {
    const platform = yield* HostProcessPlatform;
    const environment = yield* HostProcessEnvironment;
    stateOf(environment).shellMark = yield* startupFilesMark(environment, platform);
  },
);

/**
 * Brings the server's PATH up to date. `force` asks the login shell again
 * whatever the startup files say (a person pressed Check again); without it
 * the shell is asked only when one of those files changed since the last read.
 * One read runs at a time and later callers share it. Never fails: a shell
 * that does not answer leaves the PATH as it was.
 */
export const refreshServerPath = Effect.fn("refreshServerPath")(function* (options: {
  readonly force: boolean;
}): Effect.fn.Return<void, never, FileSystem.FileSystem> {
  const platform = yield* HostProcessPlatform;
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") return;
  const environment = yield* HostProcessEnvironment;
  const state = stateOf(environment);
  const now = yield* Clock.currentTimeMillis;
  if (!options.force && state.reading === null && now - state.markedAt < MARK_REUSE_MS) return;
  state.markedAt = now;

  const mark = yield* startupFilesMark(environment, platform);
  // Without a note from server start, the first look is the baseline.
  const firstLook = state.shellMark === null;
  if (firstLook) state.shellMark = mark;
  const moved =
    (platform === "win32"
      ? now - state.readAt >= WINDOWS_REREAD_MS
      : !firstLook && state.shellMark !== mark) && now - state.failedAt >= FAILED_READ_RETRY_MS;
  const wanted = options.force || moved;

  if (state.reading === null && wanted && now - state.readAt >= READ_REUSE_MS) {
    const read = yield* LoginShellPath;
    state.reading = read(environment, platform)
      .then(
        (freshPath) => {
          if (freshPath === undefined) {
            state.failedAt = now;
            return;
          }
          // Only an answer settles the change; a shell that failed is asked again later.
          state.shellMark = mark;
          state.failedAt = Number.NEGATIVE_INFINITY;
          mergeServerPath(environment, platform, freshPath);
        },
        () => {
          state.failedAt = now;
        },
      )
      .finally(() => {
        state.reading = null;
      });
  }
  const reading = state.reading;
  if (reading !== null) {
    yield* Effect.promise(() => reading).pipe(Effect.timeoutOption(WAIT_LIMIT));
    state.readAt = yield* Clock.currentTimeMillis;
    // The installer folders count whatever the shell said.
    mergeServerPath(environment, platform, undefined);
    return;
  }
  // No read: the installer folders made since the server started still count.
  mergeServerPath(environment, platform, undefined);
});
