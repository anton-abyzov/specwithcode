import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE auth_principal_revocations (principal TEXT PRIMARY KEY, revoked_at TEXT, generation INTEGER NOT NULL DEFAULT 0)`;
  yield* sql`ALTER TABLE auth_sessions ADD COLUMN principal TEXT`;
  yield* sql`ALTER TABLE auth_pairing_links ADD COLUMN principal TEXT`;
  yield* sql`ALTER TABLE auth_sessions ADD COLUMN principal_generation INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE auth_pairing_links ADD COLUMN principal_generation INTEGER NOT NULL DEFAULT 0`;
  // The check and insert are one SQLite statement, including after a concurrent restore.
  yield* sql`CREATE TRIGGER auth_session_principal_generation BEFORE INSERT ON auth_sessions
    WHEN NEW.principal IS NOT NULL AND (
      NEW.principal_generation != COALESCE((SELECT generation FROM auth_principal_revocations WHERE principal = NEW.principal), 0)
      OR (SELECT revoked_at FROM auth_principal_revocations WHERE principal = NEW.principal) IS NOT NULL
    ) BEGIN SELECT RAISE(ABORT, 'Principal approval is no longer current'); END`;
  yield* sql`CREATE TRIGGER auth_pairing_principal_generation BEFORE INSERT ON auth_pairing_links
    WHEN NEW.principal IS NOT NULL AND (
      NEW.principal_generation != COALESCE((SELECT generation FROM auth_principal_revocations WHERE principal = NEW.principal), 0)
      OR (SELECT revoked_at FROM auth_principal_revocations WHERE principal = NEW.principal) IS NOT NULL
    ) BEGIN SELECT RAISE(ABORT, 'Principal approval is no longer current'); END`;
});
