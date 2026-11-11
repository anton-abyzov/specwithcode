import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The assistant's default name changed from "Aide" to "Percy". This records,
 * once, which personal assistants still carry the old default; the server
 * renames them through `project.meta.update` after startup
 * (`project/PercyRename.ts`) and removes each row. A migration runs once, so
 * an assistant renamed back to "Aide" later keeps that name.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS percy_rename_pending (
      project_id TEXT PRIMARY KEY
    )
  `;

  yield* sql`
    INSERT OR IGNORE INTO percy_rename_pending (project_id)
    SELECT project_id
    FROM projection_projects
    WHERE deleted_at IS NULL
      AND trim(title) = 'Aide'
      AND workspace_settings_json IS NOT NULL
      AND json_valid(workspace_settings_json)
      AND json_extract(workspace_settings_json, '$.kind') = 'personal'
  `;
});
