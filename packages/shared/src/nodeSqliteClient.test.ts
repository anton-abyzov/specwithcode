import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Tracer from "effect/Tracer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqliteClient from "./nodeSqliteClient.ts";

const layer = it.layer(SqliteClient.layer({ filename: ":memory:" }));

layer("NodeSqliteClient", (it) => {
  it.effect("binds true and false in prepared, raw and unprepared query paths", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const query = sql`SELECT ${true} AS allowed, ${false} AS denied`;
      assert.deepEqual(yield* query, [{ allowed: 1, denied: 0 }]);
      assert.deepEqual(yield* query.values, [[1, 0]]);
      assert.deepEqual(yield* query.unprepared, [{ allowed: 1, denied: 0 }]);
      assert.deepEqual(yield* query.valuesUnprepared, [[1, 0]]);
      assert.deepEqual(yield* query.raw, [{ allowed: 1, denied: 0 }]);
    }),
  );

  it.effect("persists booleans and keeps false authorization predicates restrictive", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE binding_grants(id INTEGER PRIMARY KEY, enabled INTEGER NOT NULL)`;
      yield* sql`INSERT INTO binding_grants VALUES (1, ${false})`;
      yield* sql`INSERT INTO binding_grants VALUES (2, ${true})`.raw;
      assert.deepEqual(yield* sql`SELECT id FROM binding_grants WHERE enabled = ${true}`.values, [
        [2],
      ]);
      // Mirrors the pairing query's optional-scope gate: false must not bypass it.
      assert.deepEqual(
        yield* sql`UPDATE binding_grants SET enabled = ${true} WHERE id = 1 AND (${false} OR enabled = 1) RETURNING id`,
        [],
      );
      assert.deepEqual(yield* sql`SELECT enabled FROM binding_grants WHERE id = 1`.values, [[0]]);
      assert.deepEqual(
        yield* sql`UPDATE binding_grants SET enabled = ${true} WHERE id = 1 AND (${true} OR enabled = 1) RETURNING id`
          .values,
        [[1]],
      );
      yield* sql`UPDATE binding_grants SET enabled = ${false} WHERE id = 2`.valuesUnprepared;
      assert.deepEqual(yield* sql`SELECT enabled FROM binding_grants ORDER BY id`.values, [
        [1],
        [0],
      ]);
    }),
  );

  it.effect(
    "preserves ordinary binding types and returns typed errors for unsupported values",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const bytes = new Uint8Array([0, 128, 255]);
        const rows = yield* sql.unsafe<{
          n: number;
          text: string;
          empty: null;
          bytes: Uint8Array;
          allowed: number;
        }>("SELECT ? AS n, ? AS text, ? AS empty, ? AS bytes, ? AS allowed", [
          3.5,
          "false",
          null,
          bytes,
          false,
        ]);
        assert.equal(rows[0]?.n, 3.5);
        assert.equal(rows[0]?.text, "false");
        assert.equal(rows[0]?.empty, null);
        assert.deepEqual(Array.from(rows[0]!.bytes), Array.from(bytes));
        assert.equal(rows[0]?.allowed, 0);
        const error = yield* sql.unsafe("SELECT ?", [{ unsupported: true }]).pipe(Effect.flip);
        assert.equal(error._tag, "SqlError");
        assert.equal(error.reason.operation, "execute");
      }),
  );

  it.effect("retries preparing a query after the missing schema becomes available", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const select = sql<{ name: string }>`SELECT name FROM created_after_prepare_failure`;
      const error = yield* select.pipe(Effect.flip);
      assert.equal(error._tag, "SqlError");
      assert.equal(error.reason.operation, "prepare");

      yield* sql`CREATE TABLE created_after_prepare_failure(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO created_after_prepare_failure VALUES ('recovered')`;
      assert.deepEqual(yield* select, [{ name: "recovered" }]);
      assert.deepEqual(yield* select.values, [["recovered"]]);
    }),
  );

  it.effect("runs prepared queries and returns positional values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries(name) VALUES (${"alpha"}), (${"beta"})`;

      const rows = yield* sql<{ readonly id: number; readonly name: string }>`
      SELECT id, name FROM entries ORDER BY id
    `;
      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.name, "alpha");
      assert.equal(rows[1]?.name, "beta");

      const values = yield* sql`SELECT id, name FROM entries ORDER BY id`.values;
      assert.equal(values.length, 2);
      assert.equal(values[0]?.[1], "alpha");
      assert.equal(values[1]?.[1], "beta");

      const unpreparedValues = yield* sql`SELECT id, name FROM entries ORDER BY id`
        .valuesUnprepared;
      assert.deepEqual(unpreparedValues, values);
    }),
  );

  it.effect("returns a typed failure when an unprepared statement cannot be prepared", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const error = yield* Effect.flip(sql.unsafe("SELECT FROM").unprepared);

      assert.equal(error._tag, "SqlError");
      assert.equal(error.reason.operation, "prepare");
    }),
  );

  it.effect("classifies constraint failures by their SQLite result code", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE constrained(name TEXT NOT NULL UNIQUE)`;
      yield* sql`INSERT INTO constrained VALUES ('taken')`;

      const duplicate = yield* sql`INSERT INTO constrained VALUES ('taken')`.pipe(Effect.flip);
      assert(duplicate.reason._tag === "UniqueViolation");
      assert.equal(duplicate.reason.constraint, "constrained.name");

      const missing = yield* sql`INSERT INTO constrained VALUES (NULL)`.pipe(Effect.flip);
      assert.equal(missing.reason._tag, "ConstraintError");
    }),
  );
});

const makeTempDatabase = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "studio-sqlite-transaction-" });
  const filename = path.join(directory, "state.sqlite");
  // node:sqlite connections fail a busy statement at once unless given a timeout.
  const other = yield* Effect.acquireRelease(
    Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
    (database) => Effect.sync(() => database.close()),
  );
  yield* Effect.sync(() => {
    other.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE counters(id INTEGER PRIMARY KEY, value INTEGER NOT NULL);
      INSERT INTO counters VALUES (1, 0);
    `);
  });
  return { filename, other };
});

