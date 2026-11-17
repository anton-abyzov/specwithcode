import { describe, expect, it } from "vite-plus/test";
import { canRouteToMain, composerMachines, routeTarget, routedCommand } from "./routeToMain";

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

describe("composerMachines", () => {
  it("names main on the chip of a copy whose main is elsewhere, and on Send while it routes", () => {
    expect(
      composerMachines({ viewed: "m5", mainKey: "m4:p", copyOff: true, routes: true }),
    ).toEqual({ chip: "m4", send: "m4" });
    // Main unreachable: Send names no machine, the chip still says where the coordinator runs.
    expect(
      composerMachines({ viewed: "m5", mainKey: "m4:p", copyOff: true, routes: false }),
    ).toEqual({ chip: "m4", send: null });
    // Main itself, or a page that is not a copy: both name the machine being looked at.
    expect(
      composerMachines({ viewed: "m4", mainKey: null, copyOff: false, routes: false }),
    ).toEqual({ chip: "m4", send: "m4" });
  });

  it("never lets the chip and Send name two different machines", () => {
    for (const viewed of ["m5", "m4"])
      for (const mainKey of [null, "m4:p", "m5:p", "bad"])
        for (const copyOff of [false, true])
          for (const routes of [false, true]) {
            const named = composerMachines({ viewed, mainKey, copyOff, routes });
            if (named.send !== null) expect(named.send).toBe(named.chip);
            if (copyOff && mainKey === "m4:p") expect(named.chip).toBe("m4");
          }
  });
});
