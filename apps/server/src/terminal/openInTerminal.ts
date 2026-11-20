// @effect-diagnostics nodeBuiltinImport:off - writes one private script with plain file calls.
/**
 * Hands a code block to the Mac's Terminal app. Terminal is where a person
 * can answer anything a command asks, and it has its own privacy switches.
 * The block goes there as a `.command` file that removes itself as soon as it starts.
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
  /** Test seam: writes the script to an exclusively created file handle. */
  readonly writeScript?: (handle: NodeFSP.FileHandle, content: string) => Promise<void>;
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** Shells that read the script's `trap` and `cd ... ||` lines as written. */
const POSIX_SHELLS = new Set(["zsh", "bash", "sh", "dash", "ksh"]);

export interface PreparedTerminalAppRun {
  readonly command: string;
  readonly file: string;
  readonly cleanup: () => Promise<void>;
}

/** Writes the script and returns both the launch command and a pre-launch cleanup handle. */
export async function prepareTerminalAppRunHandle(
  input: TerminalAppRunInput,
): Promise<PreparedTerminalAppRun> {
  const file = NodePath.join(input.dir, `${input.name}.command`);
  const shell =
    input.shell &&
    !/[\r\n]/.test(input.shell) &&
    NodePath.isAbsolute(input.shell) &&
    POSIX_SHELLS.has(NodePath.basename(input.shell))
      ? input.shell
      : "/bin/zsh";
  const folders = [input.cwd, ...(input.fallbackCwd ? [input.fallbackCwd] : [])]
    .map((folder) => `cd ${shellQuote(folder)} 2>/dev/null`)
    .join(" || ");
  const quotedFile = shellQuote(file);
  const script = `#!${shell} -l
/bin/rm -f -- ${quotedFile}
${folders} || cd "$HOME" || exit 1
${input.command}
`;
  let handle: NodeFSP.FileHandle | undefined;
  try {
    handle = await NodeFSP.open(file, "wx", 0o700);
    if (input.writeScript) {
      await input.writeScript(handle, script);
    } else {
      await handle.writeFile(script);
    }
    await handle.close();
    handle = undefined;
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
      await NodeFSP.rm(file, { force: true }).catch(() => {});
    }
    throw error;
  }
  const marker = `\\033]${TERMINAL_ELEVATION_OSC};elevation=terminal-app;${input.nonce}\\007`;
  return {
    command: `if ${shellQuote(input.openPath ?? "/usr/bin/open")} -a Terminal ${quotedFile}; then printf '${marker}'; else code=$?; /bin/rm -f -- ${quotedFile}; exit "$code"; fi`,
    file,
    cleanup: () => NodeFSP.rm(file, { force: true }).catch(() => {}),
  };
}

/** Writes the script and returns the command that opens it in Terminal. */
export async function prepareTerminalAppRun(input: TerminalAppRunInput): Promise<string> {
  return (await prepareTerminalAppRunHandle(input)).command;
}
