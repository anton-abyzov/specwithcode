import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EventId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the helper's file must appear between the gate check and the delete, with no yield.
import * as NodeFS from "node:fs";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServiceUpdateHold from "../serviceUpdate/ServiceUpdateHold.ts";
import * as SqlitePersistence from "./Sqlite.ts";
import * as StorageMaintenance from "./StorageMaintenance.ts";

const layerStores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const layerTest = Layer.mergeAll(
  layerStores,
  EventSink.layer.pipe(Layer.provide(layerStores)),
  ProjectionMaintenance.layer.pipe(Layer.provide(layerStores)),
  NodeServices.layer,
);

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

let serial = 0;
/** A thread visited `visits` times: every visit but the newest is superseded. */
const writeVisitedThread = (threadId: ThreadId, visits: number) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const events: Array<OrchestrationV2DomainEvent> = [
      {
        id: EventId.make(`event:storage-maintenance:${(serial += 1)}`),
        type: "thread.created",
        threadId,
        providerInstanceId,
        occurredAt: now,
        payload: thread(threadId, now),
      },
    ];
    for (let visit = 0; visit < visits; visit += 1) {
      events.push({
        id: EventId.make(`event:storage-maintenance:${(serial += 1)}`),
        type: "thread.visited",
        threadId,
        providerInstanceId,
        occurredAt: now,
        payload: { ...thread(threadId, now), lastVisitedAt: now },
      });
    }
    yield* sink.write({ events });
  });

const eventCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly count: number;
  }>`SELECT COUNT(*) AS count FROM orchestration_events`;
  return rows[0]?.count ?? 0;
});

/** A real update hold over a scratch updates folder, and the maintenance that reads it. */
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const updates = yield* fs.makeTempDirectoryScoped({ prefix: "storage-maintenance-" });
  const hold = yield* ServiceUpdateHold.makeWithOptions({
    agentStatePath: path.join(updates, "state.json"),
    bootMs: null,
    isAlive: () => false,
  });
  const statePath = path.join(updates, "userdata", StorageMaintenance.STATE_FILE);
  const snapshotMarkerPath = path.join(updates, StorageMaintenance.SNAPSHOT_MARKER_FILE);
  const service = yield* StorageMaintenance.make({
    statePath,
    snapshotMarkerPath,
    pagePause: Duration.zero,
  }).pipe(Effect.provideService(ServiceUpdateHold.ServiceUpdateHold, hold));
  return { fs, path, updates, hold, statePath, snapshotMarkerPath, service };
});

