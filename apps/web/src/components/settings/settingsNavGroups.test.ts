import { describe, expect, it } from "vite-plus/test";

import { groupSettingsNavItems, isSettingsNavItemShown } from "./SettingsSidebarNav";
import { SETTINGS_SECTION_LABELS, type SettingsPath } from "./settingsSearch";

describe("groupSettingsNavItems", () => {
  it("places every section exactly once and drops empty groups", () => {
    const items = (Object.keys(SETTINGS_SECTION_LABELS) as SettingsPath[]).map((to) => ({ to }));
    const groups = groupSettingsNavItems(items);
    const placed = groups.flatMap((group) => group.items.map((item) => item.to));
    expect(placed.toSorted()).toEqual(items.map((item) => item.to).toSorted());
    expect(groups.every((group) => group.items.length > 0)).toBe(true);
    expect(groups[0]?.label).toBe("Project");
  });

  it("keeps the order of a filtered list", () => {
    const groups = groupSettingsNavItems([{ to: "/settings/skills" }, { to: "/settings/general" }]);
    expect(groups.map((group) => [group.label, group.items.map((item) => item.to)])).toEqual([
      ["Project", ["/settings/skills"]],
      ["App", ["/settings/general"]],
    ]);
  });
});

describe("isSettingsNavItemShown", () => {
  const sections = Object.keys(SETTINGS_SECTION_LABELS) as SettingsPath[];
  const shown = (state: { isConnectAdmin: boolean; overviewVisible: boolean }) =>
    sections.filter((to) => isSettingsNavItemShown(to, state));

  it("lists Connect admin only for an account the relay confirmed as an owner", () => {
    expect(shown({ isConnectAdmin: false, overviewVisible: true })).not.toContain(
      "/settings/connect-admin",
    );
    expect(shown({ isConnectAdmin: true, overviewVisible: false })).toContain(
      "/settings/connect-admin",
    );
  });

  it("keeps the other rules: no Connections entry, Project only with a project", () => {
    const anyone = shown({ isConnectAdmin: false, overviewVisible: false });
    expect(anyone).not.toContain("/settings/connections");
    expect(anyone).not.toContain("/settings/projects");
    expect(anyone).toContain("/settings/skills");
    expect(shown({ isConnectAdmin: false, overviewVisible: true })).toContain("/settings/projects");
    // Everything else is always listed.
    expect(anyone).toHaveLength(sections.length - 3);
  });
});
