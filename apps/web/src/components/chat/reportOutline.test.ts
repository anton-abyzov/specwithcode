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

  it("reads joined text as one run and still searches diagram text", () => {
    const root = document.createElement("article");
    root.innerHTML =
      '<p><code data-path-wrap=""><span>vp</span> <span>test</span></code> and vp</p>' +
      "<svg><text>Startup vp</text></svg>";
    expect(findTextRanges(root, "vp test").map((range) => range.toString())).toEqual(["vp test"]);
    expect(findTextRanges(root, "vp")).toHaveLength(3);
    expect(findTextRanges(root, "startup vp")).toHaveLength(1);
  });

  it("counts overlapping matches and keeps offsets past a letter that grows when lowered", () => {
    const root = document.createElement("article");
    root.innerHTML = "<p>aaaa</p><p>İstanbul report line.</p><p>İSTANBUL REPORT</p>";
    expect(findTextRanges(root, "aa")).toHaveLength(3);
    expect(findTextRanges(root, "line.").map((range) => range.toString())).toEqual(["line."]);
    expect(findTextRanges(root, "REPORT").map((range) => range.toString())).toEqual([
      "report",
      "REPORT",
    ]);
    expect(findTextRanges(root, "İstanbul").map((range) => range.toString())).toEqual([
      "İstanbul",
      "İSTANBUL",
    ]);
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
