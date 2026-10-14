// Run after building apps/web/tests/provider-usability/vite.config.ts.
// Serves fixture assets only; no account, provider, network or live store access.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, sep, join } from "node:path";
import { createRequire } from "node:module";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const require = createRequire(resolve("apps/server/package.json"));
const { chromium } = require("playwright-core");
const root = resolve(".artifacts/provider-usability/site");
const output = resolve(process.argv[2] ?? ".artifacts/muse-picker/evidence");
await mkdir(output, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(root + sep)) return res.writeHead(403).end();
    const body = await readFile(file);
    res
      .writeHead(200, {
        "Content-Type": file.endsWith(".js")
          ? "text/javascript"
          : file.endsWith(".css")
            ? "text/css"
            : "text/html",
      })
      .end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
let page;
let passed = false;
const errors = [];
const checks = [];
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
      : {}),
  });
  page = await browser.newPage({ reducedMotion: "reduce" });
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.route("**/*", (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  );
  for (const width of [320, 1440]) {
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${origin}/?state=muse&theme=${theme}`);
      await page.getByRole("button", { name: /Coordinator model:/ }).click();
      await page.getByRole("button", { name: /Muse Work/i }).click();
      await page.getByText("Muse Wonder Full", { exact: true }).click();
      await page.getByTestId("selection").filter({ hasText: "muse-wonder-full" }).waitFor();
      assert.deepEqual(JSON.parse(await page.getByTestId("selection").textContent()), {
        instanceId: "muse_work",
        model: "muse-wonder-full",
      });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await page.screenshot({ path: join(output, `muse-${width}-${theme}.png`), fullPage: true });
      checks.push(`${width}/${theme}: native Muse Wonder Full selection preserved`);
    }
  }
  assert.deepEqual(errors, []);
  passed = true;
  console.log(JSON.stringify({ passed: checks.length, output }));
} catch (error) {
  errors.push(String(error));
  if (page)
    await page.screenshot({ path: join(output, "failure.png"), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await writeFile(
    join(output, "receipt.json"),
    JSON.stringify(
      {
        headless: true,
        passed,
        checks,
        errors,
        scope:
          "Actual picker components with fixture provider state; no authenticated inference or installed-runtime proof",
      },
      null,
      2,
    ) + "\n",
  );
  await browser?.close();
  await new Promise((done) => server.close(done));
}
