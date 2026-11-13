// @effect-diagnostics nodeBuiltinImport:off - Real temp homes, archives and a loopback mirror.
import { describe, expect, it } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ChecksumMismatchError,
  makeNodeProvisionHost,
  type ProvisionHost,
} from "../provision/host.ts";
import {
  GH_VERSION,
  NODE_VERSION,
  nodeDownload,
  SPECWEAVE_VERSION,
} from "../provision/manifest.ts";
import {
  checkMachineTools,
  existingManagedToolDirs,
  installMachineTool,
  MachineToolInstallError,
  managedGhDir,
  managedNodeDir,
  managedToolDirs,
  toolPlatformKey,
  withPathDirs,
  type MachineToolsContext,
} from "./machineTools.ts";
import { managedSpecweaveDir, managedSpecweavePrefix } from "./specweaveTool.ts";

// oxlint-disable-next-line studio/no-global-process-runtime -- the tests install for the machine they run on.
const HOST_PLATFORM = process.platform;
// oxlint-disable-next-line studio/no-global-process-runtime -- as above.
const HOST_ARCH = process.arch;
const posix = HOST_PLATFORM !== "win32";
const tempDir = (name: string) => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), `${name}-`));

/** This process's environment without its PATH, which Windows spells `Path`. */
const withoutPath = () =>
  Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"));

/** A host with an empty PATH and a download that hands over a prepared archive. */
function hostWith(
  input: {
    readonly path?: string;
    readonly archive?: string;
    readonly env?: Record<string, string>;
    readonly exec?: ProvisionHost["exec"];
  } = {},
) {
  const real = makeNodeProvisionHost({
    env: { ...withoutPath(), PATH: input.path ?? "", ...input.env },
  });
  const downloads: string[] = [];
  const host: ProvisionHost = {
    ...real,
    ...(input.exec ? { exec: input.exec } : {}),
    download: async (url, file, options) => {
      downloads.push(url);
      if (input.archive === undefined) return real.download(url, file, options);
      await NodeFSP.copyFile(input.archive, file);
    },
  };
  return { host, downloads };
}

const context = (host: ProvisionHost, home: string): MachineToolsContext => ({
  host,
  home,
  glibc: true,
  nodeManagerDirs: [],
});

/** A tar.gz shaped like nodejs.org's: one folder holding bin/node, which reports `version`. */
async function fakeNodeArchive(version: string) {
  const work = await tempDir("node-archive");
  const stem = NodePath.join(work, "node-vX");
  await NodeFSP.mkdir(NodePath.join(stem, "bin"), { recursive: true });
  const node = NodePath.join(stem, "bin", "node");
  await NodeFSP.writeFile(node, `#!/bin/sh\necho v${version}\n`, { mode: 0o755 });
  await NodeFSP.writeFile(NodePath.join(stem, "bin", "npx"), "#!/bin/sh\n", { mode: 0o755 });
  const archive = NodePath.join(work, "node.tar.gz");
  NodeChildProcess.execFileSync("tar", ["-czf", archive, "-C", work, "node-vX"]);
  return archive;
}

describe("toolPlatformKey", () => {
  it("names the pinned builds, and none for musl Linux or an unknown CPU", () => {
    expect(toolPlatformKey("darwin", "x64", false)).toBe("darwin-x64");
    expect(toolPlatformKey("win32", "arm64", false)).toBe("win32-arm64");
    expect(toolPlatformKey("linux", "x64", true)).toBe("linux-x64");
    expect(toolPlatformKey("linux", "x64", false)).toBeNull();
    expect(toolPlatformKey("freebsd", "x64", true)).toBeNull();
  });

  it("uses nodejs.org's own names and archive kinds", () => {
    expect(nodeDownload("win32-x64").file).toBe(`node-v${NODE_VERSION}-win-x64.zip`);
    expect(nodeDownload("darwin-x64").file).toBe(`node-v${NODE_VERSION}-darwin-x64.tar.gz`);
    expect(managedNodeDir("C:\\Users\\ada\\.specwithcode", "win32-x64")).toBe(
      `C:\\Users\\ada\\.specwithcode\\runtime\\node\\node-v${NODE_VERSION}-win-x64`,
    );
    expect(managedNodeDir("/home/ada/.specwithcode", "linux-x64")).toBe(
      `/home/ada/.specwithcode/runtime/node/node-v${NODE_VERSION}-linux-x64/bin`,
    );
    expect(managedGhDir("/home/ada/.specwithcode", "linux-arm64")).toBe(
      `/home/ada/.specwithcode/tools/gh/${GH_VERSION}/bin`,
    );
  });
});

