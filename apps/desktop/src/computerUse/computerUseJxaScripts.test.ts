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
    ).toThrow(/point-owner-changed:forbidden-pid:300/);
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
});
