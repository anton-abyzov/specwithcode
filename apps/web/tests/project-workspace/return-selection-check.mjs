import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const out = process.env.UI_EVIDENCE_DIR;
assert.ok(out);
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
});
const checks = [];
try {
  for (const baseline of [true, false]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(
      `http://127.0.0.1:${process.env.PROJECT_UI_PORT ?? 5837}/?returnSelection&switch${baseline ? "&baseline" : ""}`,
    );
    await page.waitForLoadState("networkidle");
    const nav = page.getByRole("navigation", { name: "Projects" });
    await page
      .getByRole("button", { name: "Open thread Consolidate the skills, Working", exact: true })
      .first()
      .click();
    await page.getByText("Native thread fixture", { exact: false }).waitFor();
    const thread = new URL(page.url()).searchParams.get("thread");
    await nav.getByRole("button", { name: "beacon", exact: true }).click();
    await nav.getByRole("button", { name: "atlas", exact: true }).click();
    if (baseline) assert.equal(new URL(page.url()).searchParams.get("thread"), null);
    else {
      assert.equal(new URL(page.url()).searchParams.get("thread"), thread);
      await page.getByText(`Native thread fixture · ${thread}`, { exact: true }).waitFor();
    }
    await page.screenshot({ path: `${out}/${baseline ? "before" : "after"}.png`, fullPage: true });
    checks.push({
      case: baseline ? "baseline reproduces overview" : "return restores worker",
      pass: true,
    });
    if (!baseline) {
      await page.reload();
      await page.waitForLoadState("networkidle");
      await page.getByText(`Native thread fixture · ${thread}`, { exact: true }).waitFor();
      checks.push({ case: "reload retains worker", pass: true });
      for (let i = 0; i < 4; i++) {
        await nav.getByRole("button", { name: "beacon", exact: true }).click();
        await nav.getByRole("button", { name: "atlas", exact: true }).click();
      }
      assert.equal(new URL(page.url()).searchParams.get("thread"), thread);
      checks.push({ case: "rapid returns retain worker", pass: true });
      await nav.getByRole("button", { name: "Explicit overview", exact: true }).click();
      await nav.getByRole("button", { name: "beacon", exact: true }).click();
      await nav.getByRole("button", { name: "atlas", exact: true }).click();
      assert.equal(new URL(page.url()).searchParams.get("thread"), null);
      checks.push({ case: "explicit overview retained", pass: true });
      await nav.getByRole("button", { name: "Direct worker link", exact: true }).click();
      await page.getByText("Native thread fixture · review", { exact: true }).waitFor();
      await nav.getByRole("button", { name: "beacon", exact: true }).click();
      await nav.getByRole("button", { name: "atlas", exact: true }).click();
      assert.equal(new URL(page.url()).searchParams.get("thread"), "review");
      checks.push({ case: "direct link wins and becomes remembered destination", pass: true });
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
} finally {
  await browser.close();
  await fs.writeFile(`${out}/receipt.json`, JSON.stringify({ checks }, null, 2));
}
