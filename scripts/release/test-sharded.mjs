#!/usr/bin/env node
// Runs the server suite as N shard processes at once, split by WeightedShardSequencer's
// recorded file times, and exits non-zero when any shard fails.
//
//   node scripts/release/test-sharded.mjs --shards 3 --out DIR [--changed SHA] [-- FILTER...]
//   pnpm run test:server:sharded -- --shards 3 --out DIR [-- FILTER...]
//
// Each shard runs `vp test run --shard i/N` in apps/server with its own TMPDIR, CI=1,
// GIT_CONFIG_GLOBAL=/dev/null and GIT_CONFIG_NOSYSTEM=1 (the hygiene verify-release.mjs uses,
// so personal git hooks and aliases cannot change a fixture), and writes
//   DIR/server-<i>.log    the default reporter's output
//   DIR/server-<i>.json   the JSON reporter's output, for scripts/update-test-shard-weights.ts
//   DIR/shards.json       per-shard exit code, wall seconds, test files and failed files
// The server config keeps fileParallelism off, so each shard still runs one file at a time.
//
// --changed SHA   run only the files vitest's module graph ties to changes since SHA; a change
//                 to a package.json or vite config makes vitest run everything
// --timeout-minutes N   stop a shard that runs longer (default 60)
// -- FILTER...    extra vitest arguments, for example test file filters
//
// A shard that gets no files passes; a full run (no --changed) in which no shard ran a test
// file fails. Shard TMPDIRs are short directories under the system temporary directory,
// because long paths overflow the 104-byte limit on unix socket paths, and are removed after.
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const server = join(root, "apps/server");

export function parseArgs(argv) {
  const options = {
    shards: 3,
    out: undefined,
    changed: undefined,
    timeoutMinutes: 60,
    filters: [],
  };
  // pnpm run passes the `--` of `pnpm run test:server:sharded -- <options>` through; a
  // leading one is that, not the start of the vitest filters.
  for (let i = argv[0] === "--" ? 1 : 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value`);
      i += 1;
      return next;
    };
    if (arg === "--") {
      options.filters = argv.slice(i + 1);
      break;
    } else if (arg === "--shards") options.shards = Number(value());
    else if (arg === "--out") options.out = value();
    else if (arg === "--changed") options.changed = value();
    else if (arg === "--timeout-minutes") options.timeoutMinutes = Number(value());
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option ${arg}`);
  }
  if (options.help) return options;
  if (!Number.isInteger(options.shards) || options.shards < 1 || options.shards > 6)
    throw new Error("--shards must be an integer from 1 to 6");
  if (!(options.timeoutMinutes > 0)) throw new Error("--timeout-minutes must be positive");
  if (!options.out) throw new Error("--out DIR is required");
  if (options.changed !== undefined && !/^[\w./~^@{}-]+$/.test(options.changed))
    throw new Error("--changed takes a commit, such as a sha or origin/main");
  return options;
}

/** Test files and failed files from one shard's vitest JSON report, relative to apps/server. */
export function readShardReport(file, serverRoot = server) {
  if (!existsSync(file)) return { files: 0, failedFiles: [], tests: 0, failedTests: 0 };
  const report = JSON.parse(readFileSync(file, "utf8"));
  const results = report.testResults ?? [];
  return {
    files: results.length,
    failedFiles: results
      .filter((result) => result.status === "failed")
      .map((result) => relative(serverRoot, result.name).replaceAll("\\", "/")),
    tests: report.numTotalTests ?? 0,
    failedTests: report.numFailedTests ?? 0,
  };
}

/** Pass or fail for the whole run, and why. */
export function verdict(shards, { changed }) {
  const failed = shards.filter((shard) => shard.exitCode !== 0 || shard.timedOut);
  if (failed.length > 0)
    return { ok: false, reason: `shard ${failed.map((shard) => shard.index).join(", ")} failed` };
  const files = shards.reduce((sum, shard) => sum + shard.files, 0);
  if (files === 0 && changed === undefined)
    return { ok: false, reason: "no shard ran a test file" };
  return { ok: true, reason: files === 0 ? "no test file is affected by the changes" : "passed" };
}

// Each shard leads a process group of its own, so stopping it also stops the vitest workers it
// forked; a signal to the shard's leader alone leaves them running tests into a removed TMPDIR.
const detached = process.platform !== "win32";
function signalShard(child, signal) {
  try {
    if (detached) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // The shard and every process it started have already exited.
  }
}

