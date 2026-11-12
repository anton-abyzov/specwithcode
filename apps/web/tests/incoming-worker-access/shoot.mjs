// Headless screenshots of the join card: node shoot.mjs <site dir> <out dir>
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
const M4 = "Anton's MacBook M4MAX";
const choose = (page) => page.getByRole("radio", { name: new RegExp(M4) }).check();
/** name, query, and what the owner does before the picture is taken. */
const cases = [
  ["list", "", null],
  ["chosen", "", choose],
  [
    "done",
    "",
    async (page) => {
      await choose(page);
      await page.getByRole("button", { name: `Allow ${M4}` }).click();
      await page.getByText("can run work here ·").waitFor();
    },
  ],
  ["folded", "", (page) => page.getByRole("button", { name: "Not now" }).click()],
  ["not-answering", "machines=offline", null],
  ["with-saved-machine", "machines=mixed", null],
  ["signed-out", "connect=signed-out", null],
  ["connect-off", "connect=off", null],
  ["no-other-machine", "machines=none", null],
  ["no-connect", "connect=none", null],
  ["join-line-section-open", "fold=open", null],
  ["first-run", "variant=first-run", choose],
];
const report = [];
for (const theme of ["light", "dark"]) {
  for (const [width, height, label] of [
    [1120, 820, "1120"],
    [390, 900, "390"],
  ]) {
    for (const [name, query, act] of cases) {
      // A fresh context each time: Not now is remembered in this device's storage.
      const context = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: 2,
      });
      const page = await context.newPage();
      await page.goto(`${origin}/?${query}${query ? "&" : ""}theme=${theme}`);
      await page.locator("#machines-join-card").waitFor();
      if (act) await act(page);
      await page.waitForTimeout(150);
      report.push({
        name,
        theme,
        width,
        horizontalOverflow: await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
        ),
        text: await page.locator("#machines-join-card").innerText(),
        radios: await page
          .getByRole("radio")
          .evaluateAll((radios) => radios.map((radio) => [radio.checked, radio.disabled])),
        buttons: await page
          .locator("#machines-join-card button")
          .evaluateAll((buttons) => buttons.map((button) => [button.innerText, button.disabled])),
        joinSectionOpen: await page
          .locator("#private-machines-other-account")
          .evaluateAll((sections) => sections.map((section) => section.open)),
        calls: await page.evaluate(() => window.fixtureCalls.map((call) => call[0])),
      });
      await page.screenshot({
        path: NodePath.join(output, `${name}-${label}-${theme}.png`),
        fullPage: true,
      });
      await context.close();
    }
  }
}
await browser.close();
server.close();
await NodeFSP.writeFile(NodePath.join(output, "report.json"), JSON.stringify(report, null, 2));
console.log(`${report.length} screenshots in ${output}`);
console.log(
  JSON.stringify(report.filter((entry) => entry.horizontalOverflow).map((entry) => entry.name)),
);
