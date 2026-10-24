// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises the filesystem boundary.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@specweave-studio/shared/Net";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import { cli } from "../binCli.ts";

const runCli = (args: ReadonlyArray<string>) => Command.runWith(cli, { version: "0.0.0" })(args);

const captureStdout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    yield* effect;
    return (
      (yield* TestConsole.logLines).findLast((line): line is string => typeof line === "string") ??
      ""
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer)));

const home = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-fleet-cli-"));

describe("specweave-studio fleet", () => {
  it.effect("says how to add a machine when none is configured", () =>
    Effect.gen(function* () {
      const output = yield* captureStdout(runCli(["fleet", "list", "--base-dir", home()]));
      assert.include(output, "fleet invite");
    }),
  );

  it.effect("removes a machine by name and leaves an owner-only file", () =>
    Effect.gen(function* () {
      const baseDir = home();
      const file = NodePath.join(baseDir, "studio-fleet.json");
      NodeFS.writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          machines: [
            {
              id: "m1",
              label: "Mac M1",
              environmentId: "environment-m1",
              url: "https://m4.fixture.ts.net:8443",
              managementToken: "synthetic-management-token",
            },
          ],
        }),
        { mode: 0o600 },
      );
      const output = yield* captureStdout(
        runCli(["fleet", "remove", "Mac M1", "--base-dir", baseDir]),
      );
      assert.include(output, "Removed Mac M1");
      assert.deepEqual(JSON.parse(NodeFS.readFileSync(file, "utf8")).machines, []);
      // Windows has no POSIX mode bits; the profile folder's ACL keeps the file private.
      if (process.platform !== "win32") {
        assert.strictEqual(NodeFS.statSync(file).mode & 0o777, 0o600);
      }
    }),
  );

  it.effect("refuses a line that is not an invitation without writing anything", () =>
    Effect.gen(function* () {
      const baseDir = home();
      const failure = yield* runCli([
        "fleet",
        "add",
        "https://m1.fixture.ts.net",
        "--base-dir",
        baseDir,
      ]).pipe(
        Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer)),
        Effect.flip,
      );
      assert.include(String(failure.message), "not a machine invitation");
      assert.isFalse(NodeFS.existsSync(NodePath.join(baseDir, "studio-fleet.json")));
    }),
  );
});
