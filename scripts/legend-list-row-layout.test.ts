// @effect-diagnostics nodeBuiltinImport:off - exercises the installed patched web bundles.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";

// Layout measurements and browser animation-frame delivery are independent.
// A frame withheld by the host must not leave an already-grown row covering
// the next row's pointer targets.
function measuredList(bundle: string, lock: boolean, readerReset = false) {
  const source = NodeFS.readFileSync(
    new URL(`../apps/web/node_modules/@legendapp/list/${bundle}`, import.meta.url),
    "utf8",
  );
  const start = source.indexOf("function runOrScheduleMVCPRecalculate(");
  const end = source.indexOf("function updateOtherAxisSizeIfNeeded(", start);
  const frames = new Map<string, () => void>();
  const state = {
    mvcpAnchorLock: lock
      ? { id: "steer", position: 100, expiresAt: Number.MAX_SAFE_INTEGER }
      : undefined,
    userScrollAnchorReset: readerReset ? { keys: new Set<string>() } : undefined,
    scheduledWork: {
      cancel: (key: string) => frames.delete(key),
      has: (key: string) => frames.has(key),
      frame: (cb: () => void, key: string) => frames.set(key, cb),
    },
    positions: [0, 90, 180],
    measured: [220, 58, 36],
    scroll: 480,
  };
  const calculate = vi.fn((_ctx: unknown, options?: { doMVCP?: boolean }) => {
    state.positions = state.measured.map((_, index) =>
      state.measured.slice(0, index).reduce((a, b) => a + b, 0),
    );
    // The actual virtualizer owns the anchor policy. This regression exercises
    // its measurement dispatch without replacing it with an app scroll reset.
    expect(options?.doMVCP).toBe(readerReset ? undefined : true);
  });
  const run = NodeVM.runInNewContext(`${source.slice(start, end)};runOrScheduleMVCPRecalculate`, {
    calculateItemsInView: calculate,
  }) as (ctx: { state: typeof state }) => void;
  return { state, frames, calculate, measure: () => run({ state }) };
}

describe.each(["react.js", "react.mjs"])("web measured row placement (%s)", (bundle) => {
  it("places rows immediately while an MVCP anchor is held, without waiting for another frame", () => {
    const list = measuredList(bundle, true);
    list.measure();
    expect(list.state.positions).toEqual([0, 220, 278]);
    expect(list.frames.size).toBe(0);
    expect(list.state.scroll).toBe(480);
    expect(list.state.mvcpAnchorLock?.id).toBe("steer");
  });
  it("also applies a second measurement before any browser frame arrives", () => {
    const list = measuredList(bundle, true);
    list.measure();
    list.state.measured = [300, 120, 36];
    list.measure();
    expect(list.state.positions).toEqual([0, 300, 420]);
  });
  it("keeps the deliberate reader-scroll anchor-reset path", () => {
    const list = measuredList(bundle, true, true);
    list.measure();
    expect(list.state.positions).toEqual([0, 220, 278]);
    expect(list.state.userScrollAnchorReset).toBeUndefined();
  });
  it("keeps synchronous placement when there is no anchor lock", () => {
    const list = measuredList(bundle, false);
    list.measure();
    expect(list.state.positions).toEqual([0, 220, 278]);
  });
});

describe.each(["react.js", "react.mjs"])("web row measurement units (%s)", (bundle) => {
  it.each([0.8, 1, 1.5])("keeps fractional layout border-box units at visual scale %s", (scale) => {
    for (const box of ["border-box", "content-box", "hidden", "fallback"]) {
      const source = NodeFS.readFileSync(
        new URL(`../apps/web/node_modules/@legendapp/list/${bundle}`, import.meta.url),
        "utf8",
      );
      const start = source.indexOf("function measureContainersInLayoutEffect(");
      const end = source.indexOf("var typedForwardRef", start);
      const helperStart = source.indexOf("function measureWebBorderBox(");
      const helperEnd = helperStart < 0 ? -1 : source.indexOf("\n}", helperStart) + 2;
      const measure = vi.fn();
      const element = {
        offsetHeight: 149,
        offsetWidth: 390,
        getClientRects: () => (box === "hidden" ? [] : [{}]),
        getBoundingClientRect: () => ({
          height: box === "hidden" ? 0 : 149.375 * scale,
          width: box === "hidden" ? 0 : 390.25 * scale,
          left: 10,
          top: 20,
        }),
      };
      const style = {
        boxSizing: box,
        height: box === "content-box" ? "142.875px" : "149.375px",
        width: box === "content-box" ? "383.75px" : "390.25px",
        paddingTop: "2.25px",
        paddingBottom: "2.25px",
        paddingLeft: "2.25px",
        paddingRight: "2.25px",
        borderTopWidth: "1px",
        borderBottomWidth: "1px",
        borderLeftWidth: "1px",
        borderRightWidth: "1px",
      };
      const run = NodeVM.runInNewContext(
        `${helperStart < 0 ? "" : source.slice(helperStart, helperEnd)};${source.slice(start, end)};measureContainersInLayoutEffect`,
        {
          getComputedStyle: box === "fallback" ? undefined : () => style,
          peek$: () => "steer",
          setContainerLayoutBaseline: vi.fn(),
          updateItemSizesBatch: measure,
        },
      );
      run({ viewRefs: new Map([[0, { current: element }]]) });
      const expected =
        box === "hidden"
          ? { height: 0, width: 0 }
          : {
              height: 149.375 * (box === "fallback" ? scale : 1),
              width: 390.25 * (box === "fallback" ? scale : 1),
            };
      expect(measure).toHaveBeenCalledOnce();
      expect(measure.mock.calls[0]?.[1], box).toEqual([
        { containerId: 0, itemKey: "steer", size: expected },
      ]);
    }
  });
});
