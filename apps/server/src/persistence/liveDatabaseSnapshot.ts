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

const sameFile = (left: string, right: string): boolean => {
  const resolvedLeft = NodePath.resolve(left);
  const resolvedRight = NodePath.resolve(right);
  if (resolvedLeft === resolvedRight) return true;
  try {
    const a = NodeFS.statSync(resolvedLeft);
    const b = NodeFS.statSync(resolvedRight);
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
};

export interface LiveDatabaseSnapshot {
  readonly path: string;
  readonly bytes: number;
  readonly pages: number;
  readonly quickCheck: string;
}

/**
 * Copies the live database into `outputPath` with SQLite's online backup,
 * through a connection opened by `openLiveDatabaseReadOnly`. The copy is a
 * self-contained rollback-journal database, checked with `quick_check`, and
 * published only once complete.
 */
export async function snapshotLiveDatabase(
  dbPath: string,
  outputPath: string,
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
  NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true, mode: 0o700 });
  const partial = `${target}.partial-${process.pid}`;
  NodeFS.rmSync(partial, { force: true });
  try {
    const source = openLiveDatabaseReadOnly(dbPath);
    try {
      await NodeSqlite.backup(source, partial);
    } finally {
      source.close();
    }
    const copy = new NodeSqlite.DatabaseSync(partial);
    let quickCheck: string;
    let pages: number;
    try {
      copy.exec("PRAGMA journal_mode = DELETE;");
      quickCheck = String(Object.values(copy.prepare("PRAGMA quick_check").get() ?? {})[0]);
      pages = Number(Object.values(copy.prepare("PRAGMA page_count").get() ?? {})[0]);
    } finally {
      copy.close();
    }
    if (quickCheck !== "ok") {
      throw new Error(`The snapshot failed PRAGMA quick_check: ${quickCheck}`);
    }
    NodeFS.chmodSync(partial, 0o600);
    NodeFS.renameSync(partial, target);
    return { path: target, bytes: NodeFS.statSync(target).size, pages, quickCheck };
  } finally {
    for (const suffix of LIVE_DATABASE_SUFFIXES) {
      NodeFS.rmSync(`${partial}${suffix}`, { force: true });
    }
  }
}
