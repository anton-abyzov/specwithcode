// @effect-diagnostics nodeBuiltinImport:off - temp folders holding stand-in tools.
// @effect-diagnostics globalTimers:off globalDate:off - a stand-in tool that takes a moment, timed by the wall clock.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  PROBE_BATCHES_PER_MINUTE,
  ProbeBusy,
  ProbeGate,
  type ProbeMachine,
  type ProbeRun,
  type ProbeSpawn,
  probeCredential,
  probeEnvironment,
  probeFolders,
  resolveProbeBinary as resolveProbeBinaryOn,
  spawnProbe,
} from "./probe.ts";

/** Linux rules unless a test names a platform: folder names keep their case. */
const resolveProbeBinary = (
  binary: string,
  folders: ReadonlyArray<string>,
  projectRoots: ReadonlyArray<string>,
  platform: NodeJS.Platform = "linux",
) => resolveProbeBinaryOn(binary, folders, projectRoots, platform);

let base: string;
let tools: string;
let project: string;

const tool = async (folder: string, name: string, script = "#!/bin/sh\nexit 0\n") => {
  await NodeFSP.mkdir(folder, { recursive: true });
  const path = NodePath.join(folder, name);
  await NodeFSP.writeFile(path, script, { mode: 0o755 });
  return path;
};

beforeEach(async () => {
  base = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "credentials-probe-")),
  );
  tools = NodePath.join(base, "tools");
  project = NodePath.join(base, "project");
  await NodeFSP.mkdir(tools);
  await NodeFSP.mkdir(project);
});
afterEach(async () => {
  await NodeFSP.rm(base, { recursive: true, force: true });
});

interface Call {
  readonly path: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Record<string, string>;
}

const machineWith = (
  run: (call: Call) => ProbeRun,
  overrides: Partial<ProbeMachine> = {},
): { readonly machine: ProbeMachine; readonly calls: Array<Call> } => {
  const calls: Array<Call> = [];
  const spawn: ProbeSpawn = async (path, args, options) => {
    const call = { path, args, cwd: options.cwd, env: options.env };
    calls.push(call);
    return run(call);
  };
  return {
    calls,
    machine: {
      platform: "darwin",
      home: base,
      folders: [tools],
      projectRoots: [project],
      inherited: {},
      spawn,
      ...overrides,
    },
  };
};

const ok: ProbeRun = { exitCode: 0, printed: true, timedOut: false };

