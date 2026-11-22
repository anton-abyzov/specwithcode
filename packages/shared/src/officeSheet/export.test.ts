import { describe, expect, it } from "vite-plus/test";

import { exportSheetToMarkdown, exportSheetToStandaloneHtml } from "./export.ts";
import { sheetContentRevision, validateSheetDocument } from "./model.ts";

describe("sheet exporters and organization metadata", () => {
  it("exports zero-CDN, zero-script, XSS-safe standalone HTML and GFM Markdown", () => {
    const checked = validateSheetDocument({
      title: 'Q4 <script>alert(1)</script> "Plan"',
      tabs: [
        {
          name: "Summary",
          cells: {
            A1: "Item",
            B1: "SecretCol",
            C1: "Amount",
            D1: "Link",
            A2: "Infra | Core",
            B2: "hidden",
            C2: 1200,
            D2: "https://example.com/report",
            A3: "<b>Ops</b>",
            B3: "hidden2",
            C3: 800,
            D3: "javascript:alert(1)",
          },
          formats: { "C2:C3": { kind: "currency", currency: "USD", decimals: 0 } },
          styles: { "A1:D1": { heading: true } },
          columnOrder: ["A", "C", "D", "B"],
          hiddenColumns: ["B"],
          rowGroups: [{ id: "ops", label: "Details", startRow: 2, endRow: 3, collapsed: false }],
          charts: [
            {
              id: "c1",
              type: "column",
              title: "Spend by item",
              labels: "A2:A3",
              values: "C2:C3",
            },
          ],
        },
      ],
    });
    if (!checked.ok) throw new Error(checked.error);
    const doc = checked.document;

    const md = exportSheetToMarkdown(doc);
    expect(md).toContain("| Item | Amount | Link |");
    expect(md).not.toContain("SecretCol");
    expect(md).toContain("Infra \\| Core");
    expect(md).toContain("&lt;b&gt;Ops&lt;/b&gt;");
    expect(md).not.toContain("<b>Ops</b>");
    expect(md).not.toContain("<script>");
    expect(md).toContain("### Chart: Spend by item");

    const html = exportSheetToStandaloneHtml(doc, { mode: "dark" });
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).not.toContain("<script>");
    expect(html).not.toMatch(/https?:\/\/cdn\./i);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;b&gt;Ops&lt;/b&gt;");
    expect(html).toContain('href="https://example.com/report"');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("prefers-reduced-motion: reduce");
    expect(html).not.toContain("SecretCol");
  });

  it("compacts sparse sheets instead of materializing millions of empty cells", () => {
    const checked = validateSheetDocument({
      title: "Sparse Export",
      tabs: [
        {
          name: "Far",
          cells: { A1: "Start", ZZ100000: "End" },
        },
      ],
    });
    if (!checked.ok) throw new Error(checked.error);
    const md = exportSheetToMarkdown(checked.document);
    expect(md).toContain("Start");
    expect(md).toContain("End");
    expect(md.length).toBeLessThan(1000);

    const html = exportSheetToStandaloneHtml(checked.document);
    expect(html).toContain("Start");
    expect(html).toContain("End");
    expect(html.length).toBeLessThan(10_000);
  });

  it("renders signed negative column bars below the zero axis in HTML export", () => {
    const checked = validateSheetDocument({
      title: "PnL",
      tabs: [
        {
          name: "Summary",
          cells: {
            A1: "Gain",
            B1: 100,
            A2: "Flat",
            B2: 0,
            A3: "Loss",
            B3: -50,
          },
          charts: [
            {
              id: "pnl",
              type: "column",
              title: "Profit and Loss",
              labels: "A1:A3",
              values: "B1:B3",
            },
          ],
        },
      ],
    });
    if (!checked.ok) throw new Error(checked.error);
    const html = exportSheetToStandaloneHtml(checked.document);
    const rects = [...html.matchAll(/<rect class="svg-bar[^"]*"[^>]*y="([^"]+)"[^>]*height="([^"]+)"/g)];
    expect(rects).toHaveLength(3);
    const [, flatRect, lossRect] = rects;
    expect(Number(lossRect![2])).toBeGreaterThan(Number(flatRect![2]) * 5);
  });

  it("animates each chart type with CSS only and ends on the full picture", () => {
    const chartsFor = (animate: boolean) => {
      const checked = validateSheetDocument({
        title: "Motion",
        tabs: [
          {
            name: "Data",
            cells: { A1: "North", B1: 40, A2: "South", B2: 0, A3: "East", B3: 25, A4: "West", B4: 35 },
            charts: (["bar", "column", "line", "donut"] as const).map((type) => ({
              id: type,
              type,
              title: `By region ${type}`,
              labels: "A1:A4",
              values: "B1:B4",
              ...(animate ? {} : { animate: false }),
            })),
          },
        ],
      });
      if (!checked.ok) throw new Error(checked.error);
      return exportSheetToStandaloneHtml(checked.document);
    };

    const moving = chartsFor(true);
    expect(moving).not.toMatch(/<script/i);
    expect(moving).toContain('class="bar-fill animated"');
    expect(moving).toContain('class="svg-bar animated"');
    expect(moving).toMatch(/<path class="svg-line animated" pathLength="1"/);
    expect(moving).toMatch(/<circle class="svg-sweep animated"/);
    expect(moving).toContain("@keyframes draw");
    expect(moving).toMatch(/prefers-reduced-motion: reduce\) \{\s*\.animated \{ animation: none !important; \}/);
    // Marks start one after another.
    expect(moving).toContain('style="--d:0ms"');
    expect(moving).toContain('style="--d:34ms"');
    // Every gradient and mask id is used by exactly the chart that defines it.
    const ids = [...moving.matchAll(/ id="((?:fade|sweep)-[^"]+)"/g)].map((match) => match[1]!);
    expect(ids).toEqual(["fade-0-2", "sweep-0-3"]);
    for (const id of ids) expect(moving.split(`url(#${id})`)).toHaveLength(2);

    const still = chartsFor(false);
    expect(still).not.toMatch(/class="[^"]*\banimated\b/);
    expect(still).toContain('class="bar-fill"');
    expect(still).toMatch(/<path class="svg-line" pathLength="1"/);
  });

  it("gives a donut slice and its legend row the same colour when a value is zero", () => {
    const checked = validateSheetDocument({
      title: "Shares",
      tabs: [
        {
          name: "Data",
          cells: { A1: "Bikes", B1: 50, A2: "Parts", B2: 0, A3: "Service", B3: 30, A4: "Rentals", B4: 20 },
          charts: [{ id: "mix", type: "donut", title: "Mix", labels: "A1:A4", values: "B1:B4" }],
        },
      ],
    });
    if (!checked.ok) throw new Error(checked.error);
    const html = exportSheetToStandaloneHtml(checked.document);
    const ring = [...html.matchAll(/<circle cx="80" cy="80" r="58" fill="none" stroke="([^"]+)"/g)].map(
      (match) => match[1],
    );
    const legend = [...html.matchAll(/<span class="swatch" style="background:([^"]+)"><\/span>\s*<span class="legend-label">([^<]+)</g)];
    expect(ring).toHaveLength(3);
    expect(legend.map((match) => match[2])).toEqual(["Bikes", "Service", "Rentals"]);
    expect(legend.map((match) => match[1])).toEqual(ring);
  });

  it("escapes Markdown link, image, and inline formatting syntax in cells", () => {
    const checked = validateSheetDocument({
      title: "Escaping",
      tabs: [
        {
          name: "Main",
          cells: {
            A1: "Note",
            B1: "Delta",
            A2: "[click](https://evil.test) ![x](https://evil.test/p.png) *b* _i_ `c` ~s~",
            B2: -100,
          },
        },
      ],
    });
    if (!checked.ok) throw new Error(checked.error);
    const md = exportSheetToMarkdown(checked.document);
    expect(md).toContain("\\[click\\](https://evil.test)");
    expect(md).toContain("\\!\\[x\\](https://evil.test/p.png)");
    expect(md).toContain("\\*b\\*");
    expect(md).toContain("\\_i\\_");
    expect(md).toContain("\\`c\\`");
    expect(md).toContain("\\~s\\~");
    expect(md).toContain("| -100 |");
  });

  it("normalizes standalone CR line breaks in Markdown titles, tabs, and cells", () => {
    const checked = validateSheetDocument({
      title: "Line1\rLine2",
      tabs: [
        {
          name: "Main",
          cells: {
            A1: "Col\rHead",
            A2: "Row\rValue\r\nNext",
          },
        },
      ],
    });
    if (!checked.ok) throw new Error(checked.error);
    const md = exportSheetToMarkdown(checked.document);
    expect(md).not.toContain("\r");
    expect(md).toContain("# Line1 Line2");
    expect(md).toContain("| Col Head |");
    expect(md).toContain("| Row Value Next |");
  });

  it("computes deterministic content revisions", () => {
    const a = sheetContentRevision('{"title":"A"}');
    const b = sheetContentRevision('{"title":"A"}');
    const c = sheetContentRevision('{"title":"B"}');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith("r1-")).toBe(true);
  });

  it("keeps a sliver of a donut visible", () => {
    const checked = validateSheetDocument({
      title: "Sliver",
      tabs: [
        {
          name: "Main",
          cells: { A1: "Small", B1: 1, A2: "Large", B2: 399, A3: "Tiny", B3: 0.004 },
          charts: [{ id: "ring", type: "donut", title: "Share", labels: "A1:A3", values: "B1:B3" }],
        },
      ],
    });
    if (!checked.ok) throw new Error(checked.error);
    const html = exportSheetToStandaloneHtml(checked.document, { mode: "light" });
    const dashes = [...html.matchAll(/stroke-dasharray="([\d.]+) /g)].map((match) => Number(match[1]));
    expect(dashes.length).toBeGreaterThanOrEqual(3);
    expect(dashes.every((dash) => dash >= 0.75)).toBe(true);
  });
});
