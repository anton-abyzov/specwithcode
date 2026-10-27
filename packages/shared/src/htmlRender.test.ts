import { describe, expect, it, vi } from "vite-plus/test";

import {
  HTML_RENDER_EXACT_COPY_SCRIPT,
  HTML_RENDER_MAX_HEIGHT,
  htmlRenderFrameHeight,
  htmlRenderReferencesEqual,
  htmlRenderTheme,
  htmlRenderThemeFragment,
  htmlVisualDocument,
  injectHtmlRenderBootstrap,
  isHtmlVisualDocument,
  isHtmlVisualSvg,
  htmlRenderThemeMessage,
  legacyLocalPathFromOpenLink,
  normalizeEvidencePath,
  readHtmlRenderContentHeight,
  readHtmlRenderFileRequest,
  readHtmlRenderLinkRequest,
  readHtmlRenderReference,
} from "./htmlRender.ts";
import { STUDIO_CODE_DARK_THEME_COLORS, STUDIO_CODE_LIGHT_THEME_COLORS } from "./themePalettes.ts";
import { htmlRenderFromToolItem } from "./toolOutput.ts";

const reference = { attachmentId: "thread-abc-123.html", title: "Chart", height: 420 };

describe("injectHtmlRenderBootstrap", () => {
  it("puts the theme ahead of the page's own head content", () => {
    const html =
      "<!doctype html><html><head><style>:root{--background:red}</style></head><body>x</body></html>";
    const injected = injectHtmlRenderBootstrap(html);
    const themeAt = injected.indexOf('<style id="studio-theme">');
    expect(themeAt).toBeGreaterThan(injected.indexOf("<head>"));
    expect(themeAt).toBeLessThan(injected.indexOf(":root{--background:red}"));
    expect(injected).toContain('<meta charset="utf-8">');
    expect(injected).toContain('name="viewport"');
  });

  it("wraps fragments without a head and keeps existing meta tags", () => {
    const fragment =
      '<meta charset="utf-8"><meta name="viewport" content="width=device-width"><p>hi</p>';
    const injected = injectHtmlRenderBootstrap(fragment);
    expect(injected.startsWith("<!doctype html><head>")).toBe(true);
    expect(injected.match(/charset/g)).toHaveLength(1);
    expect(injected.match(/name="viewport"/g)).toHaveLength(1);
    expect(injected.endsWith("<p>hi</p>")).toBe(true);
  });

  it.each(["textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript", "plaintext"])(
    "keeps the bootstrap outside %s content",
    (tag) => {
      const fragment = `<${tag}><head><meta name="viewport"></head></${tag}>`;
      const injected = injectHtmlRenderBootstrap(fragment);
      expect(injected.startsWith("<!doctype html><head>")).toBe(true);
      expect(injected.indexOf('<style id="studio-theme">')).toBeLessThan(
        injected.indexOf(`<${tag}>`),
      );
      expect(injected).toContain('<meta name="viewport" content="width=device-width');
      expect(injected.endsWith(fragment)).toBe(true);
    },
  );

  it.each([
    '<template><head><meta name="viewport"></head></template>',
    '<template><template>inner</template><head><meta name="viewport"></head></template>',
  ])("keeps the bootstrap outside inert template content: %s", (fragment) => {
    const injected = injectHtmlRenderBootstrap(fragment);
    expect(injected.startsWith("<!doctype html><head>")).toBe(true);
    expect(injected.indexOf('<style id="studio-theme">')).toBeLessThan(
      injected.indexOf("<template>"),
    );
    expect(injected).toContain('<meta name="viewport" content="width=device-width');
    expect(injected.endsWith(fragment)).toBe(true);
  });

  it("ignores tags written inside comments and scripts", () => {
    const html =
      '<!-- copy <head> and <meta name="viewport"> here --><html><head>' +
      "<script>const tag = '<meta name=\"viewport\">';</script></head><body>x</body></html>";
    const injected = injectHtmlRenderBootstrap(html);
    expect(injected.indexOf('<style id="studio-theme">')).toBeGreaterThan(
      injected.indexOf("<html><head>"),
    );
    expect(injected).toContain('<meta name="viewport" content="width=device-width');
  });
});

