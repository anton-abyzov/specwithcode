// @effect-diagnostics nodeBuiltinImport:off -- The guard under test wraps node:fs itself.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import { assert, describe, it, vi } from "@effect/vitest";

import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";

import {
  installLiveDatabaseGuard,
  liveDatabaseDescriptor,
  liveDatabaseFile,
  liveDatabaseInside,
  registerLiveDatabase,
} from "./liveDatabaseGuard.ts";

const posix = HostProcessPlatform.defaultValue() !== "win32";
const darwin = HostProcessPlatform.defaultValue() === "darwin";

// The guard writes at most 25 reports per process; each capture starts from zero.
const resetReports = () => {
  const holder = globalThis as Record<symbol, { reports: number } | undefined>;
  const guard = holder[Symbol.for("specweave-studio.liveDatabaseGuard")];
  if (guard !== undefined) guard.reports = 0;
};

const captureStderr = () => {
  resetReports();
  const write = process.stderr.write;
  const lines: Array<string> = [];
  process.stderr.write = ((chunk: string) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return { lines, restore: () => (process.stderr.write = write) };
};

const isOpen = (fd: number): boolean => {
  try {
    NodeFS.fstatSync(fd);
    return true;
  } catch {
    return false;
  }
};

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

describe.runIf(posix)("liveDatabaseFile by file identity", () => {
  it("names a descriptor path and the macOS data-volume path of a live file", () =>
    withDirectory((directory) => {
      const dbPath = NodePath.join(directory, "statev2.sqlite");
      for (const suffix of ["", "-wal", "-shm"]) NodeFS.writeFileSync(`${dbPath}${suffix}`, "x");
      NodeFS.writeFileSync(NodePath.join(directory, "other"), "x");
      const fd = NodeFS.openSync(`${dbPath}-shm`, "r");
      const otherFd = NodeFS.openSync(NodePath.join(directory, "other"), "r");
      const late = NodePath.join(directory, "late");
      const alias = NodePath.join(directory, "alias");
      NodeFS.symlinkSync(`${dbPath}-wal`, alias);
      // @effect-diagnostics-next-line globalDate:off - the guard throttles on wall-clock time.
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const stderr = captureStderr();
      const unregister = registerLiveDatabase(dbPath);
      // A hard link made after registration has another name; the close guard covers it.
      NodeFS.linkSync(dbPath, late);
      const lateFd = NodeFS.openSync(late, "r");
      try {
        assert.equal(liveDatabaseDescriptor(fd), `${dbPath}-shm`);
        assert.equal(liveDatabaseFile(`/dev/fd/${fd}`), `${dbPath}-shm`);
        assert.isUndefined(liveDatabaseFile(`/dev/fd/${otherFd}`));
        if (darwin) assert.equal(liveDatabaseFile(`/System/Volumes/Data${dbPath}`), dbPath);
        assert.isUndefined(liveDatabaseFile(late));
        assert.isUndefined(liveDatabaseFile(alias));
        assert.equal(liveDatabaseDescriptor(lateFd), dbPath);
        assert.isUndefined(liveDatabaseDescriptor(otherFd));
        // Checked by identity, a symlink or a late hard link names the file too.
        assert.equal(liveDatabaseFile(alias, true), `${dbPath}-wal`);
        assert.equal(liveDatabaseFile(late, true), dbPath);
        assert.isUndefined(liveDatabaseFile(NodePath.join(directory, "other"), true));
        // The next recheck finds the second link, and every path is checked by identity.
        clock.mockReturnValue(now + 2000);
        assert.equal(liveDatabaseDescriptor(fd), `${dbPath}-shm`);
        assert.equal(liveDatabaseFile(late), dbPath);
        assert.equal(liveDatabaseFile(alias), `${dbPath}-wal`);
      } finally {
        unregister();
        clock.mockRestore();
        stderr.restore();
        for (const open of [fd, otherFd, lateFd]) NodeFS.closeSync(open);
      }
      assert.isTrue(stderr.lines.some((line) => line.includes("has 2 hard links")));
      assert.isUndefined(liveDatabaseFile(`/dev/fd/${fd}`));
    }));

  it("warns about a second hard link and then checks every path by identity", () =>
    withDirectory((directory) => {
      const dbPath = NodePath.join(directory, "statev2.sqlite");
      NodeFS.writeFileSync(dbPath, "x");
      const link = NodePath.join(directory, "other-name");
      NodeFS.linkSync(dbPath, link);
      const stderr = captureStderr();
      const unregister = registerLiveDatabase(dbPath);
      try {
        assert.equal(liveDatabaseFile(link), dbPath);
        assert.isUndefined(liveDatabaseFile(NodePath.join(directory, "missing")));
      } finally {
        unregister();
        stderr.restore();
      }
      assert.isTrue(stderr.lines.some((line) => line.includes("has 2 hard links")));
    }));

  it("follows a file deleted and created again", () =>
    withDirectory((directory) => {
      const dbPath = NodePath.join(directory, "statev2.sqlite");
      const wal = `${dbPath}-wal`;
      for (const suffix of ["", "-wal", "-shm"]) NodeFS.writeFileSync(`${dbPath}${suffix}`, "x");
      // @effect-diagnostics-next-line globalDate:off - the guard throttles on wall-clock time.
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const unregister = registerLiveDatabase(dbPath);
      // Held open so the old inode cannot be reused.
      const oldFd = NodeFS.openSync(wal, "r");
      NodeFS.unlinkSync(wal);
      NodeFS.writeFileSync(wal, "y");
      const newFd = NodeFS.openSync(wal, "r");
      try {
        assert.equal(liveDatabaseDescriptor(oldFd), wal);
        assert.isUndefined(liveDatabaseDescriptor(newFd));
        clock.mockReturnValue(now + 2000);
        assert.equal(liveDatabaseDescriptor(newFd), wal);
        assert.isUndefined(liveDatabaseDescriptor(oldFd));
      } finally {
        unregister();
        clock.mockRestore();
        for (const open of [oldFd, newFd]) NodeFS.closeSync(open);
      }
    }));
});

describe("installLiveDatabaseGuard", () => {
  it.runIf(posix)("keeps a descriptor for a live file open when node:fs closes it", async () => {
    const directory = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-live-db-guard-")),
    );
    const other = NodePath.join(directory, "settings.json");
    NodeFS.writeFileSync(other, "x");
    const closes: ReadonlyArray<readonly [string, (path: string) => Promise<number>]> = [
      [
        "closeSync",
        async (path) => {
          const fd = NodeFS.openSync(path, "r");
          NodeFS.closeSync(fd);
          return fd;
        },
      ],
      [
        "close",
        async (path) => {
          const fd = NodeFS.openSync(path, "r");
          await new Promise<void>((resolve, reject) =>
            NodeFS.close(fd, (error) => (error ? reject(error) : resolve())),
          );
          return fd;
        },
      ],
      [
        "FileHandle.close",
        async (path) => {
          const handle = await NodeFS.promises.open(path, "r");
          const fd = handle.fd;
          await handle.close();
          return fd;
        },
      ],
    ];
    const stderr = captureStderr();
    const uninstall = installLiveDatabaseGuard();
    const kept: Array<number> = [];
    try {
      for (const [index, [operation, openAndClose]] of closes.entries()) {
        const dbPath = NodePath.join(directory, `statev2-${index}.sqlite`);
        for (const suffix of ["", "-wal", "-shm"]) NodeFS.writeFileSync(`${dbPath}${suffix}`, "x");
        const unregister = registerLiveDatabase(dbPath);
        try {
          // A hard link made after registration gets past the name checks.
          const link = NodePath.join(directory, `shm-link-${index}`);
          NodeFS.linkSync(`${dbPath}-shm`, link);
          const fd = await openAndClose(link);
          assert.isTrue(isOpen(fd), operation);
          // A FileHandle's descriptor stays with the handle the guard keeps.
          if (operation !== "FileHandle.close") kept.push(fd);
          assert.isTrue(
            stderr.lines.some((line) =>
              line.startsWith(`[live-database-guard] ${operation} refused`),
            ),
            operation,
          );
          // Reaching it again through the same name is refused at open, so nothing more leaks.
          assert.throws(() => NodeFS.openSync(link, "r"), /live SpecWithCode database/);
          // Other files close as usual.
          const plain = NodeFS.openSync(other, "r");
          NodeFS.closeSync(plain);
          assert.isFalse(isOpen(plain));
          const plainHandle = await NodeFS.promises.open(other, "r");
          const plainHandleFd = plainHandle.fd;
          await plainHandle.close();
          assert.isFalse(isOpen(plainHandleFd));
        } finally {
          unregister();
        }
      }
    } finally {
      uninstall();
      stderr.restore();
    }
    // Unregistered, the same descriptors close normally.
    for (const fd of kept) NodeFS.closeSync(fd);
    assert.isFalse(kept.some(isOpen));
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });

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
    const stderr = captureStderr();
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
      // A symlink gets past the names; calls that close natively check it by identity.
      const alias = NodePath.join(directory, "alias");
      NodeFS.symlinkSync(shm, alias);
      refused(() => NodeFS.readFileSync(alias, "utf8"));
      refused(() => NodeFS.readFileSync(alias));
      refused(() => NodeFS.writeFileSync(alias, "y"));
      refused(() => NodeFS.appendFileSync(alias, "y"));
      refused(() => NodeFS.copyFileSync(alias, NodePath.join(directory, "copy")));
      refused(() => NodeFS.copyFileSync(other, alias));
      refused(() => NodeFS.cpSync(alias, NodePath.join(directory, "copy")));
      refused(() => NodeFS.watch(alias));
      const aliasRead = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
        NodeFS.readFile(alias, "utf8", (error) => resolve(error)),
      );
      assert.equal(aliasRead?.code, "EACCES");
      const aliasBlob = await NodeFS.openAsBlob(alias).then(
        () => undefined,
        (error: NodeJS.ErrnoException) => error,
      );
      assert.equal(aliasBlob?.code, "EACCES");
      const aliasCopy = await NodeFS.promises
        .copyFile(alias, NodePath.join(directory, "copy"))
        .then(
          () => undefined,
          (error: NodeJS.ErrnoException) => error,
        );
      assert.equal(aliasCopy?.code, "EACCES");
      const otherAlias = NodePath.join(directory, "other-alias");
      NodeFS.symlinkSync(other, otherAlias);
      assert.equal(NodeFS.readFileSync(otherAlias, "utf8"), "x");
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
      assert.isTrue(stderr.lines.some((line) => line.startsWith("[live-database-guard] EACCES")));
    } finally {
      unregister();
      uninstall();
      stderr.restore();
    }
    // Restored: the same calls work again.
    NodeFS.closeSync(NodeFS.openSync(`${dbPath}-shm`, "r"));
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  it("checks the identity of an asynchronous call's path without blocking the event loop", async () => {
    const directory = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-live-db-guard-")),
    );
    const dbPath = NodePath.join(directory, "statev2.sqlite");
    const other = NodePath.join(directory, "settings.json");
    const copy = NodePath.join(directory, "copy.json");
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, other]) {
      NodeFS.writeFileSync(file, "x");
    }
    const uninstall = installLiveDatabaseGuard();
    const unregister = registerLiveDatabase(dbPath);
    // The guard reads node:fs through its ESM namespace, which mirrors these exports.
    const statSync = vi.spyOn(process.getBuiltinModule("node:fs"), "statSync");
    NodeModule.syncBuiltinESMExports();
    try {
      const read = await new Promise<string>((resolve, reject) =>
        NodeFS.readFile(other, "utf8", (error, data) => (error ? reject(error) : resolve(data))),
      );
      assert.equal(read, "x");
      await new Promise<void>((resolve, reject) =>
        NodeFS.copyFile(other, copy, (error) => (error ? reject(error) : resolve())),
      );
      await NodeFS.promises.copyFile(other, copy);
      await NodeFS.promises.cp(other, copy);
      assert.equal(await (await NodeFS.openAsBlob(other)).text(), "x");
      // A stalled mount would block the event loop in any of these.
      const touched = statSync.mock.calls.map(([path]) => String(path));
      assert.deepEqual(
        touched.filter((path) => path === other || path === copy),
        [],
      );
    } finally {
      statSync.mockRestore();
      NodeModule.syncBuiltinESMExports();
      unregister();
      uninstall();
    }
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

