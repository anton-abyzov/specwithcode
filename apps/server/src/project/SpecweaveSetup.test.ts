// @effect-diagnostics nodeBuiltinImport:off - Plain temp folders around a fake CLI, like fleetSkills.test.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { execFileSync } from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ProcessRunner from "../processRunner.ts";
import { writeFakeCli } from "../testUtils/fakeCli.ts";
import * as SpecweaveSetup from "./SpecweaveSetup.ts";

const tempDir = (prefix: string) => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));
/** A project folder that is the top of its own Git repository. */
const repoDir = async (prefix: string) => {
  const dir = await tempDir(prefix);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
};

/** The service with `bin`, this test's `node` and the system tools on PATH. */
const setupWith = (bin: string) =>
  Effect.provide(
    SpecweaveSetup.SpecweaveSetup,
    SpecweaveSetup.layer.pipe(
      Layer.provide(ProcessRunner.layer),
      Layer.provide(NodeServices.layer),
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              PATH: [bin, NodePath.dirname(process.execPath), "/usr/bin", "/bin"].join(
                NodePath.delimiter,
              ),
            },
          }),
        ),
      ),
    ),
  );

describe("SpecweaveSetup", () => {
  it.live("runs specweave init in the folder and reports success once the config exists", () =>
    Effect.gen(function* () {
      const bin = yield* Effect.promise(() => tempDir("specweave-setup-bin-"));
      const project = yield* Effect.promise(() => repoDir("specweave-setup-project-"));
      writeFakeCli({
        directory: bin,
        name: "specweave",
        source: [
          'import { mkdirSync, writeFileSync } from "node:fs";',
          'mkdirSync(".specweave", { recursive: true });',
          'writeFileSync(".specweave/config.json", JSON.stringify({ args: process.argv.slice(2) }));',
        ].join("\n"),
      });
      const setup = yield* setupWith(bin);

      expect(yield* setup.setUp(project)).toEqual({ ok: true, alreadySetUp: false });
      const config = JSON.parse(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(project, ".specweave", "config.json"), "utf8"),
        ),
      );
      expect(config.args).toEqual([...SpecweaveSetup.SPECWEAVE_INIT_ARGS]);
      expect(config.args).not.toContain("--force");
      // A second request leaves the set-up folder alone.
      expect(yield* setup.setUp(project)).toEqual({ ok: true, alreadySetUp: true });
    }),
  );

  it.live("says why when init fails or writes no config", () =>
    Effect.gen(function* () {
      const bin = yield* Effect.promise(() => tempDir("specweave-setup-bin-"));
      const project = yield* Effect.promise(() => repoDir("specweave-setup-project-"));
      writeFakeCli({
        directory: bin,
        name: "specweave",
        source: 'console.error("Not a git repository"); process.exit(3);',
      });
      const failed = yield* (yield* setupWith(bin)).setUp(project);
      expect(failed).toMatchObject({ ok: false, reason: "failed" });
      expect(failed.ok ? "" : failed.detail).toContain("exited with 3: Not a git repository");

      writeFakeCli({ directory: bin, name: "specweave", source: "process.exit(0);" });
      const empty = yield* (yield* setupWith(bin)).setUp(project);
      expect(empty.ok ? "" : empty.detail).toContain("without writing .specweave/config.json");
    }),
  );

  it.live("refuses a folder that is not the top of a Git repository, or has a linked config", () =>
    Effect.gen(function* () {
      const bin = yield* Effect.promise(() => tempDir("specweave-setup-bin-"));
      // A CLI that would write a config if it ran: none of these cases may run it.
      writeFakeCli({
        directory: bin,
        name: "specweave",
        source: [
          'import { mkdirSync, writeFileSync } from "node:fs";',
          'mkdirSync(".specweave", { recursive: true });',
          'writeFileSync(".specweave/config.json", "{}");',
        ].join("\n"),
      });
      const setup = yield* setupWith(bin);

      const plain = yield* Effect.promise(() => tempDir("specweave-setup-plain-"));
      const notRepo = yield* setup.setUp(plain);
      expect(notRepo.ok ? "" : notRepo.detail).toContain("this folder is not one");

      const repo = yield* Effect.promise(() => repoDir("specweave-setup-outer-"));
      const sub = NodePath.join(repo, "packages", "foo");
      yield* Effect.promise(() => NodeFSP.mkdir(sub, { recursive: true }));
      const nested = yield* setup.setUp(sub);
      expect(nested.ok ? "" : nested.detail).toContain("inside the Git repository at");

      const linked = yield* Effect.promise(() => repoDir("specweave-setup-linked-"));
      const shared = NodePath.join(linked, "shared.json");
      yield* Effect.promise(() => NodeFSP.writeFile(shared, '{"custom":"KEEP-ME"}'));
      yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(linked, ".specweave")));
      yield* Effect.promise(() =>
        NodeFSP.symlink(shared, NodePath.join(linked, ".specweave", "config.json")),
      );
      const link = yield* setup.setUp(linked);
      expect(link.ok ? "" : link.detail).toContain("is a link");
      expect(yield* Effect.promise(() => NodeFSP.readFile(shared, "utf8"))).toBe(
        '{"custom":"KEEP-ME"}',
      );
      for (const folder of [plain, sub]) {
        expect(
          yield* Effect.promise(() =>
            NodeFSP.access(NodePath.join(folder, ".specweave")).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false);
      }
    }),
  );
});
