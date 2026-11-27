// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- node:sqlite is the driver under test; a plain timer stands in for the service writing.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { assert, describe, it } from "@effect/vitest";

import {
  LiveDatabaseSpaceError,
  liveDatabaseReadOnlyUri,
  openLiveDatabaseReadOnly,
  removeStalePartials,
  snapshotHeadroom,
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

  it("finishes while another connection keeps writing the database", async () => {
    await withHeldDatabase(async (dbPath, directory) => {
      const writer = new NodeSqlite.DatabaseSync(dbPath);
      try {
        writer.exec("CREATE TABLE blobs(b BLOB)");
        const insert = writer.prepare("INSERT INTO blobs(b) VALUES (randomblob(4000))");
        writer.exec("BEGIN");
        for (let i = 0; i < 3000; i++) insert.run();
        writer.exec("COMMIT");
        // The service writes all the time; a backup in small steps restarts on every write.
        const writing = setInterval(() => insert.run(), 1);
        try {
          const output = NodePath.join(directory, "busy.sqlite");
          const snapshot = await snapshotLiveDatabase(dbPath, output);
          assert.equal(snapshot.quickCheck, "ok");
          assert.isAtLeast(snapshot.pages, 3000);
        } finally {
          clearInterval(writing);
        }
      } finally {
        writer.close();
      }
    });
  }, 20_000);

  it("refuses, creating nothing, when the disk lacks the database size plus headroom", async () => {
    await withHeldDatabase(async (dbPath, directory) => {
      const output = NodePath.join(directory, "copies", "copy.sqlite");
      let asked = "";
      const error = await snapshotLiveDatabase(dbPath, output, {
        freeBytes: (dir) => {
          asked = dir;
          return snapshotHeadroom(0) - 1;
        },
      }).then(
        () => undefined,
        (cause: unknown) => cause,
      );
      assert.instanceOf(error, LiveDatabaseSpaceError);
      assert.equal(asked, NodePath.dirname(output));
      assert.match((error as Error).message, /Not enough free disk space.*needs .* GB.*is free/);
      assert.isAbove(
        (error as LiveDatabaseSpaceError).needed,
        (error as LiveDatabaseSpaceError).free,
      );
      assert.isFalse(NodeFS.existsSync(NodePath.dirname(output)));
    });
  });

  it("leaves no partial or journal behind when the backup fails", async () => {
    await withHeldDatabase(async (dbPath, directory) => {
      const output = NodePath.join(directory, "copies", "copy.sqlite");
      const partials: Array<string> = [];
      const failing = (async (_source: NodeSqlite.DatabaseSync, path: string) => {
        partials.push(path);
        NodeFS.writeFileSync(path, "half a copy");
        NodeFS.writeFileSync(`${path}-journal`, "journal");
        throw new Error("database or disk is full");
      }) as unknown as typeof NodeSqlite.backup;
      for (let attempt = 0; attempt < 2; attempt++) {
        await snapshotLiveDatabase(dbPath, output, { backup: failing }).then(
          () => assert.fail("the copy should fail"),
          (error: Error) => assert.match(error.message, /disk is full/),
        );
      }
      // Every attempt writes its own partial, so starting one never removes a running one.
      assert.equal(new Set(partials).size, 2);
      assert.deepEqual(NodeFS.readdirSync(NodePath.dirname(output)), []);
    });
  });
});

describe("removeStalePartials", () => {
  it("removes only the partials of that target", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-stale-partials-"));
    try {
      const target = NodePath.join(directory, "copy.sqlite");
      for (const name of [
        "copy.sqlite.partial-1",
        "copy.sqlite.partial-2-abcd1234",
        "copy.sqlite.partial-2-abcd1234-journal",
        "copy.sqlite",
        "other.sqlite.partial-1",
      ])
        NodeFS.writeFileSync(NodePath.join(directory, name), "x");
      assert.deepEqual(removeStalePartials(target).toSorted(), [
        "copy.sqlite.partial-1",
        "copy.sqlite.partial-2-abcd1234",
        "copy.sqlite.partial-2-abcd1234-journal",
      ]);
      assert.deepEqual(NodeFS.readdirSync(directory).toSorted(), [
        "copy.sqlite",
        "other.sqlite.partial-1",
      ]);
      assert.deepEqual(removeStalePartials(NodePath.join(directory, "missing", "x.sqlite")), []);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});