// A process holds a WAL database with the guard installed, then reaches it
// through every name the path checks do not cover, plus SQLite's own
// descriptor. Another process then asks the kernel who holds the locks.
const GUARD_URL = new URL("./liveDatabaseGuard.ts", import.meta.url).href;
const FLEET_SCRIPTS = new URL("../../../../scripts/studio-fleet/", import.meta.url).pathname;

const HOLDER = `
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import { DatabaseSync } from "node:sqlite";
const dbPath = process.argv[1];
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t(v) VALUES ('a');");
const count = db.prepare("SELECT count(*) AS n FROM t");
count.get();
const guard = await import(${JSON.stringify(GUARD_URL)});
guard.installLiveDatabaseGuard();
const { dev, ino } = NodeFS.statSync(dbPath);
const sqliteFd = NodeFS.readdirSync("/dev/fd").map(Number).find((fd) => {
  try {
    const stats = NodeFS.fstatSync(fd);
    return stats.dev === dev && stats.ino === ino;
  } catch {
    return false;
  }
});
const lines = NodeReadline.createInterface({ input: process.stdin });
process.stdout.write("ready\\n");
await new Promise((resolve) => lines.once("line", resolve));
guard.registerLiveDatabase(dbPath);
const directory = NodePath.dirname(dbPath);
const alias = NodePath.join(directory, "shm-alias");
const link = NodePath.join(directory, "db-link");
const shmLink = NodePath.join(directory, "shm-link");
const outcome = {};
const attempt = async (name, run) => {
  try {
    await run();
    outcome[name] = "closed";
  } catch (error) {
    outcome[name] = "refused " + error.code;
  }
};
NodeFS.symlinkSync(dbPath + "-shm", alias);
await attempt("symlinkReadFileUtf8", () => NodeFS.readFileSync(alias, "utf8"));
await attempt("symlinkCopyFile", () => NodeFS.copyFileSync(alias, NodePath.join(directory, "copy")));
// The first close through a late hard link is refused at close; after it, every name is checked at open.
NodeFS.linkSync(dbPath, link);
NodeFS.linkSync(dbPath + "-shm", shmLink);
await attempt("hardLinkSync", () => NodeFS.closeSync(NodeFS.openSync(link, "r")));
await attempt("hardLinkSyncAgain", () => NodeFS.closeSync(NodeFS.openSync(link, "r")));
await attempt("descriptorPath", () => NodeFS.closeSync(NodeFS.openSync("/dev/fd/" + sqliteFd, "r")));
if (process.platform === "darwin") {
  const firmlink = "/System/Volumes/Data" + NodeFS.realpathSync(dbPath);
  await attempt("firmlink", () => NodeFS.closeSync(NodeFS.openSync(firmlink, "r")));
}
await attempt("hardLinkReadFileSync", () => NodeFS.readFileSync(link));
await attempt("hardLinkCallback", () => new Promise((resolve, reject) =>
  NodeFS.open(shmLink, "r", (error, fd) => error ? reject(error) : NodeFS.close(fd, (closeError) => closeError ? reject(closeError) : resolve())),
));
await attempt("hardLinkFileHandle", async () => (await NodeFS.promises.open(link, "r")).close());
await attempt("hardLinkPromisesReadFile", () => NodeFS.promises.readFile(shmLink));
await attempt("hardLinkStream", () => new Promise((resolve, reject) =>
  NodeFS.createReadStream(link).on("error", reject).on("close", resolve).resume(),
));
await attempt("sqliteDescriptor", () => NodeFS.closeSync(sqliteFd));
outcome.rows = count.get().n;
process.stdout.write(JSON.stringify(outcome) + "\\n");
setInterval(() => count.get(), 100);
`;

