import { describe, expect, it } from "vite-plus/test";
import { canRouteToMain, routeTarget, routedCommand, sendButtonText } from "./routeToMain";

describe("routeTarget", () => {
  it("splits main's checkout key, keeping a project id that holds a colon", () => {
    expect(routeTarget("m4:1332065e")).toEqual({ environmentId: "m4", projectId: "1332065e" });
    expect(routeTarget("m1:mcp:d580ecec")).toEqual({
      environmentId: "m1",
      projectId: "mcp:d580ecec",
    });
    expect(routeTarget(null)).toBeNull();
    expect(routeTarget("m4")).toBeNull();
  });
});

describe("canRouteToMain", () => {
  const target = { environmentId: "m4" };
  it("routes only a copy whose main is connected and may run work from this window", () => {
    expect(
      canRouteToMain({
        copyOff: true,
        target,
        mainLive: true,
        mainConnected: true,
        mayOperate: true,
      }),
    ).toBe(true);
    // Main offline: the box stays off and says where to write.
    expect(
      canRouteToMain({
        copyOff: true,
        target,
        mainLive: true,
        mainConnected: false,
        mayOperate: true,
      }),
    ).toBe(false);
    // Read-only on main: nothing can start there from here.
    expect(
      canRouteToMain({
        copyOff: true,
        target,
        mainLive: true,
        mainConnected: true,
        mayOperate: false,
      }),
    ).toBe(false);
    // Main itself, or a box off for another reason, never routes.
    expect(
      canRouteToMain({
        copyOff: false,
        target,
        mainLive: true,
        mainConnected: true,
        mayOperate: true,
      }),
    ).toBe(false);
    expect(
      canRouteToMain({
        copyOff: true,
        target: null,
        mainLive: true,
        mainConnected: true,
        mayOperate: true,
      }),
    ).toBe(false);
  });
});

describe("canRouteToMain with a main that is not live", () => {
  it("never routes to a bare successor reference or a checkout mid-move", () => {
    expect(
      canRouteToMain({
        copyOff: true,
        target: { environmentId: "m4" },
        mainLive: false,
        mainConnected: true,
        mayOperate: true,
      }),
    ).toBe(false);
  });
});

describe("routedCommand", () => {
  it("reuses the command id for the same text to the same main until it is confirmed", () => {
    let n = 0;
    const mint = () => `id-${++n}`;
    const first = routedCommand(null, "m4:p", "time now?", mint);
    expect(first.commandId).toBe("id-1");
    // A retry after a lost answer: the same id, so main runs it once.
    expect(routedCommand(first, "m4:p", "time now?", mint)).toBe(first);
    // Edited text or another main is a new message.
    expect(routedCommand(first, "m4:p", "time now, please?", mint).commandId).toBe("id-2");
    expect(routedCommand(first, "m1:p", "time now?", mint).commandId).toBe("id-3");
  });
});

describe("sendButtonText", () => {
  it("never carries a machine label", () => {
    const machines = ["m4", "m5", "M5", "linux-mini", "Studio M4", "Mac"];
    for (const continues of [false, true])
      for (const hasFiles of [false, true]) {
        const text = sendButtonText({ continues, hasFiles });
        for (const machine of machines) expect(text).not.toContain(machine);
        expect(text).not.toMatch(/\bto\b|\bon\b/);
      }
  });

  it("reads Send, or continues the coordinator here once its machine has been silent", () => {
    expect(sendButtonText({ continues: false, hasFiles: false })).toBe("Send");
    expect(sendButtonText({ continues: false, hasFiles: true })).toBe("Send");
    expect(sendButtonText({ continues: true, hasFiles: false })).toBe("Continue here and send");
    expect(sendButtonText({ continues: true, hasFiles: true })).toBe("Continue here");
  });
});
