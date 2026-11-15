import { parseSheetDocument } from "@specweave-studio/shared/officeSheet";
import { act } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { sheetRelativePath } from "./SheetFileView";
import { SheetView } from "./SheetView";

const STATEMENT = JSON.stringify({
  v: 1,
  kind: "sheet",
  title: "Income statement",
  tabs: [
    {
      name: "P&L",
      cells: {
        A1: "Line",
        B1: "Q1",
        A2: "Revenue",
        B2: 120000,
        A3: "Costs",
        B3: -45000.5,
        A4: "Net income",
        B4: "=SUM(B2:B3)",
        A5: "Margin",
        B5: "=B4/B2",
        A6: "Site",
        B6: "https://example.com/report",
        A7: "Bad",
        B7: "javascript:alert(1)",
        C2: "Paid",
        C3: "Due",
      },
      formats: {
        "B2:B4": { kind: "currency", decimals: 0, negative: "parens" },
        B5: { kind: "percent", decimals: 1 },
      },
      styles: { "A4:B4": { bold: true, topBorder: true } },
      chips: ["C2:C3"],
      charts: [
        {
          id: "chart-1",
          type: "bar",
          title: "Revenue beats costs",
          labels: "A2:A3",
          values: "B2:B3",
        },
      ],
    },
    { name: "Notes", cells: { A1: "Second tab" } },
  ],
});

let renderer: ReactTestRenderer | null = null;

function render(text: string, onSave?: (contents: string) => Promise<boolean>): ReactTestRenderer {
  act(() => {
    renderer = create(<SheetView text={text} mode="light" onSave={onSave} />);
  });
  return renderer!;
}

function cell(root: ReactTestInstance, name: string): ReactTestInstance {
  return root.findByProps({ "data-cell": name });
}

