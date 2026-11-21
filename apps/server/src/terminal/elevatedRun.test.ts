// @effect-diagnostics nodeBuiltinImport:off - runs the generated wrapper as a real process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { terminalElevationState as readElevationState } from "@specweave-studio/contracts";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  elevatedRunApplies,
  elevationPromptLabel,
  elevationStateCommand,
  prepareElevatedRun,
} from "./elevatedRun.ts";

const NONCE = "abcdefghij0123456789";
const terminalElevationState = (output: string) => readElevationState(output, NONCE);

const MARKER_PASSWORD = "marker-password-1438";

const FAKE_SUDO = `#!/bin/sh
state="$FAKE_STATE"
current_sid="$(/usr/bin/python3 -c 'import os; print(os.getsid(0))')"
has_tty() {
  /usr/bin/python3 -c 'import os; fd = os.open("/dev/tty", os.O_RDONLY); os.close(fd)' 2>/dev/null
}
ticket_valid() {
  [ -f "$state/ticket" ] || return 1
  scope="$(/bin/cat "$state/ticket")"
  case "$scope" in
    global) return 0 ;;
    ppid=*) [ "$scope" = "ppid=$PPID" ] ;;
    sid=*) [ "$scope" = "sid=$current_sid" ] ;;
    "") return 0 ;;
    *) return 1 ;;
  esac
}
write_ticket() {
  [ -f "$state/no-cache" ] && return 0
  echo written >> "$state/ticket-ever-written"
  if [ -f "$state/timestamp-global" ] || [ -f "$state/timestamp-global-hidden" ]; then
    printf 'global' > "$state/ticket"
  elif [ -f "$state/timestamp-ppid" ]; then
    printf 'ppid=%s' "$PPID" > "$state/ticket"
  else
    printf 'sid=%s' "$current_sid" > "$state/ticket"
  fi
}
print_sudo_list() {
  defaults="env_reset"
  if [ -f "$state/timestamp-global" ]; then
    defaults="$defaults, timestamp_type=global"
  elif [ -f "$state/timestamp-ppid" ]; then
    defaults="$defaults, timestamp_type=ppid"
  else
    defaults="$defaults, timestamp_type=tty"
  fi
  if [ -f "$state/no-cache" ]; then
    defaults="$defaults, timestamp_timeout=0"
  else
    defaults="$defaults, timestamp_timeout=5"
  fi
  [ -f "$state/requiretty" ] && defaults="$defaults, requiretty"
  [ -f "$state/rootpw" ] && defaults="$defaults, rootpw"
  [ -f "$state/targetpw" ] && defaults="$defaults, targetpw"
  [ -f "$state/runaspw" ] && defaults="$defaults, runaspw"
  if [ -f "$state/defaults-extra" ]; then
    defaults="$defaults, $(/bin/cat "$state/defaults-extra")"
  fi
  printf 'Matching Defaults entries for tester on test-host:\\n    %s\\n\\n' "$defaults"
  if [ -f "$state/bound-defaults" ]; then
    printf 'Runas and Command-specific defaults for tester:\\n'
    /bin/cat "$state/bound-defaults"
    printf '\\n'
  fi
  printf 'User tester may run the following commands on test-host:\\n'
  if [ -f "$state/nopasswd" ]; then
    printf '    (ALL) NOPASSWD: ALL\\n'
  else
    printf '    (ALL) ALL\\n'
  fi
}
ignore_ticket=0
no_update=0
non_interactive=0
askpass=0
stdin_pw=0
list_count=0
validate=0
target_user=""
target_group=""
while [ $# -gt 0 ]; do
  case "$1" in
    -k) ignore_ticket=1; shift ;;
    -N) no_update=1; shift ;;
    -n) non_interactive=1; shift ;;
    -A) askpass=1; shift ;;
    -S) stdin_pw=1; shift ;;
    -p) shift 2 ;;
    -l) list_count=$((list_count + 1)); shift ;;
    -v) validate=1; shift ;;
    -u) target_user="$2"; shift 2 ;;
    -g) target_group="$2"; shift 2 ;;
    --) shift; break ;;
    *) break ;;
  esac
done

if [ "$ignore_ticket" = 1 ] && [ "$non_interactive" = 0 ] && [ "$askpass" = 0 ] && [ "$stdin_pw" = 0 ] && [ "$list_count" = 0 ] && [ "$validate" = 0 ] && [ $# -eq 0 ]; then
  /bin/rm -f "$state/ticket"
  exit 0
fi

if [ "$ignore_ticket" = 1 ] && [ "$no_update" = 1 ]; then
  echo "sudo: Only one of the -K, -k or -N options may be specified" >&2
  exit 1
fi

if [ -f "$state/requiretty" ] && [ "$stdin_pw" = 0 ] && ! has_tty; then
  echo "sudo: sorry, you must have a tty to run sudo" >&2
  exit 1
fi

has_ticket() {
  [ "$ignore_ticket" = 0 ] && ticket_valid
}

cmd="$1"
is_disallowed() {
  [ -f "$state/restricted-sudoers" ] && [ "$validate" = 0 ] && [ "$list_count" = 0 ] && return 0
  [ -f "$state/disallow-cmd" ] && [ "$cmd" = "$(/bin/cat "$state/disallow-cmd")" ] && return 0
  [ -f "$state/disallow-user" ] && [ "$target_user" = "$(/bin/cat "$state/disallow-user")" ] && return 0
  [ "$validate" = 1 ] && [ -f "$state/disallow-v-user" ] && [ "$target_user" = "$(/bin/cat "$state/disallow-v-user")" ] && return 0
  return 1
}

is_nopasswd_cmd() {
  [ -f "$state/nopasswd" ] && return 0
  [ "$cmd" = "true" ] && [ -f "$state/nopasswd-true" ] && return 0
  [ "$cmd" = "/bin/sh" ] && [ -f "$state/nopasswd-sh" ] && return 0
  [ -f "$state/nopasswd-for" ] && [ "$cmd" = "$(/bin/cat "$state/nopasswd-for")" ] && return 0
  return 1
}

expected_pw() {
  if [ "$list_count" -eq 0 ] && { [ -f "$state/rootpw" ] || [ -f "$state/targetpw" ] || [ -f "$state/runaspw" ]; }; then
    if [ -f "$state/root-password" ]; then
      /bin/cat "$state/root-password"
    else
      printf '__root_only_pw__'
    fi
  else
    /bin/cat "$state/password"
  fi
}

if [ "$list_count" -gt 0 ]; then
  if [ "$stdin_pw" = 1 ]; then
    IFS= read -r answer || answer=""
    if [ "$answer" = "$(expected_pw)" ]; then
      if [ "$no_update" = 0 ]; then
        write_ticket
      fi
      if [ $# -eq 0 ]; then
        print_sudo_list
        exit 0
      fi
      exit 0
    fi
    echo "sudo: 1 incorrect password attempt" >&2
    exit 1
  fi
  if [ "$non_interactive" = 1 ]; then
    if [ $# -eq 0 ]; then
      if has_ticket || [ -f "$state/nopasswd" ] || [ -f "$state/nopasswd-cmd" ] || [ -f "$state/nopasswd-true" ] || [ -f "$state/listpw-never" ]; then
        print_sudo_list
        exit 0
      fi
      echo "sudo: a password is required" >&2
      exit 1
    fi
    if is_disallowed; then
      echo "sudo: user tester is not allowed to execute '$*' as \${target_user:-root} on test-host." >&2
      exit 1
    fi
    if is_nopasswd_cmd; then
      if [ "$list_count" -ge 2 ]; then
        printf 'Sudoers entry:\\n    RunAsUsers: %s\\n    Options: !authenticate\\n    Commands:\\n\\t%s\\n' "\${target_user:-root}" "$*"
      else
        printf '%s\\n' "$*"
      fi
      exit 0
    fi
    if has_ticket || [ -f "$state/listpw-never" ]; then
      if [ "$list_count" -ge 2 ]; then
        printf 'Sudoers entry:\\n    RunAsUsers: %s\\n    Options: authenticate\\n    Commands:\\n\\t%s\\n' "\${target_user:-root}" "$*"
      else
        printf '%s\\n' "$*"
      fi
      exit 0
    fi
    echo "sudo: a password is required" >&2
    exit 1
  fi
  exit 64
fi

if [ "$non_interactive" = 1 ]; then
  if [ -f "$state/isolation-policy-deny" ] && ! has_ticket; then
    echo "sudo: sorry, you must have a tty to run sudo" >&2
    exit 1
  fi
  if is_disallowed; then
    echo "sudo: user tester is not allowed to execute '$*' as \${target_user:-root} on test-host." >&2
    exit 1
  fi
  if [ "$validate" = 1 ]; then
    if has_ticket || [ -f "$state/nopasswd" ] || [ -f "$state/verifypw-never" ]; then
      exit 0
    fi
    echo "sudo: a password is required" >&2
    exit 1
  fi
  if has_ticket || is_nopasswd_cmd; then
    exit 0
  fi
  echo "sudo: a password is required" >&2
  exit 1
fi

if [ "$stdin_pw" = 1 ]; then
  if is_disallowed; then
    echo "sudo: Sorry, user tester is not allowed to execute '$*' as \${target_user:-root} on test-host." >&2
    exit 1
  fi
  [ "$validate" = 1 ] && [ -f "$state/verifypw-never" ] && exit 0
  IFS= read -r answer || answer=""
  if [ "$answer" = "$(expected_pw)" ]; then
    if [ "$no_update" = 0 ]; then
      write_ticket
      if [ -f "$state/prime-hang" ]; then
        echo primed > "$state/primed"
        /bin/sleep 30
      fi
    fi
    exit 0
  fi
  echo "sudo: 1 incorrect password attempt" >&2
  exit 1
fi

if [ "$askpass" = 1 ]; then
  [ "$validate" = 1 ] && [ -f "$state/verifypw-never" ] && exit 0
  if is_disallowed; then
    echo "sudo: Sorry, user tester is not allowed to execute '$*' as \${target_user:-root} on test-host." >&2
    exit 1
  fi
  tries=0
  while [ $tries -lt 3 ]; do
    answer="$("$SUDO_ASKPASS")" || exit 1
    if [ "$answer" = "$(expected_pw)" ]; then
      write_ticket
      exit 0
    fi
    tries=$((tries + 1))
  done
  echo "sudo: 3 incorrect password attempts" >&2
  exit 1
fi

exit 64
`;

