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
  for (const theme of ["light", "dark"]) {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      await page.route("**/*", (route) =>
        route.request().url().startsWith(origin) ? route.continue() : route.abort(),
      );
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${origin}/?theme=${theme}`);
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
      // The note overlays scrolled rows: its fill must be opaque and its own
      // text must be the topmost element wherever it is drawn.
      const lane = page.locator('[data-case="overlay-lane"]');
      await lane.locator("[data-overlay-scroller]").evaluate((element) => {
        element.scrollTop = 120;
      });
      const laneNote = lane.locator("[data-thread-blocker]");
      const opaque = await laneNote.evaluate((element) => {
        const probe = document.createElement("canvas").getContext("2d");
        probe.fillStyle = getComputedStyle(element).backgroundColor;
        probe.fillRect(0, 0, 1, 1);
        return probe.getImageData(0, 0, 1, 1).data[3] === 255;
      });
      assert.ok(opaque, "blocker note background is opaque");
      const covered = await laneNote.evaluate((element) => {
        const text = element.querySelector("[data-thread-blocker-text]");
        const rect = text.getBoundingClientRect();
        const misses = [];
        for (const fx of [0.1, 0.5, 0.9])
          for (const fy of [0.2, 0.5, 0.8]) {
            const hit = document.elementFromPoint(
              rect.left + rect.width * fx,
              rect.top + rect.height * fy,
            );
            if (!hit || !element.contains(hit)) misses.push([fx, fy, hit?.tagName ?? null]);
          }
        return misses;
      });
      assert.deepEqual(covered, [], "nothing draws over the blocker text");
      const toggle = laneNote.getByRole("button", { name: "Show more" });
      assert.equal(await toggle.count(), 1, "long blocker starts clamped");
      const clampedHeight = (await laneNote.boundingBox()).height;
      await toggle.click();
      assert.ok(
        (await laneNote.boundingBox()).height > clampedHeight,
        "Show more expands the note",
      );
      assert.equal(await laneNote.getByRole("button", { name: "Show less" }).count(), 1);
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
