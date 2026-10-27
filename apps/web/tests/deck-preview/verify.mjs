// Build first: vp build --config apps/web/tests/deck-preview/vite.config.ts
// Supply the installed Playwright entry via STUDIO_PLAYWRIGHT_MODULE. Always headless.
// Usage: node apps/web/tests/deck-preview/verify.mjs [evidence-dir]
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = NodePath.resolve(".artifacts/deck-preview/site");
const output = NodePath.resolve(
  process.argv[2] ?? process.env.DECK_PREVIEW_OUTPUT ?? ".artifacts/deck-preview/evidence",
);
await NodeFSP.mkdir(output, { recursive: true });
const MIME = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = NodePath.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${root}${NodePath.sep}`)) {
      res.writeHead(403).end();
      return;
    }
    const body = await NodeFSP.readFile(file);
    res.writeHead(200, { "Content-Type": MIME[NodePath.extname(file)] ?? "text/html" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
    : {}),
});
const errors = [];
const receipt = [];
const DECK =
  "/Users/you/.specwithcode/m4/evidence/installed-design-acceptance-20261026/exports/installed-1.0.92-deck.pptx";

async function open(query) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.route("**/*", (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  );
  await page.goto(`${origin}/?${query}`);
  await page.locator("[data-library-viewer]").waitFor();
  await page.waitForTimeout(400);
  return { context, page };
}

try {
  for (const theme of ["light", "dark"]) {
    // The deck opens as its five slides, drawn by the slides renderer.
    {
      const { context, page } = await open(`theme=${theme}&deck=ok`);
      await page.locator('[data-deck-slide="5"]').waitFor();
      NodeAssert.equal(await page.locator("[data-deck-slide]").count(), 5);
      const text = await page.locator("[data-library-viewer]").innerText();
      NodeAssert.ok(text.includes("5 slides"), "the slide count shows");
      NodeAssert.ok(text.includes("Presentation title"), "slide text is drawn");
      NodeAssert.ok(!text.includes("Failed to read file"), "no bare read error");
      const head = await page.locator("[data-viewer-overlay]").innerText();
      NodeAssert.ok(head.includes("installed-1.0.92-deck.pptx") && head.includes("4 of 4"));
      const file = NodePath.join(output, `deck-slides-${theme}.png`);
      await page.screenshot({ path: file });
      receipt.push({ check: `deck opens as 5 slides (${theme})`, ok: true, screenshot: file });
      await page.locator("[data-deck-scroll]").evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await page.waitForTimeout(200);
      const scrolled = NodePath.join(output, `deck-slides-end-${theme}.png`);
      await page.screenshot({ path: scrolled });
      receipt.push({ check: `last slides reachable (${theme})`, ok: true, screenshot: scrolled });
      await context.close();
    }
    // A deck that cannot be read is a card naming why, with the host's ways to open it.
    {
      const { context, page } = await open(`theme=${theme}&deck=corrupt`);
      const card = page.locator("[data-file-preview-card]");
      await card.waitFor();
      const text = await card.innerText();
      NodeAssert.ok(text.includes("No preview: The file could not be read as a PowerPoint deck"));
      NodeAssert.ok(text.includes(DECK), "the card names the path");
      await card.getByRole("button", { name: "Open in default app" }).click();
      await card.getByRole("button", { name: "Show in Finder" }).click();
      NodeAssert.deepEqual(await page.evaluate(() => window.fixtureActions()), [
        { action: "open", filePath: DECK },
        { action: "reveal-in-folder", filePath: DECK },
      ]);
      const file = NodePath.join(output, `deck-unreadable-card-${theme}.png`);
      await page.screenshot({ path: file });
      receipt.push({ check: `unreadable deck is a card (${theme})`, ok: true, screenshot: file });
      await context.close();
    }
    // A Keynote file is a card too, and stepping to the deck from it draws the slides.
    {
      const { context, page } = await open(`theme=${theme}&deck=ok&file=key`);
      const card = page.locator("[data-file-preview-card]");
      await card.waitFor();
      NodeAssert.ok(
        (await card.innerText()).includes("Keynote presentations have no preview here."),
      );
      const file = NodePath.join(output, `keynote-card-${theme}.png`);
      await page.screenshot({ path: file });
      await page.getByRole("button", { name: "Next file" }).click();
      await page.locator('[data-deck-slide="5"]').waitFor();
      receipt.push({ check: `keynote card, then deck (${theme})`, ok: true, screenshot: file });
      await context.close();
    }
  }
  NodeAssert.deepEqual(errors, [], "no page errors");
  await NodeFSP.writeFile(
    NodePath.join(output, "receipt.json"),
    `${JSON.stringify({ ok: true, checks: receipt }, null, 2)}\n`,
  );
  console.log(JSON.stringify({ ok: true, output, checks: receipt.length }));
} finally {
  await browser.close();
  server.close();
}
