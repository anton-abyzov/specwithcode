// Build first: vp build --config apps/web/tests/link-dialog/vite.config.ts
// Usage: node apps/web/tests/link-dialog/verify.mjs [/absolute/evidence-dir]
// Always headless. Playwright comes from STUDIO_PLAYWRIGHT_MODULE, else apps/server's
// playwright-core; STUDIO_CHROMIUM_EXECUTABLE picks a browser binary.
// Checks and shoots, light and dark, the first step of "Link with a project on another
// machine": the copies with the best one selected, "Other projects" open, no copy found,
// and a project that is already linked (the subtitle names Main).
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = process.env.STUDIO_PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href)
  : createRequire(path.resolve("apps/server/package.json"))("playwright-core");
const output = path.resolve(
  process.argv.slice(2).find((a) => !a.startsWith("--")) ?? ".artifacts/link-dialog/evidence",
);
await fs.mkdir(output, { recursive: true });
const root = path.resolve(".artifacts/link-dialog/site");
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = path.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    assert(file.startsWith(root + path.sep));
    res.setHeader(
      "Content-Type",
      { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" }[
        path.extname(file)
      ] ?? "text/html",
    );
    res.end(await fs.readFile(file));
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
/** One page of the fixture, once the folders are read; a script error fails the run. */
async function open(query, viewport = { width: 820, height: 760 }) {
  // The page's own background follows the system appearance, so that is set with the theme.
  const colorScheme = /(^|&)theme=dark(&|$)/.test(query) ? "dark" : "light";
  const page = await browser.newPage({ viewport, colorScheme, deviceScaleFactor: 2 });
  page.on("pageerror", (error) => errors.push(`${query}: ${error.message}`));
  await page.goto(`${origin}/?${query}`);
  await page.locator('[data-slot="link-other-projects"]').waitFor();
  await page.waitForTimeout(300);
  return page;
}
const shot = async (page, name) => {
  const file = path.join(output, `${name}.png`);
  await page.screenshot({ path: file });
  return file;
};
const rows = (page) =>
  page.locator('[data-slot="link-candidate"] span.font-medium').allTextContents();
const picked = (page) =>
  page
    .locator('[data-slot="link-candidate"]:has([role="radio"][aria-checked="true"]) span.font-medium')
    .allTextContents();
const subtitle = (page) => page.locator('[data-slot="dialog-description"]').textContent();
const fold = (page) => page.locator('[data-slot="link-other-projects"] > button');
const COPIES = ["Atlas on m3", "Atlas on m1", "Atlas on linux-mini"];
const OTHERS = [
  "ai-notes on linux-mini",
  "first-steps on m5",
  "ledger on m3",
  "sketchbook on m1",
  "voxel-run on linux-mini",
  "weave on m1",
];

try {
  for (const theme of ["light", "dark"]) {
    // Copies of this project only; the best match on a connected machine is selected.
    let page = await open(`theme=${theme}`);
    assert.equal(
      await subtitle(page),
      "Pick the copy of Atlas on another machine. Each copy keeps its own coordinator, and you can switch Main any time.",
    );
    assert.deepEqual(await rows(page), COPIES);
    assert.deepEqual(await picked(page), ["Atlas on m3"]);
    const body = await page.locator('[data-slot="dialog-popup"]').textContent();
    assert.match(body, /Same root repository; 34 of 36 repositories match, 2 missing here\./);
    assert.match(body, /Same root repository; 32 of 36 repositories match, 4 missing here\./);
    assert.match(body, /Connect linux-mini first\./);
    assert.doesNotMatch(body, /sketchbook|One coordinator stays|No copy of Atlas/);
    assert.equal(await fold(page).textContent(), "Other projects (6)");
    assert.equal(await fold(page).getAttribute("aria-expanded"), "false");
    assert.equal(await page.getByRole("button", { name: "Review link" }).isEnabled(), true);
    let file = await shot(page, `link-dialog-copies-${theme}`);
    results.push({ theme, case: "copies only, best one selected", rows: COPIES, file });

    // Every other project is one click away, for a renamed or re-cloned copy.
    await fold(page).click();
    assert.deepEqual(await rows(page), [...COPIES, ...OTHERS]);
    assert.equal(await fold(page).getAttribute("aria-expanded"), "true");
    assert.deepEqual(await picked(page), ["Atlas on m3"]);
    await page.locator('[data-slot="link-other-projects"]').scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    file = await shot(page, `link-dialog-other-projects-open-${theme}`);
    // A row there can be picked; closing the fold drops that pick.
    await page.locator('[data-slot="link-candidate"]', { hasText: "ledger on m3" }).click();
    assert.deepEqual(await picked(page), ["ledger on m3"]);
    await fold(page).click();
    assert.deepEqual(await rows(page), COPIES);
    assert.deepEqual(await picked(page), []);
    assert.equal(await page.getByRole("button", { name: "Review link" }).isEnabled(), false);
    results.push({ theme, case: "Other projects open", file });
    await page.close();

    // No copy anywhere: the dialog says so and opens the other projects.
    page = await open(`theme=${theme}&case=empty`);
    assert.equal(
      await page.locator("[data-link-no-copy]").textContent(),
      "No copy of Atlas was found on another machine.",
    );
    assert.equal(await fold(page).getAttribute("aria-expanded"), "true");
    assert.deepEqual(await rows(page), OTHERS);
    assert.deepEqual(await picked(page), []);
    assert.equal(await page.getByRole("button", { name: "Review link" }).isEnabled(), false);
    file = await shot(page, `link-dialog-no-copy-${theme}`);
    results.push({ theme, case: "no copy found", file });
    await page.close();

    // Already linked with m5: the subtitle names the real Main.
    page = await open(`theme=${theme}&case=linked`);
    assert.equal(
      await subtitle(page),
      "Pick the copy of Atlas on another machine. Each copy keeps its own coordinator; Main stays on m5 and you can switch it any time.",
    );
    assert.deepEqual(await rows(page), ["Atlas on m1"]);
    assert.deepEqual(await picked(page), ["Atlas on m1"]);
    file = await shot(page, `link-dialog-linked-main-${theme}`);
    results.push({ theme, case: "linked project names Main", file });
    await page.close();
  }

  // Another interface language: the first step's own words are translated.
  const page = await open("theme=light&lang=ru");
  assert.equal(
    await page.locator('[data-slot="dialog-title"]').textContent(),
    "Связать с проектом на другой машине",
  );
  assert.equal(await fold(page).textContent(), "Другие проекты (6)");
  assert.deepEqual((await rows(page))[0], "Atlas на m3");
  const file = await shot(page, "link-dialog-copies-ru-light");
  results.push({ theme: "light", case: "Russian", file });
  await page.close();

  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, "results.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ ok: true, shots: results.length, output }, null, 2));
} finally {
  await browser.close();
  server.close();
}
