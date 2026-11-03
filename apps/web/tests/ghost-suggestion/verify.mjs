// Headless check of the suggested prompt in the composer. Build first:
//   vp build --config apps/web/tests/ghost-suggestion/vite.config.ts
// then: PW=<playwright-core/index.mjs> OUT=<dir> node apps/web/tests/ghost-suggestion/verify.mjs
// Always headless; writes screenshots and checks.json to OUT and exits 1 on a failed check.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.PW).href);
const root = NodeURL.fileURLToPath(
  new URL("../../../../.artifacts/ghost-suggestion/site", import.meta.url),
);
const out =
  process.env.OUT ??
  NodeURL.fileURLToPath(
    new URL("../../../../.artifacts/ghost-suggestion/evidence", import.meta.url),
  );
await NodeFSP.mkdir(out, { recursive: true });

const server = NodeHttp.createServer(async (req, res) => {
  try {
    const p = new URL(req.url, "http://x").pathname;
    const file = NodePath.resolve(root, `.${p === "/" ? "/index.html" : p}`);
    const mime = file.endsWith(".js")
      ? "text/javascript"
      : file.endsWith(".css")
        ? "text/css"
        : file.endsWith(".woff2")
          ? "font/woff2"
          : "text/html";
    res.writeHead(200, { "Content-Type": mime });
    res.end(await NodeFSP.readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const TEXT =
  "Run the unit tests for the composer and fix anything that fails before opening the pull request";
const failures = [];
const report = [];
const errors = [];
const browser = await chromium.launch({ headless: true });

const read = (page) =>
  page.evaluate(() => {
    const editor = document.querySelector('[data-testid="composer-editor"]');
    const ghost = document.querySelector('[data-testid="composer-ghost-suggestion"]');
    const describedBy = editor?.getAttribute("aria-describedby");
    const ghostBox = ghost?.firstElementChild?.getBoundingClientRect();
    const line = ghost ? parseFloat(getComputedStyle(ghost).lineHeight) : 0;
    return {
      editorText: editor?.textContent ?? null,
      focused: document.activeElement === editor || editor?.contains(document.activeElement),
      ghostText: ghost?.textContent ?? null,
      ghostKbd: ghost?.querySelector('[data-slot="kbd"]')?.textContent ?? null,
      ghostLines: ghostBox && line ? Math.round(ghostBox.height / line) : 0,
      ghostColor: ghost ? getComputedStyle(ghost).color : null,
      describedBy,
      description: describedBy ? (document.getElementById(describedBy)?.textContent ?? null) : null,
      mode: document.querySelector("main")?.dataset.interactionMode,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });

try {
  for (const theme of ["dark", "light"]) {
    for (const width of [360, 1280]) {
      const touch = width === 360;
      const context = await browser.newContext({
        viewport: { width, height: 640 },
        deviceScaleFactor: 2,
        reducedMotion: "reduce",
        hasTouch: touch,
        isMobile: touch,
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(`${theme}/${width}: ${error}`));
      const prefix = `${theme}-${width}`;
      const check = (ok, step, message, state) => {
        if (!ok) failures.push(`${prefix}/${step}: ${message} ${JSON.stringify(state)}`);
      };
      const open = async (query = {}) => {
        await page.goto(`${origin}/?${new URLSearchParams({ theme, ...query })}`);
        await page.locator('[data-testid="composer-editor"]').waitFor();
        await page.locator('[data-testid="composer-editor"]').click();
        await page.waitForTimeout(100);
      };
      const step = async (name, assert) => {
        const state = await read(page);
        assert(state, (ok, message) => check(ok, name, message, state));
        await page.screenshot({ path: NodePath.join(out, `${prefix}-${name}.png`) });
        report.push({ name: `${prefix}-${name}`, ...state });
      };

      // 1. A completed run's suggestion shows grey with a Tab hint.
      await open();
      await step("01-ghost", (s, ok) => {
        ok(s.ghostText?.startsWith(TEXT), "ghost text missing");
        ok(s.ghostKbd === "Tab", "Tab hint missing");
        ok(s.editorText === "", "editor not empty");
        ok(s.description?.includes("press Tab"), "no accessible Tab description");
        ok(width > 400 || s.ghostLines >= 2, "long suggestion does not wrap");
        ok(s.overflow <= 0, "horizontal overflow");
      });

      // 2. Tab accepts: the editor holds the text, focus stays, caret at the end.
      await page.keyboard.press("Tab");
      await page.waitForTimeout(150);
      await step("02-accepted", (s, ok) => {
        ok(s.editorText === TEXT, "editor does not hold the suggestion");
        ok(s.ghostText === null, "ghost still shown");
        ok(s.focused, "editor lost focus");
        ok(s.describedBy == null, "stale aria-describedby");
      });
      await page.keyboard.type("!");
      await page.waitForTimeout(50);
      await step("03-caret-at-end", (s, ok) => {
        ok(s.editorText === `${TEXT}!`, "caret was not at the end");
      });

      // 3. Typing hides the ghost; clearing brings it back.
      await open();
      await page.keyboard.type("a");
      await page.waitForTimeout(50);
      await step("04-typed", (s, ok) => {
        ok(s.ghostText === null, "ghost shown over typed text");
        ok(s.editorText === "a", "typed text missing");
      });
      await page.keyboard.press("Backspace");
      await page.waitForTimeout(50);
      await step("05-cleared", (s, ok) => {
        ok(s.ghostText?.startsWith(TEXT), "ghost did not come back");
      });

      // 4. Escape dismisses it for this run.
      await page.keyboard.press("Escape");
      await page.waitForTimeout(50);
      await step("06-dismissed", (s, ok) => {
        ok(s.ghostText === null, "ghost not dismissed");
        ok(s.editorText === "", "Escape changed the prompt");
      });
      await page.keyboard.press("Tab");
      await page.waitForTimeout(50);
      await step("07-tab-after-dismiss", (s, ok) => {
        ok(s.editorText === "", "Tab filled a dismissed suggestion");
      });

      // 5. Shift+Tab still toggles plan mode and never accepts.
      await open();
      await page.keyboard.press("Shift+Tab");
      await page.waitForTimeout(50);
      await step("08-shift-tab", (s, ok) => {
        ok(s.mode === "plan", "Shift+Tab did not toggle plan mode");
        ok(s.editorText === "", "Shift+Tab accepted the suggestion");
        ok(s.ghostText?.startsWith(TEXT), "Shift+Tab hid the suggestion");
      });

      // 6. A running thread shows no ghost, and Tab leaves the prompt alone.
      await open({ phase: "running" });
      await step("09-running", (s, ok) => {
        ok(s.ghostText === null, "ghost shown while running");
      });
      await page.keyboard.press("Tab");
      await page.waitForTimeout(50);
      await step("10-running-tab", (s, ok) => {
        ok(s.editorText === "", "Tab changed the prompt without a ghost");
      });

      // 7. A short suggestion sits on one line with its hint.
      await open({ text: "Commit it" });
      await step("11-short", (s, ok) => {
        ok(s.ghostText?.startsWith("Commit it"), "short ghost missing");
        ok(s.ghostLines === 1, "short ghost wraps");
      });
      await context.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
await NodeFSP.writeFile(
  NodePath.join(out, "checks.json"),
  JSON.stringify({ errors, failures, report }, null, 2),
);
console.log(JSON.stringify({ shots: report.length, errors: errors.length, failures }, null, 2));
process.exit(failures.length || errors.length ? 1 : 0);
