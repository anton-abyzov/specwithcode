// @effect-diagnostics nodeBuiltinImport:off - asks the person's login shell which folders it searches.
/**
 * What a new Terminal window on this machine has: the folders it searches for
 * commands, `XDG_CONFIG_HOME` when the person set one, and a short list of
 * variables the tools read there (a proxy, the key agent, a sign-in token a
 * shell profile exports). A check that looked only in system folders said a
 * tool was missing while the person ran it in Terminal, so the checks look
 * where Terminal looks. The server's own PATH is read once at start; this
 * asks the shell again, so a tool installed since then is found.
 *
 * Asked without waiting on it: a shell that takes seconds to start must not
 * stop the server from answering anyone else. The variables' values go to a
 * tool's environment and nowhere else: no answer, log or file holds one.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";

import { listLoginShellCandidates } from "@specweave-studio/shared/shell";

import { TERMINAL_VARIABLES } from "./catalog.ts";

export const TERMINAL_ENV_TIMEOUT_MS = 5000;
/** How long one read of the Terminal's environment stands. */
export const TERMINAL_ENV_KEEP_MS = 60_000;
/** A check the person asked for reads it again, but not more often than this. */
export const TERMINAL_ENV_FRESH_GAP_MS = 5000;

const MARK = "__SPECWITHCODE_TERMINAL_ENV__";

export interface TerminalEnvironment {
  readonly path: string;
  readonly xdgConfigHome: string | null;
  /** The listed variables the shell has set, by name. */
  readonly variables: Readonly<Record<string, string>>;
}

/** Runs the shell and gives what it printed, or null when it failed or took too long. */
export type ShellRun = (
  shell: string,
  args: ReadonlyArray<string>,
  timeoutMs: number,
) => Promise<string | null>;

export const runShell: ShellRun = (shell, args, timeoutMs) =>
  new Promise((resolve) => {
    NodeChildProcess.execFile(
      shell,
      [...args],
      {
        encoding: "utf8",
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
        // In the home folder, as a new Terminal window starts: a version manager's hook must not
        // read a project's `.nvmrc` because the server happens to run inside one.
        cwd: NodeOS.homedir(),
      },
      // An interactive shell without a terminal complains on stderr and may exit non-zero
      // after printing; what it printed is still the answer.
      (_error, stdout) => resolve(typeof stdout === "string" && stdout !== "" ? stdout : null),
    );
  });

const isName = (name: string) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name);

/** `printenv` works the same in zsh, bash and fish; a startup file's own output lands outside the marks. */
export const captureScript = (names: ReadonlyArray<string>) =>
  [
    `printf '%s' '${MARK}'`,
    ...["PATH", "XDG_CONFIG_HOME", ...names.filter(isName)].flatMap((name) => [
      `printenv ${name} || true`,
      `printf '%s' '${MARK}'`,
    ]),
  ].join("; ");

export function parseTerminalEnvironment(
  output: string,
  names: ReadonlyArray<string> = [],
): TerminalEnvironment | null {
  const parts = output.split(MARK);
  if (parts.length < 4) return null;
  const path = parts[1]!.trim();
  if (path === "") return null;
  const xdgConfigHome = parts[2]!.trim();
  const variables: Record<string, string> = {};
  for (const [index, name] of names.filter(isName).entries()) {
    const value = parts[index + 3]?.trim() ?? "";
    // A value over several lines is not one a tool was given; it is left out.
    if (value !== "" && !/[\r\n\0]/u.test(value)) variables[name] = value;
  }
  return { path, xdgConfigHome: xdgConfigHome === "" ? null : xdgConfigHome, variables };
}

/** The first login shell that answers; null when none does (the caller falls back to the server's own PATH). */
export async function readTerminalEnvironment(
  platform: NodeJS.Platform,
  shell: string | undefined,
  run: ShellRun = runShell,
  names: ReadonlyArray<string> = TERMINAL_VARIABLES,
): Promise<TerminalEnvironment | null> {
  if (platform === "win32") return null;
  for (const candidate of listLoginShellCandidates(platform, shell)) {
    const output = await run(candidate, ["-ilc", captureScript(names)], TERMINAL_ENV_TIMEOUT_MS);
    const environment = output === null ? null : parseTerminalEnvironment(output, names);
    if (environment !== null) return environment;
  }
  return null;
}

/**
 * One read of the Terminal's environment, shared: kept for a minute, read
 * again for a check the person asked for (they may just have installed the
 * tool), and never read twice at once or many times in a row, since each read
 * runs the person's whole shell startup.
 */
export class TerminalEnvironmentCache {
  private last: { readonly value: TerminalEnvironment | null; readonly at: number } | null = null;
  private reading: Promise<TerminalEnvironment | null> | null = null;
  private readonly read: () => Promise<TerminalEnvironment | null>;
  private readonly now: () => number;

  constructor(read: () => Promise<TerminalEnvironment | null>, now: () => number) {
    this.read = read;
    this.now = now;
  }

  get(fresh: boolean): Promise<TerminalEnvironment | null> {
    if (this.reading !== null) return this.reading;
    const keep = fresh ? TERMINAL_ENV_FRESH_GAP_MS : TERMINAL_ENV_KEEP_MS;
    if (this.last !== null && this.now() - this.last.at < keep)
      return Promise.resolve(this.last.value);
    const reading = this.read()
      .catch(() => null)
      .then((value) => {
        this.last = { value, at: this.now() };
        this.reading = null;
        return value;
      });
    this.reading = reading;
    return reading;
  }
}
