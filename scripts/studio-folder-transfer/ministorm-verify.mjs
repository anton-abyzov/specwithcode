#!/usr/bin/env node
// Mac -> Linux production folder-transfer acceptance, using isolated state only.
// Usage (Node 22): node ministorm-verify.mjs <absolute report directory> <real source repo>
// Optional: SWC_REMOTE_HOST=ministorm SWC_REMOTE_ROOT=/srv/work SWC_REMOTE_PORT=19449
// Bundles candidate code locally. SSH transports the harness and forwards HTTP;
// SourceTransfers/DestinationCopies move all project contents, never rsync/scp.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { makeRemoteFixture } from "./remote-fixture.mjs";

const [reportArgument, sourceArgument] = process.argv.slice(2);
NodeAssert.equal(process.versions.node.split(".")[0], "22", "Invoke this check with Node 22");
NodeAssert.ok(
  reportArgument && NodePath.isAbsolute(reportArgument),
  "Pass an absolute report directory",
);
NodeAssert.ok(
  sourceArgument && NodePath.isAbsolute(sourceArgument),
  "Pass an absolute real source repository",
);
const repo = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../..");
let report = NodePath.resolve(reportArgument);
NodeAssert.equal(
  await NodeFSP.lstat(report).then(
    () => true,
    () => false,
  ),
  false,
  "Use a new private report folder",
);
await NodeFSP.mkdir(report, { recursive: true, mode: 0o700 });
report = await NodeFSP.realpath(report); // /tmp is a symlink on macOS; private state uses canonical paths.
const local = NodePath.join(report, "private");
await NodeFSP.mkdir(local, { mode: 0o700 });
const host = process.env.SWC_REMOTE_HOST ?? "ministorm";
NodeAssert.match(
  host,
  /^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/,
  "Use a configured SSH host, not shell options",
);
const remoteRoot = process.env.SWC_REMOTE_ROOT ?? "/srv/work";
NodeAssert.ok(NodePath.posix.isAbsolute(remoteRoot));
const remote = NodePath.posix.join(remoteRoot, `swc-copy-acceptance-${NodeCrypto.randomUUID()}`);
const remoteNode =
  process.env.SWC_REMOTE_NODE ??
  "/home/anton/.local/share/fnm/node-versions/v22.20.0/installation/bin/node";
const port = Number(process.env.SWC_REMOTE_PORT ?? "19449");
NodeAssert.ok(Number.isInteger(port) && port > 1024 && port < 65536);
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const sshArgs = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host];
const ssh = (command, input) =>
  NodeChildProcess.execFileSync("ssh", [...sshArgs, command], {
    encoding: "utf8",
    input,
    maxBuffer: 32 << 20,
  });
const writeJson = (file, value) =>
  NodeFSP.writeFile(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const put = (name, content) =>
  ssh(`umask 077; cat > ${quote(NodePath.posix.join(remote, name))}`, content);
const readJson = async (file) => JSON.parse(await NodeFSP.readFile(file, "utf8"));
const getJson = (name) => JSON.parse(ssh(`cat ${quote(NodePath.posix.join(remote, name))}`));
const started = Date.now();
const liveSource = process.env.SWC_REMOTE_SOURCE_MODE === "live";
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
  const log = await NodeFSP.open(NodePath.join(report, `${name}.log`), "w", 0o600);
  const child = NodeChildProcess.spawn(executable, args, {
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
      await NodeFSP.lstat(file).then(
        () => true,
        () => false,
      )
    )
      return;
    NodeAssert.equal(child.exitCode, null, `Worker exited ${child.exitCode}; inspect its log`);
    await pause(100);
  }
  throw new Error(`Timed out waiting for ${file}`);
};
const exited = (child) =>
  child.exitCode !== null
    ? Promise.resolve(child.exitCode)
    : new Promise((resolve) => child.once("exit", (code) => resolve(code)));
