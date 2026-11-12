// @effect-diagnostics nodeBuiltinImport:off globalDate:off - CLI integration over a real database, a local bare origin and real clones.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@specweave-studio/shared/Net";
import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import { cli } from "../binCli.ts";
import { CLONES_SWEEP_REFUSED } from "./clones.ts";

/** Runs the CLI and returns its exit code, leaving the test process's own code untouched. */
const runCli = (args: ReadonlyArray<string>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.exitCode;
      process.exitCode = undefined;
      return previous;
    }),
    () =>
      // Clone ages are real file times, so the CLI reads the wall clock.
      Effect.andThen(
        TestClock.setTime(Date.now()),
        Command.runWith(cli, { version: "0.0.0" })(args),
      ).pipe(
        Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer)),
        Effect.map(() => process.exitCode ?? 0),
      ),
    (previous) =>
      Effect.sync(() => {
        process.exitCode = previous;
      }),
  );

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();

/** Three hours without a change, by the times of git's own files. */
function age(clone: string) {
  const at = (Date.now() - 3 * 60 * 60_000) / 1000;
  for (const name of ["HEAD", "index", "FETCH_HEAD", "ORIG_HEAD", NodePath.join("logs", "HEAD")]) {
    const file = NodePath.join(clone, ".git", name);
    if (NodeFS.existsSync(file)) NodeFS.utimesSync(file, at, at);
  }
}

interface Fixture {
  readonly home: string;
  readonly scratch: string;
  readonly merged: string;
  readonly dirty: string;
  readonly bound: string;
  readonly foreign: string;
}

/**
 * A home whose database another connection holds open in WAL mode, as the
 * service does, with one registered project (a checkout of a local bare
 * origin) and four clones in scratch: merged, dirty, bound to an open thread,
 * and of a repository no project registers.
 */
const withHome = <A, E, R>(
  use: (fixture: Fixture) => Effect.Effect<A, E, R>,
  options: { readonly database?: boolean } = {},
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const home = NodeFS.realpathSync(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-clones-cli-")),
      );
      const origin = NodePath.join(home, "origins", "widgets.git");
      const other = NodePath.join(home, "origins", "other.git");
      const project = NodePath.join(home, "projects", "widgets");
      const scratch = NodePath.join(home, "scratch");
      NodeFS.mkdirSync(NodePath.dirname(origin), { recursive: true });
      NodeFS.mkdirSync(NodePath.dirname(project), { recursive: true });
      for (const bare of [origin, other]) {
        git(home, "init", "--quiet", "--bare", "--initial-branch=main", bare);
        const seed = `${bare}.seed`;
        git(home, "clone", "--quiet", bare, seed);
        NodeFS.writeFileSync(NodePath.join(seed, "readme.md"), "one\n");
        git(seed, "add", "-A");
        git(seed, "commit", "--quiet", "-m", "first");
        git(seed, "push", "--quiet", "origin", "HEAD:main");
        NodeFS.rmSync(seed, { recursive: true, force: true });
      }
      git(home, "clone", "--quiet", origin, project);
      const clone = (name: string, from = origin) => {
        const path = NodePath.join(scratch, `2026-11-01-${name}`, "repo");
        NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
        git(home, "clone", "--quiet", from, path);
        return path;
      };
      const merged = clone("merged");
      const dirty = clone("dirty");
      NodeFS.writeFileSync(NodePath.join(dirty, "notes.md"), "unsaved");
      const bound = clone("bound");
      const foreign = clone("foreign", other);
      for (const path of [merged, dirty, bound, foreign]) age(path);

      NodeFS.mkdirSync(NodePath.join(home, "userdata"));
      let holder: NodeSqlite.DatabaseSync | null = null;
      if (options.database !== false) {
        holder = new NodeSqlite.DatabaseSync(NodePath.join(home, "userdata", "statev2.sqlite"));
        holder.exec(`
          PRAGMA journal_mode=WAL;
          CREATE TABLE projection_projects (workspace_root TEXT, deleted_at TEXT, workspace_settings_json TEXT);
          CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, payload_json TEXT, deleted_at TEXT, archived_at TEXT);
          CREATE TABLE orchestration_v2_effect_outbox (thread_id TEXT, status TEXT);
          CREATE TABLE orchestration_v2_projection_provider_sessions (payload_json TEXT, status TEXT, thread_id TEXT);
        `);
        const insert = holder.prepare("INSERT INTO projection_projects VALUES (?, ?, ?)");
        insert.run(project, null, JSON.stringify({ environment: { repositories: [] } }));
        // The Scratch project sits at the scratch root and binds no clone by itself.
        insert.run(scratch, null, null);
        holder
          .prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, ?, ?)")
          .run("reviewer", JSON.stringify({ worktreePath: bound, projectId: "p" }), null, null);
      }
      return { fixture: { home, scratch, merged, dirty, bound, foreign }, holder };
    }),
    ({ fixture }) => use(fixture),
    ({ fixture, holder }) =>
      Effect.sync(() => {
        holder?.close();
        NodeFS.rmSync(fixture.home, { recursive: true, force: true });
      }),
  );

