// Headless check that each machine shows its own assistant and Run on never offers to copy it.
// Usage (from the repository root): node apps/web/tests/aide-per-machine/verify.mjs [evidence-dir] [--prefix NAME-]
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const assert = NodeAssert.default;
const { readFile, mkdir, writeFile } = NodeFSP;
const { resolve, extname, join } = NodePath;
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const playwright = process.env.STUDIO_PLAYWRIGHT_MODULE;
if (!playwright) throw Error("Set STUDIO_PLAYWRIGHT_MODULE to Playwright's index.mjs");
const { chromium } = await import(NodeURL.pathToFileURL(playwright).href);
const args = process.argv.slice(2);
const prefix = args.includes("--prefix") ? args[args.indexOf("--prefix") + 1] : "";
const site = resolve(".artifacts/aide-per-machine/site");
const output = resolve(
  args[0] && !args[0].startsWith("--") ? args[0] : ".artifacts/aide-per-machine/evidence",
);
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
  ...(process.env.STUDIO_TEST_CHROMIUM ? { executablePath: process.env.STUDIO_TEST_CHROMIUM } : {}),
});
const receipt = {
  headless: true,
  scope:
    "Real StudioSidebar and Run on menu (DraftMachinePicker) with the real assistant rules (personalAssistant.ts, addToMachine.ts) and machine naming; simulated two-machine fleet (Studio Mac = this machine m4, Anna's MacBook = anna) and fictional projects; no live servers",
  cases: [],
  pageErrors: [],
};
const shot = async (page, name) => {
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState !== "running"),
  );
  const path = join(output, `${prefix}${name}.png`);
  await page.screenshot({ path });
  return path;
};
const open = async (width, height, query) => {
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/?theme=light&${query}`);
  return { page, errors };
};
// The Overview section's assistant rows: name, hint and the checkout they open.
const assistantRows = (page) =>
  page.locator(".sws-side-actions .sws-project-row").evaluateAll((rows) =>
    rows.map((row) => ({
      key: row.getAttribute("data-project-key"),
      label: row.querySelector(".sws-side-row-label")?.textContent ?? null,
      hint: row.querySelector(".sws-side-row-hint")?.textContent ?? null,
    })),
  );
const projectRows = (page) =>
  page
    .locator(".sws-side-section .sws-project-row .sws-side-row-label")
    .evaluateAll((labels) => labels.map((label) => label.textContent));
const menuMachines = (menu) =>
  menu
    .locator("[data-machine-status]")
    .evaluateAll((rows) => rows.map((row) => row.querySelector("span span")?.textContent));
const record = (name, size, facts, errors, screenshot) => {
  assert.deepEqual(errors, [], `${name}: page errors`);
  receipt.cases.push({ name, viewport: size, facts, pageErrors: errors.length, screenshot });
  receipt.pageErrors.push(...errors);
};

try {
  for (const [width, height] of [
    [1280, 900],
    [390, 844],
  ]) {
    const size = `${width}x${height}`;

    // 1. Two machines, one assistant each: this machine's leads, each names its machine.
    {
      const { page, errors } = await open(width, height, "view=sidebar");
      await page.locator(".sws-side-actions .sws-project-row").nth(1).waitFor();
      const rows = await assistantRows(page);
      assert.deepEqual(rows, [
        { key: "m4:/fixtures/assistants/studio-mac", label: "Aide", hint: "Studio Mac" },
        { key: "anna:/fixtures/assistants/annas-macbook", label: "Aide", hint: "Anna's MacBook" },
      ]);
      const listed = await projectRows(page);
      assert.ok(listed.includes("Example Household") && !listed.includes("Aide"), listed);
      const path = await shot(page, `${size}-sidebar-two-machines`);
      record("sidebar-two-machines", size, { assistantRows: rows, projects: listed }, errors, path);
      await page.close();
    }

    // 2. A pre-rule duplicate on this machine, created after its own, is marked extra and listed last.
    {
      const { page, errors } = await open(width, height, "view=sidebar&duplicate=1");
      await page.locator(".sws-side-actions .sws-project-row").nth(2).waitFor();
      const rows = await assistantRows(page);
      assert.equal(rows.length, 3);
      assert.deepEqual(
        rows.map((row) => row.key.split(":")[0]),
        ["m4", "anna", "m4"],
        "each machine's own assistant leads, the extra one follows",
      );
      const own = rows.find((row) => row.key === "m4:/fixtures/assistants/studio-mac");
      const duplicate = rows.find((row) => row.key === "m4:/fixtures/assistants/studio-mac-2");
      const anna = rows.find((row) => row.key === "anna:/fixtures/assistants/annas-macbook");
      assert.equal(own.hint, "Studio Mac");
      assert.equal(duplicate.hint, "Studio Mac · extra");
      assert.equal(anna.hint, "Anna's MacBook");
      const duplicateHintClipped = await page
        .locator('[data-project-key="m4:/fixtures/assistants/studio-mac-2"] .sws-side-row-hint')
        .evaluate((hint) => hint.scrollWidth > hint.clientWidth);
      assert.equal(duplicateHintClipped, false, "the extra hint fits its slot");
      const path = await shot(page, `${size}-sidebar-earlier-duplicate`);
      record(
        "sidebar-earlier-duplicate",
        size,
        { assistantRows: rows, duplicateHintClipped },
        errors,
        path,
      );
      await page.close();
    }

    // 3. One machine connected: its assistant row names no machine.
    {
      const { page, errors } = await open(width, height, "view=sidebar&machines=1");
      await page.locator(".sws-side-actions .sws-project-row").first().waitFor();
      const rows = await assistantRows(page);
      assert.deepEqual(rows, [
        { key: "m4:/fixtures/assistants/studio-mac", label: "Aide", hint: null },
      ]);
      const path = await shot(page, `${size}-sidebar-one-machine`);
      record("sidebar-one-machine", size, { assistantRows: rows }, errors, path);
      await page.close();
    }

    // 4. Run on for the assistant: only its own machine, nothing to add it to.
    {
      const { page, errors } = await open(width, height, "view=menu&project=personal");
      await page.getByRole("button", { name: "Run on: Studio Mac" }).click();
      const menu = page.getByRole("menu");
      await menu.getByText("Machines with Aide").waitFor();
      const machines = await menuMachines(menu);
      assert.deepEqual(machines, ["Studio Mac"]);
      const addItems = await menu.getByRole("menuitem", { name: "Add to another machine" }).count();
      assert.equal(addItems, 0);
      const annaMentions = await menu.getByText("Anna's MacBook").count();
      assert.equal(annaMentions, 0);
      const path = await shot(page, `${size}-run-on-assistant`);
      record(
        "run-on-assistant",
        size,
        { listedMachines: machines, addToAnotherMachineItems: addItems, annaMentions },
        errors,
        path,
      );
      await page.close();
    }

    // 5. Run on for a code project is unchanged: the machine without it is addable.
    {
      const { page, errors } = await open(width, height, "view=menu&project=code");
      await page.getByRole("button", { name: "Run on: Studio Mac" }).click();
      const menu = page.getByRole("menu");
      await menu.getByText("Machines with Example Household").waitFor();
      const machines = await menuMachines(menu);
      assert.deepEqual(machines, ["Studio Mac"]);
      const menuPath = await shot(page, `${size}-run-on-code-project`);
      await menu.getByRole("menuitem", { name: "Add to another machine" }).click();
      await menu.getByText("Add Example Household to").waitFor();
      const addable = await menuMachines(menu);
      assert.deepEqual(addable, ["Anna's MacBook"]);
      await menu
        .getByRole("menuitem", { name: /^Anna's MacBook/ })
        .getByText("Clone it there")
        .waitFor();
      const addPath = await shot(page, `${size}-run-on-code-project-add`);
      record(
        "run-on-code-project",
        size,
        { listedMachines: machines, addableMachines: addable, addableStatus: "Clone it there" },
        errors,
        [menuPath, addPath],
      );
      await page.close();
    }
  }
  receipt.passed = true;
  receipt.pageErrorCount = receipt.pageErrors.length;
  await writeFile(join(output, `${prefix}receipt.json`), JSON.stringify(receipt, null, 2) + "\n");
  console.log(`passed: ${receipt.cases.length} cases, ${receipt.pageErrorCount} page errors`);
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
