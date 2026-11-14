import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The approved device that created a pairing link, and the approval it held
 * (1327). Redemption rechecks it and Remove revokes the unredeemed ones. A
 * table of its own rather than a new column on the pairing link table, so an
 * update keeps the page proof instead of reading the whole database.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS device_pairing_creators (
      pairing_link_id TEXT PRIMARY KEY,
      device_key TEXT NOT NULL,
      approval TEXT NOT NULL
    )
  `;
});