const FAKE_SCRIPT = `#!/usr/bin/python3
import os, pty, select, sys
args = sys.argv[1:]
while args and args[0] == "-q":
    args.pop(0)
if args:
    args.pop(0)
if not args:
    sys.exit(2)
pid, fd = pty.fork()
if pid == 0:
    os.execvp(args[0], args)
out = bytearray()
reaped = False
status = 0
while True:
    r, _, _ = select.select([fd], [], [], 1.0)
    if r:
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            break
        if not chunk:
            break
        out.extend(chunk)
    else:
        w, st = os.waitpid(pid, os.WNOHANG)
        if w != 0:
            reaped = True
            status = st
            break
if not reaped:
    _, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(out)
sys.stdout.buffer.flush()
sys.exit(os.waitstatus_to_exitcode(status))
`;

// Stands in for the macOS dialog: argv is \`- <label file> <answer file>\`.
const FAKE_OSASCRIPT = `#!/bin/sh
state="$FAKE_STATE"
/bin/cat > /dev/null
cp "$2" "$state/shown-label"
echo shown >> "$state/shown-count"
case "$(/bin/cat "$state/dialog")" in
  cancel) printf cancelled > "$3"; exit 1 ;;
  timeout) printf timeout > "$3"; exit 1 ;;
  wrong) echo not-the-password ;;
  broken) printf unavailable > "$3"; exit 1 ;;
  hang) /bin/sleep 30 ;;
  *) /bin/cat "$state/password" ;;
esac
`;

interface RunResult {
  readonly output: string;
  readonly exitCode: number;
}

