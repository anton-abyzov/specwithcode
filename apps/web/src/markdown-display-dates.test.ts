import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vite-plus/test";
import { remarkDisplayDates } from "./markdown-display-dates";

function render(markdown: string) {
  return renderToStaticMarkup(
    createElement(ReactMarkdown, {
      remarkPlugins: [
        remarkGfm,
        [
          remarkDisplayDates,
          {
            timestampFormat: "12-hour",
            locale: "en-US",
            timeZone: "America/New_York",
          },
        ],
      ],
      children: markdown,
    }),
  );
}

describe("remarkDisplayDates", () => {
  it("formats date text in headings, emphasis, nested lists and tables", () => {
    const html = render(
      "# 2026-10-13\n\n**2026-10-13**\n\n- 2026-10-13\n  - 2026-10-18T03:58:37.000Z\n\n| Day |\n| --- |\n| 2026-10-13 |",
    );
    expect(html.match(/<time /g)).toHaveLength(5);
    expect(html).toContain('dateTime="2026-10-18T03:58:37.000Z"');
    expect(html).toContain('data-markdown-copy="2026-10-18T03:58:37.000Z"');
    expect(html).toContain("Oct 17, 2026, 11:58:37 PM EDT");
    expect(html).toContain("Oct 13, 2026");
    expect(html).toContain("<li><time");
    expect(html).toContain("<td><time");
  });

  it.each([
    "`2026-10-13`",
    '```json\n{"date":"2026-10-13"}\n```',
    "    2026-10-13",
    "[2026-10-13](https://example.com/2026-10-13)",
    "[2026-10-13][date]\n\n[date]: https://example.com",
    "<https://example.com/2026-10-13>",
    "<span>2026-10-13</span>",
    "Before <span>**2026-10-13**</span> after",
    "<table><tr><td>2026-10-13</td></tr></table>",
    "/tmp/2026-10-13.csv build-2026-10-13 2026-10-13.txt",
    "2026-02-30 2026-10-13T12:45 10/13/26",
  ])("preserves literal or ambiguous material: %s", (source) => {
    expect(render(source)).not.toContain("<time ");
  });

  it("preserves ordered starts and task-list checkboxes", () => {
    const html = render("98. 2026-10-13\n99. 2026-10-14\n\n- [x] 2026-10-13\n- [ ] 2026-10-14");
    expect(html).toContain('<ol start="98">');
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html.match(/<time /g)).toHaveLength(4);
  });

  it("keeps incomplete timestamps literal while streaming", () => {
    for (const partial of ["2026-10-18T", "2026-10-18T03:58:", "2026-10-18T03:58:37."]) {
      expect(render(partial)).not.toContain("<time ");
    }
    expect(render("2026-10-18T03:58:37.000Z")).toContain("<time ");
  });
});
