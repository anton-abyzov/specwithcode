// @effect-diagnostics nodeBuiltinImport:off globalDate:off - the CLI runs real commands under a real lock file in a temporary folder.
import * as NodeChildProcess from "node:child_process";
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
import { CHECKS_COPY_EXIT_BUSY, CHECKS_COPY_EXIT_DIRTY, CHECKS_EXIT_USAGE } from "./checks.ts";
import {
  HEAVY_CHECK_DIR_ENV,
  HEAVY_CHECK_EXIT_WAIT_TIMEOUT,
  heavyCheckPaths,
  type HeavyCheckRecord,
  processStartTime,
  readHolder,
} from "./heavyCheckLock.ts";
import { VERIFICATION_INSTALL_COMMAND_ENV } from "./verificationCopy.ts";

const THREAD_ENV = "SPECWEAVE_STUDIO_THREAD_ID";

/** Runs the CLI with its own lock folder and returns its exit code. */
const runCli = (root: string, args: ReadonlyArray<string>, env: Record<string, string> = {}) => {
  const set: Record<string, string> = {
    [HEAVY_CHECK_DIR_ENV]: NodePath.join(root, "locks"),
    [THREAD_ENV]: "thread-under-test",
    ...env,
  };
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = { exitCode: process.exitCode, env: { ...process.env } };
      process.exitCode = undefined;
      Object.assign(process.env, set);
      return previous;
    }),
    () =>
      Command.runWith(cli, { version: "0.0.0" })(args).pipe(
        Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer)),
        Effect.map(() => process.exitCode ?? 0),
      ),
    (previous) =>
      Effect.sync(() => {
        process.exitCode = previous.exitCode;
        for (const name of Object.keys(set)) {
          if (previous.env[name] === undefined) delete process.env[name];
          else process.env[name] = previous.env[name];
        }
      }),
  );
};

const withRoot = <A, E, R>(use: (root: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "checks-cli-"))),
    ),
    use,
    (root) => Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
  );

/** The gate held by a process that keeps running: this test. */
function holdGate(root: string): HeavyCheckRecord {
  const paths = heavyCheckPaths(NodePath.join(root, "locks"));
  const record: HeavyCheckRecord = {
    id: "another-thread",
    pid: process.pid,
    startedAt: processStartTime(process.pid),
    host: NodeOS.hostname(),
    label: "full suite",
    command: ["pnpm", "test"],
    cwd: "/work/elsewhere",
    threadId: "thread-7",
    acquiredAt: new Date().toISOString(),
  };
  NodeFS.mkdirSync(paths.dir, { recursive: true });
  NodeFS.writeFileSync(paths.lockFile, JSON.stringify(record));
  return record;
}

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();

/** A small repository with a lockfile, and an install command that records each run. */
function fixtureRepository(root: string) {
  const source = NodePath.join(root, "widgets");
  NodeFS.mkdirSync(source);
  git(source, "init", "--quiet", "--initial-branch=main");
  NodeFS.writeFileSync(
    NodePath.join(source, "package.json"),
    JSON.stringify({ packageManager: "pnpm@11.10.0" }),
  );
  NodeFS.writeFileSync(NodePath.join(source, "pnpm-lock.yaml"), "lockfileVersion: 1\n");
  git(source, "add", "-A");
  git(source, "commit", "--quiet", "-m", "first");
  const installLog = NodePath.join(root, "installs.log");
  const install = NodePath.join(root, "install.cjs");
  NodeFS.writeFileSync(
    install,
    `require("node:fs").appendFileSync(${JSON.stringify(installLog)}, "install\\n");\n`,
  );
  return {
    source,
    home: NodePath.join(root, "home"),
    env: { [VERIFICATION_INSTALL_COMMAND_ENV]: `"${process.execPath}" "${install}"` },
    installs: () =>
      NodeFS.existsSync(installLog)
        ? NodeFS.readFileSync(installLog, "utf8").split("\n").length - 1
        : 0,
    commit: (file: string, content: string) => {
      NodeFS.writeFileSync(NodePath.join(source, file), content);
      git(source, "add", "-A");
      git(source, "commit", "--quiet", "-m", file);
      return git(source, "rev-parse", "HEAD");
    },
  };
}

