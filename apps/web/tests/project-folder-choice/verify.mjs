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
    const base = `http://127.0.0.1:${server.address().port}`;
    const outcome = page.locator('[data-slot="project-location-outcome"]');
    const create = page.getByRole("button", { name: "Create", exact: true });
    const folders = page.getByRole("listbox", { name: /^Folders/ });
    await page.goto(`${base}/?theme=${theme}`);
    // Opens at the machine's projects folder, already chosen, on this device.
    await page.getByRole("option", { name: "github", exact: true }).waitFor();
    assert.equal(await page.getByText("Project type", { exact: true }).count(), 0);
    assert.equal(await outcome.innerText(), "Creates ~/Projects/example-project on MacBook M4.");
    assert.equal(await create.isEnabled(), true);
    assert.equal(await page.getByRole("button", { name: "Up one folder" }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Use this folder" }).count(), 0);
    assert.equal(
      await page.getByRole("radio", { name: /MacBook M4/ }).getAttribute("aria-checked"),
      "true",
    );
    await page.getByText("New projects start on this device.", { exact: false }).waitFor();
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(output, `${width}-${theme}-choose.png`), fullPage: true });

    // Rows mark repositories and existing projects; the keyboard opens and goes back.
    await page.getByRole("option", { name: "github", exact: true }).click();
    await page.getByRole("option", { name: "hack26-openai Git repository" }).waitFor();
    await page.getByRole("option", { name: "specweave-umb Project: specweave" }).waitFor();
    assert.equal(
      await page
        .locator("[data-folder-enter]")
        .evaluate((el) => getComputedStyle(el).animationName),
      "folder-enter-forward",
    );
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(output, `${width}-${theme}-browse.png`), fullPage: true });
    await folders.focus();
    await page.keyboard.press("ArrowRight");
    await page
      .getByText("Uses ~/Projects/github/hack26-openai as the project on MacBook M4.", {
        exact: false,
      })
      .waitFor();
    await page.keyboard.press("ArrowLeft");
    await page.getByRole("option", { name: "notes", exact: true }).waitFor();
    await page.keyboard.press("n");
    assert.equal(
      await page.getByRole("option", { name: "notes", exact: true }).getAttribute("aria-selected"),
      "true",
    );

    // A new parent folder, made on the machine being browsed.
    await page.getByRole("button", { name: "New folder", exact: true }).click();
    const newName = page.getByRole("textbox", { name: "New folder name" });
    await newName.fill("a/b");
    await newName.press("Enter");
    await page.getByText("A folder name cannot contain a slash.", { exact: true }).waitFor();
    await newName.fill("clients");
    await page.waitForTimeout(350);
    await page.screenshot({
      path: join(output, `${width}-${theme}-new-folder.png`),
      fullPage: true,
    });
    await newName.press("Enter");
    await page
      .getByText("Creates ~/Projects/github/clients/example-project", { exact: false })
      .waitFor();
    assert.deepEqual(await page.evaluate(() => window.createdFolder), {
      machine: "m4",
      parentPath: "/Users/you/Projects/github",
      name: "clients",
    });

    // The same picker on a remote machine whose projects folder is not made yet.
    await page.getByRole("radio", { name: /MacBook M1/ }).click();
    await page.getByText("does not exist yet", { exact: false }).waitFor();
    await page
      .getByText("Creates /Users/remote/Projects/example-project on MacBook M1.", { exact: true })
      .waitFor();
    assert.equal(await create.isEnabled(), true);
    assert.equal(await page.evaluate(() => window.browsedMachine), "m1");
    await page.getByText("You picked MacBook M1.", { exact: false }).waitFor();
    await page.getByRole("group", { name: "Places" }).getByRole("button", { name: "work" }).click();
    await page.getByRole("option", { name: "client-app Project: Client app" }).waitFor();
    await page
      .getByText("Creates ~/work/example-project on MacBook M1.", { exact: true })
      .waitFor();
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(output, `${width}-${theme}-remote.png`), fullPage: true });
    // Back on this device the folder chosen there is still chosen.
    await page.getByRole("radio", { name: /MacBook M4/ }).click();
    await page
      .getByText("Creates ~/Projects/github/clients/example-project", { exact: false })
      .waitFor();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    assert.equal(await page.getByRole("option", { name: /Use SpecWeave/ }).count(), 1);
    await page.getByRole("button", { name: "Add existing project", exact: true }).click();
    assert.equal(await page.evaluate(() => window.existingClicked), true);
    receipt.cases.push({ width, height, theme, passed: true });

    // Cloning starts at home with nothing chosen until a folder is opened.
    await page.goto(`${base}/?theme=${theme}&mode=clone`);
    const cloneButton = page.getByRole("button", { name: "Clone repository", exact: true });
    await page.getByRole("option", { name: "Projects", exact: true }).waitFor();
    assert.equal(await cloneButton.isDisabled(), true);
    await page.getByRole("option", { name: "Projects", exact: true }).click();
    await page.getByText("Clone into /Users/you/Projects/orbita", { exact: true }).waitFor();
    await page.getByRole("radio", { name: /MacBook M1/ }).click();
    await page.getByRole("option", { name: "work", exact: true }).waitFor();
    assert.equal(await cloneButton.isDisabled(), true);
    await page.getByRole("option", { name: "work", exact: true }).click();
    await page.getByText("Clone into /Users/remote/work/orbita", { exact: true }).waitFor();
    await cloneButton.click();
    assert.deepEqual(await page.evaluate(() => window.cloned), {
      machine: "m1",
      path: "/Users/remote/work/orbita",
    });
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(output, `${width}-${theme}-clone.png`), fullPage: true });
    receipt.cases.push({ width, height, theme, mode: "clone", passed: true });
    await page.close();
  }
  // Nothing animates when the person asked for reduced motion.
  const still = await browser.newPage({
    viewport: { width: 1280, height: 960 },
    reducedMotion: "reduce",
  });
  await still.goto(`http://127.0.0.1:${server.address().port}/?theme=dark`);
  await still.getByRole("option", { name: "github", exact: true }).click();
  await still.getByRole("option", { name: "notes", exact: true }).waitFor();
  assert.equal(
    await still.locator("[data-folder-enter]").evaluate((el) => getComputedStyle(el).animationName),
    "none",
  );
  await still.close();
  receipt.cases.push({ reducedMotion: true, passed: true });
  await writeFile(join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt));
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