describe("withPathDirs", () => {
  it("adds missing folders after the person's own, and leaves a complete PATH alone", () => {
    expect(withPathDirs("/usr/bin:/bin", ["/x/bin", "/bin"], "linux")).toBe("/usr/bin:/bin:/x/bin");
    expect(withPathDirs("/usr/bin:/x/bin", ["/x/bin"], "linux")).toBeUndefined();
    expect(withPathDirs("C:\\Tools", ["c:\\tools", "D:\\Node"], "win32")).toBe(
      "C:\\Tools;D:\\Node",
    );
  });
});

describe.runIf(posix)("checkMachineTools", () => {
  it("reports what is missing and what this machine can install", async () => {
    const home = await tempDir("machine-tools-home");
    const { host } = hostWith();
    const check = await checkMachineTools(context(host, home), "missing");
    expect(check).toMatchObject({ git: "missing", node: "missing", gh: "missing" });
    const key = toolPlatformKey(HOST_PLATFORM, HOST_ARCH, true);
    if (key !== null) expect(check.installable).toEqual(expect.arrayContaining(["node", "gh"]));
    // Git on a Mac comes from Apple's developer tools; on Linux it needs root.
    expect(check.installable.includes("git")).toBe(HOST_PLATFORM === "darwin");
  });

  it("counts a Node.js from a version manager or on PATH as present", async () => {
    const home = await tempDir("machine-tools-home");
    const nvm = await tempDir("nvm-bin");
    await NodeFSP.writeFile(NodePath.join(nvm, "node"), "#!/bin/sh\n", { mode: 0o755 });
    const { host } = hostWith();
    const fromManager = await checkMachineTools(
      { ...context(host, home), nodeManagerDirs: [nvm] },
      "present",
    );
    expect(fromManager.node).toBe("present");
    expect(fromManager.installable).not.toContain("node");
    const onPath = await checkMachineTools(context(hostWith({ path: nvm }).host, home), "present");
    expect(onPath.node).toBe("present");
  });

  it("says unknown for a Git check that gave no answer", async () => {
    const home = await tempDir("machine-tools-home");
    const check = await checkMachineTools(context(hostWith().host, home), undefined);
    expect(check.git).toBe("unknown");
    expect(check.installable).not.toContain("git");
  });
});

