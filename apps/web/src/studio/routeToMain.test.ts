import { describe, expect, it } from "vite-plus/test";
import { canRouteToMain, routeTarget } from "./routeToMain";

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
    expect(canRouteToMain({ copyOff: true, target, mainConnected: true, mayOperate: true })).toBe(
      true,
    );
    // Main offline: the box stays off and says where to write.
    expect(canRouteToMain({ copyOff: true, target, mainConnected: false, mayOperate: true })).toBe(
      false,
    );
    // Read-only on main: nothing can start there from here.
    expect(canRouteToMain({ copyOff: true, target, mainConnected: true, mayOperate: false })).toBe(
      false,
    );
    // Main itself, or a box off for another reason, never routes.
    expect(canRouteToMain({ copyOff: false, target, mainConnected: true, mayOperate: true })).toBe(
      false,
    );
    expect(
      canRouteToMain({ copyOff: true, target: null, mainConnected: true, mayOperate: true }),
    ).toBe(false);
  });
});
