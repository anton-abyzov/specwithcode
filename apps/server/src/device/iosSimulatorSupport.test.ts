import { describe, expect, it } from "vite-plus/test";

import {
  IOS_SIMULATOR_RECHECK_MS,
  UNKNOWN_RECHECK_MS,
  makeIosSimulatorProbe,
} from "./iosSimulatorSupport.ts";

const deferred = () => {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((done) => (resolve = done));
  return { promise, resolve };
};

/** Lets a finished check's callbacks run. */
const settled = async () => {
  for (let tick = 0; tick < 5; tick++) await Promise.resolve();
};

describe("makeIosSimulatorProbe", () => {
  it("is unknown while the one check runs, then keeps a yes", async () => {
    const pending = deferred();
    let checks = 0;
    let now = 0;
    const probe = makeIosSimulatorProbe({
      check: () => {
        checks++;
        return pending.promise;
      },
      now: () => now,
    });
    expect(probe.current()).toBeUndefined();
    expect(probe.current()).toBeUndefined();
    expect(checks).toBe(1);
    pending.resolve(true);
    await settled();
    now += IOS_SIMULATOR_RECHECK_MS * 10;
    expect(probe.current()).toBe(true);
    expect(checks).toBe(1);
  });

  it("checks a no again after a while, and a failed check is a no", async () => {
    let checks = 0;
    let now = 0;
    const probe = makeIosSimulatorProbe({
      check: () => {
        checks++;
        return checks === 1 ? Promise.reject(new Error("spawn failed")) : Promise.resolve(true);
      },
      now: () => now,
    });
    probe.current();
    await settled();
    expect(probe.current()).toBe(false);
    expect(checks).toBe(1);
    now += IOS_SIMULATOR_RECHECK_MS;
    expect(probe.current()).toBe(false);
    expect(checks).toBe(2);
    await settled();
    expect(probe.current()).toBe(true);
  });

  it("keeps a check that could not tell as unknown and checks it again soon", async () => {
    let checks = 0;
    let now = 0;
    const probe = makeIosSimulatorProbe({
      check: () => {
        checks++;
        return Promise.resolve(checks === 1 ? undefined : true);
      },
      now: () => now,
    });
    probe.current();
    await settled();
    expect(probe.current()).toBeUndefined();
    expect(checks).toBe(1);
    now += UNKNOWN_RECHECK_MS - 1;
    expect(probe.current()).toBeUndefined();
    expect(checks).toBe(1);
    now += 1;
    expect(probe.current()).toBeUndefined();
    expect(checks).toBe(2);
    await settled();
    expect(probe.current()).toBe(true);
    expect(UNKNOWN_RECHECK_MS).toBeLessThan(IOS_SIMULATOR_RECHECK_MS);
  });
});