describe("specweave-studio checks", () => {
  it.effect("run holds the gate for the command, records who runs it and exits with its code", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const paths = heavyCheckPaths(NodePath.join(root, "locks"));
        const seen = NodePath.join(root, "seen.json");
        // The command copies the lock it runs under, then fails with its own code.
        const script = `require("node:fs").copyFileSync(${JSON.stringify(paths.lockFile)}, ${JSON.stringify(seen)}); process.exit(7)`;
        const code = yield* runCli(root, [
          "checks",
          "run",
          "--label",
          "server tests",
          "--",
          process.execPath,
          "-e",
          script,
        ]);
        assert.strictEqual(code, 7);
        const record = JSON.parse(NodeFS.readFileSync(seen, "utf8")) as HeavyCheckRecord;
        assert.strictEqual(record.label, "server tests");
        assert.strictEqual(record.pid, process.pid);
        assert.strictEqual(record.startedAt, processStartTime(process.pid));
        assert.strictEqual(record.host, NodeOS.hostname());
        assert.strictEqual(record.threadId, "thread-under-test");
        assert.strictEqual(record.cwd, process.cwd());
        assert.deepStrictEqual(record.command, [process.execPath, "-e", script]);
        assert.isFalse(Number.isNaN(Date.parse(record.acquiredAt)));
        assert.isNull(readHolder(paths));
      }),
    ),
  );

  it.effect(
    "run gives up with exit 75 when --wait-timeout passes, without running the command",
    () =>
      withRoot((root) =>
        Effect.gen(function* () {
          const holder = holdGate(root);
          const marker = NodePath.join(root, "ran");
          const code = yield* runCli(root, [
            "checks",
            "run",
            "--wait-timeout",
            "200ms",
            "--",
            process.execPath,
            "-e",
            `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "")`,
          ]);
          assert.strictEqual(code, HEAVY_CHECK_EXIT_WAIT_TIMEOUT);
          assert.isFalse(NodeFS.existsSync(marker));
          assert.strictEqual(
            readHolder(heavyCheckPaths(NodePath.join(root, "locks")))?.id,
            holder.id,
          );
        }),
      ),
  );

  it.effect("run refuses a wait timeout it cannot read", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const code = yield* runCli(root, [
          "checks",
          "run",
          "--wait-timeout",
          "soon",
          "--",
          process.execPath,
          "-e",
          "",
        ]);
        assert.strictEqual(code, CHECKS_EXIT_USAGE);
        const errors = (yield* TestConsole.errorLines).join("\n");
        assert.include(errors, "--wait-timeout takes a number and a unit");
      }),
    ),
  );

  it.effect("status prints the holder and the queue, as text and as JSON", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        assert.strictEqual(yield* runCli(root, ["checks", "status"]), 0);
        const holder = holdGate(root);
        const queueDir = heavyCheckPaths(NodePath.join(root, "locks")).queueDir;
        NodeFS.mkdirSync(queueDir, { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(queueDir, "000001-waiter.json"),
          JSON.stringify({
            pid: process.pid,
            startedAt: null,
            host: NodeOS.hostname(),
            label: "web tests",
            cwd: "/work/web",
            threadId: null,
            enqueuedAt: "2026-11-11T10:00:00.000Z",
          }),
        );
        assert.strictEqual(yield* runCli(root, ["checks", "status"]), 0);
        assert.strictEqual(yield* runCli(root, ["checks", "status", "--json"]), 0);
        const lines = (yield* TestConsole.logLines).map(String);
        assert.include(lines[0], "The heavy-check gate is free");
        assert.include(
          lines[1],
          'Held by full suite ("pnpm test"), in /work/elsewhere, thread thread-7',
        );
        assert.include(lines[1], "1. web tests in /work/web");
        const json = JSON.parse(lines[2]!) as {
          holder: HeavyCheckRecord;
          queue: ReadonlyArray<{ label: string }>;
        };
        assert.strictEqual(json.holder.id, holder.id);
        assert.deepStrictEqual(
          json.queue.map((ticket) => ticket.label),
          ["web tests"],
        );
      }),
    ),
  );

  it.effect("copy prints one path, reuses it, and reinstalls only for a new lockfile", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const fixture = fixtureRepository(root);
        const args = ["checks", "copy", fixture.source, "--base-dir", fixture.home];
        assert.strictEqual(yield* runCli(root, args, fixture.env), 0);
        assert.strictEqual(yield* runCli(root, args, fixture.env), 0);
        assert.strictEqual(fixture.installs(), 1);
        const next = fixture.commit("readme.md", "hello\n");
        assert.strictEqual(yield* runCli(root, [...args, "--ref", next], fixture.env), 0);
        assert.strictEqual(fixture.installs(), 1);
        fixture.commit("pnpm-lock.yaml", "lockfileVersion: 2\n");
        assert.strictEqual(yield* runCli(root, [...args, "--ref", "main"], fixture.env), 0);
        assert.strictEqual(fixture.installs(), 2);

        const copy = NodePath.join(fixture.home, "verify", "widgets");
        assert.deepStrictEqual((yield* TestConsole.logLines).map(String), [copy, copy, copy, copy]);
        assert.strictEqual(
          git(copy, "rev-parse", "HEAD"),
          git(fixture.source, "rev-parse", "main"),
        );
        // The gate it took to change the copy is free again.
        assert.isNull(readHolder(heavyCheckPaths(NodePath.join(root, "locks"))));
      }),
    ),
  );

  it.effect("copy refuses to switch commits while someone else holds the gate", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const fixture = fixtureRepository(root);
        const args = ["checks", "copy", fixture.source, "--base-dir", fixture.home];
        assert.strictEqual(yield* runCli(root, args, fixture.env), 0);
        const copy = NodePath.join(fixture.home, "verify", "widgets");
        const before = git(copy, "rev-parse", "HEAD");

        const holder = holdGate(root);
        // Nothing to change: the path is still given.
        assert.strictEqual(yield* runCli(root, args, fixture.env), 0);
        fixture.commit("readme.md", "hello\n");
        assert.strictEqual(yield* runCli(root, args, fixture.env), CHECKS_COPY_EXIT_BUSY);
        assert.strictEqual(git(copy, "rev-parse", "HEAD"), before);
        assert.include((yield* TestConsole.errorLines).join("\n"), "held by full suite");
        // The same call from inside that gate's own command goes ahead.
        const inside = { ...fixture.env, STUDIO_HEAVY_CHECKS_LOCK_ID: holder.id };
        assert.strictEqual(yield* runCli(root, args, inside), 0);
        assert.strictEqual(
          git(copy, "rev-parse", "HEAD"),
          git(fixture.source, "rev-parse", "HEAD"),
        );
        assert.strictEqual(
          readHolder(heavyCheckPaths(NodePath.join(root, "locks")))?.id,
          holder.id,
        );
      }),
    ),
  );

  it.effect("copy refuses a copy with uncommitted files and says which", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const fixture = fixtureRepository(root);
        const args = ["checks", "copy", fixture.source, "--base-dir", fixture.home];
        assert.strictEqual(yield* runCli(root, args, fixture.env), 0);
        const stray = NodePath.join(fixture.home, "verify", "widgets", "stray.txt");
        NodeFS.writeFileSync(stray, "keep me");
        fixture.commit("readme.md", "hello\n");
        assert.strictEqual(yield* runCli(root, args, fixture.env), CHECKS_COPY_EXIT_DIRTY);
        assert.include((yield* TestConsole.errorLines).join("\n"), "?? stray.txt");
        assert.strictEqual(NodeFS.readFileSync(stray, "utf8"), "keep me");
      }),
    ),
  );
});
