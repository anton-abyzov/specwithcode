import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Who sent a command and which settings changed, for `rules records`. Written
// only while a machine has Team rules, so other machines keep these empty.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS team_rules_command_actors (
      command_id TEXT PRIMARY KEY,
      person TEXT NOT NULL,
      os_user TEXT,
      device_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS team_rules_settings_changes (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at TEXT NOT NULL,
      paths_json TEXT NOT NULL,
      person TEXT,
      os_user TEXT,
      device_json TEXT
    )
  `;
});
