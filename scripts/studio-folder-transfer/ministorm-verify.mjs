#!/usr/bin/env node
// Mac -> Linux production folder-transfer acceptance, using isolated state only.
// Usage (Node 22): node ministorm-verify.mjs <absolute report directory> <real source repo>
// Optional: SWC_REMOTE_HOST=ministorm SWC_REMOTE_ROOT=/srv/work SWC_REMOTE_PORT=19449
// Bundles candidate code locally. SSH transports the harness and forwards HTTP;
// SourceTransfers/DestinationCopies move all project contents, never rsync/scp.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeRemoteFixture } from "./remote-fixture.mjs";

const [reportArgument, sourceArgument] = process.argv.slice(2);
assert.equal(process.versions.node.split(".")[0], "22", "Invoke this check with Node 22");
assert.ok(reportArgument && path.isAbsolute(reportArgument), "Pass an absolute report directory");
assert.ok(
  sourceArgument && path.isAbsolute(sourceArgument),
  "Pass an absolute real source repository",
);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let report = path.resolve(reportArgument);
assert.equal(
  await fs.lstat(report).then(
    () => true,
    () => false,
  ),
  false,
  "Use a new private report folder",
);
await fs.mkdir(report, { recursive: true, mode: 0o700 });
report = await fs.realpath(report); // /tmp is a symlink on macOS; private state uses canonical paths.
const local = path.join(report, "private");
await fs.mkdir(local, { mode: 0o700 });
const host = process.env.SWC_REMOTE_HOST ?? "ministorm";
assert.match(host, /^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/, "Use a configured SSH host, not shell options");
const remoteRoot = process.env.SWC_REMOTE_ROOT ?? "/srv/work";
assert.ok(path.posix.isAbsolute(remoteRoot));
const remote = path.posix.join(remoteRoot, `swc-copy-acceptance-${randomUUID()}`);
const remoteNode =
  process.env.SWC_REMOTE_NODE ??
  "/home/anton/.local/share/fnm/node-versions/v22.20.0/installation/bin/node";
const port = Number(process.env.SWC_REMOTE_PORT ?? "19449");
assert.ok(Number.isInteger(port) && port > 1024 && port < 65536);
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const sshArgs = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host];
const ssh = (command, input) =>
  execFileSync("ssh", [...sshArgs, command], {
    encoding: "utf8",
    input,
    maxBuffer: 32 << 20,
  });
const writeJson = (file, value) =>
  fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const put = (name, content) =>
  ssh(`umask 077; cat > ${quote(path.posix.join(remote, name))}`, content);
const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const getJson = (name) => JSON.parse(ssh(`cat ${quote(path.posix.join(remote, name))}`));
const started = Date.now();
let source;
let tunnel;
let sourceExit;
let destination;
let error;
let beforeHealth;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const health = () =>
  ssh(
    "ss -H -ltnp 'sport = :8319'; curl --max-time 5 -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8319/",
  ).trim();
const start = async (name, executable, args) => {
  const log = await fs.open(path.join(report, `${name}.log`), "w", 0o600);
  const child = spawn(executable, args, {
    cwd: repo,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", log.fd, log.fd],
  });
  await log.close();
  return child;
};
const waitForFile = async (file, child, timeout = 180_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (
      await fs.lstat(file).then(
        () => true,
        () => false,
      )
    )
      return;
    assert.equal(child.exitCode, null, `Worker exited ${child.exitCode}; inspect its log`);
    await pause(100);
  }
  throw new Error(`Timed out waiting for ${file}`);
};
const exited = (child) =>
  child.exitCode !== null
    ? Promise.resolve(child.exitCode)
    : new Promise((resolve) => child.once("exit", (code) => resolve(code)));
