// Run against serve.mjs. Checks the coordinator machine choice for a project on two machines.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
import assert from "node:assert/strict";
import fs from "node:fs/promises";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const output = process.env.UI_EVIDENCE_DIR ?? "/tmp/studio-coordinator-machine";
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE }
    : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // One machine: the host name is plain text, with nothing to choose.
  await page.goto("http://127.0.0.1:5788");
  await page.waitForLoadState("networkidle");
  assert.equal(await page.getByRole("button", { name: /Coordinator runs on/ }).count(), 0);

  // Two machines and nothing saved: this computer (M4 Max) runs the coordinator.
  await page.goto("http://127.0.0.1:5788/?machines");
  await page.waitForLoadState("networkidle");
  const picker = page.getByRole("button", { name: /Coordinator runs on/ });
  assert.equal(
    await picker.getAttribute("aria-label"),
    "Coordinator runs on M4 Max. Choose the machine",
  );
  await page.screenshot({ path: `${output}/machine-default.png`, animations: "disabled" });

  await picker.click();
  const menu = page.getByRole("menu");
  await menu.waitFor();
  assert.deepEqual(
    (await menu.getByRole("menuitemradio").allInnerTexts()).map((t) => t.trim()),
    ["M1", "M4 Max"],
  );
  await page.screenshot({ path: `${output}/machine-menu.png`, animations: "disabled" });
  await menu.getByRole("menuitemradio", { name: "M1" }).click();
  await page.getByRole("button", { name: "Coordinator runs on M1. Choose the machine" }).waitFor();

  // The choice is saved for the project, so a reload keeps M1.
  await page.reload();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Coordinator runs on M1. Choose the machine" }).waitFor();
  await page.screenshot({ path: `${output}/machine-after-reload.png`, animations: "disabled" });
  assert.deepEqual(errors, []);
  console.log(`Coordinator machine checks passed. Evidence: ${output}`);
} finally {
  await browser.close();
}
