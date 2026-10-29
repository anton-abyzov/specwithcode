// Isolated production component proof: no installed server, account or live fleet.
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const site = path.join(root, ".artifacts/outside-agent/site");
const out = path.resolve(process.argv[2] ?? path.join(root, ".artifacts/outside-agent/evidence"));
await fs.mkdir(out, { recursive: true });
const { chromium } = createRequire(import.meta.url)(
  path.join(root, "apps/server/node_modules/playwright-core"),
);
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  const file = path.resolve(site, `.${pathname === "/" ? "/index.html" : pathname}`);
  if (!file.startsWith(`${site}${path.sep}`)) return res.writeHead(403).end();
  try {
    const body = await fs.readFile(file);
    res
      .writeHead(200, {
        "Content-Type":
          { ".js": "text/javascript", ".css": "text/css" }[path.extname(file)] ?? "text/html",
      })
      .end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
const checks = [];
try {
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.STUDIO_CHROMIUM_EXECUTABLE ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  for (const theme of ["light", "dark"])
    for (const width of [390, 1280])
      for (const route of ["direct", "relay"]) {
        const name = `${theme}-${width}-${route}`;
        const context = await browser.newContext({
          viewport: { width, height: 900 },
          colorScheme: theme,
        });
        await context.tracing.start({ screenshots: true, snapshots: true });
        const page = await context.newPage();
        page.setDefaultTimeout(30_000);
        page.setDefaultNavigationTimeout(30_000);
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.addInitScript(() => {
          window.copies = [];
          Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: { writeText: async (text) => window.copies.push(text) },
          });
        });
        try {
          await page.goto(
            `http://127.0.0.1:${server.address().port}/?theme=${theme}&route=${route}`,
          );
          await page.getByRole("button", { name: "Check again", exact: true }).waitFor();
          assert.match(
            await page.locator('[data-thread-origin="mcp_client"]').innerText(),
            /From Claude.ai/,
          );
          assert.match(
            await page.locator('[data-thread-origin="fleet_machine"]').innerText(),
            /From SpecWithCode · M3/,
          );
          const readiness = page.getByRole("region", { name: "Ready to work on Fixture M4" });
          assert.match(await readiness.innerText(), /Git has no credential helper for GitHub/);
          assert.match(await readiness.innerText(), /gh auth setup-git --hostname github.com/);
          await page.getByRole("button", { name: "Check again", exact: true }).click();
          await page.waitForFunction(() => window.readinessChecks === 2);
          const more = page.getByRole("button", { name: "More actions for Fixture M4" });
          await more.click();
          const publicItem = page.getByRole("menuitem", {
            name: "Copy public MCP URL",
            exact: true,
          });
          if (route === "direct") {
            await publicItem.waitFor();
            await publicItem.click();
            await page.waitForFunction(
              () => window.copies.at(-1) === "https://public.connect.example.test/mcp",
            );
            await more.click();
          } else
            assert.equal(
              await publicItem.count(),
              0,
              "Relay route must not offer a duplicate public copy action",
            );
          await page.getByRole("menuitem", { name: "Copy MCP URL", exact: true }).click();
          const expected =
            route === "direct"
              ? "https://active.example.test/mcp"
              : "https://public.connect.example.test/mcp";
          await page.waitForFunction((url) => window.copies.at(-1) === url, expected);
          await page.keyboard.press("Escape");
          await page.getByRole("menu").waitFor({ state: "hidden" });
          assert.deepEqual(errors, []);
          await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
          checks.push({
            name,
            passed: true,
            copies: await page.evaluate(() => window.copies),
            readinessChecks: await page.evaluate(() => window.readinessChecks),
          });
        } catch (error) {
          await page.screenshot({ path: path.join(out, `${name}-failed.png`), fullPage: true });
          console.error({ name, errors, body: await page.locator("body").innerText() });
          throw error;
        } finally {
          await context.tracing.stop({ path: path.join(out, `${name}-trace.zip`) });
          await context.close();
        }
      }
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.writeFile(
    path.join(out, "receipt.json"),
    JSON.stringify(
      { headless: true, checks, passed: checks.length === 8 && checks.every((c) => c.passed) },
      null,
      2,
    ),
  );
}
console.log(`Passed ${checks.length} headless outside-agent UI scenarios.`);
