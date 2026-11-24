// @effect-diagnostics nodeBuiltinImport:off -- node:sqlite builds the scratch database the copy is made from.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import {
  PersonalLinkSnapshot,
  layerLive,
  memoryDigestBeforeRenames,
  personalMemoryDigest,
  snapshotFileName,
} from "./personalLinkSnapshot.ts";

const files = [
  { name: "notes.md", sha256: "a".repeat(64) },
  { name: "people.md", sha256: "b".repeat(64) },
  { name: "routines/daily.md", sha256: "c".repeat(64) },
];

describe("personalMemoryDigest", () => {
  it("is the same whatever order the files are listed in", () => {
    const forward = personalMemoryDigest(files);
    assert.strictEqual(personalMemoryDigest(files.toReversed()), forward);
    assert.strictEqual(personalMemoryDigest([files[1]!, files[2]!, files[0]!]), forward);
    assert.match(forward, /^[0-9a-f]{64}$/);
  });

  it("changes when a file's content, name or presence changes", () => {
    const base = personalMemoryDigest(files);
    const edited = files.map((file) =>
      file.name === "notes.md" ? { ...file, sha256: "d".repeat(64) } : file,
    );
    const renamed = files.map((file) =>
      file.name === "notes.md" ? { ...file, name: "notes (m4).md" } : file,
    );
    const digests = [
      base,
      personalMemoryDigest(edited),
      personalMemoryDigest(renamed),
      personalMemoryDigest(files.slice(1)),
      personalMemoryDigest([...files, { name: "extra.md", sha256: "e".repeat(64) }]),
      personalMemoryDigest([]),
    ];
    assert.strictEqual(new Set(digests).size, digests.length);
  });

  it("does not let a name and hash run together into another file's pair", () => {
    // Without a separator, "ab" + "c..." and "a" + "bc..." would hash the same text.
    const left = personalMemoryDigest([{ name: "ab", sha256: "c".repeat(64) }]);
    const right = personalMemoryDigest([{ name: "a", sha256: `b${"c".repeat(64)}` }]);
    assert.notStrictEqual(left, right);
  });
});

describe("memoryDigestBeforeRenames", () => {
  it("maps renamed files back so a retried join matches the approved digest", () => {
    const approved = personalMemoryDigest(files);
    const renames = [
      { from: "notes.md", to: "notes (m4).md" },
      { from: "people.md", to: "people (m4).md" },
    ];
    const afterRenames = files.map((file) => {
      const rename = renames.find((entry) => entry.from === file.name);
      return rename === undefined ? file : { ...file, name: rename.to };
    });
    assert.notStrictEqual(personalMemoryDigest(afterRenames), approved);
    assert.strictEqual(memoryDigestBeforeRenames(afterRenames, renames), approved);
  });

  it("counts a rename that stopped halfway once, so the retry still matches", () => {
    const renames = [{ from: "notes.md", to: "notes (m4).md" }];
    const halfway = [...files, { name: "notes (m4).md", sha256: "a".repeat(64) }];
    assert.strictEqual(memoryDigestBeforeRenames(halfway, renames), personalMemoryDigest(files));
  });

  it("equals the plain digest when no renames happened yet", () => {
    const renames = [{ from: "notes.md", to: "notes (m4).md" }];
    assert.strictEqual(memoryDigestBeforeRenames(files, renames), personalMemoryDigest(files));
    assert.strictEqual(memoryDigestBeforeRenames(files, []), personalMemoryDigest(files));
  });

  it("still differs from the approval when content changed besides the renames", () => {
    const approved = personalMemoryDigest(files);
    const renames = [{ from: "notes.md", to: "notes (m4).md" }];
    const afterRenamesAndEdit = files.map((file) =>
      file.name === "notes.md"
        ? { name: "notes (m4).md", sha256: file.sha256 }
        : file.name === "people.md"
          ? { ...file, sha256: "f".repeat(64) }
          : file,
    );
    assert.notStrictEqual(memoryDigestBeforeRenames(afterRenamesAndEdit, renames), approved);
  });
});

