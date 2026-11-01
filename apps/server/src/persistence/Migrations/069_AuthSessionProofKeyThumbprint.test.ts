import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@specweave-studio/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("069_AuthSessionProofKeyThumbprint", (it) => {
  it.effect("adds a nullable, indexed proof key thumbprint to auth sessions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 68 });
      yield* runMigrations({ toMigrationInclusive: 69 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(auth_sessions)
      `;
      const thumbprint = columns.find((column) => column.name === "proof_key_thumbprint");
      assert.equal(thumbprint?.notnull, 0);

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(auth_sessions)
      `;
      assert.isTrue(
        indexes.some((index) => index.name === "auth_sessions_proof_key_thumbprint_idx"),
      );
    }),
  );
});
