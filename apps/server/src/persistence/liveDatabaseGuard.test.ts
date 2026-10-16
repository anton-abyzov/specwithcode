// @effect-diagnostics nodeBuiltinImport:off -- The guard under test wraps node:fs itself.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import {
  installLiveDatabaseGuard,
  liveDatabaseFile,
  liveDatabaseInside,
  registerLiveDatabase,
} from "./liveDatabaseGuard.ts";

const withDirectory = <A>(run: (directory: string) => A): A => {
  const directory = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-live-db-guard-")),
  );
  try {
    return run(directory);
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
};

describe("liveDatabaseFile", () => {
  it("names the database and its sidecars only while registered", () =>
    withDirectory((directory) => {
      const dbPath = NodePath.join(directory, "userdata", "statev2.sqlite");
      NodeFS.mkdirSync(NodePath.dirname(dbPath));
      const link = NodePath.join(directory, "link");
      NodeFS.symlinkSync(NodePath.dirname(dbPath), link);
      assert.isUndefined(liveDatabaseFile(`${dbPath}-shm`));
      const unregister = registerLiveDatabase(dbPath);
      try {
        for (const suffix of ["", "-wal", "-shm", "-journal"]) {
          assert.equal(liveDatabaseFile(`${dbPath}${suffix}`), `${dbPath}${suffix}`);
        }
        // Another spelling of the same folder, a Buffer and a file URL all name it.
        assert.equal(liveDatabaseFile(NodePath.join(link, "statev2.sqlite-wal")), `${dbPath}-wal`);
        assert.equal(liveDatabaseFile(Buffer.from(`${dbPath}-shm`)), `${dbPath}-shm`);
        assert.equal(liveDatabaseFile(new URL(`file://${dbPath}`)), dbPath);
        // macOS and Windows volumes ignore case, so another case is the same file there.
        assert.equal(
          liveDatabaseFile(NodePath.join(NodePath.dirname(dbPath), "STATEV2.SQLITE-SHM")),
          NodePath.join(NodePath.dirname(dbPath), "STATEV2.SQLITE-SHM"),
        );
        // Neighbours, copies elsewhere and descriptors do not.
        assert.isUndefined(liveDatabaseFile(NodePath.join(directory, "userdata", "settings.json")));
        assert.isUndefined(liveDatabaseFile(NodePath.join(directory, "statev2.sqlite")));
        assert.isUndefined(liveDatabaseFile(`${dbPath}.backup`));
        assert.isUndefined(liveDatabaseFile(7));
        // A recursive walk of the folder or an ancestor would reach it; a sibling would not.
        assert.equal(liveDatabaseInside(directory), dbPath);
        assert.equal(liveDatabaseInside(NodePath.dirname(dbPath)), dbPath);
        assert.isUndefined(liveDatabaseInside(NodePath.join(directory, "userdata", "attachments")));
      } finally {
        unregister();
      }
      assert.isUndefined(liveDatabaseFile(`${dbPath}-shm`));
      assert.isUndefined(registerLiveDatabase(":memory:")());
    }));
});

