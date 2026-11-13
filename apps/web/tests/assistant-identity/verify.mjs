// Headless check of personal assistant identity and personal data access: two
// assistants before and after the upgrade, the setup step without and with icon
// choice, and Settings > Google > Other machines, in light and dark at 1100 and
// 390 px. Run after building:
//   node node_modules/vite-plus/bin/vp build --config apps/web/tests/assistant-identity/vite.config.ts
//   node apps/web/tests/assistant-identity/verify.mjs /absolute/owned/report-dir
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
  process.env.ASSISTANT_IDENTITY_SITE ?? ".artifacts/assistant-identity/site",
);
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/assistant-identity/evidence");
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
const sideways = (page) =>
  page.evaluate(() => {
    const root = document.documentElement;
    return root.scrollWidth > root.clientWidth ? root.scrollWidth : 0;
  });

for (const theme of ["light", "dark"]) {
  for (const [width, height] of [
    [1100, 700],
    [390, 844],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 2,
      colorScheme: theme,
    });
    const page = await context.newPage();
    const at = `${theme}-${width}`;
    const open = async (query) => {
      await page.goto(`${origin}/?theme=${theme}&${query}`);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(250);
    };
    const shot = async (name, selector) => {
      const file = NodePath.join(output, `${name}-${at}.png`);
      await page.locator(selector).screenshot({ path: file });
      report.push(file);
      const wide = await sideways(page);
      if (wide) fail(`${name} ${at}`, `sideways scroll (${wide})`);
    };
    const rowIcons = () =>
      page
        .locator("[data-fixture=sidebar] .sws-side-row")
        .evaluateAll((rows) => rows.map((row) => `${row.dataset.icon}/${row.dataset.color}`));

    // Two assistants: one bell before, two different icons after.
    await open("view=sidebar&state=before");
    const before = await rowIcons();
    if (new Set(before).size !== 1)
      fail(`sidebar before ${at}`, `expected one icon, got ${before}`);
    await shot("sidebar-before", "[data-fixture=sidebar]");
    await open("view=sidebar&state=after");
    const afterIcons = await rowIcons();
    if (afterIcons[0] !== "concierge-bell/violet")
      fail(`sidebar after ${at}`, `the earliest lost the bell: ${afterIcons[0]}`);
    if (new Set(afterIcons.map((icon) => icon.split("/")[0])).size !== 2)
      fail(`sidebar after ${at}`, `glyphs repeat: ${afterIcons}`);
    if (new Set(afterIcons.map((icon) => icon.split("/")[1])).size !== 2)
      fail(`sidebar after ${at}`, `colours repeat: ${afterIcons}`);
    if ((await page.locator("[data-fixture=sidebar] svg").count()) !== 2)
      fail(`sidebar after ${at}`, "an icon did not draw");
    await shot("sidebar-after", "[data-fixture=sidebar]");

    // Setup: no choice before; a distinct suggestion, a marked used icon and a working pick after.
    await open("view=setup&state=before");
    if ((await page.locator("[data-assistant-icon-choice]").count()) !== 0)
      fail(`setup before ${at}`, "icon choice shown");
    await shot("setup-before", "[data-fixture=setup]");
    await open("view=setup&state=after");
    const setup = page.locator("[data-fixture=setup]");
    const suggested = await setup.getAttribute("data-icon");
    if (suggested === "concierge-bell") fail(`setup ${at}`, "suggested the icon already in use");
    if ((await setup.getAttribute("data-color")) === "violet")
      fail(`setup ${at}`, "suggested the colour already in use");
    if ((await page.getByRole("radio", { name: /used by PercyM1 · m1/ }).count()) !== 1)
      fail(`setup ${at}`, "the used icon does not say whose it is");
    if ((await page.locator("[aria-label=Icon] [role=radio]").count()) !== 12)
      fail(`setup ${at}`, "expected 12 icons");
    if ((await page.locator("[aria-label=Colour] [role=radio]").count()) !== 18)
      fail(`setup ${at}`, "expected 18 colours");
    await shot("setup-after", "[data-fixture=setup]");
    // Keyboard reach, then a pick of glyph and colour.
    await page.getByRole("radio", { name: "Rocket" }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("radio", { name: "Green" }).click();
    if ((await setup.getAttribute("data-icon")) !== "rocket")
      fail(`setup ${at}`, "picking Rocket did not change the icon");
    if ((await setup.getAttribute("data-color")) !== "green")
      fail(`setup ${at}`, "picking Green did not change the colour");
    await shot("setup-picked", "[data-fixture=setup]");

    // Settings > Google > Other machines.
    await open("view=access");
    for (const text of [
      "Other machines",
      "Work from Dana's MacBook asked to read your Gmail.",
      "Your own machine. Its work reads what you can.",
      "Reads Calendar.",
      "Reads none of your personal data.",
      "Dana's MacBook asked for Gmail and was refused",
    ]) {
      if ((await page.getByText(text, { exact: false }).count()) === 0)
        fail(`access ${at}`, `missing "${text}"`);
    }
    if ((await page.getByRole("switch").count()) !== 6) fail(`access ${at}`, "expected 6 switches");
    await shot("access", "[data-fixture=access]");
    await page.getByRole("button", { name: "Allow" }).click();
    await page.getByRole("switch", { name: "Calendar for work from Dana's MacBook" }).click();
    const calls = await page.evaluate(() => window.fixtureCalls);
    if (
      JSON.stringify(calls) !==
      JSON.stringify([
        ["allow", "env-dana", "gmail"],
        ["revoke", "env-dana", "calendar"],
      ])
    )
      fail(`access ${at}`, `unexpected changes ${JSON.stringify(calls)}`);
    if ((await page.locator("[data-personal-data-request]").count()) !== 0)
      fail(`access ${at}`, "the request stayed after Allow");
    if ((await page.getByText("Reads Gmail.").count()) !== 1)
      fail(`access ${at}`, "the summary did not follow the change");
    await shot("access-after-allow", "[data-fixture=access]");
    await context.close();
  }
}

await browser.close();
server.close();
await NodeFSP.writeFile(
  NodePath.join(output, "report.json"),
  JSON.stringify({ problems, screenshots: report }, null, 2),
);
console.log(`${report.length} screenshots in ${output}`);
if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("ok");
