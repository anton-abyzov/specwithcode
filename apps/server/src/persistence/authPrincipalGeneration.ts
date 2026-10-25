import { AuthPrincipal } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { PersistenceSqlError } from "./Errors.ts";

const encodePrincipal = Schema.encodeSync(Schema.fromJsonString(AuthPrincipal));

/** Capture at approval, then carry unchanged through every descendant credential. */
export const currentPrincipalGeneration = (sql: SqlClient.SqlClient, principal: AuthPrincipal) =>
  Effect.gen(function* () {
    const rows = yield* sql<{
      generation: number;
      revoked_at: string | null;
    }>`SELECT generation, revoked_at FROM auth_principal_revocations WHERE principal = ${encodePrincipal(principal)}`;
    if (rows[0]?.revoked_at != null)
      return yield* Effect.fail(
        new PersistenceSqlError({ operation: "principalApproval", cause: "Principal is revoked" }),
      );
    return rows[0]?.generation ?? 0;
  }).pipe(
    Effect.mapError((cause) => new PersistenceSqlError({ operation: "principalApproval", cause })),
  );
