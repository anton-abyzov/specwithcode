// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- spawns a provider CLI and ends its process tree from plain promises, on every OS.
/**
 * A provider CLI this server spawns itself, so Stop can end everything it started.
 *
 * The Claude Agent SDK's own spawn and close end only the CLI: on Windows with
 * TerminateProcess, elsewhere with a signal to the CLI alone, which leaves its tool
 * processes (shells, builds, dev servers) running. The adapter hands the SDK
 * `spawnOwnedProcess` instead (the SDK's `spawnClaudeCodeProcess` hook), and ends the
 * tree once the CLI has exited.
 *
 * How a process is known to be part of the tree, without guessing from command lines:
 * - macOS and Linux: the CLI starts as the leader of its own process group, and its tools
 *   inherit the group. The group is signalled as a whole: the kernel never hands its id to
 *   a new process while any member is alive. A tool that left the group (setsid) is found
 *   by its parent pid while that parent lives, and signalled only while its pid, start
 *   time and command line still match.
 * - Windows: a process belongs to the tree when its parent does and it was created after
 *   that parent. A parent pid Windows later gave to a newer process does not count for a
 *   child created before it. Each one is ended by a PowerShell step that checks its
 *   creation time right before it kills it, so a reused pid is left alone.
 * Every failure (no `ps`, no PowerShell, access denied) is reported as a survivor count,
 * never thrown.
 */
import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";

export interface ProcessEntry {
  readonly pid: number;
  readonly ppid: number;
  /** The process group on macOS and Linux; null on Windows. */
  readonly pgid: number | null;
  /**
   * When the process started, as the OS reports it: `ps lstart` text on macOS and Linux,
   * a Windows FILETIME in decimal at microsecond resolution on Windows. Empty when unknown.
   */
  readonly started: string;
  readonly command: string;
}

/** `ps -A -o pid=,ppid=,pgid=,lstart=,args=` output, read with LC_ALL=C. */
export function parsePosixProcessList(text: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of text.split("\n")) {
    const match =
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s?(.*)$/u.exec(
        line,
      );
    if (match === null) continue;
    entries.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      started: match[4]!.replace(/\s+/gu, " "),
      command: match[5] ?? "",
    });
  }
  return entries;
}

/** A FILETIME at the microsecond resolution both CIM and Process.StartTime agree on. */
function microsecondFiletime(value: unknown): string {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) return "";
  const filetime = BigInt(value);
  return (filetime - (filetime % 10n)).toString();
}

/** `Get-CimInstance Win32_Process` rows as JSON: ProcessId, ParentProcessId, Start, CommandLine. */
export function parseWindowsProcessList(text: string): ProcessEntry[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Empty or broken output is a failed read, never an empty table.
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const entries: ProcessEntry[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const pid = Reflect.get(row, "ProcessId");
    const ppid = Reflect.get(row, "ParentProcessId");
    const command = Reflect.get(row, "CommandLine");
    if (typeof pid !== "number" || typeof ppid !== "number") continue;
    entries.push({
      pid,
      ppid,
      pgid: null,
      started: microsecondFiletime(Reflect.get(row, "Start")),
      command: typeof command === "string" ? command : "",
    });
  }
  return entries;
}

/** A Windows FILETIME (microsecond resolution) for a time in epoch milliseconds. */
export function filetimeFromEpochMs(ms: number): string {
  return ((BigInt(Math.floor(ms)) + 11_644_473_600_000n) * 10_000n).toString();
}

/** The root of a tree: the CLI this server spawned. */
export interface OwnedRoot {
  readonly pid: number;
  /** When the spawn was asked for, on the host's monotonic clock. */
  readonly spawnedAt: number;
  /** Whether the CLI has not exited yet; while it has not, its pid is still its own. */
  readonly alive: () => boolean;
}

interface Known {
  readonly entry: ProcessEntry;
  readonly created: bigint;
}

/**
 * The Windows processes of `root`'s tree in `table`. Only a parent that is alive in the
 * table, as the same process, passes its pid on: while it runs, Windows cannot give that
 * pid to anyone else, so a process naming it as parent and created after it is its child.
 * The live CLI (its handle keeps its pid) and processes attributed by an earlier reading
 * (`remembered`) that still run as themselves are the starting points. What an exited
 * parent started is taken only if an earlier reading already attributed it: its pid may
 * have belonged to someone else since.
 */
