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
const site = resolve(".artifacts/machine-folders/site");
const output = resolve(process.argv[2] || ".artifacts/machine-folders/evidence");
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
    "Actual handoff dialog and remote folder picker; isolated simulated remote APIs; no live accounts/providers",
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
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/?theme=${theme}`);
    await page.getByRole("dialog").waitFor();
    // Screen 1: title, helper, segmented intent, machine rows, the folder, More options.
    assert.equal(await page.getByRole("heading").last().textContent(), "Move EasyChamp");
    await page
      .getByText(
        "From MacBook Pro M4 to another machine. Nothing there is replaced without asking.",
      )
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Move and continue there" })
        .getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(await page.locator('[data-slot="machine-option"]').count(), 3);
    assert.equal(
      await page.getByRole("radio", { name: "MacBook Pro M3" }).getAttribute("aria-checked"),
      "true",
    );
    // M3 has no saved folder: the picker reads only M3 and fills the matching checkout.
    assert.equal(await page.evaluate(() => window.browsedMachine), "m3");
    assert.equal(
      await page.getByLabel("Folder on MacBook Pro M3").inputValue(),
      "/Users/you/Projects/sw-easychamp",
    );
    await page.getByText("Found this project on MacBook Pro M3.", { exact: false }).waitFor();
    assert.equal(await page.locator("details").count(), 0);
    assert.equal(await page.locator("select").count(), 0);
    await page.getByText("2 uncommitted files on MacBook Pro M4.", { exact: false }).waitFor();
    assert.equal(await page.getByRole("checkbox", { name: /Remember/ }).count(), 0);
    assert.equal(
      await page.getByRole("button", { name: "Move to MacBook Pro M3" }).isDisabled(),
      true,
    );
    await page.screenshot({ path: join(output, `${width}-${theme}-choose.png`), fullPage: true });
    await page.getByRole("button", { name: "Commit for me", exact: true }).click();
    await page.getByText("No uncommitted changes on MacBook Pro M4.", { exact: false }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Up one folder" }).count(), 0);
    await page.getByRole("button", { name: "Browse…", exact: true }).click();
    await page.getByRole("button", { name: "Up one folder" }).click();
    assert.equal(
      await page.getByLabel("Folder on MacBook Pro M3").inputValue(),
      "/Users/you/Projects",
    );
    await page.getByRole("button", { name: "another-project", exact: true }).click();
    await page.screenshot({ path: join(output, `${width}-${theme}-browse.png`), fullPage: true });
    await page.getByRole("button", { name: "Use this folder", exact: true }).click();
    assert.deepEqual(
      await page.evaluate(() => ({
        environmentId: window.savedFolder.environmentId,
        path: window.savedFolder.input.workspaceRoot,
        create: window.savedFolder.input.createWorkspaceRootIfMissing,
      })),
      { environmentId: "m3", path: "/Users/you/Projects/another-project", create: false },
    );
    // The saved folder now shows read-only, with Browse… to change it.
    assert.equal(
      await page.getByLabel("Folder on MacBook Pro M3").inputValue(),
      "/Users/you/Projects/another-project",
    );
    await page.getByRole("button", { name: "Move to MacBook Pro M3", exact: true }).click();
    await page.getByText("Committed work only.", { exact: false }).waitFor();
    assert.equal(await page.locator('[data-slot="machine-option"]').count(), 0);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    );
    assert.equal(overflow, false);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: join(output, `${width}-${theme}-review.png`), fullPage: true });
    receipt.cases.push({ width, height, theme, passed: true, remoteEnvironment: "m3", overflow });
    await page.close();
  }
  await writeFile(join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt));
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
