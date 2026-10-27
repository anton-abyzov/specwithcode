// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off - CLI integration exercises a real database and folders whose ages are wall-clock file times.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@specweave-studio/shared/Net";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import { cli } from "../binCli.ts";
import { actOnFolder } from "./scratch.ts";

const DAY_MS = 86_400_000;
/**
 * Folder ages count ctime, which no test can set back, so the CLI's clock
 * runs this far ahead instead and every folder made now looks this old.
 */
const CLOCK_AHEAD_MS = 30 * DAY_MS;

/** Runs the CLI and returns its exit code, leaving the test process's own code untouched. */
const runCli = (args: ReadonlyArray<string>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.exitCode;
      process.exitCode = undefined;
      return previous;
    }),
    () =>
      // Folder ages are real file times, so the CLI reads the wall clock, moved ahead.
      Effect.andThen(
        TestClock.setTime(Date.now() + CLOCK_AHEAD_MS),
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

const FOLDERS = [
  "old-probe",
  "recent-probe",
  "2026-09-01-open-chat-abc12345",
  "2026-09-02-archived-chat-def67890",
  "2026-09-03-deleted-chat-0badc0de",
  "session-cwd",
  "holds-project",
] as const;

/** Sets a whole tree's mtimes to `ms`. */
const age = (folder: string, ms: number) => {
  for (const name of NodeFS.readdirSync(folder, { recursive: true }))
    NodeFS.utimesSync(NodePath.join(folder, String(name)), ms / 1000, ms / 1000);
  NodeFS.utimesSync(folder, ms / 1000, ms / 1000);
};

/**
 * A home with scratch folders and a database another connection holds open
 * in WAL mode, as the service does. To the CLI's clock every folder but
 * `recent-probe` is 30 days old. With `linkedScratch`, `<home>/scratch` is a
 * symlink to the real folder and the database records the link's spelling.
 */
const withHome = <A, E, R>(
  use: (home: { readonly home: string; readonly scratch: string }) => Effect.Effect<A, E, R>,
  options: { readonly database?: boolean; readonly linkedScratch?: boolean } = {},
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const home = NodeFS.realpathSync(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-scratch-cli-")),
      );
      const scratch = NodePath.join(home, "scratch");
      if (options.linkedScratch) {
        NodeFS.mkdirSync(NodePath.join(home, "drive", "scratch"), { recursive: true });
        NodeFS.symlinkSync(NodePath.join(home, "drive", "scratch"), scratch);
      }
      const folder = (name: string) => NodePath.join(scratch, name);
      for (const name of FOLDERS) {
        NodeFS.mkdirSync(folder(name), { recursive: true });
        NodeFS.writeFileSync(NodePath.join(folder(name), "notes.md"), name);
      }
      NodeFS.mkdirSync(NodePath.join(folder("holds-project"), "repo"));
      NodeFS.writeFileSync(NodePath.join(scratch, "loose-file.txt"), "");
      NodeFS.mkdirSync(NodePath.join(home, "userdata"));
      let holder: NodeSqlite.DatabaseSync | null = null;
      if (options.database !== false) {
        holder = new NodeSqlite.DatabaseSync(NodePath.join(home, "userdata", "statev2.sqlite"));
        holder.exec(`
          PRAGMA journal_mode=WAL;
          CREATE TABLE projection_projects (workspace_root TEXT, deleted_at TEXT);
          CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, payload_json TEXT, deleted_at TEXT, archived_at TEXT);
          CREATE TABLE orchestration_v2_effect_outbox (thread_id TEXT, status TEXT);
          CREATE TABLE orchestration_v2_projection_provider_sessions (payload_json TEXT, status TEXT, thread_id TEXT);
        `);
        const project = holder.prepare("INSERT INTO projection_projects VALUES (?, ?)");
        // The Scratch project itself sits at the scratch root and binds nothing alone.
        project.run(scratch, null);
        project.run(NodePath.join(folder("holds-project"), "repo"), null);
        const thread = holder.prepare(
          "INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, ?, ?)",
        );
        const payload = (name: string) =>
          JSON.stringify({ worktreePath: folder(name), projectId: "scratch" });
        thread.run("open", payload(FOLDERS[2]), null, null);
        thread.run("archived", payload(FOLDERS[3]), null, "2026-09-10");
        // Deleted long ago with its cleanup finished: its folder still stays.
        thread.run("deleted", payload(FOLDERS[4]), "2026-09-20", null);
        thread.run("local", JSON.stringify({ worktreePath: null }), null, null);
        holder
          .prepare("INSERT INTO orchestration_v2_projection_provider_sessions VALUES (?, ?, ?)")
          .run(JSON.stringify({ cwd: folder("session-cwd") }), "running", null);
      }
      // Old mtimes alone, as `cp -p` leaves them, do not make a folder old.
      for (const name of FOLDERS) age(folder(name), Date.now() - 90 * DAY_MS);
      // Modified "now" by the CLI's clock.
      age(folder("recent-probe"), Date.now() + CLOCK_AHEAD_MS);
      return { home, scratch, holder };
    }),
    ({ home, scratch }) => use({ home, scratch }),
    ({ home, holder }) =>
      Effect.sync(() => {
        holder?.close();
        NodeFS.rmSync(home, { recursive: true, force: true });
      }),
  );