describe("PersonalLinkSnapshot default", () => {
  it.effect("fails every snapshot without the live layer (fail closed)", () =>
    Effect.gen(function* () {
      const snapshotter = yield* PersonalLinkSnapshot;
      const error = yield* Effect.flip(snapshotter.snapshot("personal-link:op-1"));
      assert.instanceOf(error, Error);
      assert.match(error.message, /cannot save a database copy/);
    }),
  );
});

/** A scratch state folder under the OS temp dir; never the live SpecWithCode data. */
const makeScratchBase = () =>
  Effect.acquireRelease(
    Effect.sync(() =>
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-personal-link-snapshot-")),
    ),
    (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );

/** Creates the scratch database at `dbPath` and keeps it open, like the running service would. */
const openScratchDatabase = (dbPath: string, rows: number) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const holder = new NodeSqlite.DatabaseSync(dbPath);
      holder.exec("PRAGMA journal_mode=WAL;");
      holder.exec("CREATE TABLE IF NOT EXISTS project_memory(name TEXT PRIMARY KEY, body TEXT)");
      const insert = holder.prepare(
        "INSERT OR IGNORE INTO project_memory(name, body) VALUES (?, ?)",
      );
      for (let i = 0; i < rows; i++) insert.run(`file-${i}.md`, `body ${i}`);
      return holder;
    }),
    (holder) => Effect.sync(() => holder.close()),
  );

const countRows = (path: string) => {
  const copy = new NodeSqlite.DatabaseSync(path, { readOnly: true });
  try {
    return Number(
      Object.values(copy.prepare("SELECT count(*) FROM project_memory").get() ?? {})[0],
    );
  } finally {
    copy.close();
  }
};

const liveFor = (baseDir: string) =>
  layerLive.pipe(
    Layer.provideMerge(ServerConfig.layerTest(baseDir, baseDir)),
    Layer.provide(NodeServices.layer),
  );

