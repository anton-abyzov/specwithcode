import type { D1Client } from "@effect/sql-d1/D1Client";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Alchemy from "alchemy";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import type { EffectSQLiteD1Database } from "drizzle-orm/effect-d1";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { SqlError } from "effect/sql/SqlError";

export type RelayDatabase = EffectSQLiteD1Database & {
  readonly $client: D1Client;
};

export class RelayDb extends Context.Service<RelayDb, RelayDatabase>()("studio-relay/db/RelayDb") {}

/** A drizzle query that can be compiled without running it. */
export interface BatchableQuery {
  readonly toSQL: () => { readonly sql: string; readonly params: ReadonlyArray<unknown> };
}

/**
 * Runs the queries as one D1 batch: a single implicit transaction that
 * commits or rolls back as a whole. D1 has no interactive transactions, so
 * this replaces `withTransaction` for fixed sets of writes. Each result is the
 * raw row list (database column names) of the matching statement.
 */
export const batch = (
  db: RelayDatabase,
  queries: ReadonlyArray<BatchableQuery>,
): Effect.Effect<ReadonlyArray<ReadonlyArray<Record<string, unknown>>>, SqlError> =>
  db.$client.batch(
    queries.map((query) => {
      const compiled = query.toSQL();
      return db.$client.unsafe<Record<string, unknown>>(
        compiled.sql,
        compiled.params as Array<unknown>,
      );
    }),
  );

export const RelayD1Database = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;
  const schema = yield* Drizzle.Schema("RelaySchema", {
    schema: "./src/persistence/schema.ts",
    out: "./migrations/d1",
    dialect: "sqlite",
  });
  return yield* Cloudflare.D1.Database("RelayDatabase", {
    primaryLocationHint: "wnam",
    migrations: schema,
  }).pipe(RemovalPolicy.retain(stage === "prod"));
});
