/**
 * The processes a provider runtime started, as a ledger built from process-table samples.
 *
 * Provider tools often leave the runtime's process tree: Copilot starts every shell tool in
 * a fresh process group, and `(nohup job &)` reparents the job to launchd once its shell
 * exits. Killing the provider's own group then misses them. The ledger remembers each
 * descendant (pid and start time) and each process group the tree created while it was
 * visible, so teardown can still reach them after their parents are gone. It never admits
 * a process it cannot tie to the tree: a child of a recorded process, or a member of a
 * group whose members were all recorded when the group was first seen.
 *
 * Pure data and functions; ProviderProcessSupervisor samples the table and sends signals.
 */

export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly nice: number;
  /** `ps` lstart: with the pid, it tells a reused pid from the process that had it. */
  readonly startedAt: string;
}

/** `ps -A -o pid=,ppid=,pgid=,nice=,lstart=`, the same on macOS and Linux procps. */
export const PROCESS_TABLE_ARGS = ["-A", "-o", "pid=,ppid=,pgid=,nice=,lstart="] as const;

const ROW_PATTERN = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S.*?)\s*$/;

export function parseProcessTable(output: string): ReadonlyArray<ProcessRow> {
  const rows: Array<ProcessRow> = [];
  for (const line of output.split("\n")) {
    const match = ROW_PATTERN.exec(line);
    if (match === null) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      nice: Number(match[4]),
      startedAt: match[5] ?? "",
    });
  }
  return rows;
}

export interface DescendantLedger {
  readonly rootPid: number;
  /** The provider itself, once a sample has shown it. Never recorded twice: a later
   * process with the same pid is someone else. */
  root: ProcessRow | undefined;
  /** pid to the identity it had when recorded; the root is recorded too. */
  readonly processes: Map<number, ProcessRow>;
  /** Process groups the tree created. Dropped once a sample shows no member left. */
  readonly groups: Set<number>;
}

// A runaway fork loop must not grow the ledger without bound.
const MAX_RECORDED_PROCESSES = 4096;

export function makeDescendantLedger(rootPid: number): DescendantLedger {
  return { rootPid, root: undefined, processes: new Map(), groups: new Set() };
}

const sameProcess = (recorded: ProcessRow, live: ProcessRow | undefined) =>
  live !== undefined && live.startedAt === recorded.startedAt;

/**
 * Updates the ledger from one process-table sample and returns the processes it recorded
 * for the first time. `serverPgid` is never recorded as a group: a provider spawned without
 * its own group shares it with this server.
 */
export function observeDescendants(
  ledger: DescendantLedger,
  table: ReadonlyArray<ProcessRow>,
  serverPgid: number,
): ReadonlyArray<ProcessRow> {
  const byPid = new Map(table.map((row) => [row.pid, row]));
  for (const [pid, recorded] of ledger.processes) {
    if (!sameProcess(recorded, byPid.get(pid))) ledger.processes.delete(pid);
  }
  const children = new Map<number, Array<ProcessRow>>();
  const members = new Map<number, Array<ProcessRow>>();
  const push = (index: Map<number, Array<ProcessRow>>, key: number, row: ProcessRow) => {
    const rows = index.get(key);
    if (rows === undefined) index.set(key, [row]);
    else rows.push(row);
  };
  for (const row of table) {
    push(children, row.ppid, row);
    push(members, row.pgid, row);
  }
  for (const group of ledger.groups) {
    if (!members.has(group)) ledger.groups.delete(group);
  }

  const added: Array<ProcessRow> = [];
  const pending: Array<ProcessRow> = [];
  const record = (row: ProcessRow) => {
    if (ledger.processes.has(row.pid) || row.pid <= 1) return;
    if (ledger.processes.size >= MAX_RECORDED_PROCESSES) return;
    ledger.processes.set(row.pid, row);
    added.push(row);
    pending.push(row);
  };
  if (ledger.root === undefined) {
    const root = byPid.get(ledger.rootPid);
    if (root !== undefined) {
      ledger.root = root;
      record(root);
    }
  }
  // The live row, not the recorded one: a process that called setsid since it was recorded
  // is now in its own group, and that group must be considered for the ledger.
  for (const recorded of ledger.processes.values())
    pending.push(byPid.get(recorded.pid) ?? recorded);
  for (const group of ledger.groups) for (const row of members.get(group) ?? []) record(row);

  while (pending.length > 0) {
    const parent = pending.pop();
    if (parent === undefined) break;
    for (const child of children.get(parent.pid) ?? []) record(child);
    const group = parent.pgid;
    if (ledger.groups.has(group) || group <= 1 || group === serverPgid) continue;
    // A group joins the ledger only when every live member is already a recorded
    // descendant, so a group this tree merely joined is never taken over.
    const groupMembers = members.get(group) ?? [];
    if (groupMembers.every((member) => ledger.processes.has(member.pid))) {
      ledger.groups.add(group);
    }
  }
  return added;
}

export type ReapTarget =
  | { readonly kind: "group"; readonly pgid: number }
  | { readonly kind: "process"; readonly pid: number };

/**
 * What to signal so nothing the ledger holds survives: each recorded group as a whole, and
 * each recorded process outside those groups on its own. The root (the provider itself)
 * and its group while it is alive are left to the runtime's own shutdown, which ends them
 * gracefully; this server, its group and pid 1 are never targets.
 */
export function reapTargets(
  ledger: DescendantLedger,
  table: ReadonlyArray<ProcessRow>,
  server: { readonly pid: number; readonly pgid: number },
): ReadonlyArray<ReapTarget> {
  const byPid = new Map(table.map((row) => [row.pid, row]));
  const root = ledger.root;
  const rootGroup =
    root !== undefined && sameProcess(root, byPid.get(root.pid))
      ? byPid.get(root.pid)?.pgid
      : undefined;
  const livePgids = new Set(table.map((row) => row.pgid));
  const groups = [...ledger.groups].filter(
    (group) => group > 1 && group !== server.pgid && group !== rootGroup && livePgids.has(group),
  );
  const grouped = new Set(groups);
  const processes = [...ledger.processes.values()].filter((recorded) => {
    const live = byPid.get(recorded.pid);
    return (
      recorded.pid > 1 &&
      recorded !== ledger.root &&
      recorded.pid !== server.pid &&
      sameProcess(recorded, live) &&
      live !== undefined &&
      !grouped.has(live.pgid)
    );
  });
  return [
    ...groups.map((pgid) => ({ kind: "group" as const, pgid })),
    ...processes.map((row) => ({ kind: "process" as const, pid: row.pid })),
  ];
}
