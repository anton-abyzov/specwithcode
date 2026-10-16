import { describe, expect, it } from "vite-plus/test";

import { groupSettingsNavItems } from "./SettingsSidebarNav";
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