const sweep = (fixture: Fixture, ...flags: ReadonlyArray<string>) =>
  runCli([
    "clones",
    "sweep",
    "--base-dir",
    fixture.home,
    "--root",
    fixture.scratch,
    "--no-pull-requests",
    ...flags,
  ]);

// Windows cannot list process working folders, so the sweep keeps every clone there.
const noProcessList = HostProcessPlatform.defaultValue() === "win32";

describe("specweave-studio clones sweep", () => {
  it.effect.skipIf(noProcessList)("prints the plan and removes nothing without --apply", () =>
    withHome((fixture) =>
      Effect.gen(function* () {
        assert.strictEqual(yield* sweep(fixture), 0);
        const lines = (yield* TestConsole.logLines).map(String);
        const lineFor = (path: string) => lines.find((line) => line.includes(`${path}  `)) ?? "";
        assert.match(lineFor(fixture.merged), /^would go .* merged: HEAD is in origin\/main/);
        assert.match(lineFor(fixture.dirty), /^keep .* uncommitted or untracked files \(1\)$/);
        assert.match(lineFor(fixture.bound), /^keep .* in use by thread reviewer \(open\)$/);
        assert.match(
          lineFor(fixture.foreign),
          /^keep .* origin is not a registered project's repository$/,
        );
        assert.include(
          lines.join("\n"),
          "Dry run: 1 of 4 would be removed. Pass --apply to remove them.",
        );
        for (const path of [fixture.merged, fixture.dirty, fixture.bound, fixture.foreign])
          assert.isTrue(NodeFS.existsSync(NodePath.join(path, ".git")));
      }),
    ),
  );

  it.effect.skipIf(noProcessList)("removes only the merged, clean, unused clone with --apply", () =>
    withHome((fixture) =>
      Effect.gen(function* () {
        assert.strictEqual(yield* sweep(fixture, "--apply", "--json"), 0);
        const rows = (yield* TestConsole.logLines).map(
          (line) => JSON.parse(String(line)) as Record<string, unknown>,
        );
        const removed = rows.find((row) => row.path === fixture.merged)!;
        assert.strictEqual(removed.result, "removed");
        assert.strictEqual(removed.removedParent, NodePath.dirname(fixture.merged));
        assert.deepStrictEqual(rows.at(-1), {
          kind: "summary",
          applied: true,
          graceMinutes: 120,
          candidates: 4,
          removable: 1,
          removed: 1,
          skipped: 0,
          failed: 0,
          kept: {
            "uncommitted or untracked files": 1,
            "in use by a thread": 1,
            "origin is not a registered project's repository": 1,
          },
          dependenciesPrunable: 0,
          dependenciesPruned: 0,
        });
        assert.isFalse(NodeFS.existsSync(NodePath.dirname(fixture.merged)));
        assert.isTrue(NodeFS.existsSync(NodePath.join(fixture.dirty, "notes.md")));
        assert.isTrue(NodeFS.existsSync(NodePath.join(fixture.bound, ".git")));
        assert.isTrue(NodeFS.existsSync(NodePath.join(fixture.foreign, ".git")));
        // The project's own checkout is outside the root and untouched.
        assert.isTrue(
          NodeFS.existsSync(NodePath.join(fixture.home, "projects", "widgets", ".git")),
        );
      }),
    ),
  );

  it.effect.skipIf(noProcessList)(
    "lists the dependency installs of a kept clone and leaves one that just changed",
    () =>
      withHome((fixture) =>
        Effect.gen(function* () {
          const install = NodePath.join(fixture.dirty, "node_modules");
          NodeFS.mkdirSync(NodePath.join(install, "left-pad"), { recursive: true });
          NodeFS.writeFileSync(NodePath.join(fixture.dirty, "package.json"), "{}");
          assert.strictEqual(yield* sweep(fixture, "--apply"), 0);
          const lines = (yield* TestConsole.logLines).map(String);
          const at = lines.findIndex((line) => line.includes(`${fixture.dirty}  `));
          assert.match(
            lines[at + 1] ?? "",
            /^keep\s+1 dependency install in it: changed 0 h ago, inside the 24 h idle period$/,
          );
          assert.notInclude(lines.join("\n"), "Dependency installs");
          assert.isTrue(NodeFS.existsSync(NodePath.join(install, "left-pad")));
        }),
      ),
  );

  it.effect("refuses without a readable database and removes nothing", () =>
    withHome(
      (fixture) =>
        Effect.gen(function* () {
          assert.strictEqual(yield* sweep(fixture, "--apply"), CLONES_SWEEP_REFUSED);
          assert.include(
            (yield* TestConsole.errorLines).join("\n"),
            "cannot read the database, so nothing is removed",
          );
          assert.isTrue(NodeFS.existsSync(NodePath.join(fixture.merged, ".git")));
        }),
      { database: false },
    ),
  );

  it.effect("refuses a grace period below ten minutes", () =>
    withHome((fixture) =>
      Effect.gen(function* () {
        assert.strictEqual(yield* sweep(fixture, "--apply", "--grace", "1m"), CLONES_SWEEP_REFUSED);
        assert.include((yield* TestConsole.errorLines).join("\n"), "--grace must be at least 10m.");
        assert.isTrue(NodeFS.existsSync(NodePath.join(fixture.merged, ".git")));
      }),
    ),
  );
});
