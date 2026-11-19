// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- reads the process table and signals processes from plain promises, so an SDK-owned process can be ended on every OS.
/**
 * Ends what a provider CLI that this server did not spawn itself left running.
 *
 * The Claude Agent SDK spawns the Claude CLI, so the server never holds its pid or a
 * process group, and its own close ends only the CLI: on Windows with TerminateProcess,
 * which leaves the CLI's tool processes (shells, builds, dev servers) running; elsewhere
 * with signals to the CLI alone. Stop therefore snapshots the CLI's process tree while it
 * still runs and, once the SDK has closed it, ends whatever in that snapshot still runs:
 * on Windows with `taskkill /F` (with `/T` only for the CLI itself while it is still the
 * same process), elsewhere with SIGTERM and then SIGKILL.
 *
 * What it may touch is narrow on purpose:
 * - the CLI is a direct child of this server whose command line carries one of the exact
 *   flags given (`--session-id=<id>`, `--resume=<id>`), so a tool of another session that
 *   merely mentions the id is never taken for it;
 * - a process is known by its pid, start time and command line together, read again
 *   right before each signal, so a reused pid is left alone; a process whose start time
 *   or command line cannot be read is never signalled.
 * Every failure (no `ps`, no PowerShell, access denied) is swallowed: the SDK's own
 * teardown is unchanged.
 */
import { execFile } from "node:child_process";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface ProcessEntry {
  readonly pid: number;
  readonly ppid: number;
  /** When the process started, as the OS reports it; empty when unknown. */
  readonly started: string;
  readonly command: string;
}

/** `ps -A -o pid=,ppid=,lstart=,args=` output, read with LC_ALL=C. */
export function parsePosixProcessList(text: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of text.split("\n")) {
    const match =
      /^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s?(.*)$/u.exec(
        line,
      );
    if (match === null) continue;
    entries.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      started: match[3]!.replace(/\s+/gu, " "),
      command: match[4] ?? "",
    });
  }
  return entries;
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
    const started = Reflect.get(row, "Start");
    const command = Reflect.get(row, "CommandLine");
    if (typeof pid !== "number" || typeof ppid !== "number") continue;
    entries.push({
      pid,
      ppid,
      started: typeof started === "number" || typeof started === "string" ? String(started) : "",
      command: typeof command === "string" ? command : "",
    });
  }
  return entries;
}

/** A process the snapshot may name: one whose identity can be checked again later. */
function identifiable(entry: ProcessEntry) {
  return entry.pid > 1 && entry.started.length > 0 && entry.command.length > 0;
}

/**
 * The direct child of `ancestorPid` whose command line carries one of `flags` as a whole
 * argument, followed by everything below it; nothing when no such process runs, or when
 * more than one does (the CLI cannot be told apart then).
 */
export function markedProcessTree(
  table: ReadonlyArray<ProcessEntry>,
  ancestorPid: number,
  flags: ReadonlyArray<string>,
): ProcessEntry[] {
  const wanted = flags.filter((flag) => flag.length > 0);
  if (wanted.length === 0) return [];
  const carries = (command: string) =>
    command
      .split(/\s+/u)
      .map((argument) => argument.replace(/^["']|["']$/gu, ""))
      .some((argument) => wanted.includes(argument));
  const roots = table.filter(
    (entry) =>
      entry.ppid === ancestorPid &&
      entry.pid !== ancestorPid &&
      identifiable(entry) &&
      carries(entry.command),
  );
  if (roots.length !== 1) return [];
  const root = roots[0]!;
  const children = new Map<number, ProcessEntry[]>();
  for (const entry of table) {
    if (entry.pid === entry.ppid) continue;
    const list = children.get(entry.ppid);
    if (list === undefined) children.set(entry.ppid, [entry]);
    else list.push(entry);
  }
  // Never the server itself, even when a corrupt table lists it below the CLI.
  const seen = new Set<number>([ancestorPid, root.pid]);
  const tree: ProcessEntry[] = [root];
  const queue = [...(children.get(root.pid) ?? [])];
  while (queue.length > 0) {
    const entry = queue.shift()!;
    if (seen.has(entry.pid)) continue;
    seen.add(entry.pid);
    if (identifiable(entry)) tree.push(entry);
    queue.push(...(children.get(entry.pid) ?? []));
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
      identifiable(entry) &&
      now !== undefined &&
      now.started === entry.started &&
      now.command === entry.command
    );
  });
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
  "@{n='Start';e={if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { $null }}}," +
  "CommandLine | ConvertTo-Json -Compress";

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
    ["-A", "-o", "pid=,ppid=,lstart=,args="],
    10_000,
    { ...process.env, LC_ALL: "C" },
  );
  return text === undefined ? undefined : parsePosixProcessList(text);
}

