import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const assert = NodeAssert.default;
const { readFile, mkdir, writeFile } = NodeFSP;
const { resolve, extname, join } = NodePath;
const { homedir } = NodeOS;
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = NodeModule.createRequire(import.meta.url)(
  process.env.STUDIO_PLAYWRIGHT_MODULE ||
    join(
      homedir(),
      ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
    ),
);
const site = resolve(".artifacts/run-on-machines/site");
const output = resolve(process.argv[2] || ".artifacts/run-on-machines/evidence");
await mkdir(output, { recursive: true });
const server = NodeHttp.createServer(async (req, res) => {
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
    "Actual Run on menu, Rename machine dialog, Add to another machine dialog (clone and consolidate review) and the clone progress strip with the real draft store; simulated five-machine fleet and RPC results; no live servers",
  cases: [],
};
// Menus and dialogs fade in; capture once they have settled.
const shot = async (page, path) => {
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState !== "running"),
  );
  await page.screenshot({ path });
};
const open = async (width, height, theme, view) => {
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/?theme=${theme}&view=${view}`);
  return { page, errors };
};
const noOverflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

// AC-09: the add dialog, the consolidation review and the clone progress strip.
async function addViews(width, height, theme) {
  const shots = [];
  {
    const { page, errors } = await open(width, height, theme, "dialog");
    const dialog = page.getByRole("dialog");
    await dialog.getByText("Add EasyChamp to Mac Studio").waitFor();
    await dialog.getByText("git@github.com:anton-abyzov/easychamp.git").waitFor();
    await dialog.getByText(".env", { exact: true }).waitFor();
    const clone = dialog.getByRole("button", { name: "Clone to Mac Studio" });
    await page.waitForFunction(() =>
      [...document.querySelectorAll("button")].some(
        (b) => b.textContent === "Clone to Mac Studio" && !b.disabled,
      ),
    );
    assert.equal(await clone.isEnabled(), true);
    assert.equal(await noOverflow(page), true);
    await shot(page, join(output, `${width}-${theme}-dialog.png`));
    shots.push("dialog");
    assert.deepEqual(errors, []);
    await page.close();
  }
  {
    const { page, errors } = await open(width, height, theme, "consolidate");
    const dialog = page.getByRole("dialog");
    await dialog.getByText("Add EasyChamp to Mini 2").waitFor();
    await dialog.getByLabel("Folder on Mini 2").fill("/Users/anton/Code/champ-old");
    await dialog
      .getByText("That folder is already a checkout of this repository.", { exact: false })
      .waitFor();
    await page.waitForFunction(() =>
      [...document.querySelectorAll("button")].some(
        (b) => b.textContent === "Link and consolidate" && !b.disabled,
      ),
    );
    await dialog.getByRole("button", { name: "Link and consolidate" }).click();
    await dialog.getByText("Link and consolidate on Mini 2").waitFor();
    await dialog
      .getByText("Both machines have commits the other lacks.", { exact: false })
      .waitFor();
    // D-02: a diverged repository never offers to overwrite what Mini 2 has; only the one
    // differing file (inside its own conflict list) offers the source version.
    await dialog.getByText("Leave both untouched").waitFor();
    assert.equal(await dialog.getByText(/^Take .+’s version \(back up Mini 2’s\)$/u).count(), 1);
    const started = await page.evaluate(() =>
      window.calls.filter(([name]) => name === "copyStart").map(([, request]) => request.input),
    );
    assert.equal(started.length, 1);
    assert.equal(started[0].targetFolder, "/Users/anton/Code/champ-old");
    assert.equal(await noOverflow(page), true);
    await shot(page, join(output, `${width}-${theme}-consolidate.png`));
    shots.push("consolidate");
    assert.deepEqual(errors, []);
    await page.close();
  }
  {
    const { page, errors } = await open(width, height, theme, "strip");
    await page.getByText("Cloning anton-abyzov/easychamp").waitFor();
    await page.getByText("Receiving objects · 45% · 82.4 MiB | 6.1 MiB/s").waitFor();
    await page.getByRole("button", { name: "Cancel" }).click();
    assert.equal(await page.evaluate(() => window.cancelled), true);
    assert.equal(await noOverflow(page), true);
    await shot(page, join(output, `${width}-${theme}-strip.png`));
    shots.push("strip");
    assert.deepEqual(errors, []);
    await page.close();
  }
  return shots;
}

try {
  for (const [width, height, theme] of [
    [1280, 900, "light"],
    [390, 844, "light"],
    [1280, 900, "dark"],
    [390, 844, "dark"],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/?theme=${theme}`);
    const trigger = page.getByRole("button", { name: "Run on: MacBook M4MAX" });
    await trigger.click();
    const menu = page.getByRole("menu");
    await menu.getByText("Machines with EasyChamp").waitFor();
    assert.deepEqual(
      await menu
        .locator("[data-machine-status]")
        .evaluateAll((rows) => rows.map((row) => row.querySelector("span span")?.textContent)),
      ["MacBook M4MAX", "Mac mini"],
    );
    await shot(page, join(output, `${width}-${theme}-menu.png`));

    await menu.getByRole("menuitem", { name: "Add to another machine" }).click();
    await menu.getByText("Add EasyChamp to").waitFor();
    await menu.getByText("Has a copy at /Users/anton/Code/champ-oldLink").waitFor();
    // M1 is saved but not connected: its row links to Settings instead of offering a clone.
    assert.equal(
      await menu
        .getByRole("menuitem", { name: "Fix MacBook Pro M1: Not connected" })
        .getAttribute("href"),
      "/settings/connections",
    );
    // Mac Studio has no copy: its row offers a clone.
    await menu
      .getByRole("menuitem", { name: /^Mac Studio/ })
      .getByText("Clone it there")
      .waitFor();
    await shot(page, join(output, `${width}-${theme}-add.png`));
    await menu.getByRole("menuitem", { name: /^Mini 2/ }).click();
    assert.equal(await page.evaluate(() => window.linkDialog), "champ-mini-2");

    await trigger.click();
    await page.getByRole("menuitem", { name: "Rename a machine" }).click();
    await page
      .getByRole("menuitem", { name: "Rename Mini 2" })
      .getByText("Anton's Mac mini (2)")
      .waitFor();
    await shot(page, join(output, `${width}-${theme}-rename-list.png`));
    await page.getByRole("menuitem", { name: "Rename MacBook M4MAX" }).click();
    const dialog = page.getByTestId("rename-machine-dialog");
    await dialog.getByText("A short name for Anton's MacBook M4MAX.", { exact: false }).waitFor();
    const field = dialog.getByLabel("Name");
    await field.fill("M4 Max Studio Pro X");
    assert.equal(await field.inputValue(), "M4 Max Studio Pr", "16 characters at most");
    await field.fill("M4");
    await shot(page, join(output, `${width}-${theme}-rename.png`));
    await dialog.getByRole("button", { name: "Save" }).click();
    await page.getByRole("button", { name: "Run on: M4" }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.renamed), {
      environmentId: "m4",
      name: "M4",
    });
    assert.equal(
      await page.getByRole("button", { name: "Run on: M4" }).getAttribute("title"),
      "Anton's MacBook M4MAX",
    );
    await page.getByRole("button", { name: "Run on: M4" }).click();
    await page.getByRole("menu").getByText("Machines with EasyChamp").waitFor();
    await shot(page, join(output, `${width}-${theme}-renamed.png`));
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    );
    assert.equal(overflow, false);
    assert.deepEqual(errors, []);
    await page.close();

    const views = await addViews(width, height, theme);
    receipt.cases.push({ width, height, theme, passed: true, overflow, views });
  }
  await writeFile(join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt));
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
