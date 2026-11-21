// @effect-diagnostics nodeBuiltinImport:off - writes a private run folder with plain file calls.
/**
 * Runs a code block that needs administrator rights behind the machine's own
 * password prompt.
 *
 * The block is not changed. An isolated macOS authentication helper shows the
 * native dialog, verifies sudoers defaults under a scrubbed allowlisted
 * environment before priming a tty-local ticket, and then runs the block in
 * the same terminal. sudo ties its ticket to that terminal, so the block's own
 * `sudo` lines find it and no other shell on the machine does. The password is
 * handled only by that short-lived helper on this Mac and wiped immediately: it
 * never enters SpecWithCode's app, server, terminal output, or logs.
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

import {
  analyzeElevatedSudoInvocations,
  shellRunElevation,
  type SudoInvocationCheck,
} from "@specweave-studio/shared/shellRunElevation";

import { prepareTerminalAppRunHandle } from "./openInTerminal.ts";

/** Seconds the password dialog waits before it gives up. */
export const ELEVATION_PROMPT_TIMEOUT_SECONDS = 120;
/** Hard monotonic deadline for the entire authentication helper phase. */
export const ELEVATION_AUTH_TIMEOUT_SECONDS = ELEVATION_PROMPT_TIMEOUT_SECONDS + 15;
/** Hard monotonic deadline for dropping a primed sudo ticket during cleanup. */
export const ELEVATION_CLEANUP_TIMEOUT_SECONDS = 3;
const LABEL_LINE_CHARS = 160;
const LABEL_COMMAND_LINES = 8;
const LABEL_LEADING_LINES = 3;

/** Programs the wrapper runs by full path, so nothing on PATH can stand in for them. */
export interface ElevatedRunTools {
  readonly env: string;
  readonly sudo: string;
  readonly sh: string;
  readonly uname: string;
  readonly launchctl: string;
  readonly osascript: string;
  readonly script: string;
  readonly cat: string;
  readonly rm: string;
  readonly sleep: string;
  readonly ps: string;
  readonly awk: string;
  readonly perl: string;
}
const SYSTEM_TOOLS: ElevatedRunTools = {
  env: "/usr/bin/env",
  sudo: "/usr/bin/sudo",
  sh: "/bin/sh",
  uname: "/usr/bin/uname",
  launchctl: "/bin/launchctl",
  osascript: "/usr/bin/osascript",
  script: "/usr/bin/script",
  cat: "/bin/cat",
  rm: "/bin/rm",
  sleep: "/bin/sleep",
  ps: "/bin/ps",
  awk: "/usr/bin/awk",
  perl: "/usr/bin/perl",
};

interface TrustedAuthEnv {
  readonly home: string;
  readonly user: string;
  readonly tmpdir: string;
}

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
  /** Test seam: monotonic deadline (seconds) for the entire auth helper phase. */
  readonly authTimeoutSeconds?: number;
  /** Test seam: monotonic deadline (seconds) for dropping a primed ticket on cleanup. */
  readonly cleanupTimeoutSeconds?: number;
  /** Preferred login shell for the user command (used when launchd omits SHELL). */
  readonly shell?: string;
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
  lines.push(
    "",
    "Used only by this Mac's isolated sudo authentication helper. SpecWithCode's app, server, and logs never see or store it.",
  );
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