const jsonLines = Effect.map(TestConsole.logLines, (lines) =>
  lines.map((line) => JSON.parse(String(line)) as Record<string, unknown>),
);

describe("specweave-studio scratch prune", () => {
  it.effect("dry run lists only the unused old folder and changes nothing", () =>
    withHome(({ home, scratch }) =>
      Effect.gen(function* () {
        assert.equal(yield* runCli(["scratch", "prune", "--base-dir", home, "--json"]), 0);
        const lines = yield* jsonLines;
        const folders = lines.filter((line) => line.kind === "folder");
        assert.deepEqual(
          folders.filter((line) => line.action === "remove").map((line) => line.name),
          ["old-probe"],
        );
        const reasons = Object.fromEntries(folders.map((line) => [line.name, line.reason]));
        assert.equal(reasons["2026-09-01-open-chat-abc12345"], "in use by thread open (open)");
        assert.equal(
          reasons["2026-09-02-archived-chat-def67890"],
          "in use by thread archived (archived)",
        );
        assert.equal(
          reasons["2026-09-03-deleted-chat-0badc0de"],
          "in use by thread deleted (deleted)",
        );
        assert.equal(reasons["session-cwd"], "in use by agent session");
        assert.match(String(reasons["holds-project"]), /^in use by project /);
        assert.match(String(reasons["recent-probe"]), /^modified 0d ago$/);
        assert.equal(reasons["loose-file.txt"], "not a folder (file)");
        assert.deepEqual(lines.at(-1), {
          kind: "summary",
          scratch,
          applied: false,
          olderThanDays: 14,
          removable: 1,
          kept: 7,
          archived: 0,
          deleted: 0,
          skipped: 0,
          failed: 0,
        });
        for (const name of FOLDERS) assert.isTrue(NodeFS.existsSync(NodePath.join(scratch, name)));
      }),
    ),
  );

  it.effect("matches folders and live paths through a symlinked scratch folder", () =>
    withHome(
      ({ home, scratch }) =>
        Effect.gen(function* () {
          assert.equal(yield* runCli(["scratch", "prune", "--base-dir", home, "--json"]), 0);
          const lines = yield* jsonLines;
          const folders = lines.filter((line) => line.kind === "folder");
          assert.deepEqual(
            folders.filter((line) => line.action === "remove").map((line) => line.name),
            ["old-probe"],
          );
          const real = NodeFS.realpathSync(scratch);
          assert.notEqual(real, scratch);
          assert.equal(lines.at(-1)?.scratch, real);
        }),
      { linkedScratch: true },
    ),
  );

  it.effect("prints a JSON summary when there is no scratch folder", () =>
    withHome(({ home, scratch }) =>
      Effect.gen(function* () {
        NodeFS.rmSync(scratch, { recursive: true });
        assert.equal(yield* runCli(["scratch", "prune", "--base-dir", home, "--json"]), 0);
        assert.deepEqual(yield* jsonLines, [
          { kind: "summary", scratch, applied: false, removable: 0 },
        ]);
      }),
    ),
  );

  it.effect("--apply moves the old folder into the archive and nothing else", () =>
    withHome(({ home, scratch }) =>
      Effect.gen(function* () {
        const archive = NodePath.join(home, "archive");
        assert.equal(
          yield* runCli([
            "scratch",
            "prune",
            "--base-dir",
            home,
            "--apply",
            "--archive-to",
            archive,
          ]),
          0,
        );
        assert.isFalse(NodeFS.existsSync(NodePath.join(scratch, "old-probe")));
        assert.equal(
          NodeFS.readFileSync(NodePath.join(archive, "old-probe", "notes.md"), "utf8"),
          "old-probe",
        );
        for (const name of FOLDERS.filter((name) => name !== "old-probe"))
          assert.isTrue(NodeFS.existsSync(NodePath.join(scratch, name)), name);
        const lines = (yield* TestConsole.logLines).map(String);
        assert.isTrue(
          lines.some((line) => line.startsWith("archived") && line.includes("old-probe")),
        );
      }),
    ),
  );

  it.effect("--apply without an archive or --delete refuses and removes nothing", () =>
    withHome(({ home, scratch }) =>
      Effect.gen(function* () {
        assert.equal(yield* runCli(["scratch", "prune", "--base-dir", home, "--apply"]), 2);
        assert.isTrue(NodeFS.existsSync(NodePath.join(scratch, "old-probe")));
        assert.equal(
          yield* runCli(["scratch", "prune", "--base-dir", home, "--apply", "--delete"]),
          0,
        );
        assert.isFalse(NodeFS.existsSync(NodePath.join(scratch, "old-probe")));
        assert.isTrue(NodeFS.existsSync(NodePath.join(scratch, "recent-probe")));
      }),
    ),
  );

  it.effect("refuses a cutoff under seven days or an archive inside scratch", () =>
    withHome(({ home, scratch }) =>
      Effect.gen(function* () {
        assert.equal(
          yield* runCli(["scratch", "prune", "--base-dir", home, "--older-than", "1d"]),
          2,
        );
        assert.equal(
          yield* runCli(["scratch", "prune", "--base-dir", home, "--older-than", "soon"]),
          2,
        );
        assert.equal(
          yield* runCli([
            "scratch",
            "prune",
            "--base-dir",
            home,
            "--apply",
            "--archive-to",
            NodePath.join(scratch, "archive"),
          ]),
          2,
        );
        assert.isTrue(NodeFS.existsSync(NodePath.join(scratch, "old-probe")));
        // A refused run creates nothing.
        assert.isFalse(NodeFS.existsSync(NodePath.join(scratch, "archive")));
        // A 60-day cutoff leaves the 30-day-old folder alone.
        assert.equal(
          yield* runCli(["scratch", "prune", "--base-dir", home, "--older-than", "60d", "--json"]),
          0,
        );
        const summary = (yield* jsonLines).at(-1);
        assert.equal(summary?.removable, 0);
      }),
    ),
  );

  it.effect("refuses to run without a readable database", () =>
    withHome(
      ({ home, scratch }) =>
        Effect.gen(function* () {
          assert.equal(
            yield* runCli(["scratch", "prune", "--base-dir", home, "--apply", "--delete"]),
            2,
          );
          for (const name of FOLDERS)
            assert.isTrue(NodeFS.existsSync(NodePath.join(scratch, name)));
          const errors = (yield* TestConsole.errorLines).map(String);
          assert.isTrue(errors.some((line) => line.includes("cannot read the database")));
        }),
      { database: false },
    ),
  );
});