it.layer(layerTest)("storage maintenance", (it) => {
  it.effect("deletes nothing while the service is held for an update", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { hold, service, fs, statePath } = yield* setup;
        yield* writeVisitedThread(ThreadId.make("thread:storage-maintenance:held"), 20);
        const before = yield* eventCount;

        yield* hold.acquire({ reason: "install" });
        const held = yield* service.runNow();
        assert.equal(held.status, "skipped");
        assert.equal(held.blocker, "update-hold");
        assert.equal(yield* eventCount, before);
        assert.isFalse(yield* fs.exists(statePath));
        // A due check while held does not reclaim or compact either.
        assert.equal((yield* service.runIfDue).status, "skipped");
        assert.equal(yield* eventCount, before);

        yield* hold.release("test");
        const released = yield* service.runNow();
        assert.equal(released.status, "completed");
        assert.equal(released.mode, "full");
        assert.isAtLeast(released.compaction?.deletedEventCount ?? 0, 19);
        assert.equal(yield* eventCount, before - (released.compaction?.deletedEventCount ?? 0));
        assert.isTrue(yield* fs.exists(statePath));
      }),
    ),
  );

  it.effect("deletes nothing while an install request is open, held or not", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { service, fs, path, updates } = yield* setup;
        yield* writeVisitedThread(ThreadId.make("thread:storage-maintenance:request"), 5);
        const before = yield* eventCount;
        const now = yield* Clock.currentTimeMillis;
        yield* fs.writeFileString(
          path.join(updates, "state.json"),
          JSON.stringify({ status: "downloaded" }),
        );
        yield* fs.writeFileString(
          path.join(updates, "config.json"),
          JSON.stringify({ installRequestedAt: DateTime.formatIso(DateTime.makeUnsafe(now)) }),
        );
        const run = yield* service.runNow();
        assert.equal(run.status, "skipped");
        assert.equal(run.blocker, "install-request");
        assert.equal(yield* eventCount, before);

        // An automatic install waiting for quiet snapshots the database too.
        yield* fs.writeFileString(path.join(updates, "config.json"), JSON.stringify({}));
        yield* fs.writeFileString(
          path.join(updates, "state.json"),
          JSON.stringify({ status: "waiting-for-quiet" }),
        );
        assert.equal((yield* service.runNow()).blocker, "install-underway");
        assert.equal(yield* eventCount, before);
      }),
    ),
  );

  it.effect("deletes nothing while an update helper's snapshot marker is live, held or not", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { service, fs, snapshotMarkerPath } = yield* setup;
        yield* writeVisitedThread(ThreadId.make("thread:storage-maintenance:snapshot"), 5);
        const before = yield* eventCount;
        // remote_update.py runs update.py --snapshot and then apply: no hold, request or status.
        const now = yield* Clock.currentTimeMillis;
        yield* fs.writeFileString(
          snapshotMarkerPath,
          JSON.stringify({ at: DateTime.formatIso(DateTime.makeUnsafe(now)), pid: 1 }),
        );
        const run = yield* service.runNow();
        assert.equal(run.status, "skipped");
        assert.equal(run.blocker, "update-snapshot");
        assert.equal(yield* eventCount, before);

        // A marker no apply removed lapses.
        yield* TestClock.adjust(Duration.millis(StorageMaintenance.SNAPSHOT_MARKER_MAX_MS));
        const lapsed = yield* service.runNow();
        assert.equal(lapsed.status, "completed");
        assert.isAtLeast(lapsed.compaction?.deletedEventCount ?? 0, 4);
      }),
    ),
  );

  it.effect("stops mid-pass when a hold begins", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { hold, statePath, fs } = yield* setup;
        const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
        yield* writeVisitedThread(ThreadId.make("thread:storage-maintenance:mid-pass"), 400);
        let deletes = 0;
        // The hold begins after the first delete; the gate reads it before the second.
        const service = yield* StorageMaintenance.make({
          statePath,
          pagePause: Duration.zero,
        }).pipe(
          Effect.provideService(ServiceUpdateHold.ServiceUpdateHold, hold),
          Effect.provideService(ProjectionMaintenance.ProjectionMaintenanceV2, {
            ...maintenance,
            compactEventStoreWith: (options) =>
              maintenance.compactEventStoreWith({
                ...options,
                pageSize: 50,
                shouldContinue: Effect.gen(function* () {
                  deletes += 1;
                  if (deletes === 2) {
                    yield* hold.acquire({ reason: "install" });
                    // Past the gate's cache, so this check reads the hold.
                    yield* TestClock.adjust(Duration.millis(StorageMaintenance.GATE_CACHE_MS));
                  }
                  return yield* options?.shouldContinue ?? Effect.succeed(true);
                }),
              }),
          }),
        );
        const run = yield* service.runNow();
        assert.equal(run.status, "interrupted");
        assert.equal(run.blocker, "update-hold");
        assert.equal(run.compaction?.deletedEventCount, 49);
        // An interrupted pass records nothing, so the next check runs it again.
        assert.isFalse(yield* fs.exists(statePath));
        yield* hold.release("test");
      }),
    ),
  );

  it.effect.each(["snapshot-marker", "install-gate"] as const)(
    "stops at the next delete when the %s appears inside the gate's cache",
    (helperFile) =>
      Effect.scoped(
        Effect.gen(function* () {
          const { path, updates, statePath, snapshotMarkerPath } = yield* setup;
          const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
          yield* writeVisitedThread(ThreadId.make(`thread:storage-maintenance:${helperFile}`), 400);
          const installGatePath = path.join(updates, "install-gate.json");
          let checks = 0;
          // No hold reads the gate here: only the synchronous check before each delete sees it.
          const service = yield* StorageMaintenance.make({
            statePath,
            snapshotMarkerPath,
            installGatePath,
            bootMs: null,
            isAlive: (pid) => pid === 4242,
            pagePause: Duration.zero,
          }).pipe(
            Effect.provideService(ProjectionMaintenance.ProjectionMaintenanceV2, {
              ...maintenance,
              compactEventStoreWith: (options) =>
                maintenance.compactEventStoreWith({
                  ...options,
                  pageSize: 50,
                  shouldContinue: Effect.gen(function* () {
                    const passes = yield* options?.shouldContinue ?? Effect.succeed(true);
                    checks += 1;
                    if (checks === 2) {
                      // The helper writes its file after the cached check passed.
                      const at = DateTime.formatIso(
                        DateTime.makeUnsafe(yield* Clock.currentTimeMillis),
                      );
                      NodeFS.writeFileSync(
                        helperFile === "snapshot-marker" ? snapshotMarkerPath : installGatePath,
                        JSON.stringify({ at, pid: 4242, helperPid: 4242 }),
                      );
                    }
                    return passes;
                  }),
                }),
            }),
          );
          const run = yield* service.runNow();
          assert.equal(run.status, "interrupted");
          assert.equal(
            run.blocker,
            helperFile === "snapshot-marker" ? "update-snapshot" : "update-hold",
          );
          assert.equal(run.compaction?.deletedEventCount, 49);
        }),
      ),
  );

  it.effect("persists the last pass: not due again, then incremental", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { service, fs, statePath } = yield* setup;
        yield* writeVisitedThread(ThreadId.make("thread:storage-maintenance:quiet"), 3);
        const first = yield* service.runNow();
        assert.equal(first.mode, "full");
        const recorded = JSON.parse(yield* fs.readFileString(statePath));
        assert.equal(recorded.throughSequence, first.compaction?.throughSequence);

        // A restart builds a new service over the same file: the pass is not due.
        const restarted = yield* StorageMaintenance.make({ statePath, pagePause: Duration.zero });
        assert.equal((yield* restarted.runIfDue).status, "not-due");

        yield* writeVisitedThread(ThreadId.make("thread:storage-maintenance:busy"), 4);
        const second = yield* service.runNow();
        assert.equal(second.mode, "incremental");
        assert.equal(second.compaction?.scannedStreamCount, 1);
        assert.equal(second.compaction?.deletedEventCount, 3);
      }),
    ),
  );
});