describe("readHtmlRenderLinkRequest", () => {
  it("accepts only http(s) URLs in an MCP Apps ui/open-link request", () => {
    const link = (url: unknown) => ({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/open-link",
      params: { url },
    });
    expect(readHtmlRenderLinkRequest(link("https://example.com/a"))).toEqual({
      id: 1,
      url: "https://example.com/a",
    });
    expect(readHtmlRenderLinkRequest(link("javascript:alert(1)"))).toBeUndefined();
    expect(readHtmlRenderLinkRequest(link("file:///etc/passwd"))).toBeUndefined();
    expect(
      readHtmlRenderLinkRequest({
        jsonrpc: "2.0",
        method: "ui/open-link",
        params: { url: "https://example.com" },
      }),
    ).toBeUndefined();
    expect(
      readHtmlRenderLinkRequest({ type: "studio-html-render-link", url: "https://example.com" }),
    ).toBeUndefined();
  });
});

describe("readHtmlRenderContentHeight", () => {
  it("reads only the height of an MCP Apps size-changed notification", () => {
    const notification = (params: unknown) => ({
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params,
    });
    expect(readHtmlRenderContentHeight(notification({ height: 412 }))).toBe(412);
    expect(readHtmlRenderContentHeight(notification({ height: "412" }))).toBe(undefined);
    expect(readHtmlRenderContentHeight(notification({ height: 0 }))).toBe(undefined);
    expect(readHtmlRenderContentHeight({ ...notification({ height: 412 }), method: "x" })).toBe(
      undefined,
    );
  });
});

describe("htmlRenderThemeMessage", () => {
  it("is an MCP Apps host-context-changed notification carrying the theme variables", () => {
    const theme = htmlRenderTheme(STUDIO_CODE_DARK_THEME_COLORS, "dark");
    expect(htmlRenderThemeMessage(theme)).toEqual({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { theme: "dark", styles: { variables: theme.variables } },
    });
  });
});

describe("htmlRenderTheme", () => {
  it("exposes the brand accent as --accent and keeps the fragment decodable", () => {
    const theme = htmlRenderTheme(STUDIO_CODE_LIGHT_THEME_COLORS, "light");
    expect(theme.variables["--accent"]).toBe(STUDIO_CODE_LIGHT_THEME_COLORS.accent);
    expect(theme.variables["--chart-1"]).toBe(STUDIO_CODE_LIGHT_THEME_COLORS.accent);
    expect(theme.variables["--chart-6"]).toBeDefined();
    const fragment = htmlRenderThemeFragment(theme);
    expect(JSON.parse(decodeURIComponent(fragment.slice("#studio-theme=".length)))).toEqual(theme);
    expect(fragment).not.toContain("&");
    expect(htmlRenderTheme(STUDIO_CODE_DARK_THEME_COLORS, "dark").variables["--background"]).toBe(
      STUDIO_CODE_DARK_THEME_COLORS.canvas,
    );
  });
});

describe("readHtmlRenderReference", () => {
  it("clamps height and rejects malformed references", () => {
    expect(readHtmlRenderReference({ ...reference, height: 99_999 })?.height).toBe(2000);
    expect(readHtmlRenderReference({ ...reference, title: "  " })?.title).toBe("HTML");
    expect(readHtmlRenderReference({ ...reference, attachmentId: 4 })).toBeUndefined();
    expect(readHtmlRenderReference({ ...reference, height: Number.NaN })).toBeUndefined();
  });
});

describe("show_visual references and pages", () => {
  it("keeps only the visual kind and compares it", () => {
    const visual = readHtmlRenderReference({ ...reference, kind: "visual" });
    expect(visual?.kind).toBe("visual");
    expect(readHtmlRenderReference({ ...reference, kind: "slides" })).not.toHaveProperty("kind");
    expect(htmlRenderReferencesEqual(reference, visual!)).toBe(false);
    expect(
      htmlRenderFromToolItem({
        toolName: "mcp__studio-code__show_visual",
        output: { htmlRender: visual, message: "Shown." },
      }),
    ).toEqual(visual);
  });

  it("sizes an unmeasured visual modestly until the page reports its height", () => {
    const visual = {
      attachmentId: "a-html",
      title: "flow",
      height: HTML_RENDER_MAX_HEIGHT,
      kind: "visual" as const,
    };
    expect(htmlRenderFrameHeight(visual, 728)).toBe(420);
    expect(htmlRenderFrameHeight(visual, 728, 300)).toBe(300);
    expect(htmlRenderFrameHeight(visual, 728, 1200)).toBe(1200);
  });

  it("wraps a fragment in a themed page and refuses whole documents", () => {
    const svg = '<?xml version="1.0"?>\n<svg viewBox="0 0 10 10"><rect class="c-blue"/></svg>';
    expect(isHtmlVisualSvg(svg)).toBe(true);
    expect(isHtmlVisualSvg("<div>Chart</div>")).toBe(false);
    const page = htmlVisualDocument(svg);
    expect(page).toMatch(/^<!doctype html>/);
    expect(page).not.toContain("<?xml");
    expect(page).toContain('<body><svg viewBox="0 0 10 10">');
    expect(page).toContain(".c-blue{--hue:");
    expect(page).toContain("--text-primary:var(--foreground)");
    for (const code of [
      "<!doctype html><p>x</p>",
      "<!-- note --><html><body></body></html>",
      " <BODY>",
    ]) {
      expect(isHtmlVisualDocument(code)).toBe(true);
    }
    expect(isHtmlVisualDocument("<div><body-ish></body-ish></div>")).toBe(false);
    expect(injectHtmlRenderBootstrap(page)).toContain('id="studio-theme"');
  });
});

