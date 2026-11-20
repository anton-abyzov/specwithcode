import { describe, expect, it } from "vite-plus/test";

import { searchSettingsBySection } from "./settingsSearch";
import { searchSettingsGrouped } from "./settingsSearchModel";

const sections = [
  { section: "general", label: "General" },
  { section: "connections", label: "Connections" },
] as const;
const rows = [
  { id: "a", title: "Environments", section: "connections" as const },
  { id: "b", title: "Network access", section: "connections" as const },
  { id: "c", title: "Environment icon", section: "general" as const },
];

describe("searchSettingsGrouped", () => {
  it("returns a named section first, as the root of its rows", () => {
    const results = searchSettingsGrouped("connections", sections, rows, (row) => row.section);
    expect(results.map((r) => (r.kind === "section" ? `#${r.label}` : r.id))).toEqual([
      "#Connections",
      "a",
      "b",
    ]);
    expect(results[0]).toMatchObject({ kind: "section", matched: true });
  });

  it("groups rows found by title under their section, best match first", () => {
    const results = searchSettingsGrouped("environment", sections, rows, (row) => row.section);
    expect(results.map((r) => (r.kind === "section" ? `#${r.label}:${r.matched}` : r.id))).toEqual([
      "#Connections:false",
      "a",
      "#General:false",
      "c",
    ]);
  });

  it("returns nothing for an empty query", () => {
    expect(searchSettingsGrouped("  ", sections, rows, (row) => row.section)).toEqual([]);
  });
});

describe("searchSettingsBySection", () => {
  it("lists the Machines section itself before its subsections", () => {
    const results = searchSettingsBySection("machines");
    expect(results[0]).toMatchObject({
      kind: "section",
      section: "/settings/machines",
      label: "Machines",
      matched: true,
    });
    const nextSection = results.findIndex((r, index) => index > 0 && r.kind === "section");
    const group = results.slice(1, nextSection === -1 ? undefined : nextSection);
    expect(group.every((r) => r.kind === "row" && r.section === "/settings/machines")).toBe(true);
    expect(group.length).toBeGreaterThan(3);
    // A shortcut named after machines is found too, under its own section.
    expect(results.slice(1 + group.length).every((r) => r.section !== "/settings/machines")).toBe(
      true,
    );
  });

  it("only offers sections this surface can open", () => {
    expect(
      searchSettingsBySection("connections", undefined, ["/settings/general"]).some(
        (r) => r.section === "/settings/connections",
      ),
    ).toBe(false);
  });
});
