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
import { GH_VERSION, NODE_VERSION, nodeDownload } from "../provision/manifest.ts";
import {
  checkMachineTools,
  installMachineTool,
  MachineToolInstallError,
  managedGhDir,
  managedNodeDir,
  managedToolDirs,
  toolPlatformKey,
  withPathDirs,
  type MachineToolsContext,
} from "./machineTools.ts";

// oxlint-disable-next-line studio/no-global-process-runtime -- the tests install for the machine they run on.
const HOST_PLATFORM = process.platform;
// oxlint-disable-next-line studio/no-global-process-runtime -- as above.
const HOST_ARCH = process.arch;
const posix = HOST_PLATFORM !== "win32";
const tempDir = (name: string) => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), `${name}-`));

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
    env: { ...process.env, PATH: input.path ?? "", ...input.env },
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

// Downloads the real pinned builds. Off by default: STUDIO_MACHINE_TOOLS_LIVE=1 runs it.
describe.runIf(posix && process.env.STUDIO_MACHINE_TOOLS_LIVE === "1")(
  "live pinned installs",
  () => {
    it("installs the real Node.js and GitHub CLI into a new home and finds them", async () => {
      const home = await tempDir("machine-tools-live");
      const { host } = hostWith();
      const ctx = context(host, home);
      const lines: string[] = [];
      for (const tool of ["node", "gh"] as const) {
        const outcome = await installMachineTool(ctx, tool, "present", (line) => lines.push(line));
        expect(outcome.handedOff).toBe(false);
      }
      const after = await checkMachineTools(
        { ...context(makeNodeProvisionHost({ env: { ...process.env, PATH: "" } }), home) },
        "present",
      );
      expect(after.node).toBe("present");
      expect(after.gh).toBe("present");
      console.log(lines.join("\n"));
    }, 300_000);
  },
);
