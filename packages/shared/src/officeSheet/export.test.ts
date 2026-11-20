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

  it("computes deterministic content revisions", () => {
    const a = sheetContentRevision('{"title":"A"}');
    const b = sheetContentRevision('{"title":"A"}');
    const c = sheetContentRevision('{"title":"B"}');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith("r1-")).toBe(true);
  });
});
