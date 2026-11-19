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
  /**
   * Wall-clock time (epoch ms) this server saw the CLI exit, or null while it runs. A row
   * with the CLI's pid created before then is the CLI: nothing else could hold its pid from
   * the spawn until its exit, and a process holding it before the spawn would have kept it.
   */
  readonly exitedAtEpochMs?: () => number | null;
}

/**
 * Whether `row` (with the root's pid) is the CLI: while the CLI runs, as the identity an
 * earlier reading recorded, or created before the CLI's exit (the reading caught the CLI
 * itself, though it exited before the rows came back).
 */
function rowIsRoot(row: ProcessEntry, root: OwnedRoot, known: Known | undefined): boolean {
  if (!/^\d+$/u.test(row.started)) return false;
  if (known !== undefined) return known.entry.started === row.started;
  if (root.alive()) return true;
  const exitedAt = root.exitedAtEpochMs?.() ?? null;
  return exitedAt !== null && BigInt(row.started) <= BigInt(filetimeFromEpochMs(exitedAt + 1));
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
  // The CLI's row counts while the CLI runs, or when it is the CLI an earlier reading
  // identified (same pid and creation time): the reading caught it alive, so what it lists
  // as its children are, even if the CLI exited before the reading came back.
  const rootKnown = remembered.get(root.pid);
  if (rootRow !== undefined && rowIsRoot(rootRow, root, rootKnown)) {
    add(
      rootRow,
      rootKnown?.entry.started === rootRow.started ? rootKnown.created : BigInt(rootRow.started),
    );
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
 * Processes the reading cannot attribute, or rule out, from what it lists: children of the
 * tree without a usable creation time, and children of a process an earlier reading
 * attributed that has exited since (its pid alone proves nothing, so they are never
 * killed, but nothing proves they are not the tree's either).
 */
export function unidentifiedChildren(
  table: ReadonlyArray<ProcessEntry>,
  tree: ReadonlyArray<Known>,
  /** Each pid's identities attributed by earlier readings, oldest first. */
  remembered: ReadonlyMap<number, ReadonlyArray<Known>> = new Map(),
  /** Processes already in doubt, by pid and start: what they started is in doubt too. */
  doubtful: ReadonlyMap<number, string> = new Map(),
): Map<number, string> {
  const parents = new Set(tree.map((known) => known.entry.pid));
  const live = new Set(table.map((entry) => `${entry.pid}:${entry.started}`));
  const byPid = new Map(table.map((entry) => [entry.pid, entry]));
  const startOf = (started: string) => (/^\d+$/u.test(started) ? BigInt(started) : null);
  const doubt = new Map<number, string>();
  for (const entry of table) {
    if (parents.has(entry.pid)) continue;
    const start = startOf(entry.started);
    if (parents.has(entry.ppid) && start === null) {
      doubt.set(entry.pid, entry.started);
      continue;
    }
    // An earlier owner of the parent pid that no longer runs, created before this row:
    // the row may be what it started, even if the pid now names another of the tree's.
    const exitedOwner = (remembered.get(entry.ppid) ?? []).some(
      (parent) =>
        !live.has(`${parent.entry.pid}:${parent.entry.started}`) &&
        (start === null || start >= parent.created),
    );
    if (exitedOwner) doubt.set(entry.pid, entry.started);
  }
  // Doubt passes down: a process started by one in doubt may be the tree's as well. One in
  // doubt since an earlier reading passes it on whether it still runs or exited, even
  // when its pid now names another process.
  const queue: Array<{ readonly pid: number; readonly start: bigint | null }> = [];
  for (const [pid, entry] of doubt) queue.push({ pid, start: startOf(entry) });
  for (const [pid, started] of doubtful) {
    const row = byPid.get(pid);
    // A start missing from either reading cannot tell the process from a newer one: it
    // stays in doubt, keeping whichever start is known.
    const same =
      row !== undefined && (row.started === started || row.started === "" || started === "");
    if (same && !parents.has(pid)) doubt.set(pid, started === "" ? row.started : started);
    queue.push({ pid, start: startOf(started === "" && same ? row.started : started) });
  }
  const walked = new Set<string>();
  while (queue.length > 0) {
    const parent = queue.shift()!;
    const key = `${parent.pid}:${parent.start}`;
    if (walked.has(key)) continue;
    walked.add(key);
    for (const entry of table) {
      if (entry.ppid !== parent.pid || entry.pid === parent.pid || parents.has(entry.pid)) continue;
      if (doubt.has(entry.pid)) continue;
      const start = startOf(entry.started);
      if (parent.start !== null && start !== null && start < parent.start) continue;
      doubt.set(entry.pid, entry.started);
      queue.push({ pid: entry.pid, start });
    }
  }
  return doubt;
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
  /** False once the group id may belong to another job: its members are then not walked. */
  groupOwned = true,
  /** Tools known to be the CLI's (verified still the same process), walked for their children. */
  from: ReadonlyArray<number> = [],
): ProcessEntry[] {
  const children = new Map<number, ProcessEntry[]>();
  for (const entry of table) {
    if (entry.pid === entry.ppid) continue;
    const list = children.get(entry.ppid);
    if (list === undefined) children.set(entry.ppid, [entry]);
    else list.push(entry);
  }
  const seen = new Set<number>([selfPid]);
  const queue = groupOwned
    ? table.filter((entry) => entry.pgid === root.pid).map((entry) => entry.pid)
    : [];
  if (root.alive()) queue.push(root.pid);
  queue.push(...from);
  const escapees: ProcessEntry[] = [];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      // In the CLI's group a child is reached by the group signal, but only while that
      // group is provably the CLI's; otherwise its verified parent is what attributes it.
      if ((child.pgid !== root.pid || !groupOwned) && child.started.length > 0) {
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
  /** Every identity a pid had in the tree: a reused pid must not erase its older owner. */
  private readonly history = new Map<number, Known[]>();
  /** POSIX tools seen outside the CLI's group, kept until an end confirms them gone. */
  private readonly escapees = new Map<number, ProcessEntry>();
  /** POSIX members of the CLI's group seen by an earlier end, by pid and start. */
  private readonly groupSeen = new Map<number, string>();
  /** The CLI's group was seen empty: its id may now belong to another job. */
  private groupRetired = false;
  /** The CLI's own start, read while it ran, to tell a new leader of its group id. */
  private rootStarted: string | null = null;
  private endedOnce = false;
  /**
   * A table read failed while the tree wound down after a signal: what a process started
   * then (a helper launched on SIGTERM) may never be found, so no later end confirms.
   */
  private coverageLost = false;
  /** A reading meant to catch what the CLI started failed, so an empty tree proves nothing. */
  private unconfirmed = false;
  /**
   * A required reading succeeded and came back with the CLI already exited: it covered
   * everything the CLI started, and an exited CLI starts nothing more.
   */
  private coveredToExit = false;
  /**
   * Windows children of the tree seen without a creation time. Each stays a doubt until a
   * reading attributes it or no longer lists its pid (it exited).
   */
  private readonly unidentified = new Map<number, string>();
  private ending: Promise<TreeEndResult> | null = null;
  readonly root: OwnedRoot;
  private readonly host: TreeHost;

  constructor(root: OwnedRoot, host: TreeHost) {
    this.root = root;
    this.host = host;
  }

  /**
   * Reads the tree while the CLI runs; false when the reading failed. With `required`
   * (the reading right before Stop closes the CLI) a failure marks the tree unconfirmed:
   * a tool started since the last reading cannot be found once its parent is gone.
   */
  async remember(timeoutMs = STEP_TIMEOUT_MS, required = false): Promise<boolean> {
    if (this.host.platform !== "win32" || this.root.pid <= 1) return true;
    const table = await this.host.readProcessList(timeoutMs).catch(() => undefined);
    const known =
      table === undefined ? [] : windowsTree(table, this.root, this.host.selfPid, this.remembered);
    for (const entry of known) this.recall(entry);
    if (table !== undefined) this.noteUnidentified(table, known);
    // The reading must list the CLI itself: while it runs, or as the CLI an earlier
    // reading identified (it exited after this reading caught it).
    const ok = table !== undefined && this.listsRoot(table) && this.unidentified.size === 0;
    // Before a close, only a reading that lists the running CLI itself covers what it
    // started; a cached identity from an earlier reading does not.
    // The last such reading decides: one that succeeds right before the close covers
    // everything then running.
    // A reading that came back after the CLI exited covers all it started, so a later one
    // (which no longer lists the exited CLI) changes nothing.
    if (required && !this.coveredToExit) {
      this.unconfirmed = !ok;
      if (ok && !this.root.alive()) this.coveredToExit = true;
    }
    return ok;
  }

  private recall(known: Known) {
    this.remembered.set(known.entry.pid, known);
    const past = this.history.get(known.entry.pid);
    if (past === undefined) this.history.set(known.entry.pid, [known]);
    else if (!past.some((entry) => entry.entry.started === known.entry.started)) past.push(known);
  }

  private noteUnidentified(table: ReadonlyArray<ProcessEntry>, tree: ReadonlyArray<Known>) {
    const before = new Map(this.unidentified);
    // Each doubt is checked again from this reading, starting from those already held.
    this.unidentified.clear();
    for (const [pid, started] of unidentifiedChildren(table, tree, this.history, before)) {
      this.unidentified.set(pid, started);
    }
  }

  /**
   * Whether `table` lists the CLI: as the process an earlier reading identified, or, with
   * no such reading, while it still runs.
   */
  private listsRoot(table: ReadonlyArray<ProcessEntry>): boolean {
    const row = table.find((entry) => entry.pid === this.root.pid);
    return row !== undefined && rowIsRoot(row, this.root, this.remembered.get(this.root.pid));
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
    // Whole milliseconds: subprocess timeouts refuse fractions.
    return Math.max(0, Math.floor(Math.min(STEP_TIMEOUT_MS, deadline - this.host.now())));
  }

  private read(deadline: number) {
    const budget = this.budget(deadline);
    if (budget <= 0) return Promise.resolve(undefined);
    return this.host.readProcessList(budget).catch(() => undefined);
  }

  private groupState(): "alive" | "gone" | "denied" {
    try {
      this.host.signal(-this.root.pid, 0);
      return "alive";
    } catch (error) {
      // ESRCH: no member left. EPERM: members run that this server may not signal (one
      // that changed user, or another user's job): not gone, and not endable from here.
      return (error as { code?: unknown } | null)?.code === "EPERM" ? "denied" : "gone";
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
    // Without a table the group is still signalled, but tools that left it cannot be found,
    // then or by a later end once the signal ended their parents.
    let unknown = table === undefined;
    const members = table?.filter(
      (entry) => entry.pgid === this.root.pid && entry.pid !== host.selfPid,
    );
    // A later try with the CLI gone: its group id is free for reuse once the group empties,
    // so the group is acted on only while a member an earlier end saw is still in it.
    let groupUsable = !this.groupRetired;
    if (members !== undefined && this.root.alive()) {
      const cli = members.find((entry) => entry.pid === this.root.pid);
      if (cli !== undefined) this.rootStarted = cli.started;
    }
    if (groupUsable && this.endedOnce && !this.root.alive()) {
      if (members === undefined) {
        groupUsable = false;
        unknown = true;
        // Whoever is in the group now may leave it before a later end can look.
        this.coverageLost = true;
      } else if (members.length === 0) {
        this.groupRetired = true;
        groupUsable = false;
      } else if (!members.some((entry) => this.groupSeen.get(entry.pid) === entry.started)) {
        // Nobody seen before: either a new job leads the id now (a leader with the CLI's
        // pid but another start), or members this tree never read. Only the first is
        // certain; the second is neither signalled nor taken as gone.
        const newLeader = members.some(
          (entry) =>
            entry.pid === this.root.pid &&
            this.rootStarted !== null &&
            entry.started !== this.rootStarted,
        );
        if (newLeader) this.groupRetired = true;
        else {
          // Neither attributed nor ruled out, now or once they leave the group.
          unknown = true;
          this.coverageLost = true;
        }
        groupUsable = false;
      }
    }
    const retry = this.endedOnce;
    this.endedOnce = true;
    if (members !== undefined && groupUsable) {
      if (members.length === 0) this.groupRetired = true;
      for (const entry of members) this.groupSeen.set(entry.pid, entry.started);
    }
    const groupAlive = () => {
      if (!groupUsable || this.groupRetired) return false;
      const state = this.groupState();
      if (state === "alive") return true;
      if (state === "denied") {
        // Members it may not signal may leave the group before a later end can look.
        unknown = true;
        this.coverageLost = true;
      } else this.groupRetired = true;
      return false;
    };
    if (table !== undefined) {
      // Tools that left the group are kept across ends, so a retry still knows them.
      // Group members an earlier end saw that now run in another group left it (setsid on
      // SIGTERM): they are the CLI's escapees, whatever became of the group since.
      for (const entry of table) {
        if (
          entry.pid !== host.selfPid &&
          entry.pgid !== this.root.pid &&
          entry.started.length > 0 &&
          this.groupSeen.get(entry.pid) === entry.started
        ) {
          this.escapees.set(entry.pid, entry);
        }
      }
      // Walked from the group only while it is the CLI's, and from tools already known.
      const known = stillRunning([...this.escapees.values()], table).map((entry) => entry.pid);
      for (const entry of posixEscapees(table, this.root, host.selfPid, groupUsable, known)) {
        this.escapees.set(entry.pid, entry);
      }
    }
    let escapees = [...this.escapees.values()];
    if (table !== undefined) escapees = stillRunning(escapees, table);
    const groupMembers = !groupUsable
      ? 0
      : members === undefined
        ? groupAlive()
          ? 1
          : 0
        : members.length;
    const found = groupMembers + escapees.length;
    const settle = (survivors: number): TreeEndResult => {
      if (!unknown) {
        this.escapees.clear();
        for (const entry of escapees) this.escapees.set(entry.pid, entry);
      }
      return { found, survivors, unknown: unknown || this.coverageLost };
    };
    if (found === 0) return settle(0);
    // Each escapee is signalled only right after a read shows it is still the same process.
    // Known tools that still run, plus what each started since (a helper launched from a
    // SIGTERM handler), read while the parent link still names them.
    const withDescendants = (
      now: ReadonlyArray<ProcessEntry>,
      extra: ReadonlyArray<ProcessEntry> = [],
      fromGroup = false,
    ) => {
      const byPid = new Map(stillRunning(escapees, now).map((entry) => [entry.pid, entry]));
      for (const entry of extra) byPid.set(entry.pid, entry);
      const from = [...byPid.keys()];
      for (const entry of posixEscapees(now, this.root, host.selfPid, fromGroup, from)) {
        byPid.set(entry.pid, entry);
      }
      for (const entry of byPid.values()) this.escapees.set(entry.pid, entry);
      return [...byPid.values()];
    };
    const signalEscapees = async (signal: NodeJS.Signals) => {
      if (escapees.length === 0) return;
      const now = await this.read(deadline);
      if (now === undefined) {
        // An escapee may start a helper and exit before the next reading: lost for good.
        unknown = true;
        this.coverageLost = true;
        return;
      }
      refresh(now);
      for (const entry of escapees) {
        try {
          host.signal(entry.pid, signal);
        } catch {
          // Gone since the read.
        }
      }
    };
    // The group's members this end saw: one that leaves the group (setsid on SIGTERM)
    // empties it without ending, so an empty group is checked against them by identity.
    const seenMembers = groupUsable ? (members ?? []) : [];
    // The group id still names the CLI's group only while a member this end saw is in it;
    // once they are all gone the id may be recycled, so the group is no longer walked or
    // signalled.
    const ownsGroup = (now: ReadonlyArray<ProcessEntry>) =>
      groupUsable &&
      !this.groupRetired &&
      now.some(
        (entry) => entry.pgid === this.root.pid && this.groupSeen.get(entry.pid) === entry.started,
      );
    // Reads the table: members that left the group, and what any known process started
    // since (a helper launched on SIGTERM), become escapees while their parents still run.
    const refresh = (now: ReadonlyArray<ProcessEntry>) => {
      // Any process ever seen in the group, found running outside it, left it.
      const leavers = now.filter(
        (entry) =>
          entry.pid !== host.selfPid &&
          entry.pgid !== this.root.pid &&
          entry.started.length > 0 &&
          this.groupSeen.get(entry.pid) === entry.started,
      );
      const owned = ownsGroup(now);
      // Listed in the group, but none of them one this end saw: not provably the CLI's, and
      // they may leave the group (or it may empty) before anyone looks again.
      const unaccounted =
        !owned &&
        groupUsable &&
        !this.groupRetired &&
        now.some((entry) => entry.pgid === this.root.pid && entry.pid !== host.selfPid);
      if (unaccounted) {
        unknown = true;
        this.coverageLost = true;
      }
      // Members joined since (forked by a seen member) carry the group's continuity on.
      if (owned) {
        for (const entry of now) {
          if (entry.pgid === this.root.pid && entry.pid !== host.selfPid) {
            this.groupSeen.set(entry.pid, entry.started);
          }
        }
      }
      if (!owned && groupUsable && !this.groupRetired && groupAlive()) {
        // Members are listed in the group, but none this end saw: not provably the CLI's,
        // and not provably someone else's, now or on a later end.
        groupUsable = false;
        unknown = true;
        this.coverageLost = true;
      }
      escapees = withDescendants(now, leavers, owned);
    };
    const settled = async (until: number) => {
      while (host.now() < until) {
        const alive = groupAlive();
        if (!alive && escapees.length === 0 && seenMembers.length === 0) return true;
        const now = await this.read(Math.min(until, deadline));
        if (now === undefined) {
          // Nothing tells whether a member left the group, or started a helper, instead
          // of ending; a later end cannot find out either.
          if (seenMembers.length > 0 || escapees.length > 0) {
            unknown = true;
            this.coverageLost = true;
          }
          if (!groupAlive() && escapees.length === 0) return true;
        } else {
          refresh(now);
          if (!groupAlive() && escapees.length === 0) return true;
        }
        await host.sleep(Math.max(0, Math.min(200, until - host.now())));
      }
      return false;
    };
    if (groupAlive()) {
      if (table === undefined) this.coverageLost = true;
      this.signalGroup("SIGTERM");
    }
    await signalEscapees("SIGTERM");
    const grace = host.now() + Math.max(0, (deadline - host.now()) / 2);
    if (await settled(grace)) return settle(0);
    if (groupAlive()) {
      // What a member started on SIGTERM outside the group (a detached helper) is read
      // while the member still runs: once SIGKILL ends it, the helper names no parent.
      const now = await this.read(deadline);
      if (now === undefined) {
        if (seenMembers.length > 0) {
          unknown = true;
          this.coverageLost = true;
        }
        // On a retry the group id may have been recycled since the last proof of
        // ownership, so without a reading it is not signalled.
        if (retry) groupUsable = false;
      } else refresh(now);
      if (groupAlive()) this.signalGroup("SIGKILL");
    }
    await signalEscapees("SIGKILL");
    if (await settled(deadline)) return settle(0);
    return settle((groupAlive() ? 1 : 0) + escapees.length);
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
      for (const known of left) this.recall(known);
      this.noteUnidentified(table, left);
      if (found === -1) found = left.length;
      // A live CLI missing from the table, or a child of the tree listed without its
      // creation time, is a reading that cannot confirm the end.
      const partial = (this.root.alive() && !this.listsRoot(table)) || this.unidentified.size > 0;
      if (left.length === 0)
        return { found, survivors: 0, unknown: !rootKnown() || this.unconfirmed || partial };
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
    // Kept like every reading's: a retry still knows a survivor once its parent exits.
    for (const known of left) this.recall(known);
    this.noteUnidentified(table, left);
    return {
      found: Math.max(found, 0),
      survivors: left.length,
      unknown:
        left.length === 0 &&
        (!rootKnown() ||
          this.unconfirmed ||
          this.unidentified.size > 0 ||
          (this.root.alive() && !this.listsRoot(table))),
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
          timeout: Math.max(1, Math.floor(timeoutMs)),
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
  let exitedAtEpochMs: number | null = null;
  child.once("exit", () => {
    exited = true;
    exitedAtEpochMs = Date.now();
  });
  const tree = new OwnedProcessTree(
    {
      pid: child.pid ?? 0,
      spawnedAt,
      alive: () => !exited && child.pid !== undefined && child.exitCode === null,
      exitedAtEpochMs: () => exitedAtEpochMs,
    },
    host,
  );
  // The CLI's own identity is what lets a later end find its orphans: try again while
  // it runs if the first reading fails (a busy Windows host can be slow to answer).
  void (async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (await tree.remember()) return;
      if (!tree.root.alive()) return;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  })();
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
