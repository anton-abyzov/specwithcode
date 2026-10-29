// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native disk reads independently verify atomic persistence and permissions.
import * as NodeFS from "node:fs";
import { nodePath as NodePath } from "../nodePath.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as CoordinatorStandbyStore from "./CoordinatorStandbyStore.ts";
import {
  PLANNED_PAUSE_MAX_MS,
  STANDBY_TICK_MS,
  applyLease,
  clockJumped,
  makeStandbyWatch,
  restartWatch,
  shouldTakeOver,
  type CoordinatorLeaseInput,
  type StandbyDecision,
} from "./CoordinatorStandbyWatch.ts";

const MINUTE = 60_000;
const T0 = Date.parse("2026-10-26T14:00:00.000Z");
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const reasonOf = (decision: StandbyDecision) => (decision.fire ? "fire" : decision.reason);

const record = (
  overrides: Partial<CoordinatorStandbyStore.CoordinatorStandbyRecord> = {},
): CoordinatorStandbyStore.CoordinatorStandbyRecord => ({
  logicalProjectId: "logical:easychamp",
  projectId: "easychamp-m1",
  coordinator: {
    environmentId: "m4" as never,
    projectId: "easychamp-m4" as never,
    coordinatorThreadId: "project-coordinator:easychamp-m4" as never,
  },
  epoch: 4,
  afterMinutes: 15,
  acceptedAt: iso(T0),
  lastLeaseAt: null,
  lastSeq: null,
  watchingSince: iso(T0),
  leaseSinceWatching: false,
  pausedUntil: null,
  coordinatorSleptAt: null,
  standbySleeping: false,
  armedFor: [],
  runningThreads: [],
  shadowWorkers: [],
  lastRefusal: null,
  updatedAt: iso(T0),
  ...overrides,
});

const lease = (overrides: Partial<CoordinatorLeaseInput> = {}): CoordinatorLeaseInput => ({
  callerEnvironmentId: "m4",
  epoch: 4,
  seq: 1,
  runningThreads: [],
  workers: [],
  ...overrides,
});

const accept = (
  current: CoordinatorStandbyStore.CoordinatorStandbyRecord,
  input: CoordinatorLeaseInput,
  atMs: number,
) => {
  const verdict = applyLease(current, input, atMs);
  if (!verdict.accepted) throw new Error(`lease refused: ${verdict.reason}`);
  return verdict.record;
};

describe("shouldTakeOver", () => {
  const heard = accept(record(), lease(), T0 + MINUTE);

  it("never fires before afterMinutes of silence", () => {
    for (const afterMinutes of [5, 15, 30, 60] as const) {
      const armed = { ...heard, afterMinutes };
      const due = T0 + MINUTE + afterMinutes * MINUTE;
      expect(shouldTakeOver(armed, due - 1)).toEqual({
        fire: false,
        reason: "waiting",
        takeOverAtMs: due,
      });
      expect(shouldTakeOver(armed, due)).toEqual({ fire: true, takeOverAtMs: due });
    }
  });

  it("starts the window again on every accepted lease", () => {
    // A flap: one lease mid-window means no takeover at the original time.
    const again = accept(heard, lease({ seq: 2 }), T0 + 10 * MINUTE);
    expect(shouldTakeOver(again, T0 + 16 * MINUTE).fire).toBe(false);
    expect(shouldTakeOver(again, T0 + 25 * MINUTE).fire).toBe(true);
  });

  it("does not fire without a lease since the watch began", () => {
    expect(shouldTakeOver(record(), T0 + 10 * 60 * MINUTE)).toEqual({
      fire: false,
      reason: "no-lease-while-watching",
      takeOverAtMs: null,
    });
    // A lease heard before the current watch does not count.
    const stale = restartWatch(heard, T0 + 2 * MINUTE);
    expect(reasonOf(shouldTakeOver(stale, T0 + 60 * MINUTE))).toBe("no-lease-while-watching");
  });

  it("starts again after a restart, and needs a new lease to fire", () => {
    const restarted = restartWatch(heard, T0 + 5 * MINUTE);
    expect(shouldTakeOver(restarted, T0 + 60 * MINUTE).fire).toBe(false);
    const after = accept(restarted, lease({ seq: 2 }), T0 + 6 * MINUTE);
    expect(shouldTakeOver(after, T0 + 21 * MINUTE).fire).toBe(true);
  });

  it("does not fire while unarmed on any worker machine", () => {
    const armedFor = [
      { environmentId: "m3", armed: true, checkedAt: iso(T0), error: null },
      { environmentId: "m2", armed: false, checkedAt: iso(T0), error: "M2 is unreachable." },
    ];
    expect(shouldTakeOver({ ...heard, armedFor }, T0 + 60 * MINUTE)).toEqual({
      fire: false,
      reason: "not-armed",
      takeOverAtMs: null,
    });
    const allArmed = armedFor.map((entry) => ({ ...entry, armed: true, error: null }));
    expect(shouldTakeOver({ ...heard, armedFor: allArmed }, T0 + 60 * MINUTE).fire).toBe(true);
  });

  it("does not fire while this machine is about to sleep", () => {
    expect(reasonOf(shouldTakeOver({ ...heard, standbySleeping: true }, T0 + 60 * MINUTE))).toBe(
      "standby-sleeping",
    );
  });

  it("waits out a planned pause and counts the silence from its end", () => {
    const paused = accept(
      heard,
      lease({ seq: 2, pausedUntil: iso(T0 + 12 * MINUTE) }),
      T0 + 2 * MINUTE,
    );
    expect(reasonOf(shouldTakeOver(paused, T0 + 11 * MINUTE))).toBe("paused");
    expect(shouldTakeOver(paused, T0 + 26 * MINUTE).fire).toBe(false);
    expect(shouldTakeOver(paused, T0 + 27 * MINUTE)).toEqual({
      fire: true,
      takeOverAtMs: T0 + 27 * MINUTE,
    });
  });
});

