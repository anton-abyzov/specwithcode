// @effect-diagnostics nodeBuiltinImport:off - packaged-layout fixtures use a real private filesystem.
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { makeNodeProvisionHost } from "../provision/host.ts";
import { managedNodeDir, toolPlatformKey } from "./machineTools.ts";
import { prepareManagedVskill, VSKILL_VERSION } from "./vskillTool.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function fixture(fail = false) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "packaged-skills-"));
  roots.push(home);
  const key = toolPlatformKey(process.platform, process.arch, true)!;
  const bin = managedNodeDir(home, key);
  await fs.mkdir(bin, { recursive: true });
  const node = path.join(bin, process.platform === "win32" ? "node.exe" : "node");
  // A real executable in the app-owned layout. No developer npm or PATH is used.
  await fs.copyFile(process.execPath, node);
  await fs.chmod(node, 0o755);
  const npm = process.platform === "win32"
    ? path.join(bin, "node_modules/npm/bin/npm-cli.js")
    : path.join(bin, "../lib/node_modules/npm/bin/npm-cli.js");
  await fs.mkdir(path.dirname(npm), { recursive: true });
  await fs.writeFile(npm, `
const fs = require('node:fs'); const path = require('node:path');
if (${fail}) { console.error('fixture registry offline'); process.exit(1); }
const prefix = process.argv[process.argv.indexOf('--prefix') + 1];
if (!process.argv.includes('vskill@${VSKILL_VERSION}')) process.exit(2);
const win = process.platform === 'win32';
const pkg = path.join(prefix, ...(win ? [] : ['lib']), 'node_modules/vskill');
fs.mkdirSync(path.join(pkg, 'dist'), {recursive:true});
fs.writeFileSync(path.join(pkg,'package.json'), JSON.stringify({version:'${VSKILL_VERSION}'}));
fs.writeFileSync(path.join(pkg,'dist/bin.js'), 'console.log("fixture skill installed")');
const bin = win ? prefix : path.join(prefix,'bin'); fs.mkdirSync(bin,{recursive:true});
fs.writeFileSync(path.join(bin,win?'vskill.cmd':'vskill'), win?'@echo off\\r\\necho fixture skill installed\\r\\n':'#!/usr/bin/env node\\nconsole.log("fixture skill installed")\\n', {mode:0o755});
`);
  const host = makeNodeProvisionHost({ env: { ...process.env, HOME: home, PATH: "", Path: "" } });
  return { home, host, bin, npm };
}

describe("packaged Skills dependency", () => {
  it("prepares with empty PATH from private Node/npm and survives app upgrades without another install", async () => {
    const fx = await fixture();
    const prepared = await prepareManagedVskill({ ...fx, glibc: true });
    expect(prepared.nodeDir).toBe(fx.bin);
    expect(prepared.binary).toContain(path.join("tools", "vskill", VSKILL_VERSION));
    const run = await fx.host.exec(prepared.binary, ["--version"], { env: { PATH: [fx.bin, "/usr/bin", "/bin"].join(path.delimiter) } });
    if (process.platform !== "win32") expect(run.stdout).toContain("fixture skill installed");
    // The versioned app executable can be replaced; the private tool remains reusable offline.
    await fs.rm(fx.npm);
    expect(await prepareManagedVskill({ ...fx, glibc: true })).toEqual(prepared);
  });
  it("finds the older private Node layout while an upgrade's new pin is not installed", async () => {
    const fx = await fixture();
    const root = process.platform === "win32" ? fx.bin : path.dirname(fx.bin);
    const older = root.replace(/node-v\d+\.\d+\.\d+/, "node-v22.19.0");
    await fs.rename(root, older);
    const result = await prepareManagedVskill({ ...fx, glibc: true });
    expect(result.nodeDir).toContain("node-v22.19.0");
  });
  it("retains npm failure details and leaves no partial installed tool", async () => {
    const fx = await fixture(true);
    await expect(prepareManagedVskill({ ...fx, glibc: true })).rejects.toThrow("fixture registry offline");
    const prefix = path.join(fx.home, "tools/vskill", VSKILL_VERSION);
    await expect(fs.stat(prefix)).rejects.toThrow();
    await expect(fs.stat(`${prefix}.staging`)).rejects.toThrow();
  });
  it("reports missing runtime without attempting npm", async () => {
    const fx = await fixture();
    await fs.rm(path.join(fx.home, "runtime"), { recursive: true });
    await expect(prepareManagedVskill({ ...fx, glibc: true })).rejects.toThrow("Skills needs Node.js");
  });
});
