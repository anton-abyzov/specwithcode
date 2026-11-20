// Component fixture only. Never opens a visible browser or reaches a machine, GitHub or a registry.
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname, resolve, sep, join } from "node:path";
import { pathToFileURL } from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = process.env.STUDIO_PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href)
  : createRequire(resolve("apps/server/package.json"))("playwright-core");
const root = resolve(".artifacts/skill-rollout/site");
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
const errors = [];
const outside = [];
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(origin + "/")) return route.continue();
    outside.push(url);
    return route.abort();
  });
  const narrow = () => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  let shots = 0;
  const shot = async (name, options = { fullPage: true }) => {
    assert.equal(await narrow(), false, `${name} scrolls sideways`);
    await page.screenshot({ path: join(output, `${name}.png`), ...options });
    shots += 1;
  };
  for (const theme of ["light", "dark"])
    for (const width of [1440, 390]) {
      const tag = `${theme}-${width}`;
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${origin}/?theme=${theme}`);
      const row = page.locator('[data-testid="skill-updates"] [data-skill="html-report"]');
      await row.getByRole("button", { name: "Also add on…" }).click();
      const rollout = row.getByTestId("skill-rollout");
      // Every machine starts unticked; the ones nothing may be sent to say why.
      await rollout.getByText("Old desk needs a newer SpecWithCode to preview this").waitFor();
      await rollout.getByText("Tower is offline").waitFor();
      await rollout.getByText("This sign-in cannot change skills on Mini").waitFor();
      assert.equal(
        await rollout.getByTestId("skill-rollout-places").textContent(),
        "On Workstation only.",
      );
      assert.equal(await rollout.locator('[role="checkbox"][aria-checked="true"]').count(), 0);
      await shot(`rollout-unticked-${tag}`);

      await rollout.getByRole("checkbox", { name: "Laptop" }).click();
      await rollout.getByRole("checkbox", { name: "Build box" }).click();
      assert.equal(
        await rollout.getByTestId("skill-rollout-places").textContent(),
        "On Workstation, Laptop and Build box.",
      );
      const review = rollout.getByTestId("skill-rollout-review");
      await review.getByText("(replaces 1.1.0)", { exact: false }).waitFor();
      assert.equal(await review.getByText("through npx vskill", { exact: false }).count(), 1);
      await shot(`rollout-review-${tag}`);

      await rollout
        .getByRole("button", { name: "Save on Workstation, Laptop and Build box" })
        .click();
      const results = rollout.getByTestId("skill-rollout-results");
      await results.getByText("Updated to 1.2.0").waitFor();
      await results.getByText("Failed: npx exited 1: GitHub answered 502").waitFor();
      assert.equal(await results.getByRole("button", { name: "Undo" }).count(), 1);
      await rollout.getByRole("button", { name: "Retry failed (1)" }).waitFor();
      await shot(`rollout-results-${tag}`);

      const adopt = page.getByTestId("skill-adopt");
      await adopt.getByText("Matches acme/app-store-skills 1.0.0").waitFor();
      await adopt.scrollIntoViewIfNeeded();
      await shot(`adopt-list-${tag}`, { fullPage: false });
      await adopt.getByRole("button", { name: "Add to team-skills" }).click();
      await page.getByText("Open a pull request on acme/team-skills?").waitFor();
      await page.getByText("skills/tax-notes/references/forms.md").waitFor();
      await shot(`adopt-confirm-${tag}`, { fullPage: false });

      await page.goto(`${origin}/?theme=${theme}&view=matrix`);
      await page.getByText("scan incomplete", { exact: false }).first().waitFor();
      await shot(`matrix-incomplete-${tag}`);
    }
  assert.deepEqual(errors, []);
  assert.deepEqual(outside, []);
  console.log(`ok: ${shots} screenshots in ${output}`);
} finally {
  await browser?.close();
  server.close();
}
