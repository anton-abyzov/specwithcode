import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { BUSY_SQL } from "./readinessSweep.ts";

it.layer(SqlitePersistence.layerMemory)("the readiness check's quiet test", (it) => {
  it.effect("is quiet with no work, busy with a running turn or a pending question", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const count = () =>
        sql.unsafe<{ readonly count: number }>(BUSY_SQL).pipe(Effect.map((rows) => rows[0]!.count));
      assert.strictEqual(yield* count(), 0);
      const run = (id: string, ordinal: number, status: string, payload = "{}") =>
        sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json) VALUES (${id}, 't1', ${ordinal}, 'codex', ${status}, '2026-11-13T20:00:00Z', ${payload})`;
      yield* run("done", 1, "completed");
      // A queue a person held starts only when they resume it.
      yield* run("held", 2, "queued", '{"queueHeld":true}');
      assert.strictEqual(yield* count(), 0);
      yield* run("live", 3, "running");
      assert.strictEqual(yield* count(), 1);
    }),
  );
});
