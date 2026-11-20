// @effect-diagnostics nodeBuiltinImport:off - writes one private script with plain file calls.
/**
 * Hands a code block to the Mac's Terminal app. Terminal is where a person
 * can answer anything a command asks, and it has its own privacy switches.
 * The block goes there as a `.command` file that removes itself when it ends.
 */
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

import { terminalElevationMarker } from "@specweave-studio/contracts";

export interface TerminalAppRunInput {
  readonly command: string;
  readonly cwd: string;
  /** A private folder (mode 0700) and a name unique to this run. */
  readonly dir: string;
  readonly name: string;
  readonly shell?: string;
  /** Test seam: the program that opens a file in an app. */
  readonly openPath?: string;
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** Writes the script and returns the command that opens it in Terminal. */
export async function prepareTerminalAppRun(input: TerminalAppRunInput): Promise<string> {
  const file = NodePath.join(input.dir, `${input.name}.command`);
  const shell = input.shell && NodePath.isAbsolute(input.shell) ? input.shell : "/bin/zsh";
  const script = `#!${shell} -l
trap 'rm -f ${shellQuote(file)}' EXIT
cd ${shellQuote(input.cwd)} || exit 1
${input.command}
`;
  await NodeFS.rm(file, { force: true });
  await NodeFS.writeFile(file, script, { mode: 0o700 });
  const marker = terminalElevationMarker("terminal-app")
    .replace("\u001b", "\\033")
    .replace("\u0007", "\\007");
  return `${shellQuote(input.openPath ?? "/usr/bin/open")} -a Terminal ${shellQuote(file)} && printf '${marker}'`;
}
