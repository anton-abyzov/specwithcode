// Headless screenshots of the first-run choice: node shoot.mjs <site dir> <out dir>
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
const cases = [
  ["none", "darwin"],
  ["ready", "win32"],
  ["available", "linux"],
  ["downloading", "win32"],
];
const report = [];
for (const theme of ["light", "dark"]) {
  for (const [width, height, label] of [
    [1100, 760, "desktop"],
    [390, 780, "phone"],
  ]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
    for (const [update, os] of cases) {
      await page.goto(`${origin}/?update=${update}&os=${os}&theme=${theme}`);
      const popup = page.locator("[data-slot=dialog-popup]").first();
      await popup.waitFor();
      await page.waitForTimeout(300);
      const close = popup.getByRole("button", { name: "Close setup" });
      const later = popup.getByRole("button", { name: "Decide later" });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      report.push({
        update,
        os,
        theme,
        label,
        closeVisible: await close.isVisible(),
        decideLaterVisible: await later.isVisible(),
        updateNotice: (await popup.getByRole("status", { name: "App update" }).count()) > 0,
        horizontalOverflow: overflow,
        closeFocusedFirst: await close.evaluate((element) => element === document.activeElement),
        focusedOnFirstChoice: await page.evaluate(() =>
          (document.activeElement?.textContent ?? "").trim().startsWith("Start as a main machine"),
        ),
      });
      await page.screenshot({
        path: NodePath.join(output, `${update}-${os}-${label}-${theme}.png`),
      });
    }
    await page.close();
  }
}
await browser.close();
server.close();
await NodeFSP.writeFile(NodePath.join(output, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