describe("htmlRenderFromToolItem", () => {
  const result = { htmlRender: reference, message: "Rendered above your reply." };

  it("reads the reference from each provider's result envelope", () => {
    for (const [toolName, output] of [
      ["mcp__studio-code__html_render", [{ type: "text", text: JSON.stringify(result) }]],
      ["studio-code.html_render", { structuredContent: result, content: [] }],
      ["studio-code-thread_1_html_render", JSON.stringify(result)],
      ["html_render", result],
    ] as const) {
      expect(htmlRenderFromToolItem({ toolName, output })).toEqual(reference);
    }
  });

  it("ignores other tools and failed calls", () => {
    expect(
      htmlRenderFromToolItem({ toolName: "mcp__studio-code__html_preview", output: result }),
    ).toBe(undefined);
    expect(htmlRenderFromToolItem({ toolName: "mcp__other__html_render", output: result })).toBe(
      undefined,
    );
    expect(
      htmlRenderFromToolItem({ toolName: "html_render", output: { ...result, isError: true } }),
    ).toBeUndefined();
  });
});

describe("htmlRenderFrameHeight", () => {
  const measured = readHtmlRenderReference({
    ...reference,
    height: 1500,
    heights: [
      [728, 1403],
      [390, 1290],
      [1000, 1660],
    ],
  })!;

  it("takes the taller neighbor between measured widths and holds the ends", () => {
    expect(measured.heights?.map(([width]) => width)).toEqual([390, 728, 1000]);
    expect(htmlRenderFrameHeight(measured, 728)).toBe(1403);
    expect(htmlRenderFrameHeight(measured, 559)).toBe(1403);
    expect(htmlRenderFrameHeight(measured, 320)).toBe(1290);
  });

  it("takes the taller layout when a breakpoint falls between measured widths", () => {
    // 900px tall below a 600px media query, 450px above it.
    const responsive = readHtmlRenderReference({
      ...reference,
      height: 2000,
      heights: [
        [520, 900],
        [640, 450],
      ],
    })!;
    expect(htmlRenderFrameHeight(responsive, 590)).toBe(900);
    expect(htmlRenderFrameHeight(responsive, 640)).toBe(450);
  });

  it("fits a page the client lays out taller than the server measured", () => {
    // The agent passed contentHeight at the column width, so the page should never scroll.
    const fitted = { ...measured, height: 1403 };
    expect(htmlRenderFrameHeight(fitted, 728, 1415)).toBe(1415);
    expect(htmlRenderFrameHeight(fitted, 1400)).toBe(1660);
    expect(htmlRenderFrameHeight(fitted, 728, 5000)).toBe(HTML_RENDER_MAX_HEIGHT);
  });

  it("keeps the agent's height when it asked for a scrolling frame or the page is unmeasured", () => {
    const scrolling = { ...measured, height: 600 };
    expect(htmlRenderFrameHeight(scrolling, 728, 1415)).toBe(600);
    expect(htmlRenderFrameHeight(scrolling, 1400)).toBe(600);
    expect(htmlRenderFrameHeight(reference, 728)).toBe(reference.height);
    expect(htmlRenderFrameHeight(reference, 728, 900)).toBe(reference.height);
    expect(htmlRenderFrameHeight(reference, 728, 300)).toBe(300);
  });

  it("drops a malformed table and compares tables by value", () => {
    expect(readHtmlRenderReference({ ...reference, heights: [[728, "x"]] })?.heights).toBe(
      undefined,
    );
    const copy = readHtmlRenderReference(JSON.parse(JSON.stringify(measured)))!;
    expect(htmlRenderReferencesEqual(measured, copy)).toBe(true);
    expect(htmlRenderReferencesEqual(measured, { ...copy, heights: [[390, 1290]] })).toBe(false);
  });
});

