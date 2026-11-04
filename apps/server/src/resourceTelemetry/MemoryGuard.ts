import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { forgetExitedUserApps, isUserOpenedApp } from "../process/userOpenedApps.ts";

/**
 * When a Linux machine runs out of memory the kernel kills by score, and
 * Chromium gives renderers +300 while everything else in a user session has
 * +200: the app window (600 MB) outscored a 4.8 GB `tsc` and died first. The
 * kernel also acts only after minutes of thrashing, with the desktop frozen.
 * Everything the service starts is marked as the first to go. Early termination
 * requires an explicitly owned signal transport. The default guard sends no
 * bare-PID signals: a PID can be reused after /proc inspection and Node does not
 * expose a pinned process handle for arbitrary descendants.
 */
export const AGENT_WORK_OOM_SCORE_ADJ = 800;

const SAMPLE_INTERVAL = "5 seconds";
const SCAN_EVERY_SAMPLES = 3;
const KILL_COOLDOWN_MS = 30_000;
const TERM_GRACE = "5 seconds";
const DEFAULT_PAGE_BYTES = 4096;
const MIN_VICTIM_RSS_BYTES = 1024 ** 3;
/** Keeps remote connections up: it is small and never the cause. */
const NEVER_MARKED = new Set(["cloudflared"]);
/**
 * Only work that can simply be run again is ended early. An agent harness can
 * sit at any depth (Gemini re-spawns itself; npx adds a level) and ending one
 * loses a session, so anything unknown is left to the kernel, marked to go first.
 */
const RERUNNABLE_BUILD =
  /^(?:tsc|tsgo|vp|vite|vitest|rollup|rolldown|esbuild|webpack|turbopack|next|jest|playwright|cargo|rustc|gcc|g\+\+|cc1|cc1plus|clang|clang\+\+|ld|lld|compile|link|swiftc|swift-frontend|xcodebuild|pytest|mypy)(?:\.[cm]?js|\.exe)?$/;
const SCRIPT_RUNNER = /^(?:node|bun|deno|python[\d.]*)$/;
const RUNNER_FLAGS_WITH_VALUE = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "-C",
  "--conditions",
  "--env-file",
  "--title",
]);
/** Inline code: there is no script to judge. */
const RUNNER_INLINE_FLAGS = new Set(["-e", "--eval", "-p", "--print", "-c"]);

export interface MemorySample {
  readonly totalKb: number;
  readonly availableKb: number;
  readonly swapTotalKb: number;
  readonly swapFreeKb: number;
  /** "full" avg10 from /proc/pressure/memory; null when the kernel has no PSI. */
  readonly pressureFull: number | null;
}

export interface ProcessEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly comm: string;
  readonly rssBytes: number;
  /** With the pid, identifies one process: pids get reused. */
  readonly startTime: string;
}

export function parseMemory(meminfo: string, pressure: string): MemorySample | null {
  const field = (name: string) => {
    const match = new RegExp(`^${name}:\\s+(\\d+) kB$`, "m").exec(meminfo)?.[1];
    return match === undefined ? null : Number(match);
  };
  const totalKb = field("MemTotal");
  const availableKb = field("MemAvailable");
  if (totalKb === null || availableKb === null) return null;
  const full = /^full avg10=([\d.]+)/m.exec(pressure)?.[1];
  return {
    totalKb,
    availableKb,
    swapTotalKb: field("SwapTotal") ?? 0,
    swapFreeKb: field("SwapFree") ?? 0,
    pressureFull: full === undefined ? null : Number(full),
  };
}

/** The kernel's page size: /proc reports rss in pages, and it is not 4 KiB everywhere. */
export function pageBytesFrom(status: string, statm: string): number {
  const rssKb = Number(/^VmRSS:\s+(\d+) kB$/m.exec(status)?.[1]);
  const rssPages = Number(statm.split(" ")[1]);
  if (!(rssKb > 0) || !(rssPages > 0)) return DEFAULT_PAGE_BYTES;
  const measured = (rssKb * 1024) / rssPages;
  return [4096, 16384, 65536].reduce((best, size) =>
    Math.abs(size - measured) < Math.abs(best - measured) ? size : best,
  );
}

/** The script a runner was started with: its first argument that is not a flag. */
function scriptOf(args: ReadonlyArray<string>): string | undefined {
  for (let index = 1; index < args.length; index++) {
    const argument = args[index]!;
    if (RUNNER_INLINE_FLAGS.has(argument)) return undefined;
    if (RUNNER_FLAGS_WITH_VALUE.has(argument)) index++;
    else if (!argument.startsWith("-")) return argument;
  }
  return undefined;
}

/**
 * Judged by the program, never its other arguments: a harness told to
 * "fix apps/web/vite.config.ts", or pointed at a folder named next, is no build.
 */
