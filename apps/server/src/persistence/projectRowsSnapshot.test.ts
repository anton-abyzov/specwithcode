// @effect-diagnostics nodeBuiltinImport:off -- node:sqlite builds the scratch database the copy is made from.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { assert, describe, it } from "@effect/vitest";

import { LiveDatabaseSpaceError, snapshotHeadroom } from "./liveDatabaseSnapshot.ts";
import { COPY_INFO_TABLE, snapshotProjectRows } from "./projectRowsSnapshot.ts";

const PERCY = "percy-project";
const ample = { freeBytes: () => Number.MAX_SAFE_INTEGER };

/** A scratch database held open in WAL mode, like the running service's. */
const withHeldDatabase = async (run: (dbPath: string, directory: string) => Promise<void>) => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-project-rows-"));
  const dbPath = NodePath.join(directory, "statev2.sqlite");
  const holder = new NodeSqlite.DatabaseSync(dbPath);
  try {
    holder.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA user_version = 77;
      CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_settings_json TEXT);
      CREATE TABLE project_memory (project_id TEXT NOT NULL, name TEXT NOT NULL, content TEXT NOT NULL, PRIMARY KEY (project_id, name));
      CREATE TABLE scheduled_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT REFERENCES missing_parent(id), big INTEGER);
      CREATE TABLE orchestration_v2_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, payload_json TEXT NOT NULL);
    `);
    holder
      .prepare("INSERT INTO projection_projects VALUES (?, ?, ?)")
      .run(PERCY, "Percy", '{"revision":3}');
    holder.prepare("INSERT INTO projection_projects VALUES (?, ?, ?)").run("work", "Work", "{}");
    const memory = holder.prepare("INSERT INTO project_memory VALUES (?, ?, ?)");
    memory.run(PERCY, "people.md", "Elena");
    memory.run(PERCY, "MEMORY.md", "# index");
    holder.exec("BEGIN");
    // Plenty of another project's data, so the database is far larger than Percy's rows.
    for (let i = 0; i < 2000; i++) memory.run("work", `file-${i}.md`, "x".repeat(2000));
    holder.exec("COMMIT");
    holder
      .prepare("INSERT INTO scheduled_tasks (project_id, big) VALUES (?, ?)")
      .run(PERCY, 9007199254740993n);
    holder.prepare("INSERT INTO scheduled_tasks (project_id, big) VALUES (?, ?)").run("work", 1);
    holder
      .prepare("INSERT INTO orchestration_v2_events (thread_id, payload_json) VALUES (?, ?)")
      .run("thread-1", "{}");
    await run(dbPath, directory);
  } finally {
    holder.close();
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
};

const count = (db: NodeSqlite.DatabaseSync, sql: string) =>
  Number(Object.values(db.prepare(sql).get() ?? {})[0]);

describe("snapshotProjectRows", () => {
  it("copies only the project's rows of tables with project_id, and says whose they are", async () => {
    await withHeldDatabase(async (dbPath, directory) => {
      const output = NodePath.join(directory, "copies", "percy.sqlite");
      const snapshot = await snapshotProjectRows(dbPath, output, PERCY, {
        ...ample,
        now: () => new Date("2026-11-27T12:00:00.000Z"),
      });
      assert.equal(snapshot.quickCheck, "ok");
      assert.deepEqual(snapshot.rows, {
        project_memory: 2,
        projection_projects: 1,
        scheduled_tasks: 1,
      });
      assert.isBelow(snapshot.bytes, NodeFS.statSync(dbPath).size / 10);
      const copy = new NodeSqlite.DatabaseSync(output, { readOnly: true });
      try {
        assert.equal(count(copy, "SELECT count(*) FROM project_memory"), 2);
        assert.equal(count(copy, "SELECT count(*) FROM projection_projects"), 1);
        assert.equal(
          copy.prepare("SELECT workspace_settings_json AS s FROM projection_projects").get()?.s,
          '{"revision":3}',
        );
        assert.equal(
          count(copy, "SELECT count(*) FROM project_memory WHERE project_id <> 'percy-project'"),
          0,
        );
        // Integers past 2^53 survive exactly.
        const big = copy.prepare("SELECT big FROM scheduled_tasks");
        big.setReadBigInts(true);
        assert.equal(big.get()?.big, 9007199254740993n);
        // Tables keyed by thread, not project, stay out.
        assert.equal(
          count(copy, "SELECT count(*) FROM sqlite_master WHERE name = 'orchestration_v2_events'"),
          0,
        );
        const info = copy.prepare(`SELECT * FROM ${COPY_INFO_TABLE}`).get();
        assert.equal(info?.project_id, PERCY);
        assert.equal(info?.saved_at, "2026-11-27T12:00:00.000Z");
        assert.equal(info?.source_user_version, 77);
        assert.equal(copy.prepare("PRAGMA journal_mode").get()?.journal_mode, "delete");
      } finally {
        copy.close();
      }
      assert.deepEqual(NodeFS.readdirSync(NodePath.dirname(output)), ["percy.sqlite"]);
    });
  });

  it("needs room for the project's rows, not the whole database, and makes nothing without it", async () => {
    await withHeldDatabase(async (dbPath, directory) => {
      const output = NodePath.join(directory, "copies", "percy.sqlite");
      const error = await snapshotProjectRows(dbPath, output, PERCY, {
        freeBytes: () => snapshotHeadroom(0) - 1,
      }).then(
        () => undefined,
        (cause: unknown) => cause,
      );
      assert.instanceOf(error, LiveDatabaseSpaceError);
      const space = error as LiveDatabaseSpaceError;
      assert.isAbove(space.databaseBytes, 0);
      assert.isBelow(space.databaseBytes, NodeFS.statSync(dbPath).size / 10);
      assert.isFalse(NodeFS.existsSync(NodePath.dirname(output)));
      // Exactly the rows plus headroom is enough.
      const snapshot = await snapshotProjectRows(dbPath, output, PERCY, {
        freeBytes: () => space.needed,
      });
      assert.equal(snapshot.quickCheck, "ok");
    });
  });

  it("never replaces a copy saved first, and leaves no partial behind", async () => {
    await withHeldDatabase(async (dbPath, directory) => {
      const output = NodePath.join(directory, "percy.sqlite");
      const results = await Promise.allSettled([
        snapshotProjectRows(dbPath, output, PERCY, ample),
        snapshotProjectRows(dbPath, output, PERCY, ample),
      ]);
      assert.deepEqual(results.map((result) => result.status).toSorted(), [
        "fulfilled",
        "rejected",
      ]);
      await snapshotProjectRows(dbPath, output, PERCY, ample).then(
        () => assert.fail("an existing copy must not be replaced"),
        (cause: Error) => assert.match(cause.message, /already exists/),
      );
      assert.deepEqual(
        NodeFS.readdirSync(directory).filter((name) => name.startsWith("percy.sqlite")),
        ["percy.sqlite"],
      );
    });
  });
});
