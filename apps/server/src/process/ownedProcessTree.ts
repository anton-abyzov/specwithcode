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
export function parseWindowsProcessList(text: string): ProcessEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
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
  /** When the spawn was asked for, in epoch milliseconds: the CLI was created after it. */
  readonly spawnedAt: number;
  /** Whether the CLI has not exited yet; while it has not, its pid is still its own. */
  readonly alive: () => boolean;
}

interface Known {
  readonly entry: ProcessEntry;
  readonly created: bigint;
}

/**
 * The Windows processes below `root` in `table`: each created after its parent, the
 * parent being the root or a process already in the tree. `remembered` holds processes
 * read earlier that may have exited since, so their children are still found.
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
  const rootRow = byPid.get(root.pid);
  const rootLive = root.alive() && rootRow !== undefined && rootRow.started.length > 0;
  const rootCreated = rootLive
    ? BigInt(rootRow.started)
    : (remembered.get(root.pid)?.created ?? BigInt(filetimeFromEpochMs(root.spawnedAt - 1_000)));
  const tree: Known[] = [];
  const seen = new Set<number>([selfPid]);
  const queue: Array<{ pid: number; created: bigint }> = [{ pid: root.pid, created: rootCreated }];
  if (rootLive) tree.push({ entry: rootRow, created: rootCreated });
  seen.add(root.pid);
  // Remembered processes that exited are parents too: what they started is still here.
  for (const known of remembered.values()) {
    if (known.entry.pid === root.pid || seen.has(known.entry.pid)) continue;
    const now = byPid.get(known.entry.pid);
    if (now !== undefined && now.started === known.entry.started) continue;
    queue.push({ pid: known.entry.pid, created: known.created });
  }
  while (queue.length > 0) {
    const parent = queue.shift()!;
    // The pid now belongs to a newer process: only children created before it were its.
    const holder = byPid.get(parent.pid);
    const holderCreated =
      holder !== undefined && holder.started.length > 0 ? BigInt(holder.started) : null;
    const reused = holderCreated !== null && holderCreated !== parent.created;
    for (const child of children.get(parent.pid) ?? []) {
      if (seen.has(child.pid)) continue;
      const created = BigInt(child.started);
      if (created < parent.created) continue;
      if (reused && holderCreated !== null && created >= holderCreated) continue;
      seen.add(child.pid);
      tree.push({ entry: child, created });
      queue.push({ pid: child.pid, created });
    }
  }
  return tree;
}

/** The snapshot's processes that still run as the same process: same pid, start and command. */
export function stillRunning(
  snapshot: ReadonlyArray<ProcessEntry>,
  table: ReadonlyArray<ProcessEntry>,
): ProcessEntry[] {
  const current = new Map(table.map((entry) => [entry.pid, entry]));
  return snapshot.filter((entry) => {
    const now = current.get(entry.pid);
    return (
      entry.started.length > 0 &&
      now !== undefined &&
      now.started === entry.started &&
      now.command === entry.command
    );
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
      if (child.pgid !== root.pid && child.started.length > 0 && child.command.length > 0) {
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
  readonly readProcessList: () => Promise<ReadonlyArray<ProcessEntry> | undefined>;
  /** `process.kill`; a negative pid signals a process group. Throws like it does. */
  readonly signal: (pid: number, signal: NodeJS.Signals | 0) => void;
  /** Windows: kills each process that still has the creation time given. */
  readonly killVerified: (entries: ReadonlyArray<ProcessEntry>) => Promise<void>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

export interface TreeEndResult {
  /** Processes of the tree that were still running when the end began. */
  readonly found: number;
  /** Processes still running, or that could not be checked, when it gave up. */
  readonly survivors: number;
}

/**
 * The process tree of one spawned CLI. `remember` reads it while the CLI runs (on
 * Windows the parents it learns let `end` find orphans of tools that exited); `end`
 * ends what is still running, and resolves within its deadline whatever happens.
 */
export class OwnedProcessTree {
  private readonly remembered = new Map<number, Known>();
  readonly root: OwnedRoot;
  private readonly host: TreeHost;

  constructor(root: OwnedRoot, host: TreeHost) {
    this.root = root;
    this.host = host;
  }

  async remember(): Promise<void> {
    if (this.host.platform !== "win32") return;
    const table = await this.host.readProcessList().catch(() => undefined);
    if (table === undefined) return;
    for (const known of windowsTree(table, this.root, this.host.selfPid, this.remembered)) {
      this.remembered.set(known.entry.pid, known);
    }
  }

  async end(deadlineMs = 8_000): Promise<TreeEndResult> {
    // No pid (the spawn failed): signalling group 0 would reach this server's own group.
    if (this.root.pid <= 1) return { found: 0, survivors: 0 };
    try {
      return this.host.platform === "win32"
        ? await this.endWindows(this.host.now() + deadlineMs)
        : await this.endPosix(this.host.now() + deadlineMs);
    } catch {
      return { found: 0, survivors: 1 };
    }
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
    const table = await host.readProcessList().catch(() => undefined);
    let escapees = table === undefined ? [] : posixEscapees(table, this.root, host.selfPid);
    const groupMembers =
      table === undefined
        ? this.groupAlive()
          ? 1
          : 0
        : table.filter((entry) => entry.pgid === this.root.pid && entry.pid !== host.selfPid)
            .length;
    const found = groupMembers + escapees.length;
    if (found === 0) return { found: 0, survivors: 0 };
    const signalEscapees = async (signal: NodeJS.Signals) => {
      if (escapees.length === 0) return;
      const now = await host.readProcessList().catch(() => undefined);
      escapees = now === undefined ? escapees : stillRunning(escapees, now);
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
          const now = await host.readProcessList().catch(() => undefined);
          if (now !== undefined) escapees = stillRunning(escapees, now);
          if (escapees.length === 0) return true;
        }
        await host.sleep(200);
      }
      return false;
    };
    if (this.groupAlive()) this.signalGroup("SIGTERM");
    await signalEscapees("SIGTERM");
    const grace = Math.min(deadline, host.now() + Math.max(0, (deadline - host.now()) / 2));
    if (await settled(grace)) return { found, survivors: 0 };
    if (this.groupAlive()) this.signalGroup("SIGKILL");
    await signalEscapees("SIGKILL");
    if (await settled(deadline)) return { found, survivors: 0 };
    return { found, survivors: (this.groupAlive() ? 1 : 0) + escapees.length };
  }

  private async endWindows(deadline: number): Promise<TreeEndResult> {
    const { host } = this;
    let found = -1;
    while (host.now() < deadline) {
      const table = await host.readProcessList().catch(() => undefined);
      if (table === undefined) return { found: Math.max(found, 0), survivors: 1 };
      const tree = windowsTree(table, this.root, host.selfPid, this.remembered);
      for (const known of tree) this.remembered.set(known.entry.pid, known);
      if (found === -1) found = tree.length;
      if (tree.length === 0) return { found, survivors: 0 };
      // The CLI first, then by depth, so nothing is left to start a replacement.
      await host.killVerified(tree.map((known) => known.entry));
      await host.sleep(250);
    }
    const table = await host.readProcessList().catch(() => undefined);
    const left =
      table === undefined ? 1 : windowsTree(table, this.root, host.selfPid, this.remembered).length;
    return { found: Math.max(found, 0), survivors: left };
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
  "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId," +
  "@{n='Start';e={if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc().ToString() } else { $null }}}," +
  "CommandLine | ConvertTo-Json -Compress";

/** One PowerShell step per batch: each pid is killed only while its creation time matches. */
export function windowsKillScript(entries: ReadonlyArray<ProcessEntry>): string {
  const items = entries
    .filter((entry) => /^\d+$/u.test(entry.started))
    .map((entry) => `@(${Math.trunc(entry.pid)},${entry.started})`)
    .join(",");
  return (
    "$ErrorActionPreference='SilentlyContinue';" +
    `foreach ($i in @(${items})) {` +
    " $p = Get-Process -Id $i[0];" +
    " if ($p) { $t = $p.StartTime.ToFileTimeUtc(); if (($t - ($t % 10)) -eq [long]$i[1]) { $p.Kill() } }" +
    "}"
  );
}

/** This machine's process table, or undefined when it cannot be read. */
export async function readProcessList(
  platform: NodeJS.Platform = process.platform,
): Promise<ProcessEntry[] | undefined> {
  if (platform === "win32") {
    const text = await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESS_LIST],
      15_000,
    );
    return text === undefined ? undefined : parseWindowsProcessList(text);
  }
  const text = await run(
    platform === "darwin" ? "/bin/ps" : "ps",
    ["-A", "-o", "pid=,ppid=,pgid=,lstart=,args="],
    10_000,
    { ...process.env, LC_ALL: "C" },
  );
  return text === undefined ? undefined : parsePosixProcessList(text);
}

export const nodeTreeHost = (): TreeHost => ({
  platform: process.platform,
  selfPid: process.pid,
  readProcessList: () => readProcessList(process.platform),
  signal: (pid, signal) => {
    process.kill(pid, signal);
  },
  killVerified: async (entries) => {
    if (entries.length === 0) return;
    await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", windowsKillScript(entries)],
      15_000,
    );
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
});

/** What the Claude Agent SDK passes its `spawnClaudeCodeProcess` hook. */
export interface OwnedSpawnOptions {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env: Record<string, string | undefined>;
  readonly signal: AbortSignal;
}

/**
 * Spawns the CLI the way the SDK does (pipes, hidden window, the SDK's forwarded abort
 * signal), but on macOS and Linux as the leader of its own process group, and returns
 * the tree to end it with. Stderr is drained so the CLI never blocks on it.
 */
export function spawnOwnedProcess(
  options: OwnedSpawnOptions,
  host: TreeHost = nodeTreeHost(),
): { readonly child: ChildProcessWithoutNullStreams; readonly tree: OwnedProcessTree } {
  const spawnedAt = host.now();
  const child = spawn(options.command, [...options.args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: options.env,
    signal: options.signal,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: host.platform !== "win32",
  }) as ChildProcessWithoutNullStreams;
  child.stderr.resume();
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
  return { child, tree };
}
