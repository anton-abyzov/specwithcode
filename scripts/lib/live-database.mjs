// The way scripts read a database a running SpecWithCode service holds.
//
// A plain read-only open (`new DatabaseSync(path, { readOnly: true })`,
// `sqlite3 -readonly`, Python `?mode=ro`) still opens `-shm` read-write. If
// the service has lost its POSIX locks, that reader truncates and rebuilds
// `-shm` under the service's memory map and the service dies with SIGBUS.
// `readonly_shm=1` opens `-shm` read-only, so the reader cannot. Without
// `-shm` on disk no process has the index mapped, and `readonly_shm` could
// not open the database, so only `mode=ro` is used. The server's own copy of
// this rule is apps/server/src/persistence/liveDatabaseSnapshot.ts; Python's
// is scripts/studio-fleet/live_database.py.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

export function liveDatabaseReadOnlyUri(path) {
  const absolute = NodePath.resolve(path);
  const query = NodeFS.existsSync(`${absolute}-shm`) ? "mode=ro&readonly_shm=1" : "mode=ro";
  return `${NodeURL.pathToFileURL(absolute).href}?${query}`;
}

export function openLiveDatabaseReadOnly(path) {
  if (!NodeFS.existsSync(path)) throw new Error(`No SpecWithCode database at ${path}.`);
  const database = new NodeSqlite.DatabaseSync(liveDatabaseReadOnlyUri(path), { readOnly: true });
  database.exec("PRAGMA busy_timeout = 5000; PRAGMA query_only = ON;");
  return database;
}