describe("administrator code-block runs", () => {
  let root: string;
  let state: string;
  let bin: string;

  const writeExecutable = (name: string, content: string) =>
    NodeFS.writeFileSync(NodePath.join(bin, name), content, { mode: 0o755 });
  const setState = (name: string, content: string) =>
    NodeFS.writeFileSync(NodePath.join(state, name), content);
  const hasState = (name: string) => NodeFS.existsSync(NodePath.join(state, name));

  beforeEach(() => {
    root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "elevated-run-test-"));
    state = NodePath.join(root, "state");
    bin = NodePath.join(root, "bin");
    NodeFS.mkdirSync(state);
    NodeFS.mkdirSync(bin);
    writeExecutable("sudo", FAKE_SUDO);
    writeExecutable("osascript", FAKE_OSASCRIPT);
    writeExecutable("script", FAKE_SCRIPT);
    writeExecutable("launchctl", `#!/bin/sh\n/bin/cat "$FAKE_STATE/session"\n`);
    writeExecutable("uname", `#!/bin/sh\n/bin/cat "$FAKE_STATE/system"\n`);
    setState("password", MARKER_PASSWORD);
    setState("dialog", "answer");
    setState("session", "Aqua");
    setState("system", "Darwin");
  });

  afterEach(() => {
    NodeFS.rmSync(root, { recursive: true, force: true });
  });

  const tools = () => ({
    sudo: NodePath.join(bin, "sudo"),
    uname: NodePath.join(bin, "uname"),
    launchctl: NodePath.join(bin, "launchctl"),
    osascript: NodePath.join(bin, "osascript"),
    script:
      HostProcessPlatform.defaultValue() === "darwin"
        ? "/usr/bin/script"
        : NodePath.join(bin, "script"),
  });
  const waitUntil = (test: string, ...paths: string[]) =>
    NodeChildProcess.spawnSync("/bin/sh", [
      "-c",
      `until ${test}; do sleep 0.05; done`,
      "sh",
      ...paths,
    ]);
  const prepare = (command: string, runsDir = NodePath.join(root, "runs")) =>
    prepareElevatedRun({
      command,
      threadId: "thread-1",
      terminalId: "run-abc-3",
      elevation: {
        threadTitle: "iPhone camera missing",
        requestedFrom: "Anton's iPhone",
        nonce: NONCE,
      },
      platform: "darwin",
      runsDir,
      machineName: "Anton M5MAX PRO",
      tools: tools(),
    });
  // PATH holds no stand-ins: the wrapper must reach its tools by the paths it was given.
  const environment = () => ({
    PATH: "/usr/bin:/bin",
    FAKE_STATE: state,
    SHELL: "/bin/sh",
    HOME: root,
  });

  async function run(command: string): Promise<RunResult & { readonly runsDir: string }> {
    const runsDir = NodePath.join(root, "runs");
    const wrapped = await prepare(command, runsDir);
    const result = NodeChildProcess.spawnSync("/bin/sh", ["-c", wrapped], {
      encoding: "utf8",
      env: environment(),
    });
    return {
      output: `${result.stdout}${result.stderr}`,
      exitCode: result.status ?? -1,
      runsDir,
    };
  }

  it("asks once, runs the block with its own exit code, and forgets the ticket", async () => {
    const block = `"${tools().sudo}" -n true && echo elevated\necho "helper=\${SUDO_ASKPASS:-none}"\nexit 7`;
    const result = await run(block);
    expect(result.output).toContain("elevated");
    expect(result.output).toContain("helper=none");
    expect(result.exitCode).toBe(7);
    expect(terminalElevationState(result.output)).toBe("started");
    expect(result.output.indexOf("elevation=waiting")).toBeLessThan(
      result.output.indexOf("elevation=started"),
    );
    expect(NodeFS.readFileSync(NodePath.join(state, "shown-count"), "utf8")).toBe("shown\n");
    expect(hasState("ticket")).toBe(false);
    expect(NodeFS.readdirSync(result.runsDir)).toEqual([]);
  });

  it("never lets the password into the run's output", async () => {
    const result = await run("env; set");
    expect(result.exitCode).toBe(0);
    expect(result.output).not.toContain(MARKER_PASSWORD);
  });

  it("tells the person at the Mac who asks and what will run", async () => {
    await run("sudo cp /Library/Preferences/a.plist /Library/Preferences/a.bak\necho second line");
    const label = NodeFS.readFileSync(NodePath.join(state, "shown-label"), "utf8");
    expect(label).toContain(
      "SpecWithCode wants to run a command as administrator on Anton M5MAX PRO.",
    );
    expect(label).toContain("Thread: iPhone camera missing");
    expect(label).toContain("Asked from: Anton's iPhone");
    expect(label).toContain(
      "Command:\nsudo cp /Library/Preferences/a.plist /Library/Preferences/a.bak\necho second line\n",
    );
  });

  it.each([
    ["cancel", "cancelled", 1],
    ["timeout", "timeout", 1],
    ["wrong", "denied", 3],
    ["broken", "unavailable", 1],
  ] as const)("runs nothing when the prompt ends with %s", async (dialog, expected, prompts) => {
    setState("dialog", dialog);
    const result = await run(`touch "${NodePath.join(state, "block-ran")}"`);
    expect(terminalElevationState(result.output)).toBe(expected);
    expect(result.exitCode).toBe(1);
    expect(hasState("block-ran")).toBe(false);
    expect(hasState("ticket")).toBe(false);
    expect(
      NodeFS.readFileSync(NodePath.join(state, "shown-count"), "utf8").trim().split("\n"),
    ).toHaveLength(prompts);
    expect(NodeFS.readdirSync(result.runsDir)).toEqual([]);
  });

  it("shows no prompt when sudo needs no password", async () => {
    setState("nopasswd", "");
    const result = await run("echo elevated");
    expect(result.output).toContain("elevated");
    expect(result.output).not.toContain("elevation=waiting");
    expect(terminalElevationState(result.output)).toBe("started");
    expect(hasState("shown-count")).toBe(false);
  });

  it("leaves alone a ticket it did not ask for", async () => {
    const sid = NodeChildProcess.spawnSync(
      "/usr/bin/python3",
      ["-c", "import os; print(os.getsid(0))"],
      { encoding: "utf8" },
    ).stdout.trim();
    setState("ticket", `sid=${sid}`);
    const result = await run("echo ran");
    expect(result.output).toContain("ran");
    expect(hasState("shown-count")).toBe(false);
    expect(hasState("ticket")).toBe(true);
  });

  it("refuses a pre-existing global sudo ticket and leaves it intact", async () => {
    setState("ticket", "global");
    const blockRan = NodePath.join(state, "block-ran");
    const result = await run(`touch "${blockRan}"`);
    expect(terminalElevationState(result.output)).toBe("unavailable");
    expect(result.exitCode).toBe(1);
    expect(hasState("block-ran")).toBe(false);
    expect(hasState("shown-count")).toBe(false);
    expect(NodeFS.readFileSync(NodePath.join(state, "ticket"), "utf8")).toBe("global");
  });

  it("fails closed without minting a ticket when sudo uses timestamp_type=global", async () => {
    setState("timestamp-global", "");
    const blockRan = NodePath.join(state, "block-ran");
    const result = await run(`touch "${blockRan}"`);
    expect(terminalElevationState(result.output)).toBe("unavailable");
    expect(result.exitCode).toBe(1);
    expect(hasState("block-ran")).toBe(false);
    expect(hasState("shown-count")).toBe(true);
    expect(hasState("ticket")).toBe(false);
    expect(hasState("ticket-ever-written")).toBe(false);
  });

  it("fails closed without minting a ticket when sudo uses timestamp_type=global and requiretty", async () => {
    setState("timestamp-global", "");
    setState("requiretty", "");
    const blockRan = NodePath.join(state, "block-ran");
    const result = await run(`touch "${blockRan}"`);
    expect(terminalElevationState(result.output)).toBe("unavailable");
    expect(result.exitCode).toBe(1);
    expect(hasState("block-ran")).toBe(false);
    expect(hasState("ticket")).toBe(false);
    expect(hasState("ticket-ever-written")).toBe(false);
  });

  it("fails closed without minting a ticket when sudo uses timestamp_type=ppid", async () => {
    setState("timestamp-ppid", "");
    const blockRan = NodePath.join(state, "block-ran");
    const result = await run(`touch "${blockRan}"`);
    expect(terminalElevationState(result.output)).toBe("unavailable");
    expect(result.exitCode).toBe(1);
    expect(hasState("block-ran")).toBe(false);
    expect(hasState("shown-count")).toBe(true);
    expect(hasState("ticket")).toBe(false);
    expect(hasState("ticket-ever-written")).toBe(false);
  });

  it("catches a hidden global ticket via the real-PTY isolation check and drops it", async () => {
    setState("timestamp-global-hidden", "");
    const blockRan = NodePath.join(state, "block-ran");
    const result = await run(`touch "${blockRan}"`);
    expect(terminalElevationState(result.output)).toBe("unavailable");
    expect(result.exitCode).toBe(1);
    expect(hasState("block-ran")).toBe(false);
    expect(hasState("ticket")).toBe(false);
  });

  it("succeeds under requiretty inside a PTY when sudo uses isolated tty tickets", async () => {
    setState("requiretty", "");
    const runsDir = NodePath.join(root, "runs-requiretty");
    const wrapped = await prepare("echo requiretty-ok", runsDir);
    const result = NodeChildProcess.spawnSync(
      tools().script,
      ["-q", "/dev/null", "/bin/sh", "-c", wrapped],
      {
        encoding: "utf8",
        env: environment(),
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15_000,
      },
    );
    const output = `${result.stdout}${result.stderr}`;
    expect(terminalElevationState(output)).toBe("started");
    expect(result.status).toBe(0);
    expect(output).toContain("requiretty-ok");
    expect(hasState("ticket")).toBe(false);
  });

  it("fails closed when the ticket-isolation probe fails for a non-password reason", async () => {
    setState("isolation-policy-deny", "");
    const blockRan = NodePath.join(state, "block-ran");
    const result = await run(`touch "${blockRan}"`);
    expect(terminalElevationState(result.output)).toBe("unavailable");
    expect(result.exitCode).toBe(1);
    expect(hasState("block-ran")).toBe(false);
    expect(hasState("ticket")).toBe(false);
  });

  it.each(["rootpw", "targetpw", "runaspw"] as const)(
    "fails closed without minting a ticket when sudoers enables %s",
    async (flag) => {
      setState(flag, "");
      const blockRan = NodePath.join(state, "block-ran");
      const result = await run(`touch "${blockRan}"`);
      expect(terminalElevationState(result.output)).toBe("unavailable");
      expect(result.exitCode).toBe(1);
      expect(hasState("block-ran")).toBe(false);
      expect(hasState("ticket")).toBe(false);
      expect(hasState("ticket-ever-written")).toBe(false);
    },
  );

  it.each([
    "    Defaults!/sbin/pfctl targetpw",
    "    Defaults!/sbin/pfctl rootpw",
    "    Defaults>root runaspw",
    "    Defaults!/sbin/pfctl !tty_tickets",
    "    Defaults!/sbin/pfctl timestamp_type=global",
    "    Defaults!/sbin/pfctl timestamp_timeout=0",
  ])(
    "fails closed without minting a ticket for command/runas default %s",
    async (boundDefaultLine) => {
      setState("bound-defaults", `${boundDefaultLine}\n`);
      const blockRan = NodePath.join(state, "block-ran");
      const result = await run(`touch "${blockRan}"`);
      expect(terminalElevationState(result.output)).toBe("unavailable");
      expect(result.exitCode).toBe(1);
      expect(hasState("block-ran")).toBe(false);
      expect(hasState("ticket")).toBe(false);
      expect(hasState("ticket-ever-written")).toBe(false);
    },
  );

  it("fails closed instead of taking the no-password path when a command-specific Defaults! sets authenticate", async () => {
    setState("nopasswd", "");
    setState("bound-defaults", "    Defaults!/sbin/pfctl authenticate\n");
    const blockRan = NodePath.join(state, "block-ran");
    const result = await run(`touch "${blockRan}" && "${tools().sudo}" /sbin/pfctl -s all`);
    expect(terminalElevationState(result.output)).toBe("unavailable");
    expect(result.exitCode).toBe(1);
    expect(hasState("block-ran")).toBe(false);
    expect(hasState("shown-count")).toBe(false);
  });

  it("fails closed when target-user -v policy check fails", async () => {
    setState("disallow-v-user", "nobody");
    const blockRan = NodePath.join(state, "block-ran");
    const result = await run(`touch "${blockRan}" && "${tools().sudo}" -u nobody id`);
    expect(terminalElevationState(result.output)).toBe("unavailable");
    expect(result.exitCode).toBe(1);
    expect(hasState("block-ran")).toBe(false);
    expect(hasState("ticket")).toBe(false);
  });

  it("prompts via -v when NOPASSWD:/bin/sh applies but the block runs a PASSWD command", async () => {
    setState("nopasswd-sh", "");
    setState("listpw-never", "");
    setState("dialog", "cancel");
    const blockRan = NodePath.join(state, "block-ran");

    const cancelled = await run(`touch "${blockRan}" && "${tools().sudo}" -n /sbin/pfctl -s all`);
    expect(terminalElevationState(cancelled.output)).toBe("cancelled");
    expect(cancelled.exitCode).toBe(1);
    expect(hasState("block-ran")).toBe(false);
    expect(hasState("shown-count")).toBe(true);

    setState("dialog", "answer");
    const approved = await run(`touch "${blockRan}" && "${tools().sudo}" -n /sbin/pfctl -s all`);
    expect(terminalElevationState(approved.output)).toBe("started");
    expect(approved.exitCode).toBe(0);
    expect(hasState("block-ran")).toBe(true);
    expect(hasState("ticket")).toBe(false);
  });

  it("fails closed when both NOPASSWD:/bin/sh and verifypw=never apply to a PASSWD block command", async () => {
    setState("nopasswd-sh", "");
    setState("verifypw-never", "");
    setState("listpw-never", "");
    const blockRan = NodePath.join(state, "block-ran");

    const result = await run(`touch "${blockRan}" && "${tools().sudo}" -n /sbin/pfctl -s all`);
    expect(terminalElevationState(result.output)).toBe("unavailable");
    expect(result.exitCode).toBe(1);
    expect(hasState("block-ran")).toBe(false);
    expect(hasState("shown-count")).toBe(false);
  });

  it("does not let command arguments containing NOPASSWD spoof a NOPASSWD rule", async () => {
    setState("listpw-never", "");
    setState("dialog", "cancel");
    const blockRan = NodePath.join(state, "block-ran");

    const result = await run(
      `touch "${blockRan}" && "${tools().sudo}" /bin/echo "Options: !authenticate NOPASSWD:"`,
    );
    expect(terminalElevationState(result.output)).toBe("cancelled");
    expect(result.exitCode).toBe(1);
    expect(hasState("block-ran")).toBe(false);
    expect(hasState("shown-count")).toBe(true);
  });

  it("fails closed when sudoers disallows a specific command or target user in the block", async () => {
    setState("disallow-cmd", "/sbin/pfctl");
    const blockRan = NodePath.join(state, "block-ran");
    const disallowedCmd = await run(`touch "${blockRan}" && "${tools().sudo}" /sbin/pfctl -e`);
    expect(terminalElevationState(disallowedCmd.output)).toBe("unavailable");
    expect(disallowedCmd.exitCode).toBe(1);
    expect(hasState("block-ran")).toBe(false);
    expect(hasState("ticket")).toBe(false);

    NodeFS.rmSync(NodePath.join(state, "disallow-cmd"), { force: true });
    setState("disallow-user", "nobody");
    const disallowedUser = await run(`touch "${blockRan}" && "${tools().sudo}" -u nobody id`);
    expect(terminalElevationState(disallowedUser.output)).toBe("unavailable");
    expect(disallowedUser.exitCode).toBe(1);
    expect(hasState("block-ran")).toBe(false);
    expect(hasState("ticket")).toBe(false);
  });

  it.each(["sudo -k /sbin/pfctl -e", "sudoedit /etc/hosts", "su root -c id", "sudo $CMD"])(
    "fails closed before staging when the block uses unsupported elevation form %s",
    async (command) => {
      const runsDir = NodePath.join(root, "runs");
      const wrapped = await prepare(command, runsDir);
      expect(NodeFS.existsSync(runsDir)).toBe(false);
      const ran = NodeChildProcess.spawnSync("/bin/sh", ["-c", wrapped], {
        encoding: "utf8",
        env: environment(),
      });
      expect(ran.status).toBe(1);
      expect(terminalElevationState(ran.stdout)).toBe("unavailable");
    },
  );

  it("never asks a sudo found on PATH", async () => {
    const shim = NodePath.join(root, "shim");
    NodeFS.mkdirSync(shim);
    NodeFS.writeFileSync(
      NodePath.join(shim, "sudo"),
      `#!/bin/sh\n[ "$1" = "-A" ] && "$SUDO_ASKPASS" > "${state}/stolen"\nexit 0\n`,
      { mode: 0o755 },
    );
    const wrapped = await prepare("echo ran");
    const result = NodeChildProcess.spawnSync("/bin/sh", ["-c", wrapped], {
      encoding: "utf8",
      env: { ...environment(), PATH: `${shim}:/usr/bin:/bin` },
    });
    expect(result.stdout).toContain("ran");
    expect(hasState("stolen")).toBe(false);
  });

  it("ends the prompt and says cancelled when the run is stopped while it waits", async () => {
    setState("dialog", "hang");
    const wrapped = await prepare(`touch "${NodePath.join(state, "block-ran")}"`);
    const child = NodeChildProcess.spawn("/bin/sh", ["-c", `exec ${wrapped}`], {
      env: environment(),
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    // Waits for the dialog to be up; the test's own time limit covers a prompt that never ends.
    NodeChildProcess.spawnSync("/bin/sh", [
      "-c",
      'until [ -e "$1" ]; do sleep 0.02; done',
      "sh",
      NodePath.join(state, "shown-count"),
    ]);
    child.kill("SIGTERM");
    const exitCode = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    expect(exitCode).toBe(1);
    expect(terminalElevationState(output)).toBe("cancelled");
    expect(hasState("block-ran")).toBe(false);
    expect(NodeFS.readdirSync(NodePath.join(root, "runs"))).toEqual([]);
  });

  it("cleans up the password helper and run folder when killed with SIGKILL while prompting", async () => {
    setState("dialog", "hang");
    const runsDir = NodePath.join(root, "runs");
    const wrapped = await prepare(`touch "${NodePath.join(state, "block-ran")}"`, runsDir);
    const dir = NodePath.dirname(wrapped.slice("/bin/sh '".length, -1));
    const child = NodeChildProcess.spawn("/bin/sh", ["-c", `exec ${wrapped}`], {
      env: environment(),
      stdio: "ignore",
    });
    waitUntil(
      '[ -e "$1" ] && [ -s "$2" ]',
      NodePath.join(state, "shown-count"),
      NodePath.join(dir, "askpass.pid"),
    );
    const askpassPid = NodeFS.readFileSync(NodePath.join(dir, "askpass.pid"), "utf8")
      .trim()
      .split(/\s+/)[0]!;
    child.kill("SIGKILL");
    await new Promise((resolve) => child.on("exit", resolve));
    waitUntil('[ -z "$(ls "$1")" ] && ! kill -0 "$2" 2>/dev/null', runsDir, askpassPid);
    expect(hasState("block-ran")).toBe(false);
    expect(hasState("ticket")).toBe(false);
    expect(hasState("ticket-ever-written")).toBe(false);
    expect(NodeFS.readdirSync(runsDir)).toEqual([]);
  });

  it("drops a newly primed ticket and removes the run folder when killed with SIGKILL while priming", async () => {
    setState("prime-hang", "");
    const runsDir = NodePath.join(root, "runs-prime-kill");
    const wrapped = await prepare(`touch "${NodePath.join(state, "block-ran")}"`, runsDir);
    const child = NodeChildProcess.spawn("/bin/sh", ["-c", `exec ${wrapped}`], {
      env: environment(),
      stdio: "ignore",
    });
    waitUntil(
      '[ -e "$1" ] && [ -e "$2" ]',
      NodePath.join(state, "primed"),
      NodePath.join(state, "ticket"),
    );
    child.kill("SIGKILL");
    await new Promise((resolve) => child.on("exit", resolve));
    waitUntil('[ -z "$(ls "$1")" ] && [ ! -e "$2" ]', runsDir, NodePath.join(state, "ticket"));
    expect(hasState("block-ran")).toBe(false);
    expect(hasState("ticket")).toBe(false);
    expect(NodeFS.readdirSync(runsDir)).toEqual([]);
  });

  it.each(["SIGTERM", "SIGKILL"] as const)(
    "kills nested background grandchildren and SIGTERM-ignoring children on %s",
    async (signal) => {
      const runsDir = NodePath.join(root, "runs");
      const grandchildFile = NodePath.join(state, `grandchild-${signal}`);
      const stubbornFile = NodePath.join(state, `stubborn-${signal}`);
      const wrapped = await prepare(
        [
          `/bin/sh -c 'echo $$ > "${grandchildFile}"; exec /bin/sleep 30' &`,
          `/bin/sh -c 'trap "" TERM; echo $$ > "${stubbornFile}"; exec /bin/sleep 30' &`,
          "wait",
        ].join("\n"),
        runsDir,
      );
      const child = NodeChildProcess.spawn("/bin/sh", ["-c", `exec ${wrapped}`], {
        env: environment(),
        stdio: "ignore",
      });
      waitUntil('[ -s "$1" ] && [ -s "$2" ]', grandchildFile, stubbornFile);
      const grandchildPid = NodeFS.readFileSync(grandchildFile, "utf8").trim();
      const stubbornPid = NodeFS.readFileSync(stubbornFile, "utf8").trim();
      child.kill(signal);
      await new Promise((resolve) => child.on("exit", resolve));
      waitUntil(
        '[ -z "$(ls "$1")" ] && ! kill -0 "$2" 2>/dev/null && ! kill -0 "$3" 2>/dev/null',
        runsDir,
        grandchildPid,
        stubbornPid,
      );
      expect(hasState("ticket")).toBe(false);
      expect(NodeFS.readdirSync(runsDir)).toEqual([]);
    },
  );

  it("stops lingering background children in the block process group when the block exits normally", async () => {
    const runsDir = NodePath.join(root, "runs-bg-exit");
    const readyFile = NodePath.join(state, "bg-exit-pid");
    const wrapped = await prepare(
      [
        `/bin/sh -c 'echo $$ > "${readyFile}"; exec /bin/sleep 20' &`,
        `while [ ! -s "${readyFile}" ]; do :; done`,
        "exit 0",
      ].join("\n"),
      runsDir,
    );
    const ran = NodeChildProcess.spawnSync("/bin/sh", ["-c", wrapped], {
      encoding: "utf8",
      env: environment(),
      timeout: 15_000,
    });
    expect(ran.status).toBe(0);
    const backgroundPid = NodeFS.readFileSync(readyFile, "utf8").trim();
    waitUntil('! kill -0 "$1" 2>/dev/null', backgroundPid);
    expect(hasState("ticket")).toBe(false);
    expect(NodeFS.readdirSync(runsDir)).toEqual([]);
  });

  it.each(["SIGTERM", "SIGKILL"] as const)(
    "ends the block, drops the ticket and removes the folder on %s",
    async (signal) => {
      const runsDir = NodePath.join(root, "runs");
      const wrapped = await prepare(`echo $$ > "${NodePath.join(state, "block-pid")}"; sleep 30`);
      const dir = NodePath.dirname(wrapped.slice("/bin/sh '".length, -1));
      expect(NodeFS.readFileSync(NodePath.join(dir, "run.sh"), "utf8")).not.toContain(NONCE);
      const child = NodeChildProcess.spawn("/bin/sh", ["-c", `exec ${wrapped}`], {
        env: environment(),
        stdio: "ignore",
      });
      waitUntil('[ -s "$1" ]', NodePath.join(state, "block-pid"));
      expect(hasState("ticket")).toBe(true);
      // The nonce, block source and askpass helper leave disk before the block starts.
      for (const file of ["nonce", "block.sh", "label.txt", "askpass.sh"]) {
        expect(NodeFS.existsSync(NodePath.join(dir, file))).toBe(false);
      }
      const blockPid = NodeFS.readFileSync(NodePath.join(state, "block-pid"), "utf8").trim();
      child.kill(signal);
      await new Promise((resolve) => child.on("exit", resolve));
      waitUntil('[ -z "$(ls "$1")" ] && ! kill -0 "$2" 2>/dev/null', runsDir, blockPid);
      expect(hasState("ticket")).toBe(false);
      expect(NodeFS.readdirSync(runsDir)).toEqual([]);
    },
  );

  it.skipIf(HostProcessPlatform.defaultValue() === "win32")(
    "stops the block on Ctrl-C in a real pty without running later lines",
    async () => {
      const shells = ["/bin/zsh", "/bin/bash", "/bin/sh"].filter((shell) =>
        NodeFS.existsSync(shell),
      );
      expect(shells.length).toBeGreaterThan(0);

      for (const shell of shells) {
        const tag = NodePath.basename(shell);
        const runsDir = NodePath.join(root, `runs-pty-${tag}`);
        const readyFile = NodePath.join(state, `pty-ready-${tag}`);
        const markerA = NodePath.join(state, `pty-after-a-${tag}`);
        const markerB = NodePath.join(state, `pty-after-b-${tag}`);
        const wrapped = await prepare(
          [`: > "${readyFile}"`, "sleep 30 | cat", `: > "${markerA}"`, `touch "${markerB}"`].join(
            "\n",
          ),
          runsDir,
        );
        const python = [
          "import os, pty, select, sys, time",
          "cmd, ready = sys.argv[1], sys.argv[2]",
          "pid, fd = pty.fork()",
          "if pid == 0:",
          '  os.execv("/bin/sh", ["/bin/sh", "-c", cmd])',
          "deadline = time.monotonic() + 10",
          "sent = False",
          "while time.monotonic() < deadline:",
          "  r, _, _ = select.select([fd], [], [], 0.05)",
          "  if r:",
          "    try:",
          "      if not os.read(fd, 4096):",
          "        break",
          "    except OSError:",
          "      break",
          "  if not sent and os.path.exists(ready):",
          "    time.sleep(0.2)",
          '    os.write(fd, b"\\x03")',
          "    sent = True",
          "  done, _status = os.waitpid(pid, os.WNOHANG)",
          "  if done == pid:",
          "    sys.exit(0 if sent else 3)",
          "while time.monotonic() < deadline:",
          "  done, _status = os.waitpid(pid, os.WNOHANG)",
          "  if done == pid:",
          "    sys.exit(0 if sent else 3)",
          "  time.sleep(0.05)",
          "sys.exit(2)",
        ].join("\n");
        const result = NodeChildProcess.spawnSync("python3", ["-c", python, wrapped, readyFile], {
          encoding: "utf8",
          env: { ...environment(), SHELL: shell },
          timeout: 15_000,
        });
        expect(result.status, `${shell}: ${result.stderr}`).toBe(0);
        expect(NodeFS.existsSync(markerA), `${shell} ran next shell line after Ctrl-C`).toBe(false);
        expect(NodeFS.existsSync(markerB), `${shell} ran second line after Ctrl-C`).toBe(false);
        expect(hasState("ticket")).toBe(false);
        expect(NodeFS.readdirSync(runsDir)).toEqual([]);
      }
    },
  );

  it("ignores poisoned cat and rm on PATH", async () => {
    const poison = NodePath.join(root, "poison");
    NodeFS.mkdirSync(poison);
    for (const tool of ["cat", "rm", "sleep"]) {
      NodeFS.writeFileSync(
        NodePath.join(poison, tool),
        `#!/bin/sh\necho ${tool} >> "${NodePath.join(state, "poisoned")}"\nexit 1\n`,
        { mode: 0o755 },
      );
    }
    const wrapped = await prepare("echo safe");
    const ran = NodeChildProcess.spawnSync("/bin/sh", ["-c", wrapped], {
      encoding: "utf8",
      env: { ...environment(), PATH: `${poison}:${process.env.PATH ?? "/usr/bin:/bin"}` },
    });
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain("safe");
    expect(hasState("poisoned")).toBe(false);
  });

  it("gives each run its own folder, so an ending run cannot remove the next one's", async () => {
    const first = await prepare("echo one");
    const second = await prepare("echo two");
    expect(first).not.toBe(second);
    const ran = NodeChildProcess.spawnSync("/bin/sh", ["-c", first], {
      encoding: "utf8",
      env: { ...environment(), FAKE_STATE: state },
    });
    setState("nopasswd", "");
    expect(ran.status).toBe(0);
    const next = NodeChildProcess.spawnSync("/bin/sh", ["-c", second], {
      encoding: "utf8",
      env: environment(),
    });
    expect(next.stdout).toContain("two");
  });

  it("refuses a run folder that is a link or someone else's", async () => {
    const elsewhere = NodePath.join(root, "elsewhere");
    NodeFS.mkdirSync(elsewhere);
    const link = NodePath.join(root, "linked-runs");
    NodeFS.symlinkSync(elsewhere, link);
    await expect(prepare("sudo ls", link)).rejects.toThrow("not this user's own folder");
    expect(NodeFS.readdirSync(elsewhere)).toEqual([]);
  });

  it("can report a state when the wrapper cannot be written", () => {
    const result = NodeChildProcess.spawnSync(
      "/bin/sh",
      ["-c", elevationStateCommand("unavailable", { nonce: NONCE })],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(terminalElevationState(result.stdout)).toBe("unavailable");
    // A nonce that is not plain characters never reaches the shell.
    expect(elevationStateCommand("unavailable", { nonce: "x'; touch /tmp/pwned; '" })).toBe(
      "printf '\\033]7717;elevation=%s;\\007' unavailable; exit 1",
    );
  });

  it.each([
    ["a Mac service with no desktop session", "session", "Background"],
    ["Linux", "system", "Linux"],
  ])("does not start the block on %s", async (_name, key, value) => {
    setState(key, value);
    const result = await run(`touch "${NodePath.join(state, "block-ran")}"`);
    expect(terminalElevationState(result.output)).toBe("unavailable");
    expect(result.exitCode).toBe(1);
    expect(hasState("block-ran")).toBe(false);
    expect(hasState("shown-count")).toBe(false);
  });

  it.each([
    ["sudo -n -l passes for one command", ["nopasswd-cmd"]],
    ["sudo -n true is NOPASSWD while other commands need a password", ["nopasswd-true"]],
    [
      "Defaults verifypw=never lets sudo -n -v pass while commands need a password",
      ["verifypw-never"],
    ],
    [
      "Defaults verifypw=never and NOPASSWD true both pass while other commands need a password",
      ["verifypw-never", "nopasswd-true"],
    ],
    ["a host has nopasswd sudo but no native desktop prompt", ["nopasswd"]],
  ])("fails closed on Linux before running any part of the block when %s", async (_label, keys) => {
    setState("system", "Linux");
    for (const key of keys) setState(key, "");
    const blockRan = NodePath.join(state, "block-ran");
    const result = await run(`touch "${blockRan}" && "${tools().sudo}" -n id`);
    expect(terminalElevationState(result.output)).toBe("unavailable");
    expect(result.exitCode).toBe(1);
    expect(hasState("block-ran")).toBe(false);
    expect(hasState("shown-count")).toBe(false);
  });

  it("prompts on macOS Aqua when verifypw=never and NOPASSWD true both pass", async () => {
    setState("verifypw-never", "");
    setState("nopasswd-true", "");
    setState("dialog", "cancel");
    const blockRan = NodePath.join(state, "block-ran");

    const cancelled = await run(`touch "${blockRan}" && "${tools().sudo}" -n /bin/sh -c :`);
    expect(terminalElevationState(cancelled.output)).toBe("cancelled");
    expect(cancelled.exitCode).toBe(1);
    expect(hasState("block-ran")).toBe(false);
    expect(hasState("shown-count")).toBe(true);

    setState("dialog", "answer");
    const approved = await run(`touch "${blockRan}" && "${tools().sudo}" -n /bin/sh -c :`);
    expect(terminalElevationState(approved.output)).toBe("started");
    expect(approved.exitCode).toBe(0);
    expect(hasState("block-ran")).toBe(true);
    expect(hasState("ticket")).toBe(false);
  });

  it("fails closed on macOS Aqua when sudo does not cache a reusable ticket", async () => {
    setState("no-cache", "");
    const blockRan = NodePath.join(state, "block-ran");

    const result = await run(`touch "${blockRan}"`);
    expect(terminalElevationState(result.output)).toBe("unavailable");
    expect(result.exitCode).toBe(1);
    expect(hasState("block-ran")).toBe(false);
    expect(hasState("shown-count")).toBe(true);
  });

  it("fails closed on macOS Aqua when sudoers disallows root shell elevation", async () => {
    setState("restricted-sudoers", "");
    const blockRan = NodePath.join(state, "block-ran");

    const result = await run(`touch "${blockRan}"`);
    expect(terminalElevationState(result.output)).toBe("unavailable");
    expect(result.exitCode).toBe(1);
    expect(hasState("block-ran")).toBe(false);
  });

  // The stand-in dialog never parses the script; the real compiler does.
  it.skipIf(HostProcessPlatform.defaultValue() !== "darwin")(
    "writes a dialog script macOS accepts",
    async () => {
      const wrapped = await prepareElevatedRun({
        command: "sudo ls",
        threadId: "thread-1",
        terminalId: "run-abc-3",
        elevation: {},
        platform: "darwin",
        runsDir: NodePath.join(root, "runs"),
      });
      const dir = NodePath.dirname(wrapped.slice("/bin/sh '".length, -1));
      const helper = NodeFS.readFileSync(NodePath.join(dir, "askpass.sh"), "utf8");
      const source = helper.slice(helper.indexOf("<<'OSA'\n") + 8, helper.lastIndexOf("\nOSA"));
      const file = NodePath.join(root, "dialog.applescript");
      NodeFS.writeFileSync(file, source);
      const compiled = NodeChildProcess.spawnSync(
        "/usr/bin/osacompile",
        ["-o", NodePath.join(root, "dialog.scpt"), file],
        { encoding: "utf8" },
      );
      expect(compiled.stderr).toBe("");
      expect(compiled.status).toBe(0);
    },
  );

  it("keeps the run folder private", async () => {
    const runsDir = NodePath.join(root, "runs");
    const wrapped = await prepareElevatedRun({
      command: "sudo ls",
      threadId: "thread-1",
      terminalId: "run-abc-3",
      elevation: {},
      platform: "darwin",
      runsDir,
    });
    const dir = NodePath.dirname(wrapped.slice("/bin/sh '".length, -1));
    expect(NodeFS.statSync(runsDir).mode & 0o777).toBe(0o700);
    expect(NodePath.basename(dir)).toMatch(/^run-/);
    expect(NodeFS.statSync(dir).mode & 0o777).toBe(0o700);
    expect(NodeFS.statSync(NodePath.join(dir, "block.sh")).mode & 0o777).toBe(0o600);
    expect(NodeFS.readFileSync(NodePath.join(dir, "block.sh"), "utf8")).toBe("sudo ls");
  });
});

describe("elevationPromptLabel", () => {
  it("shows agent-written text as plain bounded lines", () => {
    const label = elevationPromptLabel({
      command: `sudo rm -rf /Library/x \u001b[2Jdisplay dialog "fake" ${"y".repeat(300)}`,
      machineName: "M5\nPassword accepted",
      elevation: { threadTitle: 'Fix "it"\r\nThread: other' },
    });
    const lines = label.split("\n");
    expect(lines[0]).toBe(
      "SpecWithCode wants to run a command as administrator on M5 Password accepted.",
    );
    expect(lines).toContain('Thread: Fix "it" Thread: other');
    const command = lines[lines.indexOf("Command:") + 1] ?? "";
    expect(command.startsWith("sudo rm -rf /Library/x")).toBe(true);
    expect(command).not.toContain("\u001b");
    expect(command.length).toBe(160);
    expect(lines.some((line) => line.startsWith("Asked from"))).toBe(false);
  });

  it("shows the administrator lines of a long block, not only its harmless start", () => {
    const harmless = Array.from({ length: 30 }, (_, index) => `echo step ${index}`);
    const label = elevationPromptLabel({
      command: [...harmless, "sudo rm -rf /Library/Important", "echo done"].join("\n"),
      machineName: "M5",
      elevation: {},
    });
    expect(label).toContain("echo step 0\necho step 1\necho step 2\n");
    expect(label).toContain("…\nsudo rm -rf /Library/Important\n");
    expect(label).toContain("more lines. Read the whole command in SpecWithCode first.");
  });
});

describe("the dialog's command lines", () => {
  const label = (command: string) =>
    elevationPromptLabel({ command, machineName: "M5", elevation: {} });
  const filler = Array.from({ length: 12 }, (_, index) => `echo step ${index}`);

  it("keeps the administrator part of a line padded past the limit", () => {
    const text = label(`echo ${"a".repeat(300)} && sudo rm -rf /Library/Important`);
    expect(text).toContain(" … sudo rm -rf /Library/Important");
  });

  it.each([
    "/usr/bin/sudo rm -rf /Library/Important",
    "sudoedit /etc/hosts",
    '"sudo" rm -rf /Library/Important',
    "osascript -e 'do shell script \"rm x\" with administrator privileges'",
  ])("shows %j from far down a long block", (line) => {
    expect(label([...filler, line].join("\n"))).toContain(`…\n${line}\n`);
  });

  it("does not let comments that mention sudo take the administrator lines' places", () => {
    const comments = Array.from({ length: 6 }, (_, index) => `# sudo note ${index}`);
    const text = label([...filler, ...comments, "sudo rm -rf /Library/Important"].join("\n"));
    expect(text).toContain("sudo rm -rf /Library/Important\n");
  });

  it("says so when administrator lines do not fit", () => {
    const many = Array.from({ length: 9 }, (_, index) => `sudo rm /Library/x${index}`);
    expect(label([...filler, ...many].join("\n"))).toContain(
      "4 of them as administrator. Read the whole command in SpecWithCode first.",
    );
  });
});

describe("elevatedRunApplies", () => {
  const base = {
    platform: "darwin",
    terminalId: "run-abc-3",
    command: "sudo ls",
    elevation: {},
  } as const;

  it("is for code-block runs that asked, on systems with sudo", () => {
    expect(elevatedRunApplies(base)).toBe(true);
    expect(elevatedRunApplies({ ...base, platform: "linux" })).toBe(true);
    expect(elevatedRunApplies({ ...base, platform: "win32" })).toBe(false);
    expect(elevatedRunApplies({ ...base, elevation: undefined })).toBe(false);
    expect(elevatedRunApplies({ ...base, terminalId: "term-1" })).toBe(false);
    expect(elevatedRunApplies({ ...base, command: undefined })).toBe(false);
  });
});
