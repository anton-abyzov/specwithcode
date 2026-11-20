// @effect-diagnostics nodeBuiltinImport:off - runs the generated script as a real process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { terminalElevationState } from "@specweave-studio/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { prepareElevatedRun } from "./elevatedRun.ts";
import { prepareTerminalAppRun } from "./openInTerminal.ts";

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

  it("says nothing was handed over when Terminal cannot be opened", async () => {
    NodeFS.writeFileSync(fakeOpen, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const command = await prepareTerminalAppRun({
      command: "ls",
      cwd,
      dir: root,
      name: "run-2",
      openPath: fakeOpen,
    });
    const opened = sh(command);
    expect(opened.status).toBe(1);
    expect(terminalElevationState(opened.stdout)).toBeNull();
  });

  it("is what a code-block run gets when it asks for Terminal on a Mac, and only there", async () => {
    const base = {
      command: "sudo ls",
      cwd,
      threadId: "thread-1",
      terminalId: "run-abc-3",
      elevation: { openIn: "terminal-app" },
      runsDir: NodePath.join(root, "runs"),
    } as const;
    expect(await prepareElevatedRun({ ...base, platform: "darwin" })).toContain("-a Terminal ");
    expect(await prepareElevatedRun({ ...base, platform: "linux" })).toMatch(/run\.sh'$/);
  });
});