it.layer(NodeServices.layer)("storage maintenance reclaim", (it) => {
  it.effect(
    "returns free pages on an incremental database and reports what the free list lost",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({
            prefix: "storage-maintenance-reclaim-",
          });
          const dbPath = path.join(home, "statev2.sqlite");
          const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
            Layer.provideMerge(SqlitePersistence.layerFromPath(dbPath)),
          );
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`PRAGMA auto_vacuum = INCREMENTAL`;
            yield* sql`VACUUM`;
            yield* sql`CREATE TABLE scratch(id INTEGER PRIMARY KEY, body BLOB NOT NULL)`;
            yield* sql`INSERT INTO scratch(body) SELECT zeroblob(4096) FROM (WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 400) SELECT i FROM n)`;
            yield* sql`DROP TABLE scratch`;
            const free = Effect.map(
              sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`,
              (rows) => rows[0]?.freelist_count ?? 0,
            );
            const before = yield* free;
            // More than one incremental_vacuum step's worth.
            assert.isAbove(before, StorageMaintenance.RECLAIM_PAGES_PER_STEP * 2);
            const service = yield* StorageMaintenance.make({
              statePath: path.join(home, StorageMaintenance.STATE_FILE),
              pagePause: Duration.zero,
            });
            const run = yield* service.runNow();
            assert.equal(run.status, "completed");
            const after = yield* free;
            assert.equal(run.reclaimedPages, before - after);
            assert.equal(after, 0);
          }).pipe(
            Effect.provide(
              Layer.mergeAll(stores, ProjectionMaintenance.layer.pipe(Layer.provide(stores))),
            ),
          );
        }),
      ),
  );
});

it.effect("paces background work at ten percent duty and resets after resting", () =>
  Effect.gen(function* () {
    const pause = yield* StorageMaintenance.makeCompactionPacer;
    const start = yield* Clock.currentTimeMillis;
    yield* pause;
    assert.equal(yield* Clock.currentTimeMillis, start);
    yield* TestClock.adjust("30 millis");
    const fiber = yield* Effect.forkChild(pause);
    yield* Effect.yieldNow;
    yield* TestClock.adjust("269 millis");
    assert.isUndefined(fiber.pollUnsafe());
    yield* TestClock.adjust("1 millis");
    yield* Fiber.join(fiber);
    assert.equal(yield* Clock.currentTimeMillis, start + 300);
    yield* pause;
    assert.equal(yield* Clock.currentTimeMillis, start + 300);
  }),
);
