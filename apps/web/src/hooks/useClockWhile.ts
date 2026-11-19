import { useCallback, useState, useSyncExternalStore } from "react";

interface Clock {
  readonly read: () => number;
  readonly start: (intervalMs: number, notify: () => void) => () => void;
}

function makeClock(): Clock {
  let now = Date.now();
  return {
    read: () => now,
    start: (intervalMs, notify) => {
      const tick = () => {
        now = Date.now();
        notify();
      };
      // The time kept from an earlier period is stale: start from the present.
      tick();
      const timer = setInterval(tick, intervalMs);
      return () => clearInterval(timer);
    },
  };
}

const idle = () => () => {};

/**
 * The current time, refreshed on an interval while `active`. For labels that
 * age ("last seen 5m ago") when nothing else re-renders them: a value read from
 * `Date.now()` inside a memo only moves when one of the memo's inputs does.
 * No timer runs while `active` is false.
 */
export function useClockWhile(active: boolean, intervalMs = 30_000): number {
  const [clock] = useState(makeClock);
  const subscribe = useCallback(
    (notify: () => void) => (active ? clock.start(intervalMs, notify) : idle()),
    [active, clock, intervalMs],
  );
  return useSyncExternalStore(subscribe, clock.read, clock.read);
}
