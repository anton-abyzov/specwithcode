// @effect-diagnostics nodeBuiltinImport:off - packaged-layout fixtures use a real private filesystem.
import { CommandResolutionCache } from "@specweave-studio/shared/shell";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Layer from "effect/Layer";
import { ProjectId, type ProjectSkillsSnapshot } from "@specweave-studio/contracts";
import { makeSkillInstallRuntime } from "../project/SkillUpdateRpc.ts";
import { makeSkillUpdates } from "../project/SkillUpdate.ts";
import * as ProcessRunner from "../processRunner.ts";
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { makeNodeProvisionHost } from "../provision/host.ts";
import { managedNodeDir, toolPlatformKey } from "./machineTools.ts";
import { prepareManagedVskill, VSKILL_VERSION } from "./vskillTool.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

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
  const npm =
    process.platform === "win32"
      ? path.join(bin, "node_modules/npm/bin/npm-cli.js")
      : path.join(bin, "../lib/node_modules/npm/bin/npm-cli.js");
  await fs.mkdir(path.dirname(npm), { recursive: true });
  await fs.writeFile(
    npm,
    `
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
`,
  );
  const host = makeNodeProvisionHost({ env: { ...process.env, HOME: home, PATH: "", Path: "" } });
  const runner = await Effect.runPromise(
    ProcessRunner.make().pipe(Effect.provide(NodeServices.layer)),
  );
  const runNpm: Parameters<typeof prepareManagedVskill>[0]["runNpm"] = async (
    command,
    args,
    options,
  ) => {
    const result = await Effect.runPromise(
      runner.run({
        command,
        args,
        env: { ...host.env, ...options?.env },
        timeout: options?.timeoutMs,
        timeoutBehavior: "timedOutResult",
        forceKillAfter: 1_000,
      }),
    );
    return {
      code: result.code === null ? null : Number(result.code),
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };
  return { home, host, bin, npm, runNpm };
}

describe("packaged Skills dependency", () => {
  it("prepares with empty PATH from private Node/npm and survives app upgrades without another install", async () => {
    const fx = await fixture();
    const prepared = await prepareManagedVskill({ ...fx, glibc: true });
    expect(prepared.nodeDir).toBe(fx.bin);
    expect(prepared.binary).toContain(path.join("tools", "vskill", VSKILL_VERSION));
    const run = await fx.runNpm(prepared.binary, ["--version"], {
      env: { PATH: [fx.bin, "/usr/bin", "/bin"].join(path.delimiter) },
    });
    expect(run.stdout).toContain("fixture skill installed");
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
    await expect(prepareManagedVskill({ ...fx, glibc: true })).rejects.toThrow(
      "fixture registry offline",
    );
    const prefix = path.join(fx.home, "tools/vskill", VSKILL_VERSION);
    await expect(fs.stat(prefix)).rejects.toThrow();
    await expect(fs.stat(`${prefix}.staging`)).rejects.toThrow();
  });
  it("reports missing runtime without attempting npm", async () => {
    const fx = await fixture();
    await fs.rm(path.join(fx.home, "runtime"), { recursive: true });
    await expect(prepareManagedVskill({ ...fx, glibc: true })).rejects.toThrow(
      "Skills needs Node.js",
    );
  });
});

it("resolves Windows node.exe without treating drive colons as separators", async () => {
  const fx = await fixture();
  const home = "C:\\App Home";
  const bin = managedNodeDir(home, "win32-x64");
  const host = {
    ...fx.host,
    platform: "win32",
    arch: "x64",
    env: { PATH: "D:\\Other;C:\\Windows" },
    exists: async (file: string) => file === bin,
    isExecutable: async (file: string) => file === path.win32.join(bin, "node.exe"),
    realPath: async (file: string) => file,
    listDir: async () => [],
  };
  // Reaching npm discovery proves node.exe was resolved from the packaged Windows layout.
  await expect(prepareManagedVskill({ ...fx, host, home, glibc: false })).rejects.toThrow(
    "could not find npm beside Node.js",
  );
});

it("releases the same-process lock even if final staging cleanup fails", async () => {
  const fx = await fixture(true);
  let removals = 0;
  const host = {
    ...fx.host,
    remove: async (file: string) => {
      if (file.endsWith(".staging") && ++removals === 2) throw new Error("fixture cleanup denied");
      await fx.host.remove(file);
    },
  };
  await expect(prepareManagedVskill({ ...fx, host, glibc: true })).rejects.toThrow(
    /fixture registry offline[\s\S]*fixture cleanup denied/,
  );
  // Retry reaches npm instead of a permanently held in-process lock.
  await expect(prepareManagedVskill({ ...fx, glibc: true })).rejects.toThrow(
    "fixture registry offline",
  );
});

