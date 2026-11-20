import * as NodeVM from "node:vm";
import { describe, expect, it } from "vite-plus/test";

import {
  JXA_AX_ACTION_SCRIPT,
  JXA_INPUT_SCRIPT,
  JXA_WINDOWS_SCRIPT,
} from "./computerUseJxaScripts.ts";
import type { InputStep } from "./computerUseSteps.ts";

describe("JXA_INPUT_SCRIPT safety invariants", () => {
  it("never posts global Escape or unchecked global mouse-up when cancelling a drag", () => {
    expect(JXA_INPUT_SCRIPT).toContain("CGEventPostToPid(validStartPid, escDown)");
    expect(JXA_INPUT_SCRIPT).toContain("CGEventPostToPid(validStartPid, escUp)");
    expect(JXA_INPUT_SCRIPT).not.toContain("CGEventPost(0, escDown)");
    expect(JXA_INPUT_SCRIPT).not.toContain("CGEventPost(0, escUp)");
    expect(JXA_INPUT_SCRIPT).toContain("function isOriginStillSafe()");
    expect(JXA_INPUT_SCRIPT).toContain("$.CGEventPostToPid(validStartPid, release);");
  });

  it("latches pre-down source PID so replacement window never receives Escape or global mouse-up", () => {
    let originReplaced = false;
    let originChangedAfterEscape = false;
    const globalPosted: Array<{
      type?: number;
      keyCode?: number;
      down?: boolean;
      x?: number;
      y?: number;
    }> = [];
    const pidPosted: Array<{
      pid: number;
      type?: number;
      keyCode?: number;
      down?: boolean;
      x?: number;
      y?: number;
    }> = [];
    const ctx = NodeVM.createContext({
      ObjC: {
        import: () => undefined,
        bindFunction: () => undefined,
        deepUnwrap: (v: unknown) => v,
        castRefToObject: (v: unknown) => v,
      },
      $: {
        NSScreen: { screens: { isNil: () => false, count: 0 } },
        NSWorkspace: {
          sharedWorkspace: {
            get frontmostApplication() {
              return originReplaced
                ? {
                    isNil: () => false,
                    localizedName: { js: "SpecWithCode" },
                    processIdentifier: 300,
                  }
                : { isNil: () => false, localizedName: { js: "Notes" }, processIdentifier: 100 };
            },
          },
        },
        CGWindowListCopyWindowInfo: () => [
          ...(originReplaced || originChangedAfterEscape
            ? [
                {
                  kCGWindowOwnerName: "SpecWithCode",
                  kCGWindowOwnerPID: 300,
                  kCGWindowNumber: 999,
                  kCGWindowLayer: 0,
                  kCGWindowAlpha: 1,
                  kCGWindowBounds: { X: 0, Y: 0, Width: 500, Height: 500 },
                },
              ]
            : []),
          {
            kCGWindowOwnerName: "Notes",
            kCGWindowOwnerPID: 100,
            kCGWindowNumber: 42,
            kCGWindowLayer: 0,
            kCGWindowAlpha: 1,
            kCGWindowBounds: { X: 0, Y: 0, Width: 500, Height: 500 },
          },
        ],
        CGEventSourceSecondsSinceLastEventType: () => 1,
        CGEventCreateKeyboardEvent: (_: unknown, keyCode: number, down: boolean) => ({
          keyCode,
          down,
        }),
        CGEventCreateMouseEvent: (_: unknown, type: number, point: { x: number; y: number }) => ({
          type,
          x: point.x,
          y: point.y,
        }),
        CGEventSetIntegerValueField: () => undefined,
        CGEventSetFlags: () => undefined,
        CGEventPost: (
          _: number,
          event: { type?: number; keyCode?: number; down?: boolean; x?: number; y?: number },
        ) => {
          globalPosted.push({ ...event });
          if (event.type === 1) originReplaced = true;
        },
        CGEventPostToPid: (
          pid: number,
          event: { type?: number; keyCode?: number; down?: boolean; x?: number; y?: number },
        ) => {
          pidPosted.push({ pid, ...event });
          if (event.keyCode === 53 && event.down === false) originChangedAfterEscape = true;
        },
      },
      delay: () => undefined,
    });
    NodeVM.runInContext(JXA_INPUT_SCRIPT, ctx);
    const dragSteps: Array<InputStep> = [
      { type: "mouse", event: 5, button: 0, x: 100, y: 100, clickState: 0, flags: 0 },
      { type: "mouse", event: 1, button: 0, x: 100, y: 100, clickState: 1, flags: 0 },
      { type: "mouse", event: 6, button: 0, x: 300, y: 300, clickState: 0, flags: 0 },
      { type: "mouse", event: 2, button: 0, x: 300, y: 300, clickState: 1, flags: 0 },
    ];
    expect(() =>
      (ctx.run as (argv: Array<string>) => string)([
        JSON.stringify(dragSteps),
        JSON.stringify({
          forbidPid: 300,
          expectedPointOwner: { x: 100, y: 100, application: "Notes", windowId: 42 },
          expectedDropOwner: { x: 300, y: 300, application: "Notes", windowId: 42 },
        }),
      ]),
    ).toThrow(/(point|drag-path)-owner-changed:forbidden-pid:300/);
    expect(pidPosted.some((e) => e.pid === 300)).toBe(false);
    expect(pidPosted.every((e) => e.pid === 100)).toBe(true);
    expect(pidPosted.some((e) => e.type === 2)).toBe(true);
    expect(globalPosted.some((e) => e.type === 2 || e.keyCode === 53)).toBe(false);
  });

  it("releases a held key to its verified recipient PID instead of globally when focus changes", () => {
    let frontApp = { isNil: () => false, localizedName: { js: "Notes" }, processIdentifier: 100 };
    const globalPosted: Array<{ keyCode?: number; down?: boolean }> = [];
    const pidPosted: Array<{ pid: number; keyCode?: number; down?: boolean }> = [];
    const ctx = NodeVM.createContext({
      ObjC: { import: () => undefined, bindFunction: () => undefined },
      $: {
        NSWorkspace: {
          sharedWorkspace: {
            get frontmostApplication() {
              return frontApp;
            },
          },
        },
        CGEventSourceSecondsSinceLastEventType: () => 1,
        CGEventCreateKeyboardEvent: (_: unknown, keyCode: number, down: boolean) => ({
          keyCode,
          down,
        }),
        CGEventSetFlags: () => undefined,
        CGEventPost: (_: number, event: { keyCode?: number; down?: boolean }) => {
          globalPosted.push({ ...event });
          if (event.down === true) {
            frontApp = {
              isNil: () => false,
              localizedName: { js: "SpecWithCode" },
              processIdentifier: 300,
            };
          }
        },
        CGEventPostToPid: (pid: number, event: { keyCode?: number; down?: boolean }) => {
          pidPosted.push({ pid, ...event });
        },
      },
      delay: () => undefined,
    });
    NodeVM.runInContext(JXA_INPUT_SCRIPT, ctx);
    const keySteps: Array<InputStep> = [
      { type: "key", keyCode: 53, down: true, flags: 0 },
      { type: "key", keyCode: 53, down: false, flags: 0 },
    ];
    expect(() =>
      (ctx.run as (argv: Array<string>) => string)([
        JSON.stringify(keySteps),
        JSON.stringify({ expectedFrontmost: "Notes", forbidPid: 300 }),
      ]),
    ).toThrow(/forbidden-frontmost-pid: 300/);
    expect(globalPosted).toEqual([{ keyCode: 53, down: true }]);
    expect(pidPosted).toEqual([{ pid: 100, keyCode: 53, down: false }]);
  });

  it("refuses control characters in foreground unicodeText before posting any key event", () => {
    expect(JXA_INPUT_SCRIPT).toContain('stop("type-unsupported-control-chars")');
    expect(JXA_INPUT_SCRIPT).not.toContain("ch === 9 ? 48 : 36");
  });

  it("cancels mid-drag occlusion without posting global Escape and releases safely", () => {
    let dropOccluded = false;
    const dragPosted: Array<{
      type?: number;
      keyCode?: number;
      down?: boolean;
      x?: number;
      y?: number;
    }> = [];
    const pidPosted: Array<{ pid: number; keyCode?: number; down?: boolean }> = [];
    const ctx = NodeVM.createContext({
      ObjC: {
        import: () => undefined,
        bindFunction: () => undefined,
        deepUnwrap: (v: unknown) => v,
        castRefToObject: (v: unknown) => v,
      },
      $: {
        NSScreen: { screens: { isNil: () => false, count: 0 } },
        NSWorkspace: {
          sharedWorkspace: {
            frontmostApplication: {
              isNil: () => false,
              localizedName: { js: "Notes" },
              processIdentifier: 100,
            },
          },
        },
        CGWindowListCopyWindowInfo: () => [
          ...(dropOccluded
            ? [
                {
                  kCGWindowOwnerName: "Terminal",
                  kCGWindowOwnerPID: 200,
                  kCGWindowNumber: 99,
                  kCGWindowLayer: 0,
                  kCGWindowAlpha: 1,
                  kCGWindowBounds: { X: 250, Y: 250, Width: 200, Height: 200 },
                },
              ]
            : []),
          {
            kCGWindowOwnerName: "Notes",
            kCGWindowOwnerPID: 100,
            kCGWindowNumber: 42,
            kCGWindowLayer: 0,
            kCGWindowAlpha: 1,
            kCGWindowBounds: { X: 0, Y: 0, Width: 500, Height: 500 },
          },
        ],
        CGEventSourceSecondsSinceLastEventType: () => 1,
        CGEventCreateKeyboardEvent: (_: unknown, keyCode: number, down: boolean) => ({
          keyCode,
          down,
        }),
        CGEventCreateMouseEvent: (_: unknown, type: number, point: { x: number; y: number }) => ({
          type,
          x: point.x,
          y: point.y,
        }),
        CGEventSetIntegerValueField: () => undefined,
        CGEventSetFlags: () => undefined,
        CGEventPost: (
          _: number,
          event: { type?: number; keyCode?: number; down?: boolean; x?: number; y?: number },
        ) => {
          dragPosted.push({ ...event });
          if (event.type === 6) dropOccluded = true;
        },
        CGEventPostToPid: (pid: number, event: { keyCode?: number; down?: boolean }) => {
          pidPosted.push({ pid, ...event });
        },
      },
      delay: () => undefined,
    });
    NodeVM.runInContext(JXA_INPUT_SCRIPT, ctx);
    const dragSteps: Array<InputStep> = [
      { type: "mouse", event: 5, button: 0, x: 100, y: 100, clickState: 0, flags: 0 },
      { type: "mouse", event: 1, button: 0, x: 100, y: 100, clickState: 1, flags: 0 },
      { type: "mouse", event: 6, button: 0, x: 300, y: 300, clickState: 0, flags: 0 },
      { type: "mouse", event: 2, button: 0, x: 300, y: 300, clickState: 1, flags: 0 },
    ];
    expect(() =>
      (ctx.run as (argv: Array<string>) => string)([
        JSON.stringify(dragSteps),
        JSON.stringify({
          expectedPointOwner: { x: 100, y: 100, application: "Notes", windowId: 42 },
          expectedDropOwner: { x: 300, y: 300, application: "Notes", windowId: 42 },
        }),
      ]),
    ).toThrow(/drop-owner-changed:Terminal/);
    expect(dragPosted.some((e) => e.keyCode === 53)).toBe(false);
    expect(pidPosted.every((e) => e.pid === 100)).toBe(true);
    expect(dragPosted.at(-1)).toEqual({ type: 2, x: 100, y: 100 });
  });

  it("aborts window-relative HID input with window-moved when window bounds shift", () => {
    const posted: Array<unknown> = [];
    const ctx = NodeVM.createContext({
      ObjC: {
        import: () => undefined,
        bindFunction: () => undefined,
        deepUnwrap: (v: unknown) => v,
        castRefToObject: (v: unknown) => v,
        unwrap: (v: unknown) => v,
      },
      delay: () => undefined,
      $: Object.assign((s: string) => s, {
        NSWorkspace: {
          sharedWorkspace: {
            frontmostApplication: {
              isNil: () => false,
              bundleIdentifier: { isNil: () => false, js: "com.apple.Notes" },
              localizedName: { isNil: () => false, js: "Notes" },
              processIdentifier: 100,
            },
          },
        },
        NSScreen: { screens: { isNil: () => true } },
        CGWindowListCopyWindowInfo: () => [
          {
            kCGWindowOwnerName: "Notes",
            kCGWindowOwnerPID: 100,
            kCGWindowNumber: 42,
            kCGWindowLayer: 0,
            kCGWindowAlpha: 1,
            kCGWindowBounds: { X: 80, Y: 50, Width: 500, Height: 400 },
          },
        ],
        CGEventCreate: () => ({}),
        CGEventGetLocation: () => ({ x: 10, y: 10 }),
        CGEventCreateMouseEvent: (_s: unknown, type: number, pt: { x: number; y: number }) => ({
          type,
          x: pt.x,
          y: pt.y,
        }),
        CGEventSetIntegerValueField: () => undefined,
        CGEventSetFlags: () => undefined,
        CGEventPost: (_tap: number, ev: unknown) => {
          posted.push(ev);
        },
        CGEventSourceSecondsSinceLastEventType: () => 10,
      }),
    });
    NodeVM.runInContext(JXA_INPUT_SCRIPT, ctx);
    expect(() =>
      (ctx.run as (argv: Array<string>) => string)([
        JSON.stringify([
          { type: "mouse", event: 1, button: 0, x: 150, y: 150, clickState: 1, flags: 0 },
          { type: "mouse", event: 2, button: 0, x: 150, y: 150, clickState: 1, flags: 0 },
        ]),
        JSON.stringify({
          expectedPointOwner: {
            x: 150,
            y: 150,
            application: "Notes",
            windowId: 42,
            bounds: { x: 0, y: 0, width: 500, height: 400 },
          },
        }),
      ]),
    ).toThrow(/point-owner-changed:\s*window-moved/);
    expect(posted).toHaveLength(0);
  });

  it("tracks drag-back synthetic cursor so global mouse-up and cursor restoration succeed", () => {
    const posted: Array<{ type: number; x?: number; y?: number }> = [];
    const warped: Array<{ x: number; y: number }> = [];
    let cursor = { x: 33, y: 44 };
    let dropCovered = false;
    const ctx = NodeVM.createContext({
      ObjC: {
        import: () => undefined,
        bindFunction: () => undefined,
        deepUnwrap: (v: unknown) => v,
        castRefToObject: (v: unknown) => v,
        unwrap: (v: unknown) => v,
      },
      delay: () => undefined,
      $: Object.assign((s: string) => s, {
        NSWorkspace: {
          sharedWorkspace: {
            frontmostApplication: {
              isNil: () => false,
              bundleIdentifier: { isNil: () => false, js: "com.apple.Notes" },
              localizedName: { isNil: () => false, js: "Notes" },
              processIdentifier: 100,
            },
          },
        },
        NSScreen: { screens: { isNil: () => true } },
        CGWindowListCopyWindowInfo: () => [
          ...(dropCovered
            ? [
                {
                  kCGWindowOwnerName: "Terminal",
                  kCGWindowOwnerPID: 200,
                  kCGWindowNumber: 99,
                  kCGWindowLayer: 0,
                  kCGWindowAlpha: 1,
                  kCGWindowBounds: { X: 250, Y: 250, Width: 200, Height: 200 },
                },
              ]
            : []),
          {
            kCGWindowOwnerName: "Notes",
            kCGWindowOwnerPID: 100,
            kCGWindowNumber: 42,
            kCGWindowLayer: 0,
            kCGWindowAlpha: 1,
            kCGWindowBounds: { X: 0, Y: 0, Width: 500, Height: 500 },
          },
        ],
        CGEventCreate: () => ({}),
        CGEventGetLocation: () => cursor,
        CGEventCreateMouseEvent: (_s: unknown, type: number, pt: { x: number; y: number }) => ({
          type,
          x: pt.x,
          y: pt.y,
        }),
        CGEventCreateKeyboardEvent: (_s: unknown, keyCode: number, down: boolean) => ({
          type: 10,
          keyCode,
          down,
        }),
        CGEventSetIntegerValueField: () => undefined,
        CGEventSetFlags: () => undefined,
        CGEventPost: (_tap: number, ev: { type: number; x?: number; y?: number }) => {
          posted.push(ev);
          if (typeof ev.x === "number" && typeof ev.y === "number") {
            cursor = { x: ev.x, y: ev.y };
          }
          if (ev.type === 6 && ev.x === 300) {
            dropCovered = true;
          }
        },
        CGEventPostToPid: () => undefined,
        CGWarpMouseCursorPosition: (pt: { x: number; y: number }) => {
          warped.push({ x: pt.x, y: pt.y });
          cursor = { x: pt.x, y: pt.y };
        },
        CGEventSourceSecondsSinceLastEventType: () => 10,
      }),
    });
    NodeVM.runInContext(JXA_INPUT_SCRIPT, ctx);
    expect(() =>
      (ctx.run as (argv: Array<string>) => string)([
        JSON.stringify([
          { type: "mouse", event: 5, button: 0, x: 100, y: 100, clickState: 0, flags: 0 },
          { type: "mouse", event: 1, button: 0, x: 100, y: 100, clickState: 1, flags: 0 },
          { type: "mouse", event: 6, button: 0, x: 300, y: 300, clickState: 0, flags: 0 },
          { type: "mouse", event: 2, button: 0, x: 300, y: 300, clickState: 1, flags: 0 },
        ]),
        JSON.stringify({
          restoreCursor: true,
          expectedPointOwner: { x: 100, y: 100, application: "Notes", windowId: 42 },
          expectedDropOwner: { x: 300, y: 300, application: "Notes", windowId: 42 },
        }),
      ]),
    ).toThrow(/drop-owner-changed:Terminal/);
    // Global dragBack (6) to origin, then global mouseUp (2) at origin, then cursor restored (5) to (33, 44).
    expect(posted.slice(-3)).toEqual([
      { type: 6, x: 100, y: 100 },
      { type: 2, x: 100, y: 100 },
      { type: 5, x: 33, y: 44 },
    ]);
    expect(warped).toHaveLength(0);
  });
});

