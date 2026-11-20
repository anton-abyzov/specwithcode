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
case "$1" in
  -n) [ -f "$state/ticket" ] || [ -f "$state/nopasswd" ]; exit $? ;;
  -k) rm -f "$state/ticket"; exit 0 ;;
  -A)
    tries=0
    while [ $tries -lt 3 ]; do
      answer="$("$SUDO_ASKPASS")" || exit 1
      if [ "$answer" = "$(cat "$state/password")" ]; then touch "$state/ticket"; exit 0; fi
      tries=$((tries + 1))
    done
    echo "sudo: 3 incorrect password attempts" >&2
    exit 1 ;;
esac
exit 64
`;

// Stands in for the macOS dialog: argv is \`- <label file> <answer file>\`.
const FAKE_OSASCRIPT = `#!/bin/sh
state="$FAKE_STATE"
cat > /dev/null
cp "$2" "$state/shown-label"
echo shown >> "$state/shown-count"
case "$(cat "$state/dialog")" in
  cancel) printf cancelled > "$3"; exit 1 ;;
  timeout) printf timeout > "$3"; exit 1 ;;
  wrong) echo not-the-password ;;
  broken) printf unavailable > "$3"; exit 1 ;;
  hang) sleep 30 ;;
  *) cat "$state/password" ;;
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
    writeExecutable("launchctl", `#!/bin/sh\ncat "$FAKE_STATE/session"\n`);
    writeExecutable("uname", `#!/bin/sh\ncat "$FAKE_STATE/system"\n`);
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
    setState("ticket", "");
    const result = await run("echo ran");
    expect(result.output).toContain("ran");
    expect(hasState("shown-count")).toBe(false);
    expect(hasState("ticket")).toBe(true);
  });

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

  it("ends the block, drops the ticket and removes the folder when the run is killed", async () => {
    const runsDir = NodePath.join(root, "runs");
    const wrapped = await prepare(`echo $$ > "${NodePath.join(state, "block-pid")}"; sleep 30`);
    const dir = NodePath.dirname(wrapped.slice("/bin/sh '".length, -1));
    const child = NodeChildProcess.spawn("/bin/sh", ["-c", `exec ${wrapped}`], {
      env: environment(),
      stdio: "ignore",
    });
    waitUntil('[ -s "$1" ]', NodePath.join(state, "block-pid"));
    expect(hasState("ticket")).toBe(true);
    // The value that signs the states is off the disk while the block runs.
    expect(NodeFS.existsSync(NodePath.join(dir, "nonce"))).toBe(false);
    expect(NodeFS.readFileSync(NodePath.join(dir, "run.sh"), "utf8")).not.toContain(NONCE);
    const blockPid = NodeFS.readFileSync(NodePath.join(state, "block-pid"), "utf8").trim();
    child.kill("SIGKILL");
    await new Promise((resolve) => child.on("exit", resolve));
    waitUntil('[ -z "$(ls "$1")" ] && ! kill -0 "$2" 2>/dev/null', runsDir, blockPid);
    expect(hasState("ticket")).toBe(false);
    expect(NodeFS.readdirSync(runsDir)).toEqual([]);
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
