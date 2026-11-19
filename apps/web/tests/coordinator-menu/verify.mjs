// Build first: vp build --config apps/web/tests/coordinator-menu/vite.config.ts
// Usage: node apps/web/tests/coordinator-menu/verify.mjs [/absolute/evidence-dir]
// Always headless. Playwright comes from STUDIO_PLAYWRIGHT_MODULE, else apps/server's
// playwright-core; STUDIO_CHROMIUM_EXECUTABLE picks a browser binary.
// 1427 AC-09: a window served by M5 that shows linux-mini's coordinator. Checks, light and
// dark at 1280 and 390 px, that the sidebar header, the project header's tag, the machine
// menu, the message labels, the reply source chip, a thread chip and a relayed note each
// name their machine in visible text, and shoots each case.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = process.env.STUDIO_PLAYWRIGHT_MODULE
  ? await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href)
  : NodeModule.createRequire(NodePath.resolve("apps/server/package.json"))("playwright-core");
const output = NodePath.resolve(
  process.argv.slice(2).find((a) => !a.startsWith("--")) ?? ".artifacts/coordinator-menu/evidence",
);
await NodeFSP.mkdir(output, { recursive: true });
const root = NodePath.resolve(".artifacts/coordinator-menu/site");
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = NodePath.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    NodeAssert.ok(file.startsWith(root + NodePath.sep));
    res.setHeader(
      "Content-Type",
      { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" }[
        NodePath.extname(file)
      ] ?? "text/html",
    );
    res.end(await NodeFSP.readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
    : {}),
});
const results = [];
const errors = [];

/** Visible text, not screen-reader text or a tooltip: a real box, inside the viewport. */
async function assertShown(page, locator, expected, width) {
  NodeAssert.equal((await locator.textContent())?.trim(), expected);
  const facts = await locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    let node = element;
    let srOnly = false;
    while (node) {
      if (node.classList?.contains("sr-only")) srOnly = true;
      node = node.parentElement;
    }
    const style = getComputedStyle(element);
    return {
      width: box.width,
      height: box.height,
      left: box.left,
      right: box.right,
      srOnly,
      hidden: style.visibility === "hidden" || style.display === "none",
      clipped: element.scrollWidth > element.clientWidth + 1,
    };
  });
  NodeAssert.equal(facts.srOnly, false, `${expected} is screen-reader text`);
  NodeAssert.equal(facts.hidden, false, `${expected} is hidden`);
  NodeAssert.ok(facts.width > 0 && facts.height > 0, `${expected} has no box`);
  NodeAssert.ok(facts.left >= 0 && facts.right <= width + 0.5, `${expected} leaves the window`);
  NodeAssert.equal(facts.clipped, false, `${expected} is cut off`);
}

try {
  for (const theme of ["light", "dark"])
    for (const width of [1280, 390]) {
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        colorScheme: theme,
        deviceScaleFactor: 2,
      });
      page.on("pageerror", (error) => errors.push(`${theme} ${width}: ${error.message}`));
      await page.goto(`${origin}/?theme=${theme}`);
      await page.locator('[data-fixture="conversation"]').waitFor();
      await page.waitForTimeout(300);
      const at = (fixture, selector) => page.locator(`[data-fixture="${fixture}"] ${selector}`);
      // The window's own machine, in the sidebar header and beside the coordinator's tag.
      await assertShown(page, at("sidebar-header", "[data-window-machine]"), "Window on M5", width);
      await assertShown(
        page,
        at("project-header", "[data-project-machine]"),
        "linux-mini's coordinator",
        width,
      );
      await assertShown(page, at("project-header", "[data-window-machine]"), "Window on M5", width);
      // Messages: the user's goes to linux-mini's coordinator; the reply comes from it.
      NodeAssert.deepEqual(
        (await at("conversation", "[data-request-execution]").allTextContents()).map((t) =>
          t.trim(),
        ),
        ["To linux-mini's coordinator", "Coordinator on linux-mini · Claude Code · Opus 5.5"],
      );
      // The reply's sources: a worker on M5 says so; the coordinator's own thread adds nothing.
      const sources = (await at("conversation", ".sws-reply-source").allTextContents()).map((t) =>
        t.replace(/\s+/g, " ").trim(),
      );
      NodeAssert.deepEqual(sources, ["re: Release notes · M5 ↗", "re: Sign-in check ↗"]);
      await assertShown(
        page,
        at("conversation", "[data-reply-source-machine]"),
        "· M5",
        width,
      );
      NodeAssert.equal(await at("conversation", "[data-reply-source-machine]").count(), 1);
      // A thread chip and a relayed note name the worker's machine.
      NodeAssert.match(
        (await at("conversation", "[data-thread-chip]").textContent()).replace(/\s+/g, " "),
        /Release notes · M5/,
      );
      NodeAssert.equal(
        (await at("conversation", "[data-relayed-from]").textContent()).trim(),
        "Message from Release notes · M5",
      );
      let file = NodePath.join(output, `coordinator-menu-remote-${theme}-${width}.png`);
      await page.screenshot({ path: file, fullPage: true });
      results.push({ theme, width, case: "remote coordinator, window on M5", file });

      // The machine menu marks the window's own row, in visible text.
      await page.locator('[aria-label^="Viewing linux-mini"]').click();
      await page.locator('[role="menu"]').waitFor();
      await page.waitForTimeout(200);
      const row = (key) => page.locator(`[data-orchestrator-view="${key}"]`);
      await assertShown(page, row("this-mac:atlas").locator("[data-row-window]"), "this window", width);
      NodeAssert.equal(await row("linux-mini:atlas").locator("[data-row-window]").count(), 0);
      file = NodePath.join(output, `coordinator-menu-switcher-${theme}-${width}.png`);
      await page.screenshot({ path: file });
      results.push({ theme, width, case: "machine menu marks this window", file });
      await page.close();
    }
  NodeAssert.deepEqual(errors, []);
  await NodeFSP.writeFile(
    NodePath.join(output, "coordinator-menu-results.json"),
    `${JSON.stringify(results, null, 2)}\n`,
  );
  console.log(JSON.stringify({ ok: true, shots: results.length, output }, null, 2));
} finally {
  await browser.close();
  server.close();
}