export function isRerunnableBuild(comm: string, cmdline: string): boolean {
  if (RERUNNABLE_BUILD.test(comm)) return true;
  if (!SCRIPT_RUNNER.test(comm)) return false;
  const script = scriptOf(cmdline.split("\0"));
  if (script === undefined) return false;
  const name = script.slice(script.lastIndexOf("/") + 1);
  if (RERUNNABLE_BUILD.test(name)) return true;
  // A tool's worker runs from inside its package: node_modules/vitest/dist/workers/forks.js.
  const parts = script.split("/");
  const packageName = parts[parts.lastIndexOf("node_modules") + 1];
  return parts.includes("node_modules") && RERUNNABLE_BUILD.test(packageName ?? "");
}

export function parseProcessStat(
  stat: string,
  pageBytes = DEFAULT_PAGE_BYTES,
): ProcessEntry | null {
  // comm can hold spaces and parentheses, so split around the last ")".
  const open = stat.indexOf("(");
  const close = stat.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const fields = stat
    .slice(close + 2)
    .trim()
    .split(" ");
  const pid = Number(stat.slice(0, open).trim());
  const ppid = Number(fields[1]);
  const rssPages = Number(fields[21]);
  const startTime = fields[19];
  if (
    !Number.isInteger(pid) ||
    !Number.isInteger(ppid) ||
    !Number.isInteger(rssPages) ||
    startTime === undefined
  ) {
    return null;
  }
  return {
    pid,
    ppid,
    comm: stat.slice(open + 1, close),
    rssBytes: rssPages * pageBytes,
    startTime,
  };
}

export function isMemoryCritical(memory: MemorySample): boolean {
  const available = memory.availableKb / memory.totalKb;
  const swapNearlyGone = memory.swapTotalKb === 0 || memory.swapFreeKb / memory.swapTotalKb <= 0.1;
  if (available <= 0.05 && swapNearlyGone) return true;
  return available <= 0.1 && (memory.pressureFull ?? 0) >= 30;
}

/**
 * Everything below `rootPid`, with its depth: direct children are depth 1. An
 * app the user opened is not agent work, so it and its tree are left out.
 */
export function descendantsOf(
  rootPid: number,
  processes: ReadonlyArray<ProcessEntry>,
  isExempt: (pid: number) => boolean = () => false,
): ReadonlyArray<ProcessEntry & { readonly depth: number }> {
  const children = new Map<number, ProcessEntry[]>();
  for (const entry of processes) {
    children.set(entry.ppid, [...(children.get(entry.ppid) ?? []), entry]);
  }
  const found: Array<ProcessEntry & { readonly depth: number }> = [];
  const walk = (pid: number, depth: number) => {
    for (const child of children.get(pid) ?? []) {
      if (isExempt(child.pid)) continue;
      found.push({ ...child, depth });
      walk(child.pid, depth + 1);
    }
  };
  walk(rootPid, 1);
  return found;
}

/**
 * Largest first. Direct children are agent harnesses, terminal shells and the
 * tunnel; a compile or build runs below them.
 */
export function victimCandidates(
  descendants: ReadonlyArray<ProcessEntry & { readonly depth: number }>,
  minRssBytes = MIN_VICTIM_RSS_BYTES,
): ReadonlyArray<ProcessEntry> {
  return descendants
    .filter((entry) => entry.depth >= 2 && entry.rssBytes >= minRssBytes)
    .toSorted((a, b) => b.rssBytes - a.rssBytes);
}

export interface MemoryGuardOptions {
  readonly procRoot?: string;
  readonly rootPid?: number;
  readonly minVictimRssBytes?: number;
  /** Only an explicitly owned signal transport may end a build. The default guard
   * marks OOM priority but sends no bare-PID signals: Node has no pinned pidfd API. */
  readonly signal?: (pid: number, signal: NodeJS.Signals) => void;
  /** Stands in for /proc/meminfo, so a test can use the real process table. */
  readonly memory?: MemorySample;
}

export interface MemoryGuardState {
  /** The processes already marked, so each is written once. */
  marked: Set<number>;
  /** Signalled already: one stuck in uninterruptible I/O must not block the next. */
  ended: Set<string>;
  lastKillAt: number;
}

