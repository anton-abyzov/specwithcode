import { assert, describe, it } from "vite-plus/test";

import * as WindowPlacement from "./windowPlacement.ts";

// M4's arrangement on October 25, 2026, in Electron coordinates.
const builtIn = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  workArea: { x: 0, y: 34, width: 1512, height: 898 },
};
const dell = {
  id: 2,
  bounds: { x: 1512, y: 0, width: 1920, height: 1080 },
  workArea: { x: 1512, y: 0, width: 1920, height: 1080 },
};
const studio = {
  id: 3,
  bounds: { x: -2048, y: -281, width: 2048, height: 1152 },
  workArea: { x: -2048, y: -281, width: 2048, height: 1152 },
};
const all = [builtIn, dell, studio];
const onDell = { x: 1683, y: 85, width: 1585, height: 898 };

describe("resolveWindowPlacement", () => {
  it("keeps bounds that fit their saved monitor exactly", () => {
    assert.deepEqual(
      WindowPlacement.resolveWindowPlacement(
        { bounds: onDell, display: { id: 2, bounds: dell.bounds }, fullScreen: false },
        all,
      ),
      { kind: "saved", bounds: onDell, savedDisplayMissing: false },
    );
  });

  it("pulls a window that hangs over an edge back onto its monitor", () => {
    const overhanging = { x: -8, y: 81, width: 1512, height: 896 };
    const placement = WindowPlacement.resolveWindowPlacement(
      { bounds: overhanging, display: null, fullScreen: false },
      all,
    );
    assert.equal(placement.kind, "adjusted");
    assert.deepEqual(placement.kind === "default" ? null : placement.bounds, {
      x: 0,
      y: 36,
      width: 1512,
      height: 896,
    });
  });

  it("follows the saved monitor when the arrangement moved it", () => {
    const movedDell = {
      ...dell,
      bounds: { ...dell.bounds, x: 1512, y: -200 },
      workArea: { ...dell.workArea, x: 1512, y: -200 },
    };
    const placement = WindowPlacement.resolveWindowPlacement(
      { bounds: onDell, display: { id: 2, bounds: dell.bounds }, fullScreen: false },
      [builtIn, movedDell, studio],
    );
    assert.deepEqual(placement, {
      kind: "adjusted",
      bounds: { ...onDell, y: onDell.y - 200 },
      savedDisplayMissing: false,
    });
  });

  it("brings full screen back on its monitor when the normal bounds are elsewhere", () => {
    const normalOnBuiltIn = { x: 0, y: 34, width: 1100, height: 780 };
    const placement = WindowPlacement.resolveWindowPlacement(
      { bounds: normalOnBuiltIn, display: { id: 3, bounds: studio.bounds }, fullScreen: true },
      all,
    );
    assert.equal(placement.kind, "adjusted");
    if (placement.kind === "default") return;
    assert.isTrue(WindowPlacement.windowFitsWithinDisplay(placement.bounds, studio.bounds));
    assert.equal(placement.bounds.width, 1100);
  });

  it("asks to wait for a saved monitor that is not connected yet", () => {
    assert.deepEqual(
      WindowPlacement.resolveWindowPlacement(
        { bounds: onDell, display: { id: 2, bounds: dell.bounds }, fullScreen: false },
        [builtIn],
      ),
      { kind: "default", savedDisplayMissing: true },
    );
  });

  it("keeps settings saved before the monitor was recorded working", () => {
    assert.deepEqual(
      WindowPlacement.resolveWindowPlacement(
        { bounds: onDell, display: null, fullScreen: false },
        all,
      ),
      { kind: "saved", bounds: onDell, savedDisplayMissing: false },
    );
    assert.deepEqual(
      WindowPlacement.resolveWindowPlacement({ bounds: onDell, display: null, fullScreen: false }, [
        builtIn,
      ]),
      { kind: "default", savedDisplayMissing: false },
    );
  });
});

describe("saved monitor matching", () => {
  it("does not trust a display id that now belongs to a monitor of another size", () => {
    const swapped = { ...dell, bounds: { ...dell.bounds, width: 2560, height: 1440 } };
    assert.deepEqual(
      WindowPlacement.resolveWindowPlacement(
        { bounds: onDell, display: { id: 2, bounds: dell.bounds }, fullScreen: false },
        [builtIn, swapped],
      ).savedDisplayMissing,
      true,
    );
  });

  it("finds a monitor whose id changed when its bounds are identical", () => {
    assert.deepEqual(
      WindowPlacement.resolveWindowPlacement(
        { bounds: onDell, display: { id: 99, bounds: dell.bounds }, fullScreen: false },
        all,
      ),
      { kind: "saved", bounds: onDell, savedDisplayMissing: false },
    );
  });
});

describe("displayForBounds", () => {
  it("picks the monitor showing most of the window", () => {
    const straddling = { x: 1300, y: 100, width: 1200, height: 800 };
    assert.equal(WindowPlacement.displayForBounds(straddling, all)?.id, 2);
    assert.isNull(
      WindowPlacement.displayForBounds({ x: 9000, y: 9000, width: 100, height: 100 }, all),
    );
  });
});