export function windowsTree(
  table: ReadonlyArray<ProcessEntry>,
  root: OwnedRoot,
  selfPid: number,
  remembered: ReadonlyMap<number, Known> = new Map(),
): Known[] {
  const byPid = new Map(table.map((entry) => [entry.pid, entry]));
  const children = new Map<number, ProcessEntry[]>();
  for (const entry of table) {
    if (entry.pid === entry.ppid || entry.started.length === 0) continue;
    const list = children.get(entry.ppid);
    if (list === undefined) children.set(entry.ppid, [entry]);
    else list.push(entry);
  }
  const tree: Known[] = [];
  const seen = new Set<number>([selfPid]);
  const queue: Known[] = [];
  const add = (entry: ProcessEntry, created: bigint) => {
    seen.add(entry.pid);
    const known = { entry, created };
    tree.push(known);
    queue.push(known);
  };
  const rootRow = byPid.get(root.pid);
  if (root.alive() && rootRow !== undefined && rootRow.started.length > 0) {
    add(rootRow, BigInt(rootRow.started));
  } else {
    // The CLI exited: whatever holds its pid now is someone else.
    seen.add(root.pid);
  }
  for (const known of remembered.values()) {
    if (seen.has(known.entry.pid)) continue;
    const now = byPid.get(known.entry.pid);
    if (now !== undefined && now.started === known.entry.started) add(now, known.created);
  }
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const child of children.get(parent.entry.pid) ?? []) {
      if (seen.has(child.pid)) continue;
      const created = BigInt(child.started);
      if (created < parent.created) continue;
      add(child, created);
    }
  }
  return tree;
}

/**
 * The snapshot's processes that still run as the same process: same pid and start time.
 * The command line is not compared: a process that execs another program is still it.
 */
export function stillRunning(
  snapshot: ReadonlyArray<ProcessEntry>,
  table: ReadonlyArray<ProcessEntry>,
): ProcessEntry[] {
  const current = new Map(table.map((entry) => [entry.pid, entry]));
  return snapshot.filter((entry) => {
    const now = current.get(entry.pid);
    return entry.started.length > 0 && now !== undefined && now.started === entry.started;
  });
}

/**
 * The POSIX processes started below the group's members (or the live root) that left the
 * group: on macOS and Linux an orphan is reparented, so the parent pid is exact.
 */
export function posixEscapees(
  table: ReadonlyArray<ProcessEntry>,
  root: OwnedRoot,
  selfPid: number,
): ProcessEntry[] {
  const children = new Map<number, ProcessEntry[]>();
  for (const entry of table) {
    if (entry.pid === entry.ppid) continue;
    const list = children.get(entry.ppid);
    if (list === undefined) children.set(entry.ppid, [entry]);
    else list.push(entry);
  }
  const seen = new Set<number>([selfPid]);
  const queue = table.filter((entry) => entry.pgid === root.pid).map((entry) => entry.pid);
  if (root.alive()) queue.push(root.pid);
  const escapees: ProcessEntry[] = [];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      if (child.pgid !== root.pid && child.started.length > 0) {
        escapees.push(child);
      }
      queue.push(child.pid);
    }
  }
  return escapees;
}

