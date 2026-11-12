// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- a lock shared by separate processes: exclusive file creation, PIDs, signals and wall-clock waits, with no Effect runtime to share.
/**
 * The machine-wide heavy-check gate behind `specweave-studio checks run`.
 *
 * Full lint, typecheck and test suites use every core. Four agent threads
 * running them at once put a 16-core machine at a load of 54, so one runs at
 * a time, on the whole machine, whatever project or app instance asks.
 *
 * The lock is one file, `heavy-checks.lock`, holding who has it. It is
 * created by hard-linking a fully written temporary file, which fails when
 * the lock exists: there is no moment when the lock exists without its
 * record, and no read-then-write. Waiters queue as ticket files in
 * `heavy-checks.queue`; only the oldest live ticket tries to take the lock,
 * so a late caller never jumps ahead.
 *
 * A holder is dead when neither its own process nor the command it started
 * is running. A PID alone is not proof: it may have been reused, so the
 * process start time recorded with it must still match. A dead holder's lock
 * is removed under a short `mkdir` mutex, after reading it again, so two
 * waiters cannot both remove it and one of them remove the other's new lock.
 *
 * Plain Node on purpose (no Effect, no workspace imports): tests run it in
 * real child processes.
 *
 * @module heavyCheckLock
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** Set for the command a gate runs, so a nested `checks run` runs directly. */
export const HEAVY_CHECK_LOCK_ID_ENV = "STUDIO_HEAVY_CHECKS_LOCK_ID";
/** Overrides the folder that holds the lock and the queue. */
export const HEAVY_CHECK_DIR_ENV = "STUDIO_HEAVY_CHECKS_DIR";
/** The thread a provider process works for; see provider/RuntimeInstructions.ts. */
const THREAD_ID_ENV = "SPECWEAVE_STUDIO_THREAD_ID";

/** `--wait-timeout` passed before the lock was free. The command did not run. */
export const HEAVY_CHECK_EXIT_WAIT_TIMEOUT = 75;
/** The command could not be started. */
export const HEAVY_CHECK_EXIT_NOT_STARTED = 127;

export const HEAVY_CHECK_POLL_MS = 250;
export const HEAVY_CHECK_PROGRESS_MS = 30_000;
/** A takeover mutex older than this was left by a crash and is removed. */
const TAKEOVER_MUTEX_STALE_MS = 10_000;

export interface HeavyCheckPaths {
  readonly dir: string;
  readonly lockFile: string;
  readonly queueDir: string;
}

export function heavyCheckPaths(dir: string): HeavyCheckPaths {
  return {
    dir,
    lockFile: NodePath.join(dir, "heavy-checks.lock"),
    queueDir: NodePath.join(dir, "heavy-checks.queue"),
  };
}

export interface HeavyCheckRecord {
  /** Unique per acquisition; also what a nested call compares. */
  readonly id: string;
  readonly pid: number;
  /** `ps -o lstart=` of `pid`, or null where it cannot be read. */
  readonly startedAt: string | null;
  /** The command the holder started, once it runs. */
  readonly childPid?: number;
  readonly childStartedAt?: string | null;
  readonly host: string;
  readonly label: string | null;
  readonly command: ReadonlyArray<string>;
  readonly cwd: string;
  readonly threadId: string | null;
  /** ISO time the lock was taken. */
  readonly acquiredAt: string;
}

export interface HeavyCheckTicket {
  readonly name: string;
  readonly pid: number;
  readonly startedAt: string | null;
  readonly host: string;
  readonly label: string | null;
  readonly cwd: string;
  readonly threadId: string | null;
  readonly enqueuedAt: string;
}

/** How liveness is read. Tests replace it to stage a reused PID. */
export interface ProcessProbe {
  readonly isRunning: (pid: number) => boolean;
  readonly startTimeOf: (pid: number) => string | null;
}

