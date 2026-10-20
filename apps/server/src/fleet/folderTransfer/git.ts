// @effect-diagnostics nodeBuiltinImport:off - the copy engine streams files and runs Git directly.
import * as NodeChildProcess from "node:child_process";

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
}

const SAFE_CONFIG = [
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

export function runGit(
  cwd: string,
  args: ReadonlyArray<string>,
  options: {
    readonly allowFailure?: boolean;
    readonly timeoutMs?: number;
    readonly env?: Readonly<Record<string, string>>;
  } = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      "git",
      ["--no-optional-locks", ...SAFE_CONFIG, "-C", cwd, ...args],
      {
        cwd,
        encoding: "buffer",
        maxBuffer: 256 * 1024 * 1024,
        timeout: options.timeoutMs ?? 10 * 60_000,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_NO_LAZY_FETCH: "1",
          GIT_LITERAL_PATHSPECS: "1",
          LC_ALL: "C",
          ...options.env,
        },
      },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? ((error as { code: number }).code ?? 1)
            : error
              ? null
              : 0;
        const result = {
          code: code ?? -1,
          stdout: Buffer.from(stdout).toString("utf8"),
          stderr: Buffer.from(stderr).toString("utf8"),
        };
        if (code === 0 || (options.allowFailure && code !== null)) resolve(result);
        else reject(new FolderGitError(args, code, result.stderr.slice(0, 2000)));
      },
    );
  });
}

export async function gitText(cwd: string, args: ReadonlyArray<string>): Promise<string> {
  return (await runGit(cwd, args)).stdout.trim();
}

/** NUL-separated output split into entries. */
export async function gitList(cwd: string, args: ReadonlyArray<string>): Promise<Array<string>> {
  return (await runGit(cwd, args)).stdout.split("\0").filter(Boolean);
}