it("bounds a descendant holding npm pipes and allows a later retry", async () => {
  const fx = await fixture();
  const original = await fs.readFile(fx.npm, "utf8");
  await fs.writeFile(
    fx.npm,
    `require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},2000)'],{stdio:['ignore',1,2]}); setTimeout(()=>process.exit(0),10);`,
  );
  const started = await Effect.runPromise(Clock.currentTimeMillis);
  const runNpm: typeof fx.runNpm = (command, args, options) =>
    fx.runNpm(command, args, { ...options, timeoutMs: 150 });
  await expect(prepareManagedVskill({ ...fx, runNpm, glibc: true })).rejects.toThrow();
  expect((await Effect.runPromise(Clock.currentTimeMillis)) - started).toBeLessThan(1500);
  await fs.writeFile(fx.npm, original);
  await expect(prepareManagedVskill({ ...fx, glibc: true })).resolves.toHaveProperty("binary");
});

it("force-kills an npm leader ignoring SIGTERM and releases the lock for retry", async () => {
  const fx = await fixture();
  const original = await fs.readFile(fx.npm, "utf8");
  const pidFile = path.join(fx.home, "npm.pid");
  await fs.writeFile(
    fx.npm,
    `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setTimeout(()=>process.exit(0),8000);`,
  );
  const started = await Effect.runPromise(Clock.currentTimeMillis);
  const runNpm: typeof fx.runNpm = (command, args, options) =>
    fx.runNpm(command, args, { ...options, timeoutMs: 2000 });
  await expect(prepareManagedVskill({ ...fx, runNpm, glibc: true })).rejects.toThrow();
  expect((await Effect.runPromise(Clock.currentTimeMillis)) - started).toBeLessThan(5000);
  const pid = Number(await fs.readFile(pidFile, "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
  await fs.writeFile(fx.npm, original);
  await expect(prepareManagedVskill({ ...fx, glibc: true })).resolves.toHaveProperty("binary");
});

it("the Settings install path bootstraps from packaged Node, installs a missing skill, and status never acquires software", async () => {
  const fx = await fixture();
  const sha = "a".repeat(64),
    commit = "b".repeat(40);
  const sourcePath = "skills/sample/SKILL.md";
  const lock = {
    version: 1,
    skills: {
      sample: {
        version: "1.0.0",
        sha,
        source: "github:owner/repo",
        sourceRepoUrl: "https://github.com/owner/repo",
        sourceSkillPath: sourcePath,
        sourceBranch: "main",
        sourceCommitSha: commit,
      },
    },
  };
  const cli = `const fs=require('node:fs'),path=require('node:path');
if(fs.existsSync(path.join(process.env.HOME,'hang-cli'))){process.on('SIGTERM',()=>{});fs.writeFileSync(path.join(process.env.HOME,'cli.pid'),String(process.pid));setTimeout(()=>process.exit(0),8000);}else{
if(process.argv[2]==='--version'){console.log('${VSKILL_VERSION}');process.exit(0);}
if(process.argv[2]!=='install')process.exit(3);
const root=path.join(process.env.HOME,'.agents');fs.mkdirSync(path.join(root,'skills/sample'),{recursive:true});
fs.writeFileSync(path.join(root,'vskill.lock'),${JSON.stringify(JSON.stringify(lock))});
fs.writeFileSync(path.join(root,'skills/sample/SKILL.md'),'---\\nname: sample\\n---\\nSynthetic skill');}`;
  const npm = `const fs=require('node:fs'),path=require('node:path');
const prefix=process.argv[process.argv.indexOf('--prefix')+1],win=process.platform==='win32';
const pkg=path.join(prefix,...(win?[]:['lib']),'node_modules/vskill');fs.mkdirSync(path.join(pkg,'dist'),{recursive:true});
fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({version:'${VSKILL_VERSION}'}));
fs.writeFileSync(path.join(pkg,'dist/bin.js'),${JSON.stringify(cli)});
const bin=win?prefix:path.join(prefix,'bin');fs.mkdirSync(bin,{recursive:true});
fs.writeFileSync(path.join(bin,win?'vskill.cmd':'vskill'),win?${JSON.stringify('@echo off\r\nnode "%~dp0node_modules\\vskill\\dist\\bin.js" %*\r\n')}:${JSON.stringify("#!/usr/bin/env node\n" + cli)},{mode:0o755});`;
  await fs.writeFile(fx.npm, npm);
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const installer = yield* makeSkillInstallRuntime({
        home: fx.home,
        baseDir: fx.home,
        platform: process.platform,
        environment: { HOME: fx.home, PATH: "" },
        host: fx.host,
      });
      const source = {
        name: "sample",
        path: sourcePath,
        plugin: null,
        version: "1.0.0",
        commit,
        contentHash: sha,
      };
      const snapshot = {
        cwd: fx.home,
        checkedAt: "2026-11-19T00:00:00Z",
        rows: [],
        providers: [],
        locks: [],
        doctor: "unavailable",
      } as ProjectSkillsSnapshot;
      const service = yield* makeSkillUpdates({
        home: fx.home,
        environment: { HOME: fx.home, PATH: "" },
        readSnapshot: () => Effect.succeed(snapshot),
        resolveCwd: () => Effect.succeed(fx.home),
        invalidate: () => Effect.void,
        rescanOpenFolders: () => Effect.void,
        sources: {
          connected: () =>
            Effect.succeed([
              {
                repo: "owner/repo",
                visibility: "public",
                connectedAt: "2026-11-19T00:00:00Z",
                checkedAt: "2026-11-19T00:00:00Z",
                state: "ok",
                commit,
                skills: [source],
              },
            ]),
          readSkill: () =>
            Effect.succeed({ state: "ok", visibility: "public", branch: "main", skill: source }),
        },
        ...installer,
        run: (request) => installer.run({ ...request, timeout: 2000 }),
      });
      const projectId = ProjectId.make("packaged-install");
      yield* service.update({ projectId, userLevel: true, operation: "status" });
      yield* Effect.promise(async () => {
        await expect(fs.stat(path.join(fx.home, "tools/vskill"))).rejects.toThrow();
      });
      yield* Effect.promise(() => fs.writeFile(path.join(fx.home, "hang-cli"), "1"));
      const started = yield* Clock.currentTimeMillis;
      const failed = yield* service.update({
        projectId,
        userLevel: true,
        operation: "install",
        install: { repo: "owner/repo", skill: "sample" },
      });
      expect(failed.outcomes?.[0]).toMatchObject({
        outcome: "failed",
        message: "vskill version check did not finish in time. Try again.",
      });
      expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(5000);
      yield* Effect.promise(async () => {
        const pid = Number(await fs.readFile(path.join(fx.home, "cli.pid"), "utf8"));
        expect(() => process.kill(pid, 0)).toThrow();
        await fs.rm(path.join(fx.home, "hang-cli"));
      });
      return yield* service.update({
        projectId,
        userLevel: true,
        operation: "install",
        install: { repo: "owner/repo", skill: "sample" },
      });
    }).pipe(Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
  );
  expect(result.outcomes?.[0], JSON.stringify(result)).toMatchObject({
    outcome: "installed",
    after: { version: "1.0.0", commit, contentHash: sha },
  });
  expect(await fs.readFile(path.join(fx.home, ".agents/skills/sample/SKILL.md"), "utf8")).toContain(
    "Synthetic skill",
  );
});

