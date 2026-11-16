import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
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
    const linkHash = createHash("sha256").update(HTML_FILE_LINK_SCRIPT).digest("base64");
    expect(HTML_FILE_LOCKED_POLICY).toContain(`script-src 'sha256-${linkHash}'`);
    expect(HTML_FILE_LOCKED_POLICY).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(HTML_FILE_LOCKED_POLICY).not.toMatch(/script-src[^;]*unsafe-eval/);
    expect(HTML_FILE_LOCKED_POLICY).not.toMatch(/script-src[^;]*'self'/);
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

  it("still adds the link script when the page only mentions the marker", () => {
    const page = "<p>data-studio-file-links</p>";
    const once = injectHtmlFileLinkScript(page);
    expect(once).toContain(HTML_FILE_LINK_SCRIPT);
    expect(injectHtmlFileLinkScript(once)).toBe(once);
  });
});

function anchor(href: string) {
  return { tagName: "A", href, parentElement: null };
}

function installLinkScript(top = false) {
  const posted: unknown[] = [];
  const parent = { postMessage(data: unknown) { posted.push(data); } };
  const window = {
    location: {
      href: "http://127.0.0.1:9/file/page.html?studio-frame=page",
      host: "127.0.0.1:9",
    },
    parent: top ? (null as unknown) : parent,
  };
  if (top) window.parent = window;
  let listener: ((event: Record<string, unknown>) => void) | null = null;
  runInNewContext(HTML_FILE_LINK_SCRIPT, {
    window,
    parent: window.parent,
    location: window.location,
    addEventListener: (_type: string, fn: (event: Record<string, unknown>) => void) => {
      listener = fn;
    },
    URL,
  });
  return {
    posted,
    click(target: { tagName: string; href?: string; parentElement: unknown }, init: Record<string, unknown> = {}) {
      const event = {
        isTrusted: init.trusted ?? true,
        button: init.button ?? 0,
        defaultPrevented: false,
        metaKey: init.metaKey ?? false,
        ctrlKey: init.ctrlKey ?? false,
        shiftKey: init.shiftKey ?? false,
        altKey: init.altKey ?? false,
        target,
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      listener?.(event);
      return event;
    },
  };
}

describe("the link script, running", () => {
  it("opens the link the reader clicks and ignores the rest", () => {
    const page = installLinkScript();
    const opened = page.click(anchor("https://example.com/docs"));
    expect(opened.defaultPrevented).toBe(true);
    expect(readHtmlRenderLinkRequest(page.posted[0])?.url).toBe("https://example.com/docs");
    expect(page.posted).toHaveLength(1);

    page.click(anchor("https://example.com/next"));
    expect(readHtmlRenderLinkRequest(page.posted[1])?.id).toBe("studio-file-link-2");

    const before = page.posted.length;
    page.click(anchor("https://phishing.example/"), { trusted: false });
    page.click(anchor("https://phishing.example/"), { metaKey: true });
    page.click(anchor("https://phishing.example/"), { button: 1 });
    page.click(anchor("http://127.0.0.1:9/other.html"));
    page.click(anchor("javascript:alert(1)"));
    page.click({ tagName: "BUTTON", parentElement: null });
    page.click({ tagName: "SPAN", parentElement: anchor("https://example.com/nested") });
    expect(page.posted).toHaveLength(before + 1);
    expect(readHtmlRenderLinkRequest(page.posted.at(-1))?.url).toBe("https://example.com/nested");
  });

  it("does nothing when the page is the top window", () => {
    const page = installLinkScript(true);
    page.click(anchor("https://example.com/docs"));
    expect(page.posted).toHaveLength(0);
  });
});

function installRelay(top = false) {
  const childInbox: unknown[] = [];
  const parentInbox: unknown[] = [];
  const child = { postMessage(data: unknown) { childInbox.push(data); } };
  const parent = { postMessage(data: unknown) { parentInbox.push(data); } };
  const iframe = { contentWindow: child };
  const window = {
    parent: top ? (null as unknown) : parent,
    document: { querySelector: () => iframe },
  };
  if (top) window.parent = window;
  let listener: ((event: { source: unknown; data: unknown }) => void) | null = null;
  runInNewContext(HTML_FILE_RELAY_SCRIPT, {
    window,
    parent: window.parent,
    document: window.document,
    addEventListener: (_type: string, fn: (event: { source: unknown; data: unknown }) => void) => {
      listener = fn;
    },
  });
  return {
    childInbox,
    parentInbox,
    send(source: unknown, data: unknown) {
      listener?.({ source, data });
    },
    child,
    parent,
  };
}

describe("the relay, running", () => {
  it("forwards a file-link open and drops everything else", () => {
    const relay = installRelay();
    relay.send(relay.child, {
      jsonrpc: "2.0",
      id: "studio-file-link-1",
      method: "ui/open-link",
      params: { url: "https://example.com/docs" },
    });
    expect(relay.parentInbox).toEqual([
      {
        jsonrpc: "2.0",
        id: "studio-file-link-1",
        method: "ui/open-link",
        params: { url: "https://example.com/docs" },
      },
    ]);
    relay.send(relay.child, {
      jsonrpc: "2.0",
      id: "x",
      method: "ui/open-link",
      params: { url: "https://phishing.example/" },
    });
    relay.send(relay.child, {
      jsonrpc: "2.0",
      id: "studio-file-link-2",
      method: "specwithcode/open-file",
      params: { path: "/etc/passwd" },
    });
    relay.send(relay.child, {
      jsonrpc: "2.0",
      id: "studio-file-link-3",
      method: "ui/open-link",
      params: { url: "javascript:alert(1)" },
    });
    expect(relay.parentInbox).toHaveLength(1);
    relay.send(relay.parent, { method: "studio/probe-cmd", params: { action: "form" } });
    expect(relay.childInbox).toEqual([{ method: "studio/probe-cmd", params: { action: "form" } }]);
  });

  it("does not forward when the wrapper is the top window", () => {
    const relay = installRelay(true);
    relay.send(relay.child, {
      jsonrpc: "2.0",
      id: "studio-file-link-1",
      method: "ui/open-link",
      params: { url: "https://example.com/docs" },
    });
    expect(relay.parentInbox).toHaveLength(0);
  });
});