describe("applyLease", () => {
  it("accepts only the registered coordinator at the registered epoch with a higher seq", () => {
    const first = applyLease(record(), lease({ seq: 7 }), T0);
    expect(first.accepted).toBe(true);
    const heard = accept(record(), lease({ seq: 7 }), T0);
    expect(heard.lastSeq).toBe(7);
    expect(applyLease(heard, lease({ seq: 8, callerEnvironmentId: "m3" }), T0)).toEqual({
      accepted: false,
      reason: "not-registered-coordinator",
    });
    expect(applyLease(heard, lease({ seq: 8, epoch: 5 }), T0)).toEqual({
      accepted: false,
      reason: "wrong-epoch",
    });
    expect(applyLease(heard, lease({ seq: 8, epoch: 3 }), T0)).toEqual({
      accepted: false,
      reason: "wrong-epoch",
    });
    for (const seq of [7, 6, 0])
      expect(applyLease(heard, lease({ seq }), T0)).toEqual({
        accepted: false,
        reason: "stale-seq",
      });
  });

  it("records its own receive time, never the sender's", () => {
    const heard = accept(record(), lease(), T0 + 3 * MINUTE);
    expect(heard.lastLeaseAt).toBe(iso(T0 + 3 * MINUTE));
    expect(heard.afterMinutes).toBe(15);
  });

  it("caps a planned pause at 30 minutes and ignores one already over", () => {
    const long = accept(record(), lease({ pausedUntil: iso(T0 + 5 * 60 * MINUTE) }), T0);
    expect(long.pausedUntil).toBe(iso(T0 + PLANNED_PAUSE_MAX_MS));
    const past = accept(record(), lease({ pausedUntil: iso(T0 - MINUTE) }), T0);
    expect(past.pausedUntil).toBeNull();
    // The next ordinary lease ends the pause.
    expect(accept(long, lease({ seq: 2 }), T0 + MINUTE).pausedUntil).toBeNull();
  });

  it("counts a sleep notice as a lease, so the window runs from that moment", () => {
    const asleep = accept(record(), lease({ sleeping: true }), T0 + 2 * MINUTE);
    expect(asleep.coordinatorSleptAt).toBe(iso(T0 + 2 * MINUTE));
    expect(shouldTakeOver(asleep, T0 + 17 * MINUTE).fire).toBe(true);
  });

  it("keeps the last 50 delivered run ids of each worker", () => {
    const worker = {
      id: "rwt:1",
      callerThreadId: "project-coordinator:easychamp-m4",
      machineId: "m3",
      environmentId: "m3",
      remoteProjectId: "easychamp-m3",
      remoteThreadId: "thread-on-m3",
      title: "Fix the flaky test",
      state: "following" as const,
      followedRunId: "run-60",
      deliveredRunIds: Array.from({ length: 60 }, (_, i) => `run-${i}`),
    };
    const heard = accept(record(), lease({ workers: [worker] }), T0);
    expect(heard.shadowWorkers[0]!.deliveredRunIds).toHaveLength(50);
    expect(heard.shadowWorkers[0]!.deliveredRunIds[0]).toBe("run-10");
  });
});

describe("clockJumped", () => {
  const start = { wallMs: T0, monoMs: 1_000 };

  it("trusts ordinary ticks, including some scheduling delay", () => {
    expect(
      clockJumped(start, { wallMs: T0 + STANDBY_TICK_MS, monoMs: 1_000 + STANDBY_TICK_MS }),
    ).toBe(false);
    expect(
      clockJumped(start, { wallMs: T0 + 2 * STANDBY_TICK_MS, monoMs: 1_000 + 2 * STANDBY_TICK_MS }),
    ).toBe(false);
  });

  it("flags a sleep, where the wall clock ran on and the monotonic clock stopped", () => {
    expect(clockJumped(start, { wallMs: T0 + 60 * MINUTE, monoMs: 1_000 + STANDBY_TICK_MS })).toBe(
      true,
    );
  });

  it("flags a forward step over two ticks and any step backwards", () => {
    expect(
      clockJumped(start, {
        wallMs: T0 + STANDBY_TICK_MS + 2 * STANDBY_TICK_MS + 1,
        monoMs: 1_000 + STANDBY_TICK_MS,
      }),
    ).toBe(true);
    expect(clockJumped(start, { wallMs: T0 - 1, monoMs: 1_000 + STANDBY_TICK_MS })).toBe(true);
  });
});