const stop = async (child) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return child?.exitCode;
  const result = exited(child);
  child.kill("SIGTERM"); // Exact child PID; never process-name/pattern termination.
  let timer;
  try {
    return await Promise.race([
      result,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          reject(new Error(`Owned child ${child.pid} did not stop in 60 seconds`));
        }, 60_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

try {
  const remoteFacts = ssh(
    `${quote(remoteNode)} -e ${quote("console.log(JSON.stringify({platform:process.platform,node:process.version,home:require('node:os').homedir()}))")}`,
  );
  assert.equal(JSON.parse(remoteFacts).platform, "linux");
  beforeHealth = health();
  // mkdir without -p is the ownership boundary: an existing remote directory refuses.
  ssh(`umask 077; mkdir ${quote(remote)}`);
  const fixture = await makeRemoteFixture(local, sourceArgument);
  await writeJson(path.join(report, "fixture.json"), fixture);
  const esbuildPath = path.join(repo, "node_modules/.pnpm/node_modules/esbuild/lib/main.js");
  const { build } = await import(esbuildPath);
  const bundle = path.join(local, "remote-worker.mjs");
  await build({
    entryPoints: [path.join(repo, "apps/server/scripts/folder-transfer-acceptance.ts")],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "bundle",
    sourcemap: false,
    logLevel: "silent",
    plugins: [
      {
        name: "candidate-workspace-packages",
        setup(build) {
          build.onResolve({ filter: /^@specweave-studio\// }, async ({ path: name }) => {
            const [, packageName, ...parts] = name.split("/");
            const directory = path.join(repo, "packages", packageName);
            const metadata = JSON.parse(
              await fs.readFile(path.join(directory, "package.json"), "utf8"),
            );
            const key = parts.length ? `./${parts.join("/")}` : ".";
            const entry = metadata.exports[key];
            return { path: path.join(directory, typeof entry === "string" ? entry : entry.import) };
          });
        },
      },
    ],
    banner: {
      js: "import {createRequire as __createRequire} from 'node:module';const require=__createRequire(import.meta.url);",
    },
  });
  const workerBytes = await fs.readFile(bundle);
  await writeJson(path.join(report, "candidate.json"), {
    commit: execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    bundleSha256: createHash("sha256").update(workerBytes).digest("hex"),
    remoteFacts: JSON.parse(remoteFacts),
    host,
    remote,
    transport: "production transfer classes over owned SSH reverse loopback tunnel",
    liveStoreUsed: false,
    coordinatorMoved: false,
  });
  const sourceConfig = {
    folder: fixture.root,
    stateRoot: path.join(local, "source-state"),
    expectedFile: path.join(local, "expected.json"),
    offerFile: path.join(local, "offer.json"),
    receiptFile: path.join(report, "source-receipt.json"),
  };
  await writeJson(path.join(local, "source-config.json"), sourceConfig);
  source = await start("source", process.execPath, [
    bundle,
    "source",
    path.join(local, "source-config.json"),
  ]);
  await waitForFile(sourceConfig.offerFile, source);
  const offer = await readJson(sourceConfig.offerFile);
  tunnel = await start("tunnel", "ssh", [
    "-N",
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=15",
    "-R",
    `127.0.0.1:${port}:127.0.0.1:${offer.port}`,
    host,
  ]);
  // Probe the tunnel without the grant: 404 still proves the owned HTTP server answers.
  let connected = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    assert.equal(tunnel.exitCode, null, "SSH forward failed; inspect tunnel.log");
    try {
      connected =
        ssh(`curl --max-time 2 -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}/`) ===
        "404";
    } catch {
      /* The SSH listener is not ready yet. */
    }
    if (connected) break;
    await pause(100);
  }
  assert.ok(connected, "Remote tunnel never answered");
  put("remote-worker.mjs", workerBytes);
  put("offer.json", await fs.readFile(sourceConfig.offerFile));
  put("expected.json", await fs.readFile(sourceConfig.expectedFile));
  const destinationConfig = {
    offerFile: `${remote}/offer.json`,
    expectedFile: `${remote}/expected.json`,
    stateRoot: `${remote}/state`,
    targetFolder: `${remote}/specweave-umb`,
    port,
    receiptFile: `${remote}/destination-receipt.json`,
    // Exercise the user-facing home path too, with canonical private state.
    linuxCaseTarget: process.env.SWC_REMOTE_CASE_TARGET_ROOT
      ? path.posix.join(
          process.env.SWC_REMOTE_CASE_TARGET_ROOT,
          path.posix.basename(remote),
          "linux-case-target",
        )
      : undefined,
  };
  put("destination-config.json", JSON.stringify(destinationConfig));
  destination = await start("destination", "ssh", [
    ...sshArgs,
    `${quote(remoteNode)} ${quote(`${remote}/remote-worker.mjs`)} destination ${quote(`${remote}/destination-config.json`)}`,
  ]);
  const destinationExit = await exited(destination);
  assert.equal(destinationExit, 0, "Remote destination failed; inspect destination.log");
  await writeJson(
    path.join(report, "destination-receipt.json"),
    getJson("destination-receipt.json"),
  );
} catch (cause) {
  error = cause instanceof Error ? cause.message : String(cause);
} finally {
  try {
    sourceExit = await stop(source);
  } catch (cause) {
    error ??= String(cause);
  }
  try {
    await stop(tunnel);
  } catch (cause) {
    error ??= String(cause);
  }
  // No detached remote workers: SSH is awaited; failure retains the isolated files for inspection.
  const afterHealth = beforeHealth === undefined ? null : health();
  let sourceReceipt = null;
  let destinationReceipt = null;
  try {
    sourceReceipt = await readJson(path.join(report, "source-receipt.json"));
  } catch {}
  try {
    destinationReceipt = await readJson(path.join(report, "destination-receipt.json"));
  } catch {}
  const liveServiceUnchanged = beforeHealth === afterHealth;
  const passed =
    !error &&
    sourceExit === 0 &&
    sourceReceipt?.sourceUnchanged === true &&
    destinationReceipt?.passed === true &&
    liveServiceUnchanged;
  const receipt = {
    passed,
    elapsedMs: Date.now() - started,
    error: error ?? null,
    sourceExit,
    liveServiceUnchanged,
    beforeHealth,
    afterHealth,
    report,
    remote,
    source: sourceReceipt,
    destination: destinationReceipt,
  };
  if (passed) {
    // Both were exclusively created by this invocation; retain only small, token-free receipts.
    ssh(
      `${quote(remoteNode)} -e ${quote("require('node:fs').rmSync(process.argv[1],{recursive:true,force:false})")} ${quote(remote)}`,
    );
    await fs.rm(local, { recursive: true });
  }
  await writeJson(path.join(report, "receipt.json"), { ...receipt, temporaryDataRemoved: passed });
  console.log(
    JSON.stringify({ passed, report: path.join(report, "receipt.json"), error: receipt.error }),
  );
  process.exitCode = passed ? 0 : 1;
}
