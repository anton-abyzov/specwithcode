// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises the filesystem boundary.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@specweave-studio/shared/Net";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { cli } from "../binCli.ts";
import * as ServerConfig from "../config.ts";
import { resolveCliAuthConfig } from "./config.ts";

const runCli = (args: ReadonlyArray<string>) => Command.runWith(cli, { version: "0.0.0" })(args);

const layerCliRuntime = Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer);

/** The latest command's output: each Console.log call is one entry. */
const captureStdout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    yield* effect;
    return (
      (yield* TestConsole.logLines).findLast((line): line is string => typeof line === "string") ??
      ""
    );
  });

/** What `/mcp` decides for this bearer, from the home's own auth store. */
const mcpAccepts = (baseDir: string, token: string) =>
  Effect.gen(function* () {
    const config = yield* resolveCliAuthConfig({ baseDir: Option.some(baseDir) }, Option.none());
    return yield* Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      return yield* auth
        .authenticateMcpClient(
          HttpServerRequest.fromWeb(
            new Request("http://127.0.0.1/mcp", {
              method: "POST",
              headers: { authorization: `Bearer ${token}` },
            }),
          ),
        )
        .pipe(Effect.option);
    }).pipe(
      Effect.provide(
        EnvironmentAuth.layerRuntime.pipe(
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error")),
        ),
      ),
    );
  });

interface IssuedJson {
  readonly sessionId: string;
  readonly token: string;
  readonly tokenType: string;
  readonly label: string;
  readonly access: string;
  readonly expiresAt: string;
}

describe("specweave-studio auth mcp-token", () => {
  it.live("mints a token /mcp accepts as a bearer, lists it, and revokes it", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-mcp-token-test-"));
      const created = yield* captureStdout(
        runCli([
          "auth",
          "mcp-token",
          "create",
          "--base-dir",
          baseDir,
          "--label",
          "Grok",
          "--access",
          "read-only",
          "--ttl",
          "7d",
          "--json",
        ]),
      );
      const issued = JSON.parse(created) as IssuedJson;
      assert.strictEqual(issued.tokenType, "Bearer");
      assert.strictEqual(issued.access, "read-only");
      assert.strictEqual(issued.label, "Grok");
      const days = (Date.parse(issued.expiresAt) - (yield* Clock.currentTimeMillis)) / 86_400_000;
      assert.isTrue(days > 6.9 && days <= 7, `expires in ${String(days)} days`);

      const accepted = yield* mcpAccepts(baseDir, issued.token);
      assert.isTrue(Option.isSome(accepted));
      if (Option.isSome(accepted)) {
        assert.strictEqual(accepted.value.sessionId, issued.sessionId);
        assert.strictEqual(accepted.value.access, "read-only");
        assert.strictEqual(accepted.value.label, "Grok");
      }

      // Listed with MCP clients only, never with its token.
      yield* runCli(["auth", "session", "issue", "--base-dir", baseDir, "--token-only"]);
      const listed = yield* captureStdout(
        runCli(["auth", "mcp-token", "list", "--base-dir", baseDir, "--json"]),
      );
      assert.notInclude(listed, issued.token);
      const rows = JSON.parse(listed) as ReadonlyArray<{ sessionId: string; subject: string }>;
      assert.deepEqual(
        rows.map((row) => [row.sessionId, row.subject]),
        [[issued.sessionId, EnvironmentAuth.MCP_CLIENT_SUBJECT]],
      );

      const revoked = yield* captureStdout(
        runCli(["auth", "mcp-token", "revoke", "--base-dir", baseDir, issued.sessionId]),
      );
      assert.include(revoked, `Revoked MCP client ${issued.sessionId}.`);
      assert.isTrue(Option.isNone(yield* mcpAccepts(baseDir, issued.token)));
      const listedAfter = yield* captureStdout(
        runCli(["auth", "mcp-token", "list", "--base-dir", baseDir, "--json"]),
      );
      assert.deepEqual(JSON.parse(listedAfter), []);
    }).pipe(Effect.provide(layerCliRuntime)),
  );

  it.live("prints the bearer header once and refuses a TTL beyond 90 days", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-mcp-token-test-"));
      const output = yield* captureStdout(
        runCli(["auth", "mcp-token", "create", "--base-dir", baseDir, "--label", "n8n"]),
      );
      assert.include(output, "Access: auto");
      assert.match(output, /Authorization: Bearer \S+/);

      const error = yield* runCli([
        "auth",
        "mcp-token",
        "create",
        "--base-dir",
        baseDir,
        "--label",
        "bot",
        "--ttl",
        "91d",
      ]).pipe(Effect.flip);
      assert.include(String(error), "1 minute to 90 days");

      // A session id that is not an MCP client is left alone.
      const sessionToken = yield* captureStdout(
        runCli(["auth", "session", "issue", "--base-dir", baseDir, "--json"]),
      );
      const { sessionId } = JSON.parse(sessionToken) as { sessionId: string };
      const refused = yield* captureStdout(
        runCli(["auth", "mcp-token", "revoke", "--base-dir", baseDir, sessionId]),
      );
      assert.include(refused, "No active MCP client found");
    }).pipe(Effect.provide(layerCliRuntime)),
  );
});