export interface TreeHost {
  readonly platform: NodeJS.Platform;
  readonly selfPid: number;
  /** The process table, or undefined when it cannot be read within `timeoutMs`. */
  readonly readProcessList: (timeoutMs: number) => Promise<ReadonlyArray<ProcessEntry> | undefined>;
  /** `process.kill`; a negative pid signals a process group. Throws like it does. */
  readonly signal: (pid: number, signal: NodeJS.Signals | 0) => void;
  /** Windows: kills each process that still has the creation time given. */
  readonly killVerified: (entries: ReadonlyArray<ProcessEntry>, timeoutMs: number) => Promise<void>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

export interface TreeEndResult {
  /** Processes of the tree that were still running when the end began. */
  readonly found: number;
  /** Processes known to be still running when it gave up. */
  readonly survivors: number;
  /** The process table could not be read in time, so what still runs is not known. */
  readonly unknown: boolean;
}

/** The longest one process-table read or kill step may take. */
const STEP_TIMEOUT_MS = 15_000;

/**
 * The process tree of one spawned CLI. `remember` reads it while the CLI runs (on
 * Windows the parents it learns let `end` find orphans of tools that exited); `end`
 * ends what is still running within one deadline shared by every step, and a second
 * call while one runs gets the same result.
 */
export class OwnedProcessTree {
  private readonly remembered = new Map<number, Known>();
  /** POSIX tools seen outside the CLI's group, kept until an end confirms them gone. */
  private readonly escapees = new Map<number, ProcessEntry>();
  private ending: Promise<TreeEndResult> | null = null;
  readonly root: OwnedRoot;
  private readonly host: TreeHost;

  constructor(root: OwnedRoot, host: TreeHost) {
    this.root = root;
    this.host = host;
  }

  async remember(timeoutMs = STEP_TIMEOUT_MS): Promise<void> {
    if (this.host.platform !== "win32" || this.root.pid <= 1) return;
    const table = await this.host.readProcessList(timeoutMs).catch(() => undefined);
    if (table === undefined) return;
    for (const known of windowsTree(table, this.root, this.host.selfPid, this.remembered)) {
      this.remembered.set(known.entry.pid, known);
    }
  }

  end(deadlineMs = 8_000): Promise<TreeEndResult> {
    if (this.ending !== null) return this.ending;
    const ending = this.endOnce(deadlineMs).finally(() => {
      if (this.ending === ending) this.ending = null;
    });
    this.ending = ending;
    return ending;
  }

  private async endOnce(deadlineMs: number): Promise<TreeEndResult> {
    // No pid (the spawn failed): signalling group 0 would reach this server's own group.
    if (this.root.pid <= 1) return { found: 0, survivors: 0, unknown: false };
    const deadline = this.host.now() + deadlineMs;
    try {
      return this.host.platform === "win32"
        ? await this.endWindows(deadline)
        : await this.endPosix(deadline);
    } catch {
      return { found: 0, survivors: 0, unknown: true };
    }
  }

  /** What is left of the deadline for one step, never more than a step may take. */
  private budget(deadline: number): number {
    return Math.max(0, Math.min(STEP_TIMEOUT_MS, deadline - this.host.now()));
  }

  private read(deadline: number) {
    const budget = this.budget(deadline);
    if (budget <= 0) return Promise.resolve(undefined);
    return this.host.readProcessList(budget).catch(() => undefined);
  }

  private groupAlive(): boolean {
    try {
      this.host.signal(-this.root.pid, 0);
      return true;
    } catch {
      // ESRCH: no member left. EPERM: a group of another user, so not this CLI's.
      return false;
    }
  }

  private signalGroup(signal: NodeJS.Signals) {
    try {
      this.host.signal(-this.root.pid, signal);
    } catch {
      // The group emptied since the check.
    }
  }

