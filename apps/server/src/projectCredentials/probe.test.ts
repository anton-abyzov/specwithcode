// @effect-diagnostics nodeBuiltinImport:off - temp folders holding stand-in tools.
// @effect-diagnostics globalTimers:off globalDate:off - a stand-in tool that takes a moment, timed by the wall clock.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { CREDENTIAL_CATALOG } from "./catalog.ts";
import {
  answerCredential,
  knownGitHosts,
  NO_CONTEXT,
  PROBE_BATCHES_PER_MINUTE,
  PROBE_CLICKS_PER_MINUTE,
  ProbeBusy,
  type ProbeContext,
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
import { shellWord } from "./tool.ts";

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
  readonly argv0?: string | undefined;
  readonly refusal?: RegExp | undefined;
}

const machineWith = (
  run: (call: Call) => ProbeRun,
  overrides: Partial<ProbeMachine> = {},
): { readonly machine: ProbeMachine; readonly calls: Array<Call> } => {
  const calls: Array<Call> = [];
  const spawn: ProbeSpawn = async (path, args, options) => {
    const call = {
      path,
      args,
      cwd: options.cwd,
      env: options.env,
      argv0: options.argv0,
      refusal: options.refusal,
    };
    calls.push(call);
    return run(call);
  };
  return {
    calls,
    machine: {
      platform: "darwin",
      home: base,
      folders: [tools],
      terminalFolders: [tools],
      appFolders: [],
      projectRoots: [project],
      projectRoot: null,
      xdgConfigHome: null,
      knownHosts: null,
      inherited: {},
      variables: {},
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
        // One file can serve several names (a version manager's shim): it is told which.
        argv0: "gh",
      }),
    ]);
  });

  it("runs the file a link leads to, under the tool's own name", async () => {
    const shim = await tool(NodePath.join(base, "shims"), "multi-shim");
    const linked = NodePath.join(tools, "gh");
    await NodeFSP.symlink(shim, linked);
    const { machine, calls } = machineWith(() => ok);
    expect(await probeCredential(machine, "github")).toBe("ready");
    expect(calls[0]).toEqual(expect.objectContaining({ path: shim, argv0: "gh" }));
  });

  it("gives a check the Terminal's way to the network and only its own sign-in variables", async () => {
    for (const name of ["gh", "wrangler", "kubectl"]) await tool(tools, name);
    const variables = {
      HTTPS_PROXY: "http://proxy.example:8080",
      SSH_AUTH_SOCK: "/tmp/terminal-agent.sock",
      GH_TOKEN: "terminal-gh",
      CLOUDFLARE_API_TOKEN: "terminal-cf",
      // Not on the app's list: never passed on, whatever the shell has.
      KUBECONFIG: "/project/evil.yaml",
    };
    const inherited = { SSH_AUTH_SOCK: "/tmp/server-agent.sock", GH_TOKEN: "server-gh" };
    const env = async (id: "github" | "cloudflare" | "kubernetes") => {
      const { machine, calls } = machineWith(() => says("signedIn"), { variables, inherited });
      await probeCredential(machine, id);
      return calls[0]!.env;
    };
    const github = await env("github");
    expect(github["GH_TOKEN"]).toBe("terminal-gh");
    expect(github["HTTPS_PROXY"]).toBe("http://proxy.example:8080");
    // The Terminal's own key agent, not the one the server started with.
    expect(github["SSH_AUTH_SOCK"]).toBe("/tmp/terminal-agent.sock");
    expect(github).not.toHaveProperty("CLOUDFLARE_API_TOKEN");
    const cloudflare = await env("cloudflare");
    expect(cloudflare["CLOUDFLARE_API_TOKEN"]).toBe("terminal-cf");
    expect(cloudflare).not.toHaveProperty("GH_TOKEN");
    const kubernetes = await env("kubernetes");
    for (const name of ["GH_TOKEN", "CLOUDFLARE_API_TOKEN", "KUBECONFIG"])
      expect(kubernetes).not.toHaveProperty(name);
    // A sign-in variable the server alone has is not the person's Terminal sign-in.
    const { machine, calls } = machineWith(() => ok, { inherited });
    await probeCredential(machine, "github");
    expect(calls[0]!.env).not.toHaveProperty("GH_TOKEN");
    expect(calls[0]!.env["SSH_AUTH_SOCK"]).toBe("/tmp/server-agent.sock");
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

  it("has no check for Docker, or for SSH without a known Git host, and none on Windows", async () => {
    for (const name of ["docker", "ssh", "gh"]) await tool(tools, name);
    const { machine, calls } = machineWith(() => ok);
    for (const id of ["docker", "ssh"] as const)
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
      "NPM_CONFIG_FUND",
      "NPM_CONFIG_UPDATE_NOTIFIER",
      "PATH",
      "WRANGLER_SEND_METRICS",
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
    const first = await gate.run(machine, ["github", "docker"], false);
    expect(first).toEqual([
      expect.objectContaining({
        id: "github",
        status: "ready",
        signIn: "gh auth login && gh auth setup-git",
        check: null,
        ran: "tool",
      }),
      expect.objectContaining({
        id: "docker",
        status: "unknown",
        signIn: "docker login <registry>",
        ran: "none",
      }),
    ]);
    expect(first.map((answer) => answer.checkedMsAgo)).toEqual([0, 0]);
    now += 30_000;
    // A kept answer says how old it is, so it is not shown as checked just now.
    expect((await gate.run(machine, ["github"], false))[0]!.checkedMsAgo).toBe(30_000);
    expect(calls).toHaveLength(1);
    now += 31_000;
    await gate.run(machine, ["github"], false);
    expect(calls).toHaveLength(2);
    await gate.run(machine, ["github"], true);
    expect(calls).toHaveLength(3);
  });

  it("refuses more than six opening checks a minute, and recovers", async () => {
    await tool(tools, "gh");
    let now = 5_000_000;
    const { machine, calls } = machineWith(() => ok);
    const gate = new ProbeGate(() => now);
    // Another project is another answer, so each of these runs the tool.
    const opened = (index: number) =>
      gate.run({ ...machine, projectRoot: `/projects/p${index}` }, ["github"], false);
    for (let index = 0; index < PROBE_BATCHES_PER_MINUTE; index += 1) {
      await opened(index);
      now += 1000;
    }
    await expect(opened(99)).rejects.toBeInstanceOf(ProbeBusy);
    expect(calls).toHaveLength(PROBE_BATCHES_PER_MINUTE);
    // Credentials with no check never count against the cap.
    await expect(gate.run(machine, ["docker"], false)).resolves.toHaveLength(1);
    // What opening used up is not taken from the person's own clicks.
    await expect(gate.run(machine, ["github"], true)).resolves.toHaveLength(1);
    now += 61_000;
    await expect(opened(100)).resolves.toHaveLength(1);
  });

  it("gives a person's own clicks a larger allowance, with an end", async () => {
    await tool(tools, "gh");
    let now = 7_000_000;
    const { machine, calls } = machineWith(() => ok);
    const gate = new ProbeGate(() => now);
    for (let index = 0; index < PROBE_CLICKS_PER_MINUTE; index += 1) {
      await gate.run(machine, ["github"], true);
      now += 100;
    }
    await expect(gate.run(machine, ["github"], true)).rejects.toBeInstanceOf(ProbeBusy);
    expect(calls).toHaveLength(PROBE_CLICKS_PER_MINUTE);
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

const context = (over: Partial<ProbeContext> = {}): ProbeContext => ({ ...NO_CONTEXT, ...over });
const says = (said: "signedIn" | "signedOut" | null, exitCode = 0): ProbeRun => ({
  exitCode,
  printed: true,
  timedOut: false,
  said,
});

describe("the catalog's tools", () => {
  it("checks every credential with the tool its commands name", () => {
    for (const entry of CREDENTIAL_CATALOG)
      if (entry.probe !== null) expect(entry.tool?.binary, entry.id).toBe(entry.probe.binary);
  });
});

describe("Cloudflare and npm checks", () => {
  it("goes by wrangler's own sentence, because it exits 0 signed out", async () => {
    await tool(tools, "wrangler");
    const status = (run: ProbeRun) => probeCredential(machineWith(() => run).machine, "cloudflare");
    expect(await status(says("signedIn"))).toBe("ready");
    expect(await status(says("signedOut"))).toBe("not_signed_in");
    // No sentence, or an error exit: no answer, never a guess.
    expect(await status(says(null))).toBe("unknown");
    expect(await status(says(null, 1))).toBe("unknown");
    expect(await status(says("signedIn", 1))).toBe("unknown");
    const { machine, calls } = machineWith(() => says("signedIn"));
    await probeCredential(machine, "cloudflare");
    expect(calls[0]).toEqual(expect.objectContaining({ args: ["whoami"], cwd: base }));
  });

  it("hears which sentence a real tool printed and keeps none of it", async () => {
    const signedIn = await tool(
      tools,
      "wrangler",
      "#!/bin/sh\necho 'You are logged in with an OAuth Token, associated with the email someone@example.com.'\n",
    );
    const entry = CREDENTIAL_CATALOG.find((item) => item.id === "cloudflare")!;
    const options = { cwd: base, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 5000 };
    const run = await spawnProbe(signedIn, [], { ...options, says: entry.probe!.says });
    expect(run).toEqual({ exitCode: 0, printed: true, timedOut: false, said: "signedIn" });
    expect(JSON.stringify(run)).not.toContain("example.com");
    const signedOut = await tool(
      tools,
      "wrangler-out",
      "#!/bin/sh\necho 'You are not authenticated. Please run `wrangler login`.'\n",
    );
    expect((await spawnProbe(signedOut, [], { ...options, says: entry.probe!.says })).said).toBe(
      "signedOut",
    );
    const other = await tool(tools, "wrangler-other", "#!/bin/sh\necho something else\n");
    expect((await spawnProbe(other, [], { ...options, says: entry.probe!.says })).said).toBeNull();
  });

  it("asks npm who is signed in, by exit code, and takes only its refusal as signed out", async () => {
    await tool(tools, "npm");
    const { machine, calls } = machineWith(() => ok);
    expect(await probeCredential(machine, "npm")).toBe("ready");
    expect(calls[0]).toEqual(expect.objectContaining({ args: ["whoami"], cwd: base }));
    for (const line of ["npm error code ENEEDAUTH", "npm ERR! code E401"])
      expect(calls[0]!.refusal!.test(line), line).toBe(true);
    expect(calls[0]!.refusal!.test("npm error code ENOTFOUND")).toBe(false);
    const failed = (refused: boolean) =>
      probeCredential(
        machineWith(() => ({ exitCode: 1, printed: false, timedOut: false, refused })).machine,
        "npm",
      );
    expect(await failed(true)).toBe("not_signed_in");
    // Offline or behind a proxy: the registry never answered, so neither does the row.
    expect(await failed(false)).toBe("unknown");
  });

  it("hears a refusal on a real tool's error output and keeps none of it", async () => {
    const entry = CREDENTIAL_CATALOG.find((item) => item.id === "npm")!;
    const options = { cwd: base, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 5000 };
    const refused = await tool(
      tools,
      "npm",
      "#!/bin/sh\necho 'npm error code ENEEDAUTH' >&2\necho 'npm error need auth for someone' >&2\nexit 1\n",
    );
    const run = await spawnProbe(refused, ["whoami"], {
      ...options,
      refusal: entry.probe!.refusal!,
    });
    expect(run).toEqual({ exitCode: 1, printed: false, timedOut: false, refused: true });
    const offline = await tool(
      tools,
      "npm-offline",
      "#!/bin/sh\necho 'npm error code ENOTFOUND' >&2\nexit 1\n",
    );
    expect(
      (await spawnProbe(offline, [], { ...options, refusal: entry.probe!.refusal! })).refused,
    ).toBe(false);
  });
});

describe("where the tool is", () => {
  it("leaves a tool Terminal finds as it was: the plain commands and no install", async () => {
    await tool(tools, "wrangler");
    const answer = await answerCredential(
      machineWith(() => says("signedIn")).machine,
      "cloudflare",
    );
    expect(answer).toEqual({
      id: "cloudflare",
      status: "ready",
      signIn: "wrangler login",
      check: "wrangler whoami",
      ran: "tool",
      tool: {
        name: "wrangler",
        state: "terminal",
        folder: null,
        install: null,
        newShell: false,
        signIn: "wrangler login",
        check: "wrangler whoami",
        appPath: null,
      },
    });
  });

  it("adds the folder to PATH for a tool only the app's folders hold", async () => {
    const app = NodePath.join(base, "app home", "commands");
    const npm = await tool(app, "npm");
    const { machine } = machineWith(() => ok, {
      folders: [tools, app],
      terminalFolders: [tools],
      appFolders: [app],
    });
    const answer = await answerCredential(machine, "npm");
    expect(answer.status).toBe("ready");
    expect(answer.tool).toEqual(
      expect.objectContaining({
        state: "app",
        appPath: npm,
        // The tool is a script that looks for `node` beside it, so its folder goes on PATH.
        // The folder has a space in it, so it is one quoted word.
        signIn: `export PATH='${app}':"$PATH" && npm login`,
        check: `export PATH='${app}':"$PATH" && npm whoami`,
        install: null,
      }),
    );
    // The short form stays the catalog's, for a window from before the tool check.
    expect(answer.signIn).toBe("npm login");
  });

  it("calls a system folder's tool the machine's own, with commands that still reach it", async () => {
    const system = NodePath.join(base, "system", "bin");
    await tool(system, "gh");
    const { machine } = machineWith(() => ok, {
      folders: [tools, system],
      terminalFolders: [tools],
      appFolders: [],
    });
    expect((await answerCredential(machine, "github")).tool).toEqual(
      expect.objectContaining({
        state: "terminal",
        appPath: null,
        signIn: `export PATH=${shellWord(system)}:"$PATH" && gh auth login && gh auth setup-git`,
      }),
    );
  });

  it("offers npm for an npm tool, reached through its folder when only the app has npm", async () => {
    await tool(tools, "npm");
    const found = await answerCredential(machineWith(() => ok).machine, "cloudflare");
    expect(found.status).toBe("tool_missing");
    expect(found.tool).toEqual(
      expect.objectContaining({
        state: "missing",
        install: "npm install --global wrangler",
        signIn: "wrangler login",
      }),
    );
    const app = NodePath.join(base, "app", "commands");
    await tool(app, "npm");
    const appOnly = machineWith(() => ok, {
      folders: [app],
      terminalFolders: [],
      appFolders: [app],
    });
    expect((await answerCredential(appOnly.machine, "cloudflare")).tool?.install).toBe(
      `export PATH=${shellWord(app)}:"$PATH" && npm install --global wrangler`,
    );
    // No npm to run it with: Node.js is what the machine lacks, and the answer says so.
    const none = machineWith(() => ok, { folders: [], terminalFolders: [] });
    expect((await answerCredential(none.machine, "cloudflare")).tool).toEqual(
      expect.objectContaining({ install: null, needsNode: true }),
    );
    expect(found.tool).not.toHaveProperty("needsNode");
  });

  it("offers Homebrew where it is there, and Google's installer where it is not", async () => {
    // The installer is fetched with curl: a machine without it gets no command that cannot start.
    const curlless = await answerCredential(machineWith(() => ok).machine, "google-cloud");
    expect(curlless.tool).toEqual(expect.objectContaining({ state: "missing", install: null }));
    expect(curlless.tool).not.toHaveProperty("needsNode");
    await tool(tools, "curl");
    const bare = await answerCredential(machineWith(() => ok).machine, "google-cloud");
    expect(bare.status).toBe("tool_missing");
    expect(bare.tool).toEqual(
      expect.objectContaining({
        state: "missing",
        install: "curl https://sdk.cloud.google.com | bash",
        newShell: true,
        signIn: "gcloud auth login --no-launch-browser",
        check: "gcloud auth list",
      }),
    );
    await tool(tools, "brew");
    const brewed = await answerCredential(machineWith(() => ok).machine, "google-cloud");
    expect(brewed.tool).toEqual(
      expect.objectContaining({ install: "brew install --cask gcloud-cli", newShell: false }),
    );
    expect((await answerCredential(machineWith(() => ok).machine, "azure")).tool?.install).toBe(
      "brew install azure-cli",
    );
    // A cask is a macOS package: Linux with Homebrew gets Google's installer, and plain formulas.
    const linux = machineWith(() => ok, { platform: "linux" }).machine;
    expect((await answerCredential(linux, "google-cloud")).tool).toEqual(
      expect.objectContaining({
        install: "curl https://sdk.cloud.google.com | bash",
        newShell: true,
      }),
    );
    expect((await answerCredential(linux, "azure")).tool?.install).toBe("brew install azure-cli");
    // No install the app knows: the row keeps its plain sentence, and Node.js is not blamed.
    const docker = (await answerCredential(machineWith(() => ok).machine, "docker")).tool;
    expect(docker).toEqual(expect.objectContaining({ state: "missing", install: null }));
    expect(docker).not.toHaveProperty("needsNode");
    expect(bare.tool).not.toHaveProperty("needsNode");
  });
});

describe("a tool the project brings itself", () => {
  const platformFolder = "repositories/acme/platform";
  let folder: string;
  const declare = async (extra: Record<string, unknown> = {}) => {
    folder = NodePath.join(project, platformFolder);
    await NodeFSP.mkdir(folder, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(folder, "package.json"),
      JSON.stringify({ name: "platform", devDependencies: { wrangler: "^4.0.0" }, ...extra }),
    );
  };
  const asked = context({ packages: new Map([["cloudflare", [platformFolder]]]) });
  const here = (overrides: Partial<ProbeMachine> = {}) =>
    machineWith(() => says("signedIn"), { projectRoot: project, ...overrides });

  it("installs through the project, with the lockfile's package manager, before the sign-in", async () => {
    await declare();
    await tool(tools, "npm");
    const npm = await answerCredential(here().machine, "cloudflare", asked);
    expect(npm.status).toBe("tool_missing");
    expect(npm.tool).toEqual({
      name: "wrangler",
      state: "missing",
      folder,
      install: `cd ${folder} && npm install`,
      newShell: false,
      // npm is there and npx is not: npm runs the project's tool itself.
      signIn: `cd ${folder} && npm exec -- wrangler login`,
      check: `cd ${folder} && npm exec -- wrangler whoami`,
      appPath: null,
    });
    // The lockfile sits at the top of the project: a workspace's one lockfile.
    await NodeFSP.writeFile(NodePath.join(project, "pnpm-lock.yaml"), "");
    // No pnpm and no npx to fetch it with: no command is offered that could not run.
    expect((await answerCredential(here().machine, "cloudflare", asked)).tool?.install).toBeNull();
    await tool(tools, "npx");
    expect((await answerCredential(here().machine, "cloudflare", asked)).tool?.install).toBe(
      `cd ${folder} && npx --yes pnpm install`,
    );
    await tool(tools, "pnpm");
    expect((await answerCredential(here().machine, "cloudflare", asked)).tool?.install).toBe(
      `cd ${folder} && pnpm install`,
    );
    // A manager that stands alone, with no npm or npx to run the tool afterwards, installs nothing:
    // Node.js is what that machine lacks, and the answer says so.
    const alone = NodePath.join(base, "alone");
    await tool(alone, "pnpm");
    const standalone = await answerCredential(
      here({ folders: [alone], terminalFolders: [alone] }).machine,
      "cloudflare",
      asked,
    );
    expect(standalone.tool).toEqual(
      expect.objectContaining({ state: "missing", install: null, needsNode: true }),
    );
    await declare({ packageManager: "yarn@4.5.0" });
    await tool(tools, "yarn");
    expect((await answerCredential(here().machine, "cloudflare", asked)).tool?.install).toBe(
      `cd ${folder} && yarn install`,
    );
  });

  it("never runs the project's copy when the list opens, only when the person asks", async () => {
    await declare();
    const bin = await tool(NodePath.join(folder, "node_modules", ".bin"), "wrangler");
    const opened = here();
    const waiting = await answerCredential(opened.machine, "cloudflare", asked);
    expect(waiting).toEqual(expect.objectContaining({ status: "unknown", ran: "waiting" }));
    expect(waiting.tool).toEqual(
      expect.objectContaining({
        state: "project",
        folder,
        install: null,
        signIn: `cd ${folder} && npx wrangler login`,
      }),
    );
    expect(opened.calls).toEqual([]);
    const clicked = here();
    const answered = await answerCredential(
      clicked.machine,
      "cloudflare",
      context({ ...asked, projectTools: true }),
    );
    expect(answered).toEqual(expect.objectContaining({ status: "ready", ran: "tool" }));
    // In the home folder, so the project's own .env and wrangler file do not answer for the person.
    expect(clicked.calls).toEqual([
      expect.objectContaining({ path: bin, args: ["whoami"], cwd: base, argv0: "wrangler" }),
    ]);
  });

  it("runs the file the project's link was checked to lead to, and reaches npx through its folder", async () => {
    await declare();
    const real = await tool(
      NodePath.join(folder, "node_modules", "wrangler", "bin"),
      "wrangler.js",
    );
    await NodeFSP.mkdir(NodePath.join(folder, "node_modules", ".bin"), { recursive: true });
    await NodeFSP.symlink(real, NodePath.join(folder, "node_modules", ".bin", "wrangler"));
    const app = NodePath.join(base, "app", "commands");
    await tool(app, "npx");
    const clicked = here({ folders: [tools, app], appFolders: [app] });
    const answer = await answerCredential(
      clicked.machine,
      "cloudflare",
      context({ ...asked, projectTools: true }),
    );
    // The link is not followed a second time when the check runs.
    expect(clicked.calls).toEqual([expect.objectContaining({ path: real, argv0: "wrangler" })]);
    expect(answer.tool?.signIn).toBe(
      `cd ${folder} && export PATH=${shellWord(app)}:"$PATH" && npx wrangler login`,
    );
  });

  it("finds a copy hoisted to a folder above, and prefers the tool Terminal has", async () => {
    await declare();
    await tool(NodePath.join(project, "node_modules", ".bin"), "wrangler");
    expect((await answerCredential(here().machine, "cloudflare", asked)).tool?.state).toBe(
      "project",
    );
    await tool(tools, "wrangler");
    const global = await answerCredential(here().machine, "cloudflare", asked);
    expect(global.tool).toEqual(
      expect.objectContaining({ state: "terminal", folder: null, signIn: "wrangler login" }),
    );
  });

  it("goes by this machine's files, never by what the other machine said", async () => {
    await declare();
    const outside = NodePath.join(base, "outside");
    await NodeFSP.mkdir(outside);
    await NodeFSP.writeFile(
      NodePath.join(outside, "package.json"),
      JSON.stringify({ devDependencies: { wrangler: "1" } }),
    );
    await NodeFSP.symlink(outside, NodePath.join(project, "linked"));
    await NodeFSP.mkdir(NodePath.join(project, "plain"));
    await NodeFSP.writeFile(NodePath.join(project, "plain", "package.json"), "{}");
    for (const folders of [
      ["../outside"],
      [outside],
      ["linked"],
      ["plain"],
      ["missing"],
      ["repositories/../../outside"],
      ["bad‮name"],
    ]) {
      const answer = await answerCredential(
        here().machine,
        "cloudflare",
        context({ packages: new Map([["cloudflare", folders]]), projectTools: true }),
      );
      expect(answer.tool, folders[0]).toEqual(
        expect.objectContaining({ state: "missing", folder: null }),
      );
    }
    // No copy of the project on this machine yet: nothing to look in.
    const before = await answerCredential(here({ projectRoot: null }).machine, "cloudflare", asked);
    expect(before.tool?.folder).toBeNull();
    // A link in node_modules/.bin that leaves the project is not the project's tool.
    const elsewhere = await tool(NodePath.join(base, "elsewhere"), "wrangler");
    await NodeFSP.mkdir(NodePath.join(folder, "node_modules", ".bin"), { recursive: true });
    await NodeFSP.symlink(elsewhere, NodePath.join(folder, "node_modules", ".bin", "wrangler"));
    expect((await answerCredential(here().machine, "cloudflare", asked)).tool?.state).toBe(
      "missing",
    );
  });

  it("writes a folder with a space or a quote in it as one shell word", async () => {
    const odd = NodePath.join(project, "it's here");
    await NodeFSP.mkdir(odd);
    await NodeFSP.writeFile(
      NodePath.join(odd, "package.json"),
      JSON.stringify({ dependencies: { wrangler: "4" } }),
    );
    const answer = await answerCredential(
      here().machine,
      "cloudflare",
      context({ packages: new Map([["cloudflare", ["it's here"]]]) }),
    );
    expect(answer.tool?.signIn).toBe(`cd '${project}/it'\\''s here' && npx wrangler login`);
  });
});

describe("sign-in files, as a hint only", () => {
  const put = async (file: string) => {
    await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
    await NodeFSP.writeFile(file, "stand-in\n");
  };

  it("says a file is there when the check could not answer, and never calls that ready", async () => {
    await put(NodePath.join(base, "Library/Preferences/.wrangler/config/default.toml"));
    const missing = await answerCredential(machineWith(() => ok).machine, "cloudflare");
    expect(missing).toEqual(expect.objectContaining({ status: "tool_missing", signInFile: true }));
    await tool(tools, "wrangler");
    const silent = await answerCredential(machineWith(() => says(null)).machine, "cloudflare");
    expect(silent).toEqual(expect.objectContaining({ status: "unknown", signInFile: true }));
    // An answer from the tool stands by itself: a stale file does not soften it.
    const out = await answerCredential(machineWith(() => says("signedOut")).machine, "cloudflare");
    expect(out.status).toBe("not_signed_in");
    expect(out).not.toHaveProperty("signInFile");
  });

  it("looks under XDG_CONFIG_HOME when the person set one, and gives it to the tool", async () => {
    const xdg = NodePath.join(base, "config home");
    await tool(tools, "wrangler");
    const plain = machineWith(() => says(null));
    expect(await answerCredential(plain.machine, "cloudflare")).not.toHaveProperty("signInFile");
    expect(plain.calls[0]!.env).not.toHaveProperty("XDG_CONFIG_HOME");
    await put(NodePath.join(xdg, ".wrangler/config/default.toml"));
    const set = machineWith(() => says(null), { xdgConfigHome: xdg });
    expect(await answerCredential(set.machine, "cloudflare")).toEqual(
      expect.objectContaining({ signInFile: true }),
    );
    expect(set.calls[0]!.env["XDG_CONFIG_HOME"]).toBe(xdg);
  });
});

describe("SSH to the known Git hosts", () => {
  const known = () => NodePath.join(base, "known-git-hosts");
  const sshMachine = (run: (call: Call) => ProbeRun) => machineWith(run, { knownHosts: known() });
  const exit = (exitCode: number | null, timedOut = false, refused = false): ProbeRun => ({
    exitCode,
    printed: false,
    timedOut,
    refused,
  });

  it("pins the three hosts' keys, one line each", () => {
    const lines = knownGitHosts().trim().split("\n");
    expect(lines.map((line) => line.split(" ")[0])).toEqual([
      "github.com",
      "gitlab.com",
      "bitbucket.org",
    ]);
    for (const line of lines) expect(line).toMatch(/^[a-z.]+ ssh-ed25519 [A-Za-z0-9+/]{68}$/u);
  });

  it("asks only the hosts it was given, with each host's own code for a known key", async () => {
    const ssh = await tool(tools, "ssh");
    const github = sshMachine(() => exit(1));
    expect(
      await probeCredential(github.machine, "ssh", context({ sshHosts: ["github.com"] })),
    ).toBe("ready");
    expect(github.calls).toHaveLength(1);
    const call = github.calls[0]!;
    expect(call.path).toBe(ssh);
    expect(call.cwd).toBe(base);
    expect(call.refusal!.test("git@github.com: Permission denied (publickey).")).toBe(true);
    expect(call.refusal!.test("ssh: connect to host github.com port 22: Network is down")).toBe(
      false,
    );
    expect(call.args.at(-1)).toBe("git@github.com");
    expect(call.args).toContain("BatchMode=yes");
    // A first contact trusts the pinned key or the person's own file, and writes nothing.
    expect(call.args).toContain("StrictHostKeyChecking=yes");
    expect(call.args).toContain(
      `UserKnownHostsFile="${NodePath.join(base, ".ssh", "known_hosts")}" "${known()}"`,
    );
    const both = sshMachine((made) => exit(made.args.at(-1) === "git@github.com" ? 1 : 0));
    expect(
      await probeCredential(
        both.machine,
        "ssh",
        context({ sshHosts: ["github.com", "gitlab.com", "github.com"] }),
      ),
    ).toBe("ready");
    expect(both.calls.map((made) => made.args.at(-1))).toEqual([
      "git@github.com",
      "git@gitlab.com",
    ]);
  });

  it("reads a refused key as no accepted key, and anything else it cannot place as no answer", async () => {
    await tool(tools, "ssh");
    const status = (run: ProbeRun, host: "github.com" | "gitlab.com" = "github.com") =>
      probeCredential(sshMachine(() => run).machine, "ssh", context({ sshHosts: [host] }));
    expect(await status(exit(255, false, true))).toBe("not_signed_in");
    // 255 is also what ssh exits with offline: without the host's refusal it is no answer.
    expect(await status(exit(255))).toBe("unknown");
    expect(await status(exit(null, true))).toBe("unknown");
    // One host that could not be reached does not make the other's accepted key a refusal.
    const mixed = sshMachine((made) =>
      made.args.at(-1) === "git@github.com" ? exit(1) : exit(255),
    );
    expect(
      await probeCredential(
        mixed.machine,
        "ssh",
        context({ sshHosts: ["github.com", "gitlab.com"] }),
      ),
    ).toBe("unknown");
    // GitHub's code for a known key is 1; GitLab's is 0.
    expect(await status(exit(0))).toBe("unknown");
    expect(await status(exit(1), "gitlab.com")).toBe("unknown");
    expect(await status(exit(0), "gitlab.com")).toBe("ready");
  });

  it("contacts nothing without a known host, a pinned key file or ssh itself", async () => {
    const noSsh = sshMachine(() => exit(1));
    expect(await probeCredential(noSsh.machine, "ssh", context({ sshHosts: ["github.com"] }))).toBe(
      "unknown",
    );
    await tool(tools, "ssh");
    const noHosts = sshMachine(() => exit(1));
    expect(await probeCredential(noHosts.machine, "ssh")).toBe("unknown");
    const unpinned = machineWith(() => exit(1));
    expect(
      await probeCredential(unpinned.machine, "ssh", context({ sshHosts: ["github.com"] })),
    ).toBe("unknown");
    const stranger = sshMachine(() => exit(1));
    expect(
      await probeCredential(
        stranger.machine,
        "ssh",
        context({ sshHosts: ["evil.example" as never] }),
      ),
    ).toBe("unknown");
    for (const made of [noSsh, noHosts, unpinned, stranger]) expect(made.calls).toEqual([]);
  });
});

describe("Check again", () => {
  it("runs the tool again and moves a row from signed out to ready", async () => {
    await tool(tools, "npm");
    let signedIn = false;
    const { machine, calls } = machineWith(() =>
      signedIn ? ok : { exitCode: 1, printed: false, timedOut: false, refused: true },
    );
    const gate = new ProbeGate(() => 1_000_000);
    expect((await gate.run(machine, ["npm"], true))[0]!.status).toBe("not_signed_in");
    signedIn = true;
    // Opening the list again within the minute still answers from memory.
    expect((await gate.run(machine, ["npm"], false))[0]!.status).toBe("not_signed_in");
    expect(calls).toHaveLength(1);
    expect((await gate.run(machine, ["npm"], true))[0]!.status).toBe("ready");
    expect(calls).toHaveLength(2);
    expect((await gate.run(machine, ["npm"], false))[0]!.status).toBe("ready");
  });

  it("keeps an answer for one project apart from another's, and a click apart from opening", async () => {
    const folder = NodePath.join(project, "app");
    await tool(NodePath.join(folder, "node_modules", ".bin"), "wrangler");
    await NodeFSP.writeFile(
      NodePath.join(folder, "package.json"),
      JSON.stringify({ devDependencies: { wrangler: "4" } }),
    );
    const { machine, calls } = machineWith(() => says("signedIn"), { projectRoot: project });
    const gate = new ProbeGate(() => 1_000_000);
    const packages = new Map([["cloudflare" as const, ["app"]]]);
    const opened = await gate.run(machine, ["cloudflare"], false, context({ packages }));
    expect(opened[0]).toEqual(expect.objectContaining({ status: "unknown", ran: "waiting" }));
    const clicked = await gate.run(
      machine,
      ["cloudflare"],
      false,
      context({ packages, projectTools: true }),
    );
    expect(clicked[0]).toEqual(expect.objectContaining({ status: "ready", ran: "tool" }));
    expect(calls).toHaveLength(1);
    // Opening the list again keeps what the click found, and runs nothing.
    const reopened = await gate.run(machine, ["cloudflare"], false, context({ packages }));
    expect(reopened[0]).toEqual(expect.objectContaining({ status: "ready", ran: "tool" }));
    expect(calls).toHaveLength(1);
    // Without the project's folders the same machine has no wrangler at all.
    const bare = await gate.run(machine, ["cloudflare"], false);
    expect(bare[0]!.status).toBe("tool_missing");
  });
});