describe("HTML_RENDER_EXACT_COPY_SCRIPT", () => {
  const PATH = "/Users/me/Downloads/cws/icon-128.png";
  const bytes = (text: string) => [...new TextEncoder().encode(text)];

  function run(input: { activeElement?: unknown; selection?: string }) {
    const writeText = vi.fn(async (_text: string) => {});
    const listeners: Array<(event: unknown) => void> = [];
    const clipboard = { writeText };
    const fakeWindow = {
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        if (type === "copy") listeners.push(listener);
      },
      getSelection: () =>
        input.selection === undefined
          ? null
          : { toString: () => input.selection, rangeCount: 0, getRangeAt: () => null },
    };
    new Function("window", "document", "navigator", HTML_RENDER_EXACT_COPY_SCRIPT)(
      fakeWindow,
      { activeElement: input.activeElement ?? null, createElement: () => ({}) },
      { clipboard },
    );
    const copy = () => {
      const data = new Map<string, string>();
      const event = {
        defaultPrevented: false,
        clipboardData: { setData: (type: string, value: string) => data.set(type, value) },
        preventDefault() {
          event.defaultPrevented = true;
        },
      };
      for (const listener of listeners) listener(event);
      return { data, prevented: event.defaultPrevented };
    };
    return { clipboard, writeText, copy };
  }

  it("writes a page's Copy button text without its trailing newline", async () => {
    const { clipboard, writeText } = run({});
    await clipboard.writeText(`\uFEFF${PATH}\u00A0\n`);
    expect(bytes(writeText.mock.calls[0]![0])).toEqual(bytes(PATH));
  });

  it("copies a selected textarea path exactly, as execCommand copy does", () => {
    const textarea = {
      tagName: "TEXTAREA",
      value: `${PATH}\n`,
      selectionStart: 0,
      selectionEnd: PATH.length + 1,
    };
    const { copy } = run({ activeElement: textarea });
    const { data, prevented } = copy();
    expect(prevented).toBe(true);
    expect(bytes(data.get("text/plain")!)).toEqual(bytes(PATH));
  });

  it("leaves a copy that is already exact to the browser", () => {
    const { copy } = run({ selection: PATH });
    expect(copy().prevented).toBe(false);
  });

  it("ships in every page's bootstrap", () => {
    expect(injectHtmlRenderBootstrap("<p>x</p>")).toContain(HTML_RENDER_EXACT_COPY_SCRIPT);
  });
});

describe("normalizeEvidencePath", () => {
  it("accepts emoji and joining-script names whose invisible characters form a visible glyph", () => {
    for (const name of [
      "❤️ notes.png",
      "⚠️ issues.log",
      "1️⃣ step.png",
      "👩‍💻 setup.md",
      "👩🏽‍💻 setup.md",
      "🏳️‍🌈.png",
      "🏴\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f} team.png",
      "می\u200cخواهم.txt",
      "क्\u200dष.txt",
      "Résumé 履歴書 🇺🇸.pdf",
    ])
      expect(normalizeEvidencePath(`/Users/a/${name}`)?.path, name).toBe(`/Users/a/${name}`);
    // The same characters stay refused where they draw nothing.
    for (const name of [
      "a\ufe0fb.png",
      "a1\ufe0f.png",
      "a\u200db.png",
      "a\u200cb.png",
      "x\u{e0067}.png",
      "\u0661\u200c\u0662.png",
      "\u0967\u200c\u0968.png",
      "\u{1f3f4}\u{e0061}\u{e0062}\u{e0063}.png",
    ])
      expect(normalizeEvidencePath(`/Users/a/${name}`), JSON.stringify(name)).toBeUndefined();
  });

  it("accepts absolute POSIX, home and Windows drive paths as written", () => {
    expect(normalizeEvidencePath("/Users/a/shot one.png")).toEqual({
      path: "/Users/a/shot one.png",
      kind: "posix",
    });
    expect(normalizeEvidencePath("~/evidence/run.log")?.kind).toBe("home");
    expect(normalizeEvidencePath("C:\\Users\\a\\x.png")?.kind).toBe("windows");
    expect(normalizeEvidencePath("C:/Users/a/x.png")?.kind).toBe("windows");
    expect(normalizeEvidencePath(`/${"a".repeat(4095)}`)).toBeDefined();
  });

  it("refuses URLs, relative, network, traversing, encoded, invisible and oversized paths", () => {
    for (const path of [
      "javascript:alert(1)",
      "data:text/html,x",
      "blob:https://x/1",
      "https://x.test/a.png",
      "/Users/a/../../etc/passwd",
      "/Users/a/./x",
      "/Users/%2e%2e/x",
      "/Users/a/%2fx",
      "/Users/a/x\u0000.png",
      "/Users/a/\u001b[0m.png",
      "/Users/a/x\n.png",
      "/Users/a/\u202ex.png",
      "/Users/a/\ud800.png",
      "/Users/a\\..\\b",
      "x.png",
      "./x.png",
      "",
      "~",
      "/",
      "/Users/a/",
      "//host/share",
      "C:\\..\\x",
      "\\\\host",
      "\\\\host\\share\\x.png",
      "\\\\?\\C:\\x.png",
      "\\\\.\\pipe\\x",
      "/Users/a/x\u200b.png",
      "/Users/a/\ufeffx.png",
      "/Users/a/x\u2060.png",
      "/Users/a/x\u00ad.png",
      "/Users/a/x\u034f.png",
      "/Users/a/x\u3164.png",
      "/Users/a/x\ufe0f.png",
      "/Users/a/x\u{e0041}.png",
      "/Users/a/\udc00.png",
      `/${"a".repeat(4096)}`,
      42,
      null,
    ])
      expect(normalizeEvidencePath(path), String(path)).toBeUndefined();
  });
});

