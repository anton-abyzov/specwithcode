// @effect-diagnostics-next-line nodeBuiltinImport:off -- a test that reads the stylesheet.
import * as NodeFS from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/hooks/useHtmlRenderTheme", () => ({
  useHtmlRenderTheme: () => ({ appearance: "dark", variables: { "--background": "#111" } }),
}));

import { BrowserDocumentFrame } from "./BrowserDocumentFrame";

const css = NodeFS.readFileSync(new URL("../../index.css", import.meta.url), "utf8");

function rule(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `${selector} is defined`).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf("}", start));
}

describe("BrowserDocumentFrame", () => {
  it("opens an HTML report on the shared report page, at the wide measure", () => {
    const html = renderToStaticMarkup(
      <BrowserDocumentFrame src="https://x.test/r.html" title="Scorecard" pdf={false} htmlRender />,
    );
    expect(html).toContain('class="report-reader-body" data-html-render-page="true"');
    expect(html).toContain('class="report-document-page" data-measure="wide"');
    expect(html).toContain("report-html-frame");
  });

  it("leaves other HTML files as a plain sandboxed frame", () => {
    const html = renderToStaticMarkup(
      <BrowserDocumentFrame src="https://x.test/page.html" title="Page" pdf={false} />,
    );
    expect(html).not.toContain("report-document-page");
    expect(html).toContain('sandbox="allow-scripts allow-forms allow-popups"');
  });
});

describe("the shared report page", () => {
  it("keeps its end room inside the scroll area", () => {
    // The scroller is a flex row; a stretched page clips its own bottom padding.
    const page = rule(".report-document-page");
    expect(page).toContain("align-self: flex-start;");
    expect(page).toContain(
      "padding: var(--report-page-top) var(--report-page-inline) var(--report-page-end);",
    );
  });

  it("sizes the page from the shared tokens", () => {
    expect(rule(".report-document-page")).toContain("var(--report-measure)");
    expect(rule('.report-document-page[data-measure="wide"]')).toContain(
      "var(--report-measure-wide)",
    );
  });
});
