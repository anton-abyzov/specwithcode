// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises a real database on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@specweave-studio/shared/Net";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import { cli } from "../binCli.ts";

const runCli = (args: ReadonlyArray<string>) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer)),
  );

/** A home whose database another connection holds open in WAL mode, as the service does. */
const withHeldHome = <A, E, R>(use: (home: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-db-cli-"));
      NodeFS.mkdirSync(NodePath.join(home, "userdata"));
      const holder = new NodeSqlite.DatabaseSync(NodePath.join(home, "userdata", "statev2.sqlite"));
      holder.exec(
        "PRAGMA journal_mode=WAL; CREATE TABLE t(id INTEGER PRIMARY KEY, big INTEGER, b BLOB);",
      );
      holder.exec("INSERT INTO t(big, b) VALUES (9007199254740993, x'beef'), (7, NULL);");
      return { home, holder };
    }),
    ({ home }) => use(home),
    ({ home, holder }) =>
      Effect.sync(() => {
        holder.close();
        NodeFS.rmSync(home, { recursive: true, force: true });
      }),
  );

describe("specweave-studio db", () => {
  it.effect("queries the live database read-only, one JSON line per row", () =>
    withHeldHome((home) =>
      Effect.gen(function* () {
        yield* runCli(["db", "query", "--base-dir", home, "SELECT id, big, b FROM t ORDER BY id"]);
        assert.deepEqual(yield* TestConsole.logLines, [
          '{"id":1,"big":"9007199254740993","b":{"blobHex":"beef"}}',
          '{"id":2,"big":7,"b":null}',
        ]);
        const write = yield* Effect.flip(
          runCli(["db", "query", "--base-dir", home, "DELETE FROM t"]),
        );
        assert.match(String(write), /readonly|read-only/i);
      }),
    ),
  );

  it.effect("writes a snapshot to a new file and refuses to overwrite one", () =>
    withHeldHome((home) =>
      Effect.gen(function* () {
        const output = NodePath.join(home, "copy.sqlite");
        yield* runCli(["db", "snapshot", "--base-dir", home, output]);
        assert.match((yield* TestConsole.logLines).join("\n"), /quick_check ok/);
        const copy = new NodeSqlite.DatabaseSync(output, { readOnly: true });
        assert.equal(copy.prepare("SELECT count(*) AS n FROM t").get()?.n, 2);
        copy.close();
        const again = yield* Effect.flip(runCli(["db", "snapshot", "--base-dir", home, output]));
        assert.match(String(again), /already exists/);
      }),
    ),
  );
});
