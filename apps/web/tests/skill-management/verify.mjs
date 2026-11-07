// Component fixture only. Never opens a visible browser or invokes real skill actions.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname, resolve, sep, join } from "node:path";
import { pathToFileURL } from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = process.env.STUDIO_PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href)
  : createRequire(resolve("apps/server/package.json"))("playwright-core");
const root = resolve(".artifacts/skill-management/site");
if (!process.argv[2]) throw new Error("Pass an absolute evidence directory outside the checkout.");
const output = resolve(process.argv[2]);
assert(!output.startsWith(process.cwd() + sep), "Keep evidence outside the checkout");
await mkdir(output, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const path = resolve(root, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
    if (!path.startsWith(root + sep)) {
      res.writeHead(403).end();
      return;
    }
    const body = await readFile(path);
    res
      .writeHead(200, {
        "Content-Type":
          { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" }[extname(path)] ??
          "text/html",
      })
      .end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const checks = [],
  errors = [];
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.route("**/*", (route) =>
    route
      .request()
      .url()
      .startsWith(origin + "/")
      ? route.continue()
      : route.abort(),
  );
  for (const theme of ["light", "dark"])
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${origin}/?theme=${theme}`);
      await page.getByText("When to use", { exact: true }).waitFor();
      assert.equal(await page.locator('[aria-label="Loaded by"] ul > li').count(), 2);
      assert.equal(await page.locator("code").first().innerText(), "image-v2");
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await page.screenshot({
        path: join(output, `verified-detail-${theme}-${width}.png`),
        fullPage: true,
      });
      await page.getByRole("button", { name: "Show more", exact: true }).focus();
      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: "Show less", exact: true }).waitFor();
      await page.getByRole("button", { name: "Compare", exact: true }).click();
      await page.getByLabel("Content to keep", { exact: true }).waitFor();
      assert.equal(
        await page.getByRole("button", { name: "Choose this copy", exact: true }).isEnabled(),
        false,
      );
      await page.getByRole("checkbox").click();
      await page.getByRole("button", { name: "Choose this copy", exact: true }).click();
      await page.getByRole("button", { name: "Confirm replacement", exact: true }).waitFor();
      assert.match(
        await page.getByRole("status").innerText(),
        /\/home\/demo\/\.agents\/skills\/image-workflow\/SKILL.md/,
      );
      await page.screenshot({
        path: join(output, `verified-preview-${theme}-${width}.png`),
        fullPage: true,
      });
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      assert.equal(
        await page.getByRole("button", { name: "Confirm replacement", exact: true }).count(),
        0,
      );
      await page.getByRole("button", { name: "Instructions", exact: true }).click();
      await page.getByRole("heading", { name: "Image workflow", exact: true }).waitFor();
      assert.equal(
        await page.getByRole("button", { name: "Edit and publish", exact: true }).isEnabled(),
        true,
      );
      await page.goto(`${origin}/?case=authoring&theme=${theme}`);
      await page.getByRole("heading", { name: "New skill", exact: true }).waitFor();
      await page.getByRole("button", { name: "Paste SKILL.md", exact: true }).waitFor();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await page.screenshot({
        path: join(output, `verified-new-skill-${theme}-${width}.png`),
        fullPage: true,
      });
      await page.getByRole("button", { name: "Paste SKILL.md", exact: true }).focus();
      await page.keyboard.press("Enter");
      await page
        .getByRole("textbox", { name: "Paste a skill", exact: true })
        .fill("# Image workflow\nReview illustrations before publishing.");
      await page.screenshot({
        path: join(output, `verified-paste-skill-${theme}-${width}.png`),
        fullPage: true,
      });
      await page.goto(`${origin}/?case=fleet&theme=${theme}`);
      await page.getByRole("button", { name: "Preview installation", exact: true }).click();
      await page.getByRole("button", { name: "Confirm installation", exact: true }).waitFor();
      assert.match(await page.getByRole("status").innerText(), /2 machines/);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await page.screenshot({
        path: join(output, `verified-fleet-preview-${theme}-${width}.png`),
        fullPage: true,
      });
      await page.getByRole("button", { name: "Confirm installation", exact: true }).click();
      const results = await page.getByTestId("skill-fleet-results").innerText();
      assert.match(results, /Desktop: installed 1.3.0/);
      assert.match(results, /Mini: Permission changed/);
      await page.screenshot({
        path: join(output, `verified-fleet-partial-${theme}-${width}.png`),
        fullPage: true,
      });
      checks.push({
        newSkill: true,
        pasteKeyboard: true,
        fleetPreview: true,
        fleetPartial: true,
        theme,
        width,
        overflow: false,
        groupedPaths: 2,
        keyboardShowMore: true,
        explicitPreview: true,
        cancelNoApply: true,
        instructions: true,
      });
    }
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, "verification.json"),
    JSON.stringify({ passed: true, proof: "synthetic component fixture", checks, errors }, null, 2),
  );
  console.log(`Passed ${checks.length} headless layouts and copy-preview interactions.`);
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
