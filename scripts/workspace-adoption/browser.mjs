import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, sep, join, dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(join(repo, "apps/server/package.json"));
const { chromium } = require("playwright-core");
const site = join(repo, ".artifacts/workspace-adoption/site");
const output = resolve(process.argv[2] ?? join(repo, ".artifacts/workspace-adoption/browser"));
await mkdir(output, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = resolve(site, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(site + sep)) return res.writeHead(403).end();
    res
      .writeHead(200, {
        "Content-Type": file.endsWith(".js")
          ? "text/javascript"
          : file.endsWith(".css")
            ? "text/css"
            : "text/html",
      })
      .end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const errors = [];
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage({ reducedMotion: "reduce" });
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.route("**/*", (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  );
  for (const width of [360, 1280])
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`${origin}/?theme=${theme}`);
      await page.getByRole("button", { name: "Preview import", exact: true }).click();
      await page
        .getByText("1 to attach · 1 already attached · 1 blocked", { exact: true })
        .waitFor();
      assert.equal(await page.getByTestId("apply-count").textContent(), "0");
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await page.screenshot({
        path: join(output, `preview-${width}-${theme}.png`),
        fullPage: true,
      });
      await page.getByRole("button", { name: "Import 1 ready repository", exact: true }).click();
      await page
        .getByText("1 attached, 1 remaining. Your project and plan are preserved.", { exact: true })
        .waitFor();
      // A refreshed preview keeps the blocked row visible after partial adoption.
      await page
        .getByText(
          "No readable origin URL. Use an approved additional folder for this local-only checkout.",
          { exact: true },
        )
        .waitFor();
      assert.equal(await page.getByTestId("apply-count").textContent(), "1");
      await page
        .getByText("Attached repositories: atlas-api, atlas-web", { exact: true })
        .waitFor();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await page.screenshot({
        path: join(output, `adopted-${width}-${theme}.png`),
        fullPage: true,
      });
    }
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, "receipt.json"),
    JSON.stringify(
      {
        headless: true,
        widths: [360, 1280],
        themes: ["light", "dark"],
        actualComponent: "ProjectEnvironmentImport",
        fixtureOnly: true,
        noProviderTurns: true,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(`Headless workspace import browser checks passed: ${output}`);
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
