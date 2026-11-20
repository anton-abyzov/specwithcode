// @effect-diagnostics nodeBuiltinImport:off - writes a private run folder with plain file calls.
/**
 * Runs a code block that needs administrator rights behind the machine's own
 * password prompt.
 *
 * The block is not changed. A wrapper asks sudo to validate first, with a
 * helper that shows a macOS dialog, and then runs the block in the same
 * terminal. sudo ties its ticket to that terminal, so the block's own `sudo`
 * lines find it and no other shell on the machine does. The password goes
 * from the dialog to sudo's pipe: it never enters this process, the terminal
 * output, a log or the window.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  isInlineRunTerminalId,
  TERMINAL_ELEVATION_OSC,
  type TerminalElevationRequest,
} from "@specweave-studio/contracts";

/** Seconds the password dialog waits before it gives up. */
export const ELEVATION_PROMPT_TIMEOUT_SECONDS = 120;
const LABEL_COMMAND_CHARS = 120;

export interface ElevatedRunInput {
  readonly command: string;
  readonly threadId: string;
  readonly terminalId: string;
  readonly elevation: TerminalElevationRequest;
  readonly platform: NodeJS.Platform;
  /** Parent of the private run folders; the user's temporary folder by default. */
  readonly runsDir?: string;
  readonly machineName?: string;
  /** Test seam: the dialog program. */
  readonly osascriptPath?: string;
}

/**
 * Whether `terminal.open` goes through the prompt: a code-block run that asked
 * for it, on a system with sudo. Windows runs the block as it is; its `sudo`
 * raises the system's own approval.
 */
export function elevatedRunApplies(input: {
  readonly platform: NodeJS.Platform;
  readonly terminalId: string;
  readonly command: string | null | undefined;
  readonly elevation: TerminalElevationRequest | undefined;
}): boolean {
  return (
    input.elevation !== undefined &&
    typeof input.command === "string" &&
    input.platform !== "win32" &&
    isInlineRunTerminalId(input.terminalId)
  );
}

/** One line of plain text: no control characters, no line breaks, bounded. */
function plainLine(value: string, maxLength: number): string {
  const line = value
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > maxLength ? `${line.slice(0, maxLength - 1)}…` : line;
}

/** What the password dialog says: who asks, from where, and the start of the command. */
export function elevationPromptLabel(input: {
  readonly command: string;
  readonly machineName: string;
  readonly elevation: TerminalElevationRequest;
}): string {
  const lines = [
    `SpecWithCode wants to run a command as administrator on ${plainLine(input.machineName, 80)}.`,
    "",
  ];
  const thread = plainLine(input.elevation.threadTitle ?? "", 80);
  if (thread) lines.push(`Thread: ${thread}`);
  const from = plainLine(input.elevation.requestedFrom ?? "", 80);
  if (from) lines.push(`Asked from: ${from}`);
  lines.push(`Command: ${plainLine(input.command, LABEL_COMMAND_CHARS)}`);
  lines.push("", "Your password goes to macOS only. SpecWithCode never sees it.");
  return lines.join("\n");
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

function askpassScript(dir: string, osascriptPath: string): string {
  return `#!/bin/sh
# Shows the password dialog for sudo and prints the answer to sudo's pipe.
dir=${shellQuote(dir)}
echo $$ > "$dir/askpass.pid"
exec ${shellQuote(osascriptPath)} - "$dir/label.txt" "$dir/answer" <<'OSA'
on run argv
  set labelText to read POSIX file (item 1 of argv) as «class utf8»
  try
    set answer to display dialog labelText default answer "" with hidden answer with title "SpecWithCode" buttons {"Cancel", "OK"} default button "OK" giving up after ${ELEVATION_PROMPT_TIMEOUT_SECONDS} with icon caution
  on error number -128
    my note(item 2 of argv, "cancelled")
    error number -128
  end try
  if gave up of answer then
    my note(item 2 of argv, "timeout")
    error number -128
  end if
  return text returned of answer
end run
on note(answerPath, state)
  do shell script "printf %s " & quoted form of state & " > " & quoted form of answerPath
end note
OSA
`;
}

function wrapperScript(dir: string): string {
  return `#!/bin/sh
# Asks for the administrator password once, runs the block, forgets the ticket.
dir=${shellQuote(dir)}
mark() { printf '\\033]${TERMINAL_ELEVATION_OSC};elevation=%s\\007' "$1"; }
cleanup() {
  sudo -k 2>/dev/null
  [ -f "$dir/askpass.pid" ] && kill "$(cat "$dir/askpass.pid")" 2>/dev/null
  rm -rf "$dir"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP
if ! sudo -n true 2>/dev/null; then
  if [ "$(uname -s)" != "Darwin" ] || [ "$(launchctl managername 2>/dev/null)" != "Aqua" ]; then
    mark unavailable
    exit 1
  fi
  mark waiting
  if ! SUDO_ASKPASS="$dir/askpass.sh" sudo -A -v 2>/dev/null; then
    state=denied
    [ -f "$dir/answer" ] && state="$(cat "$dir/answer")"
    case "$state" in cancelled|timeout) ;; *) state=denied ;; esac
    mark "$state"
    exit 1
  fi
fi
mark started
"\${SHELL:-/bin/sh}" -c "$(cat "$dir/block.sh")"
exit $?
`;
}

/**
 * Writes the run folder and returns the command the terminal runs instead of
 * the block. The folder holds no secret; the wrapper removes it when it ends.
 */
export async function prepareElevatedRun(input: ElevatedRunInput): Promise<string> {
  const parent =
    input.runsDir ??
    NodePath.join(NodeOS.tmpdir(), `specwithcode-elevated-${NodeOS.userInfo().uid}`);
  await NodeFS.mkdir(parent, { recursive: true, mode: 0o700 });
  await NodeFS.chmod(parent, 0o700);
  const name = NodeCrypto.createHash("sha256")
    .update(`${input.threadId}\n${input.terminalId}`)
    .digest("hex")
    .slice(0, 24);
  const dir = NodePath.join(parent, name);
  await NodeFS.rm(dir, { recursive: true, force: true });
  await NodeFS.mkdir(dir, { mode: 0o700 });
  const machineName = input.machineName ?? NodeOS.hostname().replace(/\.local$/, "");
  const write = (file: string, content: string, mode: number) =>
    NodeFS.writeFile(NodePath.join(dir, file), content, { mode });
  await write("block.sh", input.command, 0o600);
  await write(
    "label.txt",
    elevationPromptLabel({ command: input.command, machineName, elevation: input.elevation }),
    0o600,
  );
  await write("askpass.sh", askpassScript(dir, input.osascriptPath ?? "/usr/bin/osascript"), 0o700);
  await write("run.sh", wrapperScript(dir), 0o700);
  return `/bin/sh ${shellQuote(NodePath.join(dir, "run.sh"))}`;
}
