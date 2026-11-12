// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - real processes contend for a real lock file; their order is read from wall-clock times they write.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";

import {
  acquireHeavyCheckLock,
  HEAVY_CHECK_EXIT_WAIT_TIMEOUT,
  HEAVY_CHECK_LOCK_ID_ENV,
  type HeavyCheckPaths,
  heavyCheckPaths,
  type HeavyCheckRecord,
  holderAlive,
  parseWaitTimeout,
  processStartTime,
  readHolder,
  readQueue,
  releaseHeavyCheckLock,
  runUnderHeavyCheckGate,
  systemProcessProbe,
  tryAcquireHeavyCheckLock,
} from "./heavyCheckLock.ts";

const MODULE = NodeURL.fileURLToPath(new URL("./heavyCheckLock.ts", import.meta.url));

/** A separate process that runs a command under the gate, as the CLI does. */
const RUNNER = `
import { pathToFileURL } from "node:url";
const [modulePath, dir, label, timeout, ...command] = process.argv.slice(2);
const gate = await import(pathToFileURL(modulePath).href);
const result = await gate.runUnderHeavyCheckGate({
  paths: gate.heavyCheckPaths(dir),
  label,
  command,
  pollMs: 20,
  progressMs: 150,
  waitTimeoutMs: timeout === "none" ? undefined : Number(timeout),
  log: (line) => process.stderr.write(line + "\\n"),
});
process.exit(result.exitCode);
`;

/** Appends "start NAME TIME", stays busy for MS, appends "end NAME TIME". */
const WORK = `
const fs = require("node:fs");
const [log, name, ms] = process.argv.slice(1);
fs.appendFileSync(log, "start " + name + " " + Date.now() + "\\n");
setTimeout(() => fs.appendFileSync(log, "end " + name + " " + Date.now() + "\\n"), Number(ms));
`;

let root: string;
let paths: HeavyCheckPaths;
let log: string;
let runner: string;
const started: Array<NodeChildProcess.ChildProcess> = [];

beforeEach(() => {
  root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "heavy-checks-")));
  paths = heavyCheckPaths(NodePath.join(root, "locks"));
  log = NodePath.join(root, "work.log");
  runner = NodePath.join(root, "runner.mjs");
  NodeFS.writeFileSync(runner, RUNNER);
  NodeFS.writeFileSync(log, "");
});

afterEach(() => {
  for (const child of started.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
  NodeFS.rmSync(root, { recursive: true, force: true });
});

interface Finished {
  readonly code: number | null;
  readonly stderr: string;
}

function gateProcess(
  label: string,
  command: ReadonlyArray<string>,
  options: { readonly timeout?: number; readonly env?: NodeJS.ProcessEnv } = {},
): { readonly child: NodeChildProcess.ChildProcess; readonly done: Promise<Finished> } {
  const child = NodeChildProcess.spawn(
    process.execPath,
    [runner, MODULE, paths.dir, label, String(options.timeout ?? "none"), ...command],
    { stdio: ["ignore", "ignore", "pipe"], env: options.env ?? process.env },
  );
  started.push(child);
  let stderr = "";
  child.stderr!.on("data", (chunk) => (stderr += String(chunk)));
  return {
    child,
    done: new Promise((resolve) => child.once("exit", (code) => resolve({ code, stderr }))),
  };
}

const work = (name: string, ms: number) => [process.execPath, "-e", WORK, log, name, String(ms)];

async function until(what: string, check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function events(): ReadonlyArray<{ kind: string; name: string; at: number }> {
  return NodeFS.readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [kind, name, at] = line.split(" ");
      return { kind: kind!, name: name!, at: Number(at) };
    });
}

const at = (kind: string, name: string) =>
  events().find((event) => event.kind === kind && event.name === name)!.at;

/** A lock record for a process that is not this test. */
function writeLock(record: Partial<HeavyCheckRecord>): HeavyCheckRecord {
  const full: HeavyCheckRecord = {
    id: "held-by-someone",
    pid: process.pid,
    startedAt: processStartTime(process.pid),
    host: NodeOS.hostname(),
    label: "someone else",
    command: ["pnpm", "test"],
    cwd: "/work/elsewhere",
    threadId: "thread-9",
    acquiredAt: new Date().toISOString(),
    ...record,
  };
  NodeFS.mkdirSync(paths.dir, { recursive: true });
  NodeFS.writeFileSync(paths.lockFile, JSON.stringify(full));
  return full;
}

