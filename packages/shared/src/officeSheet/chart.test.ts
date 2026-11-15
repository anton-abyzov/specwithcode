import { describe, expect, it } from "vite-plus/test";

import { addChart, chartFromSelection, chartSeries, compactNumber, removeChart } from "./chart.ts";
import { evaluateSheet } from "./formula.ts";
import { type SheetDocument, parseCellRange, validateSheetDocument } from "./model.ts";

function build(appCount: number): SheetDocument {
  const types = [...Array.from({ length: appCount }, () => "App"), "Skill", "Skill", "Model"];
  const toolkit: Record<string, string> = {};
  types.forEach((type, index) => {
    toolkit[`A${index + 1}`] = type;
  });
  const result = validateSheetDocument({
    title: "Toolkit",
    tabs: [
      { name: "Toolkit", cells: toolkit },
      {
        name: "Breakdown",
        cells: {
          A1: "App",
          A2: "Skill",
          A3: "Model",
          A4: "Notes",
          B1: "=COUNTIF(Toolkit!A1:A99, A1)",
          B2: "=COUNTIF(Toolkit!A1:A99, A2)",
          B3: "=COUNTIF(Toolkit!A1:A99, A3)",
          B4: "not a number",
        },
        charts: [
          { id: "types", type: "bar", title: "Apps lead", labels: "A1:A4", values: "B1:B4" },
        ],
      },
    ],
  });
  if (!result.ok) throw new Error(result.error);
  return result.document;
}

describe("sheet charts", () => {
  it("draws from computed values and follows the source cells", () => {
    const first = build(3);
    const chart = first.tabs[1]!.charts![0]!;
    const series = chartSeries(first, evaluateSheet(first), 1, chart);
    expect(series.points.map((point) => [point.label, point.value])).toEqual([
      ["App", 3],
      ["Skill", 2],
      ["Model", 1],
    ]);
    expect(series.total).toBe(6);
    expect(series.points[0]!.share).toBe(0.5);

    const second = build(7);
    const updated = chartSeries(second, evaluateSheet(second), 1, chart);
    expect(updated.points[0]).toMatchObject({ label: "App", value: 7, share: 0.7 });
  });

  it("reads ranges on another tab and reports a bad range", () => {
    const doc = build(1);
    const evaluation = evaluateSheet(doc);
    const cross = chartSeries(doc, evaluation, 0, {
      id: "x",
      type: "donut",
      title: "Cross",
      labels: "Breakdown!A1:A3",
      values: "Breakdown!B1:B3",
    });
    expect(cross.points.length).toBe(3);
    const bad = chartSeries(doc, evaluation, 0, {
      id: "y",
      type: "line",
      title: "Bad",
      labels: "Nope!A1:A3",
      values: "Nope!B1:B3",
    });
    expect(bad).toMatchObject({ points: [], problem: "range" });
  });

  it("builds a chart from a selection and adds or removes it", () => {
    const doc = build(2);
    const tab = doc.tabs[1]!;
    const wide = chartFromSelection(tab, parseCellRange("A1:B3")!, "bar", "  By type ");
    expect(wide).toEqual({
      id: "chart-2",
      type: "bar",
      title: "By type",
      labels: "A1:A3",
      values: "B1:B3",
    });
    const narrow = chartFromSelection(tab, parseCellRange("B1:B3")!, "donut", "");
    expect(narrow).toMatchObject({ labels: "A1:A3", values: "B1:B3", title: "Chart 2" });

    const added = addChart(doc, 1, wide);
    expect(added.tabs[1]!.charts!.map((chart) => chart.id)).toEqual(["types", "chart-2"]);
    expect(validateSheetDocument(added).ok).toBe(true);
    const removed = removeChart(removeChart(added, 1, "types"), 1, "chart-2");
    expect(removed.tabs[1]!.charts).toBeUndefined();
  });

  it("writes compact labels", () => {
    expect(compactNumber(1234)).toBe("1,234");
    expect(compactNumber(12500)).toBe("12.5K");
    expect(compactNumber(3400000)).toBe("3.4M");
    expect(compactNumber(0.256)).toBe("0.26");
  });
});
