#!/usr/bin/env node
// Runs the server suite as N shard processes at once, split by WeightedShardSequencer's
// recorded file times, and exits non-zero when any shard fails.
//
//   node scripts/release/test-sharded.mjs --shards 3 --out DIR [--changed SHA] [-- FILTER...]
//   node scripts/release/test-sharded.mjs --shards 6 --run 1,2 --out DIR [--changed SHA]
//   node scripts/release/test-sharded.mjs --merge DIR...
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
// --run I,J       run only these of the --shards (up to 12), for a suite split across CI jobs;
//                 shards.json is then partial, and only --merge of every job's DIR judges the
//                 no-file and changed-test-file checks
// --merge DIR...  read each DIR/shards.json (one per job), print the combined table and verdict
// -- FILTER...    extra vitest arguments, for example test file filters
//
// A shard that gets no files passes; a full run (no --changed) in which no shard ran a test
// file fails. Shard TMPDIRs are short directories under the system temporary directory,
// because long paths overflow the 104-byte limit on unix socket paths, and are removed after.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../..");
const server = NodePath.join(root, "apps/server");

export function parseArgs(argv) {
  const options = {
    shards: 3,
    out: undefined,
    changed: undefined,
    timeoutMinutes: 60,
    filters: [],
  };
  let run;
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
    else if (arg === "--run") run = value();
    else if (arg === "--merge") {
      options.merge = argv.slice(i + 1);
      break;
    }
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option ${arg}`);
  }
  if (options.help) return options;
  if (options.merge !== undefined) {
    if (options.merge.length === 0) throw new Error("--merge needs at least one DIR");
    return { merge: options.merge };
  }
  const most = run === undefined ? 6 : 12;
  if (!Number.isInteger(options.shards) || options.shards < 1 || options.shards > most)
    throw new Error(`--shards must be an integer from 1 to ${most}`);
  if (run !== undefined) {
    const picked = run.split(",").map(Number);
    if (
      picked.some((index) => !Number.isInteger(index) || index < 1 || index > options.shards) ||
      new Set(picked).size !== picked.length
    )
      throw new Error(`--run takes distinct shard numbers from 1 to ${options.shards}, such as 1,2`);
    options.run = picked;
  }
  if (!(options.timeoutMinutes > 0)) throw new Error("--timeout-minutes must be positive");
  if (!options.out) throw new Error("--out DIR is required");
  if (options.changed !== undefined && !/^[\w./~^@{}-]+$/.test(options.changed))
    throw new Error("--changed takes a commit, such as a sha or origin/main");
  return options;
}

/** Test files and failed files from one shard's vitest JSON report, relative to apps/server. */
export function readShardReport(file, serverRoot = server) {
  if (!NodeFS.existsSync(file))
    return { files: 0, failedFiles: [], failures: [], tests: 0, failedTests: 0 };
  const report = JSON.parse(NodeFS.readFileSync(file, "utf8"));
  const results = report.testResults ?? [];
  const relative = (name) => NodePath.relative(serverRoot, name).replaceAll("\\", "/");
  const failed = results.filter((result) => result.status === "failed");
  return {
    files: results.length,
    failedFiles: failed.map((result) => relative(result.name)),
    // Each failed test with the first line of its error, so a run whose logs stay on the
    // machine (a hosted release runner) still says what broke.
    failures: failed.flatMap((result) =>
      (result.assertionResults ?? [])
        .filter((test) => test.status === "failed")
        .map((test) => ({
          file: relative(result.name),
          test: test.fullName ?? test.title ?? "",
          message: (test.failureMessages?.[0] ?? result.message ?? "").split("\n")[0].slice(0, 300),
        })),
    ),
    tests: report.numTotalTests ?? 0,
    failedTests: report.numFailedTests ?? 0,
  };
}

/** Pass or fail for the whole run, and why. */
export function verdict(shards, { changed, changedTestFiles = [], partial = false }) {
  const failed = shards.filter((shard) => shard.exitCode !== 0 || shard.timedOut);
  if (failed.length > 0)
    return { ok: false, reason: `shard ${failed.map((shard) => shard.index).join(", ")} failed` };
  // Another job ran the other shards: only --merge sees whether any shard ran a file.
  if (partial) return { ok: true, reason: "passed (partial; --merge judges the whole run)" };
  const files = shards.reduce((sum, shard) => sum + shard.files, 0);
  if (files === 0 && changed === undefined)
    return { ok: false, reason: "no shard ran a test file" };
  if (files === 0 && changedTestFiles.length > 0)
    return { ok: false, reason: "no shard ran a changed server test file" };
  return { ok: true, reason: files === 0 ? "no test file is affected by the changes" : "passed" };
}

/** One verdict for a suite split across jobs: every job's shards.json, each from --run. */
export function mergeSummaries(summaries) {
  const shards = summaries
    .flatMap((summary) => summary.shards ?? [])
    .toSorted((a, b) => a.index - b.index);
  const total = summaries[0]?.total ?? shards.length;
  const missing = Array.from({ length: total }, (_, i) => i + 1).filter(
    (index) => !shards.some((shard) => shard.index === index),
  );
  const changed = summaries[0]?.changed ?? undefined;
  const changedTestFiles = summaries[0]?.changedTestFiles ?? [];
  const result =
    missing.length > 0
      ? { ok: false, reason: `no result for shard ${missing.join(", ")}` }
      : verdict(shards, { changed: changed ?? undefined, changedTestFiles });
  return {
    shards,
    total,
    changed: changed ?? null,
    changedTestFiles,
    ok: result.ok,
    reason: result.reason,
    failedFiles: shards.flatMap((shard) => shard.failedFiles ?? []),
  };
}

function printTable(shards) {
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
}

// Each shard leads a process group of its own, so stopping it also stops the vitest workers it
// forked; a signal to the shard's leader alone leaves them running tests into a removed TMPDIR.
// oxlint-disable-next-line studio/no-global-process-runtime -- Standalone runner has no Effect runtime.
const detached = NodeOS.platform() !== "win32";
function signalShard(child, signal) {
  try {
    if (detached) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // The shard and every process it started have already exited.
  }
}

function runShard(index, options, out) {
  const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `sws${index}-`));
  const log = NodePath.join(out, `server-${index}.log`);
  const report = NodePath.join(out, `server-${index}.json`);
  NodeFS.rmSync(report, { force: true });
  const argv = [
    NodePath.join(root, "node_modules/vite-plus/bin/vp"),
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
    const fd = NodeFS.openSync(log, "w");
    const child = NodeChildProcess.spawn(process.execPath, argv, {
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
      NodeFS.closeSync(fd);
      if (error) NodeFS.writeFileSync(log, `\n${error.stack ?? error}\n`, { flag: "a" });
      NodeFS.writeFileSync(NodePath.join(out, `server-${index}.exit`), `${exitCode ?? 1}\n`);
      try {
        NodeFS.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (cleanup) {
        // A leftover temporary directory must not cost the run its summary.
        NodeFS.writeFileSync(log, `\ntest-sharded.mjs: could not remove ${tmp}: ${cleanup}\n`, {
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
    const text = NodeFS.readFileSync(NodeURL.fileURLToPath(import.meta.url), "utf8").split("\n");
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
  if (options.merge !== undefined) {
    const summaries = options.merge.map((dir) => {
      const file = NodePath.join(dir, "shards.json");
      if (!NodeFS.existsSync(file)) throw new Error(`${file} is missing; did that job run?`);
      return JSON.parse(NodeFS.readFileSync(file, "utf8"));
    });
    const merged = mergeSummaries(summaries);
    printTable(merged.shards);
    for (const file of merged.failedFiles) console.log(`failed: ${file}`);
    console.log(`Server shards: ${merged.reason}`);
    if (!merged.ok) process.exitCode = 1;
    return;
  }
  if (!NodeFS.existsSync(NodePath.join(root, "node_modules/vite-plus/bin/vp")))
    throw new Error("Install dependencies first: node_modules/vite-plus is missing");
  const out = NodePath.resolve(options.out);
  NodeFS.mkdirSync(out, { recursive: true });
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
  const indices = options.run ?? Array.from({ length: options.shards }, (_, i) => i + 1);
  console.log(
    `Running the server suite as ${options.shards} shards` +
      (options.run ? ` (this job: ${options.run.join(", ")})` : "") +
      (options.changed ? ` (changed since ${options.changed})` : "") +
      `; logs in ${out}`,
  );
  const shards = await Promise.all(indices.map((index) => runShard(index, options, out)));
  const changedTestFiles =
    options.changed === undefined
      ? []
      : NodeChildProcess.execFileSync(
          "git",
          ["diff", "--name-only", "--diff-filter=ACMR", options.changed, "--", "apps/server"],
          { cwd: root, encoding: "utf8" },
        )
          .split("\n")
          .filter((file) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(file));
  const partial = options.run !== undefined;
  const result = verdict(shards, { ...options, changedTestFiles, partial });
  const summary = {
    shards,
    total: options.shards,
    partial,
    changed: options.changed ?? null,
    changedTestFiles,
    filters: options.filters,
    wallSeconds: Math.round((Date.now() - began) / 100) / 10,
    ok: result.ok,
    reason: result.reason,
    failedFiles: shards.flatMap((shard) => shard.failedFiles),
  };
  NodeFS.writeFileSync(NodePath.join(out, "shards.json"), `${JSON.stringify(summary, null, 2)}\n`);

  printTable(shards);
  for (const file of summary.failedFiles) console.log(`failed: ${file}`);
  for (const failure of shards.flatMap((shard) => shard.failures))
    console.log(`  ${failure.file} > ${failure.test}: ${failure.message}`);
  for (const shard of shards.filter((item) => item.exitCode !== 0 && item.files === 0))
    console.log(`shard ${shard.index} failed before any test file ran; see ${shard.log}`);
  console.log(`Server shards: ${result.reason} in ${summary.wallSeconds}s`);
  if (!result.ok) process.exitCode = 1;
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.stack ?? String(error));
    process.exit(1);
  });
}