/** The PID of a process that has already exited. */
function exitedPid(): number {
  const child = NodeChildProcess.spawnSync(process.execPath, ["-e", ""]);
  return child.pid;
}

describe("heavy-check gate", () => {
  it("starts the second command only after the first has exited, and says who it waits for", async () => {
    const first = gateProcess("first suite", work("a", 500));
    await until("the first to hold the gate", () => readHolder(paths)?.childPid !== undefined);
    const holder = readHolder(paths)!;
    assert.strictEqual(holder.label, "first suite");
    assert.strictEqual(holder.pid, first.child.pid);
    assert.strictEqual(holder.startedAt, processStartTime(first.child.pid!));
    assert.strictEqual(holder.host, NodeOS.hostname());
    assert.deepStrictEqual(holder.command.slice(-3), [log, "a", "500"]);
    assert.isFalse(Number.isNaN(Date.parse(holder.acquiredAt)));

    const second = gateProcess("second suite", work("b", 50));
    const [a, b] = await Promise.all([first.done, second.done]);
    assert.strictEqual(a.code, 0);
    assert.strictEqual(b.code, 0);
    assert.isAtLeast(at("start", "b"), at("end", "a"));
    assert.include(b.stderr, "waiting for the heavy-check gate, held by first suite");
    assert.include(b.stderr, `PID ${first.child.pid}`);
    assert.include(b.stderr, `since ${holder.acquiredAt}`);
    assert.include(b.stderr, "still waiting after");
    assert.isNull(readHolder(paths));
    assert.lengthOf(readQueue(paths), 0);
  });

  it("serves three callers in arrival order, one at a time", async () => {
    const first = gateProcess("a", work("a", 600));
    await until("a to hold the gate", () => readHolder(paths) !== null);
    const second = gateProcess("b", work("b", 150));
    await until("b to queue", () => readQueue(paths).length === 1);
    // The late caller's own start-up is quicker than b's wait, and it still goes last.
    const third = gateProcess("c", work("c", 10));
    await until("c to queue", () => readQueue(paths).length === 2);
    assert.deepStrictEqual(
      readQueue(paths).map((ticket) => ticket.label),
      ["b", "c"],
    );
    const results = await Promise.all([first.done, second.done, third.done]);
    assert.deepStrictEqual(
      results.map((result) => result.code),
      [0, 0, 0],
    );
    assert.deepStrictEqual(
      events().map((event) => `${event.kind} ${event.name}`),
      ["start a", "end a", "start b", "end b", "start c", "end c"],
    );
  });

  it("returns the command's exit code and frees the gate", async () => {
    const result = await runUnderHeavyCheckGate({
      paths,
      command: [process.execPath, "-e", "process.exit(7)"],
      stdio: "ignore",
    });
    assert.deepStrictEqual(result, { exitCode: 7, signal: null, nested: false, timedOut: false });
    assert.isNull(readHolder(paths));
  });

  it("takes over the lock of a holder whose process is gone", async () => {
    writeLock({ pid: exitedPid(), startedAt: null });
    const acquired = await acquireHeavyCheckLock({ paths, command: ["x"], waitTimeoutMs: 5_000 });
    assert.strictEqual(acquired.status, "acquired");
    assert.strictEqual(readHolder(paths)?.pid, process.pid);
  });

  it("takes over when the holder's PID now belongs to another process", async () => {
    // This test's own PID is running, but it did not start when the record says.
    const stale = writeLock({ startedAt: "Thu Jan 1 00:00:00 1970" });
    const probe = { ...systemProcessProbe, startTimeOf: () => "Wed Nov 11 21:00:00 2026" };
    assert.isFalse(holderAlive(stale, probe));
    const acquired = await acquireHeavyCheckLock({
      paths,
      command: ["x"],
      waitTimeoutMs: 5_000,
      probe,
    });
    assert.strictEqual(acquired.status, "acquired");
    assert.notStrictEqual(readHolder(paths)?.id, stale.id);
  });

  it("keeps a lock whose holder exited while the command it started still runs", async () => {
    const command = NodeChildProcess.spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
    started.push(command);
    await until("the command to start", () => command.pid !== undefined);
    const record = writeLock({
      pid: exitedPid(),
      startedAt: null,
      childPid: command.pid!,
      childStartedAt: processStartTime(command.pid!),
    });
    assert.isTrue(holderAlive(record));
    const waiting = await acquireHeavyCheckLock({
      paths,
      command: ["x"],
      waitTimeoutMs: 150,
      pollMs: 20,
    });
    assert.strictEqual(waiting.status, "timeout");
    command.kill("SIGKILL");
    await until("the command to exit", () => command.exitCode !== null || command.killed);
    const acquired = await acquireHeavyCheckLock({
      paths,
      command: ["x"],
      waitTimeoutMs: 5_000,
      pollMs: 20,
    });
    assert.strictEqual(acquired.status, "acquired");
  });

  it("gives up after --wait-timeout with its own exit code and does not run the command", async () => {
    const holder = writeLock({});
    const lines: Array<string> = [];
    const marker = NodePath.join(root, "ran");
    const result = await runUnderHeavyCheckGate({
      paths,
      command: [
        process.execPath,
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "")`,
      ],
      waitTimeoutMs: 200,
      pollMs: 20,
      log: (line) => lines.push(line),
    });
    assert.strictEqual(result.exitCode, HEAVY_CHECK_EXIT_WAIT_TIMEOUT);
    assert.isTrue(result.timedOut);
    assert.isFalse(NodeFS.existsSync(marker));
    assert.include(lines[0], "held by someone else");
    assert.include(lines[0], "thread thread-9");
    assert.include(lines.at(-1), "The command did not run.");
    // The live holder's lock is untouched, and the caller left the queue.
    assert.strictEqual(readHolder(paths)?.id, holder.id);
    assert.lengthOf(readQueue(paths), 0);
  });

  it("runs a nested call directly instead of waiting for its own gate", async () => {
    const inner = [
      process.execPath,
      runner,
      MODULE,
      paths.dir,
      "inner",
      "2000",
      ...work("inner", 10),
    ];
    const result = await runUnderHeavyCheckGate({ paths, command: inner, stdio: "ignore" });
    assert.strictEqual(result.exitCode, 0);
    assert.deepStrictEqual(
      events().map((event) => `${event.kind} ${event.name}`),
      ["start inner", "end inner"],
    );
    // A lock id left in the environment by an earlier gate does not open this one.
    writeLock({});
    const stale = await runUnderHeavyCheckGate({
      paths,
      command: [process.execPath, "-e", ""],
      env: { ...process.env, [HEAVY_CHECK_LOCK_ID_ENV]: "an-older-gate" },
      waitTimeoutMs: 100,
      pollMs: 20,
    });
    assert.isTrue(stale.timedOut);
  });

  // oxlint-disable-next-line studio/no-global-process-runtime -- picks which tests run; no Effect runtime yet.
  it.skipIf(process.platform === "win32")(
    "passes a signal to the command and frees the gate",
    async () => {
      const holder = gateProcess("long suite", [
        process.execPath,
        "-e",
        "setTimeout(() => {}, 60000)",
      ]);
      await until("the command to start", () => readHolder(paths)?.childPid !== undefined);
      const commandPid = readHolder(paths)!.childPid!;
      holder.child.kill("SIGTERM");
      const finished = await holder.done;
      assert.strictEqual(finished.code, 128 + NodeOS.constants.signals.SIGTERM);
      assert.isNull(readHolder(paths));
      assert.isFalse(systemProcessProbe.isRunning(commandPid));
    },
  );

  it("takes the lock without waiting only when it is free and nobody is in line", () => {
    const record = tryAcquireHeavyCheckLock({ paths, command: ["checks", "copy"] });
    assert.isNotNull(record);
    assert.isNull(tryAcquireHeavyCheckLock({ paths, command: ["checks", "copy"] }));
    // Only the holder's own id releases.
    assert.isFalse(releaseHeavyCheckLock(paths, "someone-else"));
    assert.isTrue(releaseHeavyCheckLock(paths, record!.id));
    assert.isNull(readHolder(paths));
  });

  it("reads --wait-timeout values", () => {
    assert.strictEqual(parseWaitTimeout("90"), 90_000);
    assert.strictEqual(parseWaitTimeout("90s"), 90_000);
    assert.strictEqual(parseWaitTimeout("500ms"), 500);
    assert.strictEqual(parseWaitTimeout("10m"), 600_000);
    assert.strictEqual(parseWaitTimeout("2h"), 7_200_000);
    assert.isNull(parseWaitTimeout("soon"));
  });
});
