import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, extname, join } from "node:path";
import { createRequire } from "node:module";
import { homedir } from "node:os";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = createRequire(import.meta.url)(
  join(
    homedir(),
    ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
  ),
);
const site = resolve(".artifacts/project-folder-choice/site");
const output = resolve(process.argv[2] || ".artifacts/project-folder-choice/evidence");
await mkdir(output, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = resolve(site, "." + (pathname === "/" ? "/index.html" : pathname));
    if (!file.startsWith(site + "/")) throw Error("path");
    res.setHeader(
      "content-type",
      { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" }[extname(file)] ||
        "application/octet-stream",
    );
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.STUDIO_TEST_CHROMIUM ||
    join(
      homedir(),
      "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell",
    ),
});
const receipt = {
  headless: true,
  scope:
    "Actual command dialog, scrollable form, project choices, folder chooser and preview; simulated filesystem APIs, no live project creation",
  cases: [],
};
try {
  for (const [width, height, theme] of [
    [1280, 960, "light"],
    [390, 844, "light"],
    [1280, 960, "dark"],
    [390, 844, "dark"],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto(`http://127.0.0.1:${server.address().port}/?theme=${theme}`);
    await page.getByRole("button", { name: "Use this folder", exact: true }).waitFor();
    assert.equal(await page.getByText("Project type", { exact: true }).count(), 0);
    assert.equal(
      await page.getByRole("button", { name: "Create", exact: true }).isDisabled(),
      true,
    );
    await page.screenshot({ path: join(output, `${width}-${theme}-choose.png`), fullPage: true });
    await page.getByRole("button", { name: "Projects", exact: true }).click();
    await page.getByRole("button", { name: "Use this folder", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "Create", exact: true }).isEnabled(), true);
    await page
      .getByText("Creates /Users/you/Projects/example-project", { exact: false })
      .waitFor();
    await page.getByRole("option", { name: "MacBook M1 Remote machine" }).click();
    assert.equal(
      await page.getByRole("button", { name: "Create", exact: true }).isDisabled(),
      true,
    );
    await page.getByRole("button", { name: "Projects", exact: true }).click();
    await page.getByRole("button", { name: "Use this folder", exact: true }).click();
    assert.equal(await page.evaluate(() => window.browsedMachine), "m1");
    await page
      .getByText("Creates /Users/remote/Projects/example-project", { exact: false })
      .waitFor();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await page
      .getByRole("option", { name: "Add existing project Open a folder or clone a repository" })
      .click();
    assert.equal(await page.evaluate(() => window.existingClicked), true);
    await page.screenshot({ path: join(output, `${width}-${theme}-selected.png`), fullPage: true });
    receipt.cases.push({ width, height, theme, passed: true });
    await page.goto(`http://127.0.0.1:${server.address().port}/?theme=${theme}&mode=clone`);
    const cloneButton = page.getByRole("button", { name: "Clone repository", exact: true });
    assert.equal(await cloneButton.isDisabled(), true);
    await page.getByRole("button", { name: "Projects", exact: true }).click();
    await page.getByRole("button", { name: "Use this folder", exact: true }).click();
    await page.getByText("Clone into /Users/you/Projects/orbita", { exact: true }).waitFor();
    await page.getByRole("option", { name: "MacBook M1 Remote machine" }).click();
    assert.equal(await cloneButton.isDisabled(), true);
    await page.getByRole("button", { name: "Projects", exact: true }).click();
    await page.getByRole("button", { name: "Use this folder", exact: true }).click();
    await page.getByText("Clone into /Users/remote/Projects/orbita", { exact: true }).waitFor();
    await cloneButton.click();
    assert.deepEqual(await page.evaluate(() => window.cloned), { machine: "m1", path: "/Users/remote/Projects/orbita" });
    await page.screenshot({ path: join(output, `${width}-${theme}-clone.png`), fullPage: true });
    receipt.cases.push({ width, height, theme, mode: "clone", passed: true });
    await page.close();
  }
  await writeFile(join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt));
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