describe.runIf(posix && toolPlatformKey(HOST_PLATFORM, HOST_ARCH, true) !== null)(
  "installMachineTool",
  () => {
    const key = toolPlatformKey(HOST_PLATFORM, HOST_ARCH, true)!;

    it("unpacks Node.js into the app's home, checks it runs, and is then found", async () => {
      const home = await tempDir("machine-tools-home");
      const { host, downloads } = hostWith({ archive: await fakeNodeArchive(NODE_VERSION) });
      const lines: string[] = [];
      const outcome = await installMachineTool(context(host, home), "node", "present", (line) =>
        lines.push(line),
      );
      expect(downloads).toEqual([nodeDownload(key).url]);
      expect(outcome.pathDirs).toEqual([managedNodeDir(home, key)]);
      await NodeFSP.access(NodePath.join(managedNodeDir(home, key), "npx"));
      expect(lines.some((line) => line.includes("SHA-256"))).toBe(true);
      // Nothing is left behind: no staging folder and no download.
      expect(await NodeFSP.readdir(NodePath.join(home, "runtime", "node"))).toEqual([
        nodeDownload(key).stem,
      ]);
      expect(await NodeFSP.readdir(NodePath.join(home, "provision", "downloads"))).toEqual([]);
      // The folder is one the server puts on its PATH, so the next check finds it.
      expect(
        managedToolDirs({ home, platform: HOST_PLATFORM, arch: HOST_ARCH, glibc: true }),
      ).toContain(outcome.pathDirs[0]);
      const after = await checkMachineTools(context(hostWith().host, home), "present");
      expect(after.node).toBe("present");
    });

    it("refuses a build that does not report the pinned version and installs nothing", async () => {
      const home = await tempDir("machine-tools-home");
      const { host } = hostWith({ archive: await fakeNodeArchive("1.2.3") });
      await expect(
        installMachineTool(context(host, home), "node", "present", () => {}),
      ).rejects.toThrow(/does not run on this machine \(it reports 1\.2\.3\)/);
      await expect(NodeFSP.access(managedNodeDir(home, key))).rejects.toThrow();
    });

    it("never replaces a Node.js the machine already has", async () => {
      const home = await tempDir("machine-tools-home");
      const existing = await tempDir("homebrew-bin");
      await NodeFSP.writeFile(NodePath.join(existing, "node"), "#!/bin/sh\n", { mode: 0o755 });
      const { host, downloads } = hostWith({ path: existing });
      const refused = installMachineTool(context(host, home), "node", "present", () => {});
      await expect(refused).rejects.toBeInstanceOf(MachineToolInstallError);
      await expect(refused).rejects.toMatchObject({ code: "present" });
      expect(downloads).toEqual([]);
    });

    it("refuses a download whose SHA-256 differs from the pin", async () => {
      const home = await tempDir("machine-tools-home");
      const server = NodeHttp.createServer((_request, response) => response.end("not node"));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as { port: number }).port;
      try {
        const { host } = hostWith({
          env: { STUDIO_PROVISION_MIRROR_URL: `http://127.0.0.1:${port}` },
        });
        await expect(
          installMachineTool(context(host, home), "gh", "present", () => {}),
        ).rejects.toBeInstanceOf(ChecksumMismatchError);
        await expect(NodeFSP.access(managedGhDir(home, key))).rejects.toThrow();
      } finally {
        server.close();
      }
    });

    it("asks macOS for its developer tools for Git, and says the install goes on there", async () => {
      if (HOST_PLATFORM !== "darwin") return;
      const home = await tempDir("machine-tools-home");
      const ran: string[] = [];
      const { host } = hostWith({
        exec: async (command, args) => {
          ran.push([command, ...args].join(" "));
          return { code: 0, stdout: "", stderr: "" };
        },
      });
      const outcome = await installMachineTool(context(host, home), "git", "missing", () => {});
      expect(ran).toEqual(["/usr/bin/xcode-select --install"]);
      expect(outcome.handedOff).toBe(true);
    });

    it("says so, instead of waiting on a window, when macOS counts its tools as installed", async () => {
      if (HOST_PLATFORM !== "darwin") return;
      const home = await tempDir("machine-tools-home");
      const { host } = hostWith({
        exec: async () => ({
          code: 1,
          stdout: "",
          stderr:
            'xcode-select: error: command line tools are already installed, use "Software Update" to install updates',
        }),
      });
      await expect(
        installMachineTool(context(host, home), "git", "missing", () => {}),
      ).rejects.toMatchObject({ code: "failed" });
    });

    it("waits for a provisioning run that holds the machine", async () => {
      const home = await tempDir("machine-tools-home");
      await NodeFSP.mkdir(NodePath.join(home, "provision"), { recursive: true });
      // A live process other than this one: the test runner's parent.
      await NodeFSP.writeFile(NodePath.join(home, "provision", "run.lock"), `${process.ppid}\n`);
      const { host, downloads } = hostWith({ archive: await fakeNodeArchive(NODE_VERSION) });
      await expect(
        installMachineTool(context(host, home), "node", "present", () => {}),
      ).rejects.toMatchObject({ code: "busy" });
      expect(downloads).toEqual([]);
    });
  },
);