describe("probeCredential", () => {
  it("runs the catalog command by absolute path, in the home folder", async () => {
    const gh = await tool(tools, "gh");
    const { machine, calls } = machineWith(() => ok);
    expect(await probeCredential(machine, "github")).toBe("ready");
    expect(calls).toEqual([
      expect.objectContaining({
        path: gh,
        args: ["auth", "status", "--hostname", "github.com"],
        cwd: base,
      }),
    ]);
  });

  it("builds the environment from a short list, dropping what could redirect a tool", async () => {
    await tool(tools, "kubectl");
    const { machine, calls } = machineWith(() => ok, {
      inherited: {
        KUBECONFIG: "/project/evil.yaml",
        GH_CONFIG_DIR: "/project/gh",
        AZURE_CONFIG_DIR: "/project/az",
        WRANGLER_HOME: "/project/w",
        CLOUDSDK_CONFIG: "/project/g",
        NODE_OPTIONS: "--require /project/x.js",
        DYLD_INSERT_LIBRARIES: "/project/x.dylib",
        LD_PRELOAD: "/project/x.so",
        PATH: "/project/bin:/usr/bin",
        HOME: "/project",
        LANG: "en_US.UTF-8",
      },
    });
    await probeCredential(machine, "kubernetes");
    const env = calls[0]!.env;
    for (const name of [
      "KUBECONFIG",
      "GH_CONFIG_DIR",
      "AZURE_CONFIG_DIR",
      "WRANGLER_HOME",
      "CLOUDSDK_CONFIG",
      "NODE_OPTIONS",
      "DYLD_INSERT_LIBRARIES",
      "LD_PRELOAD",
    ])
      expect(env).not.toHaveProperty(name);
    expect(env.PATH).toBe(tools);
    expect(env.HOME).toBe(base);
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("reduces every outcome to a status", async () => {
    await tool(tools, "gh");
    await tool(tools, "hcloud");
    const status = (run: ProbeRun, id: "github" | "hetzner-cloud" = "github") =>
      probeCredential(machineWith(() => run).machine, id);
    expect(await status({ exitCode: 1, printed: true, timedOut: false })).toBe("not_signed_in");
    expect(await status({ exitCode: null, printed: false, timedOut: true })).toBe("unknown");
    expect(await status({ exitCode: null, printed: false, timedOut: false })).toBe("unknown");
    // A tool that exits 0 with nothing configured prints nothing.
    expect(await status({ exitCode: 0, printed: false, timedOut: false }, "hetzner-cloud")).toBe(
      "not_signed_in",
    );
    expect(await status(ok, "hetzner-cloud")).toBe("ready");
  });

  it("answers tool_missing without running anything", async () => {
    const { machine, calls } = machineWith(() => ok);
    expect(await probeCredential(machine, "azure")).toBe("tool_missing");
    expect(calls).toEqual([]);
  });

  it("has no check for npm, Wrangler, Docker or SSH, and none on Windows", async () => {
    for (const name of ["npm", "wrangler", "docker", "ssh", "gh"]) await tool(tools, name);
    const { machine, calls } = machineWith(() => ok);
    for (const id of ["npm", "cloudflare", "docker", "ssh"] as const)
      expect(await probeCredential(machine, id)).toBe("unknown");
    const windows = machineWith(() => ok, { platform: "win32" });
    expect(await probeCredential(windows.machine, "github")).toBe("unknown");
    expect(calls).toEqual([]);
    expect(windows.calls).toEqual([]);
  });
});

describe("resolveProbeBinary", () => {
  it("passes over a tool planted in a project, even through a link", async () => {
    const planted = await tool(NodePath.join(project, "bin"), "gh");
    expect(await resolveProbeBinary("gh", [NodePath.join(project, "bin")], [project])).toBeNull();
    await NodeFSP.symlink(planted, NodePath.join(tools, "gh"));
    expect(await resolveProbeBinary("gh", [tools], [project])).toBeNull();
    const real = await tool(NodePath.join(base, "system"), "gh");
    expect(await resolveProbeBinary("gh", [tools, NodePath.join(base, "system")], [project])).toBe(
      real,
    );
  });

  it("refuses a name with a path in it, a folder and a file that cannot run", async () => {
    await tool(tools, "gh");
    expect(await resolveProbeBinary("../tools/gh", [tools], [])).toBeNull();
    await NodeFSP.mkdir(NodePath.join(tools, "az"));
    expect(await resolveProbeBinary("az", [tools], [])).toBeNull();
    await NodeFSP.writeFile(NodePath.join(tools, "aws"), "", { mode: 0o644 });
    expect(await resolveProbeBinary("aws", [tools], [])).toBeNull();
  });
});

describe("resolveProbeBinary and project roots", () => {
  it("matches a root stored through a link, and one that differs only in case on macOS", async () => {
    const planted = await tool(NodePath.join(project, "bin"), "gh");
    await NodeFSP.symlink(planted, NodePath.join(tools, "gh"));
    const linked = NodePath.join(base, "linked-project");
    await NodeFSP.symlink(project, linked);
    expect(await resolveProbeBinary("gh", [tools], [linked], "linux")).toBeNull();
    expect(await resolveProbeBinary("gh", [tools], [project.toUpperCase()], "darwin")).toBeNull();
  });

  it("ignores an empty, relative or whole-disk root instead of ruling out every tool", async () => {
    const gh = await tool(tools, "gh");
    expect(await resolveProbeBinary("gh", [tools], ["", "  ", "relative/root", "/"], "linux")).toBe(
      gh,
    );
  });
});

describe("probeFolders and probeEnvironment", () => {
  it("never include the working directory or a project", () => {
    const folders = probeFolders({ platform: "linux", managed: ["/app/gh/bin"] });
    expect(folders).toContain("/usr/bin");
    expect(folders).toContain("/app/gh/bin");
    expect(folders.every((folder) => NodePath.isAbsolute(folder))).toBe(true);
    expect(probeFolders({ platform: "win32", managed: [] })).toEqual([]);
    // Nothing under a home folder: anything run as the person could have left a tool there.
    for (const platform of ["linux", "darwin"] as const)
      expect(
        probeFolders({ platform, managed: [] }).filter(
          (folder) => folder.startsWith("/Users/") || /^\/home\/(?!linuxbrew\/)/u.test(folder),
        ),
      ).toEqual([]);
    expect(
      Object.keys(probeEnvironment({ home: "/home/me", folders, inherited: {} })).sort(),
    ).toEqual([
      "AWS_PAGER",
      "AZURE_CORE_COLLECT_TELEMETRY",
      "CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK",
      "CLOUDSDK_CORE_DISABLE_PROMPTS",
      "GH_NO_UPDATE_NOTIFIER",
      "GH_PROMPT_DISABLED",
      "GIT_TERMINAL_PROMPT",
      "HOME",
      "NO_COLOR",
      "PATH",
    ]);
  });
});

describe("spawnProbe", () => {
  it("keeps nothing a tool prints and stops one that hangs", async () => {
    const chatty = await tool(tools, "chatty", "#!/bin/sh\necho account-name-and-token\nexit 0\n");
    const run = await spawnProbe(chatty, [], {
      cwd: base,
      env: { PATH: "/usr/bin:/bin" },
      timeoutMs: 5000,
    });
    expect(run).toEqual({ exitCode: 0, printed: true, timedOut: false });
    expect(JSON.stringify(run)).not.toContain("account-name");
    const hang = await tool(tools, "hang", "#!/bin/sh\nsleep 30\n");
    const started = Date.now();
    const stopped = await spawnProbe(hang, [], {
      cwd: base,
      env: { PATH: "/usr/bin:/bin" },
      timeoutMs: 200,
    });
    expect(stopped.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
    const missing = await spawnProbe(NodePath.join(tools, "absent"), [], {
      cwd: base,
      env: {},
      timeoutMs: 1000,
    });
    expect(missing.exitCode).toBeNull();
  });
});

describe("spawnProbe time limit", () => {
  it("ends the wait when a tool leaves a child holding its output open", async () => {
    // The tool exits at once; its background child keeps stdout open for 30 seconds.
    const leaver = await tool(tools, "leaver", "#!/bin/sh\n(sleep 30) &\nexit 0\n");
    const started = Date.now();
    const run = await spawnProbe(leaver, [], {
      cwd: base,
      env: { PATH: "/usr/bin:/bin" },
      timeoutMs: 300,
    });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(run.timedOut).toBe(true);
  });
});

describe("ProbeGate", () => {
  it("answers from the last minute's result, then asks again", async () => {
    await tool(tools, "gh");
    let now = 1_000_000;
    const { machine, calls } = machineWith(() => ok);
    const gate = new ProbeGate(() => now);
    const first = await gate.run(machine, ["github", "npm"], false);
    expect(first).toEqual([
      { id: "github", status: "ready", signIn: "gh auth login && gh auth setup-git", check: null },
      { id: "npm", status: "unknown", signIn: "npm login", check: "npm whoami" },
    ]);
    await gate.run(machine, ["github"], false);
    expect(calls).toHaveLength(1);
    now += 61_000;
    await gate.run(machine, ["github"], false);
    expect(calls).toHaveLength(2);
    await gate.run(machine, ["github"], true);
    expect(calls).toHaveLength(3);
  });

  it("refuses more than six batches a minute, and recovers", async () => {
    await tool(tools, "gh");
    let now = 5_000_000;
    const { machine, calls } = machineWith(() => ok);
    const gate = new ProbeGate(() => now);
    for (let index = 0; index < PROBE_BATCHES_PER_MINUTE; index += 1) {
      await gate.run(machine, ["github"], true);
      now += 1000;
    }
    await expect(gate.run(machine, ["github"], true)).rejects.toBeInstanceOf(ProbeBusy);
    expect(calls).toHaveLength(PROBE_BATCHES_PER_MINUTE);
    // Credentials with no check never count against the cap.
    await expect(gate.run(machine, ["npm"], true)).resolves.toHaveLength(1);
    now += 61_000;
    await expect(gate.run(machine, ["github"], true)).resolves.toHaveLength(1);
  });

  it("runs one batch at a time", async () => {
    await tool(tools, "gh");
    await tool(tools, "az");
    let running = 0;
    let most = 0;
    const calls: Array<string> = [];
    const spawn: ProbeSpawn = async (path) => {
      running += 1;
      most = Math.max(most, running);
      calls.push(NodePath.basename(path));
      await new Promise((resolve) => setTimeout(resolve, 20));
      running -= 1;
      return ok;
    };
    const { machine } = machineWith(() => ok, { spawn });
    const gate = new ProbeGate();
    await Promise.all([gate.run(machine, ["github"], true), gate.run(machine, ["azure"], true)]);
    expect(most).toBe(1);
    expect(calls).toEqual(["gh", "az"]);
  });
});
