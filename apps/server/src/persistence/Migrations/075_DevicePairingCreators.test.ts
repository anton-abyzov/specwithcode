import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import Migration0075 from "./075_DevicePairingCreators.ts";
import * as NodeSqliteClient from "@specweave-studio/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("075_DevicePairingCreators", (it) => {
  it.effect("adds the creator table and leaves pairing links as they were", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 74 });
      yield* sql`INSERT INTO auth_pairing_links
        (id, credential, method, scopes, subject, label, created_at, expires_at)
        VALUES
          ('link-a', 'AAAA', 'one-time-token', '[]', 'one-time-token', NULL, '1', '2'),
          ('link-b', 'BBBB', 'one-time-token', '[]', 'device-approval', 'Phone', '1', '2')`;
      const before = yield* sql`SELECT * FROM auth_pairing_links ORDER BY id`;
      yield* runMigrations({ toMigrationInclusive: 75 });
      // Safe to run again, as an interrupted update would.
      yield* Migration0075;

      assert.deepStrictEqual(yield* sql`SELECT * FROM auth_pairing_links ORDER BY id`, before);
      const columns = yield* sql<{ readonly name: string; readonly pk: number }>`
        SELECT name, pk FROM pragma_table_info('device_pairing_creators') ORDER BY cid
      `;
      assert.deepStrictEqual(
        columns.map((column) => [column.name, column.pk]),
        [
          ["pairing_link_id", 1],
          ["device_key", 0],
          ["approval", 0],
        ],
      );
      yield* sql`INSERT INTO device_pairing_creators (pairing_link_id, device_key, approval)
        VALUES ('link-a', 'jkt:phone', 'approval-1')`;
      assert.deepStrictEqual(yield* sql`SELECT * FROM device_pairing_creators`, [
        { pairing_link_id: "link-a", device_key: "jkt:phone", approval: "approval-1" },
      ]);
    }),
  );
});
