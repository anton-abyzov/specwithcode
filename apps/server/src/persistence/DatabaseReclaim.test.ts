// @effect-diagnostics nodeBuiltinImport:off -- A raw node:sqlite connection stands in for another process.
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as DatabaseReclaim from "./DatabaseReclaim.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const layerDatabase = (dbPath: string) => {
  const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
    Layer.provideMerge(SqlitePersistence.layerFromPath(dbPath)),
  );
  return Layer.mergeAll(
    stores,
    EventSink.layer.pipe(Layer.provide(stores)),
    ProjectionMaintenance.layer.pipe(Layer.provide(stores)),
  );
};

const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;
const thread = (threadId: ThreadId, now: DateTime.Utc): OrchestrationV2AppThread => ({
  createdBy: "user",
  creationSource: "web",
  id: threadId,
  projectId: ProjectId.make(`project:${threadId}`),
  title: `Thread ${threadId}`,
  providerInstanceId,
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});

/** Two threads whose node, message and visit snapshots are superseded many times. */
const history = (now: DateTime.Utc): Array<OrchestrationV2DomainEvent> => {
  let serial = 0;
  const id = () => EventId.make(`event:reclaim:${(serial += 1)}`);
  const events: Array<OrchestrationV2DomainEvent> = [];
  for (const threadId of [ThreadId.make("thread:reclaim:1"), ThreadId.make("thread:reclaim:2")]) {
    events.push({
      id: id(),
      type: "thread.created",
      threadId,
      providerInstanceId,
      occurredAt: now,
      payload: thread(threadId, now),
    });
    const nodeId = NodeId.make(`node:${threadId}`);
    for (let update = 0; update < 150; update += 1) {
      events.push({
        id: id(),
        type: "node.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: nodeId,
          threadId,
          runId: null,
          parentNodeId: null,
          rootNodeId: nodeId,
          kind: "assistant_message",
          status: update === 149 ? "completed" : "running",
          countsForRun: false,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: update === 149 ? now : null,
        },
      });
      events.push({
        id: id(),
        type: "message.updated",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: MessageId.make(`message:${threadId}`),
          threadId,
          runId: null,
          nodeId: null,
          role: "user",
          text: `${"x".repeat(2_000)}:${update}`,
          attachments: [],
          streaming: update < 149,
          createdAt: now,
          updatedAt: now,
        },
      });
      events.push({
        id: id(),
        type: "thread.visited",
        threadId,
        providerInstanceId,
        occurredAt: now,
        payload: { ...thread(threadId, now), lastVisitedAt: now },
      });
    }
  }
  return events;
};

