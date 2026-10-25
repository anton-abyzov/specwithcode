// @effect-diagnostics nodeBuiltinImport:off -- node:sqlite is the driver under test.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { assert, describe, it } from "@effect/vitest";
import { symlinksSupported } from "@specweave-studio/shared/testing/symlinks";
import { vi } from "vite-plus/test";

// NTFS file IDs are 64 bits: a sequence number above a 48-bit record index.
// As a Number past 2^53 their low bits are lost, so files created one after
// another in a folder stat with the same `ino` unless asked for bigints. Give
// every file such an ID, in the order it is first seen, to stand in for Windows.
// With `ids.none` set, every file reports ID 0, as on a volume that has none.
const ids = vi.hoisted(() => ({ none: false }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const seen = new Map<string, bigint>();
  const windowsId = (stats: { dev: number | bigint; ino: number | bigint }) => {
    const key = `${stats.dev}:${stats.ino}`;
    if (!seen.has(key)) seen.set(key, (0x7fffn << 48n) + BigInt(seen.size + 1));
    return seen.get(key)!;
  };
  const statSync = ((path: string, options?: { bigint?: boolean; throwIfNoEntry?: boolean }) => {
    const stats = actual.statSync(path, options);
    if (stats === undefined) return stats;
    const ino = ids.none ? 0n : windowsId(stats);
    return Object.assign(stats, { ino: options?.bigint === true ? ino : Number(ino) });
  }) as typeof actual.statSync;
  return { ...actual, statSync, default: { ...actual, statSync } };
});

const NodeFS = await import("node:fs");
const { snapshotLiveDatabase } = await import("./liveDatabaseSnapshot.ts");

const withHeldDatabase = async (run: (dbPath: string, directory: string) => Promise<void>) => {
  const directory = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-live-db-fileid-")),
  );
  const dbPath = NodePath.join(directory, "statev2.sqlite");
  const holder = new NodeSqlite.DatabaseSync(dbPath);
  try {
    holder.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(id INTEGER PRIMARY KEY);");
    await run(dbPath, directory);
  } finally {
    ids.none = false;
    holder.close();
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
};

const failure = (dbPath: string, target: string) =>
  snapshotLiveDatabase(dbPath, target).then(
    () => "",
    (error: Error) => error.message,
  );

describe("snapshotLiveDatabase with 64-bit file IDs", () => {
  it("tells an existing snapshot from the live files, and still refuses the live files", async () => {
    await withHeldDatabase(async (dbPath, directory) => {
      const output = NodePath.join(directory, "copy.sqlite");
      await snapshotLiveDatabase(dbPath, output);
      assert.match(await failure(dbPath, output), /already exists/);
      for (const suffix of ["", "-wal", "-shm"]) {
        assert.match(await failure(dbPath, `${dbPath}${suffix}`), /live database file/);
      }
      const link = NodePath.join(directory, "linked.sqlite");
      NodeFS.linkSync(dbPath, link);
      assert.match(await failure(dbPath, link), /live database file/);
    });
  });

  it("compares real paths when the volume reports no file IDs", async () => {
    await withHeldDatabase(async (dbPath, directory) => {
      const output = NodePath.join(directory, "copy.sqlite");
      await snapshotLiveDatabase(dbPath, output);
      ids.none = true;
      assert.match(await failure(dbPath, output), /already exists/);
      for (const suffix of ["", "-wal", "-shm"]) {
        assert.match(await failure(dbPath, `${dbPath}${suffix}`), /live database file/);
        // Windows refuses symlinks without Developer Mode or elevation.
        if (!symlinksSupported) continue;
        const link = NodePath.join(directory, `symlinked${suffix}`);
        NodeFS.symlinkSync(`${dbPath}${suffix}`, link);
        assert.match(await failure(dbPath, link), /live database file/);
      }
    });
  });
});