const storeLayer = CoordinatorStandbyStore.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "studio-standby-" })),
  Layer.provideMerge(NodeServices.layer),
);

describe("CoordinatorStandbyStore", () => {
  it.effect("persists records privately, and removes one on disarm", () =>
    Effect.gen(function* () {
      const store = yield* CoordinatorStandbyStore.CoordinatorStandbyStore;
      expect(yield* store.list).toEqual([]);
      yield* store.modify("logical:easychamp", () => record());
      const config = yield* ServerConfig.ServerConfig;
      const file = NodePath.join(config.stateDir, "coordinator-standby.json");
      if (process.platform !== "win32") expect(NodeFS.statSync(file).mode & 0o777).toBe(0o600);
      expect(JSON.parse(NodeFS.readFileSync(file, "utf8")).version).toBe(1);
      expect((yield* store.get("logical:easychamp"))?.epoch).toBe(4);
      yield* store.modify("logical:easychamp", () => null);
      expect(yield* store.list).toEqual([]);
    }).pipe(Effect.provide(storeLayer)),
  );
});

describe("makeStandbyWatch", () => {
  it.effect("starts every watch again at process start and after a sleep", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0 + 5 * MINUTE);
      const store = yield* CoordinatorStandbyStore.CoordinatorStandbyStore;
      // A lease was heard before this process started.
      yield* store.modify("logical:easychamp", () => accept(record(), lease(), T0 + 4 * MINUTE));
      let mono = 0;
      const watch = yield* makeStandbyWatch({ nowMs: () => mono });
      expect((yield* store.get("logical:easychamp"))?.watchingSince).toBe(iso(T0 + 5 * MINUTE));

      // Long silence, but nothing was heard in this process, so nothing fires.
      for (let i = 0; i < 60; i += 1) {
        mono += STANDBY_TICK_MS;
        yield* TestClock.adjust(STANDBY_TICK_MS);
        const tick = yield* watch.tick;
        expect(tick).toEqual({ restarted: false, due: [] });
      }

      // A fresh lease, then steady silence for 15 minutes, fires.
      yield* store.modify("logical:easychamp", (current) =>
        current ? accept(current, lease({ seq: 2 }), T0 + 35 * MINUTE) : undefined,
      );
      for (let i = 0; i < 29; i += 1) {
        mono += STANDBY_TICK_MS;
        yield* TestClock.adjust(STANDBY_TICK_MS);
        expect((yield* watch.tick).due).toEqual([]);
      }
      mono += STANDBY_TICK_MS;
      yield* TestClock.adjust(STANDBY_TICK_MS);
      expect((yield* watch.tick).due.map((due) => due.logicalProjectId)).toEqual([
        "logical:easychamp",
      ]);

      // This machine slept for an hour: the wall clock ran on, the monotonic clock did not.
      yield* store.modify("logical:easychamp", (current) =>
        current ? accept(current, lease({ seq: 3 }), T0 + 51 * MINUTE) : undefined,
      );
      mono += STANDBY_TICK_MS;
      yield* TestClock.adjust(60 * MINUTE);
      const woke = yield* watch.tick;
      expect(woke).toEqual({ restarted: true, due: [] });
      expect((yield* store.get("logical:easychamp"))?.watchingSince).toBe(
        iso(T0 + 50 * MINUTE + 60 * MINUTE),
      );
    }).pipe(Effect.provide(storeLayer)),
  );

  it.effect("starts the watch again when the wall clock steps backwards", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0 + 30 * MINUTE);
      const store = yield* CoordinatorStandbyStore.CoordinatorStandbyStore;
      let mono = 0;
      const watch = yield* makeStandbyWatch({ nowMs: () => mono });
      yield* store.modify("logical:easychamp", () =>
        accept(restartWatch(record(), T0 + 30 * MINUTE), lease(), T0 + 30 * MINUTE),
      );
      mono += STANDBY_TICK_MS;
      yield* TestClock.setTime(T0 + 20 * MINUTE);
      expect((yield* watch.tick).restarted).toBe(true);
      // The lease heard before the step does not count in the new watch.
      expect((yield* store.get("logical:easychamp"))?.watchingSince).toBe(iso(T0 + 20 * MINUTE));
      const current = yield* store.get("logical:easychamp");
      expect(reasonOf(shouldTakeOver(current!, T0 + 120 * MINUTE))).toBe("no-lease-while-watching");
    }).pipe(Effect.provide(storeLayer)),
  );
});