/** When `pid` started, as `ps` prints it; null when unknown (no such process, no `ps`, Windows). */
export function processStartTime(pid: number): string | null {
  // oxlint-disable-next-line studio/no-global-process-runtime -- plain Node shared with child processes; no Effect runtime.
  if (process.platform === "win32" || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    const out = NodeChildProcess.execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
    return out.length === 0 ? null : out.replaceAll(/\s+/g, " ");
  } catch {
    return null;
  }
}

function pidRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM: it exists and belongs to someone else.
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

export const systemProcessProbe: ProcessProbe = {
  isRunning: pidRunning,
  startTimeOf: processStartTime,
};

/** `pid` runs and is still the process that started at `startedAt`. Unknown times count as the same. */
function sameProcessRuns(pid: number, startedAt: string | null, probe: ProcessProbe): boolean {
  if (!probe.isRunning(pid)) return false;
  if (startedAt === null) return true;
  const now = probe.startTimeOf(pid);
  return now === null || now === startedAt;
}

/** Whether the process a record or ticket names, or the command it started, still runs. */
export function holderAlive(
  record: Pick<HeavyCheckRecord, "pid" | "startedAt" | "host"> &
    Partial<Pick<HeavyCheckRecord, "childPid" | "childStartedAt">>,
  probe: ProcessProbe = systemProcessProbe,
): boolean {
  // Another machine sharing this folder: its PIDs mean nothing here, so never take over.
  if (record.host !== NodeOS.hostname()) return true;
  if (sameProcessRuns(record.pid, record.startedAt, probe)) return true;
  return (
    record.childPid !== undefined &&
    sameProcessRuns(record.childPid, record.childStartedAt ?? null, probe)
  );
}

function readText(path: string): string | null {
  try {
    return NodeFS.readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function parseRecord(raw: string): HeavyCheckRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<HeavyCheckRecord>;
    return typeof value.id === "string" &&
      typeof value.pid === "number" &&
      typeof value.host === "string"
      ? (value as HeavyCheckRecord)
      : null;
  } catch {
    return null;
  }
}

/** The current holder's record, or null when the lock is free. */
export function readHolder(paths: HeavyCheckPaths): HeavyCheckRecord | null {
  const raw = readText(paths.lockFile);
  return raw === null ? null : parseRecord(raw);
}

