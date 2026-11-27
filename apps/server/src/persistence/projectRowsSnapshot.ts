// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- plain node:sqlite and fs code, as in liveDatabaseSnapshot; the copy stamps its own time.
/**
 * A copy of one project's rows: for every table of the live database with a
 * `project_id` column, its schema and only that project's rows. The Percy
 * join saves one before it links (1448 AC-13, 1505 D-01), instead of the
 * whole database.
 *
 * The live database is read only through `openLiveDatabaseReadOnly`, in one
 * read transaction, so every table is read at the same moment.
 *
 * @module projectRowsSnapshot
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { randomBytes } from "../nodeCrypto.ts";
import { LIVE_DATABASE_SUFFIXES } from "./liveDatabaseGuard.ts";
import {
  checkDatabaseCopy,
  freeBytesAt,
  LiveDatabaseSpaceError,
  openLiveDatabaseReadOnly,
  publishWithoutReplacing,
  snapshotHeadroom,
} from "./liveDatabaseSnapshot.ts";

/** The table the copy describes itself in. */
export const COPY_INFO_TABLE = "swc_copy_info";

export interface ProjectRowsSnapshot {
  readonly path: string;
  readonly bytes: number;
  readonly pages: number;
  readonly quickCheck: string;
  /** Rows copied per table, for tables that had any. */
  readonly rows: Readonly<Record<string, number>>;
}

export interface ProjectRowsSnapshotOptions {
  /** Free bytes where the copy is saved; `freeBytesAt` unless a test supplies its own. */
  readonly freeBytes?: (dir: string) => number;
  readonly now?: () => Date;
}

const quoteIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`;

interface ScopedTable {
  readonly name: string;
  readonly sql: string;
  readonly columns: ReadonlyArray<string>;
}

/** Tables with a `project_id` column, with their `CREATE TABLE` text. */
const scopedTablesOf = (source: NodeSqlite.DatabaseSync): ReadonlyArray<ScopedTable> => {
  const tables = source
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY name",
    )
    .all() as unknown as ReadonlyArray<{ name: string; sql: string }>;
  const scoped: Array<ScopedTable> = [];
  for (const table of tables) {
    // Virtual tables (full-text indexes) cannot be recreated by their CREATE text alone.
    if (/^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(table.sql)) continue;
    const columns = (
      source
        .prepare(`PRAGMA table_info(${quoteIdentifier(table.name)})`)
        .all() as unknown as ReadonlyArray<{
        name: string;
      }>
    ).map((column) => column.name);
    if (columns.includes("project_id")) scoped.push({ ...table, columns });
  }
  return scoped;
};

/** Bytes the project's rows take, summed over every column, before anything is written. */
const estimateBytes = (
  source: NodeSqlite.DatabaseSync,
  tables: ReadonlyArray<ScopedTable>,
  projectId: string,
): number => {
  let bytes = 0;
  for (const table of tables) {
    const sum = table.columns
      .map((column) => `COALESCE(length(CAST(${quoteIdentifier(column)} AS BLOB)), 0)`)
      .join(" + ");
    const row = source
      .prepare(
        `SELECT COALESCE(SUM(${sum}), 0) AS bytes FROM ${quoteIdentifier(table.name)} WHERE project_id = ?`,
      )
      .get(projectId) as { bytes: number | bigint } | undefined;
    bytes += Number(row?.bytes ?? 0);
  }
  return bytes;
};

/**
 * The project a saved copy holds, from its `swc_copy_info` row, or undefined
 * when the file is not such a copy (another database, a whole-database copy
 * from before 1505, an unreadable file). Opens only the saved copy, read-only.
 */
export function copiedProjectOf(path: string): string | undefined {
  let copy: NodeSqlite.DatabaseSync | undefined;
  try {
    copy = new NodeSqlite.DatabaseSync(path, { readOnly: true });
    const rows = copy
      .prepare(`SELECT project_id FROM ${COPY_INFO_TABLE}`)
      .all() as unknown as ReadonlyArray<{ project_id: unknown }>;
    const only = rows.length === 1 ? rows[0]?.project_id : undefined;
    return typeof only === "string" ? only : undefined;
  } catch {
    return undefined;
  } finally {
    copy?.close();
  }
}

/**
 * Saves `projectId`'s rows of the live database at `dbPath` into
 * `outputPath`. Before any file is made the destination must have the rows'
 * size plus `snapshotHeadroom` free. The copy is checked with `quick_check`
 * in a worker and published only where no file is yet.
 */
export async function snapshotProjectRows(
  dbPath: string,
  outputPath: string,
  projectId: string,
  options: ProjectRowsSnapshotOptions = {},
): Promise<ProjectRowsSnapshot> {
  const target = NodePath.resolve(outputPath);
  if (NodeFS.existsSync(target)) {
    throw new Error(`${target} already exists; choose a new file for the copy.`);
  }
  const dir = NodePath.dirname(target);
  const partial = `${target}.partial-${process.pid}-${randomBytes(4).toString("hex")}`;
  const rows: Record<string, number> = {};
  const source = openLiveDatabaseReadOnly(dbPath);
  try {
    // One read transaction: every table, the estimate and the copy see the same moment.
    source.exec("BEGIN");
    try {
      const tables = scopedTablesOf(source);
      const estimated = estimateBytes(source, tables, projectId);
      const free = (options.freeBytes ?? freeBytesAt)(dir);
      if (free < estimated + snapshotHeadroom(estimated)) {
        throw new LiveDatabaseSpaceError({ databaseBytes: estimated, free, dir });
      }
      const userVersion = Number(
        Object.values(source.prepare("PRAGMA user_version").get() ?? {})[0] ?? 0,
      );
      // Text crosses as raw bytes, which only round-trips between UTF-8 files.
      // The service creates its database UTF-8; anything else is refused unread.
      const encoding = String(Object.values(source.prepare("PRAGMA encoding").get() ?? {})[0]);
      if (encoding !== "UTF-8") {
        throw new Error(
          `The database is ${encoding}, not UTF-8; its project rows cannot be copied byte for byte.`,
        );
      }
      NodeFS.mkdirSync(dir, { recursive: true, mode: 0o700 });
      // References to tables left out of the copy must not refuse its rows.
      const copy = new NodeSqlite.DatabaseSync(partial, { enableForeignKeyConstraints: false });
      try {
        copy.exec("PRAGMA journal_mode = DELETE; BEGIN");
        for (const table of tables) {
          copy.exec(table.sql);
          const names = table.columns.map(quoteIdentifier).join(", ");
          // Text crosses as its raw bytes and is cast back to text on insert:
          // a JS string would cut it at an embedded NUL.
          const insert = copy.prepare(
            `INSERT INTO ${quoteIdentifier(table.name)} (${names}) VALUES (${table.columns
              .map(
                (_, index) =>
                  `CASE ?${2 * index + 2} WHEN 'text' THEN CAST(?${2 * index + 1} AS TEXT) ELSE ?${2 * index + 1} END`,
              )
              .join(", ")})`,
          );
          const select = source.prepare(
            `SELECT ${table.columns
              .map((column) => {
                const name = quoteIdentifier(column);
                return `CASE typeof(${name}) WHEN 'text' THEN CAST(${name} AS BLOB) ELSE ${name} END, typeof(${name})`;
              })
              .join(", ")} FROM ${quoteIdentifier(table.name)} WHERE project_id = ?`,
          );
          // Exact integers: ids and counters can pass 2^53.
          select.setReadBigInts(true);
          select.setReturnArrays(true);
          let count = 0;
          for (const row of select.iterate(projectId)) {
            insert.run(...(row as unknown as ReadonlyArray<NodeSqlite.SQLInputValue>));
            count += 1;
          }
          if (count > 0) rows[table.name] = count;
        }
        copy.exec(
          `CREATE TABLE ${COPY_INFO_TABLE} (project_id TEXT NOT NULL, saved_at TEXT NOT NULL, source_user_version INTEGER NOT NULL, tables_json TEXT NOT NULL)`,
        );
        copy
          .prepare(`INSERT INTO ${COPY_INFO_TABLE} VALUES (?, ?, ?, ?)`)
          .run(
            projectId,
            (options.now?.() ?? new Date()).toISOString(),
            userVersion,
            JSON.stringify(rows),
          );
        copy.exec("COMMIT");
      } finally {
        copy.close();
      }
    } finally {
      source.exec("ROLLBACK");
    }
  } catch (error) {
    for (const suffix of LIVE_DATABASE_SUFFIXES)
      NodeFS.rmSync(`${partial}${suffix}`, { force: true });
    throw error;
  } finally {
    source.close();
  }
  try {
    const { quickCheck, pages } = await checkDatabaseCopy(partial);
    if (quickCheck !== "ok") throw new Error(`The copy failed PRAGMA quick_check: ${quickCheck}`);
    NodeFS.chmodSync(partial, 0o600);
    publishWithoutReplacing(partial, target);
    return { path: target, bytes: NodeFS.statSync(target).size, pages, quickCheck, rows };
  } finally {
    for (const suffix of LIVE_DATABASE_SUFFIXES)
      NodeFS.rmSync(`${partial}${suffix}`, { force: true });
  }
}
