// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- reads the process table and signals processes from plain promises, so an SDK-owned process can be ended on every OS.
/**
 * Ends what a provider CLI that this server did not spawn itself left running.
 *
 * The Claude Agent SDK spawns the Claude CLI, so the server never holds its pid or a
 * process group, and its own close ends only the CLI: on Windows with TerminateProcess,
 * which leaves the CLI's tool processes (shells, builds, dev servers) running; elsewhere
 * with signals to the CLI alone. Stop therefore snapshots the CLI's process tree while it
 * still runs, found below this server by a marker on its command line (the session id),
 * and once the SDK has closed it, ends whatever in that snapshot is still running: on
 * Windows with `taskkill /T /F`, elsewhere with SIGTERM and then SIGKILL. A process is
 * only signalled while its pid still carries the command line it had in the snapshot, so
 * a reused pid is left alone. Every failure (no `ps`, no PowerShell, access denied) is
 * swallowed: the SDK's own teardown is unchanged.
 */
import { execFile } from "node:child_process";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface ProcessEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
}

/** `ps -A -o pid=,ppid=,args=` output. */
export function parsePosixProcessList(text: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s?(.*)$/u.exec(line);
    if (match === null) continue;
    entries.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? "" });
  }
  return entries;
}

/** `Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json`. */
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
    entries.push({ pid, ppid, command: typeof command === "string" ? command : "" });
  }
  return entries;
}

function childrenByParent(table: ReadonlyArray<ProcessEntry>) {
  const children = new Map<number, ProcessEntry[]>();
  for (const entry of table) {
    if (entry.pid === entry.ppid) continue;
    const list = children.get(entry.ppid);
    if (list === undefined) children.set(entry.ppid, [entry]);
    else list.push(entry);
  }
  return children;
}

/**
 * The highest process below `ancestorPid` whose command line contains `marker`, followed by
 * everything below it, or nothing when no such process runs.
 */
export function markedProcessTree(
  table: ReadonlyArray<ProcessEntry>,
  ancestorPid: number,
  marker: string,
): ProcessEntry[] {
  if (marker.length === 0) return [];
  const children = childrenByParent(table);
  const seen = new Set<number>([ancestorPid]);
  const walk = (start: ReadonlyArray<ProcessEntry>, visit: (entry: ProcessEntry) => boolean) => {
    const queue = [...start];
    while (queue.length > 0) {
      const entry = queue.shift()!;
      if (seen.has(entry.pid)) continue;
      seen.add(entry.pid);
      if (visit(entry)) return;
      queue.push(...(children.get(entry.pid) ?? []));
    }
  };
  let root: ProcessEntry | undefined;
  walk(children.get(ancestorPid) ?? [], (entry) => {
    if (!entry.command.includes(marker)) return false;
    root = entry;
    return true;
  });
  if (root === undefined) return [];
  const tree: ProcessEntry[] = [root];
  seen.clear();
  // Never the server itself, even when a corrupt table lists it below the CLI.
  seen.add(ancestorPid);
  seen.add(root.pid);
  walk(children.get(root.pid) ?? [], (entry) => {
    tree.push(entry);
    return false;
  });
  return tree;
}

/** The snapshot's processes that still run with the command line they had then. */
export function stillRunning(
  snapshot: ReadonlyArray<ProcessEntry>,
  table: ReadonlyArray<ProcessEntry>,
): ProcessEntry[] {
  const current = new Map(table.map((entry) => [entry.pid, entry.command]));
  return snapshot.filter((entry) => current.get(entry.pid) === entry.command);
}

function run(file: string, args: ReadonlyArray<string>, timeoutMs: number) {
  return new Promise<string | undefined>((resolve) => {
    try {
      execFile(
        file,
        [...args],
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
        (error, stdout) => resolve(error ? undefined : stdout),
      );
    } catch {
      resolve(undefined);
    }
  });
}

const WINDOWS_PROCESS_LIST =
  "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress";

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
    ["-A", "-o", "pid=,ppid=,args="],
    10_000,
  );
  return text === undefined ? undefined : parsePosixProcessList(text);
}

