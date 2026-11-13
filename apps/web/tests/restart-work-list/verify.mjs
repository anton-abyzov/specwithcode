// Headless check of the restart and update questions with running work: the
// before shot (origin/main's text-only service question) and the live list.
// Build the fixture, then run from the repository root:
//   node node_modules/vite-plus/bin/vp build --config apps/web/tests/restart-work-list/vite.config.ts
//   node apps/web/tests/restart-work-list/verify.mjs /absolute/owned/artifact-dir
// Screenshots and receipt.json go to <artifact-dir>/evidence.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const assert = NodeAssert.default;
const { mkdir, readFile, writeFile } = NodeFSP;
const { extname, join, resolve, sep } = NodePath;

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = process.env.STUDIO_PLAYWRIGHT_MODULE
  ? await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href)
  : NodeModule.createRequire(resolve("apps/server/package.json"))("playwright-core");

const artifacts = resolve(process.argv[2] ?? ".artifacts/restart-work-list");
const root = resolve(process.env.RESTART_WORK_LIST_SITE ?? join(artifacts, "site"));
const output = join(artifacts, "evidence");
await mkdir(output, { recursive: true });
const MIME = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(root + sep)) return void res.writeHead(403).end();
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "text/html" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const executablePath = process.env.STUDIO_TEST_CHROMIUM ?? process.env.STUDIO_CHROME;
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});
const POPUP = "[data-slot=alert-dialog-popup]";
const receipt = { checks: [] };

async function open(query) {
  const page = await browser.newPage({
    viewport: { width: 900, height: 820 },
    deviceScaleFactor: 2,
  });
  page.on("pageerror", (error) => console.error("page error:", error.message));
  await page.goto(`${origin}/?${new URLSearchParams(query)}`);
  await page.waitForSelector(POPUP);
  await page.waitForTimeout(400);
  return page;
}
const buttons = (page) =>
  page.$$eval(`${POPUP} [data-slot=alert-dialog-footer] button`, (all) =>
    all.map((button) => button.textContent.trim()),
  );
async function check(name, run) {
  await run();
  receipt.checks.push({ name, ok: true });
}

try {
  for (const theme of ["light", "dark"]) {
    await check(`before (${theme}): text only, two buttons, no list`, async () => {
      const page = await open({ scene: "before", theme });
      assert.deepEqual(await buttons(page), ["Cancel", "Stop and update now"]);
      assert.equal(await page.$("[data-testid=restart-running-work]"), null);
      await page.locator(POPUP).screenshot({ path: join(output, `before-dialog-${theme}.png`) });
      await page.close();
    });
    await check(`after (${theme}): count, rows with step and machine, three choices`, async () => {
      const page = await open({ scene: "after", theme });
      assert.deepEqual(await buttons(page), ["Later", "Restart now", "Wait until quiet"]);
      // The default has focus, so Enter waits.
      assert.equal(
        await page.evaluate(() => document.activeElement?.textContent?.trim()),
        "Wait until quiet",
      );
      assert.equal(
        await page.textContent("[data-testid=restart-running-work-count]"),
        "4 threads: 3 running",
      );
      const rows = await page.$$eval("[data-testid=restart-running-work-row]", (all) =>
        all.map((row) => row.textContent),
      );
      assert.equal(rows.length, 4);
      assert.match(rows.join("|"), /Release all platforms.*release\.sh ship desktop.*M4/);
      assert.match(rows.join("|"), /Fix Windows installer signing.*M1/);
      assert.match(rows.join("|"), /SpecOS nightly sync1 message queued.*Minis/);
      await page.locator(POPUP).screenshot({ path: join(output, `after-dialog-${theme}.png`) });
      await page.close();
    });
  }
  await check("after: a row opens its thread and closes the dialog", async () => {
    const page = await open({ scene: "after" });
    await page.getByRole("button", { name: /^Open Fix Windows installer signing/ }).click();
    await page.waitForFunction(() => document.body.dataset.opened !== undefined);
    assert.equal(await page.evaluate(() => document.body.dataset.opened), "env-m1/thread-2");
    await page.waitForSelector(POPUP, { state: "detached" });
    await page.close();
  });
  await check("after: the list follows what runs while open", async () => {
    const page = await open({ scene: "after", live: "1" });
    await page.waitForFunction(
      () =>
        document.querySelector("[data-testid=restart-running-work-count]")?.textContent ===
        "3 threads: 2 running",
      undefined,
      { timeout: 10_000 },
    );
    assert.equal(await page.$$eval("[data-testid=restart-running-work-row]", (r) => r.length), 3);
    await page.locator(POPUP).screenshot({ path: join(output, "after-dialog-live.png") });
    await page.close();
  });
  await check("remote: the same list for another machine, Update now", async () => {
    const page = await open({ scene: "remote" });
    assert.deepEqual(await buttons(page), ["Later", "Update now", "Wait until quiet"]);
    await page.locator(POPUP).screenshot({ path: join(output, "after-remote-dialog.png") });
    await page.close();
  });
} finally {
  await writeFile(join(output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  await browser.close();
  server.close();
}
console.log(`${receipt.checks.length} checks passed; evidence in ${output}`);
