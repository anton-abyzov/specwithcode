// @vitest-environment jsdom
import { describe, expect, it } from "vite-plus/test";

import {
  findProjectSettingsAnchor,
  PROJECT_SETTINGS_TABS,
  searchProjectSettings,
} from "./projectSettingsSearch.logic";

describe("searchProjectSettings", () => {
  it("returns a named tab as the root of its rows", () => {
    const results = searchProjectSettings("memory", PROJECT_SETTINGS_TABS);
    expect(results[0]).toMatchObject({ kind: "section", section: "memory", matched: true });
    expect(results.map((r) => r.id)).toContain("project-memory");
  });

  it.each(["knowledge", "search mode", "rebuild index"])(
    "finds Project knowledge on the Memory tab by %s",
    (query) => {
      const results = searchProjectSettings(query, PROJECT_SETTINGS_TABS);
      expect(results.map((r) => r.id)).toContain("project-knowledge");
    },
  );

  it("finds a row by a term people remember", () => {
    const results = searchProjectSettings("mcp", PROJECT_SETTINGS_TABS);
    expect(results.map((r) => r.id)).toEqual([
      "section:environment",
      "project-connections",
      "project-allowed-tools",
    ]);
  });
});

describe("findProjectSettingsAnchor", () => {
  it("finds the visible block a row's heading belongs to", () => {
    document.body.innerHTML = `
      <div hidden><section><h2>Project memory</h2></section></div>
      <div><label>Goal <textarea></textarea></label>
      <div class="project-setting-row"><div><h3>Archive project</h3></div></div></div>`;
    expect(findProjectSettingsAnchor(document.body, { anchors: ["Project memory"] })).toBeNull();
    expect(findProjectSettingsAnchor(document.body, { anchors: ["Goal"] })?.tagName).toBe("LABEL");
    expect(
      findProjectSettingsAnchor(document.body, { anchors: ["Archive project"] })?.className,
    ).toBe("project-setting-row");
  });
});