export interface MarkedTreeHost {
  readonly platform: NodeJS.Platform;
  readonly ancestorPid: number;
  readonly readProcessList: () => Promise<ReadonlyArray<ProcessEntry> | undefined>;
  readonly signal: (pid: number, signal: NodeJS.Signals) => void;
  readonly taskkillTree: (pid: number) => Promise<void>;
  readonly sleep: (ms: number) => Promise<void>;
}

export const nodeMarkedTreeHost = (): MarkedTreeHost => ({
  platform: process.platform,
  ancestorPid: process.pid,
  readProcessList: () => readProcessList(process.platform),
  signal: (pid, signal) => process.kill(pid, signal),
  taskkillTree: async (pid) => {
    await run("taskkill", ["/PID", String(pid), "/T", "/F"], 10_000);
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

/** The process tree of the CLI carrying `marker`, read while it still runs. */
export async function snapshotMarkedTree(
  marker: string,
  host: MarkedTreeHost = nodeMarkedTreeHost(),
): Promise<ProcessEntry[]> {
  try {
    const table = await host.readProcessList();
    return table === undefined ? [] : markedProcessTree(table, host.ancestorPid, marker);
  } catch {
    return [];
  }
}

/**
 * Ends what of a snapshot still runs. Returns how many processes were still running, so
 * the caller can log that Stop had to end them.
 */
export async function endSnapshotSurvivors(
  snapshot: ReadonlyArray<ProcessEntry>,
  host: MarkedTreeHost = nodeMarkedTreeHost(),
  graceMs = 1_000,
): Promise<number> {
  if (snapshot.length === 0) return 0;
  const safe = (action: () => void) => {
    try {
      action();
    } catch {
      // Gone since the read (ESRCH) or not ours (EPERM).
    }
  };
  try {
    const table = await host.readProcessList();
    if (table === undefined) return 0;
    const alive = stillRunning(
      snapshot.filter((entry) => entry.pid !== host.ancestorPid && entry.pid > 1),
      table,
    );
    if (alive.length === 0) return 0;
    if (host.platform === "win32") {
      // /T also ends what a survivor started after the snapshot, while it still runs.
      for (const entry of alive) await host.taskkillTree(entry.pid);
      return alive.length;
    }
    for (const entry of alive) safe(() => host.signal(entry.pid, "SIGTERM"));
    await host.sleep(graceMs);
    const after = await host.readProcessList();
    if (after !== undefined) {
      for (const entry of stillRunning(alive, after)) safe(() => host.signal(entry.pid, "SIGKILL"));
    }
    return alive.length;
  } catch {
    return 0;
  }
}

export interface MarkedProcessTreeShape {
  /** The process tree of the CLI carrying `marker`, or nothing. */
  readonly snapshot: (marker: string) => Effect.Effect<ReadonlyArray<ProcessEntry>>;
  /** Ends what of a snapshot still runs; resolves to how many were still running. */
  readonly endSurvivors: (snapshot: ReadonlyArray<ProcessEntry>) => Effect.Effect<number>;
}

const inert: MarkedProcessTreeShape = {
  snapshot: () => Effect.succeed([]),
  endSurvivors: () => Effect.succeed(0),
};

/**
 * Does nothing by default, so tests and tools that run fake providers never read this
 * host's process table; the server provides `layer`.
 */
export const MarkedProcessTree = Context.Reference<MarkedProcessTreeShape>(
  "specweave-studio/process/MarkedProcessTree",
  { defaultValue: () => inert },
);

export const make = (host: MarkedTreeHost = nodeMarkedTreeHost()): MarkedProcessTreeShape => ({
  snapshot: (marker) => Effect.promise(() => snapshotMarkedTree(marker, host)),
  endSurvivors: (snapshot) => Effect.promise(() => endSnapshotSurvivors(snapshot, host)),
});

export const layer = Layer.sync(MarkedProcessTree, () => make());
