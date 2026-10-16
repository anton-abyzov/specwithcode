// @vitest-environment jsdom
import { describe, expect, it } from "vite-plus/test";

import { findTextRanges, reportFileName } from "./reportOutline";

describe("findTextRanges", () => {
  it("finds every case-insensitive match across rendered text", () => {
    const root = document.createElement("article");
    root.innerHTML = "<h1>Startup order</h1><p>The <code>startup</code> runs; STARTUP ends.</p>";
    const ranges = findTextRanges(root, "startup");
    expect(ranges.map((range) => range.toString())).toEqual(["Startup", "startup", "STARTUP"]);
    expect(findTextRanges(root, "  ")).toEqual([]);
  });
});

describe("reportFileName", () => {
  it("names the download after the report title", () => {
    expect(reportFileName("Map interrupted-run recovery on startup")).toBe(
      "map-interrupted-run-recovery-on-startup.md",
    );
    expect(reportFileName("…")).toBe("report.md");
  });
});
