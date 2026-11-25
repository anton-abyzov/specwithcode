import {
  HTML_RENDER_CONTAIN_SCROLL_FRAGMENT,
  htmlRenderThemeFragment,
  injectHtmlRenderBootstrap,
} from "@specweave-studio/shared/htmlRender";
import { chromium, type Browser, type Frame, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

// A chat column that scrolls, holding an inline render as the client frames it.
const CHAT = `<!doctype html><html><body style="margin:0">
<div id="chat" style="height:400px;overflow:auto">
  <div style="height:300px"></div>
  <iframe id="render" sandbox="allow-scripts allow-forms" style="display:block;width:600px;height:500px;border:0"></iframe>
  <div style="height:3000px"></div>
</div></body></html>`;

// A page with its own scroller and a viewport taller than the frame.
const PAGE = injectHtmlRenderBootstrap(`<!doctype html><html><head></head><body style="margin:0">
<div style="height:700px"></div>
<div id="inner" style="height:200px;width:300px;overflow:auto;scroll-padding-top:6px">
  <div style="height:900px;width:1200px"></div>
  <div id="target" style="height:40px;width:80px;margin-left:700px;scroll-margin-top:10px">here</div>
  <div style="height:900px"></div>
</div>
<div id="fixed" style="position:fixed;top:0;left:0;height:120px;width:200px;overflow:auto">
  <div style="height:500px"></div><div id="pinned" style="height:20px">pinned</div><div style="height:500px"></div>
</div>
<div style="height:2500px"></div>
</body></html>`);

const NATIVE = `Element.prototype.scrollIntoView.toString().includes("[native code]")`;

const THEME = htmlRenderThemeFragment({ appearance: "dark", variables: {} });

interface Placement {
  readonly chat: number;
  readonly frameY: number;
  readonly frameX: number;
  readonly innerTop: number;
  readonly innerLeft: number;
  readonly fixedTop: number;
  readonly native: boolean;
}

describe("contained scrollIntoView in an inline render", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  const open = async (fragment: string): Promise<{ page: Page; frame: Frame }> => {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.route("http://chat.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: CHAT }),
    );
    await page.route("http://render.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: PAGE }),
    );
    await page.goto("http://chat.test/");
    await page.evaluate(
      `document.getElementById("render").src = ${JSON.stringify(`http://render.test/doc${fragment}`)}`,
    );
    const frame = await (await page.waitForSelector("#render")).contentFrame();
    if (!frame) throw new Error("no render frame");
    await frame.waitForLoadState("load");
    return { page, frame };
  };

  const scrollTo = async (fragment: string, id: string, arg: unknown): Promise<Placement> => {
    const { page, frame } = await open(fragment);
    try {
      // Page-side code goes as source: the server's types have no DOM.
      const call = arg === undefined ? "" : JSON.stringify(arg);
      await frame.evaluate(
        `document.getElementById(${JSON.stringify(id)}).scrollIntoView(${call})`,
      );
      const inside = await frame.evaluate<Omit<Placement, "chat">>(`({
        frameY: window.scrollY,
        frameX: window.scrollX,
        innerTop: document.getElementById("inner").scrollTop,
        innerLeft: document.getElementById("inner").scrollLeft,
        fixedTop: document.getElementById("fixed").scrollTop,
        native: ${NATIVE},
      })`);
      const chat = await page.evaluate<number>(`document.getElementById("chat").scrollTop`);
      return { chat, ...inside };
    } finally {
      await page.close();
    }
  };

  it.each([
    ["default", "target", undefined],
    ["true", "target", true],
    ["false", "target", false],
    ["start", "target", { block: "start" }],
    ["center", "target", { block: "center", inline: "center" }],
    ["end", "target", { block: "end", inline: "end" }],
    ["nearest", "target", { block: "nearest", inline: "nearest" }],
    ["inside a fixed scroller", "pinned", { block: "start" }],
  ] as const)("%s: moves the page as the browser would and never the chat", async (_, id, arg) => {
    const native = await scrollTo(THEME, id, arg);
    const contained = await scrollTo(`${THEME}${HTML_RENDER_CONTAIN_SCROLL_FRAGMENT}`, id, arg);
    // Without the flag the browser's own method runs and moves the chat too.
    expect(native.native).toBe(true);
    if (id === "target") expect(native.chat).toBeGreaterThan(0);
    expect(contained.native).toBe(false);
    expect(contained.chat).toBe(0);
    for (const key of ["frameY", "frameX", "innerTop", "innerLeft", "fixedTop"] as const) {
      expect(Math.abs(contained[key] - native[key]), key).toBeLessThanOrEqual(1);
    }
  });

  it("leaves a top-level page's scrollIntoView native, flag or not", async () => {
    const page = await browser.newPage();
    try {
      await page.route("http://render.test/**", (route) =>
        route.fulfill({ contentType: "text/html", body: PAGE }),
      );
      await page.goto(`http://render.test/doc${THEME}${HTML_RENDER_CONTAIN_SCROLL_FRAGMENT}`);
      expect(await page.evaluate<boolean>(NATIVE)).toBe(true);
    } finally {
      await page.close();
    }
  });
});
