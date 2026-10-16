import { describe, expect, it } from "vite-plus/test";

import { isSettingsNavItemActive } from "./SettingsSidebarNav";

describe("isSettingsNavItemActive", () => {
  it("selects the clicked section before the route settles", () => {
    expect(
      isSettingsNavItemActive("/settings/google", "/settings/general", "/settings/google"),
    ).toBe(true);
    expect(
      isSettingsNavItemActive("/settings/general", "/settings/general", "/settings/google"),
    ).toBe(false);
  });

  it("follows the location once nothing is pending", () => {
    expect(isSettingsNavItemActive("/settings/general", "/settings/general", null)).toBe(true);
    expect(isSettingsNavItemActive("/settings/providers", "/settings/providers/claude", null)).toBe(
      true,
    );
    expect(
      isSettingsNavItemActive("/settings/general", "/settings/open-source-licenses", null),
    ).toBe(true);
    expect(isSettingsNavItemActive("/settings/google", "/settings/general", null)).toBe(false);
  });
});
