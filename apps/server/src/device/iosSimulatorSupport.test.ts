import { describe, expect, it } from "vite-plus/test";

import {
  IOS_SIMULATOR_RECHECK_MS,
  type IosSimulatorSetup,
  UNKNOWN_RECHECK_MS,
  FORCED_REUSE_MS,
  iosSimulatorProbeFrom,
  isXcodeAppName,
  makeIosSimulatorProbe,
  makeIosSimulatorSetup,
  makeKeptCheck,
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

describe("makeKeptCheck", () => {
  const yesNo = (answers: Array<boolean>) => {
    let checks = 0;
    const kept = makeKeptCheck<boolean>({
      check: () => Promise.resolve(answers[checks++] ?? true),
      classify: (value) => (value ? "yes" : "no"),
      onFailure: false,
    });
    return { kept, checks: () => checks };
  };

  it("keeps a no for ordinary reads, and a forced read runs a fresh check", async () => {
    const { kept, checks } = yesNo([false, true]);
    expect(await kept.read()).toBe(false);
    expect(await kept.read()).toBe(false);
    expect(checks()).toBe(1);
    expect(await kept.read({ force: true })).toBe(true);
    expect(checks()).toBe(2);
    expect(kept.current()).toBe(true);
  });

  it("does not let a forced read join an ordinary check already running", async () => {
    let release!: (value: boolean) => void;
    let checks = 0;
    const kept = makeKeptCheck<boolean>({
      check: () => {
        checks++;
        return checks === 1
          ? new Promise<boolean>((done) => (release = done))
          : Promise.resolve(true);
      },
      classify: (value) => (value ? "yes" : "no"),
      onFailure: false,
    });
    expect(kept.current()).toBeUndefined();
    const forced = kept.read({ force: true });
    expect(checks).toBe(2);
    expect(await forced).toBe(true);
    // The older, slower run finishes later with a no and does not replace the fresh yes.
    release(false);
    await settled();
    expect(kept.current()).toBe(true);
  });

  it("shares one forced check between two forced reads", async () => {
    const { kept, checks } = yesNo([false]);
    const [first, second] = await Promise.all([
      kept.read({ force: true }),
      kept.read({ force: true }),
    ]);
    expect([first, second, checks()]).toEqual([false, false, 1]);
  });
});

describe("iosSimulatorProbeFrom", () => {
  const probeFor = (setup: IosSimulatorSetup) =>
    makeIosSimulatorSetup({ check: () => Promise.resolve(setup) });

  it("says yes once simctl answers, even before a simulator exists", async () => {
    const setup = probeFor({
      status: "ios_simulator_missing",
      xcodeAppPath: "/Applications/Xcode.app",
      simctlAnswered: true,
    });
    const probe = iosSimulatorProbeFrom(setup);
    expect(probe.current()).toBeUndefined();
    await settled();
    expect(probe.current()).toBe(true);
  });

  it("says no without a working Xcode and unknown when a tool timed out", async () => {
    const missing = iosSimulatorProbeFrom(
      probeFor({
        status: "xcode_not_selected",
        xcodeAppPath: "/Applications/Xcode.app",
        simctlAnswered: false,
      }),
    );
    const unknown = iosSimulatorProbeFrom(
      probeFor({ status: "unknown", xcodeAppPath: null, simctlAnswered: false }),
    );
    missing.current();
    unknown.current();
    await settled();
    expect(missing.current()).toBe(false);
    expect(unknown.current()).toBeUndefined();
  });
});

describe("forced reads and Xcode names", () => {
  it("reuses a forced answer for a few seconds, then checks again", async () => {
    let checks = 0;
    let now = 0;
    const kept = makeKeptCheck<boolean>({
      check: () => Promise.resolve(++checks > 1),
      classify: (value) => (value ? "yes" : "no"),
      onFailure: false,
      now: () => now,
    });
    expect(await kept.read({ force: true })).toBe(false);
    now += FORCED_REUSE_MS - 1;
    expect(await kept.read({ force: true })).toBe(false);
    expect(checks).toBe(1);
    now += 1;
    expect(await kept.read({ force: true })).toBe(true);
    expect(checks).toBe(2);
  });

  it("counts Xcode copies but not the Xcodes manager", () => {
    for (const name of [
      "Xcode.app",
      "Xcode-16.2.app",
      "Xcode-beta.app",
      "Xcode_16.app",
      "Xcode 16.app",
    ])
      expect(isXcodeAppName(name), name).toBe(true);
    for (const name of ["Xcodes.app", "XcodeClean.app", "Xcode.app.zip"])
      expect(isXcodeAppName(name), name).toBe(false);
  });
});
