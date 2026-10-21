import ReactMarkdown from "react-markdown";
import { renderToStaticMarkup } from "react-dom/server";
import rehypeRaw from "rehype-raw";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vite-plus/test";

import { remarkDocumentReadability } from "./documentReadability";

const render = (text: string) =>
  renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkDocumentReadability]}
      rehypePlugins={[rehypeRaw]}
    >
      {text}
    </ReactMarkdown>,
  );

const COMMIT = "4be1f0c9d2a7e65b31c8f09a7d4e2b6c58a1f3e0";
const DIGEST = "sha256:0d3c7e91b5a24f68c1e0973b2d5a8f4e6c19b07a3d2e58f1c4b6a9e07d3f2c81";

describe("remarkDocumentReadability", () => {
  it("gives each statement line its own paragraph, as the agent wrote them", () => {
    const html = render(
      [
        "# Release verified",
        `API merged at ${COMMIT}; release successful. Six API pods Ready, zero restarts, exact tag and registry digests verified.`,
        "Coach check at 04:16:13Z: owner report 403, clearance 200, zero rows, zero production mutations.",
        "Private report: /Users/example/Downloads/release/report.html",
      ].join("\n"),
    );
    expect(html.match(/<p>/g)).toHaveLength(3);
    expect(html).toContain(`<code>${COMMIT}</code>`);
    // Shown in full, never shortened to a file-name chip.
    expect(html).toContain("<code>/Users/example/Downloads/release/report.html</code>");
  });

  it("keeps hard-wrapped prose as one paragraph", () => {
    const wrapped = [
      "The import reads every registration export in the folder and keeps the",
      "newest row for each player. Payments that Square reports as refunded are",
      "subtracted once.",
    ].join("\n");
    expect(render(wrapped)).toBe(`<p>${wrapped}</p>`);
  });

  it("keeps two sentence lines joined: a wrap can fall on a sentence end", () => {
    const wrapped =
      "The import keeps the newest row and keeps it.\nPayments that Square refunds are subtracted.";
    expect(render(wrapped)).toBe(`<p>${wrapped}</p>`);
  });

  it("keeps wrapped prose joined when a line only looks like a label or ends in a slash", () => {
    const note =
      "Note: run the migration before you deploy, otherwise the\n`users` table stays locked.\nThen retry.";
    expect(render(note)).not.toContain("<br");
    const slash = "Measure the input/output\nLatency of each call, then the\nThroughput.";
    expect(render(slash)).not.toContain("<br");
  });

  it("finds a line's last word without backtracking on a long blob", () => {
    const blob = `Payload: ${"A".repeat(60_000)}\nNext line.\nLast line.`;
    const started = performance.now();
    render(blob);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("leaves a paragraph with inline HTML as one block", () => {
    const html = render(
      `${"Long statement that ends here. ".repeat(4)}<span title="x">Foo.\nBar</span> baz.\nThird line.`,
    );
    expect(html.match(/<p>/g)).toHaveLength(1);
    expect(html).toContain('<span title="x">Foo.\nBar</span>');
  });

  it("keeps a block of short label lines together, one per line", () => {
    const html = render("Owner: club office\nStatus: waiting for the export");
    expect(html).toBe("<p>Owner: club office<br/>\nStatus: waiting for the export</p>");
  });

  it("keeps an intro line and its facts one per line", () => {
    const html = render("Current state:\nOwner: club office\nStatus: waiting for the export");
    expect(html.match(/<br\/>/g)).toHaveLength(2);
  });

  it("never splits or rewrites a glued token", () => {
    // The source lost its spaces; the reader shows exactly what the file says.
    const html = render(`API PR480 merged${COMMIT}; health200.`);
    expect(html).toBe(`<p>API PR480 merged${COMMIT}; health200.</p>`);
  });

  it("sets standalone digests apart and leaves code, links and short hashes alone", () => {
    const html = render(
      `Digest ${DIGEST}, short 4be1f0c, \`${COMMIT}\` and [proof](/Users/example/proof.md).`,
    );
    expect(html).toContain(`<code>${DIGEST}</code>`);
    expect(html).toContain("short 4be1f0c,");
    expect(html.match(/<code>/g)).toHaveLength(2);
    expect(html).toContain('<a href="/Users/example/proof.md">proof</a>');
  });

  it("sets only whole home paths as code, without their closing punctuation", () => {
    const html = render(
      "Argo Synced/Healthy and/or /api/v1/users; drafts in ~/Downloads/drafts/message.md….",
    );
    expect(html).toContain("<code>~/Downloads/drafts/message.md</code>….");
    expect(html.match(/<code>/g)).toHaveLength(1);
  });

  it.each([
    "Saved to /Users/me/My Documents/report.md today.",
    "Saved to /Users/me/files/report(1).md today.",
    "Saved to ~/Downloads/it's/report.md today.",
    "Saved to /Users/me/_drafts/a_b_.md today.",
    "Saved to /Users/me/Downloads/folder today.",
  ])("leaves a path it cannot be sure of as plain text: %s", (line) => {
    expect(render(line)).not.toContain("<code>");
  });

  it("leaves list items and fenced code untouched", () => {
    const list = "- Done.\n  Next step.";
    expect(render(list)).toBe("<ul>\n<li>Done.\nNext step.</li>\n</ul>");
    const fence = `\`\`\`\n${COMMIT}\n/Users/example/file.md\n\`\`\``;
    expect(render(fence)).toBe(`<pre><code>${COMMIT}\n/Users/example/file.md\n</code></pre>`);
  });
});