  private async endPosix(deadline: number): Promise<TreeEndResult> {
    const { host } = this;
    const table = await this.read(deadline);
    // Without a table the group is still signalled, but tools that left it cannot be found.
    let unknown = table === undefined;
    if (table !== undefined) {
      // Tools that left the group are kept across ends, so a retry still knows them.
      for (const entry of posixEscapees(table, this.root, host.selfPid)) {
        this.escapees.set(entry.pid, entry);
      }
    }
    let escapees = [...this.escapees.values()];
    if (table !== undefined) escapees = stillRunning(escapees, table);
    const groupMembers =
      table === undefined
        ? this.groupAlive()
          ? 1
          : 0
        : table.filter((entry) => entry.pgid === this.root.pid && entry.pid !== host.selfPid)
            .length;
    const found = groupMembers + escapees.length;
    const settle = (survivors: number): TreeEndResult => {
      if (!unknown) {
        this.escapees.clear();
        for (const entry of escapees) this.escapees.set(entry.pid, entry);
      }
      return { found, survivors, unknown };
    };
    if (found === 0) return settle(0);
    // Each escapee is signalled only right after a read shows it is still the same process.
    const signalEscapees = async (signal: NodeJS.Signals) => {
      if (escapees.length === 0) return;
      const now = await this.read(deadline);
      if (now === undefined) {
        unknown = true;
        return;
      }
      escapees = stillRunning(escapees, now);
      for (const entry of escapees) {
        try {
          host.signal(entry.pid, signal);
        } catch {
          // Gone since the read.
        }
      }
    };
    const settled = async (until: number) => {
      while (host.now() < until) {
        if (!this.groupAlive()) {
          if (escapees.length === 0) return true;
          const now = await this.read(Math.min(until, deadline));
          if (now !== undefined) escapees = stillRunning(escapees, now);
          if (escapees.length === 0) return true;
        }
        await host.sleep(Math.max(0, Math.min(200, until - host.now())));
      }
      return false;
    };
    if (this.groupAlive()) this.signalGroup("SIGTERM");
    await signalEscapees("SIGTERM");
    const grace = host.now() + Math.max(0, (deadline - host.now()) / 2);
    if (await settled(grace)) return settle(0);
    if (this.groupAlive()) this.signalGroup("SIGKILL");
    await signalEscapees("SIGKILL");
    if (await settled(deadline)) return settle(0);
    return settle((this.groupAlive() ? 1 : 0) + escapees.length);
  }

  private async endWindows(deadline: number): Promise<TreeEndResult> {
    const { host } = this;
    // Without the CLI's own identity nothing below it can be attributed, so an empty
    // tree proves nothing.
    const rootKnown = () => this.root.alive() || this.remembered.has(this.root.pid);
    // The last reading is kept inside the deadline: it is what the result reports.
    const verifyBy = deadline;
    const killBy = host.now() + Math.max(0, (deadline - host.now()) * 0.7);
    let found = -1;
    let left: Known[] = [];
    while (host.now() < killBy) {
      const table = await this.read(killBy);
      if (table === undefined) return { found: Math.max(found, 0), survivors: 0, unknown: true };
      left = windowsTree(table, this.root, host.selfPid, this.remembered);
      for (const known of left) this.remembered.set(known.entry.pid, known);
      if (found === -1) found = left.length;
      if (left.length === 0) return { found, survivors: 0, unknown: !rootKnown() };
      const budget = this.budget(killBy);
      if (budget <= 0) break;
      // The CLI first, then by depth, so nothing is left to start a replacement.
      await host.killVerified(
        left.map((known) => known.entry),
        budget,
      );
      await host.sleep(Math.max(0, Math.min(250, killBy - host.now())));
    }
    const table = await this.read(verifyBy);
    if (table === undefined) return { found: Math.max(found, 0), survivors: 0, unknown: true };
    left = windowsTree(table, this.root, host.selfPid, this.remembered);
    return {
      found: Math.max(found, 0),
      survivors: left.length,
      unknown: left.length === 0 && !rootKnown(),
    };
  }
}

function run(
  file: string,
  args: ReadonlyArray<string>,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
) {
  return new Promise<string | undefined>((resolve) => {
    try {
      execFile(
        file,
        [...args],
        {
          timeout: timeoutMs,
          windowsHide: true,
          maxBuffer: 64 * 1024 * 1024,
          ...(env === undefined ? {} : { env }),
        },
        (error, stdout) => resolve(error ? undefined : stdout),
      );
    } catch {
      resolve(undefined);
    }
  });
}

const WINDOWS_PROCESS_LIST =
  "$ErrorActionPreference='Stop';" +
  "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId," +
  "@{n='Start';e={if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc().ToString() } else { $null }}}," +
  "CommandLine | ConvertTo-Json -Compress";

/**
 * One PowerShell step per batch: each pid is killed only while its creation time matches.
 * Items are "pid:time" strings, so a batch of one stays a list of one.
 */
export function windowsKillScript(entries: ReadonlyArray<ProcessEntry>): string {
  const items = entries
    .filter((entry) => /^\d+$/u.test(entry.started))
    .map((entry) => `'${Math.trunc(entry.pid)}:${entry.started}'`)
    .join(",");
  return (
    "$ErrorActionPreference='SilentlyContinue';" +
    `foreach ($i in @(${items})) {` +
    " $f = $i.Split(':'); $p = Get-Process -Id ([int]$f[0]);" +
    " if ($p) { $t = $p.StartTime.ToFileTimeUtc(); if (($t - ($t % 10)) -eq [long]$f[1]) { $p.Kill() } }" +
    "}"
  );
}

/** This machine's process table, or undefined when it cannot be read. */
export async function readProcessList(
  platform: NodeJS.Platform = process.platform,
  timeoutMs = STEP_TIMEOUT_MS,
): Promise<ProcessEntry[] | undefined> {
  if (platform === "win32") {
    const text = await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESS_LIST],
      timeoutMs,
    );
    const rows = text === undefined ? undefined : parseWindowsProcessList(text);
    // A table without this server itself was not a complete reading.
    return rows !== undefined && rows.some((row) => row.pid === process.pid) ? rows : undefined;
  }
  const text = await run(
    platform === "darwin" ? "/bin/ps" : "ps",
    ["-A", "-o", "pid=,ppid=,pgid=,lstart=,args="],
    timeoutMs,
    { ...process.env, LC_ALL: "C" },
  );
  return text === undefined ? undefined : parsePosixProcessList(text);
}