/** A Node.js on its own PATH folder with npm beside it, as nodejs.org lays it out. */
async function fakeNodeWithNpm(version: string) {
  const root = await tempDir("node-with-npm");
  await NodeFSP.mkdir(NodePath.join(root, "bin"), { recursive: true });
  await NodeFSP.mkdir(NodePath.join(root, "lib", "node_modules", "npm", "bin"), {
    recursive: true,
  });
  await NodeFSP.writeFile(NodePath.join(root, "bin", "node"), `#!/bin/sh\necho v${version}\n`, {
    mode: 0o755,
  });
  await NodeFSP.writeFile(
    NodePath.join(root, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    "",
  );
  return NodePath.join(root, "bin");
}

/** A `specweave` installed the way npm does: a bin link to the package's script. */
async function fakeSpecweave(version: string) {
  const prefix = await tempDir("specweave-prefix");
  const pkg = NodePath.join(prefix, "lib", "node_modules", "specweave");
  await NodeFSP.mkdir(NodePath.join(pkg, "bin"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(pkg, "package.json"), JSON.stringify({ version }));
  await NodeFSP.writeFile(NodePath.join(pkg, "bin", "specweave.js"), "#!/usr/bin/env node\n", {
    mode: 0o755,
  });
  await NodeFSP.mkdir(NodePath.join(prefix, "bin"));
  await NodeFSP.symlink(
    "../lib/node_modules/specweave/bin/specweave.js",
    NodePath.join(prefix, "bin", "specweave"),
  );
  return NodePath.join(prefix, "bin");
}

describe.runIf(posix)("machine readiness", () => {
  it("reports SpecWeave's version from its package and marks one older than SpecWithCode needs", async () => {
    const home = await tempDir("machine-tools-home");
    const bin = await fakeSpecweave("3.0.4");
    const check = await checkMachineTools(context(hostWith({ path: bin }).host, home), "present");
    const specweave = check.tools?.find((tool) => tool.tool === "specweave");
    expect(specweave).toMatchObject({
      presence: "present",
      version: "3.0.4",
      managed: false,
      outdated: true,
      // The person's own copy is never replaced.
      canInstall: false,
    });
    // An older client reads only the fields it knows; SpecWeave never enters `installable`.
    expect(check.installable).not.toContain("specweave");
  });

  it("offers SpecWeave when Node.js is there or the app can install it", async () => {
    const home = await tempDir("machine-tools-home");
    const node = await fakeNodeWithNpm(NODE_VERSION);
    const withNode = await checkMachineTools(
      context(hostWith({ path: node }).host, home),
      "present",
    );
    expect(withNode.tools?.find((tool) => tool.tool === "specweave")).toMatchObject({
      presence: "missing",
      canInstall: true,
    });
    expect(withNode.tools?.find((tool) => tool.tool === "node")).toMatchObject({
      presence: "present",
      version: NODE_VERSION,
      managed: false,
      outdated: false,
    });
  });

  it("marks a Node.js older than 20 as too old without offering to replace it", async () => {
    const home = await tempDir("machine-tools-home");
    const node = await fakeNodeWithNpm("18.19.0");
    const check = await checkMachineTools(context(hostWith({ path: node }).host, home), "present");
    expect(check.tools?.find((tool) => tool.tool === "node")).toMatchObject({
      outdated: true,
      managed: false,
      canInstall: false,
    });
  });

  it("keeps the app's older copy on the PATH until the current pin is installed", async () => {
    const home = await tempDir("machine-tools-home");
    const olderGh = NodePath.join(home, "tools", "gh", "2.90.0", "bin");
    await NodeFSP.mkdir(olderGh, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(olderGh, "gh"), "#!/bin/sh\necho gh version 2.90.0\n", {
      mode: 0o755,
    });
    const { host } = hostWith();
    const dirs = await existingManagedToolDirs(host, {
      home,
      platform: HOST_PLATFORM,
      arch: HOST_ARCH,
      glibc: true,
    });
    const key = toolPlatformKey(HOST_PLATFORM, HOST_ARCH, true);
    if (key === null) return;
    expect(dirs).toEqual([olderGh]);
    // On the PATH it is found, is the app's, and the current pin can replace it.
    const check = await checkMachineTools(
      context(hostWith({ path: olderGh }).host, home),
      "present",
    );
    expect(check.tools?.find((tool) => tool.tool === "gh")).toMatchObject({
      presence: "present",
      version: "2.90.0",
      managed: true,
      outdated: true,
      canInstall: true,
    });
    await NodeFSP.mkdir(managedGhDir(home, key), { recursive: true });
    expect(
      await existingManagedToolDirs(host, {
        home,
        platform: HOST_PLATFORM,
        arch: HOST_ARCH,
        glibc: true,
      }),
    ).toEqual([managedGhDir(home, key)]);
  });

  it("installs the pinned SpecWeave with npm into the app's folder and finds it after", async () => {
    const home = await tempDir("machine-tools-home");
    const node = await fakeNodeWithNpm(NODE_VERSION);
    const real = hostWith({ path: node }).host;
    const calls: Array<ReadonlyArray<string>> = [];
    const host: ProvisionHost = {
      ...real,
      exec: async (command, args, options) => {
        if (args[1] !== "install") return real.exec(command, args, options);
        calls.push(args);
        const staging = args[args.indexOf("--prefix") + 1]!;
        const pkg = NodePath.join(staging, "lib", "node_modules", "specweave");
        await NodeFSP.mkdir(NodePath.join(pkg, "bin"), { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(pkg, "package.json"),
          JSON.stringify({ version: SPECWEAVE_VERSION }),
        );
        await NodeFSP.writeFile(NodePath.join(pkg, "bin", "specweave.js"), "", { mode: 0o755 });
        await NodeFSP.mkdir(NodePath.join(staging, "bin"));
        await NodeFSP.symlink(
          "../lib/node_modules/specweave/bin/specweave.js",
          NodePath.join(staging, "bin", "specweave"),
        );
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const lines: string[] = [];
    const outcome = await installMachineTool(context(host, home), "specweave", "present", (line) =>
      lines.push(line),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(`specweave@${SPECWEAVE_VERSION}`);
    // npm's own script runs with the found Node.js; no npm.cmd and no shell.
    expect(calls[0]![0]).toMatch(/npm-cli\.js$/u);
    expect(outcome.pathDirs).toEqual([managedSpecweaveDir(home, HOST_PLATFORM)]);
    expect(await NodeFSP.readdir(NodePath.join(home, "tools", "specweave"))).toEqual([
      SPECWEAVE_VERSION,
    ]);
    const after = await checkMachineTools(
      context(hostWith({ path: `${node}:${outcome.pathDirs[0]}` }).host, home),
      "present",
    );
    expect(after.tools?.find((tool) => tool.tool === "specweave")).toMatchObject({
      presence: "present",
      version: SPECWEAVE_VERSION,
      managed: true,
      outdated: false,
    });
    expect(managedSpecweavePrefix(home, HOST_PLATFORM)).toBe(
      NodePath.join(home, "tools", "specweave", SPECWEAVE_VERSION),
    );
  });

  it("refuses SpecWeave without any Node.js and leaves nothing behind", async () => {
    const home = await tempDir("machine-tools-home");
    const error = await installMachineTool(
      context(hostWith().host, home),
      "specweave",
      "present",
      () => {},
    ).catch((caught: unknown) => caught);
    // Node.js can be installed by the app here, but SpecWeave waits for it.
    expect(error).toBeInstanceOf(MachineToolInstallError);
    expect((error as MachineToolInstallError).code).toBe("unsupported");
    await expect(NodeFSP.access(NodePath.join(home, "tools", "specweave"))).rejects.toThrow();
  });
});

// Downloads the real pinned builds and SpecWeave from npm. Off by default:
// STUDIO_MACHINE_TOOLS_LIVE=1 runs it (.github/workflows/machine-tools-live.yml on three OSes).
describe.runIf(process.env.STUDIO_MACHINE_TOOLS_LIVE === "1")("live pinned installs", () => {
  it("installs the real Node.js, GitHub CLI and SpecWeave into a new home and finds them", async () => {
    const home = await tempDir("machine-tools-live");
    const { host } = hostWith();
    const ctx = context(host, home);
    const lines: string[] = [];
    for (const tool of ["node", "gh", "specweave"] as const) {
      const outcome = await installMachineTool(ctx, tool, "present", (line) => lines.push(line));
      expect(outcome.handedOff).toBe(false);
    }
    const after = await checkMachineTools(
      { ...context(makeNodeProvisionHost({ env: { ...withoutPath(), PATH: "" } }), home) },
      "present",
    );
    expect(after.node).toBe("present");
    expect(after.gh).toBe("present");
    expect(after.tools?.find((tool) => tool.tool === "specweave")).toMatchObject({
      presence: "present",
      version: SPECWEAVE_VERSION,
      managed: true,
    });
    expect(after.tools?.find((tool) => tool.tool === "node")).toMatchObject({
      version: NODE_VERSION,
      managed: true,
      outdated: false,
    });
    expect(after.tools?.find((tool) => tool.tool === "gh")?.version).toBe(GH_VERSION);
    expect(lines.some((line) => line.startsWith("Downloading"))).toBe(true);
  }, 600_000);
});