function runShard(index, options, out) {
  const tmp = mkdtempSync(join(tmpdir(), `sws${index}-`));
  const log = join(out, `server-${index}.log`);
  const report = join(out, `server-${index}.json`);
  rmSync(report, { force: true });
  const argv = [
    join(root, "node_modules/vite-plus/bin/vp"),
    "test",
    "run",
    "--shard",
    `${index}/${options.shards}`,
    "--passWithNoTests",
    "--reporter=default",
    "--reporter=json",
    `--outputFile=${report}`,
    ...(options.changed === undefined ? [] : ["--changed", options.changed]),
    ...options.filters,
  ];
  const env = {
    ...process.env,
    CI: "1",
    TMPDIR: tmp,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    PWDEBUG: "0",
    PLAYWRIGHT_HTML_OPEN: "never",
    STUDIO_TEST_NODE: process.execPath,
  };
  const began = Date.now();
  return new Promise((done) => {
    // The shard writes straight to its log, so a killed or crashed shard still leaves one.
    const fd = openSync(log, "w");
    const child = spawn(process.execPath, argv, {
      cwd: server,
      env,
      stdio: ["ignore", fd, fd],
      detached,
    });
    children.add(child);
    let timedOut = false;
    let escalation;
    const timer = setTimeout(() => {
      timedOut = true;
      signalShard(child, "SIGTERM");
      escalation = setTimeout(() => signalShard(child, "SIGKILL"), 15000);
    }, options.timeoutMinutes * 60000);
    const finish = (exitCode, signal, error) => {
      clearTimeout(timer);
      clearTimeout(escalation);
      children.delete(child);
      // Whatever the shard left in its group (workers of a killed shard) goes with it.
      if (child.pid !== undefined) signalShard(child, "SIGKILL");
      closeSync(fd);
      if (error) writeFileSync(log, `\n${error.stack ?? error}\n`, { flag: "a" });
      writeFileSync(join(out, `server-${index}.exit`), `${exitCode ?? 1}\n`);
      try {
        rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (cleanup) {
        // A leftover temporary directory must not cost the run its summary.
        writeFileSync(log, `\ntest-sharded.mjs: could not remove ${tmp}: ${cleanup}\n`, {
          flag: "a",
        });
      }
      if (stopping !== null && children.size === 0) process.exit(stopping);
      done({
        index,
        exitCode: exitCode ?? 1,
        signal: signal ?? null,
        timedOut,
        seconds: Math.round((Date.now() - began) / 100) / 10,
        log,
        report,
        ...readShardReport(report),
      });
    };
    child.once("error", (error) => finish(1, null, error));
    child.once("close", (exitCode, signal) => finish(exitCode, signal));
  });
}

const children = new Set();
// The exit code once a signal asked the run to stop: it ends after every shard has closed and
// removed its TMPDIR, or 15 seconds later with the stragglers killed.
let stopping = null;

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`test-sharded.mjs: ${error.message} (see --help)`);
    process.exit(2);
  }
  if (options.help) {
    const text = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n");
    console.log(
      text
        .slice(
          1,
          text.findIndex((line, i) => i > 0 && !line.startsWith("//")),
        )
        .map((line) => line.replace(/^\/\/ ?/, ""))
        .join("\n"),
    );
    return;
  }
  if (!existsSync(join(root, "node_modules/vite-plus/bin/vp")))
    throw new Error("Install dependencies first: node_modules/vite-plus is missing");
  const out = resolve(options.out);
  mkdirSync(out, { recursive: true });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
    process.once(signal, () => {
      if (stopping !== null) return;
      stopping = signal === "SIGINT" ? 130 : 143;
      if (children.size === 0) process.exit(stopping);
      for (const child of children) signalShard(child, "SIGTERM");
      setTimeout(() => {
        for (const child of children) signalShard(child, "SIGKILL");
        process.exit(stopping);
      }, 15000).unref();
    });

  const began = Date.now();
  console.log(
    `Running the server suite as ${options.shards} shards` +
      (options.changed ? ` (changed since ${options.changed})` : "") +
      `; logs in ${out}`,
  );
  const shards = await Promise.all(
    Array.from({ length: options.shards }, (_, i) => runShard(i + 1, options, out)),
  );
  const result = verdict(shards, options);
  const summary = {
    shards,
    changed: options.changed ?? null,
    filters: options.filters,
    wallSeconds: Math.round((Date.now() - began) / 100) / 10,
    ok: result.ok,
    reason: result.reason,
    failedFiles: shards.flatMap((shard) => shard.failedFiles),
  };
  writeFileSync(join(out, "shards.json"), `${JSON.stringify(summary, null, 2)}\n`);

  console.log("SHARD  EXIT  SECONDS  FILES  TESTS  FAILED");
  for (const shard of shards)
    console.log(
      [
        String(shard.index).padEnd(5),
        String(shard.timedOut ? "T/O" : shard.exitCode).padEnd(4),
        String(shard.seconds).padStart(7),
        String(shard.files).padStart(5),
        String(shard.tests).padStart(6),
        String(shard.failedTests).padStart(7),
      ].join("  "),
    );
  for (const file of summary.failedFiles) console.log(`failed: ${file}`);
  for (const shard of shards.filter((item) => item.exitCode !== 0 && item.files === 0))
    console.log(`shard ${shard.index} failed before any test file ran; see ${shard.log}`);
  console.log(`Server shards: ${result.reason} in ${summary.wallSeconds}s`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack ?? String(error));
    process.exit(1);
  });
}
