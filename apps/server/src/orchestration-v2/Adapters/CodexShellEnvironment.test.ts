// @effect-diagnostics nodeBuiltinImport:off - Drives a real Codex binary and SpecWeave CLI with plain Node.
/**
 * Codex builds every shell command's environment from the user's
 * `shell_environment_policy`. Under `inherit = "core"` the SPECWEAVE_* variables
 * the app sets on the app-server process never reach the model's shell, so a
 * `specweave` ledger write there could not bind the thread. These checks run a
 * real Codex binary through `codex sandbox`, which applies the same `-c`
 * overrides and policy as the app-server: no account, no network, no model
 * turn, a fresh CODEX_HOME and HOME. They skip when Codex (or, for the ledger
 * write, the SpecWeave CLI) is not installed or its sandbox cannot run here.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, describe, expect, it } from "vite-plus/test";

import { readThreadIncrementProgress } from "../../project/ThreadIncrementProgress.ts";
import { codexShellEnvironmentArgs } from "../../provider/RuntimeInstructions.ts";

const scratch: string[] = [];
afterAll(() => {
  for (const folder of scratch) NodeFS.rmSync(folder, { recursive: true, force: true });
});

function folder(prefix: string): string {
  const created = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix)));
  scratch.push(created);
  return created;
}

/** The user's own policy: core variables only, plus one entry of their own. */
function codexHome(): string {
  const home = folder("studio-codex-home-");
  NodeFS.writeFileSync(
    NodePath.join(home, "config.toml"),
    '[shell_environment_policy]\ninherit = "core"\n[shell_environment_policy.set]\nUSER_ENTRY = "kept"\n',
  );
  return home;
}

function runs(command: string, args: ReadonlyArray<string>): boolean {
  const probe = NodeChildProcess.spawnSync(command, args, { encoding: "utf8", timeout: 20_000 });
  return probe.status === 0;
}

const CODEX = [process.env.STUDIO_CODEX_BINARY, "codex"].find(
  (candidate): candidate is string =>
    candidate !== undefined && candidate !== "" && runs(candidate, ["--version"]),
);
const SANDBOX =
  CODEX !== undefined &&
  NodeChildProcess.spawnSync(CODEX, ["sandbox", "--", "/bin/sh", "-c", "exit 0"], {
    env: { PATH: process.env.PATH, HOME: NodeOS.tmpdir(), CODEX_HOME: codexHome() },
    timeout: 20_000,
  }).status === 0;
const SPECWEAVE = runs("specweave", ["--version"]) ? "specweave" : undefined;

/** Runs `script` in a Codex sandbox shell and returns its exit status and output. */
function codexShell(input: {
  readonly args: ReadonlyArray<string>;
  readonly script: string;
  readonly home?: string;
}): { readonly status: number | null; readonly stdout: string } {
  const result = NodeChildProcess.spawnSync(
    CODEX!,
    ["sandbox", ...input.args, "--", "/bin/sh", "-c", input.script],
    {
      encoding: "utf8",
      timeout: 60_000,
      env: {
        PATH: process.env.PATH,
        HOME: input.home ?? NodeOS.tmpdir(),
        CODEX_HOME: codexHome(),
        // What the app already exports on the app-server process.
        SPECWEAVE_STUDIO_THREAD_ID: "from-the-process",
        SPECWEAVE_TOOL: "claude",
        UNRELATED_EXPORTED: "filtered",
      },
    },
  );
  return { status: result.status, stdout: result.stdout };
}

function environmentOf(stdout: string): Map<string, string> {
  return new Map(
    stdout
      .split("\n")
      .map((line) => line.split(/=(.*)/su, 2) as [string, string | undefined])
      .filter((pair): pair is [string, string] => pair[1] !== undefined),
  );
}

const THREAD = "thread:delegated-task:command%3Amcp%3Aproof%3Adelegate-task%3Acodex-shell";