it("keeps external Node selection after a managed install in the same runtime", async () => {
  const fx = await fixture();
  const externalDir = path.join(fx.home, "external");
  await fs.mkdir(externalDir);
  const shimDir = path.join(fx.home, ".local", "bin");
  await fs.mkdir(shimDir, { recursive: true });
  const env = { HOME: fx.home, PATH: externalDir };
  await Effect.runPromise(
    Effect.gen(function* () {
      const installer = yield* makeSkillInstallRuntime({
        home: fx.home,
        baseDir: fx.home,
        platform: process.platform,
        environment: env,
        host: fx.host,
      });
      const managed = yield* installer.findVskill;
      expect(managed).toContain("tools");
      yield* Effect.promise(async () => {
        const node = path.join(externalDir, process.platform === "win32" ? "node.exe" : "node");
        await fs.copyFile(process.execPath, node);
        await fs.chmod(node, 0o755);
        const cli = "console.log(process.execPath)";
        await fs.writeFile(path.join(shimDir, "cli.js"), cli);
        const shim =
          process.platform === "win32"
            ? '@echo off\r\nnode "%~dp0cli.js" %*\r\n'
            : "#!/usr/bin/env node\n" + cli;
        await fs.writeFile(
          path.join(shimDir, process.platform === "win32" ? "vskill.cmd" : "vskill"),
          shim,
          { mode: 0o755 },
        );
      });
      // Simulate expiry of the shared 30-second negative lookup cache.
      (yield* CommandResolutionCache).clear();
      const external = yield* installer.findVskill;
      expect(external).toContain(shimDir);
      const output = yield* installer.run({
        command: external!,
        args: ["--version"],
        cwd: fx.home,
        timeout: 5000,
        env,
      });
      expect(output.exitCode).toBe(0);
      expect(output.stdout.trim()).toBe(
        yield* Effect.promise(() =>
          fs.realpath(path.join(externalDir, process.platform === "win32" ? "node.exe" : "node")),
        ),
      );
    }).pipe(Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
  );
});
