// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - the copy engine streams files and runs Git directly.
import * as NodeChildProcess from "node:child_process";

import { withGitHubSpawnEnvironment } from "../../sourceControl/gitHubSpawnEnvironment.ts";

/**
 * Git for the folder copy. Copied repositories carry the source's `.git/config`,
 * so hooks and the file-system monitor are switched off for every call, prompts
 * never block, and missing promisor objects are never fetched behind our back.
 */
export class FolderGitError extends Error {
  readonly args: ReadonlyArray<string>;
  readonly code: number | null;
  readonly stderr: string;
  constructor(args: ReadonlyArray<string>, code: number | null, stderr: string) {
    super(`git ${args[0] ?? ""} failed${code === null ? "" : ` (${code})`}`);
    this.args = args;
    this.code = code;
    this.stderr = stderr;
  }
}

export interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * Git's output was not valid UTF-8 (a file name made of other bytes): `stdout` holds
   * replacement characters, so no path read from it names the file Git meant.
   */
  readonly invalidUtf8?: true;
}

// A byte order mark that starts the output is the first name's own first character: kept.
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
/** The text of Git's output, and whether any of it was not UTF-8. */
const decoded = (bytes: Buffer): { readonly text: string; readonly invalid: boolean } => {
  try {
    return { text: strictUtf8.decode(bytes), invalid: false };
  } catch {
    return { text: bytes.toString("utf8"), invalid: true };
  }
};

export const SAFE_CONFIG = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "protocol.file.allow=always",
  "-c",
  "advice.detachedHead=false",
];

/**
 * The environment every Git call of this module runs with, `extra` on top. A
 * variable `extra` gives as undefined is removed, also when this process has it.
 */
export const gitEnvironment = (extra?: Readonly<Record<string, string | undefined>>) => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_LITERAL_PATHSPECS: "1",
    LC_ALL: "C",
    ...extra,
  };
  for (const [key, value] of Object.entries(extra ?? {})) if (value === undefined) delete env[key];
  return withGitHubSpawnEnvironment(env);
};

/** The arguments of a Git call in `cwd`, as `runGit` passes them. */
export const gitArguments = (cwd: string, args: ReadonlyArray<string>) => [
  "--no-optional-locks",
  ...SAFE_CONFIG,
  "-C",
  cwd,
  ...args,
];

export function runGit(
  cwd: string,
  args: ReadonlyArray<string>,
  options: {
    readonly allowFailure?: boolean;
    readonly timeoutMs?: number;
    readonly env?: Readonly<Record<string, string | undefined>>;
    /** Kills Git when aborted; the call then rejects with a FolderGitError. */
    readonly signal?: AbortSignal;
    /** Written to Git's standard input, which is then closed. */
    readonly input?: string;
  } = {},
): Promise<GitResult> {
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  // Git for Windows starts the real git under a launcher, so killing the launcher
  // would leave Git running and holding its folder: there the whole tree is killed.
  const killTree = process.platform === "win32";
  return new Promise((resolve, reject) => {
    let killed = false;
    const child = NodeChildProcess.execFile(
      "git",
      gitArguments(cwd, args),
      {
        cwd,
        encoding: "buffer",
        maxBuffer: 256 * 1024 * 1024,
        ...(killTree ? {} : { timeout: timeoutMs }),
        ...(options.signal && !killTree ? { signal: options.signal } : {}),
        env: gitEnvironment(options.env),
      },
      (error, stdout, stderr) => {
        stopWatching();
        const code = killed
          ? null
          : error && typeof (error as { code?: unknown }).code === "number"
            ? ((error as { code: number }).code ?? 1)
            : error
              ? null
              : 0;
        const out = decoded(Buffer.from(stdout));
        const result: GitResult = {
          code: code ?? -1,
          stdout: out.text,
          stderr: Buffer.from(stderr).toString("utf8"),
          ...(out.invalid ? { invalidUtf8: true as const } : {}),
        };
        if (code === 0 || (options.allowFailure && code !== null)) resolve(result);
        else reject(new FolderGitError(args, code, result.stderr.slice(0, 2000)));
      },
    );
    if (options.input !== undefined) {
      // Git may end before it has read everything: that is its own exit code, never a
      // stream error nobody handles.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(options.input);
    }
    const stop = () => {
      if (killed || child.exitCode !== null || child.pid === undefined) return;
      killed = true;
      const fallback = () => child.kill();
      NodeChildProcess.spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      })
        .on("error", fallback)
        .on("exit", (exit) => exit !== 0 && fallback());
    };
    const timer = killTree ? setTimeout(stop, timeoutMs) : undefined;
    if (killTree && options.signal) {
      if (options.signal.aborted) stop();
      else options.signal.addEventListener("abort", stop, { once: true });
    }
    function stopWatching() {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
    }
  });
}

