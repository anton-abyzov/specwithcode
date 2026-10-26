// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises a real database on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@specweave-studio/shared/Net";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import { cli } from "../binCli.ts";

/** Runs the CLI and returns its exit code, leaving the test process's own code untouched. */
const runCli = (args: ReadonlyArray<string>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.exitCode;
      process.exitCode = undefined;
      return previous;
    }),
    () =>
      Command.runWith(cli, { version: "0.0.0" })(args).pipe(
        Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer)),
        Effect.map(() => process.exitCode ?? 0),
      ),
    (previous) =>
      Effect.sync(() => {
        process.exitCode = previous;
      }),
  );

const payload = (worktreePath: string | null, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ worktreePath, projectId: "project-1", ...extra });

/** A home whose database another connection holds open in WAL mode, as the service does. */
const withHeldHome = <A, E, R>(
  use: (home: { readonly home: string; readonly folders: string }) => Effect.Effect<A, E, R>,
  setup?: (holder: NodeSqlite.DatabaseSync, folders: string) => void,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const home = NodeFS.realpathSync(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-worktree-cli-")),
      );
      const folders = NodePath.join(home, "worktrees");
      for (const name of ["open", "settled", "archived"])
        NodeFS.mkdirSync(NodePath.join(folders, name), { recursive: true });
      NodeFS.mkdirSync(NodePath.join(home, "userdata"));
      const holder = new NodeSqlite.DatabaseSync(NodePath.join(home, "userdata", "statev2.sqlite"));
      holder.exec(`
        PRAGMA journal_mode=WAL;
        CREATE TABLE projection_projects (workspace_root TEXT, deleted_at TEXT);
        CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, payload_json TEXT, deleted_at TEXT, archived_at TEXT);
        CREATE TABLE orchestration_v2_effect_outbox (thread_id TEXT, status TEXT);
        CREATE TABLE orchestration_v2_projection_provider_sessions (payload_json TEXT, status TEXT, thread_id TEXT);
      `);
      const insert = holder.prepare(
        "INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, NULL, ?)",
      );
      const folder = (name: string) => NodePath.join(folders, name);
      insert.run("open", payload(folder("open"), { title: "Open work" }), null);
      insert.run(
        "settled",
        payload(folder("settled"), { title: "Done", settledOverride: "settled" }),
        null,
      );
      insert.run("archived", payload(folder("archived"), { title: "Old" }), "2026-10-01");
      insert.run("local", payload(null, { title: "Local" }), null);
      setup?.(holder, folders);
      return { home, folders, holder };
    }),
    ({ home, folders }) => use({ home, folders }),
    ({ home, holder }) =>
      Effect.sync(() => {
        holder.close();
        NodeFS.rmSync(home, { recursive: true, force: true });
      }),
  );

