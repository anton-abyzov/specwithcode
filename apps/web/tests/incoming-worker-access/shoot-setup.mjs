// Headless screenshots and checks of the first step of setup: node shoot-setup.mjs <site dir> <out dir>
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const [site, output] = process.argv.slice(2).map((path) => NodePath.resolve(path));
await NodeFSP.mkdir(output, { recursive: true });
const { chromium } = NodeModule.createRequire(import.meta.url)(
  process.env.STUDIO_PLAYWRIGHT_MODULE ?? "playwright-core",
);
const server = NodeHttp.createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  const file = NodePath.resolve(site, `.${pathname === "/" ? "/index.html" : pathname}`);
  try {
    const mime =
      { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" }[
        NodePath.extname(file)
      ] ?? "text/html";
    res.writeHead(200, { "Content-Type": mime }).end(await NodeFSP.readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_CHROME,
});
const signIn = (page) => page.getByRole("button", { name: "Sign in", exact: true }).click();
const linked = (page) => page.getByText("This Mac is linked").waitFor();
const choose = async (page) => {
  await signIn(page);
  await linked(page);
  // The first machine listed stands for the main one.
  await page.getByRole("radio").first().check();
};
/** name, query, what the owner does first, and the one filled button the step then shows. */
const cases = [
  ["sign-in", "", null, "Sign in"],
  [
    "linking",
    "linkMs=600000",
    async (page) => {
      await signIn(page);
      await page.getByText("Linking this Mac…").waitFor();
    },
    null,
  ],
  [
    "choose",
    "",
    async (page) => {
      await signIn(page);
      await linked(page);
      await page.getByRole("radio").first().waitFor();
    },
    "Choose a machine",
  ],
  ["chosen", "", choose, /^Allow ./],
  [
    "joined",
    "",
    async (page) => {
      await choose(page);
      await page.getByRole("button", { name: /^Allow ./ }).click();
      await page.getByText("can run work here ·").waitFor();
      await page.getByText("can start work on this Mac").waitFor();
    },
    "Continue",
  ],
  [
    "link-failed",
    "setup=failed&linkMs=50",
    // Already signed in, as after a sign-in that reloaded the window.
    (page) => page.getByText("This Mac could not be linked").waitFor(),
    "Try again",
  ],
  [
    "link-retried",
    "setup=failed&linkMs=50",
    async (page) => {
      await page.getByRole("button", { name: "Try again" }).click();
      await linked(page);
    },
    "Choose a machine",
  ],
  ["connect-off", "setup=off", null, "Turn on SpecWithCode Connect"],
  ["first-machine", "setup=linked&machines=none", null, "Continue"],
];
const report = [];
const problems = [];
for (const theme of ["light", "dark"]) {
  for (const [width, height, label] of [
    [1120, 900, "1120"],
    [390, 900, "390"],
  ]) {
    for (const [name, query, act, main] of cases) {
      const context = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: 2,
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.goto(`${origin}/?view=setup&${query}${query ? "&" : ""}theme=${theme}`);
      await page.locator('[data-testid="sign-in-first-rows"]').waitFor();
      if (act) await act(page);
      await page.waitForTimeout(250);
      const entry = {
        name,
        theme,
        width,
        errors,
        horizontalOverflow: await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
        ),
        rows: await page
          .locator('[data-testid="sign-in-first-rows"] > li')
          .evaluateAll((rows) => rows.map((row) => [row.dataset.part, row.dataset.state])),
        // Filled buttons that can be pressed, and the one the card keeps until a machine is chosen.
        mainButtons: await page
          .locator("button")
          .evaluateAll((buttons) =>
            buttons
              .filter((button) => /(^|\s)bg-primary(\s|$)/.test(button.className))
              .map((button) => button.innerText.trim()),
          ),
        text: await page.locator("[role=dialog]").innerText(),
        calls: await page.evaluate(() => window.fixtureCalls.map((call) => call[0])),
      };
      report.push(entry);
      const asExpected =
        main === null
          ? entry.mainButtons.length === 0
          : entry.mainButtons.length === 1 &&
            (main instanceof RegExp
              ? main.test(entry.mainButtons[0])
              : main === entry.mainButtons[0]);
      if (!asExpected) {
        problems.push(
          `${name} ${theme} ${label}: main buttons ${JSON.stringify(entry.mainButtons)}`,
        );
      }
      if (entry.horizontalOverflow) problems.push(`${name} ${theme} ${label}: horizontal overflow`);
      if (errors.length) problems.push(`${name} ${theme} ${label}: ${errors.join("; ")}`);
      if (/Settings >/.test(entry.text) && name !== "joined") {
        problems.push(`${name} ${theme} ${label}: sends the owner to Settings`);
      }
      // Linking is asked for once per sign-in, and again only by the owner.
      const links = entry.calls.filter((call) => call === "link").length;
      const allowedLinks = {
        "sign-in": 0,
        "connect-off": 0,
        "first-machine": 0,
        "link-retried": 2,
      };
      if (links !== (allowedLinks[name] ?? 1)) {
        problems.push(`${name} ${theme} ${label}: ${links} link requests`);
      }
      await page.screenshot({
        path: NodePath.join(output, `setup-${name}-${label}-${theme}.png`),
        fullPage: true,
      });
      await context.close();
    }
  }
}
await browser.close();
server.close();
await NodeFSP.writeFile(
  NodePath.join(output, "setup-report.json"),
  JSON.stringify({ problems, report }, null, 2),
);
console.log(`${report.length} screenshots in ${output}`);
console.log(problems.length ? problems.join("\n") : "no problems");
process.exit(problems.length ? 1 : 0);
