import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@specweave-studio/shared/nodeSqliteClient";
import { runSqliteState } from "./studio-sqlite-state.ts";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import { symlinksSupported } from "@specweave-studio/shared/testing/symlinks";

const createFixtureDatabase = Effect.fn("createSqliteStateFixtureDatabase")(function* (
  baseDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateDir = path.join(baseDir, "userdata");
  const databasePath = path.join(stateDir, "statev2.sqlite");
  yield* fs.makeDirectory(stateDir, { recursive: true });
  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE fixtures (id INTEGER PRIMARY KEY, label TEXT NOT NULL)`;
    yield* sql`INSERT INTO fixtures (id, label) VALUES (1, 'existing')`;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })));
});

it.layer(NodeServices.layer)("studio-sqlite-state", (it) => {
  it.effect("reports each invalid SQL source with a specific error", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-sqlite-state-input-" });

      const multipleSources = yield* runSqliteState({
        operation: "query",
        baseDir,
        sql: "SELECT 1",
        file: "fixture.sql",
      }).pipe(Effect.flip);
      assert.equal(multipleSources._tag, "SqliteStateMultipleSqlSourcesError");
      assert.equal(multipleSources.message, "Provide only one of --sql or --file.");

      const missingSource = yield* runSqliteState({ operation: "query", baseDir }).pipe(
        Effect.flip,
      );
      assert.equal(missingSource._tag, "SqliteStateMissingSqlSourceError");
      assert.equal(missingSource.message, "Provide one of --sql or --file.");

      const emptySql = yield* runSqliteState({
        operation: "query",
        baseDir,
        sql: "   ",
      }).pipe(Effect.flip);
      assert.equal(emptySql._tag, "SqliteStateEmptySqlError");
      assert.equal(emptySql.message, "SQL input is empty.");
    }),
  );

  it.effect("queries an isolated database through Effect SQL", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-sqlite-state-query-" });
      yield* createFixtureDatabase(baseDir);

      const result = yield* runSqliteState({
        operation: "query",
        baseDir,
        sql: "SELECT id, label FROM fixtures",
      });

      assert.equal(result.operation, "query");
      if (result.operation === "query") {
        assert.deepStrictEqual(result.rows, [{ id: 1, label: "existing" }]);
      }
    }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "backs up isolated state before writes and refuses the shared home",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-sqlite-state-exec-" });
        yield* createFixtureDatabase(baseDir);

        const mutation = yield* runSqliteState({
          operation: "exec",
          baseDir,
          sql: "INSERT INTO fixtures (id, label) VALUES (2, 'seeded')",
        });
        assert.equal(mutation.operation, "exec");
        if (mutation.operation === "exec" && (yield* HostProcessPlatform) !== "win32") {
          // NTFS has no POSIX mode bits to report.
          assert.equal((yield* fs.stat(mutation.backup)).mode & 0o777, 0o600);
        }

        const error = yield* runSqliteState(
          {
            operation: "exec",
            baseDir,
            sql: "DELETE FROM fixtures",
          },
          { sharedHome: baseDir },
        ).pipe(Effect.flip);
        assert.equal(error._tag, "SqliteStateSharedHomeMutationError");

        const aliasParent = yield* fs.makeTempDirectoryScoped({
          prefix: "studio-sqlite-state-alias-",
        });
        const aliasBaseDir = path.join(aliasParent, "shared-home-alias");
        yield* fs.symlink(baseDir, aliasBaseDir);
        const aliasError = yield* runSqliteState(
          {
            operation: "exec",
            baseDir: aliasBaseDir,
            sql: "DELETE FROM fixtures",
          },
          { sharedHome: baseDir },
        ).pipe(Effect.flip);
        assert.equal(aliasError._tag, "SqliteStateSharedHomeMutationError");
      }),
  );

  it.effect("refuses exec on a home a service runs from and leaves its database unchanged", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-sqlite-state-live-" });
      yield* createFixtureDatabase(baseDir);
      // The parent process is alive and started before this record.
      yield* fs.writeFileString(
        path.join(baseDir, "userdata", "server-runtime.json"),
        JSON.stringify({
          version: 1,
          pid: process.ppid,
          host: "127.0.0.1",
          port: 8_319,
          origin: "http://127.0.0.1:8319",
          // A real time: the test clock would record 1970.
          startedAt: DateTime.formatIso(DateTime.nowUnsafe()),
        }),
      );

      const error = yield* runSqliteState(
        { operation: "exec", baseDir, sql: "DELETE FROM fixtures" },
        { sharedHome: path.join(baseDir, "elsewhere") },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "LiveDatabaseOwnedError");
      // A query still reads it, through the read-only opener.
      const result = yield* runSqliteState({
        operation: "query",
        baseDir,
        sql: "SELECT COUNT(*) AS count FROM fixtures",
      });
      if (result.operation === "query") assert.deepStrictEqual(result.rows, [{ count: 1 }]);
      const names = yield* fs.readDirectory(path.join(baseDir, "userdata"));
      assert.isFalse(names.some((name) => name.includes(".backup-")));
    }),
  );
});
