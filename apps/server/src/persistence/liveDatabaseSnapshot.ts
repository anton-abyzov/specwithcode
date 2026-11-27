// @effect-diagnostics nodeBuiltinImport:off -- node:sqlite is the database driver, as in nodeSqliteClient.
/**
 * The one supported way for anything but the service's own connection to
 * read the live database.
 *
 * A reader in another process normally takes part in SQLite's locking. When
 * it finds the database apparently unused, because the service's locks were
 * lost, a normal read-only open (`sqlite3 -readonly`, Python `?mode=ro`,
 * `DatabaseSync(path, { readOnly: true })`) truncates and rebuilds `-shm`
 * under the running service, which then crashes with SIGBUS. `readonly_shm=1`
 * opens `-shm` read-only, so the reader can never rebuild or truncate it, and
 * `mode=ro` keeps it from ever checkpointing or deleting `-wal`. In the
 * reproduction (research note sqlite-crash-2026-10-16) plain read-only
 * readers crashed a service whose `-shm` lock was gone 45 times out of 45;
 * these flags crashed it 0 times out of 192 and every snapshot passed
 * `PRAGMA integrity_check`.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";
import * as NodeWorker from "node:worker_threads";

import { randomBytes } from "../nodeCrypto.ts";
import { LIVE_DATABASE_SUFFIXES } from "./liveDatabaseGuard.ts";

const BUSY_TIMEOUT_MS = 5_000;

/**
 * `file:` URI that opens `dbPath` without being able to change it or its
 * `-wal` and `-shm`. Without `-shm` on disk no process has the current index
 * mapped, and `readonly_shm` could not open the database, so only `mode=ro`.
 */
export function liveDatabaseReadOnlyUri(dbPath: string): string {
  const absolute = NodePath.resolve(dbPath);
  const query = NodeFS.existsSync(`${absolute}-shm`) ? "mode=ro&readonly_shm=1" : "mode=ro";
  return `${NodeURL.pathToFileURL(absolute).href}?${query}`;
}

