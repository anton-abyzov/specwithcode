import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The DPoP key a session is bound to, so every session of one SpecWithCode
// Connect phone can be ended together when that phone is removed. Nullable:
// unbound sessions and rows from before this column have none. Older
// proof-bound sessions last an hour, so they expire on their own.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(auth_sessions)
  `;
  if (!columns.some((column) => column.name === "proof_key_thumbprint")) {
    yield* sql`
      ALTER TABLE auth_sessions
      ADD COLUMN proof_key_thumbprint TEXT
    `;
  }
  yield* sql`
    CREATE INDEX IF NOT EXISTS auth_sessions_proof_key_thumbprint_idx
    ON auth_sessions(proof_key_thumbprint)
    WHERE proof_key_thumbprint IS NOT NULL
  `;
});
