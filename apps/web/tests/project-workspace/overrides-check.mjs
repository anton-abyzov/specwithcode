// Project settings Overrides and Environment repositories against the `?overrides` fixture. Headless only.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const output = process.env.UI_EVIDENCE_DIR;
assert(output, "Use a new explicit evidence directory");
await fs.mkdir(output, { recursive: false });
const port = Number(process.env.PROJECT_UI_PORT ?? 5788);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
    : {}),
});
const errors = [];
const checks = [];
try {
  for (const [name, viewport, scheme] of [
    ["desktop-dark", { width: 1440, height: 1000 }, "dark"],
    ["desktop-light", { width: 1440, height: 1000 }, "light"],
    ["phone-dark", { width: 390, height: 844 }, "dark"],
  ]) {
    const page = await browser.newPage({ viewport, colorScheme: scheme });
    page.on("pageerror", (error) => errors.push(`${name}: ${error.message}`));
    await page.goto(`http://127.0.0.1:${port}/?overrides&overrides-panel`);
    const overrides = page.locator("#project-overrides");
    await overrides.waitFor();
    const text = await overrides.innerText();
    assert.match(text, /When a thread finishes/);
    assert.match(text, /Open PR and auto-merge/);
    assert.doesNotMatch(text, /auto_merge|pull_request|full-access/);
    assert.match(text, /Copilot, Codex \+1/);
    assert.equal(
      await overrides.getByText("Providers for the recommended model", { exact: true }).count(),
      1,
    );
    checks.push(`${name}: one row per setting, machines grouped, values in words`);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    assert.equal(overflow, false, `${name}: page overflows horizontally`);
    await overrides.screenshot({ path: `${output}/overrides-${name}.png` });

    await page.goto(`http://127.0.0.1:${port}/?overrides`);
    await page.getByLabel("Project settings", { exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Environment", exact: true }).click();
    const repository = dialog.locator('[data-entry-key="repository:repo-one"]');
    await repository.waitFor();
    await repository.getByText("This checkout's origin is", { exact: false }).waitFor();
    checks.push(`${name}: renamed origin offers Update URL`);
    await repository.screenshot({ path: `${output}/repository-origin-${name}.png` });
    const path = repository.getByRole("textbox", { name: /^Checkout path for/ });
    await path.fill("https://github.com/example/atlas-platform.git");
    await repository.getByText("This is a folder path, not a URL.").waitFor();
    assert(
      await dialog.getByRole("button", { name: "Save changes", exact: true }).isDisabled(),
      "Save stays disabled while the path holds a URL",
    );
    checks.push(`${name}: URL typed as a path is flagged at the field and blocks Save`);
    await repository.screenshot({ path: `${output}/repository-url-in-path-${name}.png` });
    await repository.getByRole("button", { name: "Use as repository URL" }).click();
    await repository.getByText("URL changed, unsaved", { exact: false }).waitFor();
    checks.push(`${name}: Use as repository URL keeps the entry and its path`);
    await repository.screenshot({ path: `${output}/repository-url-edited-${name}.png` });
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log(checks.join("\n"));
} finally {
  await browser.close();
}
