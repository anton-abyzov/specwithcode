import { describe, expect, it } from "vite-plus/test";

import { filterScopeChoices, pageScopeChoices } from "./settingsScopeChoices";

const choices = [
  { label: "SpecWeave umbrella", detail: "/Users/me/specweave-umb" },
  { label: "Studio routing samples — M4", detail: "/tmp/verification/0886" },
  { label: "vskill", detail: "/Users/me/specweave-umb/repositories/vskill" },
  { label: "Aide", detail: "Personal assistant" },
];

describe("filterScopeChoices", () => {
  it("returns every choice for a blank query", () => {
    expect(filterScopeChoices(choices, "   ")).toBe(choices);
  });

  it("matches every word against the label or detail, ignoring case and order", () => {
    expect(filterScopeChoices(choices, "UMB vskill").map((c) => c.label)).toEqual(["vskill"]);
    expect(filterScopeChoices(choices, "assistant").map((c) => c.label)).toEqual(["Aide"]);
    expect(filterScopeChoices(choices, "routing m4").map((c) => c.label)).toEqual([
      "Studio routing samples — M4",
    ]);
  });

  it("returns nothing when a word matches no choice", () => {
    expect(filterScopeChoices(choices, "umbrella zzz")).toEqual([]);
  });
});

describe("pageScopeChoices", () => {
  const rows = Array.from({ length: 21 }, (_, index) => index + 1);

  it("cuts the list into pages and reports the visible range", () => {
    const second = pageScopeChoices(rows, 1, 8);
    expect(second.items).toEqual([9, 10, 11, 12, 13, 14, 15, 16]);
    expect(second).toMatchObject({ page: 1, pageCount: 3, first: 9, last: 16, total: 21 });
    expect(pageScopeChoices(rows, 2, 8)).toMatchObject({ first: 17, last: 21 });
  });

  it("clamps a page past the end so a narrowed search never shows an empty page", () => {
    expect(pageScopeChoices(rows.slice(0, 3), 2, 8)).toMatchObject({
      items: [1, 2, 3],
      page: 0,
      pageCount: 1,
    });
  });

  it("reports an empty list as one empty page", () => {
    expect(pageScopeChoices([], 0, 8)).toMatchObject({
      items: [],
      page: 0,
      pageCount: 1,
      first: 0,
      last: 0,
      total: 0,
    });
  });
});
