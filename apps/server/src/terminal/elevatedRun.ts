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
  readonly kill?: string;
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
_ap_start="$(LC_ALL=C ${shellQuote(tools.ps)} -o lstart= -p "$$" 2>/dev/null | ${shellQuote(tools.awk)} '{ s=""; for (i=1; i<=NF; i++) s=(s=="" ? $i : s "_" $i); if (s != "") { print s; exit } }')"
if [ -n "$_ap_start" ]; then
  printf '%s 0 %s\\n' "$$" "$_ap_start" > "$dir/askpass.pid"
else
  printf '%s 0\\n' "$$" > "$dir/askpass.pid"
fi
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
 *  - `preflight`: computes one monotonic `$AUTH_TIMEOUT` deadline, persists it to
 *    `$DIR/deadline`, and runs every initial `sudo -k -n` NOPASSWD probe, probe
 *    selection, cached-ticket verification, and `precheck-defaults` check under
 *    that single deadline.
 *  - `authenticate <sh|v>`: continues the same `$DIR/deadline`, asks for the
 *    password via `askpass.sh`, verifies sudoers defaults via `sudo -N -S -p "" -l`
 *    BEFORE priming any ticket, and only then creates `need-drop`, primes in
 *    run/validate mode, and runs post-prime verification.
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
  const nopasswdTargetRows: string[] = targets.map((target) => {
    const flags = sudoTargetFlagList(target).map(perlSingleQuote).join(", ");
    return `  [$SUDO, '-k', '-n', ${flags}, $SH, '-c', ':'],`;
  });
  const nopasswdRuleRows: string[] = checks.map((check) => {
    const flags = sudoTargetFlagList(check).map(perlSingleQuote);
    const argv = check.command.map(perlSingleQuote);
    return `  [${["$SUDO", "'-k'", "'-n'", "'-l'", "'-l'", ...flags, "'--'", ...argv].join(", ")}],`;
  });
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
my @NOPASSWD_TARGET_CHECKS = (
${nopasswdTargetRows.join("\n")}
);
my @NOPASSWD_RULE_CHECKS = (
${nopasswdRuleRows.join("\n")}
);
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

sub has_nopasswd_rule_text {
  my ($text) = @_;
  my $found = 0;
  for my $line (split /\\r?\\n/, $text) {
    return $found ? 1 : 0 if $line =~ /^\\s*Commands:/;
    $found = 1 if $line =~ /^\\s*Options:.*(?:^|[\\s,])!authenticate(?:[\\s,]|$)/;
    $found = 1 if $line =~ /^\\s*\\([^)]*\\)\\s+NOPASSWD:/;
  }
  return $found ? 1 : 0;
}

sub write_answer {
  my ($state) = @_;
  if (open my $fh, ">", "$DIR/answer") {
    print $fh "$state\\n";
    close $fh;
  }
}

sub write_preflight {
  my ($line) = @_;
  if (open my $fh, ">", "$DIR/preflight") {
    print $fh "$line\\n";
    close $fh;
  }
}

sub write_deadline {
  my ($deadline) = @_;
  if (open my $fh, ">", "$DIR/deadline") {
    printf $fh "%.6f\\n", $deadline;
    close $fh;
  }
}