function textOf(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

describe("SheetView", () => {
  it("shows computed, formatted cells", () => {
    const { root } = render(STATEMENT);
    expect(textOf(cell(root, "B2"))).toBe("$120,000");
    expect(textOf(cell(root, "B3"))).toBe("($45,001)");
    expect(textOf(cell(root, "B4"))).toBe("$75,000");
    expect(textOf(cell(root, "B5"))).toBe("62.5%");
    expect(cell(root, "B4").props["data-bold"]).toBe(true);
    expect(cell(root, "B4").props["data-rule"]).toBe(true);
    expect(cell(root, "B2").props["data-align"]).toBe("right");
  });

  it("shows the formula of the selected cell in the formula bar", () => {
    const { root } = render(STATEMENT);
    act(() => cell(root, "B4").props.onMouseDown({ shiftKey: false }));
    expect(textOf(root.findByProps({ "data-sheet-address": true }))).toBe("B4");
    expect(textOf(root.findByProps({ "data-sheet-formula": true }))).toBe("=SUM(B2:B3)");
  });

  it("links only http, https and mailto text", () => {
    const { root } = render(STATEMENT);
    const links = root.findAllByType("a");
    expect(links.map((link) => link.props.href)).toEqual(["https://example.com/report"]);
    expect(textOf(cell(root, "B7"))).toBe("javascript:alert(1)");
  });

  it("draws chips and the tab's charts", () => {
    const { root } = render(STATEMENT);
    expect(root.findAllByProps({ className: "office-chip" }).map(textOf)).toEqual(["Paid", "Due"]);
    const chart = root.findByProps({ "data-chart-id": "chart-1" });
    expect(textOf(chart)).toContain("Revenue beats costs");
    expect(chart.findAllByProps({ className: "office-bars-value" }).map(textOf)).toEqual([
      "120K · 100%",
      "-45K",
    ]);
    // Each bar carries its share of the largest value; the stylesheet turns it into a width.
    expect(
      chart
        .findAllByProps({ className: "office-bars-bar" })
        .map((bar) => bar.props.style["--office-bar-share"]),
    ).toEqual([1, 0]);
    // The chart sits on the grid, two columns right of its data and level with it.
    const placed = root.findByProps({ className: "office-grid-chart" });
    expect(placed.props.style).toMatchObject({ left: 44 + 3 * 112, top: 28, width: 520 });
  });

  it("switches tabs", () => {
    const { root } = render(STATEMENT);
    const tabs = root.findAllByProps({ role: "tab" });
    act(() => tabs[1]!.props.onClick());
    expect(textOf(cell(root, "A1"))).toBe("Second tab");
    expect(root.findAllByProps({ "data-chart-id": "chart-1" })).toHaveLength(0);
  });

  it("offers no chart editing without a way to save", () => {
    const { root } = render(STATEMENT);
    expect(root.findAllByProps({ "data-sheet-insert-chart": true })).toHaveLength(0);
  });

  it("saves a chart made from the selected range", async () => {
    const saved: string[] = [];
    const { root } = render(STATEMENT, async (contents) => {
      saved.push(contents);
      return true;
    });
    act(() => cell(root, "A2").props.onMouseDown({ shiftKey: false }));
    act(() => cell(root, "B3").props.onMouseDown({ shiftKey: true }));
    act(() => root.findByProps({ "data-sheet-insert-chart": true }).props.onClick());
    act(() => root.findAllByProps({ role: "radio" })[3]!.props.onClick());
    act(() =>
      root.findByProps({ className: "office-sheet-input" }).props.onChange({
        target: { value: "Where the money goes" },
      }),
    );
    await act(async () => {
      root.findByType("form").props.onSubmit({ preventDefault: () => {} });
    });
    expect(saved).toHaveLength(1);
    const next = parseSheetDocument(saved[0]!);
    expect(next.ok && next.document.tabs[0]!.charts).toEqual([
      {
        id: "chart-1",
        type: "bar",
        title: "Revenue beats costs",
        labels: "A2:A3",
        values: "B2:B3",
      },
      {
        id: "chart-2",
        type: "donut",
        title: "Where the money goes",
        labels: "A2:A3",
        values: "B2:B3",
      },
    ]);
    expect(root.findAllByProps({ "data-chart-id": "chart-2" }).length).toBeGreaterThan(0);
  });

  it("drops the chart again when the save fails", async () => {
    const { root } = render(STATEMENT, async () => false);
    act(() => cell(root, "B2").props.onMouseDown({ shiftKey: false }));
    act(() => cell(root, "B3").props.onMouseDown({ shiftKey: true }));
    act(() => root.findByProps({ "data-sheet-insert-chart": true }).props.onClick());
    await act(async () => {
      root.findByType("form").props.onSubmit({ preventDefault: () => {} });
    });
    expect(root.findAllByProps({ "data-chart-id": "chart-2" })).toHaveLength(0);
    expect(textOf(root.findByProps({ role: "alert" }))).toBe("The chart could not be saved.");
  });

  it("says so when the file is not a sheet", () => {
    const { root } = render('{"v":1,"kind":"sheet","tabs":"<script>"}');
    expect(textOf(root.findByProps({ role: "alert" }))).toContain("This sheet could not be read.");
    expect(root.findAllByType("table")).toHaveLength(0);
  });
});

describe("sheetRelativePath", () => {
  it("keeps a path inside the folder and refuses one outside it", () => {
    expect(sheetRelativePath("/work/app", ".specweave/artifacts/a.sheet.json")).toBe(
      ".specweave/artifacts/a.sheet.json",
    );
    expect(sheetRelativePath("/work/app/", "/work/app/.specweave/artifacts/a.sheet.json")).toBe(
      ".specweave/artifacts/a.sheet.json",
    );
    expect(sheetRelativePath("/work/app", "/work/other/a.sheet.json")).toBeNull();
    expect(sheetRelativePath("/work/app", "/work/app-two/a.sheet.json")).toBeNull();
    expect(
      sheetRelativePath("C:\\Work\\App", "c:\\work\\app\\.specweave\\artifacts\\a.sheet.json"),
    ).toBe(".specweave/artifacts/a.sheet.json");
    expect(sheetRelativePath("C:\\Work\\App", "D:\\Work\\App\\a.sheet.json")).toBeNull();
  });
});
