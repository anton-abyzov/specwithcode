import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@specweave-studio/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })))(
  "067 principal upgrade",
  (it) => {
    it.effect(
      "retains all legacy rows and marks ambiguous identity NULL without guessing from labels",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* runMigrations({ toMigrationInclusive: 66 });
          yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at, client_label) VALUES ('old', 'mcp-client', '[]', 'bearer-access-token', '2026-10-24T00:00:00Z', '2026-11-24T00:00:00Z', 'SpecWithCode workers · victim')`;
          yield* sql`INSERT INTO auth_pairing_links (id, credential, method, scopes, subject, created_at, expires_at, label) VALUES ('link', 'synthetic-code', 'one-time-token', '[]', 'one-time-token', '2026-10-24T00:00:00Z', '2026-11-24T00:00:00Z', 'SpecWithCode workers · victim')`;
          yield* runMigrations();
          expect(yield* sql`SELECT session_id, client_label, principal FROM auth_sessions`).toEqual(
            [{ session_id: "old", client_label: "SpecWithCode workers · victim", principal: null }],
          );
          expect(yield* sql`SELECT id, label, principal FROM auth_pairing_links`).toEqual([
            { id: "link", label: "SpecWithCode workers · victim", principal: null },
          ]);
          expect(yield* sql`SELECT principal_generation FROM auth_sessions`).toEqual([
            { principal_generation: 0 },
          ]);
          expect(yield* sql`SELECT principal_generation FROM auth_pairing_links`).toEqual([
            { principal_generation: 0 },
          ]);
          expect(
            yield* sql`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'auth_%_principal_generation' ORDER BY name`,
          ).toEqual([
            { name: "auth_pairing_principal_generation" },
            { name: "auth_session_principal_generation" },
          ]);
          expect(yield* runMigrations()).toEqual([]);
        }),
    );
  },
);
