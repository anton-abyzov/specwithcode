import { describe, expect, it } from "vite-plus/test";

import {
  fitWithin,
  makeFrameGrabber,
  makeLockWatch,
  pointerInFrame,
  type LockState,
} from "./screenCapture.logic.ts";

describe("frame size", () => {
  it("fits the longer side within the limit and never enlarges", () => {
    expect(fitWithin(3024, 1964, 1920)).toEqual({ width: 1920, height: 1247 });
    expect(fitWithin(1080, 1920, 1920)).toEqual({ width: 1080, height: 1920 });
    expect(fitWithin(1440, 3440, 1920)).toEqual({ width: 804, height: 1920 });
    expect(fitWithin(1280, 800, 1920)).toEqual({ width: 1280, height: 800 });
    expect(fitWithin(0, 0, 1920)).toEqual({ width: 0, height: 0 });
  });
});

describe("the pointer", () => {
  const second = { x: 1512, y: -200, width: 2560, height: 1440 };
  it("maps screen points to frame pixels on a second, larger display", () => {
    expect(pointerInFrame({ x: 1512, y: -200 }, second, { width: 1920, height: 1080 })).toEqual({
      x: 0,
      y: 0,
    });
    expect(pointerInFrame({ x: 2792, y: 520 }, second, { width: 1920, height: 1080 })).toEqual({
      x: 960,
      y: 540,
    });
  });
  it("is absent when the pointer is on another display", () => {
    expect(
      pointerInFrame({ x: 100, y: 100 }, second, { width: 1920, height: 1080 }),
    ).toBeUndefined();
    expect(
      pointerInFrame({ x: 4072, y: 0 }, second, { width: 1920, height: 1080 }),
    ).toBeUndefined();
  });
});

describe("lock state", () => {
  it("is locked when either the event or the question says so, and unknown on anything odd", () => {
    let answer = "active";
    const watch = makeLockWatch(() => answer);
    expect(watch.state()).toBe("unlocked");
    answer = "idle";
    expect(watch.state()).toBe("unlocked");
    answer = "locked";
    expect(watch.state()).toBe("locked");
    answer = "active";
    watch.onLock();
    expect(watch.state()).toBe("locked");
    watch.onUnlock();
    expect(watch.state()).toBe("unlocked");
    answer = "unknown";
    expect(watch.state()).toBe("unknown");
    const broken = makeLockWatch(() => {
      throw new Error("no session");
    });
    expect(broken.state()).toBe("unknown");
  });
});

describe("one look at a display", () => {
  const still = { jpeg: new Uint8Array([1, 2, 3]), width: 1920, height: 1200 };
  const grabber = (states: Array<LockState>, taken: { count: number }) =>
    makeFrameGrabber({
      lockState: () => states.shift() ?? "unlocked",
      still: () => {
        taken.count += 1;
        return Promise.resolve(still);
      },
      pointer: () => ({ x: 5, y: 6 }),
      digest: (jpeg) => `d${jpeg.length}`,
    });

  it("gives the picture, its size, the pointer and a digest", async () => {
    expect(await grabber(["unlocked", "unlocked"], { count: 0 })("1")).toEqual({
      kind: "frame",
      jpeg: still.jpeg,
      width: 1920,
      height: 1200,
      pointer: { x: 5, y: 6 },
      digest: "d3",
    });
  });

  it("takes no picture at all while locked or while the state is unknown", async () => {
    for (const state of ["locked", "unknown"] as const) {
      const taken = { count: 0 };
      expect(await grabber([state], taken)("1")).toEqual({ kind: "locked" });
      expect(taken.count).toBe(0);
    }
  });

  it("throws away a picture when the Mac locked while it was being taken", async () => {
    for (const after of ["locked", "unknown"] as const) {
      const taken = { count: 0 };
      expect(await grabber(["unlocked", after], taken)("1")).toEqual({ kind: "locked" });
      expect(taken.count).toBe(1);
    }
  });

  it("gives nothing when the capture fails or comes back empty", async () => {
    const failing = makeFrameGrabber({
      lockState: () => "unlocked",
      still: () => Promise.reject(new Error("no grant")),
      pointer: () => undefined,
      digest: () => "",
    });
    expect(await failing("1")).toEqual({ kind: "none" });
    const empty = makeFrameGrabber({
      lockState: () => "unlocked",
      still: () => Promise.resolve({ jpeg: new Uint8Array(0), width: 0, height: 0 }),
      pointer: () => undefined,
      digest: () => "",
    });
    expect(await empty("1")).toEqual({ kind: "none" });
  });
});
