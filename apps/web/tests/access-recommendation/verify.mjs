// Headless check of the Full access recommendation: the first-run Access step in
// its real frame and the composer's chip callout, in light and dark at 1100 and
// 390 px. Checks sideways scroll, where focus starts, Enter, both answers and a
// failed save. Run after building:
//   node node_modules/vite-plus/bin/vp build --config apps/web/tests/access-recommendation/vite.config.ts
//   node apps/web/tests/access-recommendation/verify.mjs /absolute/owned/report-dir
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = process.env.STUDIO_PLAYWRIGHT_MODULE
  ? await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href)
  : NodeModule.createRequire(NodePath.resolve("apps/server/package.json"))("playwright-core");
const site = NodePath.resolve(
  process.env.ACCESS_RECOMMENDATION_SITE ?? ".artifacts/access-recommendation/site",
);
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/access-recommendation/evidence");
await NodeFSP.mkdir(output, { recursive: true });
const MIME = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = NodePath.resolve(site, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(site + NodePath.sep)) return void res.writeHead(403).end();
    res
      .writeHead(200, { "Content-Type": MIME[NodePath.extname(file)] ?? "text/html" })
      .end(await NodeFSP.readFile(file));
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

const problems = [];
const report = [];
const fail = (where, what) => problems.push(`${where}: ${what}`);
const calls = (page) => page.evaluate(() => window.fixtureCalls.map((call) => call[0]));
const focused = (page) => page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
/** Nothing off the side, and the named box inside the window. */
const layout = (page, selector) =>
  page.evaluate((selector) => {
    const found = [];
    const root = document.documentElement;
    if (root.scrollWidth > root.clientWidth) found.push(`sideways scroll (${root.scrollWidth})`);
    const box = document.querySelector(selector)?.getBoundingClientRect();
    if (!box) found.push(`no ${selector}`);
    else if (box.left < 0 || box.right > root.clientWidth + 0.5)
      found.push(`${selector} off the side (${Math.round(box.left)}..${Math.round(box.right)})`);
    return found;
  }, selector);

for (const theme of ["light", "dark"]) {
  for (const [width, height] of [
    [1100, 800],
    [390, 844],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 2,
      colorScheme: theme,
    });
    const page = await context.newPage();
    const open = async (query) => {
      await page.goto(`${origin}/?theme=${theme}&${query}`);
      await page.waitForLoadState("networkidle");
    };
    const at = `${theme} ${width}`;

    // The Access step.
    await open("view=wizard");
    await page.getByText("Let agents work without stopping to ask?").waitFor();
    await page.waitForTimeout(200);
    for (const problem of await layout(page, '[data-slot="dialog-popup"]'))
      fail(`wizard ${at}`, problem);
    if (!(await focused(page)).startsWith("Use Full access"))
      fail(`wizard ${at}`, `focus starts on "${await focused(page)}"`);
    for (const text of [
      "Recommended",
      "Run terminal commands: install packages, run tests, use git",
      "Still stops for your decisions, sign-ins and app approvals such as sending email",
      "Agents ask before every command and file change. Work waits until you answer.",
    ])
      if (!(await page.getByText(text, { exact: true }).isVisible()))
        fail(`wizard ${at}`, `missing "${text}"`);
    await page.screenshot({ path: NodePath.join(output, `wizard-${theme}-${width}.png`) });
    // Enter presses the recommended action.
    await page.keyboard.press("Enter");
    await page.locator('[data-fixture-done="accepted"]').waitFor();
    if ((await calls(page)).join() !== "accept") fail(`wizard ${at}`, "Enter did not accept");
    await open("view=wizard");
    await page.getByRole("button", { name: "Keep Supervised" }).click();
    await page.locator('[data-fixture-done="declined"]').waitFor();
    if ((await calls(page)).includes("accept")) fail(`wizard ${at}`, "Keep Supervised accepted");
    // A failed save keeps the step open and says so.
    await open("view=wizard&save=fails");
    await page.getByRole("button", { name: /Use Full access/ }).click();
    await page.getByRole("alert").waitFor();
    if (await page.locator("[data-fixture-done]").count())
      fail(`wizard ${at}`, "left the step after a failed save");
    await page.screenshot({ path: NodePath.join(output, `wizard-failed-${theme}-${width}.png`) });

    // The composer's chip and callout.
    await open("view=composer");
    await page.getByText("Recommended: Full access").waitFor();
    await page.waitForTimeout(300);
    for (const problem of await layout(page, '[data-slot="popover-popup"]'))
      fail(`composer ${at}`, problem);
    if ((await focused(page)) !== "Switch to Full access")
      fail(`composer ${at}`, `focus starts on "${await focused(page)}"`);
    if (!(await page.locator("[data-access-recommended]").isVisible()))
      fail(`composer ${at}`, "chip not highlighted");
    await page.screenshot({ path: NodePath.join(output, `composer-${theme}-${width}.png`) });
    await page.keyboard.press("Enter");
    await page.locator('[data-runtime-mode="full-access"]').waitFor();
    if (await page.locator("[data-access-recommended]").count())
      fail(`composer ${at}`, "still highlighted after Switch");
    await page.screenshot({
      path: NodePath.join(output, `composer-accepted-${theme}-${width}.png`),
    });
    // Escape declines, as Keep Supervised and the close button do.
    await open("view=composer");
    await page.getByText("Recommended: Full access").waitFor();
    await page.keyboard.press("Escape");
    await page.getByText("Recommended: Full access").waitFor({ state: "hidden" });
    if ((await calls(page)).join() !== "decline") fail(`composer ${at}`, "Escape did not decline");
    await open("view=composer");
    await page.getByRole("button", { name: "Close" }).click();
    if ((await calls(page)).join() !== "decline") fail(`composer ${at}`, "Close did not decline");
    await open("view=composer&save=fails");
    await page.getByRole("button", { name: "Switch to Full access" }).click();
    await page.getByRole("alert").waitFor();
    if (!(await page.getByText("Recommended: Full access").isVisible()))
      fail(`composer ${at}`, "callout closed after a failed save");
    await page.screenshot({ path: NodePath.join(output, `composer-failed-${theme}-${width}.png`) });
    report.push({ theme, width, height });
    await context.close();
  }
}
await browser.close();
server.close();
await NodeFSP.writeFile(
  NodePath.join(output, "report.json"),
  `${JSON.stringify({ checked: report, problems }, null, 2)}\n`,
);
if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`Access recommendation: ${report.length} layouts checked, no problems. ${output}`);
