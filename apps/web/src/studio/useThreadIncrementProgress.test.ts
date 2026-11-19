import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { makeProgressRefreshGate } from "./useThreadIncrementProgress";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const gateWithCount = () => {
  const refresh = vi.fn();
  return { gate: makeProgressRefreshGate({ refresh, periodMs: 15_000 }), refresh };
};

describe("makeProgressRefreshGate", () => {
  it("folds ten thread moves within the period into one trailing refresh", () => {
    const { gate, refresh } = gateWithCount();
    for (let move = 0; move < 10; move += 1) {
      vi.advanceTimersByTime(1_000);
      gate.activity();
    }
    expect(refresh).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes right away when the last refresh is older than the period", () => {
    const { gate, refresh } = gateWithCount();
    vi.advanceTimersByTime(20_000);
    gate.activity();
    expect(refresh).toHaveBeenCalledTimes(1);
    gate.activity();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("never refreshes while a read is in flight, and runs the owed refresh once it settles", () => {
    const { gate, refresh } = gateWithCount();
    gate.setPending(true);
    gate.activity();
    gate.linkChanged();
    vi.advanceTimersByTime(60_000);
    gate.tick();
    expect(refresh).not.toHaveBeenCalled();

    gate.setPending(false);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes a hand-made link change without waiting for the period", () => {
    const { gate, refresh } = gateWithCount();
    gate.linkChanged();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("lets the slow timer cover a move it follows", () => {
    const { gate, refresh } = gateWithCount();
    vi.advanceTimersByTime(14_000);
    gate.activity();
    gate.tick();
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("waits longer between timed reads after a slow read, then recovers", () => {
    const { gate, refresh } = gateWithCount();
    gate.setPending(true);
    vi.advanceTimersByTime(20_000);
    gate.setPending(false);

    // A 20s read stretches the period to 80s from the last refresh (at mount).
    for (let elapsed = 20_000; elapsed < 65_000; elapsed += 15_000) {
      vi.advanceTimersByTime(15_000);
      gate.tick();
    }
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(15_000);
    gate.tick();
    expect(refresh).toHaveBeenCalledTimes(1);

    // A fast read brings back the usual period.
    gate.setPending(true);
    vi.advanceTimersByTime(200);
    gate.setPending(false);
    vi.advanceTimersByTime(15_000);
    gate.tick();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("still refreshes a hand-made link change at once after a slow read", () => {
    const { gate, refresh } = gateWithCount();
    gate.setPending(true);
    vi.advanceTimersByTime(30_000);
    gate.setPending(false);
    gate.linkChanged();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("drops a scheduled refresh when disposed", () => {
    const { gate, refresh } = gateWithCount();
    gate.activity();
    gate.dispose();
    vi.advanceTimersByTime(60_000);
    expect(refresh).not.toHaveBeenCalled();
  });
});