const LOCKS = `
import json, sys
sys.path.insert(0, sys.argv[1])
import live_database
print(json.dumps(live_database.service_locks(sys.argv[2])))
`;

const lockHolders = (dbPath: string): { database: unknown; index: unknown } => {
  const result = NodeChildProcess.spawnSync(
    "python3",
    ["-B", "-I", "-c", LOCKS, FLEET_SCRIPTS, dbPath],
    {
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
};

const hasPython =
  posix && NodeChildProcess.spawnSync("python3", ["-I", "-c", "import fcntl"]).status === 0;

describe.runIf(hasPython)("a guarded process holding a live database", () => {
  it("keeps its SQLite locks when node:fs opens and closes the files under other names", async () => {
    const directory = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-live-db-guard-")),
    );
    const dbPath = NodePath.join(directory, "statev2.sqlite");
    const holder = NodeChildProcess.spawn(
      process.execPath,
      ["--no-warnings", "--input-type=module", "--eval", HOLDER, dbPath],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stderr = "";
    holder.stderr.on("data", (chunk) => (stderr += String(chunk)));
    const lines = NodeReadline.createInterface({ input: holder.stdout });
    const nextLine = () =>
      new Promise<string>((resolve, reject) => {
        lines.once("line", resolve);
        holder.once("exit", () => reject(new Error(`The holder exited: ${stderr}`)));
      });
    try {
      assert.equal(await nextLine(), "ready");
      const expected = { database: holder.pid, index: holder.pid };
      assert.deepEqual(lockHolders(dbPath), expected);
      holder.stdin.write("go\n");
      const outcome = JSON.parse(await nextLine());
      assert.deepEqual(outcome, {
        symlinkReadFileUtf8: "refused EACCES",
        symlinkCopyFile: "refused EACCES",
        hardLinkSync: "closed",
        hardLinkSyncAgain: "refused EACCES",
        descriptorPath: "refused EACCES",
        ...(darwin ? { firmlink: "refused EACCES" } : {}),
        hardLinkReadFileSync: "refused EACCES",
        hardLinkCallback: "refused EACCES",
        hardLinkFileHandle: "refused EACCES",
        hardLinkPromisesReadFile: "refused EACCES",
        hardLinkStream: "refused EACCES",
        sqliteDescriptor: "closed",
        rows: 1,
      });
      assert.deepEqual(lockHolders(dbPath), expected);
      assert.include(stderr, "[live-database-guard] EACCES: readFileSync refused");
      assert.include(stderr, "[live-database-guard] closeSync refused");
    } finally {
      holder.kill("SIGKILL");
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});
