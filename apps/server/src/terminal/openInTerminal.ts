// @effect-diagnostics nodeBuiltinImport:off - writes one private script with plain file calls.
/**
 * Hands a code block to the Mac's Terminal app. Terminal is where a person
 * can answer anything a command asks, and it has its own privacy switches.
 * The block goes there as a `.command` file that removes itself when it ends.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { TERMINAL_ELEVATION_OSC } from "@specweave-studio/contracts";

export interface TerminalAppRunInput {
  readonly command: string;
  readonly cwd: string;
  /** Where to start when `cwd` is gone (a removed worktree); home is the last resort. */
  readonly fallbackCwd?: string;
  /** A private folder (mode 0700) and a name unique to this run. */
  readonly dir: string;
  readonly name: string;
  /** Plain characters only; the caller checks it. */
  readonly nonce: string;
  readonly shell?: string;
  /** Test seam: the program that opens a file in an app. */
  readonly openPath?: string;
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** Shells that read the script's `trap` and `cd ... ||` lines as written. */
const POSIX_SHELLS = new Set(["zsh", "bash", "sh", "dash", "ksh"]);

/** Writes the script and returns the command that opens it in Terminal. */
export async function prepareTerminalAppRun(input: TerminalAppRunInput): Promise<string> {
  const file = NodePath.join(input.dir, `${input.name}.command`);
  const shell =
    input.shell &&
    NodePath.isAbsolute(input.shell) &&
    POSIX_SHELLS.has(NodePath.basename(input.shell))
      ? input.shell
      : "/bin/zsh";
  const folders = [input.cwd, ...(input.fallbackCwd ? [input.fallbackCwd] : [])]
    .map((folder) => `cd ${shellQuote(folder)} 2>/dev/null`)
    .join(" || ");
  const script = `#!${shell} -l
self=${shellQuote(file)}
trap 'rm -f "$self"' EXIT
${folders} || cd "$HOME" || exit 1
${input.command}
`;
  await NodeFSP.writeFile(file, script, { mode: 0o700, flag: "wx" });
  const marker = `\\033]${TERMINAL_ELEVATION_OSC};elevation=terminal-app;${input.nonce}\\007`;
  return `${shellQuote(input.openPath ?? "/usr/bin/open")} -a Terminal ${shellQuote(file)} && printf '${marker}'`;
}