export async function gitText(cwd: string, args: ReadonlyArray<string>): Promise<string> {
  return (await runGit(cwd, args)).stdout.trim();
}

/** NUL-separated output split into entries. */
export async function gitList(cwd: string, args: ReadonlyArray<string>): Promise<Array<string>> {
  return (await runGit(cwd, args)).stdout.split("\0").filter(Boolean);
}

/**
 * The URLs to try for an origin: itself, then its HTTPS form when it is an SSH
 * address (`git@host:owner/repo`, `ssh://git@host[:22]/owner/repo`). A machine without
 * an SSH key can often still clone over HTTPS: a public repository needs no
 * sign-in, and a private one uses the Git credential helper (such as `gh auth`).
 */
export function originCandidates(origin: string): Array<string> {
  const scp = /^[^@/]+@([^:/]+):(?!\/)(.+?)(?:\.git)?\/?$/.exec(origin);
  const ssh = /^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::(\d+))?\/(.+?)(?:\.git)?\/?$/.exec(origin);
  // A custom SSH port says nothing about where, or under which path, HTTPS is served.
  if (ssh?.[2] !== undefined && ssh[2] !== "22") return [origin];
  const host = scp?.[1] ?? ssh?.[1];
  const path = scp?.[2] ?? ssh?.[3];
  if (!host || !path) return [origin];
  return [origin, `https://${host}/${path}.git`];
}

/** SSH never asks for a password or passphrase; an unreachable host fails fast. */
const BATCH_SSH = { GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=15" };

let ownSsh: boolean | null = null;

/** The person set their own SSH program (a Windows agent, plink, a per-key command). */
function hasOwnSsh(): boolean {
  if (process.env.GIT_SSH_COMMAND || process.env.GIT_SSH) return true;
  if (ownSsh === null) {
    try {
      ownSsh =
        NodeChildProcess.execFileSync("git", ["config", "--get", "core.sshCommand"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 10_000,
        }).trim() !== "";
    } catch {
      // Exit 1: not set.
      ownSsh = false;
    }
  }
  return ownSsh;
}

/**
 * Git's environment for talking to a remote without a person at the keyboard.
 * `GIT_SSH_COMMAND` outranks `GIT_SSH` and `core.sshCommand`, so it is only set
 * when the person configured none of them.
 */
export function remoteEnv(): Readonly<Record<string, string>> {
  return hasOwnSsh() ? {} : BATCH_SSH;
}

/**
 * The first of `originCandidates(origin)` this machine can read, or null when
 * none answers (no network, no key, no access). Runs `git ls-remote`, which reads
 * refs only.
 */
export async function reachableOrigin(
  origin: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<string | null> {
  for (const candidate of originCandidates(origin)) {
    const result = await runGit(cwd, ["ls-remote", "--quiet", "--heads", candidate], {
      allowFailure: true,
      // A readable origin answers in seconds; this only bounds a network that never does.
      timeoutMs: 20_000,
      env: remoteEnv(),
      ...(signal ? { signal } : {}),
    }).catch(() => null);
    if (result?.code === 0) return candidate;
  }
  return null;
}
