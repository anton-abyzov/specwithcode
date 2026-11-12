// Headless check and screenshots of the Usage section of Settings > Connect admin:
// node shoot.mjs <site dir> <out dir>
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const [site, output] = process.argv.slice(2).map((path) => NodePath.resolve(path));
await NodeFSP.mkdir(output, { recursive: true });
const { chromium } = NodeModule.createRequire(import.meta.url)(
  process.env.STUDIO_PLAYWRIGHT_MODULE ?? "playwright-core",
);
const server = NodeHttp.createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  const file = NodePath.resolve(site, `.${pathname === "/" ? "/index.html" : pathname}`);
  try {
    const mime =
      { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" }[
        NodePath.extname(file)
      ] ?? "text/html";
    const body = await NodeFSP.readFile(file);
    res.writeHead(200, { "Content-Type": mime }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_CHROME,
});
const cases = {
  ready: {
    has: [
      "Signed up in total",
      "1,083",
      "New sign-ups",
      "Machines linked",
      "Mac installer",
      "2,915",
    ],
    hasNot: ["at least this many", "could not be read"],
  },
  "no-clerk": {
    has: ["Sign-ups could not be read from Clerk.", "Machines linked", "Mac installer"],
    hasNot: ["Signed up in total", "New sign-ups"],
  },
  partial: {
    has: ["The sign-up numbers are at least this many.", "Older releases were not counted."],
    hasNot: [],
  },
  loading: { has: ["Loading usage…", "Loading downloads…"], hasNot: ["Machines linked"] },
  failed: {
    has: ["SpecWithCode Connect could not read its data", "Try again", "Mac installer"],
    hasNot: ["Machines linked"],
  },
  "no-downloads": {
    has: [
      "Installer downloads could not be read from GitHub.",
      "Installs from npm could not be read.",
      "Machines linked",
    ],
    hasNot: ["Mac installer"],
  },
};
const failures = [];
const fail = (where, message) => failures.push(`${where}: ${message}`);
for (const [width, height] of [
  [900, 900],
  [390, 844],
]) {
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
    for (const [state, want] of Object.entries(cases)) {
      const where = `${state}/${theme}/${width}`;
      await page.goto(`${origin}/?state=${state}&theme=${theme}`);
      await page.getByRole("heading", { name: "Usage" }).waitFor();
      await page.waitForTimeout(350);
      const text = await page.locator("main").innerText();
      for (const expected of want.has) {
        if (!text.includes(expected)) fail(where, `missing "${expected}"`);
      }
      for (const unexpected of want.hasNot) {
        if (text.includes(unexpected)) fail(where, `has "${unexpected}"`);
      }
      // Nothing may push the page sideways, at phone width either.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      if (overflow > 0) fail(where, `page scrolls sideways by ${overflow}px`);
      if (state === "ready") {
        // Every week has a bar slot, the tallest fills the chart, an empty week has none.
        const heights = await page
          .locator('[data-testid="connect-admin-usage-weeks"]')
          .first()
          .locator("[data-bar]")
          .evaluateAll((bars) => bars.map((bar) => Math.round(bar.getBoundingClientRect().height)));
        if (heights.length !== 12) fail(where, `${heights.length} week bars, not 12`);
        if (Math.max(...heights) < 40) fail(where, `tallest bar is ${Math.max(...heights)}px`);
        if (heights[0] !== 0) fail(where, `an empty week drew a ${heights[0]}px bar`);
        if (heights[1] < 3) fail(where, `a week with one sign-up drew a ${heights[1]}px bar`);
        // No number in the tables is cut off or wrapped under its neighbour.
        const cut = await page
          .locator("td")
          .evaluateAll(
            (cells) => cells.filter((cell) => cell.scrollWidth > cell.clientWidth + 1).length,
          );
        if (cut > 0) fail(where, `${cut} table numbers are cut off`);
      }
      await page.screenshot({
        path: NodePath.join(output, `${state}-${theme}-${width}.png`),
        fullPage: true,
      });
    }
    await page.close();
  }
}
await browser.close();
server.close();
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`Connect admin usage: ${Object.keys(cases).length} states, 2 themes, 2 widths OK`);
