import { isRedirect } from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import { designSystemsRouteGuard } from "../../routes/settings.design-systems";
import { requestedProjectOf } from "./DesignSystemsSettings";

describe("settings/design-systems route", () => {
  it("redirects to General while design systems are off", () => {
    let thrown: unknown = null;
    try {
      designSystemsRouteGuard({ designSystems: false });
    } catch (error) {
      thrown = error;
    }
    expect(isRedirect(thrown)).toBe(true);
    expect((thrown as { options: { to: string } }).options.to).toBe("/settings/general");
  });

  it("opens once design systems are on", () => {
    expect(() => designSystemsRouteGuard({ designSystems: true })).not.toThrow();
  });
});

describe("requestedProjectOf", () => {
  it("reads ?project= as a string, including ids the router parsed as numbers", () => {
    expect(requestedProjectOf({ project: "p-1" })).toBe("p-1");
    expect(requestedProjectOf({ project: 42 })).toBe("42");
    expect(requestedProjectOf({})).toBeNull();
    expect(requestedProjectOf({ project: { id: 1 } })).toBeNull();
  });
});