describe("readHtmlRenderFileRequest", () => {
  const request = (params: unknown, extra: object = {}) => ({
    jsonrpc: "2.0",
    id: "studio-file-1",
    method: "specwithcode/open-file",
    params,
    ...extra,
  });

  it("reads only the path and line of an open or copy request", () => {
    expect(
      readHtmlRenderFileRequest(
        request({
          path: "/Users/a/x.png",
          line: 42,
          environmentId: "other",
          threadId: "project-coordinator:x",
          cwd: "/",
        }),
      ),
    ).toEqual({ id: "studio-file-1", method: "open-file", path: "/Users/a/x.png", line: 42 });
    expect(
      readHtmlRenderFileRequest(
        request({ path: "/Users/a/x.png", line: 3 }, { method: "specwithcode/copy-path" }),
      ),
    ).toEqual({ id: "studio-file-1", method: "copy-path", path: "/Users/a/x.png" });
  });

  it("rejects other shapes and lines", () => {
    for (const data of [
      request({ path: "/Users/a/x.png" }, { id: undefined }),
      request({ path: "/Users/a/x.png" }, { jsonrpc: "1.0" }),
      request({ url: "file:///Users/a/x.png" }, { method: "ui/open-link" }),
      request({ path: "/Users/a/x.png", line: -1 }),
      request({ path: "/Users/a/x.png", line: 1.5 }),
      request({ path: "/Users/a/x.png", line: "42" }),
      request({ path: "../x.png" }),
      request(null),
      "specwithcode/open-file",
    ])
      expect(readHtmlRenderFileRequest(data)).toBeUndefined();
  });
});

describe("legacyLocalPathFromOpenLink", () => {
  const frame = "https://host.test/api/assets/abc/report.html?sig=1#studio-theme=x";
  it("reads a path an old bootstrap resolved against the frame's own server", () => {
    expect(legacyLocalPathFromOpenLink("https://host.test/Users/a/shot%20one.png", frame)).toBe(
      "/Users/a/shot one.png",
    );
  });
  it("leaves the app's own pages, other origins and unsafe paths as links", () => {
    expect(
      legacyLocalPathFromOpenLink("https://host.test/api/assets/x.png", frame),
    ).toBeUndefined();
    expect(
      legacyLocalPathFromOpenLink("https://host.test/settings/general", frame),
    ).toBeUndefined();
    expect(legacyLocalPathFromOpenLink("https://host.test/", frame)).toBeUndefined();
    expect(legacyLocalPathFromOpenLink("https://other.test/Users/a/x.png", frame)).toBeUndefined();
    expect(
      legacyLocalPathFromOpenLink("https://host.test/Users/%252e%252e/x", frame),
    ).toBeUndefined();
    expect(legacyLocalPathFromOpenLink("not a url", frame)).toBeUndefined();
  });
});

describe("evidence links in the bootstrap", () => {
  it("ships the evidence styles with the theme and lets a handled click stay handled", () => {
    const injected = injectHtmlRenderBootstrap("<p>x</p>");
    expect(injected).toContain("a.studio-evidence{");
    expect(injected).toContain('"specwithcode/open-file"');
    expect(injected).toContain('"specwithcode/copy-path"');
    // The link handler leaves a click an evidence link already took.
    expect(injected).toContain("if(!l||e.defaultPrevented)return;");
    for (const script of injected.matchAll(/<script>([\s\S]*?)<\/script>/g))
      expect(() => new Function(script[1]!)).not.toThrow();
  });
});
