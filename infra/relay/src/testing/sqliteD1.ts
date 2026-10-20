// @effect-diagnostics nodeBuiltinImport:off - test helper reads migration files synchronously.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import * as D1Client from "@effect/sql-d1/D1Client";
import { makeWithDefaults } from "drizzle-orm/effect-d1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Reactivity from "effect/reactivity/Reactivity";

import * as RelayDb from "../db.ts";

const migrationsDir = join(import.meta.dirname, "../../migrations/d1");

const toSqlite = (value: unknown) =>
  value === undefined ? null : typeof value === "boolean" ? (value ? 1 : 0) : value;

class BoundStatement {
  readonly database: DatabaseSync;
  readonly sql: string;
  readonly params: ReadonlyArray<unknown>;

  constructor(database: DatabaseSync, sql: string, params: ReadonlyArray<unknown> = []) {
    this.database = database;
    this.sql = sql;
    this.params = params;
  }

  bind(...params: ReadonlyArray<unknown>) {
    return new BoundStatement(this.database, this.sql, params);
  }

  private prepare(arrays: boolean): StatementSync {
    const statement = this.database.prepare(this.sql);
    statement.setReturnArrays(arrays);
    return statement;
  }

  allSync() {
    const statement = this.prepare(false);
    const params = this.params.map(toSqlite) as Array<never>;
    if (statement.columns().length === 0) {
      const changes = statement.run(...params);
      return { results: [], success: true, meta: { changes: Number(changes.changes) } };
    }
    return { results: statement.all(...params), success: true, meta: {} };
  }

  async all() {
    return this.allSync();
  }

  async raw() {
    return this.prepare(true).all(...(this.params.map(toSqlite) as Array<never>));
  }

  async run() {
    return this.allSync();
  }

  async first() {
    return this.allSync().results[0] ?? null;
  }
}

/** A D1Database over in-memory `node:sqlite`, with the relay's D1 migrations applied. */
export const makeSqliteD1 = () => {
  const database = new DatabaseSync(":memory:");
  for (const entry of readdirSync(migrationsDir).sort()) {
    const sql = readFileSync(join(migrationsDir, entry, "migration.sql"), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim() !== "") database.exec(statement);
    }
  }
  const d1 = {
    prepare: (sql: string) => new BoundStatement(database, sql),
    // D1 runs a batch as one implicit transaction.
    batch: async (statements: ReadonlyArray<BoundStatement>) => {
      database.exec("BEGIN");
      try {
        const results = statements.map((statement) => statement.allSync());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    exec: async (sql: string) => {
      database.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
  return { database, d1: d1 as unknown as D1Database };
};

/** RelayDb backed by an in-memory SQLite database (a fresh one by default). */
export const layerSqliteRelayDb = (d1: D1Database = makeSqliteD1().d1) =>
  Layer.effect(
    RelayDb.RelayDb,
    Effect.gen(function* () {
      const client = yield* D1Client.make({ db: d1 });
      return yield* makeWithDefaults({}).pipe(Effect.provideService(D1Client.D1Client, client));
    }),
  ).pipe(Layer.provide(Reactivity.layer));
