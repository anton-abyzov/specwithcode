// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises the filesystem boundary.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@specweave-studio/shared/Net";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { cli } from "../binCli.ts";
import * as ServerConfig from "../config.ts";
import { resolveCliAuthConfig } from "./config.ts";

const runCli = (args: ReadonlyArray<string>) => Command.runWith(cli, { version: "0.0.0" })(args);
const layerCliRuntime = Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer);

const withAuth = <A, E>(
  baseDir: string,
  use: (auth: EnvironmentAuth.EnvironmentAuth["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const config = yield* resolveCliAuthConfig({ baseDir: Option.some(baseDir) }, Option.none());
    return yield* EnvironmentAuth.EnvironmentAuth.pipe(
      Effect.flatMap(use),
      Effect.provide(
        EnvironmentAuth.layerRuntime.pipe(
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error")),
        ),
      ),
    );
  });

describe("specweave-studio auth session revoke, server stopped", () => {
  it.live("ends every session on a Connect device's key, as the running server does", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-cli-revoke-"));
      const [phone, phoneAgain, other] = yield* withAuth(baseDir, (auth) =>
        Effect.all([
          auth.issueSession({ subject: "cloud-connect", proofKeyThumbprint: "phone-key" }),
          auth.issueSession({ subject: "cloud-connect", proofKeyThumbprint: "phone-key" }),
          auth.issueSession({ label: "Laptop" }),
        ]),
      );

      yield* runCli(["auth", "session", "revoke", "--base-dir", baseDir, phone.sessionId]);

      const active = yield* withAuth(baseDir, (auth) => auth.listSessions());
      const ids = active.map((session) => session.sessionId);
      assert.notInclude(ids, phone.sessionId);
      // The phone would otherwise sign itself back in with the same key.
      assert.notInclude(ids, phoneAgain.sessionId);
      assert.include(ids, other.sessionId);

      yield* runCli(["auth", "session", "revoke", "--base-dir", baseDir, other.sessionId]);
      const after = yield* withAuth(baseDir, (auth) => auth.listSessions());
      assert.notInclude(
        after.map((session) => session.sessionId),
        other.sessionId,
      );
    }).pipe(Effect.provide(layerCliRuntime)),
  );
});
