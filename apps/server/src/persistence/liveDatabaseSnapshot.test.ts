// @effect-diagnostics nodeBuiltinImport:off -- node:sqlite is the driver under test.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { assert, describe, it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";

import {
  liveDatabaseReadOnlyUri,
  openLiveDatabaseReadOnly,
  snapshotLiveDatabase,
} from "./liveDatabaseSnapshot.ts";

const capacityCheck = vi.hoisted(() => vi.fn<() => boolean>());
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const statfsSync = (path: string, options: { bigint: true }) => {
    const stats = actual.statfsSync(path, options);
    if (capacityCheck()) stats.bavail = 0n;
    return stats;
  };
  return { ...actual, statfsSync };
});

const withHeldDatabase = async (run: (dbPath: string, directory: string, holder: NodeSqlite.DatabaseSync) => Promise<void>) => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-live-db-snapshot-"));
  const dbPath = NodePath.join(directory, "statev2.sqlite");
  const holder = new NodeSqlite.DatabaseSync(dbPath);
  try {
    holder.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
    holder.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
    const insert = holder.prepare("INSERT INTO t(v) VALUES (?)");
    for (let i = 0; i < 250; i++) insert.run(`row ${i}`);
    await run(dbPath, directory, holder);
  } finally {
    capacityCheck.mockReset();
    holder.close();
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
};

describe("liveDatabaseReadOnlyUri", () => {
  it("opens -shm read-only whenever it exists", async () => {
    await withHeldDatabase(async (dbPath) => {
      assert.match(
        liveDatabaseReadOnlyUri(dbPath),
        /^file:\/\/.*statev2\.sqlite\?mode=ro&readonly_shm=1$/,
      );
    });
    // Windows file names cannot contain "?", so "%" stands in for it there.
    const windows = process.platform === "win32";
    const directory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), `studio live db #${windows ? "%" : "?"}`),
    );
    try {
      const uri = liveDatabaseReadOnlyUri(NodePath.join(directory, "statev2.sqlite"));
      assert.match(uri, /\?mode=ro$/);
      assert.include(uri, `studio%20live%20db%20%23${windows ? "%25" : "%3F"}`);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("openLiveDatabaseReadOnly", () => {
  it("reads committed rows from the log and cannot write", async () => {
    await withHeldDatabase(async (dbPath) => {
      const reader = openLiveDatabaseReadOnly(dbPath);
      try {
        assert.equal(reader.prepare("SELECT count(*) AS n FROM t").get()?.n, 250);
        assert.throws(() => reader.exec("INSERT INTO t(v) VALUES ('no')"), /readonly|read-only/i);
      } finally {
        reader.close();
      }
    });
  });
});

describe("snapshotLiveDatabase", () => {
  it("writes a checked, self-contained copy and never overwrites", async () => {
    await withHeldDatabase(async (dbPath, directory) => {
      const output = NodePath.join(directory, "copies", "copy.sqlite");
      const snapshot = await snapshotLiveDatabase(dbPath, output);
      assert.equal(snapshot.path, output);
      assert.equal(snapshot.quickCheck, "ok");
      assert.isFalse(NodeFS.existsSync(`${output}-wal`));
      const copy = new NodeSqlite.DatabaseSync(output, { readOnly: true });
      try {
        assert.equal(copy.prepare("SELECT count(*) AS n FROM t").get()?.n, 250);
        assert.equal(copy.prepare("PRAGMA journal_mode").get()?.journal_mode, "delete");
      } finally {
        copy.close();
      }
      const failure = (target: string) =>
        snapshotLiveDatabase(dbPath, target).then(
          () => "",
          (error: Error) => error.message,
        );
      assert.match(await failure(output), /already exists/);
      assert.match(await failure(`${dbPath}-wal`), /live database file/);
      assert.deepEqual(
        NodeFS.readdirSync(NodePath.dirname(output)).filter((name) => name.startsWith(".db-snapshot-")),
        [],
      );
    });
  });

  it("refuses insufficient space before startup and after space drops during copying", async () => {
    await withHeldDatabase(async (dbPath, directory, holder) => {
      holder.exec("INSERT INTO t(v) VALUES (zeroblob(5 * 1024 * 1024))");
      const output = NodePath.join(directory, "copy.sqlite");
      const originalEntries = NodeFS.readdirSync(directory).sort();

      capacityCheck.mockReturnValue(true);
      await expect(snapshotLiveDatabase(dbPath, output)).rejects.toThrow(/not enough free space/i);
      expect(capacityCheck).toHaveBeenCalledTimes(1);
      expect(NodeFS.readdirSync(directory).sort()).toEqual(originalEntries);

      capacityCheck.mockReset().mockReturnValueOnce(false).mockReturnValue(true);
      await expect(snapshotLiveDatabase(dbPath, output)).rejects.toThrow(/not enough free space/i);
      expect(capacityCheck).toHaveBeenCalledTimes(2);
      expect(NodeFS.readdirSync(directory).sort()).toEqual(originalEntries);
    });
  });

  it("stops when concurrent commits keep restarting the native backup", async () => {
    await withHeldDatabase(async (dbPath, directory, holder) => {
      holder.exec("INSERT INTO t(v) VALUES (zeroblob(5 * 1024 * 1024))");
      const output = NodePath.join(directory, "copy.sqlite");
      const originalEntries = NodeFS.readdirSync(directory).sort();
      capacityCheck.mockReturnValueOnce(false).mockImplementation(() => {
        // Each commit updates one page without growing the logical database.
        holder.exec("UPDATE t SET v = CASE v WHEN 'other' THEN 'row 0' ELSE 'other' END WHERE id = 1");
        return false;
      });

      await expect(snapshotLiveDatabase(dbPath, output)).rejects.toThrow(/exceeded its copy budget/i);
      expect(capacityCheck).toHaveBeenCalledTimes(4);
      expect(NodeFS.readdirSync(directory).sort()).toEqual(originalEntries);
    });
  });

  it("preserves the destination if another writer claims it during copying", async () => {
    await withHeldDatabase(async (dbPath, directory) => {
      const output = NodePath.join(directory, "copy.sqlite");
      const pending = snapshotLiveDatabase(dbPath, output);
      NodeFS.writeFileSync(output, "existing data", { flag: "wx" });

      await expect(pending).rejects.toThrow(/EEXIST/);
      expect(NodeFS.readFileSync(output, "utf8")).toBe("existing data");
      expect(NodeFS.readdirSync(directory).some((name) => name.startsWith(".db-snapshot-"))).toBe(false);
    });
  });
});
