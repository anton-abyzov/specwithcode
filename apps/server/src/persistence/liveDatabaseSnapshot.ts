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
const SNAPSHOT_COPY_TIMEOUT_MS = 5 * 60_000;
const SNAPSHOT_BATCH_PAGES = 1_024;
const SNAPSHOT_BUDGET_ERROR =
  "Snapshot exceeded its copy budget. Use db query or retry when database activity is lower.";
const SNAPSHOT_FREE_SPACE_RESERVE = 256 * 1024 ** 2;

function requireSnapshotSpace(directory: string, bytes: number): void {
  const { bavail, bsize } = NodeFS.statfsSync(directory, { bigint: true });
  const required = bytes + SNAPSHOT_FREE_SPACE_RESERVE;
  if (bavail * bsize < BigInt(required)) {
    throw new Error(
      `Not enough free space for the snapshot at ${directory} (need ${required} bytes including the 256 MiB reserve).`,
    );
  }
}

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
  // A sidecar may not exist yet, so compare the resolved parents before stat.
  if (
    nameKey(NodePath.basename(resolvedLeft)) === nameKey(NodePath.basename(resolvedRight)) &&
    nameKey(realPathOf(NodePath.dirname(resolvedLeft))) ===
      nameKey(realPathOf(NodePath.dirname(resolvedRight)))
  ) {
    return true;
  }
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
  if (NodeFS.lstatSync(target, { throwIfNoEntry: false })) {
    throw new Error(`${target} already exists; choose a new file for the snapshot.`);
  }
  NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true, mode: 0o700 });
  const staging = NodeFS.mkdtempSync(NodePath.join(NodePath.dirname(target), ".db-snapshot-"));
  const partial = NodePath.join(staging, "snapshot.sqlite");
  try {
    const source = openLiveDatabaseReadOnly(dbPath);
    try {
      const pageSize = Number(source.prepare("PRAGMA page_size").get()?.page_size);
      const initialPages = Number(source.prepare("PRAGMA page_count").get()?.page_count);
      const batchPages = Math.min(SNAPSHOT_BATCH_PAGES, Math.max(1, initialPages));
      const batchBytes = batchPages * pageSize;
      requireSnapshotSpace(staging, Math.max(initialPages * pageSize, batchBytes));

      const deadline = performance.now() + SNAPSHOT_COPY_TIMEOUT_MS;
      // A concurrent writer may restart the backup. Charge every batch, even
      // when SQLite reports no net progress. Throwing stops the native job
      // before it schedules another batch.
      const maxBatches = 2 * Math.ceil(Math.max(1, initialPages) / batchPages);
      let batches = 0;
      const copiedPages = await NodeSqlite.backup(source, partial, {
        rate: batchPages,
        progress({ totalPages }) {
          if (
            ++batches >= maxBatches ||
            performance.now() >= deadline ||
            totalPages > initialPages
          ) {
            throw new Error(SNAPSHOT_BUDGET_ERROR);
          }
          requireSnapshotSpace(staging, batchBytes);
        },
      });
      if (copiedPages > initialPages || performance.now() >= deadline) {
        throw new Error(SNAPSHOT_BUDGET_ERROR);
      }
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
    const bytes = NodeFS.statSync(partial).size;
    requireSnapshotSpace(staging, 0);
    // Same filesystem, atomic, and fails if another caller claimed the name.
    NodeFS.linkSync(partial, target);
    return { path: target, bytes, pages, quickCheck };
  } finally {
    NodeFS.rmSync(staging, { recursive: true, force: true });
  }
}
