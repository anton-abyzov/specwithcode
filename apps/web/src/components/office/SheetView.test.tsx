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

function render(
  text: string,
  onSave?: (contents: string, expectedRevision?: string) => Promise<boolean | "conflict">,
): ReactTestRenderer {
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
    ).toEqual([1, 45000.5 / 120000]);
    // The chart sits on the grid, two columns right of its data and level with it.
    const placed = root.findByProps({ className: "office-grid-chart" });
    expect(placed.props.style).toMatchObject({ left: 44 + 3 * 112, top: 28, width: 520 });
  });

  it("keeps fill and top border on blank cells inside a styled header", () => {
    const sheet = JSON.parse(STATEMENT);
    sheet.tabs[0].styles["A1:C1"] = { fill: true, topBorder: true };
    const { root } = render(JSON.stringify(sheet));
    expect(cell(root, "C1").props).toMatchObject({ "data-fill": true, "data-rule": true });
  });

  it("reports a chart beyond the visible grid without rendering an off-grid card", () => {
    const sheet = JSON.parse(STATEMENT);
    sheet.tabs[0].charts[0].at = "D501";
    const { root } = render(JSON.stringify(sheet));
    expect(root.findAllByProps({ "data-chart-id": "chart-1" })).toHaveLength(0);
    expect(textOf(root)).toContain("Showing the first");
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

  it("filters, sorts, and aggregates chart series interactively", () => {
    const rich = JSON.stringify({
      v: 1,
      kind: "sheet",
      title: "Regional revenue",
      tabs: [
        {
          name: "Data",
          cells: {
            A1: "Region",
            B1: "Revenue",
            A2: "West",
            B2: 100,
            A3: "East",
            B3: 300,
            A4: "West",
            B4: 250,
          },
          charts: [
            {
              id: "rev-chart",
              type: "bar",
              title: "Revenue by region",
              labels: "A2:A4",
              values: "B2:B4",
            },
          ],
        },
      ],
    });
    const { root } = render(rich);
    // Aggregate by sum -> West (350), East (300)
    act(() =>
      root.findByProps({ "data-chart-aggregate": "rev-chart" }).props.onChange({
        target: { value: "sum" },
      }),
    );
    const chart = root.findByProps({ "data-chart-id": "rev-chart" });
    expect(chart.findAllByProps({ className: "office-bars-label" }).map(textOf)).toEqual([
      "West",
      "East",
    ]);
    expect(chart.findAllByProps({ className: "office-bars-value" }).map(textOf)).toEqual([
      "350 · 54%",
      "300 · 46%",
    ]);

    // Filter to East only
    act(() => root.findByProps({ "data-chart-filter": "East" }).props.onClick());
    expect(chart.findAllByProps({ className: "office-bars-label" }).map(textOf)).toEqual(["East"]);

    // Reset filter to All and sort ascending
    act(() => root.findByProps({ "data-chart-filter-all": "rev-chart" }).props.onClick());
    act(() =>
      root.findByProps({ "data-chart-sort": "rev-chart" }).props.onChange({
        target: { value: "value-asc" },
      }),
    );
    expect(chart.findAllByProps({ className: "office-bars-label" }).map(textOf)).toEqual([
      "East",
      "West",
    ]);
  });

  it("sorts columns, organizes column visibility/order, and collapses row groups", () => {
    const organized = JSON.stringify({
      v: 1,
      kind: "sheet",
      title: "Ops",
      tabs: [
        {
          name: "Tasks",
          cells: {
            A1: "Item",
            B1: "Cost",
            C1: "Owner",
            A2: "Zeta",
            B2: 300,
            C2: "Mia",
            A3: "Alpha",
            B3: 100,
            C3: "Leo",
            A4: "Beta",
            B4: 200,
            C4: "Nia",
          },
          rowGroups: [{ id: "g1", label: "Group 1", startRow: 2, endRow: 4, collapsed: false }],
        },
      ],
    });
    const { root } = render(organized);

    // Sort column B ascending: rows 3 (100), 4 (200), 2 (300)
    act(() => root.findByProps({ "data-col-sort": "B" }).props.onClick());
    const rowsAfterSort = root
      .findAllByType("tr")
      .filter((tr) => tr.props["data-row"] !== undefined)
      .slice(0, 4)
      .map((tr) => tr.props["data-row"]);
    expect(rowsAfterSort).toEqual([1, 3, 4, 2]);

    // Collapse row group starting at row 2 -> rows 3 and 4 hidden
    act(() => root.findByProps({ "data-row-group-toggle": 2 }).props.onClick());
    const visibleRowNums = root
      .findAllByType("tr")
      .filter((tr) => tr.props["data-row"] !== undefined)
      .map((tr) => tr.props["data-row"]);
    expect(visibleRowNums).toContain(2);
    expect(visibleRowNums).not.toContain(3);
    expect(visibleRowNums).not.toContain(4);

    // Open column organizer, hide column C, and move B left of A
    act(() => root.findByProps({ "data-sheet-columns-toggle": true }).props.onClick());
    act(() => root.findByProps({ "data-col-toggle": "C" }).props.onClick());
    expect(root.findAllByProps({ "data-col-header": "C" })).toHaveLength(0);
    act(() => root.findByProps({ "data-col-left": "B" }).props.onClick());
    const headerLetters = root
      .findAllByType("th")
      .filter((th) => th.props["data-col-header"] !== undefined)
      .slice(0, 2)
      .map((th) => th.props["data-col-header"]);
    expect(headerLetters).toEqual(["B", "A"]);
  });

  it("exports standalone HTML and copies Markdown", async () => {
    let exportedHtml = "";
    let exportedFile = "";
    let copiedMd = "";
    act(() => {
      renderer = create(
        <SheetView
          text={STATEMENT}
          mode="light"
          onExportHtml={(html, filename) => {
            exportedHtml = html;
            exportedFile = filename;
          }}
          onCopyMarkdown={(md) => {
            copiedMd = md;
          }}
        />,
      );
    });
    const { root } = renderer!;
    act(() => root.findByProps({ "data-sheet-export-html": true }).props.onClick());
    expect(exportedFile).toBe("income-statement.html");
    expect(exportedHtml).toContain("<!DOCTYPE html>");
    expect(exportedHtml).not.toContain("<script");
    expect(exportedHtml).toContain("Revenue beats costs");

    await act(async () => {
      await root.findByProps({ "data-sheet-copy-md": true }).props.onClick();
    });
    expect(copiedMd).toContain("| Line | Q1 |");
    expect(copiedMd).toContain("$75,000");
  });

  it("shows a non-destructive conflict banner when external text changes under a local draft", async () => {
    let resolveSave!: (ok: boolean) => void;
    const onSave = () =>
      new Promise<boolean>((resolve) => {
        resolveSave = resolve;
      });
    const inst = render(STATEMENT, onSave);
    act(() => cell(inst.root, "A2").props.onMouseDown({ shiftKey: false }));
    act(() => cell(inst.root, "B3").props.onMouseDown({ shiftKey: true }));
    act(() => inst.root.findByProps({ "data-sheet-insert-chart": true }).props.onClick());
    act(() => {
      inst.root.findByType("form").props.onSubmit({ preventDefault: () => {} });
    });

    // External update lands with a different value before our save resolves.
    const external = JSON.parse(STATEMENT);
    external.tabs[0].cells.B2 = 999000;
    act(() => {
      inst.update(<SheetView text={JSON.stringify(external)} mode="light" onSave={onSave} />);
    });
    expect(inst.root.findAllByProps({ "data-sheet-conflict": true })).toHaveLength(1);

    // Reload latest discards the draft and displays the external value.
    act(() => inst.root.findByProps({ "data-sheet-conflict-reload": true }).props.onClick());
    expect(inst.root.findAllByProps({ "data-sheet-conflict": true })).toHaveLength(0);
    expect(textOf(cell(inst.root, "B2"))).toBe("$999,000");
    await act(async () => {
      resolveSave(true);
    });
  });

  it("passes expectedRevision on save and preserves draft on server conflict", async () => {
    const calls: Array<{ contents: string; expectedRevision: string | undefined }> = [];
    const onSave = async (contents: string, expectedRevision?: string) => {
      calls.push({ contents, expectedRevision });
      return calls.length === 1 ? ("conflict" as const) : true;
    };
    const inst = render(STATEMENT, onSave);
    act(() => cell(inst.root, "A2").props.onMouseDown({ shiftKey: false }));
    act(() => cell(inst.root, "B3").props.onMouseDown({ shiftKey: true }));
    act(() => inst.root.findByProps({ "data-sheet-insert-chart": true }).props.onClick());
    await act(async () => {
      await inst.root.findByType("form").props.onSubmit({ preventDefault: () => {} });
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.expectedRevision).toMatch(/^r1-/);
    // Conflict banner stays visible with the draft intact.
    expect(inst.root.findAllByProps({ "data-sheet-conflict": true })).toHaveLength(1);

    // While refresh is still pending (incomingRevision === baseRevision), Keep my edits
    // is disabled and never sends an unfenced expectedRevision: undefined.
    const keepPending = inst.root.findByProps({ "data-sheet-conflict-keep": true });
    expect(keepPending.props.disabled).toBe(true);

    // Once the refreshed external text arrives, Keep my edits enables and fences with
    // the authoritative incomingRevision (never undefined).
    const external = JSON.parse(STATEMENT);
    external.tabs[0].cells.B2 = 123456;
    const refreshedText = JSON.stringify(external);
    act(() => {
      inst.update(<SheetView text={refreshedText} mode="light" onSave={onSave} />);
    });
    const keepReady = inst.root.findByProps({ "data-sheet-conflict-keep": true });
    expect(keepReady.props.disabled).toBe(false);
    await act(async () => {
      await keepReady.props.onClick();
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.expectedRevision).toMatch(/^r1-/);
    expect(calls[1]!.expectedRevision).not.toBe(calls[0]!.expectedRevision);
    expect(inst.root.findAllByProps({ "data-sheet-conflict": true })).toHaveLength(0);
  });

  it("isolates chart overrides across tabs, clears saved filters on All, and keeps summary rows pinned on sort", () => {
    const doc = JSON.stringify({
      title: "Multi-tab",
      tabs: [
        {
          name: "First",
          cells: {
            A1: "Item",
            B1: "Amount",
            A2: "Alpha",
            B2: 100,
            A3: "Beta",
            B3: 300,
            A4: "Total",
            B4: "=SUM(B2:B3)",
          },
          styles: { "A4:B4": { bold: true, topBorder: true } },
          charts: [
            {
              id: "chart-1",
              type: "bar",
              title: "First Chart",
              labels: "A2:A3",
              values: "B2:B3",
              filterValues: ["Alpha"],
            },
          ],
        },
        {
          name: "Second",
          cells: {
            A1: "Region",
            B1: "Sales",
            A2: "North",
            B2: 50,
            A3: "South",
            B3: 80,
          },
          charts: [
            {
              id: "chart-1",
              type: "bar",
              title: "Second Chart",
              labels: "A2:A3",
              values: "B2:B3",
            },
          ],
        },
      ],
    });
    const inst = render(doc);

    // Clicking "All" on First's chart-1 clears its saved filterValues: ["Alpha"].
    const barCount = () =>
      inst.root.findAll((node) => node.type === "span" && node.props.className === "office-bars-label")
        .length;
    expect(barCount()).toBe(1);
    act(() => inst.root.findByProps({ "data-chart-filter-all": "chart-1" }).props.onClick());
    expect(barCount()).toBe(2);

    // Filter First's chart-1 to Beta, then switch to Second: Second's chart-1 must NOT inherit Beta.
    act(() => inst.root.findByProps({ "data-chart-filter": "Beta" }).props.onClick());
    expect(barCount()).toBe(1);
    const tabs = inst.root.findAllByProps({ role: "tab" });
    act(() => tabs[1]!.props.onClick());
    expect(barCount()).toBe(2);

    // Switch back to First and sort column B descending: Total (row 4, topBorder) stays at the bottom.
    act(() => tabs[0]!.props.onClick());
    act(() => inst.root.findByProps({ "data-col-sort": "B" }).props.onClick()); // asc
    act(() => inst.root.findByProps({ "data-col-sort": "B" }).props.onClick()); // desc
    const bodyRows = inst.root.findByType("tbody").findAllByType("tr");
    const firstColValues = bodyRows
      .slice(0, 4)
      .map((tr) => textOf(tr.findAllByType("td")[0]!));
    expect(firstColValues).toEqual(["Item", "Beta", "Alpha", "Total"]);
  });

  it("blocks ordinary saves during conflict, calls onReload, surfaces export errors, keeps All reset chip, and pins hidden-border summaries", async () => {
    // 1) onReload called on server conflict and Reload latest; ordinary save blocked during conflict.
    let reloadCount = 0;
    const saveCalls: Array<string | undefined> = [];
    const onSave = async (_contents: string, expectedRevision?: string) => {
      saveCalls.push(expectedRevision);
      return "conflict" as const;
    };
    act(() => {
      renderer = create(
        <SheetView
          text={STATEMENT}
          mode="light"
          onSave={onSave}
          onReload={() => {
            reloadCount += 1;
          }}
        />,
      );
    });
    act(() => cell(renderer!.root, "A2").props.onMouseDown({ shiftKey: false }));
    act(() => cell(renderer!.root, "B3").props.onMouseDown({ shiftKey: true }));
    act(() => renderer!.root.findByProps({ "data-sheet-insert-chart": true }).props.onClick());
    await act(async () => {
      await renderer!.root.findByType("form").props.onSubmit({ preventDefault: () => {} });
    });
    expect(saveCalls).toHaveLength(1);
    expect(reloadCount).toBe(1);

    // Attempting an ordinary layout save while conflicted must not call onSave.
    act(() => renderer!.root.findByProps({ "data-sheet-columns-toggle": true }).props.onClick());
    await act(async () => {
      renderer!.root.findByProps({ "data-col-toggle": "B" }).props.onClick();
    });
    expect(saveCalls).toHaveLength(1);
    expect(
      renderer!.root
        .findAllByProps({ role: "alert" })
        .map(textOf)
        .join(" "),
    ).toContain("Resolve the conflict");

    // Clicking Reload latest invokes onReload again and clears conflict.
    act(() => renderer!.root.findByProps({ "data-sheet-conflict-reload": true }).props.onClick());
    expect(reloadCount).toBe(2);
    expect(renderer!.root.findAllByProps({ "data-sheet-conflict": true })).toHaveLength(0);

    // 2) Copy Markdown failure surfaces an alert cleanly without crashing.
    act(() => {
      renderer!.update(
        <SheetView
          text={STATEMENT}
          mode="light"
          onCopyMarkdown={() => Promise.reject(new Error("Clipboard denied"))}
        />,
      );
    });
    await act(async () => {
      await renderer!.root.findByProps({ "data-sheet-copy-md": true }).props.onClick();
    });
    expect(textOf(renderer!.root.findByProps({ role: "alert" }))).toContain("Clipboard denied");

    // 3) Single-category chart with an active filter still shows the All reset chip,
    //    and a summary row whose topBorder is on a hidden column still stays pinned on sort.
    const edgeDoc = JSON.stringify({
      title: "Edge",
      tabs: [
        {
          name: "Main",
          cells: {
            A1: "Item",
            B1: "Amount",
            C1: "Marker",
            A2: "Zeta",
            B2: 300,
            C2: "",
            A3: "Alpha",
            B3: 100,
            C3: "",
            A4: "Total",
            B4: 400,
            C4: "sum",
          },
          hiddenColumns: ["C"],
          styles: { C4: { topBorder: true } },
          charts: [
            {
              id: "single-filtered",
              type: "bar",
              title: "Filtered",
              labels: "A2:A2",
              values: "B2:B2",
              filterValues: ["NonExistent"],
            },
          ],
        },
      ],
    });
    act(() => {
      renderer!.update(<SheetView text={edgeDoc} mode="light" />);
    });
    expect(
      renderer!.root.findAllByProps({ "data-chart-filter-all": "single-filtered" }),
    ).toHaveLength(1);
    act(() => renderer!.root.findByProps({ "data-col-sort": "B" }).props.onClick());
    const sortedFirstCol = renderer!.root
      .findByType("tbody")
      .findAllByType("tr")
      .slice(0, 4)
      .map((tr) => textOf(tr.findAllByType("td")[0]!));
    expect(sortedFirstCol).toEqual(["Item", "Alpha", "Zeta", "Total"]);
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
    // POSIX filenames with literal backslashes (including drive-like prefixes) must not be rewritten.
    expect(sheetRelativePath("/work/app", "foo\\bar.sheet.json")).toBe("foo\\bar.sheet.json");
    expect(sheetRelativePath("/work/app", "/work/app/foo\\bar.sheet.json")).toBe(
      "foo\\bar.sheet.json",
    );
    expect(sheetRelativePath("/work/app", "C:\\bar.sheet.json")).toBe("C:\\bar.sheet.json");
    expect(sheetRelativePath("/work/app", "/work/app/C:\\bar.sheet.json")).toBe(
      "C:\\bar.sheet.json",
    );
  });
});