const projectionDump = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name LIKE 'orchestration_v2_projection_%' AND name <> 'orchestration_v2_projection_metadata'
    ORDER BY name
  `;
  const dump: Record<string, unknown> = {};
  for (const { name } of tables) {
    dump[name] = yield* sql.unsafe(`SELECT rowid AS __rowid, * FROM "${name}" ORDER BY rowid`);
  }
  return JSON.stringify(dump);
});

const sequences = (dbPath: string) => {
  const database = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      all: database
        .prepare("SELECT sequence FROM orchestration_events ORDER BY sequence")
        .all()
        .map((row) => Number(row["sequence"])),
      sqliteSequence: JSON.stringify(
        database.prepare("SELECT name, seq FROM sqlite_sequence ORDER BY name").all(),
      ),
      autoVacuum: Number(database.prepare("PRAGMA auto_vacuum").get()?.["auto_vacuum"]),
      quickCheck: String(database.prepare("PRAGMA quick_check").get()?.["quick_check"]),
    };
  } finally {
    database.close();
  }
};

const isReclaimError = Schema.is(DatabaseReclaim.DatabaseReclaimError);
const reasonOf = (error: { readonly _tag: string }) =>
  isReclaimError(error) ? error.reason : error._tag;
/** Real time: pids are dated against the process start time `ps` reports, not the test clock. */
// @effect-diagnostics-next-line globalDate:off -- the test clock would date the record before the process.
const wallClockIso = () => DateTime.formatIso(DateTime.makeUnsafe(Date.now()));

/** A stopped SpecWithCode home with a database holding `history`. */
const makeHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "database-reclaim-" });
  const userdata = path.join(home, "userdata");
  yield* fs.makeDirectory(userdata, { recursive: true });
  const dbPath = path.join(userdata, "statev2.sqlite");
  const projections = yield* Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    for (const event of history(now)) yield* sink.write({ events: [event] });
    return yield* projectionDump;
  }).pipe(Effect.provide(layerDatabase(dbPath)));
  const options = {
    dbPath,
    baseDir: home,
    serverRuntimeStatePath: path.join(userdata, "server-runtime.json"),
  };
  return { fs, path, home, userdata, dbPath, options, projections };
});

// db reclaim refuses on Windows (open files cannot be renamed), so only that refusal runs there.
const windowsHost = HostProcessPlatform.defaultValue() === "win32";

it.layer(NodeServices.layer)("db reclaim", (it) => {
  it.effect.skipIf(windowsHost)("compacts and rewrites the database, keeping every remaining sequence", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fs, dbPath, options, projections, userdata } = yield* makeHome;
        const before = sequences(dbPath);
        const sizeBefore = Number((yield* fs.stat(dbPath)).size);

        const dryRun = yield* DatabaseReclaim.reclaim({ ...options, dryRun: true });
        assert.isTrue(dryRun.dryRun);
        if (!dryRun.dryRun) return;
        assert.deepEqual(sequences(dbPath).all, before.all);
        assert.equal(dryRun.compaction.deletedEventCount, 2 * 148 * 2 + 2 * 149);
        assert.equal(dryRun.storage.freelistPages, 0);
        assert.isBelow(dryRun.expectedBytes.high, sizeBefore);

        const result = yield* DatabaseReclaim.reclaim(options);
        assert.isFalse(result.dryRun);
        if (result.dryRun) return;
        assert.equal(result.compaction.deletedEventCount, dryRun.compaction.deletedEventCount);
        assert.equal(result.maxSequence, before.all.at(-1));
        assert.isBelow(result.afterBytes, sizeBefore);
        assert.equal(result.autoVacuum, 0);
        assert.isTrue(result.backupPath.startsWith(`${dbPath}.before-reclaim-`));
        // Closed with its log folded in: no -wal or -shm is left beside the new file.
        assert.isFalse(yield* fs.exists(`${dbPath}-wal`));
        assert.isFalse(yield* fs.exists(`${dbPath}-shm`));

        // The backup is the compacted original; the new file keeps its every sequence.
        const compacted = sequences(result.backupPath);
        const rewritten = sequences(dbPath);
        assert.deepEqual(rewritten.all, compacted.all);
        assert.equal(rewritten.all.length, before.all.length - result.compaction.deletedEventCount);
        assert.equal(rewritten.all.at(-1), before.all.at(-1));
        assert.equal(rewritten.sqliteSequence, before.sqliteSequence);
        assert.equal(rewritten.quickCheck, "ok");
        const leftovers = (yield* fs.readDirectory(userdata)).filter((name) =>
          name.includes(".reclaim-"),
        );
        assert.deepEqual(leftovers, []);

        // The service opens the new file, and rebuild reproduces the projections.
        const rebuilt = yield* Effect.gen(function* () {
          const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
          assert.isTrue((yield* maintenance.verify).valid);
          assert.isTrue((yield* maintenance.rebuild).valid);
          return yield* projectionDump;
        }).pipe(Effect.provide(layerDatabase(dbPath)));
        assert.strictEqual(rebuilt, projections);
      }),
    ),
  );

  it.effect.skipIf(windowsHost)("writes the copy in another folder and turns on incremental auto_vacuum", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fs, path, home, dbPath, options } = yield* makeHome;
        const before = sequences(dbPath);
        const workDir = path.join(home, "work");
        const result = yield* DatabaseReclaim.reclaim({ ...options, workDir, incremental: true });
        if (result.dryRun) return assert.fail("not a dry run");
        assert.equal(result.autoVacuum, 2);
        const rewritten = sequences(dbPath);
        assert.equal(rewritten.autoVacuum, 2);
        assert.equal(rewritten.all.at(-1), before.all.at(-1));
        assert.deepEqual(yield* fs.readDirectory(workDir), []);
      }),
    ),
  );

  it.effect.skipIf(windowsHost)("refuses while the service runs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fs, dbPath, options } = yield* makeHome;
        const before = sequences(dbPath);
        yield* fs.writeFileString(
          options.serverRuntimeStatePath,
          JSON.stringify({
            version: 1,
            pid: process.pid,
            port: 3773,
            origin: "http://127.0.0.1:3773",
            startedAt: wallClockIso(),
          }),
        );
        const error = yield* Effect.flip(DatabaseReclaim.reclaim(options));
        assert.equal(reasonOf(error), "service-running");
        assert.include(String(error.message), options.serverRuntimeStatePath);
        assert.include(String(error.message), "--force-stale-pid");
        assert.deepEqual(sequences(dbPath).all, before.all);
      }),
    ),
  );

  it.effect.skipIf(windowsHost)("ignores a recorded pid another process took over, and a forced stale pid", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fs, path, home, options } = yield* makeHome;
        const runtime = (startedAt: string) =>
          fs.writeFileString(
            options.serverRuntimeStatePath,
            JSON.stringify({
              version: 1,
              pid: process.pid,
              port: 3773,
              origin: "http://127.0.0.1:3773",
              startedAt,
            }),
          );
        // This process started after the record: the pid was reused.
        yield* runtime("2000-01-01T00:00:00.000Z");
        const updates = path.join(home, "updates");
        yield* fs.makeDirectory(updates, { recursive: true });
        yield* fs.writeFileString(
          path.join(updates, "hold.json"),
          JSON.stringify({ pid: process.pid, startedAt: "2000-01-01T00:00:00.000Z" }),
        );
        const reused = yield* DatabaseReclaim.reclaim(options);
        assert.isFalse(reused.dryRun);

        // A pid that cannot be told apart from the service: only the override passes.
        yield* runtime(wallClockIso());
        assert.equal(
          reasonOf(yield* Effect.flip(DatabaseReclaim.reclaim(options))),
          "service-running",
        );
        const forced = yield* DatabaseReclaim.reclaim({ ...options, forceStalePid: true });
        assert.isFalse(forced.dryRun);
      }),
    ),
  );

  it.effect.skipIf(windowsHost)("refuses the swap when a connection opens the database after the copy", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fs, dbPath, options, userdata } = yield* makeHome;
        let other: NodeSqlite.DatabaseSync | undefined;
        const error = yield* Effect.flip(
          DatabaseReclaim.reclaim({
            ...options,
            beforeSwap: Effect.sync(() => {
              other = new NodeSqlite.DatabaseSync(dbPath);
              other.prepare("SELECT COUNT(*) FROM orchestration_events").get();
            }),
          }),
        ).pipe(Effect.ensuring(Effect.sync(() => other?.close())));
        assert.equal(reasonOf(error), "in-use");
        // Nothing was renamed: the compacted original is still the database, and the copy is gone.
        const names = yield* fs.readDirectory(userdata);
        assert.deepEqual(
          names.filter((name) => name.includes("reclaim")),
          [],
        );
        assert.equal(sequences(dbPath).quickCheck, "ok");
      }),
    ),
  );

  it.effect.skipIf(windowsHost)("keeps every other connection out while it swaps", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fs, dbPath, options, userdata, path } = yield* makeHome;
        const refused: Array<string> = [];
        const tryRead = (file: string) => {
          const other = new NodeSqlite.DatabaseSync(file);
          try {
            other.exec("PRAGMA busy_timeout = 0");
            other.prepare("SELECT COUNT(*) FROM orchestration_events").get();
          } catch (error) {
            refused.push(String(error));
          } finally {
            other.close();
          }
        };
        const result = yield* DatabaseReclaim.reclaim({
          ...options,
          duringSwap: Effect.gen(function* () {
            tryRead(dbPath);
            const copy = (yield* fs.readDirectory(userdata)).find((name) =>
              /\.reclaim-\d{8}T\d{6}Z$/.test(name),
            );
            if (copy !== undefined) tryRead(path.join(userdata, copy));
          }).pipe(Effect.orDie),
        });
        assert.isFalse(result.dryRun);
        assert.equal(refused.length, 2);
        for (const message of refused) assert.match(message, /locked|busy/i);
        assert.equal(sequences(dbPath).quickCheck, "ok");
      }),
    ),
  );

  it.effect.skipIf(windowsHost)("puts the original back when the copy cannot be moved into place", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fs, dbPath, options, userdata } = yield* makeHome;
        const failing = FileSystem.FileSystem.of({
          ...fs,
          rename: (from, to) =>
            to === dbPath && from.includes(".reclaim-")
              ? fs.rename(`${from}.missing`, to)
              : fs.rename(from, to),
        });
        const error = yield* Effect.flip(
          DatabaseReclaim.reclaim(options).pipe(
            Effect.provideService(FileSystem.FileSystem, failing),
          ),
        );
        assert.equal(reasonOf(error), "failed");
        assert.include(String(error.message), "is unchanged");
        const names = yield* fs.readDirectory(userdata);
        assert.deepEqual(
          names.filter((name) => name.includes("before-reclaim")),
          [],
        );
        // The checked copy is kept, and the original opens where it was.
        const copy = names.find((name) => /\.reclaim-\d{8}T\d{6}Z$/.test(name));
        assert.isDefined(copy);
        assert.equal(sequences(dbPath).quickCheck, "ok");
        assert.deepEqual(sequences(dbPath).all, sequences(`${userdata}/${copy}`).all);
      }),
    ),
  );

  it.effect.skipIf(windowsHost)("syncs the copy beside the database and its folder before the rename", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fs, path, home, dbPath, options, userdata } = yield* makeHome;
        const workDir = path.join(home, "other-volume");
        yield* fs.makeDirectory(workDir, { recursive: true });
        const events: Array<string> = [];
        const watched = FileSystem.FileSystem.of({
          ...fs,
          stat: (target) =>
            target === workDir
              ? fs.stat(target).pipe(Effect.map((info) => ({ ...info, dev: info.dev + 1 })))
              : fs.stat(target),
          open: (target, openOptions) =>
            fs.open(target, openOptions).pipe(
              Effect.map((file) => ({
                ...file,
                sync: Effect.sync(() => events.push(`sync ${target}`)).pipe(
                  Effect.andThen(file.sync),
                ),
              })),
            ),
          rename: (from, to) =>
            Effect.sync(() => events.push(`rename ${from}`)).pipe(
              Effect.andThen(fs.rename(from, to)),
            ),
        });
        const result = yield* DatabaseReclaim.reclaim({ ...options, workDir }).pipe(
          Effect.provideService(FileSystem.FileSystem, watched),
        );
        assert.isFalse(result.dryRun);
        const staged = events.find((event) => /^sync .*\.reclaim-\d{8}T\d{6}Z$/.test(event));
        assert.isDefined(staged);
        assert.isTrue((staged ?? "").startsWith(`sync ${userdata}/`));
        const moved = events.indexOf(`rename ${(staged ?? "").slice("sync ".length)}`);
        assert.isAbove(moved, events.indexOf(staged ?? ""));
        assert.isAbove(moved, events.indexOf(`sync ${userdata}`));
        assert.equal(sequences(dbPath).quickCheck, "ok");
      }),
    ),
  );

  it.effect.skipIf(windowsHost)("keeps only the work-folder copy when the copy beside the database cannot move", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fs, path, home, dbPath, options, userdata } = yield* makeHome;
        const workDir = path.join(home, "other-volume");
        yield* fs.makeDirectory(workDir, { recursive: true });
        const failing = FileSystem.FileSystem.of({
          ...fs,
          stat: (target) =>
            target === workDir
              ? fs.stat(target).pipe(Effect.map((info) => ({ ...info, dev: info.dev + 1 })))
              : fs.stat(target),
          rename: (from, to) =>
            to === dbPath && from.includes(".reclaim-")
              ? fs.rename(`${from}.missing`, to)
              : fs.rename(from, to),
        });
        const error = yield* Effect.flip(
          DatabaseReclaim.reclaim({ ...options, workDir }).pipe(
            Effect.provideService(FileSystem.FileSystem, failing),
          ),
        );
        assert.equal(reasonOf(error), "failed");
        assert.include(String(error.message), "is unchanged");
        // Nothing of the reclaim is left beside the database; the checked copy waits in the work folder.
        assert.deepEqual(
          (yield* fs.readDirectory(userdata)).filter((name) => name.includes("reclaim")),
          [],
        );
        const kept = (yield* fs.readDirectory(workDir)).filter((name) =>
          /\.reclaim-\d{8}T\d{6}Z$/.test(name),
        );
        assert.lengthOf(kept, 1);
        assert.include(String(error.message), path.join(workDir, kept[0] ?? ""));
        assert.equal(sequences(dbPath).quickCheck, "ok");
      }),
    ),
  );

  it.effect.skipIf(windowsHost)("names the file to move back when neither rename can be undone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fs, dbPath, options, userdata } = yield* makeHome;
        const before = sequences(dbPath).all;
        // A volume without hard links, where both later renames fail.
        const failing = FileSystem.FileSystem.of({
          ...fs,
          link: (from) => fs.link(`${from}.missing`, `${from}.never`),
          rename: (from, to) =>
            to === dbPath ? fs.rename(`${from}.missing`, to) : fs.rename(from, to),
        });
        const error = yield* Effect.flip(
          DatabaseReclaim.reclaim(options).pipe(
            Effect.provideService(FileSystem.FileSystem, failing),
          ),
        );
        assert.equal(reasonOf(error), "failed");
        const backup = (yield* fs.readDirectory(userdata)).find((name) =>
          name.includes(".before-reclaim-"),
        );
        assert.isDefined(backup);
        assert.include(String(error.message), `Move ${userdata}/${backup} to ${dbPath}`);
        assert.isFalse(yield* fs.exists(dbPath));
        assert.isFalse(yield* fs.exists(`${dbPath}.reclaim-lock`));

        // The service refuses to start on a missing database and names the same file.
        const opened = yield* projectionDump.pipe(
          Effect.provide(layerDatabase(dbPath)),
          Effect.exit,
        );
        assert.isTrue(Exit.isFailure(opened));
        const why = Cause.pretty(Exit.isFailure(opened) ? opened.cause : Cause.empty);
        assert.include(why, `Move ${userdata}/${backup}`);
        assert.isFalse(yield* fs.exists(dbPath));
        // Moved back, it is the database again: compacted in place, nothing else lost.
        yield* fs.rename(`${userdata}/${backup}`, dbPath);
        assert.equal(sequences(dbPath).quickCheck, "ok");
        assert.equal(sequences(dbPath).all.at(-1), before.at(-1));
      }),
    ),
  );

  it.effect.skipIf(windowsHost)("finishes the swap it started when interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fs, dbPath, options, userdata } = yield* makeHome;
        const before = sequences(dbPath).all;
        const linking = yield* Deferred.make<void>();
        const proceed = yield* Deferred.make<void>();
        const slow = FileSystem.FileSystem.of({
          ...fs,
          link: (from, to) =>
            Deferred.succeed(linking, undefined).pipe(
              Effect.andThen(Deferred.await(proceed)),
              Effect.andThen(fs.link(from, to)),
            ),
        });
        const fiber = yield* Effect.forkChild(
          DatabaseReclaim.reclaim(options).pipe(Effect.provideService(FileSystem.FileSystem, slow)),
        );
        yield* Deferred.await(linking);
        // Ctrl+C reaches the CLI as this interrupt (NodeRuntime.runMain).
        const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber));
        yield* Effect.yieldNow;
        yield* Deferred.succeed(proceed, undefined);
        yield* Fiber.join(interrupting);
        // The database is whole: the rewritten one, with the original beside it.
        const after = sequences(dbPath);
        assert.equal(after.quickCheck, "ok");
        assert.isBelow(after.all.length, before.length);
        const backup = (yield* fs.readDirectory(userdata)).find((name) =>
          name.includes(".before-reclaim-"),
        );
        assert.isDefined(backup);
        // The original, compacted in place before the copy: the same log.
        assert.deepEqual(sequences(`${userdata}/${backup}`).all, after.all);
      }),
    ),
  );

  it.effect("refuses on Windows before it changes anything", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fs, dbPath, options, userdata } = yield* makeHome;
        const before = sequences(dbPath).all;
        const error = yield* Effect.flip(
          DatabaseReclaim.reclaim(options).pipe(
            Effect.provideService(HostProcessPlatform, "win32"),
          ),
        );
        assert.equal(reasonOf(error), "unsupported");
        assert.deepEqual(sequences(dbPath).all, before);
        assert.deepEqual(
          (yield* fs.readDirectory(userdata)).filter((name) => name.includes("reclaim")),
          [],
        );
      }),
    ),
  );

  it.effect.skipIf(windowsHost)("a lock whose pid cannot be dated stops reclaim, not the service", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fs, dbPath, options } = yield* makeHome;
        // A live pid (this process's parent) with no readable time: as on Windows or BusyBox.
        yield* fs.writeFileString(
          `${dbPath}.reclaim-lock`,
          JSON.stringify({ pid: process.ppid, startedAt: "unknown" }),
        );
        const opened = yield* projectionDump.pipe(
          Effect.provide(layerDatabase(dbPath)),
          Effect.exit,
        );
        assert.isTrue(Exit.isSuccess(opened));

        const error = yield* Effect.flip(DatabaseReclaim.reclaim(options));
        assert.equal(reasonOf(error), "in-use");
        assert.include(String(error.message), `${dbPath}.reclaim-lock`);
        assert.include(String(error.message), "--force-stale-pid");
        const forced = yield* DatabaseReclaim.reclaim({ ...options, forceStalePid: true });
        assert.isFalse(forced.dryRun);
        assert.isFalse(yield* fs.exists(`${dbPath}.reclaim-lock`));
      }),
    ),
  );

  it.effect.skipIf(windowsHost)("--force-stale-pid never takes the lock of a reclaim ps dates as running", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fs, dbPath, options } = yield* makeHome;
        const before = sequences(dbPath).all;
        // A live pid (this process's parent) that started before its lock was written.
        const lock = JSON.stringify({ pid: process.ppid, startedAt: wallClockIso() });
        yield* fs.writeFileString(`${dbPath}.reclaim-lock`, lock);
        const error = yield* Effect.flip(
          DatabaseReclaim.reclaim({ ...options, forceStalePid: true }),
        );
        assert.equal(reasonOf(error), "in-use");
        assert.include(String(error.message), "does not override");
        assert.equal(yield* fs.readFileString(`${dbPath}.reclaim-lock`), lock);
        assert.deepEqual(sequences(dbPath).all, before);
      }),
    ),
  );

  it.effect.skipIf(windowsHost)("removes a partial copy beside the database when copying it fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fs, path, home, dbPath, options, userdata } = yield* makeHome;
        const workDir = path.join(home, "other-volume");
        yield* fs.makeDirectory(workDir, { recursive: true });
        // The work folder reads as another volume, and the copy across breaks off.
        const failing = FileSystem.FileSystem.of({
          ...fs,
          stat: (target) =>
            target === workDir
              ? fs.stat(target).pipe(Effect.map((info) => ({ ...info, dev: info.dev + 1 })))
              : fs.stat(target),
          copyFile: (from, to) =>
            fs
              .writeFileString(to, "partial")
              .pipe(Effect.andThen(fs.copyFile(`${from}.missing`, to))),
        });
        const error = yield* Effect.flip(
          DatabaseReclaim.reclaim({ ...options, workDir }).pipe(
            Effect.provideService(FileSystem.FileSystem, failing),
          ),
        );
        assert.notEqual(reasonOf(error), "in-use");
        assert.deepEqual(
          (yield* fs.readDirectory(userdata)).filter((name) => name.includes("reclaim")),
          [],
        );
        assert.deepEqual(yield* fs.readDirectory(workDir), []);
        assert.equal(sequences(dbPath).quickCheck, "ok");
      }),
    ),
  );

  it.effect.skipIf(windowsHost)("the service does not open the database while a reclaim runs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fs, dbPath } = yield* makeHome;
        const open = projectionDump.pipe(Effect.provide(layerDatabase(dbPath)), Effect.exit);
        yield* fs.writeFileString(
          `${dbPath}.reclaim-lock`,
          JSON.stringify({ pid: process.pid, startedAt: wallClockIso() }),
        );
        const refused = yield* open;
        assert.isTrue(Exit.isFailure(refused));
        assert.include(
          Cause.pretty(Exit.isFailure(refused) ? refused.cause : Cause.empty),
          "db reclaim",
        );
        // A lock whose reclaim no longer runs is ignored.
        yield* fs.writeFileString(
          `${dbPath}.reclaim-lock`,
          JSON.stringify({ pid: process.pid, startedAt: "2000-01-01T00:00:00.000Z" }),
        );
        assert.isTrue(Exit.isSuccess(yield* open));
      }),
    ),
  );

  it.effect.skipIf(windowsHost)("refuses while another process has the database open", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { dbPath, options } = yield* makeHome;
        const before = sequences(dbPath);
        const other = new NodeSqlite.DatabaseSync(dbPath);
        try {
          other.exec("PRAGMA journal_mode = WAL");
          other.prepare("SELECT COUNT(*) FROM orchestration_events").get();
          const error = yield* Effect.flip(DatabaseReclaim.reclaim(options));
          assert.equal(reasonOf(error), "in-use");
        } finally {
          other.close();
        }
        assert.deepEqual(sequences(dbPath).all, before.all);
      }),
    ),
  );

  it.effect.skipIf(windowsHost)("refuses while an update is in progress", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fs, path, home, dbPath, options } = yield* makeHome;
        const before = sequences(dbPath);
        const updates = path.join(home, "updates");
        yield* fs.makeDirectory(updates, { recursive: true });
        yield* fs.writeFileString(
          path.join(updates, "state.json"),
          JSON.stringify({ status: "installing" }),
        );
        const error = yield* Effect.flip(DatabaseReclaim.reclaim(options));
        assert.equal(reasonOf(error), "update-in-progress");
        assert.deepEqual(sequences(dbPath).all, before.all);

        // An update helper's snapshot, with no agent status at all (remote_update.py).
        yield* fs.writeFileString(path.join(updates, "state.json"), JSON.stringify({}));
        yield* fs.writeFileString(
          path.join(updates, "database-snapshot.json"),
          JSON.stringify({ at: DateTime.formatIso(yield* DateTime.now), pid: 1 }),
        );
        const snapshot = yield* Effect.flip(DatabaseReclaim.reclaim(options));
        assert.equal(reasonOf(snapshot), "update-in-progress");
        assert.include(String(snapshot.message), "update-snapshot");
        assert.deepEqual(sequences(dbPath).all, before.all);
      }),
    ),
  );
});
