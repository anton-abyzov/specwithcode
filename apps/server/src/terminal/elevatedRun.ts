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
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  isInlineRunTerminalId,
  TERMINAL_ELEVATION_NONCE_REGEX,
  TERMINAL_ELEVATION_OSC,
  type TerminalElevationState,
  type TerminalElevationRequest,
} from "@specweave-studio/contracts";

import { shellRunElevation } from "@specweave-studio/shared/shellRunElevation";

import { prepareTerminalAppRun } from "./openInTerminal.ts";

/** Seconds the password dialog waits before it gives up. */
export const ELEVATION_PROMPT_TIMEOUT_SECONDS = 120;
const LABEL_LINE_CHARS = 160;
const LABEL_COMMAND_LINES = 8;
const LABEL_LEADING_LINES = 3;

/** Programs the wrapper runs by full path, so nothing on PATH can stand in for them. */
export interface ElevatedRunTools {
  readonly sudo: string;
  readonly uname: string;
  readonly launchctl: string;
  readonly osascript: string;
  readonly cat: string;
  readonly rm: string;
  readonly sleep: string;
  readonly ps: string;
  readonly awk: string;
  readonly perl: string;
}
const SYSTEM_TOOLS: ElevatedRunTools = {
  sudo: "/usr/bin/sudo",
  uname: "/usr/bin/uname",
  launchctl: "/bin/launchctl",
  osascript: "/usr/bin/osascript",
  cat: "/bin/cat",
  rm: "/bin/rm",
  sleep: "/bin/sleep",
  ps: "/bin/ps",
  awk: "/usr/bin/awk",
  perl: "/usr/bin/perl",
};