describe("codexShellEnvironmentArgs", () => {
  it("passes each variable as a TOML string under shell_environment_policy.set", () => {
    expect(codexShellEnvironmentArgs({ threadId: 'a"b\\c\nd', tool: "codex" })).toEqual([
      "-c",
      'shell_environment_policy.set.SPECWEAVE_STUDIO_THREAD_ID="a\\"b\\\\c\\u000ad"',
      "-c",
      'shell_environment_policy.set.SPECWEAVE_TOOL="codex"',
      "-c",
      'shell_environment_policy.set.SPECWEAVE_MODEL=""',
    ]);
  });
});

describe.skipIf(!SANDBOX)("a real Codex shell under inherit = core", () => {
  it("drops the process identity without the overrides", () => {
    const shell = codexShell({ args: [], script: "env" });
    expect(shell.status).toBe(0);
    const environment = environmentOf(shell.stdout);
    expect(environment.get("SPECWEAVE_STUDIO_THREAD_ID")).toBeUndefined();
    expect(environment.get("USER_ENTRY")).toBe("kept");
  });

  it("carries the thread's identity and keeps the user's policy", () => {
    const shell = codexShell({
      args: codexShellEnvironmentArgs({ threadId: THREAD, tool: "codex" }),
      script: "env",
    });
    expect(shell.status).toBe(0);
    const environment = environmentOf(shell.stdout);
    expect(environment.get("SPECWEAVE_STUDIO_THREAD_ID")).toBe(THREAD);
    expect(environment.get("SPECWEAVE_TOOL")).toBe("codex");
    expect(environment.get("SPECWEAVE_MODEL")).toBe("");
    // The user's own entry survives and inheritance stays core-only.
    expect(environment.get("USER_ENTRY")).toBe("kept");
    expect(environment.get("UNRELATED_EXPORTED")).toBeUndefined();
    expect(environment.get("PATH")).toBeDefined();
  });

  it.skipIf(SPECWEAVE === undefined)(
    "binds the thread when its shell writes a SpecWeave ledger",
    { timeout: 120_000 },
    async () => {
      const base = folder("studio-codex-ledger-");
      const home = NodePath.join(base, "home");
      const project = NodePath.join(base, "project");
      const increment = NodePath.join(project, ".specweave/increments/0001-proof");
      NodeFS.mkdirSync(home, { recursive: true });
      NodeFS.mkdirSync(increment, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(project, ".specweave/config.json"),
        '{"project":{"name":"proof"}}',
      );
      NodeFS.writeFileSync(
        NodePath.join(increment, "spec.md"),
        "# Proof\n\n## Acceptance Criteria\n- [ ] AC-01: works\n\n## Tasks\n\n### T-01 Do it\n- AC: AC-01 | Files: none | Test: true\n",
      );
      NodeFS.writeFileSync(
        NodePath.join(increment, "metadata.json"),
        '{"id":"0001-proof","status":"active","title":"Proof"}',
      );
      NodeFS.mkdirSync(NodePath.join(project, ".git"));
      NodeFS.writeFileSync(NodePath.join(project, ".git/HEAD"), "ref: refs/heads/main\n");

      const shell = codexShell({
        home,
        args: [
          "-c",
          'sandbox_mode="workspace-write"',
          "-c",
          `sandbox_workspace_write.writable_roots=[${JSON.stringify(base)}]`,
          ...codexShellEnvironmentArgs({ threadId: THREAD, tool: "codex" }),
        ],
        script: `cd ${JSON.stringify(project)} && ${SPECWEAVE} task claim T-01 0001`,
      });
      expect(shell.status).toBe(0);
      const [progress] = await readThreadIncrementProgress(project, [
        { threadId: THREAD, title: null, branch: null, worktreePath: null, home },
      ]);
      expect(progress).toMatchObject({
        incrementId: "0001-proof",
        binding: "claim",
        boundTaskId: "T-01",
      });
      expect(NodeFS.readFileSync(NodePath.join(increment, "ledger.jsonl"), "utf8")).toContain(
        '"by":"codex@',
      );
    },
  );
});