/** Live tickets, oldest first. Tickets of processes that are gone are removed. */
export function readQueue(
  paths: HeavyCheckPaths,
  probe: ProcessProbe = systemProcessProbe,
): ReadonlyArray<HeavyCheckTicket> {
  let names: Array<string>;
  try {
    names = NodeFS.readdirSync(paths.queueDir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const tickets: Array<HeavyCheckTicket> = [];
  for (const name of names.sort()) {
    const file = NodePath.join(paths.queueDir, name);
    const raw = readText(file);
    if (raw === null) continue;
    let ticket: HeavyCheckTicket;
    try {
      ticket = { ...(JSON.parse(raw) as HeavyCheckTicket), name };
    } catch {
      continue;
    }
    if (typeof ticket.pid !== "number" || typeof ticket.host !== "string") continue;
    if (holderAlive(ticket, probe)) tickets.push(ticket);
    else NodeFS.rmSync(file, { force: true });
  }
  return tickets;
}

/** Writes `content` to a new file that exists only complete: temporary file, then hard link. */
function createExclusive(target: string, content: string): boolean {
  const temporary = `${target}.${process.pid}.${NodeCrypto.randomBytes(6).toString("hex")}.tmp`;
  NodeFS.writeFileSync(temporary, content, { flag: "wx" });
  try {
    NodeFS.linkSync(temporary, target);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw cause;
  } finally {
    NodeFS.rmSync(temporary, { force: true });
  }
}

/**
 * Removes a dead holder's lock. `seen` is the lock's content when it was
 * judged dead; under the mutex it is read again and removed only if unchanged.
 */
function removeDeadLock(paths: HeavyCheckPaths, seen: string): void {
  const mutex = `${paths.lockFile}.takeover`;
  try {
    NodeFS.mkdirSync(mutex);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    try {
      if (Date.now() - NodeFS.statSync(mutex).mtimeMs > TAKEOVER_MUTEX_STALE_MS)
        NodeFS.rmdirSync(mutex);
    } catch {
      // Gone already, or not ours to remove: the next poll tries again.
    }
    return;
  }
  try {
    if (readText(paths.lockFile) === seen) NodeFS.rmSync(paths.lockFile, { force: true });
  } finally {
    try {
      NodeFS.rmdirSync(mutex);
    } catch {
      // Removed as stale by another waiter.
    }
  }
}

/** Removes the lock when `id` still holds it. Safe from a `process.on("exit")` handler. */
export function releaseHeavyCheckLock(paths: HeavyCheckPaths, id: string): boolean {
  const raw = readText(paths.lockFile);
  if (raw === null || parseRecord(raw)?.id !== id) return false;
  NodeFS.rmSync(paths.lockFile, { force: true });
  return true;
}

/** Replaces the holder's own record, for example once its command has a PID. */
function rewriteRecord(paths: HeavyCheckPaths, record: HeavyCheckRecord): void {
  if (readHolder(paths)?.id !== record.id) return;
  const temporary = `${paths.lockFile}.${process.pid}.update.tmp`;
  NodeFS.writeFileSync(temporary, JSON.stringify(record));
  NodeFS.renameSync(temporary, paths.lockFile);
}

export interface HeavyCheckWaitReport {
  readonly holder: HeavyCheckRecord | null;
  /** 1 is next in line. */
  readonly position: number;
  readonly queued: number;
  readonly waitedMs: number;
  readonly first: boolean;
}

export interface AcquireOptions {
  readonly paths: HeavyCheckPaths;
  readonly label?: string | null;
  readonly command: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Give up after this long; undefined waits forever, 0 never waits. */
  readonly waitTimeoutMs?: number | undefined;
  readonly pollMs?: number;
  readonly progressMs?: number;
  readonly onWait?: (report: HeavyCheckWaitReport) => void;
  readonly probe?: ProcessProbe;
}

export type AcquireResult =
  | { readonly status: "acquired"; readonly record: HeavyCheckRecord }
  | { readonly status: "timeout"; readonly holder: HeavyCheckRecord | null };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Takes the lock, waiting in arrival order behind earlier callers. */
export async function acquireHeavyCheckLock(options: AcquireOptions): Promise<AcquireResult> {
  const { paths } = options;
  const probe = options.probe ?? systemProcessProbe;
  const env = options.env ?? process.env;
  const pollMs = options.pollMs ?? HEAVY_CHECK_POLL_MS;
  const progressMs = options.progressMs ?? HEAVY_CHECK_PROGRESS_MS;
  NodeFS.mkdirSync(paths.queueDir, { recursive: true });

  const startedAt = processStartTime(process.pid);
  const cwd = options.cwd ?? process.cwd();
  const label = options.label ?? null;
  const threadId = env[THREAD_ID_ENV]?.trim() || null;
  const host = NodeOS.hostname();
  const began = Date.now();

  // Sorts by arrival time, then PID; the random tail keeps names unique.
  const ticketName = `${String(began).padStart(15, "0")}-${String(process.pid).padStart(10, "0")}-${NodeCrypto.randomBytes(4).toString("hex")}.json`;
  const ticketFile = NodePath.join(paths.queueDir, ticketName);
  NodeFS.writeFileSync(
    ticketFile,
    JSON.stringify({
      pid: process.pid,
      startedAt,
      host,
      label,
      cwd,
      threadId,
      enqueuedAt: new Date(began).toISOString(),
    }),
    { flag: "wx" },
  );
  try {
    let lastReport: number | null = null;
    for (;;) {
      const queue = readQueue(paths, probe);
      const position = Math.max(1, queue.findIndex((ticket) => ticket.name === ticketName) + 1);
      if (position === 1) {
        const record: HeavyCheckRecord = {
          id: NodeCrypto.randomUUID(),
          pid: process.pid,
          startedAt,
          host,
          label,
          command: options.command,
          cwd,
          threadId,
          acquiredAt: new Date().toISOString(),
        };
        if (createExclusive(paths.lockFile, JSON.stringify(record)))
          return { status: "acquired", record };
        const seen = readText(paths.lockFile);
        if (seen !== null) {
          const held = parseRecord(seen);
          // An unreadable record is nobody's: no holder writes one.
          if (held === null || !holderAlive(held, probe)) {
            removeDeadLock(paths, seen);
            continue;
          }
        } else continue;
      }
      const now = Date.now();
      const waitedMs = now - began;
      if (options.waitTimeoutMs !== undefined && waitedMs >= options.waitTimeoutMs)
        return { status: "timeout", holder: readHolder(paths) };
      if (lastReport === null || now - lastReport >= progressMs) {
        options.onWait?.({
          holder: readHolder(paths),
          position,
          queued: queue.length,
          waitedMs,
          first: lastReport === null,
        });
        lastReport = now;
      }
      await sleep(
        options.waitTimeoutMs === undefined
          ? pollMs
          : Math.max(1, Math.min(pollMs, options.waitTimeoutMs - waitedMs)),
      );
    }
  } finally {
    NodeFS.rmSync(ticketFile, { force: true });
  }
}

/**
 * Takes the lock only if it is free and nobody waits for it; never waits and
 * never takes over. Null means someone else holds it or is in line.
 */
export function tryAcquireHeavyCheckLock(
  options: Pick<AcquireOptions, "paths" | "label" | "command" | "cwd" | "env" | "probe">,
): HeavyCheckRecord | null {
  const { paths } = options;
  NodeFS.mkdirSync(paths.queueDir, { recursive: true });
  if (readQueue(paths, options.probe).length > 0) return null;
  const record: HeavyCheckRecord = {
    id: NodeCrypto.randomUUID(),
    pid: process.pid,
    startedAt: processStartTime(process.pid),
    host: NodeOS.hostname(),
    label: options.label ?? null,
    command: options.command,
    cwd: options.cwd ?? process.cwd(),
    threadId: (options.env ?? process.env)[THREAD_ID_ENV]?.trim() || null,
    acquiredAt: new Date().toISOString(),
  };
  return createExclusive(paths.lockFile, JSON.stringify(record)) ? record : null;
}

/** The caller runs inside the gate's own command, so it may act without taking the lock. */
export function insideHeavyCheckGate(
  paths: HeavyCheckPaths,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const outer = env[HEAVY_CHECK_LOCK_ID_ENV];
  return outer !== undefined && outer.length > 0 && readHolder(paths)?.id === outer;
}

const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;

/** `label (command) in cwd, thread X, PID n, since <time>` for one holder. */
export function describeHolder(record: HeavyCheckRecord, now = Date.now()): string {
  const command = record.command.join(" ");
  const shown = command.length > 120 ? `${command.slice(0, 117)}...` : command;
  const held = now - Date.parse(record.acquiredAt);
  return [
    record.label === null ? `"${shown}"` : `${record.label} ("${shown}")`,
    `in ${record.cwd}`,
    ...(record.threadId === null ? [] : [`thread ${record.threadId}`]),
    `PID ${record.pid}`,
    `since ${record.acquiredAt}${Number.isFinite(held) ? ` (${seconds(held)} ago)` : ""}`,
  ].join(", ");
}

/** One stderr line for a waiting caller. */
export function waitLine(report: HeavyCheckWaitReport): string {
  const holder =
    report.holder === null ? "another caller ahead in the queue" : describeHolder(report.holder);
  return report.first
    ? `checks: waiting for the heavy-check gate, held by ${holder}. Position ${report.position} of ${report.queued} waiting.`
    : `checks: still waiting after ${seconds(report.waitedMs)}, position ${report.position} of ${report.queued}; held by ${holder}.`;
}

export interface RunOptions extends Omit<AcquireOptions, "onWait"> {
  /** Where waiting and failure lines go. */
  readonly log?: (line: string) => void;
  readonly stdio?: NodeChildProcess.StdioOptions;
}

export interface RunResult {
  readonly exitCode: number;
  readonly signal: NodeJS.Signals | null;
  /** Ran directly because the caller was already inside the gate. */
  readonly nested: boolean;
  readonly timedOut: boolean;
}

const FORWARDED_SIGNALS: ReadonlyArray<NodeJS.Signals> = ["SIGINT", "SIGTERM", "SIGHUP"];

function spawnAndWait(
  options: RunOptions,
  env: NodeJS.ProcessEnv,
  onSpawn: (child: NodeChildProcess.ChildProcess) => void,
): Promise<Pick<RunResult, "exitCode" | "signal">> {
  return new Promise((resolve) => {
    const [file, ...args] = options.command;
    const child = NodeChildProcess.spawn(file!, args, {
      cwd: options.cwd ?? process.cwd(),
      env,
      stdio: options.stdio ?? "inherit",
    });
    const forward = (signal: NodeJS.Signals) => {
      child.kill(signal);
    };
    for (const signal of FORWARDED_SIGNALS) process.on(signal, forward);
    const done = (result: Pick<RunResult, "exitCode" | "signal">) => {
      for (const signal of FORWARDED_SIGNALS) process.off(signal, forward);
      resolve(result);
    };
    child.once("spawn", () => onSpawn(child));
    child.once("error", (cause) => {
      options.log?.(`checks: cannot start ${file}: ${cause.message}`);
      done({ exitCode: HEAVY_CHECK_EXIT_NOT_STARTED, signal: null });
    });
    child.once("exit", (code, signal) => {
      done({
        exitCode: code ?? 128 + (signal === null ? 0 : (NodeOS.constants.signals[signal] ?? 0)),
        signal,
      });
    });
  });
}

/**
 * Runs `command` holding the gate and returns its exit code. The lock is
 * released when the command exits, on a forwarded signal included. If this
 * process is killed outright, the lock stays until the command it started is
 * gone too, then the next waiter takes it over.
 */
export async function runUnderHeavyCheckGate(options: RunOptions): Promise<RunResult> {
  const env = options.env ?? process.env;
  const { paths } = options;
  if (options.command.length === 0) throw new Error("checks run needs a command after --");

  if (insideHeavyCheckGate(paths, env)) {
    const result = await spawnAndWait(options, env, () => {});
    return { ...result, nested: true, timedOut: false };
  }

  const acquired = await acquireHeavyCheckLock({
    ...options,
    onWait: (report) => options.log?.(waitLine(report)),
  });
  if (acquired.status === "timeout") {
    options.log?.(
      `checks: gave up after ${seconds(options.waitTimeoutMs ?? 0)}; the gate is held by ${
        acquired.holder === null ? "another caller" : describeHolder(acquired.holder)
      }. The command did not run.`,
    );
    return {
      exitCode: HEAVY_CHECK_EXIT_WAIT_TIMEOUT,
      signal: null,
      nested: false,
      timedOut: true,
    };
  }

  const { record } = acquired;
  let childRunning = false;
  // If this process exits while its command still runs, the record stays: the command holds the gate.
  const onExit = () => {
    if (!childRunning) releaseHeavyCheckLock(paths, record.id);
  };
  process.on("exit", onExit);
  try {
    const result = await spawnAndWait(
      options,
      { ...env, [HEAVY_CHECK_LOCK_ID_ENV]: record.id },
      (child) => {
        if (child.pid === undefined) return;
        childRunning = true;
        child.once("exit", () => {
          childRunning = false;
        });
        rewriteRecord(paths, {
          ...record,
          childPid: child.pid,
          childStartedAt: processStartTime(child.pid),
        });
      },
    );
    return { ...result, nested: false, timedOut: false };
  } finally {
    childRunning = false;
    releaseHeavyCheckLock(paths, record.id);
    process.off("exit", onExit);
  }
}

/** `90`, `90s`, `500ms`, `10m` or `2h` in milliseconds; null for anything else. */
export function parseWaitTimeout(text: string): number | null {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(text.trim());
  if (match === null) return null;
  const unit =
    match[2] === "ms" ? 1 : match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : 1000;
  const ms = Math.round(Number(match[1]) * unit);
  return Number.isSafeInteger(ms) ? ms : null;
}
