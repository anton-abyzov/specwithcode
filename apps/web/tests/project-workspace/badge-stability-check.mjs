// Real ProjectRow and attention aggregation; isolated data, no live stores/providers.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const output = process.env.UI_EVIDENCE_DIR ?? "/tmp/badge-stability-evidence";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE }
    : {}),
});
const receipt = { headless: true, cases: [] };
try {
  for (const width of [1280, 390])
    for (const theme of ["light", "dark"]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${process.env.PROJECT_UI_URL ?? "http://127.0.0.1:5798"}/?attention`);
      await page.evaluate((t) => {
        document.documentElement.classList.toggle("dark", t === "dark");
        document.documentElement.dataset.theme = t;
      }, theme);
      const sidebar = page.getByRole("complementary", { name: "Project sidebar" });
      const row = sidebar.locator(".sws-side-row");
      const numeric = sidebar.locator(".sws-count > [aria-hidden]");
      await page.getByRole("button", { name: "coordinator", exact: true }).click();
      await numeric.waitFor();
      assert.equal(await numeric.textContent(), "1");
      const before = await row.locator(".sws-side-row-label").boundingBox();
      for (let n = 0; n < 12; n++) {
        for (const scenario of ["partial", "coordinator"]) {
          await page.getByRole("button", { name: scenario, exact: true }).click();
          assert.equal(await numeric.textContent(), "1");
          assert.equal(
            await sidebar.locator(".sws-project-coverage").count(),
            scenario === "partial" ? 1 : 0,
          );
          assert.deepEqual(await row.locator(".sws-side-row-label").boundingBox(), before);
        }
      }
      await row.hover();
      assert(await numeric.isVisible(), "hover hid the count");
      assert.deepEqual(await row.locator(".sws-side-row-label").boundingBox(), before);
      await page.screenshot({ path: `${output}/${width}-${theme}-hover.png` });
      for (const scenario of ["cached", "offline", "synchronizing", "remote-unknown"]) {
        await page.getByRole("button", { name: scenario, exact: true }).click();
        assert(await sidebar.locator(".sws-project-coverage").isVisible());
        assert(!/[?+]/.test(await numeric.allTextContents().then((x) => x.join(""))));
      }
      await page.screenshot({ path: `${output}/${width}-${theme}-unavailable.png` });
      await page.getByRole("button", { name: "resolved", exact: true }).click();
      assert.equal(await numeric.count(), 0);
      assert.equal(await sidebar.locator(".sws-project-coverage").count(), 0);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors, []);
      receipt.cases.push({
        width,
        theme,
        transitions: 24,
        hoverCountVisible: true,
        layoutStable: true,
        unavailableExplicit: true,
      });
      await page.close();
    }
  await writeFile(`${output}/receipt.json`, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
} finally {
  await browser.close();
}
