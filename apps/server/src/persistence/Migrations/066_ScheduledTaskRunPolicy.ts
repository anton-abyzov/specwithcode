import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // { modelPinned?, check? } as JSON; NULL is an unpinned task with no check.
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN run_policy_json TEXT`;
});
