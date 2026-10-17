// Build with vp build --config apps/web/tests/blocked-thread/vite.config.ts first.
// Supply the installed Playwright entry via STUDIO_PLAYWRIGHT_MODULE.
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = path.resolve(".artifacts/blocked-thread/site");
const output = path.resolve(".artifacts/blocked-thread/evidence");
await fs.mkdir(output, { recursive: true });
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = path.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${root}${path.sep}`)) {
      res.writeHead(403).end();
      return;
    }
    const mime = file.endsWith(".js")
      ? "text/javascript"
      : file.endsWith(".css")
        ? "text/css"
        : "text/html";
    res.writeHead(200, { "Content-Type": mime });
    res.end(await fs.readFile(file));
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
const receipt = { headless: true, checks: [], screenshots: [] };
try {
  // "translucent" gives the theme's canvas and card alpha, as an imported theme may.
  for (const theme of ["light", "dark", "translucent"]) {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      await page.route("**/*", (route) =>
        route.request().url().startsWith(origin) ? route.continue() : route.abort(),
      );
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${origin}/?theme=${theme === "dark" ? "dark" : "light"}`);
      if (theme === "translucent")
        await page.addStyleTag({
          content:
            "html{--background:oklch(1 0 0 / 0.5)!important;--card:oklch(1 0 0 / 0.4)!important}",
        });
      await page.locator("[data-case]").first().waitFor();
      const overlay = page.locator('[data-case="none-with-notes"]');
      assert.equal(await overlay.getAttribute("data-status"), "");
      assert.equal(await overlay.getAttribute("data-group"), "Idle");
      assert.equal(await overlay.locator("[data-thread-blocker]").count(), 0);
      for (const [id, blocker] of [
        ["question", "Ship 1.0.35 today, or wait for the SQLite fix? I recommend waiting."],
        ["no-access", "No access to the staging token; can you grant it?"],
      ]) {
        const card = page.locator(`[data-case="${id}"]`);
        assert.equal(await card.getAttribute("data-status"), "Blocked");
        assert.equal(await card.getAttribute("data-group"), "Waiting on you");
        const note = card.locator("[data-thread-blocker]");
        assert.equal(await note.count(), 1);
        assert.equal((await note.textContent())?.trim(), `Blocked: ${blocker}`);
        const box = await note.boundingBox();
        assert.ok(box && box.width <= width, "note fits the viewport");
      }
      // The lane overlays scrolled rows. Nothing in it may let a transcript
      // row show through or draw over its text, and the timeline's inset must
      // keep the first row below it as it grows.
      const lane = page.locator('[data-case="overlay-lane"]');
      const scroller = lane.locator("[data-overlay-scroller]");
      const laneNote = lane.locator("[data-thread-blocker]");
      await lane.scrollIntoViewIfNeeded();
      const firstRowClear = () =>
        // The inset is measured, so give it a few frames to follow the lane.
        lane.evaluate(async (section) => {
          let gap = -Infinity;
          for (let frame = 0; frame < 30 && gap < 0; frame += 1) {
            await new Promise((resolve) => requestAnimationFrame(resolve));
            const bottom = section
              .querySelector("[data-banner-lane]")
              .getBoundingClientRect().bottom;
            gap =
              section.querySelector('[data-transcript-row="0"]').getBoundingClientRect().top -
              bottom;
          }
          return gap;
        });
      assert.ok((await firstRowClear()) >= 0, "first row starts below the lane");
      const toggle = laneNote.getByRole("button", { name: "Show more" });
      assert.equal(await toggle.count(), 1, "long blocker starts clamped");
      const clampedHeight = (await laneNote.boundingBox()).height;
      await toggle.click();
      assert.ok(
        (await laneNote.boundingBox()).height > clampedHeight,
        "Show more expands the note",
      );
      assert.equal(await laneNote.getByRole("button", { name: "Show less" }).count(), 1);
      assert.ok((await firstRowClear()) >= 0, "the inset follows the expanded lane");
      await scroller.evaluate((element) => {
        element.scrollTop = 240;
      });
      const surfaces =
        '[data-slot="alert"], [data-thread-meta], [data-thread-plan-card], [data-thread-blocker]';
      const overlaps = await lane.evaluate((section, selector) => {
        const misses = [];
        for (const surface of section.querySelectorAll(selector)) {
          const rect = surface.getBoundingClientRect();
          for (const fx of [0.08, 0.3, 0.5, 0.7, 0.92])
            for (const fy of [0.08, 0.3, 0.5, 0.7, 0.92]) {
              const hit = document.elementFromPoint(
                rect.left + rect.width * fx,
                rect.top + rect.height * fy,
              );
              if (!hit || !surface.contains(hit) || hit.closest("[data-transcript-row]"))
                misses.push([
                  surface.outerHTML.slice(0, 60),
                  fx,
                  fy,
                  hit?.textContent?.slice(0, 40),
                ]);
            }
        }
        return misses;
      }, surfaces);
      assert.deepEqual(overlaps, [], "no transcript row is topmost inside a lane surface");
      // Pixels, not hit tests: the whole lane (gaps beside the alert included),
      // the dock and each surface look the same with the rows under them shown
      // or hidden, so nothing shows through.
      const regions = await lane.evaluate(
        (section, selector) =>
          [
            ...section.querySelectorAll(
              `[data-banner-lane], ${selector}, [data-thread-progress-dock]`,
            ),
          ].map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              name:
                element.getAttribute("data-thread-meta") ??
                element.getAttribute("data-slot") ??
                (element.hasAttribute("data-banner-lane") ? "lane" : null) ??
                [...element.attributes].find((a) => a.name.startsWith("data-thread"))?.name,
              clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            };
          }),
        surfaces,
      );
      const shoot = () =>
        Promise.all(regions.map((region) => page.screenshot({ clip: region.clip })));
      const shown = await shoot();
      const hideRows = await page.addStyleTag({
        content: "[data-transcript-row]{visibility:hidden}",
      });
      const hidden = await shoot();
      const seeThrough = regions
        .filter((_, index) => !shown[index].equals(hidden[index]))
        .map((region) => region.name);
      assert.deepEqual(seeThrough, [], "transcript rows show through the lane");
      await hideRows.evaluate((element) => element.remove());
      // A row revealed at the top (a collapsed report, a found match) lands below the lane.
      const revealGap = await lane.evaluate((section) => {
        section.querySelector('[data-transcript-row="30"]').scrollIntoView({ block: "start" });
        const bottom = section.querySelector("[data-banner-lane]").getBoundingClientRect().bottom;
        return (
          section.querySelector('[data-transcript-row="30"]').getBoundingClientRect().top - bottom
        );
      });
      assert.ok(revealGap >= 0, `revealed row lands below the lane (${revealGap}px)`);
      await scroller.evaluate((element) => {
        element.scrollTop = 240;
      });
      await lane.screenshot({ path: path.join(output, `blocked-lane-${theme}-${width}.png`) });
      assert.deepEqual(errors, []);
      const file = path.join(output, `blocked-thread-${theme}-${width}.png`);
      await page.screenshot({ path: file, fullPage: true });
      receipt.screenshots.push(file);
      receipt.checks.push({ theme, width, ok: true });
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
await fs.writeFile(path.join(output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt, null, 2));