describe("actOnFolder", () => {
  const made: Array<string> = [];
  const folder = () => {
    const root = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-scratch-act-")),
    );
    made.push(root);
    const path = NodePath.join(root, "scratch", "probe");
    NodeFS.mkdirSync(path, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(path, "run.log"), "");
    return { root, path };
  };
  const input = (root: string, path: string, now: number) => ({
    decision: {
      name: "probe",
      path,
      action: "remove" as const,
      newestMs: now - 30 * DAY_MS,
      reason: "unused",
    },
    entry: {
      name: "probe",
      paths: [path],
      kind: "directory" as const,
      age: { known: false as const, reason: "re-read" },
    },
    scratchRoots: [NodePath.join(root, "scratch")],
    livePaths: [],
    archiveDir: null,
    olderThanMs: 14 * DAY_MS,
    now,
    foldCase: false,
  });

  it("skips a folder changed since the check", () => {
    try {
      const { root, path } = folder();
      // A second ahead: file times can round past the moment they were read.
      assert.deepEqual(actOnFolder(input(root, path, Date.now() + 1000)), {
        result: "skipped",
        detail: "changed since the check: modified 0d ago",
      });
      assert.isTrue(NodeFS.existsSync(path));
    } finally {
      for (const root of made.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips a folder a thread bound since the check, and deletes it otherwise", () => {
    try {
      const { root, path } = folder();
      const later = Date.now() + CLOCK_AHEAD_MS;
      assert.deepEqual(
        actOnFolder({
          ...input(root, path, later),
          livePaths: [{ paths: [path], owner: "thread t1 (open)" }],
        }),
        { result: "skipped", detail: "changed since the check: in use by thread t1 (open)" },
      );
      assert.isTrue(NodeFS.existsSync(path));
      assert.deepEqual(actOnFolder(input(root, path, later)), { result: "deleted" });
      assert.isFalse(NodeFS.existsSync(path));
    } finally {
      for (const root of made.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});
