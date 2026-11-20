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
import * as SpecweaveSetupRequests from "./SpecweaveSetupRequests.ts";
import { listProjectIncrements, specweaveState } from "./ThreadIncrementProgress.ts";

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
  it.live("keeps the increments of an unfinished folder, which then reads as on (1396 AC-08)", () =>
    Effect.gen(function* () {
      const bin = yield* Effect.promise(() => tempDir("specweave-setup-bin-"));
      const project = yield* Effect.promise(() => repoDir("specweave-setup-half-"));
      const folder = NodePath.join(project, ".specweave/increments/0001-simple-website");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(folder, { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(folder, "metadata.json"),
          JSON.stringify({ title: "Simple website", status: "planned" }),
        );
        await NodeFSP.writeFile(NodePath.join(folder, "spec.md"), "# Simple website\n");
      });
      expect(yield* Effect.promise(() => specweaveState(project))).toBe("unfinished");
      // Like the real init: writes the config and leaves increments alone.
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

      expect(yield* setup.setUp(project)).toEqual({ ok: true, alreadySetUp: false });
      expect(yield* Effect.promise(() => specweaveState(project))).toBe("on");
      const listed = yield* Effect.promise(() => listProjectIncrements(project, null));
      expect(listed.map((entry) => [entry.incrementId, entry.title])).toEqual([
        ["0001-simple-website", "Simple website"],
      ]);
      expect(
        yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(folder, "spec.md"), "utf8")),
      ).toBe("# Simple website\n");
    }),
  );

  it.live(
    "remembers a failure with its reason and Node.js missing, until a success (1396 AC-08)",
    () =>
      Effect.gen(function* () {
        const bin = yield* Effect.promise(() => tempDir("specweave-setup-bin-"));
        const project = yield* Effect.promise(() => repoDir("specweave-setup-fail-"));
        const state = yield* Effect.promise(() => tempDir("specweave-setup-state-"));
        const file = SpecweaveSetupRequests.specweaveSetupFile(state);
        writeFakeCli({
          directory: bin,
          name: "specweave",
          source: 'console.error("disk full"); process.exit(4);',
        });
        const failed = yield* (yield* setupWith(bin)).setUp(project);
        expect(failed.ok).toBe(false);
        if (failed.ok) return;
        yield* Effect.promise(() =>
          SpecweaveSetupRequests.recordSetupFailure(file, "project-1", {
            detail: failed.detail,
            needsNode: failed.needs === "node",
          }),
        );
        yield* Effect.promise(() => SpecweaveSetupRequests.recordDeclined(file, "project-1"));
        const stored = yield* Effect.promise(() =>
          SpecweaveSetupRequests.readProjectFacts(file, "project-1"),
        );
        expect(stored.failure?.detail).toContain("disk full");
        expect(stored.failure?.needsNode).toBeUndefined();
        expect(stored.declined).toBe(true);
        // A missing Node.js is stored as such, so the Board offers to install it.
        yield* Effect.promise(() =>
          SpecweaveSetupRequests.recordSetupFailure(file, "project-1", {
            detail: SpecweaveSetup.specweaveUnavailableDetail("darwin"),
            needsNode: true,
          }),
        );
        expect(
          (yield* Effect.promise(() => SpecweaveSetupRequests.readProjectFacts(file, "project-1")))
            .failure?.needsNode,
        ).toBe(true);
        // The next success clears the failure and the decline, and nothing else.
        yield* Effect.promise(() => SpecweaveSetupRequests.recordAdviceSeen(file, "project-1"));
        yield* Effect.promise(() => SpecweaveSetupRequests.recordSetupSuccess(file, "project-1"));
        expect(
          yield* Effect.promise(() => SpecweaveSetupRequests.readProjectFacts(file, "project-1")),
        ).toEqual({ adviceSeen: true });
      }),
  );

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

  it("gives advice that needs no sudo and no reinstall when Node is missing", () => {
    const detail = SpecweaveSetup.specweaveUnavailableDetail("linux");
    expect(detail).toContain("neither specweave nor npx");
    expect(detail).toContain("~/.local/bin");
    expect(detail).not.toContain("npm i -g");
    expect(detail).not.toContain("sudo");
    expect(SpecweaveSetup.specweaveUnavailableDetail("win32")).toContain("nodejs.org");
  });

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

  it.live(
    "with initGit, runs git init first, stages nothing and keeps a parent repository's refusal",
    () =>
      Effect.gen(function* () {
        const bin = yield* Effect.promise(() => tempDir("specweave-setup-bin-"));
        // Records whether a repository existed when the CLI ran.
        writeFakeCli({
          directory: bin,
          name: "specweave",
          source: [
            'import { existsSync, mkdirSync, writeFileSync } from "node:fs";',
            'mkdirSync(".specweave/increments", { recursive: true });',
            'writeFileSync(".specweave/config.json", JSON.stringify({ git: existsSync(".git") }));',
          ].join("\n"),
        });
        const setup = yield* setupWith(bin);

        const plain = yield* Effect.promise(() => tempDir("specweave-setup-git-"));
        // Written before setup, like an increment a worker planned with SpecWeave off.
        const early = NodePath.join(plain, ".specweave", "increments", "0001-simple-site");
        yield* Effect.promise(() => NodeFSP.mkdir(early, { recursive: true }));
        yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(early, "spec.md"), "# Site\n"));
        yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(plain, "notes.txt"), "mine"));

        expect(yield* setup.setUp(plain, { initGit: true })).toEqual({
          ok: true,
          alreadySetUp: false,
          gitInitialized: true,
        });
        const config = JSON.parse(
          yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(plain, ".specweave", "config.json"), "utf8"),
          ),
        );
        expect(config.git).toBe(true);
        expect(
          execFileSync("git", ["rev-parse", "--show-toplevel"], {
            cwd: plain,
            encoding: "utf8",
          }).trim(),
        ).toBe(yield* Effect.promise(() => NodeFSP.realpath(plain)));
        // Nothing of the person's is staged or committed.
        expect(
          execFileSync("git", ["diff", "--cached", "--name-only"], {
            cwd: plain,
            encoding: "utf8",
          }),
        ).toBe("");
        const tracked = execFileSync("git", ["ls-files"], { cwd: plain, encoding: "utf8" });
        expect(tracked).toBe("");
        expect(
          yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(early, "spec.md"), "utf8")),
        ).toBe("# Site\n");

        // A subfolder of a repository is still refused, and no repository is nested in it.
        const repo = yield* Effect.promise(() => repoDir("specweave-setup-outer-"));
        const sub = NodePath.join(repo, "apps", "site");
        yield* Effect.promise(() => NodeFSP.mkdir(sub, { recursive: true }));
        const nested = yield* setup.setUp(sub, { initGit: true });
        expect(nested.ok ? "" : nested.detail).toContain("inside the Git repository at");
        expect(
          yield* Effect.promise(() =>
            NodeFSP.access(NodePath.join(sub, ".git")).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false);
      }),
  );
});