it.effect("steps a pragma that emits undeclared rows to completion on every query path", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA auto_vacuum = INCREMENTAL`;
    yield* sql`CREATE TABLE pages(id INTEGER PRIMARY KEY, body BLOB NOT NULL)`;
    yield* sql`INSERT INTO pages(body) SELECT zeroblob(4096) FROM (WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 400) SELECT i FROM n)`;
    yield* sql`DELETE FROM pages`;
    const free = Effect.map(
      sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`,
      (rows) => rows[0]?.freelist_count ?? 0,
    );
    // incremental_vacuum declares no column yet steps once per freed page.
    const paths = [
      sql.unsafe("PRAGMA incremental_vacuum(64)"),
      sql.unsafe("PRAGMA incremental_vacuum(64)").raw,
      sql.unsafe("PRAGMA incremental_vacuum(64)").values,
      sql.unsafe("PRAGMA incremental_vacuum(64)").unprepared,
      sql.unsafe("PRAGMA incremental_vacuum(64)").valuesUnprepared,
    ];
    for (const path of paths) {
      const before = yield* free;
      assert.isAtLeast(before, 64);
      yield* path;
      assert.equal(before - (yield* free), 64);
    }
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("keeps another connection from committing between a transaction's read and write", () =>
  Effect.gen(function* () {
    const { filename, other } = yield* makeTempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const [row] = yield* sql<{ readonly value: number }>`
            SELECT value FROM counters WHERE id = 1
          `;
          // With a deferred BEGIN this commit lands and the write below fails
          // with SQLITE_BUSY_SNAPSHOT, which no busy timeout can wait out.
          yield* Effect.sync(() =>
            assert.throws(
              () => other.exec("UPDATE counters SET value = value + 1 WHERE id = 1"),
              /database is locked/,
            ),
          );
          yield* sql`UPDATE counters SET value = ${(row?.value ?? 0) + 10} WHERE id = 1`;
        }),
      );
      yield* Effect.sync(() => other.exec("UPDATE counters SET value = value + 1 WHERE id = 1"));
      assert.deepEqual(yield* sql`SELECT value FROM counters WHERE id = 1`.values, [[11]]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reports a transaction blocked by another writer as a lock timeout", () =>
  Effect.gen(function* () {
    const { filename, other } = yield* makeTempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA busy_timeout = 0`;
      const read = sql.withTransaction(sql`SELECT value FROM counters WHERE id = 1`.values);

      yield* Effect.sync(() => other.exec("BEGIN IMMEDIATE"));
      const error = yield* read.pipe(Effect.flip);
      assert.equal(error.reason._tag, "LockTimeoutError");

      yield* Effect.sync(() => other.exec("COMMIT"));
      assert.deepEqual(yield* read, [[0]]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("returns a typed failure when the database cannot be opened", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      Layer.build(SqliteClient.layer({ filename: "\0" })).pipe(Effect.scoped),
    );

    assert.equal(error._tag, "SqlError");
    assert.equal(error.reason.operation, "open");
  }),
);

it.effect(
  "recovers a prepared query immediately after an exclusive database lock is released",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "studio-sqlite-prepare-" });
      const filename = path.join(directory, "state.sqlite");
      const blocker = yield* Effect.acquireRelease(
        Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
        (database) => Effect.sync(() => database.close()),
      );
      yield* Effect.sync(() => {
        blocker.exec("CREATE TABLE entries(value TEXT); INSERT INTO entries VALUES ('retained')");
      });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* Effect.sync(() => blocker.exec("BEGIN EXCLUSIVE"));
        const select = sql`SELECT value FROM entries`;
        const error = yield* select.values.pipe(Effect.flip);
        assert.equal(error._tag, "SqlError");
        assert.equal(error.reason.operation, "prepare");
        yield* Effect.sync(() => blocker.exec("ROLLBACK"));
        assert.deepEqual(yield* select.values, [["retained"]]);
        assert.deepEqual(yield* select, [{ value: "retained" }]);
      }).pipe(Effect.provide(SqliteClient.layer({ filename })));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "logs statements that run past the slow threshold with truncated SQL and a span event",
  () =>
    Effect.gen(function* () {
      const warnings: Array<unknown> = [];
      const captureLogs = Logger.make(({ logLevel, message }) => {
        if (logLevel === "Warn") warnings.push(message);
      });
      const spans: Array<Tracer.NativeSpan> = [];
      const recordingTracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const longColumn = `value_${"x".repeat(240)}`;

      // A zero threshold reports every statement, so the test does not depend on timing.
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`SELECT 1 AS ${longColumn}`);
        yield* sql`SELECT ${1} AS one`.values;
      }).pipe(
        // The driver does not see `sql.execute` as its parent by default, so the
        // event lands on the caller's span, the work that waited on the statement.
        Effect.withSpan("caller"),
        Effect.provide(
          Layer.mergeAll(
            SqliteClient.layer({ filename: ":memory:", slowStatementThresholdMs: 0 }),
            Logger.layer([captureLogs], { mergeWithExisting: false }),
          ),
        ),
        Effect.withTracer(recordingTracer),
      );

      assert.strictEqual(warnings.length, 2);
      const [text, fields] = warnings[0] as [string, { sql: string; durationMs: number }];
      assert.strictEqual(text, "slow SQLite statement");
      assert.strictEqual(fields.sql, `SELECT 1 AS ${longColumn}`.slice(0, 200) + "...");
      assert.isAtLeast(fields.durationMs, 0);
      assert.strictEqual((warnings[1] as [string, { sql: string }])[1].sql, "SELECT ? AS one");
      const slowEvents = spans
        .filter((span) => span.name === "caller")
        .flatMap((span) => span.events.filter(([name]) => name === "sqlite.slow_statement"));
      assert.strictEqual(slowEvents.length, 2);
      assert.strictEqual(slowEvents[0]![2]["db.query.text"], fields.sql);

      // At the default threshold a fast statement logs nothing.
      warnings.length = 0;
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`SELECT 1 AS one`;
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            SqliteClient.layer({ filename: ":memory:" }),
            Logger.layer([captureLogs], { mergeWithExisting: false }),
          ),
        ),
      );
      assert.deepEqual(warnings, []);
    }),
);

it.effect("also logs slow statements that fail, marked as failed", () =>
  Effect.gen(function* () {
    const warnings: Array<unknown> = [];
    const captureLogs = Logger.make(({ logLevel, message }) => {
      if (logLevel === "Warn") warnings.push(message);
    });

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE unique_ids(id INTEGER PRIMARY KEY)`;
      yield* sql`INSERT INTO unique_ids VALUES (${1})`;
      warnings.length = 0;
      // A duplicate key fails while executing, on both the row and the values path.
      const rowError = yield* sql`INSERT INTO unique_ids VALUES (${1})`.pipe(Effect.flip);
      const valuesError = yield* sql`INSERT INTO unique_ids VALUES (${1}) RETURNING id`.values.pipe(
        Effect.flip,
      );
      assert.strictEqual(rowError.reason.operation, "execute");
      assert.strictEqual(valuesError.reason.operation, "execute");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          SqliteClient.layer({ filename: ":memory:", slowStatementThresholdMs: 0 }),
          Logger.layer([captureLogs], { mergeWithExisting: false }),
        ),
      ),
    );

    assert.deepEqual(
      warnings.map((warning) => {
        const [text, fields] = warning as [string, { sql: string; failed?: boolean }];
        return [text, fields.sql, fields.failed];
      }),
      [
        ["slow SQLite statement", "INSERT INTO unique_ids VALUES (?)", true],
        ["slow SQLite statement", "INSERT INTO unique_ids VALUES (?) RETURNING id", true],
      ],
    );
  }),
);