export const nodeTreeHost = (): TreeHost => ({
  platform: process.platform,
  selfPid: process.pid,
  readProcessList: (timeoutMs) => readProcessList(process.platform, timeoutMs),
  signal: (pid, signal) => {
    process.kill(pid, signal);
  },
  killVerified: async (entries, timeoutMs) => {
    if (entries.length === 0) return;
    await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", windowsKillScript(entries)],
      timeoutMs,
    );
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  // Monotonic: a clock change never stretches or cuts a deadline.
  now: () => performance.now(),
});

/** What the Claude Agent SDK passes its `spawnClaudeCodeProcess` hook. */
export interface OwnedSpawnOptions {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env: Record<string, string | undefined>;
  readonly signal: AbortSignal;
}

/** The last bytes of the CLI's stderr kept for the log when it fails. */
const STDERR_TAIL_BYTES = 4_096;

/**
 * Spawns the CLI the way the SDK does (pipes, hidden window, the SDK's forwarded abort
 * signal), but on macOS and Linux as the leader of its own process group, and returns
 * the tree to end it with. Stderr is drained so the CLI never blocks on it; its last
 * 4 KB are kept for the log. On Windows the tree is read once right away, so the CLI's
 * own creation time is known even if it exits before Stop.
 */
export function spawnOwnedProcess(
  options: OwnedSpawnOptions,
  host: TreeHost = nodeTreeHost(),
): {
  readonly child: ChildProcessWithoutNullStreams;
  readonly tree: OwnedProcessTree;
  readonly stderrTail: () => string;
} {
  const spawnedAt = host.now();
  const child = spawn(options.command, [...options.args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: options.env,
    signal: options.signal,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: host.platform !== "win32",
  }) as ChildProcessWithoutNullStreams;
  let tail = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    tail = (tail + chunk).slice(-STDERR_TAIL_BYTES);
  });
  child.stderr.on("error", () => {
    // The CLI's stderr closed with it; nothing to keep.
  });
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  const tree = new OwnedProcessTree(
    {
      pid: child.pid ?? 0,
      spawnedAt,
      alive: () => !exited && child.pid !== undefined && child.exitCode === null,
    },
    host,
  );
  void tree.remember();
  return { child, tree, stderrTail: () => tail };
}

/**
 * Ends a tree again after an end that left processes running or could not read the
 * process table: up to four more tries, 15 seconds apart. Resolves once a try confirms
 * nothing is left, or after the last one.
 */
export async function retryTreeEnd(
  tree: OwnedProcessTree,
  attempts = 4,
  intervalMs = 15_000,
): Promise<TreeEndResult | null> {
  let last: TreeEndResult | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    last = await tree.end();
    if (last.survivors === 0 && !last.unknown) return last;
  }
  return last;
}
