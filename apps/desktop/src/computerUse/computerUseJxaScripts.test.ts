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
    expect(JXA_INPUT_SCRIPT).toContain("CGEventPostToPid(press.startPid, escDown)");
    expect(JXA_INPUT_SCRIPT).toContain("CGEventPostToPid(press.startPid, escUp)");
    expect(JXA_INPUT_SCRIPT).not.toContain("CGEventPost(0, escDown)");
    expect(JXA_INPUT_SCRIPT).not.toContain("CGEventPost(0, escUp)");
    expect(JXA_INPUT_SCRIPT).toContain(
      "var originSafe = !opts.expectedPointOwner || checkPointOwner(opts) === null;",
    );
    expect(JXA_INPUT_SCRIPT).toContain("(!humanMoved && originSafe)");
    expect(JXA_INPUT_SCRIPT).toContain("$.CGEventPostToPid(press.startPid, release);");
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
});

describe("JXA_AX_ACTION_SCRIPT and JXA_WINDOWS_SCRIPT window disambiguation", () => {
  it("captures kCGWindowName in JXA_WINDOWS_SCRIPT for title-based AX verification", () => {
    expect(JXA_WINDOWS_SCRIPT).toContain("kCGWindowName");
  });

  it("refuses ambiguous equal-geometry same-PID sibling windows in JXA_AX_ACTION_SCRIPT", () => {
    expect(JXA_AX_ACTION_SCRIPT).toContain('"ax-window-ambiguous"');
    expect(JXA_AX_ACTION_SCRIPT).toContain("matchingSiblings");
    expect(JXA_AX_ACTION_SCRIPT).toContain(
      "winInfo.title.trim() !== req.expectedWindowTitle.trim()",
    );
  });
});
