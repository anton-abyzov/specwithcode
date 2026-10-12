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

const runCli = (args: ReadonlyArray<string>) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer)),
  );

const writeMod = (folder: string, manifest: Record<string, unknown>, source?: string) => {
  NodeFS.mkdirSync(folder, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(folder, "mod.json"), JSON.stringify(manifest));
  if (source !== undefined) NodeFS.writeFileSync(NodePath.join(folder, "register.js"), source);
};

const manifest = { name: "status-clock", version: "1.0.0", main: "register.js" };

describe("specweave-studio mods", () => {
  it.effect("validates a loadable mod folder and prints its hash", () =>
    Effect.gen(function* () {
      const folder = NodePath.join(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-mods-cli-")),
        "status-clock",
      );
      writeMod(folder, manifest, "export function register(on) {}\n");
      yield* runCli(["mods", "validate", folder]);
      const output = (yield* TestConsole.logLines).join("\n");
      assert.include(output, "status-clock 1.0.0 is a loadable mod.");
      assert.match(output, /Content hash: [0-9a-f]{64}/u);
    }),
  );

  it.effect("fails on a folder Studio would not load", () =>
    Effect.gen(function* () {
      const folder = NodePath.join(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-mods-cli-")),
        "other-name",
      );
      writeMod(folder, manifest);
      const error = yield* runCli(["mods", "validate", folder]).pipe(Effect.flip);
      assert.equal((error as { _tag?: string })._tag, "ModInvalidError");
      const problems = (yield* TestConsole.errorLines).join("\n");
      assert.include(problems, 'names "status-clock" but the folder is "other-name"');
      assert.include(problems, "register.js is missing");
    }),
  );

  it.effect("lists installed mods with their status", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-mods-cli-"));
      writeMod(
        NodePath.join(baseDir, "userdata", "mods", "status-clock"),
        { ...manifest, permissions: ["threads:read"] },
        "export function register(on) {}\n",
      );
      yield* runCli(["mods", "list", "--base-dir", baseDir]);
      const output = (yield* TestConsole.logLines).join("\n");
      assert.include(output, "status-clock 1.0.0: pending (permissions: threads:read)");
    }),
  );
});
