// @effect-diagnostics nodeBuiltinImport:off - Checks the published credential file on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as LocalCliCredential from "./LocalCliCredential.ts";
import * as SessionStore from "./SessionStore.ts";

const home = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-local-cli-cred-"));

/** One service start: the auth store with the credential layer, on the given home. */
const start = (baseDir: string) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      LocalCliCredential.layer.pipe(
        Layer.provideMerge(EnvironmentAuth.layerRuntime),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
      ),
      scope,
    );
    const config = yield* Effect.gen(function* () {
      return yield* ServerConfig.ServerConfig;
    }).pipe(Effect.provide(context));
    const file = NodePath.join(
      config.secretsDir,
      `${LocalCliCredential.LOCAL_CLI_CREDENTIAL_SECRET}.bin`,
    );
    const rows = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{ readonly session_id: string }>`SELECT session_id FROM auth_sessions`;
    }).pipe(Effect.provide(context));
    const verify = (token: string) =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        return yield* sessions.verify(token);
      }).pipe(Effect.provide(context));
    return { file, rows, verify, stop: Scope.close(scope, Exit.void) };
  });

describe("LocalCliCredential.layer", () => {
  it.effect(
    "publishes a new token on every start, writes no auth row, and removes it on stop",
    () =>
      Effect.gen(function* () {
        const baseDir = home();
        const first = yield* start(baseDir);
        const firstToken = NodeFS.readFileSync(first.file, "utf8").trim();
        // Windows has no POSIX modes; the file inherits the home folder's ACL.
        if (process.platform !== "win32") {
          assert.equal((NodeFS.statSync(first.file).mode & 0o777).toString(8), "600");
        }
        const verified = yield* first.verify(firstToken);
        assert.equal(verified.subject, LocalCliCredential.LOCAL_CLI_CREDENTIAL_SUBJECT);
        // The update helper's post-restart proof requires unchanged auth rows.
        assert.deepStrictEqual(yield* first.rows, []);
        yield* first.stop;
        assert.isFalse(NodeFS.existsSync(first.file));

        const second = yield* start(baseDir);
        const secondToken = NodeFS.readFileSync(second.file, "utf8").trim();
        assert.notEqual(secondToken, firstToken);
        // A token from the previous start, copied while it ran, no longer works.
        const refused = yield* second.verify(firstToken).pipe(Effect.flip);
        assert.equal(refused._tag, "UnknownSessionTokenError");
        assert.equal((yield* second.verify(secondToken)).subject, "local-cli-credential");
        assert.deepStrictEqual(yield* second.rows, []);
        yield* second.stop;
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
