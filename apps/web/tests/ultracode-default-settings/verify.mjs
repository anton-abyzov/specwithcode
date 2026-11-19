// Headless check of Settings › Agents › Claude workflows: the mode select offers Disabled and
// On request, "Ultracode by default" reads Threads, picking Off saves only that key, and a
// machine whose stored mode is Automatic reads On request plus All chats and saves both keys.
// Build from apps/web: node ../../node_modules/vite-plus/bin/vp build --config tests/ultracode-default-settings/vite.config.ts
// Run from the repository root with PLAYWRIGHT_MODULE and PLAYWRIGHT_EXECUTABLE_PATH set:
//   node apps/web/tests/ultracode-default-settings/verify.mjs <outdir>
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

const assert = NodeAssert.default;
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const site = NodePath.resolve(".artifacts/ultracode-default-settings/site");
const output = NodePath.resolve(
  process.argv[2] || ".artifacts/ultracode-default-settings/evidence",
);
await NodeFSP.mkdir(output, { recursive: true });
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" };
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = NodePath.resolve(site, "." + (pathname === "/" ? "/index.html" : pathname));
    if (!file.startsWith(site + "/")) throw Error("path");
    res.setHeader("content-type", types[NodePath.extname(file)] || "application/octet-stream");
    res.end(await NodeFSP.readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
});
const errors = [];
const base = `http://127.0.0.1:${server.address().port}/`;
const receipt = { headless: true, checks: [], screenshots: [] };
const check = (name, fn) => {
  fn();
  receipt.checks.push(name);
};

async function open(width, theme, mode = "on-request") {
  const page = await browser.newPage({
    viewport: { width, height: 900 },
    deviceScaleFactor: 2,
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}?mode=${mode}&theme=${theme}`);
  await page.waitForFunction(() => document.getElementById("root").childElementCount > 0);
  await page.evaluate(() => document.fonts.ready);
  return page;
}
const group = (page) => page.getByRole("group", { name: "Ultracode by default" });
const pressed = (page) =>
  group(page)
    .locator("[aria-pressed='true'], [data-pressed]")
    .allInnerTexts()
    .then((texts) => texts.map((text) => text.trim()));
const modeText = (page) => page.getByRole("combobox", { name: "Claude workflow mode" }).innerText();
const patches = (page) => page.evaluate(() => window.fixtureState.patches);
// The Claude workflows section is the last one on the page.
const section = (page) =>
  page.locator("[data-setting-keys~='claudeUltracodeDefault']").locator("xpath=../..");

for (const theme of ["light", "dark"]) {
  for (const width of [1440, 390]) {
    const page = await open(width, theme);
    const label = `${theme} ${width}`;
    const mode = (await modeText(page)).trim();
    const shown = await pressed(page);
    check(`${label}: the mode reads On request and the default reads Threads`, () => {
      assert.equal(mode, "On request");
      assert.deepEqual(shown, ["Threads"]);
    });
    const file = NodePath.join(output, `settings-ultracode-default-${theme}-${width}.png`);
    await section(page).screenshot({ path: file });
    receipt.screenshots.push(file);
    await page.close();
  }
}

{
  const page = await open(1440, "light");
  await page.getByRole("combobox", { name: "Claude workflow mode" }).click();
  const options = (await page.getByRole("option").allInnerTexts()).map((text) => text.trim());
  check("the mode select offers only Disabled and On request", () =>
    assert.deepEqual(options, ["Disabled", "On request"]),
  );
  const file = NodePath.join(output, "settings-workflow-mode-options-light-1440.png");
  await page.screenshot({ path: file });
  receipt.screenshots.push(file);
  await page.keyboard.press("Escape");
  await group(page).getByRole("button", { name: "Off" }).click();
  const saved = await patches(page);
  check("picking Off saves only the default", () =>
    assert.deepEqual(saved, [{ claudeUltracodeDefault: "off" }]),
  );
  assert.deepEqual(await pressed(page), ["Off"]);
  await page.close();
}

for (const theme of ["light", "dark"]) {
  const page = await open(1440, theme, "automatic");
  const mode = (await modeText(page)).trim();
  const shown = await pressed(page);
  check(`${theme}: a stored Automatic reads On request plus All chats`, () => {
    assert.equal(mode, "On request");
    assert.deepEqual(shown, ["All chats"]);
  });
  const file = NodePath.join(output, `settings-ultracode-default-automatic-${theme}-1440.png`);
  await section(page).screenshot({ path: file });
  receipt.screenshots.push(file);
  await group(page).getByRole("button", { name: "Threads" }).click();
  const saved = await patches(page);
  check(`${theme}: changing the default on an Automatic machine saves both keys`, () =>
    assert.deepEqual(saved, [
      { claudeWorkflowMode: "on-request", claudeUltracodeDefault: "threads" },
    ]),
  );
  await page.close();
}

check("no page errors", () => assert.deepEqual(errors, []));
await NodeFSP.writeFile(NodePath.join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt, null, 2));
await browser.close();
server.close();
