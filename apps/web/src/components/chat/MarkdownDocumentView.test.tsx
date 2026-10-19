import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { MarkdownDocumentView } from "./ReportReader";

const RESEARCH = [
  "---",
  "title: Project joining, folder handoff and machine pairing",
  "date: October 19, 2026",
  "session: Claude desktop local_9f3ef3f8-980e-42bd-880e-20ea017297a5",
  "---",
  "",
  "# Project joining, folder handoff and machine pairing",
  "",
  "**Verdict.** Build three things.",
].join("\n");

const render = (text: string) =>
  renderToStaticMarkup(
    <MarkdownDocumentView text={text} renderMarkdown={(markdown) => <pre>{markdown}</pre>} />,
  );

describe("MarkdownDocumentView", () => {
  it("shows a report's frontmatter as a title and property table, not as prose", () => {
    const html = render(RESEARCH);
    expect(html).toContain(
      '<h1 class="report-document-title">Project joining, folder handoff and machine pairing</h1>',
    );
    expect(html).toContain('data-report-properties="true"');
    expect(html).toContain(">Session</dt>");
    expect(html).toContain("local_9f3ef3f8-980e-42bd-880e-20ea017297a5");
    // The body renders once, without the frontmatter or a second title.
    expect(html).toContain(
      '<div class="report-document-prose" data-markdown-body="true"><pre>**Verdict.** Build three things.</pre></div>',
    );
    expect(html).not.toContain("title:");
    expect(html.match(/machine pairing/g)).toHaveLength(1);
  });

  it("renders a file without frontmatter as written", () => {
    const html = render("# Notes\n\nBody.");
    expect(html).not.toContain("report-document-title");
    expect(html).not.toContain("report-document-properties");
    expect(html).toContain("<pre># Notes\n\nBody.</pre>");
  });
});