describe("installLiveDatabaseGuard", () => {
  it("refuses every way node:fs would open, replace or delete a live file", async () => {
    const directory = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-live-db-guard-")),
    );
    const state = NodePath.join(directory, "userdata");
    const dbPath = NodePath.join(state, "statev2.sqlite");
    const other = NodePath.join(state, "settings.json");
    NodeFS.mkdirSync(state);
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, other]) {
      NodeFS.writeFileSync(file, "x");
    }
    const stderr = process.stderr.write;
    const reports: Array<string> = [];
    process.stderr.write = ((chunk: string) => {
      reports.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    const uninstall = installLiveDatabaseGuard();
    const unregister = registerLiveDatabase(dbPath);
    try {
      assert.strictEqual(installLiveDatabaseGuard(), uninstall);
      const shm = `${dbPath}-shm`;
      const refused = (run: () => unknown) => {
        assert.throws(run, /live SpecWithCode database/);
      };
      refused(() => NodeFS.openSync(shm, "r"));
      refused(() => NodeFS.readFileSync(dbPath));
      refused(() => NodeFS.copyFileSync(dbPath, NodePath.join(directory, "copy")));
      refused(() => NodeFS.copyFileSync(other, `${dbPath}-wal`));
      refused(() => NodeFS.createReadStream(shm));
      refused(() => NodeFS.watch(dbPath));
      refused(() => NodeFS.renameSync(`${dbPath}-wal`, NodePath.join(directory, "moved")));
      refused(() => NodeFS.renameSync(state, `${state}-moved`));
      refused(() => NodeFS.readFileSync(NodePath.join(state, "STATEV2.SQLITE-SHM")));
      refused(() => NodeFS.promises.watch(shm));
      refused(() => NodeFS.unlinkSync(`${dbPath}-wal`));
      refused(() => NodeFS.rmSync(state, { recursive: true }));
      refused(() => NodeFS.cpSync(directory, `${directory}-copy`, { recursive: true }));
      const promised = await NodeFS.promises.readFile(shm).then(
        () => undefined,
        (error: NodeJS.ErrnoException) => error,
      );
      assert.equal(promised?.code, "EACCES");
      const handled = await NodeFS.promises.open(dbPath, "r").then(
        () => undefined,
        (error: NodeJS.ErrnoException) => error,
      );
      assert.equal(handled?.code, "EACCES");
      const blob = await NodeFS.openAsBlob(shm).then(
        () => undefined,
        (error: NodeJS.ErrnoException) => error,
      );
      assert.equal(blob?.code, "EACCES");
      const called = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
        NodeFS.open(shm, "r", (error) => resolve(error)),
      );
      assert.equal(called?.code, "EACCES");
      // Reading metadata opens nothing, and other files are untouched.
      assert.equal(NodeFS.statSync(shm).size, 1);
      NodeFS.accessSync(dbPath);
      assert.equal(NodeFS.readFileSync(other, "utf8"), "x");
      NodeFS.closeSync(NodeFS.openSync(other, "r"));
      assert.isTrue(NodeFS.existsSync(`${dbPath}-wal`));
      assert.isTrue(reports.some((line) => line.startsWith("[live-database-guard] EACCES")));
    } finally {
      unregister();
      uninstall();
      process.stderr.write = stderr;
    }
    // Restored: the same calls work again.
    NodeFS.closeSync(NodeFS.openSync(`${dbPath}-shm`, "r"));
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  it("guards Effect's file system when installed before Effect loads, as the CLI entry does", () =>
    withDirectory((directory) => {
      const dbPath = NodePath.join(directory, "statev2.sqlite");
      NodeFS.writeFileSync(`${dbPath}-shm`, "x");
      const child = NodeChildProcess.spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `const guard = await import(${JSON.stringify(new URL("./liveDatabaseGuard.ts", import.meta.url).href)});
guard.installLiveDatabaseGuard();
guard.registerLiveDatabase(process.argv[1]);
const Effect = await import(${JSON.stringify(import.meta.resolve("effect/Effect"))});
const FileSystem = await import(${JSON.stringify(import.meta.resolve("effect/FileSystem"))});
const NodeFileSystem = await import(${JSON.stringify(import.meta.resolve("@effect/platform-node/NodeFileSystem"))});
const read = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFile(process.argv[1] + "-shm");
});
const error = await Effect.runPromise(Effect.flip(read).pipe(Effect.provide(NodeFileSystem.layer)));
console.log(JSON.stringify({
  reason: error.reason._tag,
  live: String(error.reason.cause?.message).includes("live SpecWithCode database"),
}));`,
          dbPath,
        ],
        { encoding: "utf8" },
      );
      assert.equal(child.status, 0, child.stderr);
      assert.deepEqual(JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "{}"), {
        reason: "PermissionDenied",
        live: true,
      });
    }));
});
