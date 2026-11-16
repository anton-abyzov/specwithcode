import { createHash } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";

import { readHtmlRenderLinkRequest } from "@specweave-studio/shared/htmlRender";

import {
  HTML_FILE_LINK_SCRIPT,
  HTML_FILE_LOCKED_POLICY,
  HTML_FILE_RELAY_SCRIPT,
  htmlFrameMode,
  htmlPreviewPagePath,
  htmlPreviewResponseHeaders,
  htmlPreviewWrapperDocument,
  htmlPreviewWrapperPolicy,
  injectHtmlFileLinkScript,
} from "./HtmlFilePreview.ts";

const TOP_POLICY = "sandbox allow-scripts allow-forms allow-popups";

describe("htmlFrameMode", () => {
  const mode = (search: string, secFetchDest: string | undefined) =>
    htmlFrameMode({ searchParams: new URLSearchParams(search), secFetchDest });

  it("serves the wrapper for the app frame and for an iframe navigation", () => {
    expect(mode("studio-frame=1", "document")).toBe("wrapper");
    expect(mode("studio-frame=1", "iframe")).toBe("wrapper");
    expect(mode("", "iframe")).toBe("wrapper");
  });

  it("locks the inner page even when the destination is a document", () => {
    expect(mode("studio-frame=page", "document")).toBe("locked");
    expect(mode("studio-frame=page", undefined)).toBe("locked");
  });

  it("keeps a top-level document on today's policy", () => {
    expect(mode("", "document")).toBe("top");
    expect(mode("workspace-revision=1", "document")).toBe("top");
  });

  it("locks a fetch and a request with no fetch destination", () => {
    expect(mode("", "empty")).toBe("locked");
    expect(mode("", undefined)).toBe("locked");
    expect(mode("", "script")).toBe("locked");
  });
});

describe("html preview documents", () => {
  it("frames the locked page from a same-origin path", () => {
    const url = new URL("http://127.0.0.1:9/api/assets/token/page.html?workspace-revision=1");
    expect(htmlPreviewPagePath(url)).toBe(
      "/api/assets/token/page.html?workspace-revision=1&studio-frame=page",
    );
    const document = htmlPreviewWrapperDocument(htmlPreviewPagePath(url));
    expect(document).toContain('sandbox="allow-scripts allow-forms"');
    expect(document).not.toContain("allow-popups");
    expect(document).toContain(
      'src="/api/assets/token/page.html?workspace-revision=1&amp;studio-frame=page"',
    );
    expect(document).toContain(HTML_FILE_RELAY_SCRIPT);
    expect(document).not.toContain("data-studio-file-links");
  });

  it("hashes the relay script into the wrapper policy", () => {
    const hash = createHash("sha256").update(HTML_FILE_RELAY_SCRIPT).digest("base64");
    const policy = htmlPreviewWrapperPolicy();
    expect(policy).toBe(
      `sandbox allow-scripts; default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; frame-src 'self'`,
    );
    expect(policy).not.toContain("allow-popups");
    expect(policy).not.toContain("allow-forms");
  });

  it("locks a framed page and leaves a top-level page on today's policy", () => {
    expect(htmlPreviewResponseHeaders("locked", TOP_POLICY)).toMatchObject({
      "Cache-Control": "private, no-store",
      "Content-Security-Policy": HTML_FILE_LOCKED_POLICY,
      Vary: "Sec-Fetch-Dest",
    });
    expect(htmlPreviewResponseHeaders("top", TOP_POLICY)["Content-Security-Policy"]).toBe(
      TOP_POLICY,
    );
    expect(HTML_FILE_LOCKED_POLICY).not.toContain("allow-popups");
    expect(HTML_FILE_LOCKED_POLICY).toContain("connect-src 'none'");
    expect(HTML_FILE_LOCKED_POLICY).toContain("form-action 'none'");
  });

  it("adds the link script once, before the body end", () => {
    const page = injectHtmlFileLinkScript("<html><body><a href='https://example.com'>x</a></body></html>");
    expect(page).toContain(`<script data-studio-file-links>${HTML_FILE_LINK_SCRIPT}</script></body>`);
    expect(injectHtmlFileLinkScript(page)).toBe(page);
    expect(injectHtmlFileLinkScript("<p>no body</p>")).toContain("data-studio-file-links");
  });

  it("asks the app to open a different-site link the reader clicks", () => {
    expect(HTML_FILE_LINK_SCRIPT).toContain('method:"ui/open-link"');
    expect(HTML_FILE_LINK_SCRIPT).toContain("parent===window");
    expect(HTML_FILE_LINK_SCRIPT).toContain("u.host===location.host");
    const posted = {
      jsonrpc: "2.0",
      id: "studio-file-link-1",
      method: "ui/open-link",
      params: { url: "https://example.com/docs" },
    };
    expect(readHtmlRenderLinkRequest(posted)?.url).toBe("https://example.com/docs");
  });
});
