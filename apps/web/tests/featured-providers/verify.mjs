// Build with vp build --config apps/web/tests/featured-providers/vite.config.ts first.
// Supply the installed Playwright entry via STUDIO_PLAYWRIGHT_MODULE.
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = path.resolve(".artifacts/featured-providers/site");
const output = path.resolve(".artifacts/featured-providers/evidence");
await fs.mkdir(output, { recursive: true });
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = path.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${root}${path.sep}`)) {
      res.writeHead(403).end();
      return;
    }
    const mime = file.endsWith(".js")
      ? "text/javascript"
      : file.endsWith(".css")
        ? "text/css"
        : "text/html";
    const data = await fs.readFile(file);
    res.writeHead(200, { "Content-Type": mime });
    res.end(data);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
    : {}),
});
const errors = [];
const checks = [];
try {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.route("**/*", (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  );
  for (const width of [320, 390, 768, 1440]) {
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${origin}/?theme=${theme}`);
      await page.getByRole("button", { name: "Add GitHub Copilot", exact: true }).waitFor();
      assert.equal(
        await page
          .locator('section[aria-label="Featured ACP providers"]')
          .evaluate((element) => getComputedStyle(element).display),
        "grid",
      );
      assert.ok(
        (await page.getByRole("button", { name: "Add GitHub Copilot", exact: true }).boundingBox())
          .height >= 24,
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await page.screenshot({ path: path.join(output, `${width}-${theme}.png`), fullPage: true });
      checks.push(`${width}-${theme}: no overflow`);
    }
  }
  await page.getByRole("button", { name: "Add GitHub Copilot", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.getByTestId("selected").filter({ hasText: "Selected github-copilot-cli" }).waitFor();
  checks.push("Keyboard Add passes exact registry ID");
  await page.getByRole("button", { name: "Add Gemini CLI", exact: true }).click();
  await page.getByTestId("selected").filter({ hasText: "Selected gemini" }).waitFor();
  checks.push("Gemini uses its exact registry identity");
  await page.goto(`${origin}/?state=added`);
  await page.getByRole("button", { name: "Manage Gemini CLI", exact: true }).click();
  await page.getByTestId("selected").filter({ hasText: "Selected manage:gemini_work" }).waitFor();
  checks.push("Added agent opens its existing settings without installation");
  for (const state of ["readonly", "loading", "preparing"]) {
    await page.goto(`${origin}/?state=${state}`);
    await page.getByRole("button").first().waitFor();
    for (const button of await page.getByRole("button").all())
      assert.equal(await button.isDisabled(), true);
    checks.push(`${state}: all Add actions disabled`);
  }
  await page.goto(`${origin}/?state=error`);
  await page.getByRole("button", { name: "Retry GitHub Copilot registry lookup" }).click();
  assert.equal(
    await page.getByRole("button", { name: "Add GitHub Copilot", exact: true }).isEnabled(),
    true,
  );
  checks.push("Registry failure retries successfully");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/?state=missing&theme=dark&dir=rtl`);
  await page.getByRole("button", { name: "Retry Grok Build registry lookup" }).waitFor();
  assert.equal(await page.getByRole("button", { name: /^Add / }).count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: path.join(output, "390-dark-rtl-unavailable.png"),
    fullPage: true,
  });
  checks.push("Missing registry entries never fabricate availability; RTL no overflow");
  for (const width of [320, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${origin}/?view=repair&theme=${width === 320 ? "light" : "dark"}`);
    const repair = page.getByRole("button", { name: "Install / update agent", exact: true });
    await repair.waitFor();
    assert.deepEqual(await page.evaluate(() => window.__repairCalls), []);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: path.join(output, `repair-${width}.png`), fullPage: true });
    await repair.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("status").filter({ hasText: "Agent v1.2.3-fixture installed" }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__repairCalls), [
      {
        command: "prepare",
        input: { environmentId: "remote-worker", input: { agentId: "github-copilot-cli" } },
      },
      {
        command: "refresh",
        input: {
          environmentId: "remote-worker",
          input: { instanceId: "copilot_work", refreshModels: true },
        },
      },
    ]);
    checks.push(
      `Repair ${width}: no automatic RPC, keyboard action prepares and refreshes exact remote instance`,
    );
  }
  await page.goto(`${origin}/?view=repair&state=readonly`);
  assert.equal(
    await page.getByRole("button", { name: "Install / update agent", exact: true }).isDisabled(),
    true,
  );
  await page.goto(`${origin}/?view=repair&state=preparing`);
  await page.getByRole("button", { name: "Install / update agent", exact: true }).click();
  assert.equal(
    await page.getByRole("button", { name: "Installing…", exact: true }).isDisabled(),
    true,
  );
  assert.equal(await page.evaluate(() => window.__repairCalls.length), 1);
  await page.goto(`${origin}/?view=repair&state=error`);
  await page.getByRole("button", { name: "Install / update agent", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "Check the environment connection and retry" })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Install / update agent", exact: true }).isEnabled(),
    true,
  );
  await page.goto(`${origin}/?view=repair&state=override`);
  await page.getByTestId("selected").waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Install / update agent", exact: true }).count(),
    0,
  );
  assert.deepEqual(await page.evaluate(() => window.__repairCalls), []);
  checks.push(
    "Repair preserves read-only, pending and local-override boundaries; failure remains actionable",
  );
  assert.deepEqual(errors, []);
  const receipt = {
    type: "isolated-component-fixture",
    headless: true,
    nativeProviderTurns: 0,
    installations: 0,
    checks,
    errors,
    screenshotDirectory: output,
  };
  await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
