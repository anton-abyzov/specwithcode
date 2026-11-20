// @effect-diagnostics nodeBuiltinImport:off - runs the generated script as a real process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { terminalElevationState as readElevationState } from "@specweave-studio/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { prepareElevatedRun } from "./elevatedRun.ts";
import { prepareTerminalAppRun } from "./openInTerminal.ts";

const NONCE = "abcdefghij0123456789";
const terminalElevationState = (output: string) => readElevationState(output, NONCE);

describe("Open in Terminal", () => {
  let root: string;
  let cwd: string;
  let fakeOpen: string;

  beforeEach(() => {
    root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "open-in-terminal-test-"));
    cwd = NodePath.join(root, "it's a project");
    NodeFS.mkdirSync(cwd);
    fakeOpen = NodePath.join(root, "open");
    NodeFS.writeFileSync(fakeOpen, `#!/bin/sh\nprintf '%s\\n' "$@" > "${root}/opened"\n`, {
      mode: 0o755,
    });
  });

  afterEach(() => {
    NodeFS.rmSync(root, { recursive: true, force: true });
  });

  const sh = (command: string) =>
    NodeChildProcess.spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });

  it("opens a private script that runs the block in the thread's folder and removes itself", async () => {
    const command = await prepareTerminalAppRun({
      command: `pwd -P > "${root}/ran-in"\necho 'second line' >> "${root}/ran-in"`,
      cwd,
      dir: root,
      name: "run-1",
      nonce: NONCE,
      shell: "/bin/sh",
      openPath: fakeOpen,
    });
    const opened = sh(command);
    expect(opened.status).toBe(0);
    expect(terminalElevationState(opened.stdout)).toBe("terminal-app");
    const file = NodePath.join(root, "run-1.command");
    expect(NodeFS.readFileSync(NodePath.join(root, "opened"), "utf8")).toBe(
      `-a\nTerminal\n${file}\n`,
    );
    expect(NodeFS.statSync(file).mode & 0o777).toBe(0o700);

    // Terminal runs the file the way this does.
    expect(NodeChildProcess.spawnSync(file, [], { encoding: "utf8" }).status).toBe(0);
    expect(NodeFS.readFileSync(NodePath.join(root, "ran-in"), "utf8")).toBe(
      `${NodeFS.realpathSync(cwd)}\nsecond line\n`,
    );
    expect(NodeFS.existsSync(file)).toBe(false);
  });

  it("survives a folder name with spaces, quotes and $( ), and a removed thread folder", async () => {
    const dir = NodePath.join(root, "it's $(touch pwned) dir");
    NodeFS.mkdirSync(dir);
    const command = await prepareTerminalAppRun({
      command: `pwd -P > "${root}/ran-in"`,
      cwd: NodePath.join(root, "removed worktree"),
      fallbackCwd: cwd,
      dir,
      name: "run-3",
      nonce: NONCE,
      // Not a shell that reads the script's lines as written: zsh is used instead.
      shell: "/opt/homebrew/bin/fish",
      openPath: fakeOpen,
    });
    expect(sh(command).status).toBe(0);
    const file = NodePath.join(dir, "run-3.command");
    expect(NodeFS.readFileSync(file, "utf8").startsWith("#!/bin/zsh -l\n")).toBe(true);
    // Open in Terminal is macOS-only where /bin/zsh exists; Linux CI may lack zsh.
    const ran = NodeFS.existsSync("/bin/zsh")
      ? NodeChildProcess.spawnSync(file, [], { encoding: "utf8", cwd: root })
      : NodeChildProcess.spawnSync("/bin/sh", [file], { encoding: "utf8", cwd: root });
    expect(ran.status).toBe(0);
    expect(NodeFS.readFileSync(NodePath.join(root, "ran-in"), "utf8")).toBe(
      `${NodeFS.realpathSync(cwd)}\n`,
    );
    expect(NodeFS.existsSync(file)).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(root, "pwned"))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(dir, "pwned"))).toBe(false);
  });

  it("removes only its own file when the block uses a variable named self", async () => {
    const keep = NodePath.join(root, "README.md");
    NodeFS.writeFileSync(keep, "keep");
    await prepareTerminalAppRun({
      command: `self="${keep}"\n_specwithcode_command_file="${keep}" 2>/dev/null\ntrue`,
      cwd,
      dir: root,
      name: "run-4",
      nonce: NONCE,
      shell: "/bin/sh",
      openPath: fakeOpen,
    });
    const file = NodePath.join(root, "run-4.command");
    NodeChildProcess.spawnSync(file, [], { encoding: "utf8" });
    expect(NodeFS.existsSync(keep)).toBe(true);
    expect(NodeFS.existsSync(file)).toBe(false);
  });

  it("falls back to zsh when the requested shell contains a newline", async () => {
    await prepareTerminalAppRun({
      command: "echo safe",
      cwd,
      dir: root,
      name: "run-5",
      nonce: NONCE,
      shell: "/tmp/evil\ntouch pwned\n/bin/sh",
      openPath: fakeOpen,
    });
    const file = NodePath.join(root, "run-5.command");
    expect(NodeFS.readFileSync(file, "utf8").startsWith("#!/bin/zsh -l\n")).toBe(true);
  });

  it("removes the .command file even when the block replaces the shell with exec", async () => {
    const shells = ["/bin/sh", ...(NodeFS.existsSync("/bin/zsh") ? ["/bin/zsh"] : [])];
    for (const [index, shell] of shells.entries()) {
      const markerFile = NodePath.join(root, `exec-ran-${index}`);
      await prepareTerminalAppRun({
        command: `exec /bin/sh -c 'printf replaced > "${markerFile}"'`,
        cwd,
        dir: root,
        name: `run-exec-${index}`,
        nonce: NONCE,
        shell,
        openPath: fakeOpen,
      });
      const file = NodePath.join(root, `run-exec-${index}.command`);
      expect(NodeFS.existsSync(file)).toBe(true);
      const ran = NodeChildProcess.spawnSync(file, [], { encoding: "utf8" });
      expect(ran.status).toBe(0);
      expect(NodeFS.readFileSync(markerFile, "utf8")).toBe("replaced");
      expect(NodeFS.existsSync(file)).toBe(false);
    }
  });

  it("removes the staged .command file and says nothing was handed over when Terminal cannot be opened", async () => {
    NodeFS.writeFileSync(fakeOpen, "#!/bin/sh\nexit 7\n", { mode: 0o755 });
    const command = await prepareTerminalAppRun({
      command: "ls",
      cwd,
      dir: root,
      name: "run-2",
      nonce: NONCE,
      openPath: fakeOpen,
    });
    const file = NodePath.join(root, "run-2.command");
    expect(NodeFS.existsSync(file)).toBe(true);
    const opened = sh(command);
    expect(opened.status).toBe(7);
    expect(terminalElevationState(opened.stdout)).toBeNull();
    expect(NodeFS.existsSync(file)).toBe(false);
  });

  it("is what a code-block run gets when it asks for Terminal on a Mac, and only there", async () => {
    const base = {
      command: "sudo ls",
      cwd,
      threadId: "thread-1",
      terminalId: "run-abc-3",
      elevation: { openIn: "terminal-app", nonce: NONCE },
      runsDir: NodePath.join(root, "runs"),
    } as const;
    expect(await prepareElevatedRun({ ...base, platform: "darwin" })).toContain("-a Terminal ");
    expect(await prepareElevatedRun({ ...base, platform: "linux" })).toMatch(/run\.sh'$/);
  });
});
