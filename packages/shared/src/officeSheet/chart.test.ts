import { describe, expect, it } from "vite-plus/test";

import {
  addChart,
  chartFromSelection,
  chartHeight,
  chartSeries,
  compactNumber,
  layoutSheetCharts,
  removeChart,
} from "./chart.ts";
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

it("reads only the first cells of a huge chart range", () => {
  const checked = validateSheetDocument({
    title: "T",
    tabs: [
      {
        name: "A",
        cells: { A1: "one", B1: 5 },
        charts: [
          { id: "c", type: "bar", title: "Huge", labels: "A1:A100000", values: "B1:ZZ100000" },
        ],
      },
    ],
  });
  if (!checked.ok) throw new Error(checked.error);
  const series = chartSeries(
    checked.document,
    evaluateSheet(checked.document),
    0,
    checked.document.tabs[0]!.charts![0]!,
  );
  expect(series.points).toEqual([{ label: "one", value: 5, share: 1 }]);
});

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

it("places charts beside their data, honours an anchor and stacks ones that would overlap", () => {
  const checked = validateSheetDocument({
    title: "T",
    tabs: [
      {
        name: "A",
        cells: { A1: "Type", B1: "Count", A2: "x", B2: 1, A3: "y", B3: 2 },
        widths: { A: 200 },
        gridlines: false,
        styles: { "A1:B1": { fill: true } },
        charts: [
          { id: "one", type: "bar", title: "One", labels: "A2:A3", values: "B2:B3" },
          { id: "two", type: "column", title: "Two", labels: "A2:A3", values: "B2:B3" },
          {
            id: "three",
            type: "donut",
            title: "Three",
            labels: "A2:A3",
            values: "B2:B3",
            at: "h30",
          },
        ],
      },
    ],
  });
  if (!checked.ok) throw new Error(checked.error);
  const tab = checked.document.tabs[0]!;
  expect(tab.gridlines).toBe(false);
  expect(tab.styles).toEqual({ "A1:B1": { fill: true } });
  expect(tab.charts![2]!.at).toBe("H30");
  const boxes = layoutSheetCharts(tab, [2, 2, 2]);
  // Column D starts after A (200), B and C (112 each); the row above the values is row 1.
  expect(boxes[0]).toMatchObject({ left: 424, top: 0, width: 520, height: chartHeight("bar", 2) });
  expect(boxes[1]!.left).toBe(424);
  expect(boxes[1]!.top).toBeGreaterThanOrEqual(boxes[0]!.top + boxes[0]!.height + 16);
  expect(boxes[1]!.top % 28).toBe(0);
  expect(boxes[2]).toMatchObject({ left: 200 + 6 * 112, top: 29 * 28 });
  expect(boxes[2]!.endRow).toBeGreaterThan(29);
});

it("supports interactive chart filtering, group-by aggregation, sorting, topN, and runtime overrides", () => {
  const checked = validateSheetDocument({
    title: "Sales",
    tabs: [
      {
        name: "Data",
        cells: {
          A1: "Product",
          B1: "Region",
          C1: "Revenue",
          A2: "Alpha",
          B2: "US",
          C2: 100,
          A3: "Beta",
          B3: "EU",
          C3: 400,
          A4: "Alpha",
          B4: "US",
          C4: 250,
          A5: "Gamma",
          B5: "US",
          C5: 50,
        },
        charts: [
          {
            id: "rev",
            type: "bar",
            title: "Revenue by product",
            labels: "A2:A5",
            values: "C2:C5",
            filterRange: "B2:B5",
            aggregate: "sum",
            sort: "value-desc",
            topN: 2,
          },
        ],
      },
    ],
  });
  if (!checked.ok) throw new Error(checked.error);
  const doc = checked.document;
  const evaluation = evaluateSheet(doc);
  const chart = doc.tabs[0]!.charts![0]!;

  const base = chartSeries(doc, evaluation, 0, chart);
  expect(base.availableFilters).toEqual(["US", "EU"]);
  expect(base.points.map((p) => [p.label, p.value])).toEqual([
    ["Beta", 400],
    ["Alpha", 350],
  ]);

  const usOnly = chartSeries(doc, evaluation, 0, chart, {
    filterValues: ["US"],
    aggregate: "avg",
    sort: "label-asc",
    topN: 5,
  });
  expect(usOnly.points.map((p) => [p.label, p.value])).toEqual([
    ["Alpha", 175],
    ["Gamma", 50],
  ]);
});
