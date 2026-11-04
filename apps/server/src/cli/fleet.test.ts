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
import { describeFleetDiskRoom, fleetDiskRoomAskOf } from "./fleet.ts";
import * as Option from "effect/Option";

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

  it.effect("lists this machine as a table row without a token note", () =>
    Effect.gen(function* () {
      const baseDir = home();
      NodeFS.mkdirSync(NodePath.join(baseDir, "userdata"));
      NodeFS.writeFileSync(
        NodePath.join(baseDir, "userdata", "environment-id"),
        "environment-m4\n",
      );
      NodeFS.writeFileSync(
        NodePath.join(baseDir, "studio-fleet.json"),
        JSON.stringify({
          version: 1,
          machines: [
            {
              id: "m4",
              label: "Mac M4",
              environmentId: "environment-m4",
              url: "https://m4.fixture.ts.net",
            },
          ],
        }),
        { mode: 0o600 },
      );
      const output = yield* captureStdout(runCli(["fleet", "list", "--base-dir", baseDir]));
      assert.deepEqual(output.split("\n"), [
        "MACHINE  STATUS       ROUTE         FALLBACK",
        "m4       unreachable  this machine  -",
        "  Name       Mac M4",
        "  Tailscale  https://m4.fixture.ts.net",
        "  Note       service not answering",
        "",
      ]);
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

describe("specweave-studio fleet room", () => {
  const room = (args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const line = yield* captureStdout(runCli(["fleet", "room", "--json", ...args]));
      const failed = process.exitCode;
      process.exitCode = undefined;
      return { body: JSON.parse(line) as Record<string, unknown>, failed };
    });

  it.effect("prints a usage failure for a bad version or FULL_READ list, as one JSON line", () =>
    Effect.gen(function* () {
      for (const flags of [
        ["--full-read", "69"],
        ["--version", "1.0.190", "--full-read", "../x"],
      ]) {
        const { body, failed } = yield* room(["--base-dir", home(), "m1", ...flags]);
        assert.strictEqual(body.reason, "usage");
        assert.strictEqual(failed, 1);
      }
    }),
  );

  it.effect("names a machine this primary does not know", () =>
    Effect.gen(function* () {
      const { body, failed } = yield* room(["--base-dir", home(), "m9", "--version", "1.0.190"]);
      assert.strictEqual(body.reason, "unknown-machine");
      assert.include(String(body.error), "m9");
      assert.strictEqual(failed, 1);
    }),
  );

  it("maps flags to the narrow ask and prints one human line", () => {
    assert.deepEqual(fleetDiskRoomAskOf({ version: Option.some("1.0.190"), fullRead: "none" }), {
      version: "1.0.190",
      fullRead: "none",
    });
    assert.isString(fleetDiskRoomAskOf({ version: Option.none(), fullRead: "69,73" }));
    assert.isString(fleetDiskRoomAskOf({ version: Option.some("1.0.190"), fullRead: "69;73" }));
    const report = { ok: false, version: "1.0.190", freeBytes: 2 * 1024 ** 3, volume: "/" };
    assert.strictEqual(
      describeFleetDiskRoom("Mac M1", {
        ...report,
        needBytes: 3 * 1024 ** 3,
        transport: "connect",
      }),
      "Mac M1 is short of disk for 1.0.190: 2.0 GiB free, 3.0 GiB needed on /, reached over SpecWithCode Connect.",
    );
  });
});
