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

  it("computes deterministic content revisions", () => {
    const a = sheetContentRevision('{"title":"A"}');
    const b = sheetContentRevision('{"title":"A"}');
    const c = sheetContentRevision('{"title":"B"}');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith("r1-")).toBe(true);
  });
});