function askpassScript(dir: string, tools: ElevatedRunTools, trustedEnv: TrustedAuthEnv): string {
  return `#!/bin/sh
# Shows the password dialog for the isolated authentication helper.
dir=${shellQuote(dir)}
printf '%s 0\\n' "$$" > "$dir/askpass.pid"
exec ${shellQuote(tools.env)} -i \\
  PATH=/usr/bin:/bin:/usr/sbin:/sbin \\
  HOME=${shellQuote(trustedEnv.home)} \\
  USER=${shellQuote(trustedEnv.user)} \\
  LOGNAME=${shellQuote(trustedEnv.user)} \\
  TMPDIR=${shellQuote(trustedEnv.tmpdir)} \\
  LC_ALL=C \\
  ${shellQuote(tools.osascript)} - "$dir/label.txt" "$dir/answer" <<'OSA'
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

function sudoTargetFlagList(check: {
  readonly user: string | null;
  readonly group: string | null;
}): ReadonlyArray<string> {
  const parts: string[] = [];
  if (check.user !== null) parts.push("-u", check.user);
  if (check.group !== null) parts.push("-g", check.group);
  return parts;
}

function sudoTargetArgs(check: {
  readonly user: string | null;
  readonly group: string | null;
}): string {
  return sudoTargetFlagList(check)
    .map((part, index) => (index % 2 === 1 ? shellQuote(part) : part))
    .join(" ");
}

function distinctSudoTargets(
  checks: ReadonlyArray<SudoInvocationCheck>,
): ReadonlyArray<{ readonly user: string | null; readonly group: string | null }> {
  const seen = new Set<string>();
  const targets: Array<{ readonly user: string | null; readonly group: string | null }> = [];
  for (const check of checks) {
    if (check.user === null && check.group === null) continue;
    const key = JSON.stringify([check.user, check.group]);
    if (!seen.has(key)) {
      seen.add(key);
      targets.push({ user: check.user, group: check.group });
    }
  }
  return targets;
}

/**
 * Perl helper staged alongside `run.sh` (and unlinked before the user block runs):
 *  - `check-defaults <auth|nopasswd>`: parses `LC_ALL=C sudo -N -l` output from
 *    stdin and fails closed on non-tty ticket scope (`timestamp_type != tty`,
 *    `!tty_tickets`), alternate-account password policies (`rootpw`/`targetpw`/
 *    `runaspw`), sub-minute/disabled `timestamp_timeout`, `passwd_tries=0`,
 *    command/runas-bound overrides (`Defaults>`/`Defaults!`), or missing privileges.
 *  - `authenticate <sh|v>`: asks for the password via `askpass.sh`, verifies
 *    sudoers defaults via `sudo -N -S -p "" -l` BEFORE priming any ticket, and
 *    only then creates `need-drop` and primes in run/validate mode.
 */
function perlSingleQuote(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function authHelperScript(
  dir: string,
  tools: ElevatedRunTools,
  trustedEnv: TrustedAuthEnv,
  checks: ReadonlyArray<SudoInvocationCheck>,
  authTimeoutSeconds: number,
): string {
  const dirLit = perlSingleQuote(dir);
  const sudoLit = perlSingleQuote(tools.sudo);
  const shLit = perlSingleQuote(tools.sh);
  const scriptLit = perlSingleQuote(tools.script);
  const homeLit = perlSingleQuote(trustedEnv.home);
  const userLit = perlSingleQuote(trustedEnv.user);
  const tmpdirLit = perlSingleQuote(trustedEnv.tmpdir);
  const timeoutLit =
    Number.isFinite(authTimeoutSeconds) && authTimeoutSeconds > 0
      ? authTimeoutSeconds.toFixed(3)
      : String(ELEVATION_AUTH_TIMEOUT_SECONDS);
  const targets = distinctSudoTargets(checks);
  const policyCheckRows: string[] = [
    ...targets.flatMap((target) => {
      const flags = sudoTargetFlagList(target).map(perlSingleQuote).join(", ");
      return [
        `  [$SUDO, '-N', '-n', ${flags}, '-v'],`,
        `  [$SUDO, '-N', '-n', ${flags}, $SH, '-c', ':'],`,
      ];
    }),
    ...checks.map((check) => {
      const flags = sudoTargetFlagList(check).map(perlSingleQuote);
      const argv = check.command.map(perlSingleQuote);
      return `  [${["$SUDO", "'-N'", "'-n'", "'-l'", ...flags, "'--'", ...argv].join(", ")}],`;
    }),
  ];
  return `#!${tools.perl}
use strict;
use warnings;
use Fcntl ();
use POSIX ();
use Time::HiRes qw(clock_gettime CLOCK_MONOTONIC sleep);

my $DIR = ${dirLit};
my $SUDO = ${sudoLit};
my $SH = ${shLit};
my $SCRIPT = ${scriptLit};
my $AUTH_TIMEOUT = ${timeoutLit} + 0;
my @POLICY_CHECKS = (
${policyCheckRows.join("\n")}
);
my %CLEAN_ENV = (
  PATH    => '/usr/bin:/bin:/usr/sbin:/sbin',
  HOME    => ${homeLit},
  USER    => ${userLit},
  LOGNAME => ${userLit},
  TMPDIR  => ${tmpdirLit},
  LC_ALL  => 'C',
  TERM    => 'xterm-256color',
);
%ENV = %CLEAN_ENV;

sub split_options {
  my ($s) = @_;
  my @opts;
  my $cur = "";
  my $in_q = 0;
  my $esc = 0;
  for my $ch (split //, $s) {
    if ($esc) { $cur .= $ch; $esc = 0; next; }
    if ($ch eq "\\\\" && $in_q) { $cur .= $ch; $esc = 1; next; }
    if ($ch eq "\\"") { $in_q = !$in_q; $cur .= $ch; next; }
    if ($ch eq "," && !$in_q) {
      push @opts, $cur;
      $cur = "";
      next;
    }
    $cur .= $ch;
  }
  push @opts, $cur if length $cur;
  return map { s/^\\s+|\\s+$//gr } grep { /\\S/ } @opts;
}

sub unquote {
  my ($v) = @_;
  return "" unless defined $v;
  $v =~ s/^"(.*)"$/$1/;
  return $v;
}

sub bad_timeout {
  my ($val) = @_;
  return 1 unless defined $val;
  my $u = unquote($val);
  return 1 unless $u =~ /^-?(?:\\d+(?:\\.\\d+)?|\\.\\d+)$/;
  my $n = $u + 0;
  return ($n >= 0 && $n < 1) ? 1 : 0;
}

sub is_unsafe_bound_option {
  my ($opt, $mode) = @_;
  return 0 unless $opt =~ /^(!)?([A-Za-z_][A-Za-z0-9_]*)(?:([+-]?=)(.*))?$/;
  my ($neg, $name, $val) = ($1 // "", lc($2), $4);
  if ($name eq "rootpw" || $name eq "targetpw" || $name eq "runaspw") {
    return !$neg ? 1 : 0;
  }
  if ($mode eq "nopasswd" && $name eq "authenticate" && !$neg) {
    return 1;
  }
  if ($name eq "tty_tickets" && $neg) {
    return 1;
  }
  if ($name eq "timestamp_type") {
    return 1 if $neg;
    return lc(unquote($val)) ne "tty" ? 1 : 0;
  }
  if ($name eq "timestamp_timeout") {
    return 1 if $neg;
    return bad_timeout($val);
  }
  if ($name eq "passwd_tries") {
    return 1 if $neg;
    my $u = unquote($val);
    return ($u !~ /^\\d+$/ || ($u + 0) < 1) ? 1 : 0;
  }
  return 0;
}

sub check_defaults_text {
  my ($text, $mode) = @_;
  my $section = "";
  my $saw_user_header = 0;
  my $timestamp_type = "tty";
  my $rootpw = 0;
  my $targetpw = 0;
  my $runaspw = 0;
  my $timestamp_timeout = "5";
  my $passwd_tries = "3";
  my $bound_unsafe = 0;

  for my $line (split /\\r?\\n/, $text) {
    if ($line =~ /^Matching Defaults entries for .+:$/) {
      $section = "matching";
      next;
    }
    if ($line =~ /^Runas and Command-specific defaults for .+:$/) {
      $section = "bound";
      next;
    }
    if ($line =~ /^User .+ may run the following commands on .+:$/) {
      $section = "commands";
      $saw_user_header = 1;
      next;
    }
    if ($line =~ /^\\S/) {
      $section = "";
      next;
    }
    if ($section eq "matching") {
      for my $opt (split_options($line)) {
        next unless $opt =~ /^(!)?([A-Za-z_][A-Za-z0-9_]*)(?:([+-]?=)(.*))?$/;
        my ($neg, $name, $val) = ($1 // "", lc($2), $4);
        if ($name eq "timestamp_type") {
          $timestamp_type = $neg ? "unknown" : lc(unquote($val));
        } elsif ($name eq "tty_tickets") {
          $timestamp_type = $neg ? "global" : "tty";
        } elsif ($name eq "rootpw") {
          $rootpw = $neg ? 0 : 1;
        } elsif ($name eq "targetpw") {
          $targetpw = $neg ? 0 : 1;
        } elsif ($name eq "runaspw") {
          $runaspw = $neg ? 0 : 1;
        } elsif ($name eq "timestamp_timeout") {
          $timestamp_timeout = $neg ? "0" : ($val // "");
        } elsif ($name eq "passwd_tries") {
          $passwd_tries = $neg ? "0" : ($val // "");
        }
      }
    } elsif ($section eq "bound") {
      my $trimmed = $line;
      $trimmed =~ s/^\\s+//;
      my $rest = $trimmed;
      $rest =~ s/^Defaults[>!]\\S+\\s+//;
      for my $chunk (split_options($rest)) {
        if (is_unsafe_bound_option($chunk, $mode)) {
          $bound_unsafe = 1;
          last;
        }
        if ($chunk =~ /\\s+(\\S+)$/ && is_unsafe_bound_option($1, $mode)) {
          $bound_unsafe = 1;
          last;
        }
      }
    }
  }

  return 0 unless $saw_user_header;
  return 0 if $bound_unsafe;
  return 0 if $rootpw || $targetpw || $runaspw;
  if ($mode eq "auth") {
    return 0 if $timestamp_type ne "tty";
    return 0 if bad_timeout($timestamp_timeout);
    my $tries = unquote($passwd_tries);
    return 0 if $tries !~ /^\\d+$/ || ($tries + 0) < 1;
  }
  return 1;
}

sub write_answer {
  my ($state) = @_;
  if (open my $fh, ">", "$DIR/answer") {
    print $fh "$state\\n";
    close $fh;
  }
}

sub wipe_secret {
  return unless defined $_[0];
  my $len = length($_[0]);
  $_[0] = ("\\0" x $len) if $len > 0;
  $_[0] = "";
}

sub set_nonblock {
  my ($fh) = @_;
  my $flags = fcntl($fh, Fcntl::F_GETFL, 0);
  return unless defined $flags;
  fcntl($fh, Fcntl::F_SETFL, $flags | Fcntl::O_NONBLOCK);
}

sub run_with_stdin {
  my ($stdin_data, $deadline, @cmd) = @_;
  if (clock_gettime(CLOCK_MONOTONIC) >= $deadline) {
    return (124, "", "", 1);
  }
  pipe(my $in_r, my $in_w) or return (127, "", "pipe failed", 0);
  pipe(my $out_r, my $out_w) or return (127, "", "pipe failed", 0);
  pipe(my $err_r, my $err_w) or return (127, "", "pipe failed", 0);
  my $pid = fork();
  if (!defined $pid) {
    close $in_r; close $in_w; close $out_r; close $out_w; close $err_r; close $err_w;
    return (127, "", "fork failed", 0);
  }
  if ($pid == 0) {
    POSIX::setpgid(0, 0);
    close $in_w; close $out_r; close $err_r;
    if (defined($stdin_data) && length($stdin_data) > 0) {
      open(STDIN, "<&", $in_r) or POSIX::_exit(127);
    } else {
      open(STDIN, "<", "/dev/null") or POSIX::_exit(127);
    }
    open(STDOUT, ">&", $out_w) or POSIX::_exit(127);
    open(STDERR, ">&", $err_w) or POSIX::_exit(127);
    close $in_r; close $out_w; close $err_w;
    %ENV = %CLEAN_ENV;
    exec @cmd or POSIX::_exit(127);
  }
  POSIX::setpgid($pid, $pid);
  close $in_r; close $out_w; close $err_w;
  set_nonblock($in_w);
  set_nonblock($out_r);
  set_nonblock($err_r);

  my $in_buf = defined($stdin_data) ? "$stdin_data" : "";
  my $in_open = length($in_buf) > 0 ? 1 : 0;
  if (!$in_open) {
    close $in_w;
  }
  my ($out, $err) = ("", "");
  my ($out_open, $err_open) = (1, 1);
  my ($exited, $status, $timed_out) = (0, 0, 0);

  while (!$exited) {
    my $w = waitpid($pid, POSIX::WNOHANG);
    if ($w == $pid) {
      $exited = 1;
      $status = $?;
      last;
    } elsif ($w < 0) {
      $exited = 1;
      $status = -1;
      last;
    }

    my $rem = $deadline - clock_gettime(CLOCK_MONOTONIC);
    if ($rem <= 0) {
      $timed_out = 1;
      last;
    }

    my $rin = "";
    vec($rin, fileno($out_r), 1) = 1 if $out_open;
    vec($rin, fileno($err_r), 1) = 1 if $err_open;
    my $win = "";
    vec($win, fileno($in_w), 1) = 1 if $in_open;

    my $slice = $rem < 0.05 ? $rem : 0.05;
    my ($rout, $wout) = ($rin, $win);
    my $nfound = select($rout, $wout, undef, $slice);
    if (defined($nfound) && $nfound > 0) {
      if ($in_open && vec($wout, fileno($in_w), 1)) {
        local $SIG{PIPE} = "IGNORE";
        my $written = syswrite($in_w, $in_buf);
        if (defined($written) && $written > 0) {
          substr($in_buf, 0, $written, "");
          if (length($in_buf) == 0) {
            close $in_w;
            $in_open = 0;
          }
        } elsif (!defined($written) && ($! == POSIX::EAGAIN || $! == POSIX::EWOULDBLOCK || $! == POSIX::EINTR)) {
          # retry on next select slice
        } else {
          close $in_w;
          $in_open = 0;
        }
      }
      if ($out_open && vec($rout, fileno($out_r), 1)) {
        my $n = sysread($out_r, my $buf, 4096);
        if (defined($n) && $n > 0) {
          $out .= $buf;
        } elsif (defined($n) && $n == 0) {
          $out_open = 0;
        } elsif (!($! == POSIX::EAGAIN || $! == POSIX::EWOULDBLOCK || $! == POSIX::EINTR)) {
          $out_open = 0;
        }
      }
      if ($err_open && vec($rout, fileno($err_r), 1)) {
        my $n = sysread($err_r, my $buf, 4096);
        if (defined($n) && $n > 0) {
          $err .= $buf;
        } elsif (defined($n) && $n == 0) {
          $err_open = 0;
        } elsif (!($! == POSIX::EAGAIN || $! == POSIX::EWOULDBLOCK || $! == POSIX::EINTR)) {
          $err_open = 0;
        }
      }
    }
  }

  if ($in_open) {
    close $in_w;
    $in_open = 0;
  }
  wipe_secret($in_buf);

  if ($timed_out) {
    kill "TERM", -$pid, $pid;
    my $reaped = 0;
    for (1 .. 10) {
      if (!$reaped) {
        my $w = waitpid($pid, POSIX::WNOHANG);
        $reaped = 1 if ($w == $pid || $w < 0);
      }
      last if $reaped && !kill(0, -$pid);
      sleep(0.05);
    }
    if (!$reaped || kill(0, -$pid)) {
      kill "KILL", -$pid, $pid;
      if (!$reaped) {
        for (1 .. 10) {
          my $w = waitpid($pid, POSIX::WNOHANG);
          last if $w == $pid || $w < 0;
          sleep(0.05);
        }
      }
    }
    close $out_r; close $err_r;
    return (124, $out, $err, 1);
  }

  # Child exited: drain already-buffered output non-blockingly without waiting
  # for pipe EOF so a descendant holding stdout/stderr open cannot hang auth.
  my $drain_deadline = clock_gettime(CLOCK_MONOTONIC) + 0.05;
  while (($out_open || $err_open) && clock_gettime(CLOCK_MONOTONIC) < $drain_deadline) {
    my $drin = "";
    vec($drin, fileno($out_r), 1) = 1 if $out_open;
    vec($drin, fileno($err_r), 1) = 1 if $err_open;
    my $drout = $drin;
    my $nf = select($drout, undef, undef, 0);
    last if !defined($nf) || $nf <= 0;
    my $got = 0;
    if ($out_open && vec($drout, fileno($out_r), 1)) {
      my $n = sysread($out_r, my $buf, 4096);
      if (defined($n) && $n > 0) { $out .= $buf; $got = 1; }
      elsif (defined($n) && $n == 0) { $out_open = 0; }
      elsif (!($! == POSIX::EAGAIN || $! == POSIX::EWOULDBLOCK || $! == POSIX::EINTR)) { $out_open = 0; }
    }
    if ($err_open && vec($drout, fileno($err_r), 1)) {
      my $n = sysread($err_r, my $buf, 4096);
      if (defined($n) && $n > 0) { $err .= $buf; $got = 1; }
      elsif (defined($n) && $n == 0) { $err_open = 0; }
      elsif (!($! == POSIX::EAGAIN || $! == POSIX::EWOULDBLOCK || $! == POSIX::EINTR)) { $err_open = 0; }
    }
    last unless $got;
  }

  close $out_r; close $err_r;
  my $rc = ($status == -1) ? 127 : ($status & 127) ? (128 + ($status & 127)) : ($status >> 8);
  return ($rc, $out, $err, 0);
}

sub is_policy_denial {
  my ($err) = @_;
  return ($err =~ /not in the sudoers|is not allowed|must have a tty|no tty/i) ? 1 : 0;
}

sub run_in_child_shell {
  my ($deadline, @cmd) = @_;
  return run_with_stdin(undef, $deadline, $SH, "-c", '"$@"; rc=$?; exit "$rc"', "sh", @cmd);
}

sub run_probe_check {
  my ($deadline, $probe_kind) = @_;
  if ($probe_kind eq "sh") {
    return run_in_child_shell($deadline, $SUDO, "-N", "-n", $SH, "-c", ":");
  }
  return run_in_child_shell($deadline, $SUDO, "-N", "-n", "-v");
}

sub run_isolated_probe_check {
  my ($deadline, $probe_kind) = @_;
  return (127, "", "", 0) unless -x $SCRIPT;
  my @iso_cmd = $probe_kind eq "sh"
    ? ($SCRIPT, "-q", "/dev/null", $SUDO, "-N", "-n", $SH, "-c", ":")
    : ($SCRIPT, "-q", "/dev/null", $SUDO, "-N", "-n", "-v");
  return run_with_stdin(undef, $deadline, @iso_cmd);
}

sub verify_post_prime {
  my ($deadline, $probe_kind, $require_probe) = @_;
  if ($require_probe) {
    my ($rc, undef, undef, $to) = run_probe_check($deadline, $probe_kind);
    return "timeout" if $to;
    return "unavailable" if $rc != 0;
  }
  {
    my ($rc, $out, $err, $to) = run_isolated_probe_check($deadline, $probe_kind);
    return "timeout" if $to;
    return "unavailable" if $rc != 1 || ("$out$err" !~ /a password is required/);
  }
  {
    my ($rc, $out, undef, $to) = run_in_child_shell($deadline, $SUDO, "-N", "-n", "-l");
    return "timeout" if $to;
    return "unavailable" if $rc != 0 || !check_defaults_text($out, "auth");
  }
  for my $cmd_ref (@POLICY_CHECKS) {
    my ($rc, undef, undef, $to) = run_in_child_shell($deadline, @$cmd_ref);
    return "timeout" if $to;
    return "unavailable" if $rc != 0;
  }
  return "ok";
}

my $action = $ARGV[0] // "";
if ($action eq "check-defaults") {
  my $mode = $ARGV[1] // "auth";
  local $/;
  my $text = <STDIN>;
  $text = "" unless defined $text;
  exit(check_defaults_text($text, $mode) ? 0 : 1);
}

if ($action eq "precheck-defaults") {
  my $deadline = clock_gettime(CLOCK_MONOTONIC) + $AUTH_TIMEOUT;
  unlink "$DIR/answer";
  my ($rc, $out, undef, $to) = run_in_child_shell($deadline, $SUDO, "-N", "-n", "-l");
  if ($to) {
    write_answer("timeout");
    exit 1;
  }
  if ($rc == 0 && !check_defaults_text($out, "auth")) {
    write_answer("unavailable");
    exit 1;
  }
  exit 0;
}

if ($action eq "verify-cached") {
  my $probe_kind = $ARGV[1] // "sh";
  my $deadline = clock_gettime(CLOCK_MONOTONIC) + $AUTH_TIMEOUT;
  unlink "$DIR/answer";
  my $verdict = verify_post_prime($deadline, $probe_kind, 0);
  if ($verdict eq "ok") {
    exit 0;
  }
  write_answer($verdict);
  exit 1;
}

if ($action eq "authenticate") {
  my $probe_kind = $ARGV[1] // "sh";
  my $deadline = clock_gettime(CLOCK_MONOTONIC) + $AUTH_TIMEOUT;
  for my $attempt (1 .. 3) {
    if (clock_gettime(CLOCK_MONOTONIC) >= $deadline) {
      write_answer("timeout");
      exit 1;
    }
    unlink "$DIR/answer";
    my ($ask_rc, $pw, undef, $ask_to) = run_with_stdin(undef, $deadline, "$DIR/askpass.sh");
    if ($ask_to) {
      wipe_secret($pw);
      write_answer("timeout");
      exit 1;
    }
    if ($ask_rc != 0) {
      wipe_secret($pw);
      exit 1;
    }
    $pw =~ s/\\r?\\n\\z//;
    my $payload = "$pw\\n";
    my ($list_rc, $list_out, $list_err, $list_to) = run_with_stdin($payload, $deadline, $SUDO, "-N", "-S", "-p", "", "-l");
    if ($list_to) {
      wipe_secret($pw);
      wipe_secret($payload);
      write_answer("timeout");
      exit 1;
    }
    if ($list_rc != 0) {
      wipe_secret($pw);
      wipe_secret($payload);
      if (is_policy_denial($list_err)) {
        write_answer("unavailable");
        exit 1;
      }
      if ($attempt == 3) {
        write_answer("denied");
        exit 1;
      }
      next;
    }
    if (!check_defaults_text($list_out, "auth")) {
      wipe_secret($pw);
      wipe_secret($payload);
      write_answer("unavailable");
      exit 1;
    }
    if (open my $drop, ">", "$DIR/need-drop") {
      close $drop;
    }
    my @prime_cmd = $probe_kind eq "sh"
      ? ($SUDO, "-S", "-p", "", $SH, "-c", ":")
      : ($SUDO, "-S", "-p", "", "-v");
    my ($prime_rc, undef, $prime_err, $prime_to) = run_with_stdin($payload, $deadline, @prime_cmd);
    wipe_secret($pw);
    wipe_secret($payload);
    if ($prime_to) {
      write_answer("timeout");
      exit 1;
    }
    if ($prime_rc == 0) {
      my $verdict = verify_post_prime($deadline, $probe_kind, 1);
      if ($verdict eq "ok") {
        exit 0;
      }
      write_answer($verdict);
      exit 1;
    }
    if (is_policy_denial($prime_err)) {
      write_answer("unavailable");
      exit 1;
    }
    if ($attempt == 3) {
      write_answer("denied");
      exit 1;
    }
  }
  write_answer("denied");
  exit 1;
}

exit 2;
`;
}

function wrapperScript(
  dir: string,
  tools: ElevatedRunTools,
  trustedEnv: TrustedAuthEnv,
  checks: ReadonlyArray<SudoInvocationCheck>,
  cleanupTimeoutSeconds: number,
): string {
  const env = shellQuote(tools.env);
  const sudo = shellQuote(tools.sudo);
  const sh = shellQuote(tools.sh);
  const script = shellQuote(tools.script);
  const cat = shellQuote(tools.cat);
  const rm = shellQuote(tools.rm);
  const sleep = shellQuote(tools.sleep);
  const ps = shellQuote(tools.ps);
  const awk = shellQuote(tools.awk);
  const perl = shellQuote(tools.perl);
  const trustedHome = shellQuote(trustedEnv.home);
  const trustedUser = shellQuote(trustedEnv.user);
  const trustedTmpdir = shellQuote(trustedEnv.tmpdir);
  const cleanupTimeoutLit = shellQuote(
    Number.isFinite(cleanupTimeoutSeconds) && cleanupTimeoutSeconds > 0
      ? cleanupTimeoutSeconds.toFixed(3)
      : String(ELEVATION_CLEANUP_TIMEOUT_SECONDS),
  );
  const targets = distinctSudoTargets(checks);
  const nopasswdLines = [
    `  in_child_shell ${sudo} -k -n -v >/dev/null 2>&1 || return 1`,
    `  in_child_shell ${sudo} -k -n ${sh} -c : >/dev/null 2>&1 || return 1`,
    `  defaults_out="$(in_child_shell ${sudo} -k -n -l 2>/dev/null)" || return 1`,
    `  printf '%s\\n' "$defaults_out" | run_clean_env ${perl} "$dir/auth.pl" check-defaults nopasswd >/dev/null 2>&1 || return 1`,
    ...targets.map((target) => {
      const flags = sudoTargetArgs(target);
      return `  in_child_shell ${sudo} -k -n ${flags} ${sh} -c : >/dev/null 2>&1 || return 1`;
    }),
    ...checks.map((check) => {
      const flags = sudoTargetArgs(check);
      const flagPart = flags ? `${flags} ` : "";
      const argv = check.command.map(shellQuote).join(" ");
      return `  has_nopasswd_rule ${flagPart}-- ${argv} || return 1`;
    }),
  ];
  return `#!/bin/sh
# Asks for the administrator password once, verifies run-local policy and
# ticket isolation, runs the block, and forgets any ticket it asked for.
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
run_clean_env() {
  ${env} -i \\
    PATH=/usr/bin:/bin:/usr/sbin:/sbin \\
    HOME=${trustedHome} \\
    USER=${trustedUser} \\
    LOGNAME=${trustedUser} \\
    TMPDIR=${trustedTmpdir} \\
    LC_ALL=C \\
    TERM=xterm-256color \\
    "$@"
}
run_isolated() {
  pidfile="$1"
  grab_tty="$2"
  shift 2
  if [ -x ${perl} ]; then
    (
      _p5o_set="\${PERL5OPT+1}"; _p5o="\${PERL5OPT-}"
      _p5l_set="\${PERL5LIB+1}"; _p5l="\${PERL5LIB-}"
      _pl_set="\${PERLLIB+1}"; _pl="\${PERLLIB-}"
      unset PERL5OPT PERL5LIB PERLLIB PERL5DB PERL5DB_THREADED
      exec ${perl} -e 'use POSIX qw(setpgid tcsetpgrp isatty); setpgid(0, 0); if ($ARGV[1] && isatty(0)) { local $SIG{TTOU} = "IGNORE"; tcsetpgrp(0, $$); } open my $f, ">", $ARGV[0] or die $!; print $f "$$ 1\\n"; close $f; $ENV{PERL5OPT} = $ARGV[3] if $ARGV[2] eq "1"; $ENV{PERL5LIB} = $ARGV[5] if $ARGV[4] eq "1"; $ENV{PERLLIB} = $ARGV[7] if $ARGV[6] eq "1"; splice @ARGV, 0, 8; exec @ARGV or exit 127' "$pidfile" "$grab_tty" "$_p5o_set" "$_p5o" "$_p5l_set" "$_p5l" "$_pl_set" "$_pl" "$@"
    )
  else
    /bin/sh -c 'printf "%s 0\\n" "$$" > "$1"; shift; exec "$@"' sh "$pidfile" "$@"
  fi
}
run_isolated_clean() {
  pidfile="$1"
  grab_tty="$2"
  shift 2
  run_clean_env ${perl} -e 'use POSIX qw(setpgid tcsetpgrp isatty); setpgid(0, 0); if ($ARGV[1] && isatty(0)) { local $SIG{TTOU} = "IGNORE"; tcsetpgrp(0, $$); } open my $f, ">", $ARGV[0] or die $!; print $f "$$ 1\\n"; close $f; splice @ARGV, 0, 2; exec @ARGV or exit 127' "$pidfile" "$grab_tty" "$@"
}
reclaim_tty() {
  if [ -x ${perl} ]; then
    run_clean_env ${perl} -e 'use POSIX qw(tcsetpgrp isatty); if (isatty(0)) { local $SIG{TTOU} = "IGNORE"; tcsetpgrp(0, getpgrp()); }' 2>/dev/null
  fi
}
in_child_shell() {
  run_clean_env ${sh} -c '"$@"; rc=$?; exit "$rc"' sh "$@"
}
has_nopasswd_rule() {
  out="$(in_child_shell ${sudo} -k -n -l -l "$@" 2>/dev/null)" || return 1
  printf '%s\\n' "$out" | run_clean_env ${awk} '
    /^[[:space:]]*Commands:/ { exit(found ? 0 : 1) }
    /^[[:space:]]*Options:.*(^|[[:space:],])!authenticate([[:space:],]|$)/ { found = 1 }
    /^[[:space:]]*\\([^)]*\\)[[:space:]]+NOPASSWD:/ { found = 1 }
    END { exit(found ? 0 : 1) }
  '
}
check_block_nopasswd() {
${nopasswdLines.join("\n")}
  return 0
}
drop_ticket() {
  [ -f "$dir/need-drop" ] || return 0
  if [ -x ${perl} ]; then
    if run_clean_env ${perl} -e 'use strict; use warnings; use POSIX (); use Time::HiRes qw(clock_gettime CLOCK_MONOTONIC sleep); my ($timeout, @cmd) = @ARGV; my $deadline = clock_gettime(CLOCK_MONOTONIC) + ($timeout + 0); my $pid = fork(); exit 1 unless defined $pid; if ($pid == 0) { POSIX::setpgid(0, 0); open(STDIN, "<", "/dev/null"); open(STDOUT, ">", "/dev/null"); open(STDERR, ">", "/dev/null"); exec @cmd or POSIX::_exit(127); } POSIX::setpgid($pid, $pid); my ($reaped, $status) = (0, 0); while (1) { my $w = waitpid($pid, POSIX::WNOHANG); if ($w == $pid || $w < 0) { $reaped = 1; $status = $?; last; } last if clock_gettime(CLOCK_MONOTONIC) >= $deadline; sleep(0.05); } if (!$reaped) { kill "TERM", -$pid, $pid; for (1 .. 10) { if (!$reaped) { my $w = waitpid($pid, POSIX::WNOHANG); $reaped = 1 if ($w == $pid || $w < 0); } last if $reaped && !kill(0, -$pid); sleep(0.05); } if (!$reaped || kill(0, -$pid)) { kill "KILL", -$pid, $pid; if (!$reaped) { for (1 .. 10) { my $w = waitpid($pid, POSIX::WNOHANG); last if $w == $pid || $w < 0; sleep(0.05); } } } exit 124; } exit(($status & 127) ? (128 + ($status & 127)) : ($status >> 8));' ${cleanupTimeoutLit} ${sudo} -k 2>/dev/null; then
      ${rm} -f "$dir/need-drop" 2>/dev/null
    fi
  else
    run_clean_env ${sudo} -k 2>/dev/null && ${rm} -f "$dir/need-drop" 2>/dev/null
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
  # Only a ticket this run asked for is dropped; bound it so a hung sudo -k
  # cannot stall wrapper teardown or leak the staging directory.
  drop_ticket
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
if [ ! -x ${env} ] || [ ! -x ${sudo} ] || [ ! -x ${perl} ] || [ ! -x ${awk} ] || [ ! -x ${script} ]; then
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
  drop_ticket
  ${rm} -rf "$dir"
) </dev/null >/dev/null 2>&1 &
watch_pid=$!
if [ "$(run_clean_env ${shellQuote(tools.uname)} -s)" != "Darwin" ] || [ "$(run_clean_env ${shellQuote(tools.launchctl)} managername 2>/dev/null)" != "Aqua" ]; then
  # Non-macOS hosts and headless Mac services have no native password prompt here.
  # Fail closed before running any part of the block rather than relying on an
  # inconclusive sudo -n preflight that can pass under mixed sudoers policies.
  mark unavailable
  exit 1
fi
if ! check_block_nopasswd; then
  probe_kind=
  if ! in_child_shell ${sudo} -k -n ${sh} -c : >/dev/null 2>&1; then
    probe_kind=sh
  elif ! in_child_shell ${sudo} -k -n -v >/dev/null 2>&1; then
    probe_kind=v
  else
    # Neither /bin/sh nor -v requires a password (e.g. NOPASSWD:/bin/sh with
    # verifypw=any or verifypw=never), yet the block is not provably NOPASSWD.
    mark unavailable
    exit 1
  fi
  run_probe() {
    if [ "$probe_kind" = sh ]; then
      in_child_shell ${sudo} -N -n ${sh} -c : >/dev/null 2>&1
    else
      in_child_shell ${sudo} -N -n -v >/dev/null 2>&1
    fi
  }
  if run_probe; then
    # A cached ticket already exists: verify it is PTY-local (not timestamp_type=global),
    # sudoers defaults are safe, and every sudo invocation in the block is authorized.
    run_isolated_clean "$dir/ask.pid" 0 ${perl} "$dir/auth.pl" verify-cached "$probe_kind" 2>/dev/null &
    ask_pid=$!
    wait "$ask_pid"
    verified=$?
    ask_pid=
    ${rm} -f "$dir/ask.pid"
    if [ "$verified" != 0 ]; then
      state=unavailable
      [ -f "$dir/answer" ] && state="$(${cat} "$dir/answer")"
      case "$state" in timeout|unavailable) ;; *) state=unavailable ;; esac
      mark "$state"
      exit 1
    fi
  else
    # If sudoers allows passwordless listing (e.g. listpw=never), fail closed
    # before raising a password prompt when defaults are unsafe.
    run_isolated_clean "$dir/ask.pid" 0 ${perl} "$dir/auth.pl" precheck-defaults 2>/dev/null &
    ask_pid=$!
    wait "$ask_pid"
    prechecked=$?
    ask_pid=
    ${rm} -f "$dir/ask.pid"
    if [ "$prechecked" != 0 ]; then
      state=unavailable
      [ -f "$dir/answer" ] && state="$(${cat} "$dir/answer")"
      case "$state" in timeout|unavailable) ;; *) state=unavailable ;; esac
      mark "$state"
      exit 1
    fi
    mark waiting
    phase=prompt
    run_isolated_clean "$dir/ask.pid" 0 ${perl} "$dir/auth.pl" authenticate "$probe_kind" 2>/dev/null &
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
${rm} -f "$dir/block.sh" "$dir/label.txt" "$dir/askpass.sh" "$dir/auth.pl" "$dir/answer" "$dir/askpass.pid" "$dir/ask.pid"
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

export interface PreparedElevatedRun {
  readonly command: string;
  readonly cleanup: () => Promise<void>;
}

/**
 * Writes the run folder (or macOS Terminal `.command` file) and returns both
 * the command to run and a cleanup handle for pre-launch failures.
 */
export async function prepareElevatedRunHandle(
  input: ElevatedRunInput,
): Promise<PreparedElevatedRun> {
  const nonce = safeNonce(input.elevation);
  if (input.elevation.openIn === "terminal-app" && input.platform === "darwin") {
    const parent = await privateRunsDir(input.runsDir);
    const resolvedShell =
      input.shell?.trim() || process.env.SHELL?.trim() || NodeOS.userInfo().shell || undefined;
    const staged = await prepareTerminalAppRunHandle({
      command: input.command,
      cwd: input.cwd ?? "",
      ...(input.fallbackCwd ? { fallbackCwd: input.fallbackCwd } : {}),
      dir: parent,
      name: NodeCrypto.randomBytes(12).toString("hex"),
      nonce,
      ...(resolvedShell ? { shell: resolvedShell } : {}),
    });
    return { command: staged.command, cleanup: staged.cleanup };
  }
  const analysis = analyzeElevatedSudoInvocations(input.command);
  if (analysis.kind === "unsupported") {
    return {
      command: elevationStateCommand("unavailable", input.elevation),
      cleanup: async () => {},
    };
  }
  const parent = await privateRunsDir(input.runsDir);
  // A new folder each run: a run that is ending can only remove its own.
  const dir = await NodeFSP.mkdtemp(NodePath.join(parent, "run-"));
  const cleanup = () => NodeFSP.rm(dir, { recursive: true, force: true }).catch(() => {});
  try {
    const tools = { ...SYSTEM_TOOLS, ...input.tools };
    const userInfo = NodeOS.userInfo();
    const trustedEnv: TrustedAuthEnv = {
      home: userInfo.homedir,
      user: userInfo.username,
      tmpdir: NodeOS.tmpdir(),
    };
    const authTimeoutSeconds = input.authTimeoutSeconds ?? ELEVATION_AUTH_TIMEOUT_SECONDS;
    const cleanupTimeoutSeconds = input.cleanupTimeoutSeconds ?? ELEVATION_CLEANUP_TIMEOUT_SECONDS;
    const machineName = input.machineName ?? NodeOS.hostname().replace(/\.local$/, "");
    const write = (file: string, content: string, mode: number) =>
      NodeFSP.writeFile(NodePath.join(dir, file), content, { mode, flag: "wx" });
    await write("block.sh", input.command, 0o600);
    await write(
      "label.txt",
      elevationPromptLabel({ command: input.command, machineName, elevation: input.elevation }),
      0o600,
    );
    await write("askpass.sh", askpassScript(dir, tools, trustedEnv), 0o700);
    await write(
      "auth.pl",
      authHelperScript(dir, tools, trustedEnv, analysis.checks, authTimeoutSeconds),
      0o700,
    );
    await write("nonce", nonce, 0o600);
    await write(
      "run.sh",
      wrapperScript(dir, tools, trustedEnv, analysis.checks, cleanupTimeoutSeconds),
      0o700,
    );
    return {
      command: `/bin/sh ${shellQuote(NodePath.join(dir, "run.sh"))}`,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/**
 * Writes the run folder and returns the command the terminal runs instead of
 * the block. The folder holds no secret; the wrapper removes it when it ends.
 */
export async function prepareElevatedRun(input: ElevatedRunInput): Promise<string> {
  return (await prepareElevatedRunHandle(input)).command;
}
