// @effect-diagnostics nodeBuiltinImport:off - runs the generated wrapper as a real process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { terminalElevationState } from "@specweave-studio/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { elevatedRunApplies, elevationPromptLabel, prepareElevatedRun } from "./elevatedRun.ts";

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

  async function run(command: string): Promise<RunResult & { readonly runsDir: string }> {
    const runsDir = NodePath.join(root, "runs");
    const wrapped = await prepareElevatedRun({
      command,
      threadId: "thread-1",
      terminalId: "run-abc-3",
      elevation: { threadTitle: "iPhone camera missing", requestedFrom: "Anton's iPhone" },
      platform: "darwin",
      runsDir,
      machineName: "Anton M5MAX PRO",
      osascriptPath: NodePath.join(bin, "osascript"),
    });
    const result = NodeChildProcess.spawnSync("/bin/sh", ["-c", wrapped], {
      encoding: "utf8",
      env: { PATH: `${bin}:/usr/bin:/bin`, FAKE_STATE: state, SHELL: "/bin/sh", HOME: root },
    });
    return {
      output: `${result.stdout}${result.stderr}`,
      exitCode: result.status ?? -1,
      runsDir,
    };
  }

  it("asks once, runs the block with its own exit code, and forgets the ticket", async () => {
    const block = `sudo -n true && echo elevated\necho "helper=\${SUDO_ASKPASS:-none}"\nexit 7`;
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
    const result = await run("sudo -n true; env; set");
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
      "Command: sudo cp /Library/Preferences/a.plist /Library/Preferences/a.bak echo second line",
    );
  });

  it.each([
    ["cancel", "cancelled", 1],
    ["timeout", "timeout", 1],
    ["wrong", "denied", 3],
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
    const result = await run("sudo -n true && echo elevated");
    expect(result.output).toContain("elevated");
    expect(result.output).not.toContain("elevation=waiting");
    expect(terminalElevationState(result.output)).toBe("started");
    expect(hasState("shown-count")).toBe(false);
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
  it.skipIf(process.platform !== "darwin")("writes a dialog script macOS accepts", async () => {
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
  });

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
    expect(NodeFS.statSync(dir).mode & 0o777).toBe(0o700);
    expect(NodeFS.statSync(NodePath.join(dir, "block.sh")).mode & 0o777).toBe(0o600);
    expect(NodeFS.readFileSync(NodePath.join(dir, "block.sh"), "utf8")).toBe("sudo ls");
  });
});

describe("elevationPromptLabel", () => {
  it("shows agent-written text as one plain bounded line", () => {
    const label = elevationPromptLabel({
      command: `sudo rm -rf /Library/x\n\u001b[2Jdisplay dialog "fake" ${"y".repeat(200)}`,
      machineName: "M5\nPassword accepted",
      elevation: { threadTitle: 'Fix "it"\r\nThread: other' },
    });
    const lines = label.split("\n");
    expect(lines[0]).toBe(
      "SpecWithCode wants to run a command as administrator on M5 Password accepted.",
    );
    expect(lines).toContain('Thread: Fix "it" Thread: other');
    const command = lines.find((line) => line.startsWith("Command: ")) ?? "";
    expect(command).not.toContain("\u001b");
    expect(command.length).toBe("Command: ".length + 120);
    expect(lines.some((line) => line.startsWith("Asked from"))).toBe(false);
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