export interface ElevatedRunInput {
  readonly command: string;
  /** The thread's folder; "Open in Terminal" starts there. */
  readonly cwd?: string;
  readonly fallbackCwd?: string;
  readonly threadId: string;
  readonly terminalId: string;
  readonly elevation: TerminalElevationRequest;
  readonly platform: NodeJS.Platform;
  /** Parent of the private run folders; the user's temporary folder by default. */
  readonly runsDir?: string;
  readonly machineName?: string;
  /** Test seam: stand-ins for the system programs. */
  readonly tools?: Partial<ElevatedRunTools>;
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

const ADMINISTRATOR_WORD = /\b(?:sudo|sudoedit|doas|su|pkexec)\b|administrator\s+privileges/gi;

/** Whether a line runs something as administrator; a comment that mentions sudo does not. */
const runsAsAdministrator = (line: string): boolean => shellRunElevation(line).administrator;

/**
 * One line of the block for the dialog. A long line keeps its start and the
 * part that runs as administrator, so padding cannot push that part out.
 */
function labelLine(raw: string): string {
  const line = plainLine(raw, Number.MAX_SAFE_INTEGER);
  if (line.length <= LABEL_LINE_CHARS || !runsAsAdministrator(line))
    return plainLine(line, LABEL_LINE_CHARS);
  const headChars = 60;
  const tailChars = LABEL_LINE_CHARS - headChars - 3;
  const at = [...line.matchAll(ADMINISTRATOR_WORD)]
    .map((match) => match.index)
    .find((index) => index >= headChars);
  if (at === undefined) return plainLine(line, LABEL_LINE_CHARS);
  return `${line.slice(0, headChars)} … ${plainLine(line.slice(at), tailChars)}`;
}

/**
 * The lines of the block the dialog shows. A long block shows its start and
 * then the lines that run as administrator, so harmless opening lines cannot
 * push them out of sight; if some still do not fit, the dialog says so.
 */
function labelCommandLines(command: string): string[] {
  const rawLines = command.split("\n").filter((line) => plainLine(line, 2).length > 0);
  const lines = rawLines.map(labelLine);
  if (lines.length <= LABEL_COMMAND_LINES) return lines;
  const administrator = rawLines.map(runsAsAdministrator);
  const shown = new Set<number>();
  for (let index = 0; index < LABEL_LEADING_LINES; index += 1) shown.add(index);
  for (let index = LABEL_LEADING_LINES; index < lines.length; index += 1) {
    if (shown.size >= LABEL_COMMAND_LINES) break;
    if (administrator[index]) shown.add(index);
  }
  for (let index = LABEL_LEADING_LINES; shown.size < LABEL_COMMAND_LINES; index += 1)
    shown.add(index);
  const picked = [...shown].toSorted((left, right) => left - right);
  const result: string[] = [];
  picked.forEach((index, position) => {
    if (position > 0 && index !== (picked[position - 1] ?? 0) + 1) result.push("…");
    result.push(lines[index] ?? "");
  });
  const hidden = lines.length - picked.length;
  const hiddenAdministrator = administrator.filter((is, index) => is && !shown.has(index)).length;
  const more = `… ${hidden} more ${hidden === 1 ? "line" : "lines"}`;
  result.push(
    hiddenAdministrator > 0
      ? `${more}, ${hiddenAdministrator} of them as administrator. Read the whole command in SpecWithCode first.`
      : `${more}. Read the whole command in SpecWithCode first.`,
  );
  return result;
}

/** What the password dialog says: who asks, from where, and what will run. */
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
  lines.push("", "Command:", ...labelCommandLines(input.command));
  lines.push("", "Your password goes to macOS only. SpecWithCode never sees it.");
  return lines.join("\n");
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** The nonce as sent, or none: it is written into shell scripts, so only plain characters pass. */
const safeNonce = (elevation: TerminalElevationRequest): string =>
  elevation.nonce !== undefined && TERMINAL_ELEVATION_NONCE_REGEX.test(elevation.nonce)
    ? elevation.nonce
    : "";

/** `printf` format that writes one state marker; safe inside single quotes. */
const markerFormat = (nonce: string): string =>
  `\\033]${TERMINAL_ELEVATION_OSC};elevation=%s;${nonce}\\007`;

/** A command that only reports a state, for when the wrapper cannot be written. */
export function elevationStateCommand(
  state: TerminalElevationState,
  elevation: TerminalElevationRequest,
): string {
  return `printf '${markerFormat(safeNonce(elevation))}' ${state}; exit 1`;
}

function askpassScript(dir: string, osascriptPath: string): string {
  return `#!/bin/sh
# Shows the password dialog for sudo and prints the answer to sudo's pipe.
dir=${shellQuote(dir)}
printf '%s 0\\n' "$$" > "$dir/askpass.pid"
exec ${shellQuote(osascriptPath)} - "$dir/label.txt" "$dir/answer" <<'OSA'
on run argv
  set labelText to read POSIX file (item 1 of argv) as «class utf8»
  try
    set answer to display dialog labelText default answer "" with hidden answer with title "SpecWithCode" buttons {"Cancel", "OK"} default button "OK" giving up after ${ELEVATION_PROMPT_TIMEOUT_SECONDS} with icon caution
  on error errorText number errorNumber
    if errorNumber is -128 then
      my recordAnswer(item 2 of argv, "cancelled")
    else
      my recordAnswer(item 2 of argv, "unavailable")
    end if
    error number -128
  end try
  if gave up of answer then
    my recordAnswer(item 2 of argv, "timeout")
    error number -128
  end if
  return text returned of answer
end run
on recordAnswer(answerPath, state)
  do shell script "printf %s " & quoted form of state & " > " & quoted form of answerPath
end recordAnswer
OSA
`;
}

function wrapperScript(dir: string, tools: ElevatedRunTools): string {
  const sudo = shellQuote(tools.sudo);
  const cat = shellQuote(tools.cat);
  const rm = shellQuote(tools.rm);
  const sleep = shellQuote(tools.sleep);
  const ps = shellQuote(tools.ps);
  const awk = shellQuote(tools.awk);
  const perl = shellQuote(tools.perl);
  return `#!/bin/sh
# Asks for the administrator password once, runs the block, forgets the ticket.
dir=${shellQuote(dir)}
wrapper_pid=$$
# The value that signs this run's states leaves the disk before the block starts.
nonce="$(${cat} "$dir/nonce" 2>/dev/null)"
${rm} -f "$dir/nonce"
mark() { printf '\\033]${TERMINAL_ELEVATION_OSC};elevation=%s;%s\\007' "$1" "$nonce"; }
collect_tree() {
  root="$1"
  own_pgid="\${2:-0}"
  root_exited="\${3:-0}"
  [ -n "$root" ] || return 0
  if [ -x ${ps} ] && [ -x ${awk} ]; then
    ${ps} -eo pid=,ppid=,pgid= 2>/dev/null | ${awk} -v root="$root" -v own_pgid="$own_pgid" -v root_exited="$root_exited" -v wrap="$wrapper_pid" '
      BEGIN {
        root = root + 0
        own_pgid = own_pgid + 0
        root_exited = root_exited + 0
        wrap = wrap + 0
      }
      {
        pid = $1 + 0; ppid = $2 + 0; pgid = $3 + 0
        if (pid <= 1) next
        parent[pid] = ppid
        group[pid] = pgid
        all[++n] = pid
        if (pid == root) root_pgid = pgid
      }
      END {
        if (root <= 1) exit 0
        if (root_exited == 0 && (root in parent)) seen[root] = 1
        if (own_pgid == 1 || (root_exited == 0 && root_pgid == root)) {
          for (i = 1; i <= n; i++) {
            p = all[i]
            if (group[p] == root) seen[p] = 1
          }
        }
        changed = 1
        while (changed) {
          changed = 0
          for (i = 1; i <= n; i++) {
            p = all[i]
            if (!(p in seen) && (parent[p] in seen)) {
              seen[p] = 1
              changed = 1
            }
          }
        }
        for (p in seen) {
          if (seen[p] == 1 && (p + 0) > 1 && (p + 0) != wrap) print p
        }
      }
    '
  elif [ "$root_exited" = 0 ]; then
    printf '%s\\n' "$root"
  fi
}
stop_target() {
  pidfile="$1"
  root_exited="\${2:-0}"
  [ -f "$pidfile" ] || return 0
  target_pid=
  own_pgid=0
  read target_pid own_pgid < "$pidfile" 2>/dev/null
  ${rm} -f "$pidfile"
  case "$target_pid" in
    ""|*[!0-9]*|0|1) return 0 ;;
  esac
  own_pgid="\${own_pgid:-0}"
  if [ "$root_exited" = 1 ] && [ "$own_pgid" != 1 ]; then
    return 0
  fi
  # Freeze first so a shell cannot advance to the next command or fork while stopping.
  [ "$own_pgid" = 1 ] && kill -STOP -- -"$target_pid" 2>/dev/null
  [ "$root_exited" = 0 ] && kill -STOP "$target_pid" 2>/dev/null
  pids="$(collect_tree "$target_pid" "$own_pgid" "$root_exited")"
  if [ -z "$pids" ]; then
    [ "$own_pgid" = 1 ] && kill -CONT -- -"$target_pid" 2>/dev/null
    return 0
  fi
  kill -STOP $pids 2>/dev/null
  pids="$(collect_tree "$target_pid" "$own_pgid" "$root_exited")"
  [ "$own_pgid" = 1 ] && kill -TERM -- -"$target_pid" 2>/dev/null
  [ -n "$pids" ] && kill -TERM $pids 2>/dev/null
  [ "$own_pgid" = 1 ] && kill -CONT -- -"$target_pid" 2>/dev/null
  [ -n "$pids" ] && kill -CONT $pids 2>/dev/null
  i=0
  while [ "$i" -lt 5 ]; do
    alive=0
    for p in $pids; do
      if kill -0 "$p" 2>/dev/null; then alive=1; break; fi
    done
    [ "$alive" = 0 ] && break
    ${sleep} 0.2 2>/dev/null || ${sleep} 1
    i=$((i + 1))
  done
  [ "$own_pgid" = 1 ] && kill -KILL -- -"$target_pid" 2>/dev/null
  more="$(collect_tree "$target_pid" "$own_pgid" "$root_exited")"
  for p in $more $pids; do
    kill -0 "$p" 2>/dev/null && kill -KILL "$p" 2>/dev/null
  done
}
run_isolated() {
  pidfile="$1"
  grab_tty="$2"
  shift 2
  if [ -x ${perl} ]; then
    ${perl} -e 'use POSIX qw(setpgid tcsetpgrp isatty); setpgid(0, 0); if ($ARGV[1] && isatty(0)) { local $SIG{TTOU} = "IGNORE"; tcsetpgrp(0, $$); } open my $f, ">", $ARGV[0] or die $!; print $f "$$ 1\\n"; close $f; splice @ARGV, 0, 2; exec @ARGV or exit 127' "$pidfile" "$grab_tty" "$@"
  else
    /bin/sh -c 'printf "%s 0\\n" "$$" > "$1"; shift; exec "$@"' sh "$pidfile" "$@"
  fi
}
reclaim_tty() {
  if [ -x ${perl} ]; then
    ${perl} -e 'use POSIX qw(tcsetpgrp isatty); if (isatty(0)) { local $SIG{TTOU} = "IGNORE"; tcsetpgrp(0, getpgrp()); }' 2>/dev/null
  fi
}
phase=check
ask_pid=
watch_pid=
cleanup() {
  stop_target "$dir/block.pid"
  stop_target "$dir/ask.pid"
  stop_target "$dir/askpass.pid"
  [ -n "$ask_pid" ] && kill -TERM "$ask_pid" 2>/dev/null
  reclaim_tty
  # Only a ticket this run asked for is dropped.
  [ -f "$dir/need-drop" ] && ${sudo} -k 2>/dev/null
  ${rm} -rf "$dir"
  [ -n "$watch_pid" ] && kill -KILL "$watch_pid" 2>/dev/null
}
stop() {
  if [ "$phase" = prompt ]; then
    mark cancelled
    exit 1
  fi
  exit 130
}
trap cleanup EXIT
trap stop INT TERM HUP
if [ ! -x ${sudo} ]; then
  mark unavailable
  exit 1
fi
# Start the watcher before prompting so SIGKILL during authentication still
# kills the helper, drops any newly primed ticket and removes the run folder.
(
  trap '' HUP INT TERM
  while kill -0 "$wrapper_pid" 2>/dev/null; do
    ${sleep} 0.2 2>/dev/null || ${sleep} 1
  done
  stop_target "$dir/ask.pid"
  stop_target "$dir/askpass.pid"
  stop_target "$dir/block.pid"
  [ -f "$dir/need-drop" ] && ${sudo} -k 2>/dev/null
  ${rm} -rf "$dir"
) </dev/null >/dev/null 2>&1 &
watch_pid=$!
if ! ${sudo} -n true 2>/dev/null; then
  if [ "$(${shellQuote(tools.uname)} -s)" != "Darwin" ]; then
    if ! ${sudo} -n -l >/dev/null 2>&1; then
      mark unavailable
      exit 1
    fi
  elif [ "$(${shellQuote(tools.launchctl)} managername 2>/dev/null)" != "Aqua" ]; then
    mark unavailable
    exit 1
  else
    mark waiting
    phase=prompt
    # sudo -n true just failed, so any ticket created from here on belongs to this run.
    : > "$dir/need-drop"
    # In the background, so Stop and a closed terminal end the prompt at once.
    SUDO_ASKPASS="$dir/askpass.sh" run_isolated "$dir/ask.pid" 0 ${sudo} -A -v 2>/dev/null &
    ask_pid=$!
    wait "$ask_pid"
    asked=$?
    ask_pid=
    ${rm} -f "$dir/ask.pid" "$dir/askpass.pid"
    if [ "$asked" != 0 ]; then
      state=denied
      [ -f "$dir/answer" ] && state="$(${cat} "$dir/answer")"
      case "$state" in cancelled|timeout|unavailable) ;; *) state=denied ;; esac
      phase=done
      mark "$state"
      exit 1
    fi
  fi
fi
phase=run
block="$(${cat} "$dir/block.sh")"
${rm} -f "$dir/block.sh" "$dir/label.txt" "$dir/askpass.sh" "$dir/answer" "$dir/askpass.pid" "$dir/ask.pid"
# The block runs in the foreground in its own process group (with the tty
# foreground transferred to it when stdin is a tty) so Ctrl-C delivers SIGINT
# immediately while abnormal termination still tears down the whole tree.
trap - TERM HUP
mark started
run_isolated "$dir/block.pid" 1 "\${SHELL:-/bin/sh}" -c "$block"
code=$?
reclaim_tty
stop_target "$dir/block.pid" 1
exit "$code"
`;
}

/** The private parent of the run folders: this user's, a real folder, closed to others. */
async function privateRunsDir(runsDir: string | undefined): Promise<string> {
  const uid = NodeOS.userInfo().uid;
  const parent = runsDir ?? NodePath.join(NodeOS.tmpdir(), `specwithcode-elevated-${uid}`);
  await NodeFSP.mkdir(parent, { recursive: true, mode: 0o700 });
  // Someone else's folder, or a link to one, is never written to.
  const stat = await NodeFSP.lstat(parent);
  if (!stat.isDirectory() || stat.uid !== uid)
    throw new Error("The folder for administrator runs is not this user's own folder.");
  await NodeFSP.chmod(parent, 0o700);
  return parent;
}

/**
 * Writes the run folder and returns the command the terminal runs instead of
 * the block. The folder holds no secret; the wrapper removes it when it ends.
 */
export async function prepareElevatedRun(input: ElevatedRunInput): Promise<string> {
  const parent = await privateRunsDir(input.runsDir);
  const nonce = safeNonce(input.elevation);
  if (input.elevation.openIn === "terminal-app" && input.platform === "darwin")
    return prepareTerminalAppRun({
      command: input.command,
      cwd: input.cwd ?? NodeOS.homedir(),
      ...(input.fallbackCwd ? { fallbackCwd: input.fallbackCwd } : {}),
      dir: parent,
      name: NodeCrypto.randomBytes(12).toString("hex"),
      nonce,
      ...(process.env.SHELL ? { shell: process.env.SHELL } : {}),
    });
  // A new folder each run: a run that is ending can only remove its own.
  const dir = await NodeFSP.mkdtemp(NodePath.join(parent, "run-"));
  const tools = { ...SYSTEM_TOOLS, ...input.tools };
  const machineName = input.machineName ?? NodeOS.hostname().replace(/\.local$/, "");
  const write = (file: string, content: string, mode: number) =>
    NodeFSP.writeFile(NodePath.join(dir, file), content, { mode, flag: "wx" });
  await write("block.sh", input.command, 0o600);
  await write(
    "label.txt",
    elevationPromptLabel({ command: input.command, machineName, elevation: input.elevation }),
    0o600,
  );
  await write("askpass.sh", askpassScript(dir, tools.osascript), 0o700);
  await write("nonce", nonce, 0o600);
  await write("run.sh", wrapperScript(dir, tools), 0o700);
  return `/bin/sh ${shellQuote(NodePath.join(dir, "run.sh"))}`;
}