describe("specweave-studio worktree owners", () => {
  it.effect("lists every thread folder with its state, one JSON line each", () =>
    withHeldHome(({ home, folders }) =>
      Effect.gen(function* () {
        assert.equal(yield* runCli(["worktree", "owners", "--base-dir", home, "--json"]), 0);
        const lines = (yield* TestConsole.logLines).map((line) => JSON.parse(String(line)));
        assert.deepEqual(
          lines.map(({ threadId, state, path, title, projectId }) => ({
            threadId,
            state,
            path,
            title,
            projectId,
          })),
          [
            {
              threadId: "open",
              state: "open",
              path: NodePath.join(folders, "open"),
              title: "Open work",
              projectId: "project-1",
            },
            {
              threadId: "settled",
              state: "settled",
              path: NodePath.join(folders, "settled"),
              title: "Done",
              projectId: "project-1",
            },
            {
              threadId: "archived",
              state: "archived",
              path: NodePath.join(folders, "archived"),
              title: "Old",
              projectId: "project-1",
            },
          ],
        );
      }),
    ),
  );

  it.effect("exits 0 for a folder an open thread uses, also from a folder inside it", () =>
    withHeldHome(({ home, folders }) =>
      Effect.gen(function* () {
        const nested = NodePath.join(folders, "open", "packages", "app");
        assert.equal(
          yield* runCli(["worktree", "owners", "--base-dir", home, "--json", "--path", nested]),
          0,
        );
        const lines = (yield* TestConsole.logLines).map((line) => JSON.parse(String(line)));
        assert.deepEqual(
          lines.map((line) => [line.threadId, line.state]),
          [["open", "open"]],
        );
      }),
    ),
  );

  it.effect("exits 1 when only settled or archived threads use the folder, or none", () =>
    withHeldHome(({ home, folders }) =>
      Effect.gen(function* () {
        for (const name of ["settled", "archived", "unused"]) {
          assert.equal(
            yield* runCli([
              "worktree",
              "owners",
              "--base-dir",
              home,
              "--path",
              NodePath.join(folders, name),
            ]),
            1,
          );
        }
        assert.match(
          (yield* TestConsole.logLines).join("\n"),
          /No open thread, project or live agent session uses/,
        );
        // The parent of an open thread's folder would remove it too.
        assert.equal(
          yield* runCli(["worktree", "owners", "--base-dir", home, "--path", folders]),
          0,
        );
      }),
    ),
  );

  it.effect("exits 0 for a folder reached through a symlinked parent", () =>
    withHeldHome(({ home, folders }) =>
      Effect.gen(function* () {
        const link = NodePath.join(home, "linked-worktrees");
        NodeFS.symlinkSync(folders, link);
        assert.equal(
          yield* runCli([
            "worktree",
            "owners",
            "--base-dir",
            home,
            "--path",
            NodePath.join(link, "open"),
          ]),
          0,
        );
      }),
    ),
  );

  it.effect("exits 0 for a folder that holds a project or a live agent session", () =>
    withHeldHome(
      ({ home, folders }) =>
        Effect.gen(function* () {
          for (const name of ["project", "session"]) {
            assert.equal(
              yield* runCli([
                "worktree",
                "owners",
                "--base-dir",
                home,
                "--json",
                "--path",
                NodePath.join(folders, name),
              ]),
              0,
            );
          }
          assert.deepEqual(
            (yield* TestConsole.logLines).map((line) => JSON.parse(String(line)).kind),
            ["project", "session"],
          );
          // A stopped session no longer uses its folder.
          assert.equal(
            yield* runCli([
              "worktree",
              "owners",
              "--base-dir",
              home,
              "--path",
              NodePath.join(folders, "stopped"),
            ]),
            1,
          );
        }),
      (holder, folders) => {
        for (const name of ["project", "session", "stopped"])
          NodeFS.mkdirSync(NodePath.join(folders, name));
        holder
          .prepare("INSERT INTO projection_projects VALUES (?, NULL)")
          .run(NodePath.join(folders, "project"));
        const session = holder.prepare(
          "INSERT INTO orchestration_v2_projection_provider_sessions VALUES (?, ?, NULL)",
        );
        session.run(JSON.stringify({ cwd: NodePath.join(folders, "session", "src") }), "running");
        session.run(JSON.stringify({ cwd: NodePath.join(folders, "stopped") }), "stopped");
      },
    ),
  );

  it.effect("exits 2, never 1, when the check fails", () =>
    Effect.gen(function* () {
      // No database in this home.
      const empty = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-worktree-cli-"));
      try {
        assert.equal(
          yield* runCli(["worktree", "owners", "--base-dir", empty, "--path", empty]),
          2,
        );
      } finally {
        NodeFS.rmSync(empty, { recursive: true, force: true });
      }
      // A thread row that cannot be read.
      yield* withHeldHome(
        ({ home, folders }) =>
          Effect.gen(function* () {
            assert.equal(
              yield* runCli([
                "worktree",
                "owners",
                "--base-dir",
                home,
                "--path",
                NodePath.join(folders, "unused"),
              ]),
              2,
            );
            assert.equal(yield* runCli(["worktree", "owners", "--base-dir", home]), 2);
          }),
        (holder) => {
          holder
            .prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, NULL, NULL)")
            .run("broken", "{not json");
        },
      );
      assert.match((yield* TestConsole.errorLines).join("\n"), /worktree owners: /);
    }),
  );
});