describe("JXA_AX_ACTION_SCRIPT and JXA_WINDOWS_SCRIPT window disambiguation", () => {
  it("captures kCGWindowName in JXA_WINDOWS_SCRIPT for title-based AX verification", () => {
    expect(JXA_WINDOWS_SCRIPT).toContain("kCGWindowName");
  });

  it("refuses ambiguous equal-geometry same-PID sibling windows regardless of Quartz title or layer", () => {
    let performCalls = 0;
    const runWithSibling = (siblingLayer: number, siblingTitle: string) => {
      const ctx = NodeVM.createContext({
        ObjC: {
          import: () => undefined,
          bindFunction: () => undefined,
          deepUnwrap: (v: unknown) => v,
          castRefToObject: (v: unknown) => v,
          unwrap: (v: unknown) => v,
        },
        Ref: () => [null],
        $: Object.assign((s: string) => s, {
          NSWorkspace: {
            sharedWorkspace: {
              frontmostApplication: { isNil: () => true },
            },
          },
          CGWindowListCopyWindowInfo: () => [
            {
              kCGWindowOwnerName: "Notes",
              kCGWindowOwnerPID: 100,
              kCGWindowNumber: 42,
              kCGWindowLayer: 0,
              kCGWindowAlpha: 1,
              kCGWindowName: "Draft A",
              kCGWindowBounds: { X: 10, Y: 20, Width: 400, Height: 300 },
            },
            {
              kCGWindowOwnerName: "Notes",
              kCGWindowOwnerPID: 100,
              kCGWindowNumber: 99,
              kCGWindowLayer: siblingLayer,
              kCGWindowAlpha: 1,
              kCGWindowName: siblingTitle,
              kCGWindowBounds: { X: 10, Y: 20, Width: 400, Height: 300 },
            },
          ],
          AXUIElementPerformAction: () => {
            performCalls++;
            return 0;
          },
        }),
      });
      NodeVM.runInContext(JXA_AX_ACTION_SCRIPT, ctx);
      return JSON.parse(
        (ctx.run as (argv: Array<string>) => string)([
          JSON.stringify({
            kind: "click",
            pid: 100,
            x: 100,
            y: 100,
            windowId: 42,
            expectedWindowBounds: { x: 10, y: 20, width: 400, height: 300 },
            expectedWindowTitle: "Draft A",
          }),
        ]),
      ) as { ok: boolean; reason?: string };
    };
    expect(runWithSibling(0, "Different Quartz Title")).toMatchObject({
      ok: false,
      reason: "ax-window-ambiguous",
    });
    expect(runWithSibling(3, "Floating Sheet")).toMatchObject({
      ok: false,
      reason: "ax-window-ambiguous",
    });
    expect(performCalls).toBe(0);
  });

  it("aborts drag before posting a segment over an unapproved intermediate window (Round 11)", () => {
    const postedEvents: Array<{ kind: string; event: number; x?: number; y?: number }> = [];
    let midDragCover = false;
    const makeCtx = (preCovered: boolean) => {
      let cursor = { x: 5, y: 5 };
      const ctx = NodeVM.createContext({
        ObjC: {
          import: () => {},
          bindFunction: () => {},
          castRefToObject: (v: unknown) => v,
          deepUnwrap: (v: unknown) => v,
          unwrap: (v: unknown) => v,
        },
        delay: () => {},
        $: {
          NSScreen: { screens: { isNil: () => true } },
          NSWorkspace: {
            sharedWorkspace: {
              frontmostApplication: {
                isNil: () => false,
                localizedName: { js: "Terminal" },
                bundleIdentifier: { js: "com.apple.Terminal" },
                processIdentifier: 999,
              },
            },
          },
          CGEventSourceSecondsSinceLastEventType: () => 5,
          CGEventCreate: () => ({ kind: "probe" }),
          CGEventGetLocation: () => cursor,
          CGEventCreateMouseEvent: (_s: unknown, event: number, pt: { x: number; y: number }) => ({
            kind: "mouse",
            event,
            x: pt.x,
            y: pt.y,
          }),
          CGEventSetIntegerValueField: () => {},
          CGEventSetFlags: () => {},
          CGEventCreateKeyboardEvent: (_s: unknown, keyCode: number, down: boolean) => ({
            kind: "key",
            event: keyCode,
            down,
          }),
          CGEventPost: (
            _tap: number,
            ev: { kind: string; event: number; x?: number; y?: number },
          ) => {
            postedEvents.push(ev);
            if (ev.kind === "mouse" && typeof ev.x === "number" && typeof ev.y === "number") {
              cursor = { x: ev.x, y: ev.y };
            }
            if (ev.kind === "mouse" && ev.event === 1) {
              midDragCover = true;
            }
          },
          CGEventPostToPid: (
            _pid: number,
            ev: { kind: string; event: number; x?: number; y?: number },
          ) => {
            postedEvents.push(ev);
          },
          CGWindowListCopyWindowInfo: () => [
            ...(preCovered || midDragCover
              ? [
                  {
                    kCGWindowOwnerName: "EvilApp",
                    kCGWindowOwnerPID: 666,
                    kCGWindowNumber: 66,
                    kCGWindowLayer: 0,
                    kCGWindowAlpha: 1,
                    kCGWindowBounds: { X: 40, Y: 0, Width: 30, Height: 100 },
                  },
                ]
              : []),
            {
              kCGWindowOwnerName: "Notes",
              kCGWindowOwnerPID: 100,
              kCGWindowNumber: 10,
              kCGWindowLayer: 0,
              kCGWindowAlpha: 1,
              kCGWindowBounds: { X: 0, Y: 0, Width: 100, Height: 100 },
            },
          ],
        },
      });
      NodeVM.runInContext(JXA_INPUT_SCRIPT, ctx);
      return ctx;
    };

    const steps = [
      { type: "mouse", event: 1, button: 0, x: 10, y: 50, clickState: 1 },
      { type: "mouse", event: 6, button: 0, x: 50, y: 50, clickState: 1 },
      { type: "mouse", event: 2, button: 0, x: 90, y: 50, clickState: 1 },
    ];
    const opts = {
      restoreCursor: true,
      expectedPointOwner: {
        x: 10,
        y: 50,
        application: "Notes",
        windowId: 10,
        bounds: { x: 0, y: 0, width: 100, height: 100 },
      },
      expectedDropOwner: {
        x: 90,
        y: 50,
        application: "Notes",
        windowId: 10,
        bounds: { x: 0, y: 0, width: 100, height: 100 },
      },
    };

    // Case 1: unapproved app already covers intermediate drag point -> aborted before mouseDown
    postedEvents.length = 0;
    const preCtx = makeCtx(true);
    expect(() =>
      (preCtx.run as (argv: Array<string>) => string)([
        JSON.stringify(steps),
        JSON.stringify(opts),
      ]),
    ).toThrow(/drag-path-owner-changed:EvilApp/);
    expect(postedEvents.filter((e) => e.event !== 5)).toHaveLength(0);

    // Case 2: unapproved app appears over intermediate drag point after mouseDown -> aborted before mouseDragged at (50,50)
    postedEvents.length = 0;
    midDragCover = false;
    const midCtx = makeCtx(false);
    expect(() =>
      (midCtx.run as (argv: Array<string>) => string)([
        JSON.stringify(steps),
        JSON.stringify(opts),
      ]),
    ).toThrow(/drag-path-owner-changed:EvilApp/);
    expect(
      postedEvents.some((e) => e.kind === "mouse" && e.event === 6 && e.x === 50 && e.y === 50),
    ).toBe(false);
  });

  it("allows window-relative title-bar drag when the latched window moves with the pointer (Round 11)", () => {
    const postedEvents: Array<{ kind: string; event: number; x?: number; y?: number }> = [];
    let windowX = 100;
    let cursor = { x: 5, y: 5 };
    const ctx = NodeVM.createContext({
      ObjC: {
        import: () => {},
        bindFunction: () => {},
        castRefToObject: (v: unknown) => v,
        deepUnwrap: (v: unknown) => v,
        unwrap: (v: unknown) => v,
      },
      delay: () => {},
      $: {
        NSScreen: { screens: { isNil: () => true } },
        NSWorkspace: {
          sharedWorkspace: {
            frontmostApplication: {
              isNil: () => false,
              localizedName: { js: "Terminal" },
              bundleIdentifier: { js: "com.apple.Terminal" },
              processIdentifier: 999,
            },
          },
        },
        CGEventSourceSecondsSinceLastEventType: () => 5,
        CGEventCreate: () => ({ kind: "probe" }),
        CGEventGetLocation: () => cursor,
        CGEventCreateMouseEvent: (_s: unknown, event: number, pt: { x: number; y: number }) => ({
          kind: "mouse",
          event,
          x: pt.x,
          y: pt.y,
        }),
        CGEventSetIntegerValueField: () => {},
        CGEventSetFlags: () => {},
        CGEventPost: (
          _tap: number,
          ev: { kind: string; event: number; x?: number; y?: number },
        ) => {
          postedEvents.push(ev);
          if (ev.kind === "mouse" && typeof ev.x === "number" && typeof ev.y === "number") {
            cursor = { x: ev.x, y: ev.y };
          }
          if (ev.kind === "mouse" && ev.event === 6 && typeof ev.x === "number") {
            // Window moves along with the title-bar drag
            windowX = ev.x - 50;
          }
        },
        CGWindowListCopyWindowInfo: () => [
          {
            kCGWindowOwnerName: "Notes",
            kCGWindowOwnerPID: 100,
            kCGWindowNumber: 50,
            kCGWindowLayer: 0,
            kCGWindowAlpha: 1,
            kCGWindowBounds: { X: windowX, Y: 100, Width: 300, Height: 200 },
          },
        ],
      },
    });
    NodeVM.runInContext(JXA_INPUT_SCRIPT, ctx);
    const steps = [
      { type: "mouse", event: 1, button: 0, x: 150, y: 110, clickState: 1 },
      { type: "mouse", event: 6, button: 0, x: 200, y: 110, clickState: 1 },
      { type: "mouse", event: 6, button: 0, x: 250, y: 110, clickState: 1 },
      { type: "mouse", event: 2, button: 0, x: 250, y: 110, clickState: 1 },
    ];
    const opts = {
      restoreCursor: true,
      expectedPointOwner: {
        x: 150,
        y: 110,
        application: "Notes",
        windowId: 50,
        bounds: { x: 100, y: 100, width: 300, height: 200 },
      },
      expectedDropOwner: {
        x: 250,
        y: 110,
        application: "Notes",
        windowId: 50,
        bounds: { x: 100, y: 100, width: 300, height: 200 },
      },
    };
    const out = (ctx.run as (argv: Array<string>) => string)([
      JSON.stringify(steps),
      JSON.stringify(opts),
    ]);
    expect(JSON.parse(out)).toMatchObject({ frontmostApplication: "Terminal" });
    expect(postedEvents.filter((e) => e.kind === "mouse" && e.event === 6)).toHaveLength(2);
    expect(postedEvents.filter((e) => e.kind === "mouse" && e.event === 2)).toHaveLength(1);
  });

  it("requires background empty-selection AXSelectedText insertion and never falls back to AXValue or double-writes (Round 12)", () => {
    const runAxType = (opts: {
      selectedTextSettable: boolean;
      frontPid: number;
      selectedText?: string;
      setSelectedTextErr?: number;
    }) => {
      const setCalls: Array<{ attr: string; value: string }> = [];
      let fieldValue = "Draft ";
      let currentSelection = opts.selectedText ?? "";
      const ctx = NodeVM.createContext({
        ObjC: {
          import: () => {},
          bindFunction: () => {},
          castRefToObject: (v: unknown) => v,
          deepUnwrap: (v: unknown) => v,
          unwrap: (v: unknown) => v,
        },
        Ref: () => [null],
        $: Object.assign((s: string) => s, {
          NSWorkspace: {
            sharedWorkspace: {
              frontmostApplication: {
                isNil: () => false,
                localizedName: { js: opts.frontPid === 100 ? "Notes" : "Terminal" },
                processIdentifier: opts.frontPid,
              },
            },
          },
          CGWindowListCopyWindowInfo: () => [
            {
              kCGWindowOwnerName: "Notes",
              kCGWindowOwnerPID: 100,
              kCGWindowNumber: 42,
              kCGWindowLayer: 0,
              kCGWindowAlpha: 1,
              kCGWindowBounds: { X: 10, Y: 20, Width: 400, Height: 300 },
            },
          ],
          AXUIElementCreateApplication: () => ({ kind: "app" }),
          AXUIElementCopyElementAtPosition: (
            _app: unknown,
            _x: number,
            _y: number,
            ref: Array<unknown>,
          ) => {
            ref[0] = { kind: "el" };
            return 0;
          },
          AXUIElementCopyAttributeValue: (_el: unknown, attr: string, ref: Array<unknown>) => {
            if (attr === "AXRole") {
              ref[0] = "AXTextArea";
              return 0;
            }
            if (attr === "AXIdentifier") {
              ref[0] = "body-editor";
              return 0;
            }
            if (attr === "AXSelectedText") {
              ref[0] = currentSelection;
              return 0;
            }
            if (attr === "AXValue") {
              ref[0] = fieldValue;
              return 0;
            }
            return -25212;
          },
          AXUIElementIsAttributeSettable: (_el: unknown, attr: string, ref: Array<unknown>) => {
            if (attr === "AXSelectedText") {
              ref[0] = opts.selectedTextSettable;
              return 0;
            }
            if (attr === "AXValue") {
              ref[0] = true;
              return 0;
            }
            ref[0] = false;
            return 0;
          },
          AXUIElementSetAttributeValue: (_el: unknown, attr: string, val: string) => {
            setCalls.push({ attr, value: val });
            if (attr === "AXSelectedText") {
              if (currentSelection.length > 0) {
                fieldValue = fieldValue.replace(currentSelection, val);
                currentSelection = "";
              } else {
                fieldValue += val;
              }
              return opts.setSelectedTextErr ?? 0;
            }
            if (attr === "AXValue") {
              fieldValue = val;
            }
            return 0;
          },
          CFRelease: () => {},
        }),
      });
      NodeVM.runInContext(JXA_AX_ACTION_SCRIPT, ctx);
      const result = JSON.parse(
        (ctx.run as (argv: Array<string>) => string)([
          JSON.stringify({
            mode: "type",
            pid: 100,
            x: 100,
            y: 100,
            windowId: 42,
            text: "from agent",
            expectedRole: "AXTextArea",
            expectedFieldKey: "r:AXTextArea|id:body-editor|wid:42",
          }),
        ]),
      ) as { ok: boolean; reason?: string };
      return { result, setCalls, fieldValue };
    };

    // Case 1: Background target, empty selection, AXSelectedText settable -> atomic insertion succeeds
    const selectedPath = runAxType({ selectedTextSettable: true, frontPid: 999, selectedText: "" });
    expect(selectedPath.result).toMatchObject({ ok: true, kind: "typed" });
    expect(selectedPath.setCalls).toEqual([{ attr: "AXSelectedText", value: "from agent" }]);

    // Case 2: Non-empty selection in field -> refuses before any write so user's selection is preserved
    const selectionRefused = runAxType({
      selectedTextSettable: true,
      frontPid: 999,
      selectedText: "Draft ",
    });
    expect(selectionRefused.result).toMatchObject({ ok: false, reason: "ax-selection-nonempty" });
    expect(selectionRefused.setCalls).toHaveLength(0);
    expect(selectionRefused.fieldValue).toBe("Draft ");

    // Case 3: Target app is frontmost -> refuses background AX write
    const frontmostRefused = runAxType({ selectedTextSettable: true, frontPid: 100 });
    expect(frontmostRefused.result).toMatchObject({ ok: false, reason: "ax-target-frontmost" });
    expect(frontmostRefused.setCalls).toHaveLength(0);

    // Case 4: AXSelectedText unsupported -> refuses whole-field AXValue overwrite even in background
    const unsupportedRefused = runAxType({ selectedTextSettable: false, frontPid: 999 });
    expect(unsupportedRefused.result).toMatchObject({
      ok: false,
      reason: "ax-insertion-unsupported",
    });
    expect(unsupportedRefused.setCalls).toHaveLength(0);

    // Case 5: Uncertain AXSelectedText error (kAXErrorCannotComplete = -25204) -> returns ax-set-uncertain with NO second write
    const uncertainErr = runAxType({
      selectedTextSettable: true,
      frontPid: 999,
      setSelectedTextErr: -25204,
    });
    expect(uncertainErr.result).toMatchObject({ ok: false, reason: "ax-set-uncertain" });
    expect(uncertainErr.setCalls).toEqual([{ attr: "AXSelectedText", value: "from agent" }]);
  });

  it("uses one atomic window snapshot per mouseDown preflight and per drag segment (Round 12)", () => {
    let snapshotCount = 0;
    const posted: Array<{ type: number; x: number; y: number }> = [];
    const ctx = NodeVM.createContext({
      ObjC: {
        import: () => {},
        bindFunction: () => {},
        castRefToObject: (v: unknown) => v,
        unwrap: (v: unknown) => v,
        deepUnwrap: (v: unknown) => v,
      },
      delay: () => {},
      $: {
        NSWorkspace: {
          sharedWorkspace: {
            frontmostApplication: {
              isNil: () => false,
              bundleIdentifier: { js: "com.apple.Notes" },
              localizedName: { js: "Notes" },
              processIdentifier: 100,
            },
          },
        },
        NSScreen: { screens: { isNil: () => true } },
        CGEventCreate: () => ({}),
        CGEventGetLocation: () => ({ x: 50, y: 50 }),
        CGEventSourceSecondsSinceLastEventType: () => 10,
        CGEventCreateMouseEvent: (
          _s: unknown,
          type: number,
          pt: { x: number; y: number },
          button: number,
        ) => ({ type, x: pt.x, y: pt.y, button }),
        CGEventSetIntegerValueField: () => {},
        CGEventSetFlags: () => {},
        CGEventPost: (_tap: number, ev: { type: number; x: number; y: number }) => {
          posted.push(ev);
        },
        CGWindowListCopyWindowInfo: () => {
          snapshotCount++;
          return [
            {
              kCGWindowOwnerName: "Notes",
              kCGWindowOwnerPID: 100,
              kCGWindowNumber: 42,
              kCGWindowLayer: 0,
              kCGWindowAlpha: 1,
              kCGWindowBounds: { X: 0, Y: 0, Width: 500, Height: 400 },
            },
          ];
        },
      },
    });
    NodeVM.runInContext(JXA_INPUT_SCRIPT, ctx);

    const drag = [
      { type: "mouse", event: 1, x: 50, y: 50, button: 0, clickCount: 1 },
      { type: "mouse", event: 6, x: 83, y: 50, button: 0, clickCount: 1 },
      { type: "mouse", event: 6, x: 117, y: 50, button: 0, clickCount: 1 },
      { type: "mouse", event: 6, x: 150, y: 50, button: 0, clickCount: 1 },
      { type: "mouse", event: 6, x: 183, y: 50, button: 0, clickCount: 1 },
      { type: "mouse", event: 6, x: 217, y: 50, button: 0, clickCount: 1 },
      { type: "mouse", event: 6, x: 250, y: 50, button: 0, clickCount: 1 },
      { type: "mouse", event: 2, x: 250, y: 50, button: 0, clickCount: 1 },
    ];
    const dragSegmentCount = 6;

    (ctx.run as (argv: Array<string>) => string)([
      JSON.stringify(drag),
      JSON.stringify({
        expectedPointOwner: {
          x: 50,
          y: 50,
          application: "Notes",
          windowId: 42,
          bounds: { x: 0, y: 0, width: 500, height: 400 },
        },
        expectedDropOwner: {
          x: 250,
          y: 50,
          application: "Notes",
          windowId: 42,
          bounds: { x: 0, y: 0, width: 500, height: 400 },
        },
        forbidPid: 999,
      }),
    ]);

    // 2 entry checks + 1 atomic snapshot for mouseDown preflight (origin + drop + all segments) + 1 per drag segment (segment + drop) + 1 for mouseUp.
    expect(snapshotCount).toBe(2 + 1 + dragSegmentCount + 1);
    expect(posted.length).toBe(dragSegmentCount + 2);
  });
});