const stop = async (child, timeoutMs = 60_000) => {
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
          reject(new Error(`Owned child ${child.pid} did not stop in ${timeoutMs / 1000} seconds`));
        }, timeoutMs);
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
  NodeAssert.equal(JSON.parse(remoteFacts).platform, "linux");
  beforeHealth = health();
  // mkdir without -p is the ownership boundary: an existing remote directory refuses.
  ssh(`umask 077; mkdir ${quote(remote)}`);
  const fixture = liveSource
    ? { root: await NodeFSP.realpath(sourceArgument), sourceRepository: sourceArgument }
    : await makeRemoteFixture(local, sourceArgument);
  if (!liveSource && process.env.SWC_REMOTE_SOURCE_MODE === "external-worktree")
    fixture.root = NodePath.join(fixture.root, "worktrees/specweave-wip");
  await writeJson(NodePath.join(report, "fixture.json"), fixture);
  const esbuildPath = NodePath.join(repo, "node_modules/.pnpm/node_modules/esbuild/lib/main.js");
  const { build } = await import(esbuildPath);
  const bundle = NodePath.join(local, "remote-worker.mjs");
  await build({
    entryPoints: [NodePath.join(repo, "apps/server/scripts/folder-transfer-acceptance.ts")],
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
            const directory = NodePath.join(repo, "packages", packageName);
            const metadata = JSON.parse(
              await NodeFSP.readFile(NodePath.join(directory, "package.json"), "utf8"),
            );
            const key = parts.length ? `./${parts.join("/")}` : ".";
            const entry = metadata.exports[key];
            return {
              path: NodePath.join(directory, typeof entry === "string" ? entry : entry.import),
            };
          });
        },
      },
    ],
    banner: {
      js: "import {createRequire as __createRequire} from 'node:module';const require=__createRequire(import.meta.url);",
    },
  });
  const workerBytes = await NodeFSP.readFile(bundle);
  const productionDirectory = "apps/server/src/fleet/folderTransfer";
  const provenanceFiles = [
    ...(await NodeFSP.readdir(NodePath.join(repo, productionDirectory)))
      .filter(
        (name) => name.endsWith(".ts") && !name.includes(".test") && !name.includes("testkit"),
      )
      .map((name) => `${productionDirectory}/${name}`),
    "apps/server/scripts/folder-transfer-acceptance.ts",
    "apps/server/scripts/folder-transfer-consolidation.ts",
    "scripts/studio-folder-transfer/ministorm-verify.mjs",
    "scripts/studio-folder-transfer/remote-fixture.mjs",
  ];
  const sourceSha256 = Object.fromEntries(
    await Promise.all(
      provenanceFiles.map(async (name) => [
        name,
        NodeCrypto.createHash("sha256")
          .update(await NodeFSP.readFile(NodePath.join(repo, name)))
          .digest("hex"),
      ]),
    ),
  );
  await writeJson(NodePath.join(report, "candidate.json"), {
    commit: NodeChildProcess.execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    bundleSha256: NodeCrypto.createHash("sha256").update(workerBytes).digest("hex"),
    sourceSha256,
    invocation: {
      executable: process.execPath,
      arguments: process.argv.slice(1),
      sourceMode: process.env.SWC_REMOTE_SOURCE_MODE ?? "dirty-umbrella",
      remotePort: port,
    },
    startedAt: new Date(started).toISOString(),
    remoteFacts: JSON.parse(remoteFacts),
    host,
    remote,
    transport: "production transfer classes over owned SSH reverse loopback tunnel",
    liveStoreUsed: false,
    coordinatorMoved: false,
  });
  const sourceConfig = {
    folder: fixture.root,
    stateRoot: NodePath.join(local, "source-state"),
    expectedFile: NodePath.join(local, "expected.json"),
    offerFile: NodePath.join(local, "offer.json"),
    receiptFile: NodePath.join(report, "source-receipt.json"),
    liveSource,
    exerciseScenarios: !liveSource,
  };
  await writeJson(NodePath.join(local, "source-config.json"), sourceConfig);
  source = await start("source", process.execPath, [
    bundle,
    "source",
    NodePath.join(local, "source-config.json"),
  ]);
  await waitForFile(sourceConfig.offerFile, source, liveSource ? 900_000 : 180_000);
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
    NodeAssert.equal(tunnel.exitCode, null, "SSH forward failed; inspect tunnel.log");
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
  NodeAssert.ok(connected, "Remote tunnel never answered");
  put("remote-worker.mjs", workerBytes);
  put("offer.json", await NodeFSP.readFile(sourceConfig.offerFile));
  put("expected.json", await NodeFSP.readFile(sourceConfig.expectedFile));
  const destinationConfig = {
    offerFile: `${remote}/offer.json`,
    expectedFile: `${remote}/expected.json`,
    stateRoot: `${remote}/state`,
    targetFolder: `${remote}/specweave-umb`,
    port,
    receiptFile: `${remote}/destination-receipt.json`,
    liveSource,
    // Exercise the user-facing home path too, with canonical private state.
    linuxCaseTarget: process.env.SWC_REMOTE_CASE_TARGET_ROOT
      ? NodePath.posix.join(
          process.env.SWC_REMOTE_CASE_TARGET_ROOT,
          NodePath.posix.basename(remote),
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
  NodeAssert.equal(destinationExit, 0, "Remote destination failed; inspect destination.log");
  await writeJson(
    NodePath.join(report, "destination-receipt.json"),
    getJson("destination-receipt.json"),
  );
} catch (cause) {
  error = cause instanceof Error ? cause.message : String(cause);
} finally {
  try {
    sourceExit = await stop(source, liveSource ? 300_000 : 60_000);
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
    sourceReceipt = await readJson(NodePath.join(report, "source-receipt.json"));
  } catch {}
  try {
    destinationReceipt = await readJson(NodePath.join(report, "destination-receipt.json"));
  } catch {}
  const liveServiceUnchanged = beforeHealth === afterHealth;
  const passed =
    !error &&
    sourceExit === 0 &&
    (sourceReceipt?.sourceUnchanged === true ||
      (liveSource && sourceReceipt?.sourceReadOnly === true)) &&
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
    await NodeFSP.rm(local, { recursive: true });
  }
  await writeJson(NodePath.join(report, "receipt.json"), {
    ...receipt,
    temporaryDataRemoved: passed,
  });
  console.log(
    JSON.stringify({ passed, report: NodePath.join(report, "receipt.json"), error: receipt.error }),
  );
  process.exitCode = passed ? 0 : 1;
}
