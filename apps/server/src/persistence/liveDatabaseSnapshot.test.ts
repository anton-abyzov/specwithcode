// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- node:sqlite is the driver under test; a plain timer stands in for the service writing.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { assert, describe, it } from "@effect/vitest";

import {
  checkDatabaseCopy,
  LiveDatabaseSpaceError,
  liveDatabaseReadOnlyUri,
  openLiveDatabaseReadOnly,
  publishWithoutReplacing,
  removeStalePartials,
  snapshotHeadroom,
  snapshotLiveDatabase,
} from "./liveDatabaseSnapshot.ts";

/** Tests not about space never depend on the free space of the machine they run on. */
const ample = { freeBytes: () => Number.MAX_SAFE_INTEGER };

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
      const snapshot = await snapshotLiveDatabase(dbPath, output, ample);
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
        snapshotLiveDatabase(dbPath, target, ample).then(
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
        let writes = 0;
        let writesDuringCopy = 0;
        const writing = setInterval(() => {
          insert.run();
          writes += 1;
        }, 1);
        try {
          const output = NodePath.join(directory, "busy.sqlite");
          // Let the writer start first, so the copy begins while the database is busy.
          while (writes < 3) await new Promise((resolve) => setTimeout(resolve, 2));
          const before = writes;
          const snapshot = await snapshotLiveDatabase(dbPath, output, ample);
          writesDuringCopy = writes - before;
          assert.equal(snapshot.quickCheck, "ok");
          assert.isAtLeast(snapshot.pages, 3000);
          // The copy runs off the event loop, so the service kept writing while it ran.
          assert.isAbove(writesDuringCopy, 0);
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
      const reader = openLiveDatabaseReadOnly(dbPath);
      const databaseBytes =
        Number(reader.prepare("PRAGMA page_count").get()?.page_count) *
        Number(reader.prepare("PRAGMA page_size").get()?.page_size);
      reader.close();
      const needed = databaseBytes + snapshotHeadroom(databaseBytes);
      const output = NodePath.join(directory, "copies", "copy.sqlite");
      let asked = "";
      const error = await snapshotLiveDatabase(dbPath, output, {
        freeBytes: (dir) => {
          asked = dir;
          return needed - 1;
        },
      }).then(
        () => undefined,
        (cause: unknown) => cause,
      );
      assert.instanceOf(error, LiveDatabaseSpaceError);
      assert.equal(asked, NodePath.dirname(output));
      assert.match((error as Error).message, /Not enough free disk space.*needs .*is free/);
      assert.equal((error as LiveDatabaseSpaceError).needed, needed);
      assert.equal((error as LiveDatabaseSpaceError).databaseBytes, databaseBytes);
      assert.isFalse(NodeFS.existsSync(NodePath.dirname(output)));
      // Exactly the size plus headroom is enough.
      const snapshot = await snapshotLiveDatabase(dbPath, output, { freeBytes: () => needed });
      assert.equal(snapshot.quickCheck, "ok");
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
  it("removes this process's and stopped processes' partials, never a running one's", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-stale-partials-"));
    try {
      const target = NodePath.join(directory, "copy.sqlite");
      const own = process.pid;
      for (const name of [
        `copy.sqlite.partial-${own}`,
        `copy.sqlite.partial-${own}-abcd1234-journal`,
        "copy.sqlite.partial-111-abcd1234",
        "copy.sqlite.partial-222-abcd1234",
        "copy.sqlite.partial-notapid",
        "copy.sqlite",
        "other.sqlite.partial-111",
      ])
        NodeFS.writeFileSync(NodePath.join(directory, name), "x");
      // 222 is a running `db snapshot` into the same file; 111 stopped.
      const removed = removeStalePartials(target, (pid) => pid === 222);
      assert.deepEqual(
        removed.toSorted(),
        [
          "copy.sqlite.partial-111-abcd1234",
          `copy.sqlite.partial-${own}`,
          `copy.sqlite.partial-${own}-abcd1234-journal`,
        ].toSorted(),
      );
      assert.deepEqual(NodeFS.readdirSync(directory).toSorted(), [
        "copy.sqlite",
        "copy.sqlite.partial-222-abcd1234",
        "copy.sqlite.partial-notapid",
        "other.sqlite.partial-111",
      ]);
      assert.deepEqual(removeStalePartials(NodePath.join(directory, "missing", "x.sqlite")), []);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("checkDatabaseCopy", () => {
  it("checks a copy in a worker and rejects a file that is not a database", async () => {
    await withHeldDatabase(async (dbPath, directory) => {
      const output = NodePath.join(directory, "checked.sqlite");
      await snapshotLiveDatabase(dbPath, output, ample);
      let ticks = 0;
      const ticking = setInterval(() => (ticks += 1), 0);
      try {
        const checked = await checkDatabaseCopy(output);
        assert.equal(checked.quickCheck, "ok");
        assert.isAbove(checked.pages, 0);
      } finally {
        clearInterval(ticking);
      }
      // The event loop ran while the worker checked.
      assert.isAbove(ticks, 0);
      const junk = NodePath.join(directory, "junk.sqlite");
      NodeFS.writeFileSync(junk, "not a database, long enough to have a header: ".repeat(20));
      await checkDatabaseCopy(junk).then(
        () => assert.fail("a file that is not a database must not pass"),
        (error: Error) => assert.match(error.message, /not a database|malformed/i),
      );
    });
  });
});

describe("publishWithoutReplacing", () => {
  it("publishes a finished copy, and never replaces one another writer saved first", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-publish-"));
    try {
      const target = NodePath.join(directory, "copy.sqlite");
      const first = `${target}.partial-1-aaaa`;
      NodeFS.writeFileSync(first, "first copy");
      publishWithoutReplacing(first, target);
      assert.equal(NodeFS.readFileSync(target, "utf8"), "first copy");
      assert.isFalse(NodeFS.existsSync(first));
      // A second writer that passed its own existence check before the first published.
      const second = `${target}.partial-2-bbbb`;
      NodeFS.writeFileSync(second, "second copy");
      assert.throws(() => publishWithoutReplacing(second, target), /already exists/);
      assert.equal(NodeFS.readFileSync(target, "utf8"), "first copy");
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps the first copy when two snapshots race for one absent file", async () => {
    await withHeldDatabase(async (dbPath, directory) => {
      const output = NodePath.join(directory, "raced.sqlite");
      // Both pass the existence check before either publishes.
      const results = await Promise.allSettled([
        snapshotLiveDatabase(dbPath, output, ample),
        snapshotLiveDatabase(dbPath, output, ample),
      ]);
      assert.deepEqual(results.map((result) => result.status).toSorted(), [
        "fulfilled",
        "rejected",
      ]);
      const rejected = results.find((result) => result.status === "rejected");
      assert.match(String((rejected as PromiseRejectedResult).reason), /already exists/);
      assert.deepEqual(
        NodeFS.readdirSync(directory).filter((name) => name.startsWith("raced.sqlite")),
        ["raced.sqlite"],
      );
    });
  });
});
