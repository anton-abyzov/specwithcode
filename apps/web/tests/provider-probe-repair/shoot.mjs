// Headless captures of the failed-check status row fixture. Usage, with Node 22, after
// `node node_modules/vite-plus/bin/vp build --config apps/web/tests/provider-probe-repair/vite.config.ts`:
//   STUDIO_PLAYWRIGHT_MODULE=/abs/playwright-core/index.mjs node apps/web/tests/provider-probe-repair/shoot.mjs /abs/report-dir [tag]
// Writes <tag>-{light,dark}.png, <tag>-checking.png and <tag>.json. Exits non-zero on a page error.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = process.env.STUDIO_PLAYWRIGHT_MODULE
  ? await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href)
  : await import("playwright-core");

const [reportDir, tag = "after"] = process.argv.slice(2);
if (!reportDir || !NodePath.isAbsolute(reportDir)) {
  console.error("Give an absolute report directory.");
  process.exit(2);
}
NodeFS.mkdirSync(reportDir, { recursive: true });
const site = NodeURL.fileURLToPath(
  new URL("../../../../.artifacts/provider-probe-repair/site", import.meta.url),
);
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = NodeHttp.createServer((request, response) => {
  const path = new URL(request.url, "http://x").pathname;
  const file = NodePath.join(site, path === "/" ? "index.html" : path);
  if (!file.startsWith(site) || !NodeFS.existsSync(file)) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": types[NodePath.extname(file)] ?? "text/plain" });
  NodeFS.createReadStream(file).pipe(response);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const errors = [];
const results = {};
const browser = await chromium.launch({
  headless: true,
  ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
    : {}),
});
try {
  const context = await browser.newContext({ reducedMotion: "reduce", locale: "en-US" });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.route("**/*", (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  );
  for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto(`${origin}/?theme=${theme}`);
    await page.locator("[data-case]").first().waitFor();
    await page.screenshot({
      path: NodePath.join(reportDir, `${tag}-${theme}.png`),
      fullPage: true,
    });
    if (theme === "light") {
      for (const id of await page
        .locator("[data-case]")
        .evaluateAll((all) => all.map((e) => e.dataset.case))) {
        const row = page.locator(`[data-case="${id}"] [data-case-row]`);
        results[id] = {
          text: (await row.innerText()).replace(/\s+/g, " ").trim(),
          buttons: await row.locator("button").allInnerTexts(),
        };
      }
      // Press Check again on case b and capture the row while it reads as checking.
      const row = page.locator('[data-case="b-broken-install"] [data-case-row]');
      await row.getByRole("button", { name: "Check again" }).click();
      await page.waitForTimeout(150);
      await row.screenshot({ path: NodePath.join(reportDir, `${tag}-checking.png`) });
      results.checking = (await row.innerText()).replace(/\s+/g, " ").trim();
      await page.waitForTimeout(1_500);
      await row.screenshot({ path: NodePath.join(reportDir, `${tag}-checked.png`) });
      results.checked = (await row.innerText()).replace(/\s+/g, " ").trim();
    }
  }
} finally {
  await browser.close();
  server.close();
}
NodeFS.writeFileSync(
  NodePath.join(reportDir, `${tag}.json`),
  `${JSON.stringify({ results, errors }, null, 2)}\n`,
);
console.log(JSON.stringify({ results, errors }, null, 2));
process.exit(errors.length > 0 ? 1 : 0);