export const makeMemoryGuard = Effect.fn("makeMemoryGuard")(function* (
  options: MemoryGuardOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const procRoot = options.procRoot ?? "/proc";
  const rootPid = options.rootPid ?? process.pid;
  const signal = options.signal;
  const state: MemoryGuardState = {
    marked: new Set(),
    ended: new Set(),
    lastKillAt: Number.NEGATIVE_INFINITY,
  };

  const readText = (path: string) => fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""));

  const pageBytes = pageBytesFrom(
    yield* readText(`${procRoot}/self/status`),
    yield* readText(`${procRoot}/self/statm`),
  );
  const keyOf = (entry: ProcessEntry) => `${entry.pid}:${entry.startTime}`;

  const readDescendants = Effect.gen(function* () {
    const names = yield* fs.readDirectory(procRoot).pipe(Effect.orElseSucceed(() => []));
    const pids = names.filter((name) => /^\d+$/.test(name));
    if (pids.length > 0) {
      const alive = new Set(pids.map(Number));
      forgetExitedUserApps((pid) => alive.has(pid));
    }
    const stats = yield* Effect.forEach(pids, (name) => readText(`${procRoot}/${name}/stat`), {
      concurrency: 16,
    });
    return descendantsOf(
      rootPid,
      stats.flatMap((stat) => parseProcessStat(stat, pageBytes) ?? []),
      isUserOpenedApp,
    );
  });

  // A process that exited, or a sandboxed one that refuses, is simply skipped.
  const mark = (descendants: ReadonlyArray<ProcessEntry>) =>
    Effect.gen(function* () {
      const live = new Set(descendants.map(keyOf));
      state.ended = new Set([...state.ended].filter((key) => live.has(key)));
      state.marked = new Set(
        [...state.marked].filter((pid) => descendants.some((d) => d.pid === pid)),
      );
      for (const entry of descendants) {
        if (state.marked.has(entry.pid) || NEVER_MARKED.has(entry.comm)) continue;
        state.marked.add(entry.pid);
        yield* fs
          .writeFileString(
            `${procRoot}/${entry.pid}/oom_score_adj`,
            String(AGENT_WORK_OOM_SCORE_ADJ),
          )
          .pipe(Effect.ignore);
      }
    });

  /** False when the process is out of reach (EPERM), so the next can be tried. */
  const sendSignal = (pid: number, name: NodeJS.Signals) =>
    Effect.sync(() => {
      if (signal === undefined) return false;
      try {
        signal(pid, name);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    });

  /** The first candidate that is a build and takes the signal; true if there was one. */
  const endLargest = (candidates: ReadonlyArray<ProcessEntry>, memory: MemorySample) =>
    Effect.gen(function* () {
      for (const victim of candidates) {
        if (state.ended.has(keyOf(victim))) continue;
        const cmdline = yield* readText(`${procRoot}/${victim.pid}/cmdline`);
        if (!isRerunnableBuild(victim.comm, cmdline)) continue;
        if (!(yield* sendSignal(victim.pid, "SIGTERM"))) continue;
        state.ended.add(keyOf(victim));
        yield* Effect.logWarning("memory is critical; ended the largest build", {
          pid: victim.pid,
          command: victim.comm,
          rssBytes: victim.rssBytes,
          availableKb: memory.availableKb,
          swapFreeKb: memory.swapFreeKb,
          pressureFull: memory.pressureFull,
        });
        yield* Effect.sleep(TERM_GRACE).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const now = parseProcessStat(yield* readText(`${procRoot}/${victim.pid}/stat`));
              if (now !== null && keyOf(now) === keyOf(victim)) {
                yield* sendSignal(victim.pid, "SIGKILL");
              }
            }),
          ),
          Effect.forkScoped,
        );
        return true;
      }
      return false;
    });

  /** One pass; `scan` marks new processes even when memory is fine. */
  const pass = (scan: boolean) =>
    Effect.gen(function* () {
      const memory =
        options.memory ??
        parseMemory(
          yield* readText(`${procRoot}/meminfo`),
          yield* readText(`${procRoot}/pressure/memory`),
        );
      const critical = memory !== null && isMemoryCritical(memory);
      if (!scan && !critical) return;
      const descendants = yield* readDescendants;
      yield* mark(descendants);
      // Do not replace an atomic process handle with a /proc read plus process.kill:
      // the PID may be reused between those operations. Keep kernel OOM priority.
      if (!critical || signal === undefined) return;
      const now = yield* Clock.currentTimeMillis;
      if (now - state.lastKillAt < KILL_COOLDOWN_MS) return;
      const candidates = victimCandidates(descendants, options.minVictimRssBytes);
      if (yield* endLargest(candidates, memory)) state.lastKillAt = now;
    });

  return { pass, state };
});

/** Scans on the first sample of every `SCAN_EVERY_SAMPLES`. */
export function runGuardPasses<E, R>(pass: (scan: boolean) => Effect.Effect<void, E, R>) {
  let samples = 0;
  return Effect.suspend(() => pass(samples++ % SCAN_EVERY_SAMPLES === 0)).pipe(
    Effect.catchCause((cause) => Effect.logWarning("memory guard pass failed", { cause })),
    Effect.andThen(Effect.sleep(SAMPLE_INTERVAL)),
    Effect.forever,
  );
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    if (platform !== "linux" || process.env.STUDIO_MEMORY_GUARD === "off") return;
    const guard = yield* makeMemoryGuard();
    yield* runGuardPasses(guard.pass).pipe(Effect.forkScoped);
  }),
);
