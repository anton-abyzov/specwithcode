// @effect-diagnostics nodeBuiltinImport:off - provisioning I/O is wrapped at the RPC boundary.
import * as NodePath from "node:path";
import type { ProvisionHost } from "../provision/host.ts";
import { acquireProvisionLock } from "../provision/runner.ts";
import { existingManagedToolDirs } from "./machineTools.ts";
import { npmCliFor } from "./specweaveTool.ts";

/** App-owned dependency, independent of the user's global npm prefix and app release. */
export const VSKILL_VERSION = "1.2.18";
export interface PreparedVskill {
  readonly binary: string;
  readonly nodeDir: string;
}

/** Called only by an explicit Skills action, never by inventory/background discovery. */
export async function prepareManagedVskill(input: {
  readonly host: ProvisionHost;
  readonly home: string;
  readonly glibc: boolean;
  /** Bounded platform runner, supplied by the live RPC boundary. */
  readonly runNpm: ProvisionHost["exec"];
}): Promise<PreparedVskill> {
  const { host, home } = input;
  const windows = host.platform === "win32";
  const path = windows ? NodePath.win32 : NodePath.posix;
  const dirs = await existingManagedToolDirs(host, {
    home, platform: host.platform, arch: host.arch, glibc: input.glibc,
  });
  const pathKey = Object.keys(host.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const searchDirs = [...dirs, ...(host.env[pathKey] ?? "").split(windows ? ";" : ":")]
    .map((dir) => dir.replace(/^"(.*)"$/, "$1"))
    .filter((dir) => path.isAbsolute(dir));
  const locate = async (name: string) => {
    for (const dir of searchDirs) {
      const candidate = path.join(dir, name);
      if (await host.isExecutable(candidate)) return candidate;
    }
    return null;
  };
  const node = await locate(windows ? "node.exe" : "node");
  if (node === null) throw new Error("Skills needs Node.js. Install Node.js in Settings > Machine setup, then try again.");
  const nodeDir = path.dirname(node);
  const existing = await locate(windows ? "vskill.cmd" : "vskill");
  if (existing !== null) return { binary: existing, nodeDir };
  const prefix = path.join(home, "tools", "vskill", VSKILL_VERSION);
  const commandAt = (root: string) => windows ? path.join(root, "vskill.cmd") : path.join(root, "bin", "vskill");
  const packageAt = (root: string) => path.join(root, ...(windows ? [] : ["lib"]), "node_modules", "vskill");
  const valid = async (root: string) => {
    try {
      const manifest = JSON.parse(await host.readText(path.join(packageAt(root), "package.json")) ?? "null");
      return manifest?.version === VSKILL_VERSION && await host.isExecutable(commandAt(root)) && await host.exists(path.join(packageAt(root), "dist", "bin.js"));
    } catch { return false; }
  };
  if (await valid(prefix)) return { binary: commandAt(prefix), nodeDir };
  const npm = await npmCliFor(host, node);
  if (npm === null) throw new Error("Skills could not find npm beside Node.js. Repair Node.js in Settings > Machine setup, then try again.");
  await host.mkdirp(path.dirname(prefix));
  const release = await acquireProvisionLock(host, path.join(path.dirname(prefix), "install.lock"));
  if (release === null) throw new Error("The Skills installer is already being prepared. Try again when it finishes.");
  const staging = `${prefix}.staging`;
  try {
    if (await valid(prefix)) return { binary: commandAt(prefix), nodeDir };
    await host.remove(staging);
    await host.mkdirp(staging);
    const result = await input.runNpm(node, [npm, "install", "--global", "--prefix", staging,
      "--no-audit", "--no-fund", "--bin-links=true", "--loglevel=error", `vskill@${VSKILL_VERSION}`], {
      timeoutMs: 120_000,
      env: { [pathKey]: [nodeDir, host.env[pathKey] ?? "", ...(windows ? [] : ["/usr/bin", "/bin"])].filter(Boolean).join(windows ? ";" : ":") },
    });
    if (result.code !== 0) throw new Error(`Could not prepare the Skills installer: ${`${result.stderr}\n${result.stdout}`.trim().slice(-600) || "npm failed or timed out"}`);
    if (!(await valid(staging))) throw new Error("npm did not produce a complete Skills installer. Try again.");
    await host.remove(prefix);
    await host.rename(staging, prefix);
    return { binary: commandAt(prefix), nodeDir };
  } finally {
    try { await host.remove(staging); }
    finally { await release(); }
  }
}
