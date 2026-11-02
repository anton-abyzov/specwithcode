// Build first: node node_modules/vite-plus/bin/vp build --config apps/web/tests/project-artifacts/vite.config.ts
// Then: node apps/web/tests/project-artifacts/verify.mjs /absolute/report-dir
// Always headless. Serves the fixture only; every other request is aborted. Fictional data.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const assert = NodeAssert.default;
const { mkdir, readFile, writeFile } = NodeFSP;
const { extname, join, resolve, sep } = NodePath;

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = process.env.STUDIO_PLAYWRIGHT_MODULE
  ? await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href)
  : NodeModule.createRequire(resolve("apps/server/package.json"))("playwright-core");

const root = resolve(".artifacts/project-artifacts/site");
const output = resolve(process.argv[2] ?? ".artifacts/project-artifacts/evidence");
await mkdir(output, { recursive: true });
const MIME = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(root + sep)) return void res.writeHead(403).end();
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "text/html" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const NOW = new Date("2026-10-30T18:00:00Z");

const checks = [];
const errors = [];
const browser = await chromium.launch({
  headless: true,
  ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
    : {}),
});
let passed = false;
try {
  const context = await browser.newContext({
    reducedMotion: "reduce",
    timezoneId: "America/New_York",
    locale: "en-US",
  });
  await context.clock.setFixedTime(NOW);
  const prepare = (target) => {
    target.setDefaultTimeout(10_000);
    target.on("pageerror", (error) => errors.push(String(error)));
    return target.route("**/*", (route) =>
      route.request().url().startsWith(origin) ? route.continue() : route.abort(),
    );
  };
  const page = await context.newPage();
  await prepare(page);
  const outside = [];
  page.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith(origin) && !url.startsWith("data:")) outside.push(url);
  });
  const titles = (scope) =>
    page
      .locator(
        `${scope} .sws-artifact-card:not(.sws-artifact-more-card) .sws-artifact-title, ${scope} .sws-library-label`,
      )
      .allTextContents();

  for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width: 1300, height: 900 });
    await page.goto(`${origin}/?theme=${theme}`);
    await page.locator(".sws-artifact-shelf").waitFor();

    // Pinned first, then newest.
    const shelf = await titles('[data-testid="threads-pane"]');
    assert.equal(shelf[0], "YC demo deck", "the pinned deck leads");
    assert.equal(shelf[1], "shelf-light.png");
    assert.equal(shelf.length, 7, "every artifact once, and no pull requests");
    const library = await titles('[data-testid="library-pane"]');
    assert.equal(library.length, shelf.length, "the Library lists the same artifacts");
    assert.deepEqual(library.slice(0, 2), shelf.slice(0, 2), "in the shelf's order");
    assert.equal(await page.locator('.sws-artifact-card[data-kind="pullRequest"]').count(), 0);
    assert.equal(await page.getByText("Check gh sign-in with an API call").count(), 0);
    await page
      .locator('[data-testid="threads-pane"] img.sws-artifact-thumb-image')
      .first()
      .waitFor();
    // The shelf scrolls inside the pane; the page never scrolls sideways.
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    const row = page.locator(".sws-artifact-row");
    assert.ok(
      await row.evaluate((node) => node.scrollWidth > node.clientWidth),
      "the shelf scrolls",
    );
    await page.screenshot({ path: join(output, `shelf-library-${theme}.png`) });
    checks.push(`${theme}: pinned first then newest, shelf and Library agree, contained`);

    // Documents show a page preview; the HTML one is a small image and no frame.
    const shelfPane = page.locator('[data-testid="threads-pane"]');
    const row0 = page.locator(".sws-artifact-row");
    const htmlCard = shelfPane.locator(
      '.sws-artifact-card:has(.sws-artifact-title:text-is("connect-sign-in-report.html"))',
    );
    await htmlCard.scrollIntoViewIfNeeded();
    const htmlImage = htmlCard.locator("img.sws-artifact-thumb-image");
    await htmlImage.waitFor();
    const htmlSrc = await htmlImage.getAttribute("src");
    assert.match(htmlSrc, /^data:image\/webp/, "the HTML report is a small raster");
    assert.ok(htmlSrc.length < 60_000, `the raster stays small, got ${htmlSrc.length}`);
    assert.equal(await page.locator("iframe").count(), 0, "no card holds a frame");
    assert.deepEqual(outside, [], "a page preview loads nothing");
    // The fixture's script would paint the page red: the top corner stays as the page drew it.
    const pixel = await page.evaluate(async (src) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      const canvas = new OffscreenCanvas(image.width, image.height);
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      return [...context.getImageData(image.width - 4, image.height - 4, 1, 1).data];
    }, htmlSrc);
    assert.ok(pixel[0] > 230 && pixel[1] > 230 && pixel[2] > 230, `no script ran, got ${pixel}`);
    await page.screenshot({
      path: join(output, `shelf-pages-${theme}.png`),
      clip: { x: 0, y: 0, width: 480, height: 300 },
    });
    await row0.evaluate((node) => node.scrollTo({ left: 0 }));
    // A Markdown file is a picture of its page, named by its own heading.
    const markdownCard = shelfPane.locator(
      '.sws-artifact-card:has(.sws-artifact-title:text-is("Review of the artifacts shelf"))',
    );
    await markdownCard.scrollIntoViewIfNeeded();
    const markdownImage = markdownCard.locator("img.sws-artifact-thumb-image");
    await markdownImage.waitFor();
    const markdownSrc = await markdownImage.getAttribute("src");
    assert.match(markdownSrc, /^data:image\/webp/, "the Markdown page is a small raster");
    assert.ok(markdownSrc.length < 60_000, `the raster stays small, got ${markdownSrc.length}`);
    assert.deepEqual(outside, [], "a Markdown page loads nothing");
    // Title and age share one line, and the card has a tint and a turned sheet behind the page.
    const foot = await markdownCard.locator(".sws-artifact-foot").boundingBox();
    assert.ok(foot.height <= 20, `one line, got ${foot.height}`);
    assert.notEqual(await markdownCard.locator(".sws-artifact-age").textContent(), "");
    const sheet = await markdownCard
      .locator(".sws-artifact-thumb")
      .evaluate((node) => getComputedStyle(node, "::before").transform);
    assert.notEqual(sheet, "none", "the back sheet is turned");
    await markdownCard.screenshot({ path: join(output, `markdown-card-${theme}.png`) });
    // View all is the row's last card and opens the Library's Artifacts view.
    const last = shelfPane.locator(".sws-artifact-row > li").last();
    assert.equal(await last.locator(".sws-artifact-title").textContent(), "View all");
    await row.evaluate((node) => node.scrollTo({ left: node.scrollWidth }));
    await page.screenshot({
      path: join(output, `shelf-end-${theme}.png`),
      clip: { x: 0, y: 0, width: 520, height: 330 },
    });
    await row.evaluate((node) => node.scrollTo({ left: 0 }));
    checks.push(`${theme}: Markdown and HTML rasters, no frame, one-line foot; View all last`);

    // The header folds the row and remembers it.
    const toggle = shelfPane.locator(".sws-artifact-shelf-toggle");
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    assert.equal(await row.isVisible(), false);
    await page.reload();
    await page.locator(".sws-artifact-shelf").waitFor();
    assert.equal(await toggle.getAttribute("aria-expanded"), "false", "folded after a reload");
    await page.screenshot({
      path: join(output, `shelf-folded-${theme}.png`),
      clip: { x: 0, y: 0, width: 520, height: 200 },
    });
    await toggle.click();
    assert.equal(await row.isVisible(), true);
    checks.push(`${theme}: the Artifacts header folds and remembers it`);

    // Hover shows pin and menu; the menu offers the artifact's actions.
    const card = page.locator('[data-testid="threads-pane"] .sws-artifact-card').nth(1);
    await card.hover();
    await card.locator(".sws-artifact-more").click();
    await page.getByRole("menuitem", { name: "Open thread" }).waitFor();
    const items = await page.getByRole("menuitem").allTextContents();
    assert.deepEqual(items, [
      "Open",
      "Pin to the top",
      "Open thread",
      "Show in Library",
      "Copy path",
    ]);
    await page.screenshot({
      path: join(output, `shelf-menu-${theme}.png`),
      clip: { x: 0, y: 0, width: 500, height: 420 },
    });
    await page.keyboard.press("Escape");
    checks.push(`${theme}: card menu offers Open, Pin, Open thread, Show in Library, Copy path`);

    // Pinning moves it among the pinned, which keep newest first.
    await card.hover();
    await card.locator(".sws-artifact-pin").click();
    assert.deepEqual((await titles('[data-testid="threads-pane"]')).slice(0, 2), [
      "shelf-light.png",
      "YC demo deck",
    ]);
    assert.equal(
      await page.locator('[data-testid="library-pane"] .sws-library-row[data-pinned]').count(),
      2,
    );
    checks.push(`${theme}: pin moves the artifact first`);

    // The list has Name, Thread, a full date and Size; headers sort, pinned stay first.
    const pane = page.locator('[data-testid="library-pane"]');
    assert.deepEqual(await pane.getByRole("columnheader").allInnerTexts(), [
      "Name",
      "Thread",
      "Date modified",
      "Size",
      "Actions",
    ]);
    assert.match(
      await pane.locator(".sws-library-row").first().getByRole("gridcell").nth(2).innerText(),
      /^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M$/,
    );
    await pane.locator(".sws-artifact-sort", { hasText: "Name" }).click();
    assert.equal(
      await pane.getByRole("columnheader", { name: "Name" }).getAttribute("aria-sort"),
      "ascending",
    );
    const byName = await titles('[data-testid="library-pane"]');
    const pinnedCount = await pane.locator(".sws-library-row[data-pinned]").count();
    const unpinned = byName.slice(pinnedCount);
    assert.deepEqual(
      unpinned,
      unpinned.toSorted((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    );
    await page.screenshot({ path: join(output, `library-list-sorted-${theme}.png`) });
    await pane.locator(".sws-artifact-sort", { hasText: "Date modified" }).click();
    checks.push(`${theme}: list columns, full dates, sorted headers`);

    // The Type filter narrows, never offers pull requests; grid view shows cards.
    await pane.locator(".sws-library-filter").click();
    assert.equal(await page.getByRole("menuitemradio", { name: "Pull requests" }).count(), 0);
    await page.getByRole("menuitemradio", { name: "Documents" }).click();
    assert.ok((await titles('[data-testid="library-pane"]')).length >= 1);
    await page.keyboard.press("Escape");
    await pane.locator('[aria-label="Grid view"]').click();
    await page.screenshot({ path: join(output, `library-grid-documents-${theme}.png`) });
    checks.push(`${theme}: Type filter and grid view`);

    await page.goto(`${origin}/?theme=${theme}&view=grid`);
    await page.locator(".sws-artifact-grid").waitFor();
    await page.locator(".sws-artifact-grid img.sws-artifact-thumb-image").nth(2).waitFor();
    await page.screenshot({ path: join(output, `library-grid-${theme}.png`), fullPage: true });
    checks.push(`${theme}: grid view`);
  }

  // A phone-width pane keeps the Library usable.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/`);
  await page.locator(".sws-artifact-shelf").waitFor();
  await page.screenshot({ path: join(output, "narrow-light.png"), fullPage: true });
  checks.push("390px: renders");

  assert.deepEqual(errors, []);
  passed = true;
} finally {
  await browser.close();
  server.close();
  await writeFile(
    join(output, "report.json"),
    `${JSON.stringify({ passed, checks, errors, at: new Date().toISOString() }, null, 2)}\n`,
  );
}
console.log(`project-artifacts: ${checks.length} checks passed; evidence in ${output}`);
