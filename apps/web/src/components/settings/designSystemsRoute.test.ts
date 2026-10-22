import { isRedirect } from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import { designSystemsRouteGuard } from "../../routes/settings.design-systems";

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
