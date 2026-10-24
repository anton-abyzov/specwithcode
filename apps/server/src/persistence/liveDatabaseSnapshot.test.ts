// @effect-diagnostics nodeBuiltinImport:off -- node:sqlite is the driver under test.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { assert, describe, it } from "@effect/vitest";

import {
  liveDatabaseReadOnlyUri,
  openLiveDatabaseReadOnly,
  snapshotLiveDatabase,
} from "./liveDatabaseSnapshot.ts";

const withHeldDatabase = async (run: (dbPath: string, directory: string) => Promise<void>) => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-live-db-snapshot-"));
  const dbPath = NodePath.join(directory, "statev2.sqlite");
  const holder = new NodeSqlite.DatabaseSync(dbPath);
  try {
    holder.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
    holder.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
    const insert = holder.prepare("INSERT INTO t(v) VALUES (?)");
    for (let i = 0; i < 250; i++) insert.run(`row ${i}`);
    await run(dbPath, directory);
  } finally {
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
        NodeFS.readdirSync(NodePath.dirname(output)).filter((name) => name.includes("partial")),
        [],
      );
    });
  });
});