describe("PersonalLinkSnapshot layerLive", () => {
  it.effect("copies the scratch database into <state>/backups/personal-link", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const baseDir = yield* makeScratchBase();
        yield* Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          assert.isTrue(config.dbPath.startsWith(baseDir));
          yield* openScratchDatabase(config.dbPath, 5);
          const snapshotter = yield* PersonalLinkSnapshot;
          const path = yield* snapshotter.snapshot("personal-link:op/1");
          assert.strictEqual(
            path,
            NodePath.join(
              config.stateDir,
              "backups",
              "personal-link",
              snapshotFileName("personal-link:op/1"),
            ),
          );
          assert.isTrue(NodeFS.existsSync(path));
          assert.strictEqual(countRows(path), 5);
        }).pipe(Effect.provide(liveFor(baseDir)));
      }),
    ),
  );

  it.effect("reuses the copy when the same operation snapshots again", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const baseDir = yield* makeScratchBase();
        yield* Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          const holder = yield* openScratchDatabase(config.dbPath, 3);
          const snapshotter = yield* PersonalLinkSnapshot;
          const first = yield* snapshotter.snapshot("personal-link:op-2");
          const firstMtime = NodeFS.statSync(first).mtimeMs;
          // The database moves on; the retry must keep the pre-merge copy.
          holder.prepare("INSERT INTO project_memory(name, body) VALUES (?, ?)").run("late", "x");
          const second = yield* snapshotter.snapshot("personal-link:op-2");
          assert.strictEqual(second, first);
          assert.strictEqual(countRows(second), 3);
          assert.strictEqual(NodeFS.statSync(second).mtimeMs, firstMtime);
          assert.deepStrictEqual(
            NodeFS.readdirSync(NodePath.dirname(first)).filter((name) => name.endsWith(".sqlite")),
            [snapshotFileName("personal-link:op-2")],
          );
        }).pipe(Effect.provide(liveFor(baseDir)));
      }),
    ),
  );

  it.effect("reuses an existing copy for the same operation after a restart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const baseDir = yield* makeScratchBase();
        const first = yield* Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          yield* openScratchDatabase(config.dbPath, 2);
          return yield* (yield* PersonalLinkSnapshot).snapshot("personal-link:op-3");
        }).pipe(Effect.scoped, Effect.provide(liveFor(baseDir)));
        // A fresh layer has no memory of the first run, as after a server restart.
        const second = yield* Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          yield* openScratchDatabase(config.dbPath, 4);
          return yield* (yield* PersonalLinkSnapshot).snapshot("personal-link:op-3");
        }).pipe(Effect.scoped, Effect.provide(liveFor(baseDir)));
        assert.strictEqual(second, first);
        assert.strictEqual(countRows(second), 2);
      }),
    ),
  );

  it.effect("gives different operations different copies", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const baseDir = yield* makeScratchBase();
        yield* Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          const holder = yield* openScratchDatabase(config.dbPath, 1);
          const snapshotter = yield* PersonalLinkSnapshot;
          const first = yield* snapshotter.snapshot("personal-link:op-a");
          holder.prepare("INSERT INTO project_memory(name, body) VALUES (?, ?)").run("b", "x");
          const second = yield* snapshotter.snapshot("personal-link:op-b");
          assert.notStrictEqual(second, first);
          assert.strictEqual(countRows(first), 1);
          assert.strictEqual(countRows(second), 2);
        }).pipe(Effect.provide(liveFor(baseDir)));
      }),
    ),
  );

  it.effect("fails, writing nothing, when there is no database to copy", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const baseDir = yield* makeScratchBase();
        yield* Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          const error = yield* Effect.flip(
            (yield* PersonalLinkSnapshot).snapshot("personal-link:op-missing"),
          );
          assert.match(error.message, /No SpecWithCode database/);
          const dir = NodePath.join(config.stateDir, "backups", "personal-link");
          const written = NodeFS.existsSync(dir) ? NodeFS.readdirSync(dir) : [];
          assert.deepStrictEqual(written, []);
        }).pipe(Effect.provide(liveFor(baseDir)));
      }),
    ),
  );

  // Operation ids that differ only in characters outside [a-zA-Z0-9._-] once
  // mapped to one file name; the hash suffix keeps each operation's own copy.
  it.effect("does not reuse another operation's copy when their ids sanitize alike", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const baseDir = yield* makeScratchBase();
        yield* Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          const holder = yield* openScratchDatabase(config.dbPath, 1);
          const snapshotter = yield* PersonalLinkSnapshot;
          const first = yield* snapshotter.snapshot("personal-link:op-c");
          holder.prepare("INSERT INTO project_memory(name, body) VALUES (?, ?)").run("c", "x");
          const second = yield* snapshotter.snapshot("personal-link_op-c");
          assert.notStrictEqual(second, first);
          assert.strictEqual(countRows(second), 2);
        }).pipe(Effect.provide(liveFor(baseDir)));
      }),
    ),
  );

  it("names long ids that share a prefix apart", () => {
    const prefix = "personal-link:".padEnd(120, "x");
    assert.notStrictEqual(snapshotFileName(`${prefix}a`), snapshotFileName(`${prefix}b`));
    assert.match(
      snapshotFileName("personal-link:op-1"),
      /^personal-link_op-1-[0-9a-f]{16}\.sqlite$/,
    );
  });

  it.effect("refuses, instead of reusing, a folder in the way of the copy's folder", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const baseDir = yield* makeScratchBase();
        yield* Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          yield* openScratchDatabase(config.dbPath, 1);
          NodeFS.mkdirSync(NodePath.join(config.stateDir, "backups"), { recursive: true });
          // A file where the personal-link folder should be: mkdir fails with EEXIST.
          NodeFS.writeFileSync(NodePath.join(config.stateDir, "backups", "personal-link"), "x");
          const error = yield* Effect.flip(
            (yield* PersonalLinkSnapshot).snapshot("personal-link:op-eexist"),
          );
          assert.instanceOf(error, Error);
        }).pipe(Effect.provide(liveFor(baseDir)));
      }),
    ),
  );

  it.effect("refuses to reuse an existing file that is not a sound database", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const baseDir = yield* makeScratchBase();
        yield* Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          yield* openScratchDatabase(config.dbPath, 1);
          const dir = NodePath.join(config.stateDir, "backups", "personal-link");
          NodeFS.mkdirSync(dir, { recursive: true });
          NodeFS.writeFileSync(
            NodePath.join(dir, snapshotFileName("personal-link:op-junk")),
            "not a database",
          );
          const error = yield* Effect.flip(
            (yield* PersonalLinkSnapshot).snapshot("personal-link:op-junk"),
          );
          assert.match(error.message, /unusable file/);
        }).pipe(Effect.provide(liveFor(baseDir)));
      }),
    ),
  );
});
