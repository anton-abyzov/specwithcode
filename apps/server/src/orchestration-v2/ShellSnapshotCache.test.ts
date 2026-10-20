import { assert, it } from "@effect/vitest";
import type { OrchestrationV2ThreadShellSnapshot } from "@specweave-studio/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import * as ShellSnapshotCache from "./ShellSnapshotCache.ts";

const snapshotOf = (sequence: number) =>
  ({
    schemaVersion: 2,
    snapshotSequence: sequence,
    threads: [],
    archivedThreads: [],
  }) as unknown as OrchestrationV2ThreadShellSnapshot;

/** A read that counts itself and returns a new snapshot each time. */
const countingRead = () => {
  const calls: Array<ShellSnapshotCache.ShellSnapshotReadOptions> = [];
  const read = (options: ShellSnapshotCache.ShellSnapshotReadOptions) =>
    Effect.sync(() => {
      calls.push(options);
      return snapshotOf(calls.length);
    });
  return { calls, read };
};

const maxAgeMs = ShellSnapshotCache.SWEEP_SHELL_SNAPSHOT_MAX_AGE_MS;

it.effect("serves sweeps within the age from one read", () =>
  Effect.gen(function* () {
    const { calls, read } = countingRead();
    const cache = yield* ShellSnapshotCache.make(read);
    const first = yield* cache.get({ location: "active", maxAgeMs });
    yield* cache.invalidate;
    yield* TestClock.adjust(maxAgeMs - 1);
    const second = yield* cache.get({ location: "active", maxAgeMs });
    assert.strictEqual(second, first);
    assert.deepEqual(calls, [{ location: "active" }]);
  }),
);

it.effect("reads again once a write is older than the age", () =>
  Effect.gen(function* () {
    const { calls, read } = countingRead();
    const cache = yield* ShellSnapshotCache.make(read);
    yield* cache.get({ location: "active", maxAgeMs });
    yield* cache.invalidate;
    yield* TestClock.adjust(maxAgeMs);
    const next = yield* cache.get({ location: "active", maxAgeMs });
    assert.equal(next.snapshotSequence, 2);
    assert.equal(calls.length, 2);
  }),
);

it.effect("keeps reusing a snapshot no write has touched, up to the cap", () =>
  Effect.gen(function* () {
    const { calls, read } = countingRead();
    const cache = yield* ShellSnapshotCache.make(read);
    const first = yield* cache.get({ unsettledOnly: true, maxAgeMs });
    // A sweep every 30 seconds on an idle server: no scan after the first.
    for (let sweep = 0; sweep < 9; sweep += 1) {
      yield* TestClock.adjust("30 seconds");
      assert.strictEqual(yield* cache.get({ unsettledOnly: true, maxAgeMs }), first);
    }
    assert.equal(calls.length, 1);
    yield* TestClock.adjust(ShellSnapshotCache.UNCHANGED_SHELL_SNAPSHOT_MAX_AGE_MS);
    yield* cache.get({ unsettledOnly: true, maxAgeMs });
    assert.equal(calls.length, 2);
  }),
);

it.effect("keeps each location apart", () =>
  Effect.gen(function* () {
    const { calls, read } = countingRead();
    const cache = yield* ShellSnapshotCache.make(read);
    yield* cache.get({ location: "active", maxAgeMs });
    yield* cache.get({ unsettledOnly: true, maxAgeMs });
    yield* cache.get({ location: "archive", maxAgeMs });
    yield* cache.get({ location: "active", maxAgeMs });
    assert.deepEqual(calls, [{ location: "active" }, {}, { location: "archive" }]);
  }),
);

const shellOf = (
  id: string,
  fields: { readonly settledAt?: string | null; readonly settledOverride?: string | null } = {},
) => ({ id, settledAt: null, settledOverride: null, archivedAt: null, ...fields });

/** One active read holding open, settled, reopened and archived threads. */
const mixedRead = () => {
  const calls: Array<ShellSnapshotCache.ShellSnapshotReadOptions> = [];
  const read = (options: ShellSnapshotCache.ShellSnapshotReadOptions) =>
    Effect.sync(() => {
      calls.push(options);
      return {
        schemaVersion: 2,
        snapshotSequence: calls.length,
        threads: [
          shellOf("open"),
          shellOf("auto-settled", { settledAt: "2026-10-01T00:00:00Z" }),
          shellOf("manual-settled", { settledOverride: "settled" }),
          shellOf("reopened", { settledOverride: "active" }),
          // Reopened by hand but still stamped: the SQL filter skips it too.
          shellOf("reopened-stamped", {
            settledOverride: "active",
            settledAt: "2026-10-01T00:00:00Z",
          }),
        ],
        archivedThreads: [
          { ...shellOf("archived-open"), archivedAt: "2026-10-01T00:00:00Z" },
          {
            ...shellOf("archived-settled", { settledAt: "2026-10-01T00:00:00Z" }),
            archivedAt: "2026-10-01T00:00:00Z",
          },
        ],
      } as unknown as OrchestrationV2ThreadShellSnapshot;
    });
  return { calls, read };
};