sub read_deadline {
  if (open my $fh, "<", "$DIR/deadline") {
    my $raw = <$fh>;
    close $fh;
    if (defined($raw) && $raw =~ /^\\s*(\\d+(?:\\.\\d+)?)\\s*$/) {
      return $1 + 0;
    }
  }
  return clock_gettime(CLOCK_MONOTONIC) + $AUTH_TIMEOUT;
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
  # Clean up any surviving descendants left in the helper's process group after
  # the leader exited normally (for example a background child holding fds open).
  if (kill(0, -$pid)) {
    kill "TERM", -$pid;
    for (1 .. 4) {
      last unless kill(0, -$pid);
      sleep(0.05);
    }
    if (kill(0, -$pid)) {
      kill "KILL", -$pid;
      for (1 .. 4) {
        last unless kill(0, -$pid);
        sleep(0.05);
      }
    }
  }
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

if ($action eq "preflight") {
  my $deadline = clock_gettime(CLOCK_MONOTONIC) + $AUTH_TIMEOUT;
  write_deadline($deadline);
  unlink "$DIR/answer", "$DIR/preflight";

  my ($v_rc, undef, undef, $v_to) = run_in_child_shell($deadline, $SUDO, "-k", "-n", "-v");
  if ($v_to) {
    write_answer("timeout");
    exit 1;
  }
  my ($sh_rc, undef, undef, $sh_to) = run_in_child_shell($deadline, $SUDO, "-k", "-n", $SH, "-c", ":");
  if ($sh_to) {
    write_answer("timeout");
    exit 1;
  }

  if ($v_rc == 0 && $sh_rc == 0) {
    my ($list_rc, $list_out, undef, $list_to) = run_in_child_shell($deadline, $SUDO, "-k", "-n", "-l");
    if ($list_to) {
      write_answer("timeout");
      exit 1;
    }
    my $nopasswd_ok = ($list_rc == 0 && check_defaults_text($list_out, "nopasswd")) ? 1 : 0;
    if ($nopasswd_ok) {
      for my $cmd_ref (@NOPASSWD_TARGET_CHECKS) {
        my ($rc, undef, undef, $to) = run_in_child_shell($deadline, @$cmd_ref);
        if ($to) {
          write_answer("timeout");
          exit 1;
        }
        if ($rc != 0) {
          $nopasswd_ok = 0;
          last;
        }
      }
    }
    if ($nopasswd_ok) {
      for my $cmd_ref (@NOPASSWD_RULE_CHECKS) {
        my ($rc, $out, undef, $to) = run_in_child_shell($deadline, @$cmd_ref);
        if ($to) {
          write_answer("timeout");
          exit 1;
        }
        if ($rc != 0 || !has_nopasswd_rule_text($out)) {
          $nopasswd_ok = 0;
          last;
        }
      }
    }
    if ($nopasswd_ok) {
      write_preflight("ready");
      exit 0;
    }
  }

  my $probe_kind = "";
  if ($sh_rc != 0) {
    $probe_kind = "sh";
  } elsif ($v_rc != 0) {
    $probe_kind = "v";
  } else {
    # Neither /bin/sh nor -v requires a password (e.g. NOPASSWD:/bin/sh with
    # verifypw=any or verifypw=never), yet the block is not provably NOPASSWD.
    write_answer("unavailable");
    exit 1;
  }

  my ($probe_rc, undef, undef, $probe_to) = run_probe_check($deadline, $probe_kind);
  if ($probe_to) {
    write_answer("timeout");
    exit 1;
  }
  if ($probe_rc == 0) {
    # A cached ticket already exists: verify it is PTY-local (not timestamp_type=global),
    # sudoers defaults are safe, and every sudo invocation in the block is authorized.
    my $verdict = verify_post_prime($deadline, $probe_kind, 0);
    if ($verdict eq "ok") {
      write_preflight("ready");
      exit 0;
    }
    write_answer($verdict);
    exit 1;
  }

  # If sudoers allows passwordless listing (e.g. listpw=never), fail closed
  # before raising a password prompt when defaults are unsafe.
  my ($pre_rc, $pre_out, undef, $pre_to) = run_in_child_shell($deadline, $SUDO, "-N", "-n", "-l");
  if ($pre_to) {
    write_answer("timeout");
    exit 1;
  }
  if ($pre_rc == 0 && !check_defaults_text($pre_out, "auth")) {
    write_answer("unavailable");
    exit 1;
  }

  write_preflight("prompt $probe_kind");
  exit 0;
}

if ($action eq "authenticate") {
  my $probe_kind = $ARGV[1] // "sh";
  my $deadline = read_deadline();
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
    my $drop_ok = 0;
    if (open my $drop, ">", "$DIR/need-drop") {
      $drop_ok = close($drop) ? 1 : 0;
    }
    if (!$drop_ok || -l "$DIR/need-drop" || !-f "$DIR/need-drop") {
      wipe_secret($pw);
      wipe_secret($payload);
      write_answer("unavailable");
      exit 1;
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
  cleanupTimeoutSeconds: number,
): string {
  const env = shellQuote(tools.env);
  const sudo = shellQuote(tools.sudo);
  const script = shellQuote(tools.script);
  const cat = shellQuote(tools.cat);
  const rm = shellQuote(tools.rm);
  const sleep = shellQuote(tools.sleep);
  const ps = shellQuote(tools.ps);
  const awk = shellQuote(tools.awk);
  const perl = shellQuote(tools.perl);
  const kill = tools.kill ? shellQuote(tools.kill) : "kill";
  const trustedHome = shellQuote(trustedEnv.home);
  const trustedUser = shellQuote(trustedEnv.user);
  const trustedTmpdir = shellQuote(trustedEnv.tmpdir);
  const cleanupTimeoutLit = shellQuote(
    Number.isFinite(cleanupTimeoutSeconds) && cleanupTimeoutSeconds > 0
      ? cleanupTimeoutSeconds.toFixed(3)
      : String(ELEVATION_CLEANUP_TIMEOUT_SECONDS),
  );
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
  root_start="\${4:-}"
  root_recycled="\${5:-0}"
  if [ "$#" -ge 5 ]; then
    shift 5
  else
    shift "$#"
  fi
  seeds="$*"
  [ -n "$root" ] || [ -n "$seeds" ] || return 0
  [ -x ${ps} ] && [ -x ${awk} ] || return 1
  _ps_out="$(LC_ALL=C ${ps} -eo pid=,ppid=,pgid=,lstart= 2>/dev/null)" || return 1
  [ -n "$_ps_out" ] || return 1
  printf '%s\\n' "$_ps_out" | ${awk} -v root="$root" -v own_pgid="$own_pgid" -v root_exited="$root_exited" -v root_start="$root_start" -v root_recycled="$root_recycled" -v seeds="$seeds" -v wrap="$wrapper_pid" '
    BEGIN {
      root = root + 0
      own_pgid = own_pgid + 0
      root_exited = root_exited + 0
      root_recycled = root_recycled + 0
      wrap = wrap + 0
      n = 0
    }
    {
      pid = $1 + 0; ppid = $2 + 0; pgid = $3 + 0
      if (pid <= 1) next
      st = ""
      for (i = 4; i <= NF; i++) {
        st = (st == "" ? $i : st "_" $i)
      }
      parent[pid] = ppid
      group[pid] = pgid
      start_of[pid] = st
      all[++n] = pid
      if (pid == root) root_pgid = pgid
    }
    END {
      if (n == 0) exit 1
      if (root > 1 && root_recycled == 0) {
        root_matches = 1
        if (root_start != "" && (root in parent) && start_of[root] != root_start) {
          root_matches = 0
          root_recycled = 1
        }
        if (root_exited == 0 && root_matches && (root in parent)) seen[root] = 1
        if (root_recycled == 0 && (own_pgid == 1 || (root_exited == 0 && root_matches && root_pgid == root))) {
          for (i = 1; i <= n; i++) {
            p = all[i]
            if (group[p] == root) {
              if (p == root && (root_exited == 1 || !root_matches)) continue
              seen[p] = 1
            }
          }
        }
      }
      m = split(seeds, seed_arr, /[ \\t\\r\\n]+/)
      for (i = 1; i <= m; i++) {
        tok = seed_arr[i]
        if (tok == "") continue
        colon = index(tok, ":")
        if (colon > 0) {
          sp = substr(tok, 1, colon - 1) + 0
          sst = substr(tok, colon + 1)
        } else {
          sp = tok + 0
          sst = ""
        }
        if (sp <= 1 || sp == wrap) continue
        if (!(sp in parent)) continue
        if (sst != "" && start_of[sp] != sst) continue
        seen[sp] = 1
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
        if (seen[p] == 1 && (p + 0) > 1 && (p + 0) != wrap) {
          if (start_of[p] != "") print p ":" start_of[p]
          else print p
        }
      }
    }
  '
}
check_root_identity() {
  _cr_pid="$1"
  _cr_start="\${2:-}"
  [ -n "$_cr_start" ] || return 0
  if [ -x ${perl} ]; then
    run_clean_env ${perl} -e 'use POSIX qw(EPERM); my ($ps, $pid, $expected) = @ARGV; my $ok = kill(0, $pid); exit 1 unless $ok || $! == EPERM; local $ENV{LC_ALL} = "C"; exit 3 unless -x $ps && open my $fh, "-|", $ps, "-o", "pid=,lstart=", "-p", $pid; my ($found, $cur) = (0, ""); while (<$fh>) { if (/^\\s*(\\d+)\\s+(.+?)\\s*$/ && $1 == $pid) { $found = 1; $cur = $2; $cur =~ s/\\s+/_/g; last; } } my $ps_ok = close($fh) && $? == 0; if (!$ps_ok) { my $ok2 = kill(0, $pid); exit 1 unless $ok2 || $! == EPERM; exit 3; } exit 1 unless $found; exit($cur eq $expected ? 0 : 2);' ${ps} "$_cr_pid" "$_cr_start" 2>/dev/null
    return $?
  fi
  return 3
}
resolve_signal_pids() {
  [ $# -gt 0 ] || return 0
  if [ -x ${perl} ]; then
    run_clean_env ${perl} -e 'use POSIX qw(EPERM); my $ps = shift @ARGV; my (%bare, %stamped, @order, %seen_pid); for my $tok (@ARGV) { if ($tok =~ /^(\\d+):([A-Za-z0-9:._+-]+)$/) { my ($p, $st) = ($1, $2); next unless $p > 1; push @order, $p unless $seen_pid{$p}++; $stamped{$p} = $st; } elsif ($tok =~ /^(\\d+)$/) { my $p = $1; next unless $p > 1; push @order, $p unless $seen_pid{$p}++; $bare{$p} = 1; } } my @need_ps; for my $p (@order) { next unless exists $stamped{$p}; my $ok = kill(0, $p); push @need_ps, $p if $ok || $! == EPERM; } my %cur; if (@need_ps) { local $ENV{LC_ALL} = "C"; exit 2 unless -x $ps && open my $fh, "-|", $ps, "-o", "pid=,lstart=", "-p", join(",", @need_ps); while (<$fh>) { if (/^\\s*(\\d+)\\s+(.+?)\\s*$/) { my ($p, $st) = ($1, $2); $st =~ s/\\s+/_/g; $cur{$p} = $st; } } my $ps_ok = close($fh) && $? == 0; if (!$ps_ok) { for my $p (@need_ps) { my $ok = kill(0, $p); exit 2 if $ok || $! == EPERM; } } } for my $p (@order) { if (exists $stamped{$p}) { print "$p\\n" if defined($cur{$p}) && $cur{$p} eq $stamped{$p}; } elsif ($bare{$p}) { print "$p\\n"; } }' ${ps} "$@" 2>/dev/null
    return $?
  fi
  return 2
}
pids_alive() {
  [ $# -gt 0 ] || return 1
  if [ -x ${perl} ]; then
    run_clean_env ${perl} -e 'use POSIX qw(EPERM); my $ps = shift @ARGV; my (%seen, @entries, @live_pids); for my $tok (@ARGV) { my ($p, $st); if ($tok =~ /^(\\d+):([A-Za-z0-9:._+-]+)$/) { ($p, $st) = ($1, $2); } elsif ($tok =~ /^(\\d+)$/) { ($p, $st) = ($1, ""); } else { next; } next unless $p > 1; my $key = "$p:$st"; next if $seen{$key}++; my $ok = kill(0, $p); if ($ok || $! == EPERM) { push @entries, [$p, $st]; push @live_pids, $p; } } exit 10 unless @entries; local $ENV{LC_ALL} = "C"; if (-x $ps && open my $fh, "-|", $ps, "-o", "pid=,stat=,lstart=", "-p", join(",", @live_pids)) { my %info; while (<$fh>) { if (/^\\s*(\\d+)\\s+(\\S+)\\s*(.*?)\\s*$/) { my ($p, $stat, $lst) = ($1, $2, $3); $lst =~ s/\\s+/_/g; $info{$p} = [$stat, $lst]; } } my $ps_ok = close($fh) && $? == 0; if (!$ps_ok) { for my $e (@entries) { my $ok = kill(0, $e->[0]); exit 0 if $ok || $! == EPERM; } exit 10; } for my $e (@entries) { my ($p, $exp) = @$e; if (defined $info{$p}) { next if $info{$p}[0] =~ /^Z/; next if $exp ne "" && $info{$p}[1] ne "" && $info{$p}[1] ne $exp; } my $ok = kill(0, $p); exit 0 if $ok || $! == EPERM; } exit 10; } exit 0;' ${ps} "$@" 2>/dev/null
    _rc=$?
    [ "$_rc" = 10 ] && return 1
    return 0
  fi
  return 0
}
pgid_alive() {
  _pg="$1"
  case "$_pg" in
    ""|*[!0-9]*|0|1) return 1 ;;
  esac
  if [ -x ${perl} ]; then
    run_clean_env ${perl} -e 'use POSIX qw(EPERM); my ($ps, $pg) = @ARGV; my $ok = kill(0, -$pg); my $eperm = (!$ok && $! == EPERM) ? 1 : 0; exit 10 unless $ok || $eperm; exit 0 if $eperm; if (-x $ps && open my $fh, "-|", $ps, "-eo", "pid=,pgid=,stat=") { my ($found, $non_zombie) = (0, 0); while (<$fh>) { if (/^\\s*(\\d+)\\s+(\\d+)\\s+(\\S+)/ && $2 == $pg) { $found++; $non_zombie++ unless $3 =~ /^Z/; } } my $ps_ok = close($fh) && $? == 0; if ($ps_ok && $found > 0 && $non_zombie == 0) { exit 10; } if (!$ps_ok || $found == 0) { my $ok2 = kill(0, -$pg); exit 10 unless $ok2 || $! == EPERM; } } exit 0;' ${ps} "$_pg" 2>/dev/null
    _rc=$?
    [ "$_rc" = 10 ] && return 1
    return 0
  fi
  return 0
}
append_observed() {
  for _op in "$@"; do
    _op_pid="\${_op%%:*}"
    case "$_op_pid" in
      ""|*[!0-9]*|0|1|"$wrapper_pid") continue ;;
    esac
    if [ "$_op" = "$_op_pid" ]; then
      case " $observed " in
        *" $_op_pid "*|*" $_op_pid:"*) continue ;;
      esac
    else
      case " $observed " in
        *" $_op "*) continue ;;
      esac
    fi
    observed="\${observed:+$observed }$_op"
  done
}
load_observed() {
  _obsfile="$1"
  [ -f "$_obsfile" ] || return 0
  if [ -x ${perl} ]; then
    run_clean_env ${perl} -e 'my ($f, $wrap) = @ARGV; open my $fh, "<", $f or exit 1; my (%seen, %has_stamped, @toks); while (<$fh>) { for my $tok (split /\\s+/) { if ($tok =~ /^(\\d+):([A-Za-z0-9:._+-]+)$/) { next unless $1 > 1 && $1 != $wrap; $has_stamped{$1} = 1; push @toks, $tok unless $seen{$tok}++; } elsif ($tok =~ /^(\\d+)$/) { next unless $1 > 1 && $1 != $wrap; push @toks, $tok unless $seen{$tok}++; } } } close $fh or exit 1; for my $tok (@toks) { next if $tok =~ /^(\\d+)$/ && $has_stamped{$1}; print "$tok\\n"; }' "$_obsfile" "$wrapper_pid" 2>/dev/null
    return $?
  fi
  return 1
}
persist_observed() {
  _obsfile="$1"
  shift
  [ $# -gt 0 ] || return 0
  if [ -x ${perl} ]; then
    run_clean_env ${perl} -e 'my ($f, $wrap, @args) = @ARGV; my (%seen, %has_stamped); my $add = sub { my ($tok) = @_; if ($tok =~ /^(\\d+):([A-Za-z0-9:._+-]+)$/) { return unless $1 > 1 && $1 != $wrap; $seen{$tok} = 1; $has_stamped{$1} = 1; } elsif ($tok =~ /^(\\d+)$/) { return unless $1 > 1 && $1 != $wrap; $seen{$tok} = 1; } }; if (-e $f) { open my $in, "<", $f or exit 1; while (<$in>) { $add->($_) for split /\\s+/; } close $in or exit 1; } $add->($_) for @args; my @out = sort grep { !(/^(\\d+)$/ && $has_stamped{$1}) } keys %seen; exit 0 unless @out; my $tmp = "$f.tmp.$$"; open my $out_fh, ">", $tmp or exit 1; for my $tok (@out) { print $out_fh "$tok\\n" or do { close $out_fh; unlink $tmp; exit 1; }; } close $out_fh or do { unlink $tmp; exit 1; }; rename($tmp, $f) or do { unlink $tmp; exit 1; };' "$_obsfile" "$wrapper_pid" "$@" 2>/dev/null
    return $?
  fi
  return 1
}
mark_teardown() {
  [ -f "$dir/launch.lock" ] || return 0
  if [ -x ${perl} ]; then
    run_clean_env ${perl} -e 'use Fcntl qw(:DEFAULT :flock); my ($lock, $td) = @ARGV; sysopen(my $lf, $lock, O_RDWR | O_NOFOLLOW) or exit 0; flock($lf, LOCK_EX) or exit 0; open(my $f, ">", $td) and do { print $f "1\\n"; close $f; }; close $lf;' "$dir/launch.lock" "$dir/teardown" 2>/dev/null
  else
    printf '1\\n' > "$dir/teardown" 2>/dev/null
  fi
}
stop_target() {
  pidfile="$1"
  root_exited="\${2:-0}"
  [ -f "$pidfile" ] || return 0
  obsfile="\${pidfile}.observed"
  exitedfile="\${pidfile}.exited"
  [ -f "$exitedfile" ] && root_exited=1
  target_pid=
  own_pgid=0
  root_start=
  read target_pid own_pgid root_start < "$pidfile" 2>/dev/null
  case "$target_pid" in
    ""|*[!0-9]*|0|1) ${rm} -f "$pidfile" "$obsfile" "$exitedfile"; return 0 ;;
  esac
  own_pgid="\${own_pgid:-0}"
  if [ "$root_exited" = 1 ] && [ "$own_pgid" != 1 ] && [ ! -f "$obsfile" ]; then
    ${rm} -f "$pidfile" "$exitedfile"
    return 0
  fi
  snapshot_failed=0
  root_recycled=0
  observed=
  if [ -f "$obsfile" ]; then
    if prev_observed="$(load_observed "$obsfile")"; then
      [ -n "$prev_observed" ] && append_observed $prev_observed
    else
      snapshot_failed=1
      printf 'stop-target-failed\\n' > "$dir/stop-failed" 2>/dev/null
    fi
  fi
  if [ -n "$root_start" ]; then
    check_root_identity "$target_pid" "$root_start"
    _cr_rc=$?
    case "$_cr_rc" in
      0) ;;
      1) root_exited=1 ;;
      2) root_exited=1; root_recycled=1 ;;
      *)
        root_exited=1
        root_recycled=1
        snapshot_failed=1
        printf 'stop-target-failed\\n' > "$dir/stop-failed" 2>/dev/null
        ;;
    esac
  fi
  # Freeze first so a shell cannot advance to the next command or fork while stopping.
  [ "$own_pgid" = 1 ] && [ "$root_recycled" = 0 ] && ${kill} -STOP -"$target_pid" 2>/dev/null
  [ "$root_exited" = 0 ] && [ "$root_recycled" = 0 ] && ${kill} -STOP "$target_pid" 2>/dev/null
  if snap1="$(collect_tree "$target_pid" "$own_pgid" "$root_exited" "$root_start" "$root_recycled" $observed)"; then
    if [ -n "$snap1" ]; then
      append_observed $snap1
      if ! persist_observed "$obsfile" $observed; then
        snapshot_failed=1
        printf 'stop-target-failed\\n' > "$dir/stop-failed" 2>/dev/null
      fi
    fi
  else
    snapshot_failed=1
    printf 'stop-target-failed\\n' > "$dir/stop-failed" 2>/dev/null
  fi
  if [ -z "$observed" ] && [ "$snapshot_failed" = 0 ]; then
    _root_tok="$target_pid"
    [ -n "$root_start" ] && _root_tok="$target_pid:$root_start"
    if ! { [ "$root_exited" = 0 ] && [ "$root_recycled" = 0 ] && pids_alive "$_root_tok"; } && ! { [ "$own_pgid" = 1 ] && [ "$root_recycled" = 0 ] && pgid_alive "$target_pid"; }; then
      [ "$own_pgid" = 1 ] && [ "$root_recycled" = 0 ] && ${kill} -CONT -"$target_pid" 2>/dev/null
      ${rm} -f "$pidfile" "$obsfile" "$exitedfile"
      return 0
    fi
  fi
  if [ -n "$observed" ]; then
    if sig_pids="$(resolve_signal_pids $observed)"; then
      [ -n "$sig_pids" ] && ${kill} -STOP $sig_pids 2>/dev/null
    else
      snapshot_failed=1
      printf 'stop-target-failed\\n' > "$dir/stop-failed" 2>/dev/null
    fi
  fi
  # Retain the union of every observed PID across snapshots and persist it to
  # $pidfile.observed so a privileged descendant reparented after its parent
  # exits cannot be forgotten before TERM, KILL, final liveness checks, or
  # watcher takeover if the wrapper is SIGKILLed mid-teardown.
  if snap2="$(collect_tree "$target_pid" "$own_pgid" "$root_exited" "$root_start" "$root_recycled" $observed)"; then
    [ -n "$snap2" ] && append_observed $snap2
  else
    snapshot_failed=1
    printf 'stop-target-failed\\n' > "$dir/stop-failed" 2>/dev/null
  fi
  if [ "$root_exited" = 0 ] && [ "$root_recycled" = 0 ]; then
    if [ -n "$root_start" ]; then
      append_observed "$target_pid:$root_start"
    else
      append_observed "$target_pid"
    fi
  fi
  if [ -n "$observed" ]; then
    if ! persist_observed "$obsfile" $observed; then
      snapshot_failed=1
      printf 'stop-target-failed\\n' > "$dir/stop-failed" 2>/dev/null
    fi
  fi
  [ "$own_pgid" = 1 ] && [ "$root_recycled" = 0 ] && ${kill} -TERM -"$target_pid" 2>/dev/null
  sig_pids=
  if [ -n "$observed" ]; then
    if sig_pids="$(resolve_signal_pids $observed)"; then
      [ -n "$sig_pids" ] && ${kill} -TERM $sig_pids 2>/dev/null
    else
      snapshot_failed=1
      printf 'stop-target-failed\\n' > "$dir/stop-failed" 2>/dev/null
    fi
  fi
  [ "$own_pgid" = 1 ] && [ "$root_recycled" = 0 ] && ${kill} -CONT -"$target_pid" 2>/dev/null
  [ -n "$sig_pids" ] && ${kill} -CONT $sig_pids 2>/dev/null
  i=0
  while [ "$i" -lt 5 ]; do
    _alive=0
    [ -n "$observed" ] && pids_alive $observed && _alive=1
    [ "$own_pgid" = 1 ] && [ "$root_recycled" = 0 ] && pgid_alive "$target_pid" && _alive=1
    [ "$_alive" = 0 ] && break
    ${sleep} 0.2 2>/dev/null || ${sleep} 1
    i=$((i + 1))
  done
  if more="$(collect_tree "$target_pid" "$own_pgid" "$root_exited" "$root_start" "$root_recycled" $observed)"; then
    if [ -n "$more" ]; then
      append_observed $more
      if ! persist_observed "$obsfile" $observed; then
        snapshot_failed=1
        printf 'stop-target-failed\\n' > "$dir/stop-failed" 2>/dev/null
      fi
    fi
  else
    snapshot_failed=1
    printf 'stop-target-failed\\n' > "$dir/stop-failed" 2>/dev/null
  fi
  [ "$own_pgid" = 1 ] && [ "$root_recycled" = 0 ] && ${kill} -KILL -"$target_pid" 2>/dev/null
  if [ -n "$observed" ]; then
    if sig_pids="$(resolve_signal_pids $observed)"; then
      for p in $sig_pids; do
        ${kill} -KILL "$p" 2>/dev/null
      done
    else
      snapshot_failed=1
      printf 'stop-target-failed\\n' > "$dir/stop-failed" 2>/dev/null
    fi
  fi
  i=0
  while [ "$i" -lt 5 ]; do
    if remaining="$(collect_tree "$target_pid" "$own_pgid" "$root_exited" "$root_start" "$root_recycled" $observed)"; then
      if [ -n "$remaining" ]; then
        append_observed $remaining
        if ! persist_observed "$obsfile" $observed; then
          snapshot_failed=1
          printf 'stop-target-failed\\n' > "$dir/stop-failed" 2>/dev/null
        fi
      fi
    else
      snapshot_failed=1
      printf 'stop-target-failed\\n' > "$dir/stop-failed" 2>/dev/null
    fi
    _alive=0
    [ -n "$observed" ] && pids_alive $observed && _alive=1
    [ "$own_pgid" = 1 ] && [ "$root_recycled" = 0 ] && pgid_alive "$target_pid" && _alive=1
    [ "$_alive" = 0 ] && break
    ${sleep} 0.1 2>/dev/null || ${sleep} 1
    i=$((i + 1))
  done
  if remaining="$(collect_tree "$target_pid" "$own_pgid" "$root_exited" "$root_start" "$root_recycled" $observed)"; then
    if [ -n "$remaining" ]; then
      append_observed $remaining
      if ! persist_observed "$obsfile" $observed; then
        snapshot_failed=1
        printf 'stop-target-failed\\n' > "$dir/stop-failed" 2>/dev/null
      fi
    fi
  else
    snapshot_failed=1
    printf 'stop-target-failed\\n' > "$dir/stop-failed" 2>/dev/null
  fi
  if [ "$snapshot_failed" != 0 ] || { [ -n "$observed" ] && pids_alive $observed; } || { [ "$own_pgid" = 1 ] && [ "$root_recycled" = 0 ] && pgid_alive "$target_pid"; }; then
    # A live descendant/group member survived SIGKILL (for example a root-owned
    # child returning EPERM) or process enumeration failed. Keep the pidfile and
    # observed set and mark teardown failed so finalize_run_dir fails closed.
    printf 'stop-target-failed\\n' > "$dir/stop-failed" 2>/dev/null
    return 1
  fi
  # Remove the pidfile and observed list only after teardown completes so a
  # SIGKILL mid-stop still lets the watcher discover and finish killing the
  # target tree.
  ${rm} -f "$pidfile" "$obsfile" "$exitedfile"
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
      exec ${perl} -e 'use Fcntl qw(:DEFAULT :flock); use POSIX qw(setpgid tcsetpgrp isatty EPERM); my ($lock, $td, $cf, $wpid, $pidfile, $grab_tty, $ps, $p5os, $p5o, $p5ls, $p5l, $pls, $pl) = splice(@ARGV, 0, 13); setpgid(0, 0); sysopen(my $lf, $lock, O_RDWR | O_NOFOLLOW) or exit 1; flock($lf, LOCK_EX) or exit 1; if (-e $td || -e $cf || !-e $lock || (!kill(0, $wpid) && $! != EPERM)) { exit 1; } my $start = ""; { local $ENV{LC_ALL} = "C"; if (-x $ps && open my $pfh, "-|", $ps, "-o", "lstart=", "-p", $$) { my $line = <$pfh>; close $pfh; if ($? == 0 && defined $line) { $line =~ s/^\\s+|\\s+$//g; $line =~ s/\\s+/_/g; $start = $line if $line =~ /^[A-Za-z0-9:._+-]+$/; } } } open my $f, ">", $pidfile or exit 1; print $f ($start ne "" ? "$$ 1 $start\\n" : "$$ 1\\n"); close $f or exit 1; close $lf; if ($grab_tty && isatty(0)) { local $SIG{TTOU} = "IGNORE"; tcsetpgrp(0, $$); } $ENV{PERL5OPT} = $p5o if $p5os eq "1"; $ENV{PERL5LIB} = $p5l if $p5ls eq "1"; $ENV{PERLLIB} = $pl if $pls eq "1"; exec @ARGV or exit 127' "$dir/launch.lock" "$dir/teardown" "$dir/cleanup-failed" "$wrapper_pid" "$pidfile" "$grab_tty" ${ps} "$_p5o_set" "$_p5o" "$_p5l_set" "$_p5l" "$_pl_set" "$_pl" "$@"
    )
  else
    return 1
  fi
}
run_isolated_clean() {
  pidfile="$1"
  grab_tty="$2"
  shift 2
  run_clean_env ${perl} -e 'use Fcntl qw(:DEFAULT :flock); use POSIX qw(setpgid tcsetpgrp isatty EPERM); my ($lock, $td, $cf, $wpid, $pidfile, $grab_tty, $ps) = splice(@ARGV, 0, 7); setpgid(0, 0); sysopen(my $lf, $lock, O_RDWR | O_NOFOLLOW) or exit 1; flock($lf, LOCK_EX) or exit 1; if (-e $td || -e $cf || !-e $lock || (!kill(0, $wpid) && $! != EPERM)) { exit 1; } my $start = ""; { local $ENV{LC_ALL} = "C"; if (-x $ps && open my $pfh, "-|", $ps, "-o", "lstart=", "-p", $$) { my $line = <$pfh>; close $pfh; if ($? == 0 && defined $line) { $line =~ s/^\\s+|\\s+$//g; $line =~ s/\\s+/_/g; $start = $line if $line =~ /^[A-Za-z0-9:._+-]+$/; } } } open my $f, ">", $pidfile or exit 1; print $f ($start ne "" ? "$$ 1 $start\\n" : "$$ 1\\n"); close $f or exit 1; close $lf; if ($grab_tty && isatty(0)) { local $SIG{TTOU} = "IGNORE"; tcsetpgrp(0, $$); } exec @ARGV or exit 127' "$dir/launch.lock" "$dir/teardown" "$dir/cleanup-failed" "$wrapper_pid" "$pidfile" "$grab_tty" ${ps} "$@"
}
reclaim_tty() {
  if [ -x ${perl} ]; then
    run_clean_env ${perl} -e 'use POSIX qw(tcsetpgrp isatty); if (isatty(0)) { local $SIG{TTOU} = "IGNORE"; tcsetpgrp(0, getpgrp()); }' 2>/dev/null
  fi
}
drop_ticket() {
  [ -f "$dir/need-drop" ] || return 0
  if [ -x ${perl} ]; then
    if run_clean_env ${perl} -e 'use strict; use warnings; use POSIX (); use Time::HiRes qw(clock_gettime CLOCK_MONOTONIC sleep); my ($timeout, @cmd) = @ARGV; my $deadline = clock_gettime(CLOCK_MONOTONIC) + ($timeout + 0); my $pid = fork(); exit 1 unless defined $pid; if ($pid == 0) { POSIX::setpgid(0, 0); open(STDIN, "<", "/dev/null"); open(STDOUT, ">", "/dev/null"); open(STDERR, ">", "/dev/null"); exec @cmd or POSIX::_exit(127); } POSIX::setpgid($pid, $pid); my ($reaped, $status) = (0, 0); while (1) { my $w = waitpid($pid, POSIX::WNOHANG); if ($w == $pid || $w < 0) { $reaped = 1; $status = $?; last; } last if clock_gettime(CLOCK_MONOTONIC) >= $deadline; sleep(0.05); } if (!$reaped) { kill "TERM", -$pid, $pid; for (1 .. 10) { if (!$reaped) { my $w = waitpid($pid, POSIX::WNOHANG); $reaped = 1 if ($w == $pid || $w < 0); } last if $reaped && !kill(0, -$pid); sleep(0.05); } if (!$reaped || kill(0, -$pid)) { kill "KILL", -$pid, $pid; if (!$reaped) { for (1 .. 10) { my $w = waitpid($pid, POSIX::WNOHANG); last if $w == $pid || $w < 0; sleep(0.05); } } } exit 124; } if (kill(0, -$pid)) { kill "TERM", -$pid; for (1 .. 4) { last unless kill(0, -$pid); sleep(0.05); } if (kill(0, -$pid)) { kill "KILL", -$pid; for (1 .. 4) { last unless kill(0, -$pid); sleep(0.05); } } } exit(($status & 127) ? (128 + ($status & 127)) : ($status >> 8));' ${cleanupTimeoutLit} ${sudo} -k 2>/dev/null; then
      ${rm} -f "$dir/need-drop" 2>/dev/null
    fi
  else
    run_clean_env ${sudo} -k 2>/dev/null && ${rm} -f "$dir/need-drop" 2>/dev/null
  fi
}
finalize_run_dir() {
  if [ -f "$dir/need-drop" ] || [ -f "$dir/stop-failed" ]; then
    # Record failure before removing scratch files so Manager never mistakes a
    # failed sudo -k or surviving descendant process (for example EPERM on root)
    # for confirmed teardown.
    if [ -f "$dir/need-drop" ] && [ -f "$dir/stop-failed" ]; then
      printf 'drop-ticket-and-stop-target-failed\\n' > "$dir/cleanup-failed" 2>/dev/null
    elif [ -f "$dir/stop-failed" ]; then
      printf 'stop-target-failed\\n' > "$dir/cleanup-failed" 2>/dev/null
    else
      printf 'drop-ticket-failed\\n' > "$dir/cleanup-failed" 2>/dev/null
    fi
    ${rm} -f "$dir/run.sh" "$dir/block.sh" "$dir/label.txt" "$dir/askpass.sh" "$dir/auth.pl" "$dir/nonce" "$dir/answer" "$dir/deadline" "$dir/preflight" "$dir/askpass.pid" "$dir/ask.pid" "$dir/block.pid" "$dir/askpass.pid.observed" "$dir/ask.pid.observed" "$dir/block.pid.observed" "$dir/askpass.pid.exited" "$dir/ask.pid.exited" "$dir/block.pid.exited" "$dir"/*.observed.tmp.* "$dir/launch.lock" "$dir/teardown" "$dir/stop-failed" 2>/dev/null
  else
    ${rm} -rf "$dir"
  fi
}
phase=check
ask_pid=
watch_pid=
block_exited=0
cleanup() {
  mark_teardown
  stop_target "$dir/block.pid" "$block_exited"
  stop_target "$dir/ask.pid"
  stop_target "$dir/askpass.pid"
  [ -n "$ask_pid" ] && kill -TERM "$ask_pid" 2>/dev/null
  reclaim_tty
  # Only a ticket this run asked for is dropped; bound it so a hung sudo -k
  # cannot stall wrapper teardown, and keep a cleanup-failed marker instead of
  # deleting $dir when invalidation does not succeed.
  drop_ticket
  finalize_run_dir
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
# Lock file serializing child PID publication against watcher/cleanup teardown.
: > "$dir/launch.lock"
# Start the watcher before prompting so SIGKILL during authentication still
# kills the helper, drops any newly primed ticket and finalizes the run folder.
(
  trap '' HUP INT TERM
  while kill -0 "$wrapper_pid" 2>/dev/null; do
    ${sleep} 0.2 2>/dev/null || ${sleep} 1
  done
  if [ -d "$dir" ] && [ ! -f "$dir/cleanup-failed" ]; then
    mark_teardown
    stop_target "$dir/ask.pid"
    stop_target "$dir/askpass.pid"
    stop_target "$dir/block.pid"
    drop_ticket
    finalize_run_dir
  fi
) </dev/null >/dev/null 2>&1 &
watch_pid=$!
# Signal that the wrapper and its SIGKILL watcher own teardown; removing $dir is
# the cleanup acknowledgement waited on before any replacement/close/restart.
printf '%s\\n' "$wrapper_pid" > "$dir/started"
if [ "$(run_clean_env ${shellQuote(tools.uname)} -s)" != "Darwin" ] || [ "$(run_clean_env ${shellQuote(tools.launchctl)} managername 2>/dev/null)" != "Aqua" ]; then
  # Non-macOS hosts and headless Mac services have no native password prompt here.
  # Fail closed before running any part of the block rather than relying on an
  # inconclusive sudo -n preflight that can pass under mixed sudoers policies.
  mark unavailable
  exit 1
fi
run_isolated_clean "$dir/ask.pid" 0 ${perl} "$dir/auth.pl" preflight 2>/dev/null &
ask_pid=$!
wait "$ask_pid"
preflight_rc=$?
ask_pid=
${rm} -f "$dir/ask.pid"
if [ "$preflight_rc" != 0 ]; then
  state=unavailable
  [ -f "$dir/answer" ] && state="$(${cat} "$dir/answer")"
  case "$state" in timeout|unavailable) ;; *) state=unavailable ;; esac
  mark "$state"
  exit 1
fi
preflight_mode=
probe_kind=
if [ -f "$dir/preflight" ]; then
  read preflight_mode probe_kind < "$dir/preflight" 2>/dev/null
fi
if [ "$preflight_mode" = prompt ]; then
  case "$probe_kind" in
    sh|v) ;;
    *) mark unavailable; exit 1 ;;
  esac
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
elif [ "$preflight_mode" != ready ]; then
  mark unavailable
  exit 1
fi
phase=run
block="$(${cat} "$dir/block.sh")"
${rm} -f "$dir/block.sh" "$dir/label.txt" "$dir/askpass.sh" "$dir/auth.pl" "$dir/answer" "$dir/deadline" "$dir/preflight" "$dir/askpass.pid" "$dir/ask.pid"
# The block runs in the foreground in its own process group (with the tty
# foreground transferred to it when stdin is a tty) so Ctrl-C delivers SIGINT
# immediately while abnormal termination still tears down the whole tree.
trap - TERM HUP
mark started
run_isolated "$dir/block.pid" 1 "\${SHELL:-/bin/sh}" -c "$block"
code=$?
block_exited=1
printf '1\\n' > "$dir/block.pid.exited" 2>/dev/null
reclaim_tty
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
  /**
   * Staging directory owned by the in-terminal `run.sh` wrapper (and its
   * SIGKILL watcher). Once `run.sh` writes `$runDir/started`, removing `runDir`
   * acknowledges that descendant teardown and ticket cleanup have finished;
   * if `sudo -k` fails or times out, the wrapper deletes scripts/scratch files
   * and writes `$runDir/cleanup-failed` while keeping `runDir` so the manager
   * fails closed instead of treating teardown as confirmed.
   */
  readonly runDir?: string;
  /**
   * Marker file created by the Terminal.app launcher immediately before
   * invoking `open -a Terminal`, and removed either on `open` failure or when
   * the opened `.command` script starts running in Terminal.app. Its presence
   * after a mid-spawn disposal signals that handoff may already be pending, so
   * the manager must not unlink the `.command` script out from under it.
   */
  readonly handoffMarker?: string;
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
    return {
      command: staged.command,
      cleanup: staged.cleanup,
      handoffMarker: staged.handoffMarker,
    };
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
    await write("run.sh", wrapperScript(dir, tools, trustedEnv, cleanupTimeoutSeconds), 0o700);
    return {
      command: `/bin/sh ${shellQuote(NodePath.join(dir, "run.sh"))}`,
      cleanup,
      runDir: dir,
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