export interface MarkedTreeHost {
  readonly platform: NodeJS.Platform;
  readonly ancestorPid: number;
  readonly readProcessList: () => Promise<ReadonlyArray<ProcessEntry> | undefined>;
  readonly signal: (pid: number, signal: NodeJS.Signals) => void;
  /** `taskkill /F`, with `/T` when `tree` is set. */
  readonly taskkill: (pid: number, tree: boolean) => Promise<void>;
  readonly sleep: (ms: number) => Promise<void>;
}

export const nodeMarkedTreeHost = (): MarkedTreeHost => ({
  platform: process.platform,
  ancestorPid: process.pid,
  readProcessList: () => readProcessList(process.platform),
  signal: (pid, signal) => process.kill(pid, signal),
  taskkill: async (pid, tree) => {
    await run("taskkill", ["/PID", String(pid), ...(tree ? ["/T"] : []), "/F"], 10_000);
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

/** The process tree of the CLI carrying one of `flags`, read while it still runs. */
export async function snapshotMarkedTree(
  flags: ReadonlyArray<string>,
  host: MarkedTreeHost = nodeMarkedTreeHost(),
): Promise<ProcessEntry[]> {
  try {
    const table = await host.readProcessList();
    return table === undefined ? [] : markedProcessTree(table, host.ancestorPid, flags);
  } catch {
    return [];
  }
}

/**
 * Ends what of a snapshot still runs. Resolves to how many processes were still running,
 * so the caller can log that Stop had to end them. It keeps going after a caller's
 * timeout gives up on it: every step is bounded and checks identity first.
 */
export async function endSnapshotSurvivors(
  snapshot: ReadonlyArray<ProcessEntry>,
  host: MarkedTreeHost = nodeMarkedTreeHost(),
  graceMs = 1_000,
): Promise<number> {
  const owned = snapshot.filter((entry) => entry.pid !== host.ancestorPid && identifiable(entry));
  if (owned.length === 0) return 0;
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
    const alive = stillRunning(owned, table);
    if (alive.length === 0) return 0;
    if (host.platform === "win32") {
      const [root] = owned;
      // The CLI itself, still the same process: /T ends what it started since the snapshot.
      if (root !== undefined && alive.some((entry) => entry.pid === root.pid)) {
        await host.taskkill(root.pid, true);
      }
      // Each orphan on its own, identity checked against a fresh read right before.
      for (const entry of alive) {
        if (entry.pid === root?.pid) continue;
        const now = await host.readProcessList();
        if (now === undefined) break;
        if (stillRunning([entry], now).length === 1) await host.taskkill(entry.pid, false);
      }
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
  /** The process tree of the CLI carrying one of `flags`, or nothing. */
  readonly snapshot: (flags: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<ProcessEntry>>;
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
  snapshot: (flags) => Effect.promise(() => snapshotMarkedTree(flags, host)),
  endSurvivors: (snapshot) => Effect.promise(() => endSnapshotSurvivors(snapshot, host)),
});

export const layer = Layer.sync(MarkedProcessTree, () => make());

/** The command-line flags the Claude Agent SDK gives the CLI of one session. */
export function claudeSessionFlags(sessionId: string): string[] {
  return sessionId.length === 0 ? [] : [`--session-id=${sessionId}`, `--resume=${sessionId}`];
}
