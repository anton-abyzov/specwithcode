import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright"
);
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const output = process.env.UI_EVIDENCE_DIR;
assert.ok(output, "Set UI_EVIDENCE_DIR");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
    : {}),
});
const results = [];
const selector = '[data-slot$="-popup"]';
const visible = () =>
  [...document.querySelectorAll('[data-slot$="-popup"]')]
    .filter((e) => e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
    .map((e) => ({ slot: e.dataset.slot, rect: e.getBoundingClientRect().toJSON() }));
try {
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      for (const kind of [
        "select",
        "combobox",
        "popover",
        "menu",
        "tooltip",
        "dialog",
        "alert",
        "sheet",
        "preview",
      ]) {
        const label = `${kind}-${width}-${theme}`;
        await page.goto(
          `http://127.0.0.1:${process.env.POPUP_PORT ?? 5813}/?kind=${kind}&theme=${theme}`,
        );
        await page.getByText("Project one", { exact: true }).waitFor();
        await page.locator(selector).first().waitFor({ state: "visible" });
        await page.waitForTimeout(250);
        const opened = await page.evaluate(visible);
        assert.ok(opened.length, `${label}: never opened`);
        for (const { rect } of opened)
          assert.ok(
            rect.x >= -1 && rect.y >= -1 && rect.right <= width + 1 && rect.bottom <= 901,
            `${label}: clipped ${JSON.stringify(rect)}`,
          );
        await page.screenshot({ path: `${output}/${label}-open.png` });
        await page.evaluate(() => {
          location.hash = "two";
        });
        await page.getByText("Project two", { exact: true }).waitFor();
        await page.waitForTimeout(250);
        const after = await page.evaluate(visible);
        await page.screenshot({ path: `${output}/${label}-switched.png` });
        assert.equal(after.length, 0, `${label}: popup leaked onto next project`);
        await page.evaluate(() => {
          location.hash = "one";
        });
        await page.getByText("Project one", { exact: true }).waitFor();
        await page.waitForTimeout(250);
        assert.equal(
          (await page.evaluate(visible)).length,
          0,
          `${label}: popup reopened on return`,
        );
        results.push({ kind, width, theme, opened, switched: true, returned: true });
        await writeFile(`${output}/results.json`, JSON.stringify({ results, errors }, null, 2));
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
} finally {
  await browser.close();
}
console.log(`PASS ${results.length} popup/view/theme combinations`);