it.effect("uses uncached statements for large bindings without invoking named getters twice", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const instances: NodeSqlite.StatementSync[] = [];
    const original = NodeSqlite.StatementSync.prototype.all;
    const spy = vi.spyOn(NodeSqlite.StatementSync.prototype, "all").mockImplementation(function (
      this: NodeSqlite.StatementSync,
      ...args
    ) {
      instances.push(this);
      return original.apply(this, args);
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
    const small = new Set<NodeSqlite.StatementSync>();
    const large = new Set<NodeSqlite.StatementSync>();
    for (const value of [
      "small",
      "x".repeat(65537),
      "界".repeat(30000),
      new Uint8Array(65537),
      new ArrayBuffer(65537),
      "small",
    ]) {
      const length =
        typeof value === "string"
          ? value.length
          : value instanceof ArrayBuffer
            ? null
            : value.byteLength;
      const query = sql`SELECT length(${value}) AS n`;
      assert.deepEqual(yield* query, [{ n: length }]);
      assert.deepEqual(yield* query.values, [[length]]);
      for (const instance of instances.splice(0)) (value === "small" ? small : large).add(instance);
    }
    assert.equal(small.size, 1);
    assert.equal(large.size, 8);
    for (const instance of large) assert.isFalse(small.has(instance));
    let reads = 0;
    assert.deepEqual(
      yield* sql.unsafe("SELECT $value AS n", [
        {
          get $value() {
            return ++reads;
          },
        },
      ]),
      [{ n: 1 }],
    );
    assert.equal(reads, 1);
    const named = { $value: "x".repeat(65537) };
    const a = yield* sql.unsafe("SELECT length($value) AS n", [named]);
    const b = yield* sql.unsafe("SELECT length($value) AS n", [named]);
    assert.deepEqual(a, b);
    assert.notStrictEqual(instances.at(-1), instances.at(-2));
    for (const value of ["small", "x".repeat(65537)]) {
      const values = sql`SELECT 1 AS id, length(${value}) AS n`.values;
      assert.deepEqual(yield* values.pipe(Effect.provideService(SqlClient.SafeIntegers, true)), [
        [1n, BigInt(value.length)],
      ]);
      assert.deepEqual(yield* values, [[1, value.length]]);
    }
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);