/** A read-only connection that cannot reset the live database's `-shm` or remove its `-wal`. */
export function openLiveDatabaseReadOnly(dbPath: string): NodeSqlite.DatabaseSync {
  if (!NodeFS.existsSync(dbPath)) {
    throw new Error(`No SpecWithCode database at ${dbPath}.`);
  }
  const database = new NodeSqlite.DatabaseSync(liveDatabaseReadOnlyUri(dbPath), {
    readOnly: true,
  });
  try {
    database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; PRAGMA query_only = ON;`);
  } catch (cause) {
    database.close();
    throw cause;
  }
  return database;
}

// macOS and Windows volumes are case-insensitive by default, and APFS ignores Unicode normalization.
const nameKey = (path: string): string =>
  process.platform === "darwin" || process.platform === "win32"
    ? path.normalize("NFC").toLowerCase()
    : path;

const statOf = (path: string): NodeFS.BigIntStats | undefined => {
  try {
    return NodeFS.statSync(path, { bigint: true, throwIfNoEntry: false });
  } catch {
    return undefined;
  }
};

const realPathOf = (path: string): string => {
  try {
    return NodeFS.realpathSync.native(path);
  } catch {
    return path;
  }
};

/**
 * Whether two paths name one file. File IDs are compared as bigints: NTFS IDs
 * are 64 bits, and as Numbers files made one after another in a folder lose
 * the low bits that tell them apart. An ID of 0 means the volume has none, so
 * the real paths are compared instead.
 */
const sameFile = (left: string, right: string): boolean => {
  const resolvedLeft = NodePath.resolve(left);
  const resolvedRight = NodePath.resolve(right);
  if (nameKey(resolvedLeft) === nameKey(resolvedRight)) return true;
  const a = statOf(resolvedLeft);
  const b = statOf(resolvedRight);
  if (a === undefined || b === undefined) return false;
  if (a.ino === 0n || b.ino === 0n) {
    return nameKey(realPathOf(resolvedLeft)) === nameKey(realPathOf(resolvedRight));
  }
  return a.dev === b.dev && a.ino === b.ino;
};

export interface LiveDatabaseSnapshot {
  readonly path: string;
  readonly bytes: number;
  readonly pages: number;
  readonly quickCheck: string;
}

const GIB = 1024 ** 3;

/**
 * Free space a copy of `bytes` needs beyond its own size: the larger of 1 GiB
 * and a tenth of it. A one-step backup holds one read snapshot for the whole
 * copy, so the live `-wal` cannot checkpoint past it and grows meanwhile.
 */
export const snapshotHeadroom = (bytes: number): number => Math.max(GIB, Math.ceil(bytes / 10));

/** Bytes as people read them on a disk ("18.8 GB"); binary units, as Finder's rounding is close enough. */
export const formatBytes = (bytes: number): string =>
  bytes >= GIB
    ? `${(bytes / GIB).toFixed(1)} GB`
    : `${Math.max(0, Math.round(bytes / 1024 ** 2))} MB`;

/** Bytes an unprivileged process may still write in the folder `dir` (or its nearest existing parent). */
export const freeBytesAt = (dir: string): number => {
  let probe = NodePath.resolve(dir);
  while (!NodeFS.existsSync(probe)) {
    const parent = NodePath.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const stats = NodeFS.statfsSync(probe);
  return Number(stats.bavail) * Number(stats.bsize);
};

/** The destination has less free space than the copy needs; nothing was written. */
export class LiveDatabaseSpaceError extends Error {
  readonly needed: number;
  readonly free: number;
  readonly databaseBytes: number;
  constructor(input: {
    readonly databaseBytes: number;
    readonly free: number;
    readonly dir: string;
  }) {
    const needed = input.databaseBytes + snapshotHeadroom(input.databaseBytes);
    super(
      `Not enough free disk space for the database copy: it needs ${formatBytes(needed)} ` +
        `(the ${formatBytes(input.databaseBytes)} database plus room to spare) and ` +
        `${formatBytes(input.free)} is free where it is saved (${input.dir}). Free some space and it tries again.`,
    );
    this.name = "LiveDatabaseSpaceError";
    this.needed = needed;
    this.free = input.free;
    this.databaseBytes = input.databaseBytes;
  }
}

/** Size of the database a backup would write: every page, free ones included. */
const databaseBytesOf = (source: NodeSqlite.DatabaseSync): number => {
  const pages = Number(Object.values(source.prepare("PRAGMA page_count").get() ?? {})[0]);
  const pageSize = Number(Object.values(source.prepare("PRAGMA page_size").get() ?? {})[0]);
  return pages * pageSize;
};

const PARTIAL_MARK = ".partial-";

/** Whether a process with this id is running (a process we may not signal still counts). */
export const processIsRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Removes the partial files an earlier copy into `target` left behind: those
 * of a process that is no longer running, and this process's own. Call it
 * only while this process runs no copy into `target`. A partial of another
 * running process (a `db snapshot` into the same file) is left alone, as is a
 * name that carries no process id.
 */
export function removeStalePartials(
  target: string,
  isRunning: (pid: number) => boolean = processIsRunning,
): ReadonlyArray<string> {
  const resolved = NodePath.resolve(target);
  const dir = NodePath.dirname(resolved);
  const prefix = `${NodePath.basename(resolved)}${PARTIAL_MARK}`;
  let names: Array<string>;
  try {
    names = NodeFS.readdirSync(dir);
  } catch {
    return [];
  }
  const removed: Array<string> = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const pid = Number(/^(\d+)(?:-|$)/.exec(name.slice(prefix.length))?.[1] ?? Number.NaN);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    if (pid !== process.pid && isRunning(pid)) continue;
    NodeFS.rmSync(NodePath.join(dir, name), { force: true });
    removed.push(name);
  }
  return removed;
}

// Runs in a worker as plain CommonJS: it opens only the copy, never the live database.
const CHECK_COPY_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const first = (row) => Object.values(row ?? {})[0];
const db = new DatabaseSync(workerData.path, workerData.makeSelfContained ? {} : { readOnly: true });
try {
  if (workerData.makeSelfContained) db.exec("PRAGMA journal_mode = DELETE;");
  parentPort.postMessage({
    quickCheck: String(first(db.prepare("PRAGMA quick_check").get())),
    pages: Number(first(db.prepare("PRAGMA page_count").get())),
  });
} finally {
  db.close();
}
`;

/**
 * Runs `PRAGMA quick_check` on a saved copy in a worker thread: it reads the
 * whole file, several seconds per ten gigabytes, which would stall the
 * service's event loop. With `makeSelfContained` the copy is first switched
 * to a rollback journal; otherwise it is opened read-only. Rejects when the
 * file cannot be opened as a database.
 */
export function checkDatabaseCopy(
  path: string,
  options: { readonly makeSelfContained?: boolean } = {},
): Promise<{ readonly quickCheck: string; readonly pages: number }> {
  return new Promise((resolve, reject) => {
    let answer: { readonly quickCheck: string; readonly pages: number } | undefined;
    const worker = new NodeWorker.Worker(CHECK_COPY_WORKER, {
      eval: true,
      workerData: { path, makeSelfContained: options.makeSelfContained === true },
    });
    worker.once("message", (message: { quickCheck: string; pages: number }) => {
      answer = message;
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (answer !== undefined) resolve(answer);
      else reject(new Error(`Checking the database copy stopped early (exit code ${code}).`));
    });
  });
}

export interface SnapshotLiveDatabaseOptions {
  /** Free bytes where the copy is saved; `freeBytesAt` unless a test supplies its own. */
  readonly freeBytes?: (dir: string) => number;
  /** SQLite's online backup; replaced only by tests that make it fail. */
  readonly backup?: typeof NodeSqlite.backup;
}

/**
 * Copies the live database into `outputPath` with SQLite's online backup,
 * through a connection opened by `openLiveDatabaseReadOnly`. The copy is a
 * self-contained rollback-journal database, checked with `quick_check`, and
 * published only once complete.
 *
 * The backup copies every page in one step (`rate: -1`). In steps of a few
 * pages SQLite starts over whenever the service writes between two steps, so
 * a busy multi-gigabyte database is never copied. Before any file is made the
 * destination must have the database's size plus `snapshotHeadroom` free.
 * Each attempt writes its own partial file and removes it when it fails.
 */
export async function snapshotLiveDatabase(
  dbPath: string,
  outputPath: string,
  options: SnapshotLiveDatabaseOptions = {},
): Promise<LiveDatabaseSnapshot> {
  const target = NodePath.resolve(outputPath);
  for (const suffix of LIVE_DATABASE_SUFFIXES) {
    if (sameFile(target, `${dbPath}${suffix}`)) {
      throw new Error(`Refusing to write a snapshot over the live database file ${target}.`);
    }
  }
  if (NodeFS.existsSync(target)) {
    throw new Error(`${target} already exists; choose a new file for the snapshot.`);
  }
  const dir = NodePath.dirname(target);
  const source = openLiveDatabaseReadOnly(dbPath);
  try {
    const databaseBytes = databaseBytesOf(source);
    const free = (options.freeBytes ?? freeBytesAt)(dir);
    if (free < databaseBytes + snapshotHeadroom(databaseBytes)) {
      throw new LiveDatabaseSpaceError({ databaseBytes, free, dir });
    }
    NodeFS.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const partial = `${target}${PARTIAL_MARK}${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
      await (options.backup ?? NodeSqlite.backup)(source, partial, { rate: -1 });
      const { quickCheck, pages } = await checkDatabaseCopy(partial, { makeSelfContained: true });
      if (quickCheck !== "ok") {
        throw new Error(`The snapshot failed PRAGMA quick_check: ${quickCheck}`);
      }
      NodeFS.chmodSync(partial, 0o600);
      NodeFS.renameSync(partial, target);
      return { path: target, bytes: NodeFS.statSync(target).size, pages, quickCheck };
    } finally {
      // After the rename the partial is gone; after a failure this removes it and its journal.
      for (const suffix of LIVE_DATABASE_SUFFIXES) {
        NodeFS.rmSync(`${partial}${suffix}`, { force: true });
      }
    }
  } finally {
    source.close();
  }
}
