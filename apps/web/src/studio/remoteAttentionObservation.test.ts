import { describe, expect, it } from "vite-plus/test";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import type { StudioFleetSnapshot } from "@specweave-studio/contracts/studioFleet";
import {
  fleetRetainsWorkers,
  fleetWorkerCapability,
  remoteAttentionObservation,
} from "./remoteAttentionObservation";

const snapshot = (workers: boolean) =>
  ({ machines: workers ? [{ workers: {} }] : [] }) as unknown as StudioFleetSnapshot;
describe("attention polling coverage", () => {
  it("keeps known fleet capability and remote coverage through every background refresh", () => {
    for (const waiting of [false, true, false, true, false]) {
      expect(fleetWorkerCapability(AsyncResult.success(snapshot(false), { waiting }))).toBe(false);
      expect(fleetWorkerCapability(AsyncResult.success(snapshot(true), { waiting }))).toBe(true);
      expect(
        remoteAttentionObservation(true, AsyncResult.success({ workers: [] }, { waiting }))
          .complete,
      ).toBe(true);
    }
  });
  it("does not turn initial, disconnected, or failed retained data into all-clear", () => {
    expect(fleetWorkerCapability(AsyncResult.initial(true))).toBeNull();
    expect(fleetWorkerCapability(AsyncResult.success(null))).toBeNull();
    expect(fleetWorkerCapability(AsyncResult.fail("offline"))).toBeNull();
    expect(remoteAttentionObservation(null, AsyncResult.success({ workers: [] })).complete).toBe(
      false,
    );
    expect(remoteAttentionObservation(true, AsyncResult.initial(true)).complete).toBe(false);
    expect(remoteAttentionObservation(true, AsyncResult.success(null)).complete).toBe(false);
    const failed = AsyncResult.fail("offline", {
      previousSuccess: Option.some(AsyncResult.success({ workers: [] })),
    });
    expect(remoteAttentionObservation(true, failed).complete).toBe(false);
  });
  it("keeps asking for workers through a failed fleet poll that retains a snapshot", () => {
    const failed = AsyncResult.fail("offline", {
      previousSuccess: Option.some(AsyncResult.success(snapshot(true))),
    });
    expect(fleetRetainsWorkers(failed)).toBe(true);
    expect(fleetWorkerCapability(failed)).toBeNull();
    const retained = remoteAttentionObservation(
      fleetWorkerCapability(failed),
      AsyncResult.success({ workers: [{ id: "w" }] } as never),
    );
    expect(retained.workers).toHaveLength(1);
    expect(retained.complete).toBe(false);
    expect(fleetRetainsWorkers(AsyncResult.fail("offline"))).toBe(false);
    expect(fleetRetainsWorkers(AsyncResult.initial(true))).toBe(false);
    expect(fleetRetainsWorkers(AsyncResult.success(null))).toBe(false);
    expect(fleetRetainsWorkers(AsyncResult.success(snapshot(false), { waiting: true }))).toBe(
      false,
    );
  });
  it("does not rerun a worker dependency when fleet polling only changes transport state", () => {
    const registry = AtomRegistry.make();
    const fleet = Atom.make(AsyncResult.success(snapshot(true)));
    const capability = Atom.make((get) => fleetWorkerCapability(get(fleet)));
    let requests = 0;
    const workers = Atom.make((get) => {
      get(capability);
      return ++requests;
    });
    const unsubscribe = registry.subscribe(workers, () => {});
    try {
      registry.get(workers);
      for (const waiting of [true, false, true, false]) {
        registry.set(fleet, AsyncResult.success(snapshot(true), { waiting }));
        registry.get(workers);
      }
      expect(requests).toBe(1);
      registry.set(fleet, AsyncResult.success(snapshot(false)));
      registry.get(workers);
      expect(requests).toBe(2);
    } finally {
      unsubscribe();
      registry.dispose();
    }
  });
});