it.effect("serves every sweep, unsettled or not, from one read within the age", () =>
  Effect.gen(function* () {
    const { calls, read } = mixedRead();
    const cache = yield* ShellSnapshotCache.make(read);
    // Idle compaction and the full-access sweep, then the pull request and
    // provider fallback sweeps, with writes landing in between.
    const every = yield* cache.get({ location: "active", maxAgeMs });
    yield* cache.invalidate;
    yield* TestClock.adjust("10 seconds");
    const unsettled = yield* cache.get({ location: "active", unsettledOnly: true, maxAgeMs });
    yield* cache.invalidate;
    yield* TestClock.adjust("10 seconds");
    const again = yield* cache.get({ location: "active", unsettledOnly: true, maxAgeMs });
    yield* cache.invalidate;
    yield* TestClock.adjust("9 seconds");
    assert.strictEqual(yield* cache.get({ location: "active", maxAgeMs }), every);
    assert.deepEqual(calls, [{ location: "active" }]);

    assert.deepEqual(
      every.threads.map((thread) => thread.id),
      ["open", "auto-settled", "manual-settled", "reopened", "reopened-stamped"],
    );
    assert.deepEqual(
      unsettled.threads.map((thread) => thread.id),
      ["open", "reopened"],
    );
    assert.deepEqual(
      unsettled.archivedThreads.map((thread) => thread.id),
      ["archived-open"],
    );
    assert.equal(unsettled.snapshotSequence, every.snapshotSequence);
    assert.strictEqual(again, unsettled);
  }),
);

it.effect("an exact unsettled read still asks the database for unsettled threads", () =>
  Effect.gen(function* () {
    const { calls, read } = mixedRead();
    const cache = yield* ShellSnapshotCache.make(read);
    yield* cache.get({ location: "active", unsettledOnly: true });
    assert.deepEqual(calls, [{ location: "active", unsettledOnly: true }]);
  }),
);

it.effect("always reads for a caller that names no age, and shares what it read", () =>
  Effect.gen(function* () {
    const { calls, read } = countingRead();
    const cache = yield* ShellSnapshotCache.make(read);
    yield* cache.get({ location: "active", maxAgeMs });
    const exact = yield* cache.get({ location: "active" });
    assert.equal(exact.snapshotSequence, 2);
    assert.strictEqual(yield* cache.get({ location: "active", maxAgeMs }), exact);
    assert.equal(calls.length, 2);
  }),
);

it.effect("lets concurrent sweeps wait on the read already running", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let reads = 0;
    const cache = yield* ShellSnapshotCache.make(() =>
      Effect.gen(function* () {
        reads += 1;
        yield* Deferred.succeed(started, undefined);
        yield* Deferred.await(release);
        return snapshotOf(reads);
      }),
    );
    const leader = yield* Effect.forkChild(cache.get({ unsettledOnly: true, maxAgeMs }));
    yield* Deferred.await(started);
    const followers = yield* Effect.forkChild(
      Effect.all(
        [1, 2, 3].map(() => cache.get({ unsettledOnly: true, maxAgeMs })),
        { concurrency: "unbounded" },
      ),
    );
    yield* Effect.yieldNow;
    yield* Deferred.succeed(release, undefined);
    const first = yield* Fiber.join(leader);
    const rest = yield* Fiber.join(followers);
    assert.equal(reads, 1);
    for (const snapshot of rest) assert.strictEqual(snapshot, first);
  }),
);

it.effect("a waiting sweep reads for itself when the running read is interrupted", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let reads = 0;
    const cache = yield* ShellSnapshotCache.make(() =>
      Effect.gen(function* () {
        reads += 1;
        if (reads === 1) {
          yield* Deferred.succeed(started, undefined);
          return yield* Effect.never;
        }
        return snapshotOf(reads);
      }),
    );
    const leader = yield* Effect.forkChild(cache.get({ location: "active", maxAgeMs }));
    yield* Deferred.await(started);
    const follower = yield* Effect.forkChild(cache.get({ location: "active", maxAgeMs }));
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(leader);
    const snapshot = yield* Fiber.join(follower);
    assert.equal(snapshot.snapshotSequence, 2);
    assert.equal(reads, 2);
  }),
);

it.effect("counts writes for sweeps that skip a repeat read", () =>
  Effect.gen(function* () {
    const { read } = countingRead();
    const cache = yield* ShellSnapshotCache.make(read);
    assert.equal(yield* cache.writeCount, 0);
    yield* cache.invalidate;
    yield* cache.invalidate;
    assert.equal(yield* cache.writeCount, 2);
  }),
);
